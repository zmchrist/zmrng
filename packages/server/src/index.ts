import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync, utimesSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WebSocket } from 'ws'
import { config, liveRepos } from './config.js'
import { Db } from './db.js'
import { WsHub } from './ws.js'
import { TaskManager } from './phases.js'
import { TerminalManager, parseClientMsg } from './terminal.js'
import { ChatManager, parseChatClientMsg } from './chatAgent.js'
import { WorkspaceManager, ChannelManager, parseWorkspaceClientMsg } from './workspace.js'
import { AgentResponder, resolveBotAgent } from './agentResponder.js'
import { sanitizeAttachments } from './runner.js'
import { listWorktreeFiles, selfUpdate } from './worktree.js'
import { readWorktreeFile, writeWorktreeFile, listNotes, WorktreeFileError } from './files.js'
import { runPreflight } from './preflight.js'
import { parseStreamedText } from './chat.js'
import { readUiState, writeUiState } from './uiState.js'
import { DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE } from './types.js'
import type {
  WsEvent,
  EffortLevel,
  CaveStyle,
  FlowMode,
  WorktreeFileTree,
  AgentSummary,
  ChatMessage,
  Channel,
  Message,
  UiState,
  TermServerMsg,
  ChatServerMsg,
  WsWorkspaceServerMsg,
} from './types.js'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const execFileAsync = promisify(execFile)

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STYLES: readonly CaveStyle[] = [
  'normal',
  'caveman-lite',
  'caveman-full',
  'caveman-ultra',
  'wenyan-full',
]

function asEffort(v: unknown): EffortLevel | undefined {
  return EFFORTS.includes(v as EffortLevel) ? (v as EffortLevel) : undefined
}
function asStyle(v: unknown): CaveStyle | undefined {
  return STYLES.includes(v as CaveStyle) ? (v as CaveStyle) : undefined
}
const FLOWS: readonly FlowMode[] = ['direct', 'plan']
function asFlow(v: unknown): FlowMode | undefined {
  return FLOWS.includes(v as FlowMode) ? (v as FlowMode) : undefined
}

// True only under `npm run dev` (tsx runs the .ts source directly). In a built
// deploy the entry is dist/index.js. The Settings reboot's restart step touches
// the entry file to trigger a tsx-watch respawn, which is meaningless (and
// would hang dead) without tsx supervising — so that step is gated on this;
// the git-pull + build steps still run either way.
const IS_DEV = import.meta.url.endsWith('.ts')

// Raise the default 1 MB body limit: base64 image/PDF attachments on the
// task-create and steer routes easily exceed it (a small image is already ~1 MB
// encoded). 32 MB comfortably covers the 8 MB-per-file × 10 attachment cap.
const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 })

// Last-resort safety net: an unguarded async error anywhere (a stray socket
// EPIPE, a rejected promise in a WS handler, etc.) would otherwise crash the
// whole process — which then tears down the sibling `dev:web` (Vite) script
// too, since both run under one `concurrently` parent. Log and keep serving
// instead of dying; see .claude/errors.md "Dev server randomly dies with ws
// proxy error: EPIPE" for the specific case this generalizes.
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaughtException — process kept alive')
})
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandledRejection — process kept alive')
})

