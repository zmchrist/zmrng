# Backend TypeScript Conventions

## Stack
- TypeScript throughout (ESM, npm workspaces — `packages/server`, `packages/web`)
- Fastify 5 for HTTP + `@fastify/websocket` for the WS surface
- better-sqlite3 for persistence (WAL mode)
- Node `child_process` (`spawn`) for the headless `claude` runner
- `node-pty` for the Workspace bottom-dock terminal's PTY sessions (`GET /ws/terminal`)
- The same headless `claude` runner (`GET /ws/chat`) powers a standalone agent-chat
  session, independent of the task lifecycle
- Pino for structured logging
- **No shared package** — `packages/server/src/types.ts` is the source of truth,
  manually mirrored into `packages/web/src/types.ts`

## Project Architecture
```
packages/server/src/
  index.ts     — Fastify bootstrap: REST routes + WebSocket + static serve
  config.ts    — env parsing + repo registry (config/repos.json → env → legacy)
  db.ts        — SQLite schema, prepared statements, idempotent migrations
  types.ts     — Task/WsEvent/usage/RepoTarget/User/Session types (SOURCE OF TRUTH)
  password.ts  — scrypt password hashing ONLY (versioned `scrypt$N$r$p$salt$key`)
  session.ts   — pure session-token primitives (newToken/hashToken/expiry/renewal)
  auth.ts      — AuthService + LoginThrottle + cookie builders + the gated-prefix list
  authRoutes.ts— registerAuth(): the onRequest gate + /api/auth/{login,logout,me}
  kbRoutes.ts  — registerKbRoutes(): the whole Knowledge Base REST surface
  cli/createUser.ts — account-provisioning CLI (`npm run create-user`)
  runner.ts    — spawn + parse the claude child (stream-json); strip API key; buildUserMessage()/sanitizeAttachments() for multimodal image/PDF attachments
  terminal.ts  — TerminalManager: server-owned node-pty sessions (keyed by id) for the Workspace terminal; attach/detach survive a transient socket drop within a grace window
  chatAgent.ts — ChatManager: standalone chat `claude` Runners (GET /ws/chat), same RunnerFactory seam as TaskManager
  phases.ts    — phase state machine + system/kickoff prompts + lane queue
  loop.ts      — LoopManager: the Loop mode (gauntlet loop) engine — own lane pool (LOOP_MAX_LANES=3, separate from config.maxLanes), load gate, fresh claude child per ticket step, serial fold mutex, final scan + one final PR, persistent per-run orchestrator; same RunnerFactory seam as TaskManager/ChatManager
  loopMap.ts   — pure Loop decision logic (bar/blocked-by parsing, frontier + pick order, verdict mapping, round fuse); no IO
  loopPrompts.ts — Loop prompt contract + GAUNTLET_* control-token parsing (reuses styleDirective/PR_BODY_TEMPLATE/PR_RE from phases.ts)
  loopGithub.ts — the LoopGitHub seam over `gh api` (sub-issues → epic task-list fallback; blocked_by → "Blocked by #N" fallback)
  loopLoad.ts  — machine-load probe (available memory, not os.freemem(); load per core) feeding the lane-count advice and the new-pick gate
  loopRoutes.ts — registerLoopRoutes(): the ungated /api/loop/* REST surface (plain function over a narrow manager interface, like kbRoutes)
  worktree.ts  — git worktree create/remove per task (createWorktree takes an optional {branch, base, dir} override; exports gitIn)
  ws.ts        — WebSocket broadcast hub
```

## Patterns

### Manual type mirror (no shared package)
`types.ts` is the single source of truth. Every change to it **must** be mirrored
into `packages/web/src/types.ts` in the same change. `npm run typecheck` over both
workspaces is what catches drift.

### Runner safety — Max OAuth only
The runner **strips `ANTHROPIC_API_KEY` from the child env** so `claude` uses the
operator's Max subscription, never the metered API. Never export the key in this
shell; never extract or proxy the OAuth token.
```typescript
const env = { ...process.env }
delete env.ANTHROPIC_API_KEY
spawn('claude', args, { cwd, env })
```
`terminal.ts`'s `TerminalManager.attach()` mirrors this same strip (gated on
`config.authMode === 'oauth'`) before handing the child env to its `PtyFactory`, so a
`claude` launched inside the Workspace terminal is Max-OAuth-only too. `chatAgent.ts`'s
`ChatManager` does **not** repeat the strip — it spawns through the same `RunnerFactory`
seam as `TaskManager` (`Runner`'s own constructor already strips the key), so it is
Max-OAuth-only by construction. `loop.ts`'s `LoopManager` (every ticket step, the final-PR
agent and the per-run orchestrator) is Max-OAuth-only the same way — never spawn a Loop
child outside that seam.

