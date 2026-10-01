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
import { LaneEmitter } from './lanes.js'
import { ChatManager, parseChatClientMsg } from './chatAgent.js'
import { WorkspaceManager, ChannelManager, PageManager, parseWorkspaceClientMsg } from './workspace.js'
import { AgentResponder, resolveBotAgent } from './agentResponder.js'
import { defaultRunnerFactory, sanitizeAttachments } from './runner.js'
import { defaultScanRunnerFactory } from './scanRunner.js'
import { listWorktreeFiles, selfUpdate } from './worktree.js'
import { startVersionPoller } from './versionPoller.js'
import { readWorktreeFile, writeWorktreeFile, listNotes, WorktreeFileError } from './files.js'
import { runPreflight } from './preflight.js'
import { AuthService } from './auth.js'
import { registerAuth } from './authRoutes.js'
import { registerKbRoutes } from './kbRoutes.js'
import { LoopManager } from './loop.js'
import { registerLoopRoutes } from './loopRoutes.js'
import { ghLoopGitHub } from './loopGithub.js'
import { defaultLoadProbe } from './loopLoad.js'
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
  WorkspaceSettings,
  TermServerMsg,
  ChatServerMsg,
  WsWorkspaceServerMsg,
  WorkspaceMember,
  PublicUser,
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
// Each manager's trailing `onChange`/`onLanesChange` defers to `emitter` through
// an arrow, so the emitter can be constructed after the managers it reads from.
const manager = new TaskManager(
  db,
  (e: WsEvent) => hub.broadcast(e),
  defaultRunnerFactory,
  defaultScanRunnerFactory,
  () => emitter.notify(),
)
const terminals = new TerminalManager(undefined, undefined, undefined, () => emitter.notify())
const chats = new ChatManager(undefined, undefined, () => emitter.notify())
// The single lane-snapshot assembler: reads the three managers that own live
// sessions and coalesces a burst of changes into one broadcast `lanes` frame.
const emitter = new LaneEmitter(
  {
    tasks: () => manager.laneSnapshot(),
    chats: () => chats.snapshot(),
    terminals: () => terminals.snapshot(),
  },
  (snapshot) => hub.broadcast({ type: 'lanes', snapshot }),
)
// Boot reconciliation: mark any task still sitting in a live phase (its worker
// child died with the previous process) `stale`, so the UI surfaces the dead
// state and offers Restart instead of pretending the worker is alive. Runs after
// the emitter exists, since its patches notify it.
manager.reconcileOrphans()
// Loop mode (gauntlet loop, ADR-0003): its own lane pool, separate from the task
// execute-lane cap, so it never reads `manager`'s lanes or the Lanes emitter. Its
// orchestrator sessions drive it by curl-ing the /api/loop routes over loopback,
// hence `apiBase` is this server's own port. Boot reconciliation marks any run
// left live by the previous process `stale`, mirroring the task pipeline.
const loop = new LoopManager(db, (e: WsEvent) => hub.broadcast(e), {
  runnerFactory: defaultRunnerFactory,
  github: ghLoopGitHub(),
  load: defaultLoadProbe({
    maxLoadPerCore: config.loopMaxLoadPerCore,
    minFreeMemMb: config.loopMinFreeMemMb,
  }),
  scanFactory: defaultScanRunnerFactory,
  apiBase: `http://127.0.0.1:${config.port}`,
  pumpIntervalMs: config.loopPumpIntervalMs,
  log: app.log,
})
loop.reconcileOrphans()
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
// KB real-time sync (T2, #144): a dedicated Map<page_id, Set<socket>> subscription
// registry fans a saved block delta (page.update) out ONLY to the sockets
// subscribed to that page, and drives lightweight per-page viewer presence
// (page.presence) off the subscribe set. Same per-socket send injection as
// ChannelManager — no history replay (page scrollback is the REST route).
const pages = new PageManager<WebSocket>(db, (socket, frame) => {
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

// ---- CORS (team-workspace cross-origin REST) ----
// A teammate's browser/desktop app talks to THIS server's channel REST surface
// (/api/channels …) from a different origin than the local one it was served
// from. Without permissive CORS those cross-origin fetches are blocked and the
// Team tab silently falls back to (or fails against) the wrong server. The
// workspace port is Tailscale-perimeter only (see CLAUDE.md), so reflecting any
// origin is acceptable here.
//
// It stays acceptable AFTER the login gate specifically because the
// cross-origin path authenticates with an `Authorization: Bearer` header rather
// than a cookie: `access-control-allow-credentials` is never sent, so a hostile
// origin reflected here cannot ride the operator's session (the session cookie
// is `SameSite=Strict` and never leaves its own site). Reflecting arbitrary
// origins WITH credentials would be a serious vulnerability — do not add that
// header. The only change the gate required is allowing `authorization`
// through preflight.
app.addHook('onRequest', (req, reply, done) => {
  reply.header('access-control-allow-origin', req.headers.origin ?? '*')
  reply.header('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
  reply.header('access-control-allow-headers', 'content-type, authorization')
  reply.header('vary', 'origin')
  if (req.method === 'OPTIONS') {
    reply.code(204).send()
    return
  }
  done()
})

// ---- auth (login gate for the KB + Team surfaces) ----
// Registered AFTER the CORS hook so an OPTIONS preflight is answered before the
// gate ever sees it. The Workspace task orchestrator is deliberately NOT gated —
// only `/api/spaces`, `/api/pages`, `/api/folders`, `/api/page-revisions`,
// `/api/channels` and `/api/auth/{me,logout}` sit behind a session
// (`isProtectedPath` in auth.ts is the single list).
const auth = new AuthService(db, config.sessionTtlMs)
registerAuth(app, {
  auth,
  secureCookies: config.secureCookies,
  sessionTtlMs: config.sessionTtlMs,
})
// One sweep at boot clears sessions that lapsed while the server was down;
// `AuthService.resolve` also drops an expired row the moment it sees one, so
// there is no background timer to keep the process alive.
{
  const swept = auth.sweep()
  if (swept > 0) app.log.info({ swept }, 'expired sessions swept')
}

// ---- REST ----

app.get('/api/config', () => ({
  model: config.defaultModel,
  maxLanes: config.maxLanes,
  targetRepo: config.targetRepo,
  defaultRepoId: config.defaultRepoId,
  // The shared team-agent bot handle (default `@agent`), surfaced so the Team
  // chat's mention autocomplete/highlighter know the agent's name. Visual only —
  // the server-side reply trigger (`detectMention`) is unchanged.
  botHandle: config.workspaceBotHandle,
  authMode:
    config.authMode === 'apikey'
      ? 'API key (ANTHROPIC_API_KEY billed per task)'
      : 'Max OAuth (ANTHROPIC_API_KEY stripped from workers)',
  authModeKind: config.authMode,
  // This instance's HEAD sha, so a client can compare it to a `new-version`
  // frame and decide whether a self-update is actually available (WS-B / D3).
  headSha: config.headSha,
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

// Everything zmrng is running right now (Lanes panel). Read-only and in-memory:
// built on demand from the three live-session managers, never persisted. The
// same payload is pushed as a `lanes` frame over `/ws`; this route serves the
// client's initial load, mirroring `/api/tasks` beside the `snapshot` frame.
app.get('/api/lanes', () => emitter.snapshot())

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

// Durable per-user Team prefs (the display-name handle) persisted in zmrng.db.
// Previously browser localStorage only, which proved unreliable across
// refresh/app-reopen/rebuild in the desktop shell; the sidecar DB lives in the
// persistent per-user data dir, so it survives all of those. Keys are the DB's
// alone — the wire shape is the typed WorkspaceSettings.
//
// The Team workspace URL is deliberately NOT a setting: it is fixed in the web
// client (`teamConfig.WORKSPACE_URL`) because the whole team shares one
// Tailscale-reachable VPS. A `workspace_url` row written by an older build is
// never read or accepted again — migrations here are additive-only, so the dead
// row is left in place rather than deleted.
const SETTING_TEAM_HANDLE = 'team_handle'

app.get('/api/settings', (): WorkspaceSettings => ({
  teamHandle: db.getSetting(SETTING_TEAM_HANDLE) ?? '',
}))

// PATCH-style: only the keys present in the body are written; a blank value
// clears that key. Always returns the full, current WorkspaceSettings.
app.put('/api/settings', (req, reply) => {
  const body = req.body as Partial<WorkspaceSettings> | undefined
  if (!body || typeof body !== 'object') {
    return reply.code(400).send({ error: 'settings document is required' })
  }
  try {
    const now = new Date().toISOString()
    if (typeof body.teamHandle === 'string') {
      db.setSetting(SETTING_TEAM_HANDLE, body.teamHandle, now)
    }
    return {
      teamHandle: db.getSetting(SETTING_TEAM_HANDLE) ?? '',
    } satisfies WorkspaceSettings
  } catch (err) {
    app.log.error({ err }, 'failed to write settings')
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

// Read one file under the Projects dir — the Workspace Files tab always
// browses this fixed directory, independent of task selection.
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

// Write text content into a file under the Projects dir. Same guards as the
// per-task route: path traversal/symlink escapes and binary (image/pdf) paths
// are rejected by `writeWorktreeFile`.
app.put('/api/projects/file', (req, reply) => {
  const body = req.body as { path?: string; content?: string } | undefined
  if (!body?.path || body.content === undefined) {
    return reply.code(400).send({ error: 'path and content are required' })
  }
  try {
    writeWorktreeFile(config.projectsDir, body.path, body.content)
    return { ok: true }
  } catch (err) {
    const code = err instanceof WorktreeFileError ? 400 : 500
    app.log.error({ err, path: body.path }, 'failed to write project file')
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

// Every persisted security-scan round for a task (oldest-first), read-only. Feeds
// the web Security panel; mirrors the events route pattern.
app.get('/api/tasks/:id/security-scans', (req) => {
  const { id } = req.params as { id: string }
  return db.listSecurityScansForTask(id)
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

// ===================================================================
// Knowledge Base (KB) — spaces / folders / pages (T1 #140, single-field editor)
// The whole KB REST surface lives in `kbRoutes.ts` and is registered here, on
// THIS instance (a plain function, not an encapsulated plugin) so the auth
// gate's `onRequest` hook above still covers it and `requireUser` sees the
// `req.authUser` it sets. It is a separate module so the KB surface — and with
// it the claim that every write is attributed to the authenticated session,
// never to a client-supplied `author` — is integration-testable with
// `app.inject()` against a bare Fastify, which importing this file could never
// be (it opens the real DB and spawns managers at import time).
// ===================================================================
registerKbRoutes(app, {
  db,
  broadcast: (frame) => hub.broadcastRoom('workspace', JSON.stringify(frame)),
  log: app.log,
})

// Loop mode REST surface (/api/loop/*) — ungated like the Workspace orchestrator;
// a plain function so it is integration-testable with app.inject().
registerLoopRoutes(app, { loop })


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

// Restart an orphaned task's worker (option B — a fresh agent in the same
// worktree, seeded with a replayed transcript; NOT `claude --resume`).
// Namespaced under the task, distinct from the self-update POST /api/restart.
app.post('/api/tasks/:id/restart', async (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    await manager.restartAgent(id)
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

// Lanes panel "Close": kill the worker (or dequeue it) and park the task `blocked`.
app.post('/api/tasks/:id/close-lane', (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    manager.closeLane(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/lanes/chat/:id/close', (req, reply) => {
  const { id } = req.params as { id: string }
  if (!chats.close(id)) return reply.code(404).send({ error: 'chat session not found' })
  return { ok: true }
})

app.post('/api/lanes/terminal/:id/close', (req) => {
  const { id } = req.params as { id: string }
  terminals.close(id)
  return { ok: true }
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
  // Seed the Lanes panel on connect, exactly as `snapshot` seeds the board.
  hub.send(socket, { type: 'lanes', snapshot: emitter.snapshot() })
})

// Bidirectional PTY channel for the Workspace terminal. A socket ATTACHES to a
// server-owned session (keyed by id) rather than owning the shell: socket close
// ⇒ the session is DETACHED (kept alive for a grace window), so a lock/unlock, a
// network blip, or a page reload can reattach to the same shell and replay its
// recent output. The client's first frame is `attach` (carrying its stored
// sessionId, if any); the server answers with the resolved `session` id and the
// bytes to replay.
app.get('/ws/terminal', { websocket: true }, (socket: WebSocket) => {
  let sessionId: string | null = null

  const send = (msg: TermServerMsg): void => {
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      // socket closed mid-send
    }
  }

  socket.on('message', (raw) => {
    try {
      const msg = parseClientMsg(String(raw))
      if (!msg) return
      if (msg.type === 'attach') {
        // First (or a repeated) attach: resolve-or-spawn the session, then replay.
        if (sessionId) return // already attached on this socket — ignore
        const result = terminals.attach(msg.sessionId, {
          onData: (data) => send({ type: 'data', data }),
          onExit: (code) => {
            send({ type: 'exit', code })
            socket.close()
          },
        })
        sessionId = result.sessionId
        send({ type: 'session', sessionId })
        if (result.replay) send({ type: 'data', data: result.replay })
        terminals.resize(sessionId, msg.cols, msg.rows)
      } else if (sessionId && msg.type === 'input') {
        terminals.write(sessionId, msg.data)
      } else if (sessionId && msg.type === 'resize') {
        terminals.resize(sessionId, msg.cols, msg.rows)
      } else if (sessionId && msg.type === 'close') {
        // Explicit tab close: kill now, no grace window.
        terminals.close(sessionId)
        sessionId = null
        socket.close()
      }
    } catch (err) {
      app.log.error({ err }, 'terminal message handler failed')
      socket.close()
    }
  })

  // Detach (not kill) so the shell survives a transient drop; the grace timer
  // reaps it if nothing reattaches.
  socket.on('close', () => {
    if (sessionId) terminals.detach(sessionId)
  })
  socket.on('error', () => {
    if (sessionId) terminals.detach(sessionId)
  })
})

// Bidirectional chat channel for the bottom-dock standalone agent chat. One
// socket owns at most one conversational `claude` session: a `start` frame
// (re)spawns it, `input` sends an operator turn, `interrupt` cuts the in-flight
// turn. The session is ephemeral — socket close ⇒ session killed.
const CHAT_HEARTBEAT_MS = 30000
app.get('/ws/chat', { websocket: true }, (socket: WebSocket) => {
  let session: ReturnType<ChatManager['create']> | null = null

  const send = (msg: ChatServerMsg): void => {
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      // socket closed mid-send
    }
  }

  // ws-level heartbeat: a half-open socket (browser tab killed, laptop slept,
  // network dropped) never fires 'close', so without this its `claude` child
  // would linger forever as a zombie holding memory. If a ping goes unanswered
  // between ticks, terminate the socket — the close handler then kills the child.
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
  }, CHAT_HEARTBEAT_MS)

  const startSession = (
    model: string,
    effort: EffortLevel,
    style: CaveStyle,
    repoId?: string,
    voice?: boolean,
  ): void => {
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
        { model, effort, style, repoId, voice },
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
      // Tell the client which Lanes row this session is, so clicking that row
      // can focus the owning chat tab. Sent on every (re)spawn.
      const laneId = chats.laneId(session)
      if (laneId) send({ type: 'lane', laneId })
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
      if (msg.type === 'start') startSession(msg.model, msg.effort, msg.style, msg.repoId, msg.voice)
      else if (msg.type === 'input') session?.send(msg.text, msg.attachments)
      else if (msg.type === 'interrupt') session?.interrupt()
    } catch (err) {
      app.log.error({ err }, 'chat message handler failed')
      socket.close()
    }
  })
  const cleanup = (): void => {
    clearInterval(heartbeat)
    session?.kill()
  }
  socket.on('close', cleanup)
  socket.on('error', cleanup)
})

// ONE multiplexed team-workspace socket per teammate. Frames are channel-tagged
// by `type` (never one socket per resource): `hello` self-asserts a display name
// (stored as a members row) and marks the teammate online; `ping` is answered
// with `pong`. Presence is connection-based plus a heartbeat: a member is online
// while they hold a live socket, and a periodic ws-level ping/pong evicts a dead
// socket so they drop off the roster. The socket joins the 'workspace' room so it
// receives every roster re-broadcast. NO history replay.
const WORKSPACE_HEARTBEAT_MS = 30000
// Latest-known origin/main sha, set by the version poller (WS-B / D3) when it
// sees origin/main move ahead of this instance's HEAD. Held in memory only (no
// DB); '' until the poller reports one. Read on connect to seed late joiners.
let latestKnownVersionSha = ''
app.get('/ws/workspace', { websocket: true }, (socket: WebSocket, req) => {
  hub.join('workspace', socket)
  let joined = false
  // The socket's roster identity, established by its `hello`. Page presence
  // (T2) attaches this member to each page.subscribe so the per-page viewer set
  // carries display names.
  let member: WorkspaceMember | undefined
  // The socket's AUTHENTICATED identity. Every message, reaction and page edit
  // is attributed to this, never to a wire field — a client can no longer post
  // under a name it chose. Resolved on `hello` from either the bearer token in
  // that frame (the cross-origin desktop→VPS path, which has no cookie it can
  // send) or the session cookie the browser attached to the HTTP handshake.
  let user: PublicUser | undefined
  const handshakeCookie = req.headers.cookie

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

  /**
   * Tell a socket with no usable session why it is being dropped, then drop it.
   * The client clears that origin's stored session and re-shows the login pane.
   */
  const denyUnauthenticated = (): void => {
    send({ type: 'unauthorized' })
    socket.close()
  }

  const cleanup = (): void => {
    clearInterval(heartbeat)
    hub.leaveAll(socket)
    channels.unsubscribeAll(socket)
    // Drop this socket from every page's fan-out and re-broadcast presence to the
    // pages it was viewing (T2). No new heartbeat — this close/error path IS the
    // eviction trigger for page presence.
    pages.unsubscribeAll(socket)
    if (joined) {
      workspace.leave(socket)
      joined = false
      member = undefined
    }
    user = undefined
  }

  socket.on('message', (raw) => {
    try {
      const msg = parseWorkspaceClientMsg(String(raw))
      if (!msg) return
      if (msg.type === 'hello') {
        const resolved = auth.resolveSocketIdentity(handshakeCookie, msg.token)
        if (!resolved) {
          app.log.info({ bearer: msg.token !== undefined }, 'workspace socket rejected — no session')
          denyUnauthenticated()
          return
        }
        user = resolved
        const joinedMember = workspace.join(socket, resolved)
        joined = true
        // Capture the roster identity for page presence (viewers are live sockets,
        // so `online` is always true).
        member = { id: joinedMember.id, displayName: joinedMember.displayName, online: true }
        // Seed the now-authenticated socket with the current roster, so a late
        // joiner immediately sees who is already present. This deliberately
        // happens AFTER authentication — an anonymous socket learns nothing
        // about the workspace, not even who is in it.
        send({ type: 'roster', members: workspace.roster() })
        // Boot safety-net seed (WS-B / D3): if the poller already knows of a
        // newer origin/main sha than this instance is running, tell this client
        // immediately so a late joiner learns about the update without waiting
        // for the next live broadcast.
        if (latestKnownVersionSha && latestKnownVersionSha !== config.headSha) {
          send({ type: 'new-version', sha: latestKnownVersionSha })
        }
        return
      }
      if (msg.type === 'ping') {
        send({ type: 'pong' })
        return
      }
      // Every remaining frame needs an established session. A socket that never
      // said `hello` — or whose `hello` failed to authenticate — can neither
      // read a channel's live feed nor persist a single thing.
      if (!user) {
        denyUnauthenticated()
        return
      }
      if (msg.type === 'subscribe') {
        channels.subscribe(socket, msg.channelId)
      } else if (msg.type === 'unsubscribe') {
        channels.unsubscribe(socket, msg.channelId)
      } else if (msg.type === 'react') {
        // Toggle the reactor's emoji on the message and fan the updated set out
        // live to that channel's subscribers. Best-effort: an unknown/mismatched
        // message is a no-op inside react(). The reactor is the socket's
        // AUTHENTICATED user — the frame carries no handle to spoof.
        channels.react(msg.channelId, msg.messageId, user.displayName, msg.emoji)
      } else if (msg.type === 'message') {
        // Persist + fan out live to subscribed sockets only (no history replay).
        // A socket post is always `human` — the `agent` kind is server-controlled
        // (set by the T4 agent path below), never trusted from a client frame —
        // and its author is the socket's authenticated user, not a wire field.
        const stored = channels.post(msg.channelId, user.displayName, msg.body, 'human')
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
      } else if (msg.type === 'page.subscribe') {
        // Register interest in a page's live whole-body fan-out + viewer
        // presence, using the roster identity established by `hello`.
        if (member) pages.subscribe(socket, msg.pageId, member)
      } else if (msg.type === 'page.unsubscribe') {
        pages.unsubscribe(socket, msg.pageId)
      } else if (msg.type === 'page.edit') {
        // Autosave the page's whole body and fan a `page.update` out live to
        // that page's subscribers. A socket `page.edit` is ALWAYS a human
        // author, and that author is the socket's authenticated user — which
        // also feeds the throttled `page.edit` changelog entry. An unknown page
        // is a no-op inside savePage().
        const stored = pages.savePage(msg.pageId, msg.body, user)
        app.log.info(
          { pageId: msg.pageId, saved: stored !== undefined, username: user.username },
          'kb page.edit',
        )
      }
    } catch (err) {
      app.log.error({ err }, 'workspace message handler failed')
      socket.close()
    }
  })
  socket.on('close', cleanup)
  socket.on('error', cleanup)
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
  loop.shutdown()
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
// Synchronous backstop: the shutdown() force-exit (2s) can fire before a worker's
// async SIGKILL escalation (5s) runs. On ANY exit path, group-SIGKILL every live
// worker tree so `claude` grandchildren die with the server instead of orphaning
// to launchd and burning CPU/RAM. Cheap and idempotent when already clean.
process.on('exit', () => {
  manager.hardKillAll()
  loop.hardKillAll()
})

// Version poller (WS-B / D3). Disabled by default (versionPollMs === 0) so
// laptops never background-fetch; the VPS opts in via ZMRNG_VERSION_POLL_MS.
// When origin/main moves ahead of this HEAD it records the sha and broadcasts a
// `new-version` frame to every socket in the 'workspace' room.
startVersionPoller({
  repoRoot: config.repoRoot,
  localSha: config.headSha,
  intervalMs: config.versionPollMs,
  onNewVersion: (sha) => {
    latestKnownVersionSha = sha
    app.log.info({ sha }, 'origin/main advanced — broadcasting new-version to workspace')
    hub.broadcastRoom(
      'workspace',
      JSON.stringify({ type: 'new-version', sha } as WsWorkspaceServerMsg),
    )
  },
  onError: (err) => app.log.error({ err }, 'version poll cycle failed'),
})

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