const db = new Db(config.dbPath)
const hub = new WsHub()
const manager = new TaskManager(db, (e: WsEvent) => hub.broadcast(e))
const terminals = new TerminalManager()
const chats = new ChatManager()
// Team-workspace presence: every join/leave re-broadcasts the full roster to the
// 'workspace' room. The broadcast sink mirrors TaskManager's hub injection.
const workspace = new WorkspaceManager(db, (frame: WsWorkspaceServerMsg) =>
  hub.broadcastRoom('workspace', JSON.stringify(frame)),
)
// Channel messaging: a dedicated Map<channel_id, Set<socket>> subscription
// registry fans a posted message out ONLY to the sockets that subscribed to that
// channel. The per-socket send sink writes directly to the target ws socket (no
// history replay — scrollback is the REST route below).
const channels = new ChannelManager<WebSocket>(db, (socket, frame) => {
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    // socket closed mid-send; its close handler drops the subscription
  }
})
// The ONE shared @mention team agent (D8/D4): constructed once, serving every
// channel's mentions — never one instance per channel. It relays a mention plus
// that channel's recent scrollback to the configured bot AgentTarget (U4) and
// posts the reply back as a server-controlled `kind='agent'` message. Disabled
// (undefined) when no agents are configured — mentions are then a graceful
// no-op. Which live agent is the bot and the reference-checkout path are
// orchestrator-owned deployment config (ZMRNG_WORKSPACE_BOT_AGENT /
// ZMRNG_WORKSPACE_REPO_PATH).
const botAgent = resolveBotAgent(config.agents, config.workspaceBotAgentId)
const agentResponder = botAgent
  ? new AgentResponder({
      botAgent,
      botHandle: config.workspaceBotHandle,
      scrollback: config.workspaceScrollback,
      checkoutPath: config.workspaceRepoPath,
      timeoutMs: config.workspaceAgentTimeoutMs,
      listMessages: (channelId, before, limit) => db.listMessages(channelId, before, limit),
      post: (channelId, author, body, kind) => channels.post(channelId, author, body, kind),
      log: app.log,
    })
  : undefined

await app.register(websocket)

// ---- REST ----

app.get('/api/config', () => ({
  model: config.defaultModel,
  maxLanes: config.maxLanes,
  targetRepo: config.targetRepo,
  defaultRepoId: config.defaultRepoId,
  // Optional server-side default VPS workspace-server URL for the Team tab. The
  // per-teammate localStorage value (client-side) wins over this when set.
  workspaceUrl: config.workspaceUrl,
  authMode:
    config.authMode === 'apikey'
      ? 'API key (ANTHROPIC_API_KEY billed per task)'
      : 'Max OAuth (ANTHROPIC_API_KEY stripped from workers)',
  authModeKind: config.authMode,
  // Whether the dev-only restart endpoint is available (tsx watch supervising).
  dev: IS_DEV,
}))

// Rescanned live on every request (not the boot-time `config.repos` singleton) so
// a repo added/renamed under the projects dir shows up on a plain page refresh.
app.get('/api/repos', () => liveRepos())

// Self-update reboot (Settings panel): fast-forward zmrng's own checkout to
// origin/main, rebuild, then restart so the fresh code takes effect. Runs in
// three steps, any of which can fail and abort the rest:
//   1. selfUpdate() — ff-only git pull; throws (409) on a dirty tree or a
//      diverged/unmerged history, never touching uncommitted work.
//   2. `npm run build` — rebuilds server + web from the freshly pulled code.
//   3. touch the entry file to trigger a tsx-watch respawn (dev only — a
//      built deploy has no supervisor, so step 3 is skipped there and the
//      response reports `restarted: false`; steps 1-2 still ran).
// Reply before touching the entry so the client gets its response before the
// process goes down.
app.post('/api/restart', async (_req, reply) => {
  try {
    await selfUpdate(config.repoRoot)
  } catch (err) {
    app.log.error({ err }, 'self-update git pull failed')
    return reply.code(409).send({ error: errMsg(err) })
  }

  try {
    await execFileAsync('npm', ['run', 'build'], {
      cwd: config.repoRoot,
      maxBuffer: 1024 * 1024 * 32,
    })
  } catch (err) {
    app.log.error({ err }, 'self-update build failed')
    return reply.code(500).send({ error: `build failed: ${errMsg(err)}` })
  }

  if (!IS_DEV) {
    app.log.info('self-update pulled + rebuilt zmrng; no supervisor to restart (not tsx watch)')
    return reply.send({ ok: true, restarted: false })
  }

  const entry = fileURLToPath(import.meta.url)
  app.log.info({ entry }, 'self-update pulled + rebuilt — touching entry to trigger tsx watch respawn')
  reply.send({ ok: true, restarted: true })
  setTimeout(() => {
    try {
      const now = new Date()
      utimesSync(entry, now, now)
    } catch (err) {
      app.log.error({ err }, 'failed to touch entry file for restart')
    }
  }, 50)
})