### Attachment sanitization — trust nothing from the client
Any request/frame field that can carry an operator's image/PDF attachment
(`POST /api/tasks`, `POST /api/tasks/:id/message`, the `/ws/chat` `input` frame) must be
run through `sanitizeAttachments(raw)` (`runner.ts`) before it reaches `Runner.send()`.
It never throws — a malformed shape, a disallowed `mediaType`, or an oversized decoded
payload is silently dropped, and the array is capped at `MAX_ATTACHMENTS`. `kind` is
always *derived* from the allow-listed `mediaType`, never trusted from the client, so a
mismatched `kind` field can't smuggle a PDF in as an image. The limits
(`ALLOWED_MEDIA_TYPES`/`MAX_ATTACHMENTS`/`MAX_ATTACHMENT_BYTES`) live once in `types.ts`
and are mirrored to the web side purely as a client-side fast-fail (`attachments.ts`'s
`validateFile`) — the server-side `sanitizeAttachments` call is the actual enforcement
point and must never be skipped for a new route/frame that accepts attachments.
Attachments are transient by design: never written to disk or the DB, held only long
enough to build one outbound stream-json message (`buildUserMessage`).

### Auth — gate at the edge, attribute from the session
The Knowledge Base and Team Chat surfaces are gated; the Workspace orchestrator is not.
`isProtectedPath` (`auth.ts`) is the SINGLE list of gated prefixes — add a new gated route
there, never with an ad-hoc check in a handler. Inside a gated handler, take the identity
from `requireUser(req, reply)` and NEVER from the request body: a client-supplied `author`
is ignored everywhere, and the workspace socket REJECTS a frame that still asserts one.

Register route modules as PLAIN FUNCTIONS on the app instance (`registerAuth`,
`registerKbRoutes`), not as `fastify-plugin` plugins — an encapsulated plugin's
`onRequest` hook would not cover the parent's routes, and it is what lets a test attach
them to a bare `Fastify()` and drive them with `app.inject()`. `registerLoopRoutes` follows
the same shape; the Loop surface (`/api/loop/*`) is deliberately UNGATED like the Workspace
orchestrator — its main caller is a run's own orchestrator `curl`ing loopback — so it
validates every body itself (400 before the manager is touched) instead of relying on a
gate. Bodyless Loop POSTs must be called with no JSON content-type
(`FST_ERR_CTP_EMPTY_JSON_BODY`).

Never make the session cookie unconditionally `Secure`: browsers silently DROP a `Secure`
cookie on a plain-http origin, and the VPS workspace is plain http on the tailnet.

### Repo registry (config)
Targets load with a fallback chain — `config/repos.json` → `ZMRNG_REPOS` env →
legacy `ZMRNG_TARGET_REPO`. Validate each path is a git repo at startup; skip
invalid entries with a warning. Resolve with `repoById(id)`.

### Pino Logging
```typescript
const app = fastify({ logger: true }) // Pino auto-configured
app.log.info({ repoId, taskId }, 'task created')
app.log.error({ err }, 'failed to spawn claude')
```

### SQLite Patterns
```typescript
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
const insert = db.prepare('INSERT INTO tasks (...) VALUES (...)')
```
Migrations are idempotent: read `PRAGMA table_info(tasks)`, `ALTER TABLE ... ADD
COLUMN` only when missing. Add the column to `SCHEMA` too for fresh DBs.

### WebSocket Handler
```typescript
app.get('/ws', { websocket: true }, (socket) => {
  hub.add(socket)
  hub.send(socket, { type: 'snapshot', tasks: db.listTasks() })
})
```

### Reconnect / stream parsing
- claude is launched with `--output-format stream-json`; parse each NDJSON line
  defensively (lines may be partial across chunks — buffer and split on `\n`).
- Treat unknown line shapes as no-ops, never throw on a stray line.

## Error Handling
- Type your errors; log with structured context.
- Graceful degradation: a failed worktree/spawn fails *that* task, never the server.
```typescript
try {
  wt = await createWorktree(repo.path, repo.defaultBranch, dir, taskId, title)
} catch (err) {
  this.fail(taskId, `worktree creation failed: ${errMsg(err)}`)
}
```

## Anti-Patterns

### Using `any` Type
Use proper types from `types.ts`. For untyped stream-json, narrow via small
helper guards, not `any`.

### Bare Catch Clauses
```typescript
// BAD
try { ... } catch (e) { console.log(e) }
// GOOD
try { ... } catch (err) { app.log.error({ err }, 'descriptive message') }
```

### Hard-coding Config Values
Read ports, repo paths, lane caps, and the model from `config.ts` (env-driven) —
never inline a repo path or a port number.

### Console.log in Production Code
Use `app.log.*` (Pino), never `console.log`, in server code.

### Forgetting the type mirror
Editing `packages/server/src/types.ts` without mirroring `packages/web/src/types.ts`
is the most common cause of a web typecheck failure.
