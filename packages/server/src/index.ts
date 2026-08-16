import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync, utimesSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WebSocket } from 'ws'
import { config } from './config.js'
import { Db } from './db.js'
import { WsHub } from './ws.js'
import { TaskManager } from './phases.js'
import { TerminalManager, parseClientMsg } from './terminal.js'
import { listWorktreeFiles } from './worktree.js'
import { readWorktreeFile, writeWorktreeFile, listNotes, WorktreeFileError } from './files.js'
import { runPreflight } from './preflight.js'
import { parseStreamedText } from './chat.js'
import { readUiState, writeUiState } from './uiState.js'
import type {
  WsEvent,
  EffortLevel,
  CaveStyle,
  FlowMode,
  WorktreeFileTree,
  AgentSummary,
  ChatMessage,
  UiState,
  TermServerMsg,
} from './types.js'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

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
// deploy the entry is dist/index.js. The restart button touches the entry file
// to trigger a tsx-watch respawn, which is meaningless (and would hang dead)
// without tsx supervising — so the endpoint is gated on this.
const IS_DEV = import.meta.url.endsWith('.ts')

const app = Fastify({ logger: true })
const db = new Db(config.dbPath)
const hub = new WsHub()
const manager = new TaskManager(db, (e: WsEvent) => hub.broadcast(e))
const terminals = new TerminalManager()

await app.register(websocket)

// ---- REST ----

app.get('/api/config', () => ({
  model: config.defaultModel,
  maxLanes: config.maxLanes,
  targetRepo: config.targetRepo,
  defaultRepoId: config.defaultRepoId,
  authMode:
    config.authMode === 'apikey'
      ? 'API key (ANTHROPIC_API_KEY billed per task)'
      : 'Max OAuth (ANTHROPIC_API_KEY stripped from workers)',
  authModeKind: config.authMode,
  // Whether the dev-only restart endpoint is available (tsx watch supervising).
  dev: IS_DEV,
}))

app.get('/api/repos', () => config.repos)

// Dev-only: restart the server so a fresh boot re-reads config/repos.json,
// .env, and starts with clean worker state. Touching the entry file's mtime
// makes tsx-watch send SIGTERM (→ our shutdown() handler kills live workers +
// checkpoints the WAL) then respawn a fresh process. Guarded to dev because a
// built deploy (node dist/index.js) has no supervisor — it would exit and stay
// dead. Reply first, then touch, so the client gets its 200 before we go down.
app.post('/api/restart', (_req, reply) => {
  if (!IS_DEV) {
    return reply
      .code(409)
      .send({ error: 'restart is only available under `npm run dev` (tsx watch)' })
  }
  const entry = fileURLToPath(import.meta.url)
  app.log.info({ entry }, 'restart requested — touching entry to trigger tsx watch respawn')
  reply.send({ ok: true })
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
      }
    | undefined
  const title = body?.title?.trim()
  const taskBody = body?.body?.trim()
  if (!title || !taskBody) {
    return reply.code(400).send({ error: 'title and body are required' })
  }
  return manager.createTask(
    title,
    taskBody,
    body?.model,
    asEffort(body?.effort),
    asStyle(body?.style),
    body?.repoId,
    asFlow(body?.flow),
  )
})

app.get('/api/tasks/:id/events', (req) => {
  const { id } = req.params as { id: string }
  return db.getEvents(id)
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
  const body = req.body as { text?: string } | undefined
  const text = body?.text?.trim()
  if (!text) return reply.code(400).send({ error: 'text is required' })
  try {
    manager.message(id, text)
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

function shutdown(signal: string): void {
  app.log.info({ signal }, 'shutting down — killing live claude workers')
  manager.shutdown()
  terminals.killAll()
  app.close().finally(() => {
    // Checkpoint the WAL into the durable .db before exit so tasks survive the
    // restart — tsx-watch/SIGTERM otherwise kill us before any clean close.
    try {
      db.close()
    } catch (err) {
      app.log.error({ err }, 'failed to checkpoint/close db on shutdown')
    }
    process.exit(0)
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