// Optional chat agents (U4). Only the client-safe fields — never leak url/headers.
app.get('/api/agents', (): AgentSummary[] =>
  config.agents.map((a) => ({ id: a.id, label: a.label })),
)

// Fresh probe every call — advisory only, never a gate on Start.
app.get('/api/preflight', () => runPreflight())

// Local-settings-file UI persistence (U5) — layout chrome + per-task open
// files, kept out of zmrng.db entirely. Always 200: a missing/corrupt file
// yields an empty default document, never a 500.
app.get('/api/ui-state', (): UiState => {
  try {
    return readUiState()
  } catch (err) {
    app.log.error({ err }, 'failed to read ui state')
    return { global: {}, perTask: {} }
  }
})

app.put('/api/ui-state', (req, reply) => {
  const body = req.body as UiState | undefined
  if (!body || typeof body !== 'object') {
    return reply.code(400).send({ error: 'ui state document is required' })
  }
  try {
    writeUiState({ global: body.global ?? {}, perTask: body.perTask ?? {} })
    return { ok: true }
  } catch (err) {
    app.log.error({ err }, 'failed to write ui state')
    return reply.code(500).send({ error: errMsg(err) })
  }
})

// Directory listing of the configured Projects dir, for the Workspace file tree
// when no task is selected. Skips dotfiles/heavy dirs. Always 200: a
// missing/unreadable dir yields an empty tree, never a 500.
app.get('/api/projects/files', (): WorktreeFileTree => {
  try {
    return listWorktreeFiles(config.projectsDir, { skipDotEntries: true })
  } catch (err) {
    app.log.error({ err }, 'failed to list projects dir')
    return { root: null, entries: [] }
  }
})

// Read one file under the Projects dir (no-task file viewing). Read-only:
// arbitrary project files are never written through this route.
app.get('/api/projects/file', (req, reply) => {
  const { path } = req.query as { path?: string }
  if (!path) return reply.code(400).send({ error: 'path is required' })
  try {
    return readWorktreeFile(config.projectsDir, path)
  } catch (err) {
    const code = err instanceof WorktreeFileError ? 400 : 500
    app.log.error({ err, path }, 'failed to read project file')
    return reply.code(code).send({ error: errMsg(err) })
  }
})

app.get('/api/tasks', () => db.listTasks())

app.post('/api/tasks', (req, reply) => {
  const body = req.body as
    | {
        title?: string
        body?: string
        model?: string
        effort?: string
        style?: string
        flow?: string
        repoId?: string
        attachments?: unknown
      }
    | undefined
  const title = body?.title?.trim()
  const taskBody = body?.body?.trim()
  const attachments = sanitizeAttachments(body?.attachments)
  // A title is always required, but an image-only description (no body text) is valid.
  if (!title || !(taskBody || attachments.length > 0)) {
    return reply.code(400).send({ error: 'title and a body or attachment are required' })
  }
  return manager.createTask(
    title,
    taskBody ?? '',
    body?.model,
    asEffort(body?.effort),
    asStyle(body?.style),
    body?.repoId,
    asFlow(body?.flow),
    attachments,
  )
})

app.get('/api/tasks/:id/events', (req) => {
  const { id } = req.params as { id: string }
  return db.getEvents(id)
})

// Team-workspace channel list (box 2). Always 200; #general is seeded by default.
app.get('/api/channels', (): Channel[] => db.listChannels())

// Create a channel (T3). Optionally repo-scoped via a nullable `repoId` — the
// repo id is stored as a free-text tag (a suggestion for the "Send to my zmrng"
// handoff); it is NOT validated against the local registry here. Tolerant: a
// blank name is a 400, never a 500; a duplicate name reuses the existing row
// (db.createChannel is idempotent by name). On success the updated channel list
// is broadcast to the 'workspace' room so every connected teammate's rail
// refreshes live (the client handles the `channels` frame already).
app.post('/api/channels', (req, reply) => {
  const body = req.body as { name?: string; repoId?: string | null } | undefined
  const name = body?.name?.trim()
  if (!name) {
    return reply.code(400).send({ error: 'name is required' })
  }
  const rawRepoId = typeof body?.repoId === 'string' ? body.repoId.trim() : ''
  const repoId = rawRepoId.length > 0 ? rawRepoId : null
  const channel = db.createChannel(name, repoId, new Date().toISOString())
  hub.broadcastRoom(
    'workspace',
    JSON.stringify({ type: 'channels', channels: db.listChannels() } as WsWorkspaceServerMsg),
  )
  app.log.info({ channelId: channel.id }, 'channel created')
  return channel
})

