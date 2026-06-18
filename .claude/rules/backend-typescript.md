# Backend TypeScript Conventions

## Stack
- TypeScript throughout (ESM, npm workspaces — `packages/server`, `packages/web`)
- Fastify 5 for HTTP + `@fastify/websocket` for the WS surface
- better-sqlite3 for persistence (WAL mode)
- Node `child_process` (`spawn`) for the headless `claude` runner
- Pino for structured logging
- **No shared package** — `packages/server/src/types.ts` is the source of truth,
  manually mirrored into `packages/web/src/types.ts`

## Project Architecture
```
packages/server/src/
  index.ts     — Fastify bootstrap: REST routes + WebSocket + static serve
  config.ts    — env parsing + repo registry (config/repos.json → env → legacy)
  db.ts        — SQLite schema, prepared statements, idempotent migrations
  types.ts     — Task/WsEvent/usage/RepoTarget types (SOURCE OF TRUTH)
  runner.ts    — spawn + parse the claude child (stream-json); strip API key
  phases.ts    — phase state machine + system/kickoff prompts + lane queue
  worktree.ts  — git worktree create/remove per task
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