// Paginated scrollback for one channel (box 4). Mirrors the events/WS split: REST
// serves history, the workspace socket delivers only NEW messages. `before` (an
// oldest-loaded message id) walks backwards; `limit` is clamped to a hard cap.
// Always 200: a bad id / unknown channel yields an empty page, never a 500.
app.get('/api/channels/:id/messages', (req): Message[] => {
  const { id } = req.params as { id: string }
  const { before, limit } = req.query as { before?: string; limit?: string }
  const channelId = Number(id)
  if (!Number.isInteger(channelId)) return []
  const beforeId = before !== undefined && before !== '' ? Number(before) : NaN
  const cursor = Number.isInteger(beforeId) ? beforeId : null
  const requested = limit !== undefined ? Number(limit) : DEFAULT_MESSAGE_PAGE
  const page =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_MESSAGE_PAGE)
      : DEFAULT_MESSAGE_PAGE
  return db.listMessages(channelId, cursor, page)
})

// Directory listing (not contents) of a task's worktree, for the Workspace file
// tree. Always 200: a missing task / worktree yields an empty tree, never a 500.
app.get('/api/tasks/:id/files', (req): WorktreeFileTree => {
  const { id } = req.params as { id: string }
  const task = db.getTask(id)
  try {
    return listWorktreeFiles(task?.worktree ?? null)
  } catch (err) {
    app.log.error({ err, taskId: id }, 'failed to list worktree files')
    return { root: null, entries: [] }
  }
})

// Read one worktree file's contents, dispatched by format (text vs base64).
app.get('/api/tasks/:id/file', (req, reply) => {
  const { id } = req.params as { id: string }
  const { path } = req.query as { path?: string }
  const task = db.getTask(id)
  if (!task?.worktree || !path) return reply.code(400).send({ error: 'path is required' })
  try {
    return readWorktreeFile(task.worktree, path)
  } catch (err) {
    const code = err instanceof WorktreeFileError ? 400 : 500
    app.log.error({ err, taskId: id, path }, 'failed to read worktree file')
    return reply.code(code).send({ error: errMsg(err) })
  }
})

// Write text content into a worktree file (rejects binary/image/pdf paths).
app.put('/api/tasks/:id/file', (req, reply) => {
  const { id } = req.params as { id: string }
  const body = req.body as { path?: string; content?: string } | undefined
  const task = db.getTask(id)
  if (!task?.worktree || !body?.path || body.content === undefined) {
    return reply.code(400).send({ error: 'path and content are required' })
  }
  try {
    writeWorktreeFile(task.worktree, body.path, body.content)
    return { ok: true }
  } catch (err) {
    const code = err instanceof WorktreeFileError ? 400 : 500
    app.log.error({ err, taskId: id, path: body.path }, 'failed to write worktree file')
    return reply.code(code).send({ error: errMsg(err) })
  }
})

// List of note filenames under this task's `.zmrng/notes/`. Always 200: a
// missing task/worktree/dir yields an empty list, never a 500.
app.get('/api/tasks/:id/notes', (req): string[] => {
  const { id } = req.params as { id: string }
  const task = db.getTask(id)
  if (!task?.worktree) return []
  try {
    return listNotes(task.worktree)
  } catch (err) {
    app.log.error({ err, taskId: id }, 'failed to list task notes')
    return []
  }
})

// Persisted chat history for a task/agent conversation. Always 200: unknown
// task or agent yields an empty list, never a 500.
app.get('/api/tasks/:id/chat', (req): ChatMessage[] => {
  const { id } = req.params as { id: string }
  const { agentId } = req.query as { agentId?: string }
  if (!agentId) return []
  return db.listChatMessages(id, agentId)
})

// Streaming chat proxy (U4). Persists the user message, POSTs the conversation
// (plus per-task context) to the configured agent, relays the streamed bytes to
// the client untouched, and persists the accumulated assistant text on close.
// Read-only w.r.t. the worktree — chat never writes worktree files.
app.post('/api/tasks/:id/chat', async (req, reply) => {
  const { id } = req.params as { id: string }
  const body = req.body as { agentId?: string; content?: string } | undefined
  const agentId = body?.agentId?.trim()
  const content = body?.content?.trim()
  if (!agentId || !content) {
    return reply.code(400).send({ error: 'agentId and content are required' })
  }
  const task = db.getTask(id)
  if (!task) return reply.code(404).send({ error: 'task not found' })
  const agent = config.agents.find((a) => a.id === agentId)
  if (!agent) return reply.code(404).send({ error: 'unknown agent' })

  const priorHistory = db.listChatMessages(id, agentId)
  db.addChatMessage(id, agentId, 'user', content, new Date().toISOString())
  const messages = [
    ...priorHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content },
  ]
  const upstreamBody = JSON.stringify({
    messages,
    context: { repoId: task.repoId, worktree: task.worktree, status: task.status },
  })

  // Take over the raw socket so we can stream chunks as they arrive.
  reply.hijack()
  const raw = reply.raw
  raw.setHeader('content-type', 'text/event-stream')
  raw.setHeader('cache-control', 'no-cache')

  let assistant = ''
  try {
    const upstream = await fetch(agent.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...agent.headers },
      body: upstreamBody,
    })
    if (!upstream.ok || !upstream.body) {
      app.log.error(
        { taskId: id, agentId, status: upstream.status },
        'chat upstream returned an error',
      )
      raw.write(`event: error\ndata: ${JSON.stringify({ error: `upstream ${upstream.status}` })}\n\n`)
      raw.end()
      return
    }
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      assistant += chunk
      raw.write(chunk)
    }
  } catch (err) {
    app.log.error({ err, taskId: id, agentId }, 'chat stream failed')
    raw.write(`event: error\ndata: ${JSON.stringify({ error: errMsg(err) })}\n\n`)
  } finally {
    const text = parseStreamedText(assistant).trim()
    if (text) db.addChatMessage(id, agentId, 'assistant', text, new Date().toISOString())
    raw.end()
  }
})

app.post('/api/tasks/:id/start', async (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    await manager.start(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/message', (req, reply) => {
  const { id } = req.params as { id: string }
  const body = req.body as { text?: string; attachments?: unknown } | undefined
  const text = body?.text?.trim() ?? ''
  const attachments = sanitizeAttachments(body?.attachments)
  if (!text && attachments.length === 0) {
    return reply.code(400).send({ error: 'text or an attachment is required' })
  }
  try {
    manager.message(id, text, attachments.length > 0 ? attachments : undefined)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/resume', (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    manager.resume(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/interrupt', (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    manager.interrupt(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/done', async (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    await manager.done(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/cancel', async (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    await manager.cancel(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/archive', (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    manager.archive(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.delete('/api/tasks/:id', async (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    await manager.deleteTask(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

// ---- WebSocket ----

app.get('/ws', { websocket: true }, (socket: WebSocket) => {
  hub.add(socket)
  hub.send(socket, { type: 'snapshot', tasks: db.listTasks() })
})

// Bidirectional PTY channel for the Workspace bottom-dock terminal. One socket
// owns exactly one shell: socket close ⇒ PTY killed (ephemeral by construction).
app.get('/ws/terminal', { websocket: true }, (socket: WebSocket) => {
  const send = (msg: TermServerMsg): void => {
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      // socket closed mid-send
    }
  }
  try {
    const session = terminals.create({
      onData: (data) => send({ type: 'data', data }),
      onExit: (code) => {
        send({ type: 'exit', code })
        socket.close()
      },
    })
    socket.on('message', (raw) => {
      try {
        const msg = parseClientMsg(String(raw))
        if (msg?.type === 'input') session.write(msg.data)
        else if (msg?.type === 'resize') session.resize(msg.cols, msg.rows)
      } catch (err) {
        app.log.error({ err }, 'terminal message handler failed')
        socket.close()
      }
    })
    socket.on('close', () => session.kill())
    socket.on('error', () => session.kill())
  } catch (err) {
    app.log.error({ err }, 'terminal spawn failed')
    try {
      socket.close()
    } catch {
      // already closed
    }
  }
})

// Bidirectional chat channel for the bottom-dock standalone agent chat. One
// socket owns at most one conversational `claude` session: a `start` frame
// (re)spawns it, `input` sends an operator turn, `interrupt` cuts the in-flight
// turn. The session is ephemeral — socket close ⇒ session killed.
app.get('/ws/chat', { websocket: true }, (socket: WebSocket) => {
  let session: ReturnType<ChatManager['create']> | null = null

  const send = (msg: ChatServerMsg): void => {
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      // socket closed mid-send
    }
  }

  const startSession = (model: string, effort: EffortLevel, style: CaveStyle, repoId?: string): void => {
    // Replace any prior session on this socket (a config change respawns).
    if (session) {
      try {
        session.kill()
      } catch {
        // already exited
      }
      session = null
    }
    try {
      session = chats.create(
        { model, effort, style, repoId },
        {
          onSession: (sessionId) => send({ type: 'ready', sessionId }),
          onPartial: (text) => send({ type: 'partial', text }),
          onAssistantText: (text) => send({ type: 'assistant', text }),
          onToolUse: (name, summary, isSubagent, subagentType) =>
            send({
              type: 'tool',
              name,
              summary,
              actor: isSubagent ? (subagentType ?? 'subagent') : 'main',
              isSubagent,
            }),
          // Subagent results are intentionally not forwarded — keep the thread
          // to the agent's own turns, tools, and big decisions only.
          onSubagentResult: () => {},
          onResult: (_text, isError) => send({ type: 'result', isError }),
          onExit: (code) => {
            send({ type: 'exit', code })
            socket.close()
          },
          onSpawnError: (err) => {
            send({ type: 'error', text: errMsg(err) })
            socket.close()
          },
        },
      )
    } catch (err) {
      app.log.error({ err }, 'chat spawn failed')
      send({ type: 'error', text: errMsg(err) })
      socket.close()
    }
  }

  socket.on('message', (raw) => {
    try {
      const msg = parseChatClientMsg(String(raw))
      if (!msg) return
      if (msg.type === 'start') startSession(msg.model, msg.effort, msg.style, msg.repoId)
      else if (msg.type === 'input') session?.send(msg.text, msg.attachments)
      else if (msg.type === 'interrupt') session?.interrupt()
    } catch (err) {
      app.log.error({ err }, 'chat message handler failed')
      socket.close()
    }
  })
  socket.on('close', () => session?.kill())
  socket.on('error', () => session?.kill())
})

// ONE multiplexed team-workspace socket per teammate. Frames are channel-tagged
// by `type` (never one socket per resource): `hello` self-asserts a display name
// (stored as a members row) and marks the teammate online; `ping` is answered
// with `pong`. Presence is connection-based plus a heartbeat: a member is online
// while they hold a live socket, and a periodic ws-level ping/pong evicts a dead
// socket so they drop off the roster. The socket joins the 'workspace' room so it
// receives every roster re-broadcast. NO history replay.
const WORKSPACE_HEARTBEAT_MS = 30000
app.get('/ws/workspace', { websocket: true }, (socket: WebSocket) => {
  hub.join('workspace', socket)
  let joined = false

  const send = (msg: WsWorkspaceServerMsg): void => {
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      // socket closed mid-send
    }
  }

  // ws-level heartbeat: mark the socket dead if it misses a pong between ticks,
  // terminate it, and let the close handler drop the member off the roster.
  let alive = true
  socket.on('pong', () => {
    alive = true
  })
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate()
      return
    }
    alive = false
    try {
      socket.ping()
    } catch {
      // socket already gone
    }
  }, WORKSPACE_HEARTBEAT_MS)

  const cleanup = (): void => {
    clearInterval(heartbeat)
    hub.leaveAll(socket)
    channels.unsubscribeAll(socket)
    if (joined) {
      workspace.leave(socket)
      joined = false
    }
  }

  socket.on('message', (raw) => {
    try {
      const msg = parseWorkspaceClientMsg(String(raw))
      if (!msg) return
      if (msg.type === 'hello') {
        workspace.join(socket, msg.displayName)
        joined = true
      } else if (msg.type === 'ping') {
        send({ type: 'pong' })
      } else if (msg.type === 'subscribe') {
        channels.subscribe(socket, msg.channelId)
      } else if (msg.type === 'unsubscribe') {
        channels.unsubscribe(socket, msg.channelId)
      } else if (msg.type === 'message') {
        // Persist + fan out live to subscribed sockets only (no history replay).
        // A socket post is always `human` — the `agent` kind is server-controlled
        // (set by the T4 agent path below), never trusted from a client frame.
        const stored = channels.post(msg.channelId, msg.author, msg.body, 'human')
        // T4: an @mention of the bot handle triggers the ONE shared team agent
        // asynchronously — the socket handler never blocks on (or crashes from)
        // the agent path. `handleMention` is best-effort and never throws; the
        // extra `.catch` is belt-and-braces. Unmentioned messages do nothing
        // (no always-listening). A missing channel (`stored === undefined`) is a
        // no-op.
        if (stored && agentResponder && agentResponder.mentions(msg.body)) {
          app.log.info(
            { channelId: msg.channelId, messageId: stored.id },
            'team-agent mention triggered',
          )
          void agentResponder.handleMention(msg.channelId).catch((err) => {
            app.log.error({ err, channelId: msg.channelId }, 'team-agent handleMention crashed')
          })
        }
      }
    } catch (err) {
      app.log.error({ err }, 'workspace message handler failed')
      socket.close()
    }
  })
  socket.on('close', cleanup)
  socket.on('error', cleanup)

  // Seed the fresh socket with the current roster before it says hello, so a
  // late joiner immediately sees who is already present.
  send({ type: 'roster', members: workspace.roster() })
})

// ---- static (production) ----

if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist })
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? ''
    if (url.startsWith('/api') || url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
} else {
  app.log.error(
    { webDist: config.webDist },
    'web UI not built — run `npm run build` first (serving API only, no UI at this URL)',
  )
}

// ---- lifecycle ----

let shuttingDown = false
function shutdown(signal: string): void {
  // Guard re-entry: a second SIGTERM (tsx-watch is impatient) must not restart
  // the teardown or cancel the forced-exit timer.
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'shutting down — killing live claude workers')
  manager.shutdown()
  terminals.killAll()
  chats.killAll()

  let exited = false
  const finish = (code: number): void => {
    if (exited) return
    exited = true
    // Checkpoint the WAL into the durable .db before exit so tasks survive the
    // restart — tsx-watch/SIGTERM otherwise kill us before any clean close.
    try {
      db.close()
    } catch (err) {
      app.log.error({ err }, 'failed to checkpoint/close db on shutdown')
    }
    process.exit(code)
  }

  // Force-exit fallback: `app.close()` drains open connections before it
  // resolves, and long-lived browser WebSockets on `/ws` never close on their
  // own — so without this timer the process hangs forever holding :4500, and
  // the next tsx-watch restart dies with EADDRINUSE. Always release the port.
  const forceTimer = setTimeout(() => {
    app.log.warn('shutdown timed out — forcing exit to release the port')
    finish(0)
  }, 2000)
  forceTimer.unref()

  app.close().finally(() => {
    clearTimeout(forceTimer)
    finish(0)
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

try {
  await app.listen({ host: '0.0.0.0', port: config.port })
  for (const warning of config.repoWarnings) app.log.warn({ warning }, 'repo registry')
  app.log.info(
    {
      repos: config.repos.map((r) => r.id),
      defaultRepoId: config.defaultRepoId,
      maxLanes: config.maxLanes,
      model: config.defaultModel,
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      tasks: db.taskCount(),
      port: config.port,
    },
    'zmrng server ready',
  )
} catch (err) {
  app.log.error({ err }, 'failed to start')
  process.exit(1)
}
