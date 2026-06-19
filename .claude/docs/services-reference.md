# Services Reference

Deep reference for zmrng's backend services. Not auto-loaded — read when working on
a specific service. Source of truth is the code in `packages/server/src/`.

---

## Runner — `packages/server/src/runner.ts`

Wraps one long-lived headless `claude` child process per task.

- **Spawn:** `claude -p --input-format stream-json --output-format stream-json
  --verbose --include-partial-messages --dangerously-skip-permissions --model <m>
  --effort <e> --append-system-prompt <sp> --add-dir <cwd>`, `cwd` = worktree path.
- **Max OAuth only:** the constructor copies `process.env` and `delete`s
  `ANTHROPIC_API_KEY` before spawn, so the child authenticates with the operator's
  Max login and never bills the metered API.
- **stdout parsing:** buffers chunks, splits on `\n`, `JSON.parse` per line (tolerant —
  non-JSON lines ignored). Dispatches by `type`:
  - first line with a `session_id` → `onSession(sid)`
  - `stream_event` with a `content_block_delta`/`text_delta` → `onPartial(text)`
  - `assistant` → `onAssistantText(concatenated text blocks)`
  - `result` → `onResult(result, is_error, usage)`; `parseUsage` reads
    `input_tokens` / `output_tokens` / `cache_*` / `total_cost_usd` / `num_turns`.
- **`send(text)`** writes a stream-json `user` turn to the child's stdin.
- **`kill()`** ends stdin and sends SIGTERM (both wrapped in try/catch).
- Callbacks: `onSession`, `onAssistantText`, `onPartial`, `onResult`, `onExit`, `onSpawnError`.
- Helpers `asRecord` / `asString` keep parsing typed without `any`.

## TaskManager / phases — `packages/server/src/phases.ts`

The phase state machine and orchestration.

- **States:** `backlog → clarify → planning → executing → validating → review → done`
  (plus `blocked` for a missing subagent, and `failed`). Each autonomous phase
  (planning/executing) runs in its own fresh `claude` session. `building` is a legacy
  single-phase status, retained only for old DB rows/events.
- **`createTask(title, body, model?, effort?, style?, repoId?)`** — resolves `repoId`
  against the registry (falls back to `config.defaultRepoId`), inserts, broadcasts.
- **`start(taskId)`** — resolves the target repo via `repoById`, creates a worktree in
  it, transitions to `clarify`, spawns the runner, sends the clarify kickoff.
- **`systemPrompt(branch, repoPath, defaultBranch, style)`** — repo-agnostic; tells the
  worker it operates on the target repo at `repoPath`, on branch `branch` cut from
  `defaultBranch`, to obey *that repo's* CLAUDE.md/.claude/rules, never touch the
  default branch, and apply the per-task caveman `style` to narration only.
- **Detection (control tokens):** `ZMRNG_READY` (clarify→planning); `ZMRNG_PLAN_READY
  model=… effort=… plan=…` (planning→executing, carries the execute-phase model/effort/
  plan path); `ZMRNG_VALIDATING` (executing→validating); a GitHub PR URL (→review);
  `ZMRNG_BLOCKED: <reason>` (any autonomous phase → `blocked`, lane held, child alive).
- **Per-phase fresh sessions:** each autonomous phase is its own `claude` child. On
  `ZMRNG_READY` the clarify child is replaced by a planning child (always `opus`/`high`,
  seeded with the condensed clarify transcript); on `ZMRNG_PLAN_READY` it is replaced by
  an execute child on the plan's chosen model/effort, which runs through validate → PR.
- **Execute lanes:** cap = `config.maxLanes` (`ZMRNG_MAX_LANES`, default 2). A task takes
  a lane at `ZMRNG_READY`; extra READY tasks park in `planning` with `queued=true` in
  `executeQueue`; `freeLane` (on PR/done/cancel/fail) promotes the next via `beginPlan`.
- **`message` / `resume` / `done` / `cancel` / `shutdown`** — operator turn (clarify
  only); resume a `blocked` task after the missing agent is added; finish + local-sync
  after merge + remove worktree; cancel + remove worktree; kill all live runners.
- `planKickoff` → run `/core_piv_loop:plan-feature`, QA the plan, emit `ZMRNG_PLAN_READY`.
  `executeKickoff(branch, defaultBranch, planPath)` → `/core_piv_loop:execute` →
  `ZMRNG_VALIDATING` → qa/code-reviewer/doc-updater chain → commit → push →
  `gh pr create --base <defaultBranch>` → print PR URL.

## Db — `packages/server/src/db.ts`

SQLite (better-sqlite3, WAL).

- **Tables:** `tasks` (id, title, body, status, session_id, branch, worktree, pr_url,
  model, effort, style, **repo_id**, usage counters, queued, timestamps) and `events`
  (autoincrement id, task_id, ts, kind, payload JSON) + `idx_events_task`.
- **Migrations:** `ensureColumns()` reads `PRAGMA table_info(tasks)` and `ALTER`s any
  missing column (idempotent); columns also live in `SCHEMA` for fresh DBs.
- **`rowToTask`** maps `repo_id` → `repoId`, backfilling `config.defaultRepoId` when null.
- **`createTask`**, **`addUsage`** (atomic `col = col + delta`), `getTask`, `listTasks`,
  `updateTask` (field→column patch), `insertEvent`, `getEvents`.

## Config — `packages/server/src/config.ts`

Env parsing + repo registry.

- **`config`**: `port`, `targetRepo` (default repo path, back-compat), `repos[]`,
  `defaultRepoId`, `repoWarnings[]`, `defaultModel`, `maxLanes`, `repoRoot`, `dbPath`,
  `worktreesDir`, `webDist`, `apiKeyStripped`.
- **Registry fallback chain:** `config/repos.json` → `ZMRNG_REPOS` env (`id:path`
  pairs, comma-separated) → legacy single `ZMRNG_TARGET_REPO`.
- **Validation:** each candidate path checked via `git rev-parse --is-inside-work-tree`;
  invalid entries skipped into `repoWarnings`; best-effort keeps candidates if all fail.
- **`defaultRepoId`:** `ZMRNG_DEFAULT_REPO` if valid, else first entry.
- **`repoById(id)`** resolves a `RepoTarget` from the registry.
- Loads `.env` at repo root into `process.env` (dev convenience).

## Worktree — `packages/server/src/worktree.ts`

- **`createWorktree(repoPath, defaultBranch, worktreesDir, taskId, title)`** — best-effort
  `git fetch origin`, then `git worktree add -b feat/zmrng/<slug>-<shortId> <path> <base>`.
  Base resolved `origin/<defaultBranch>` → local `<defaultBranch>` → `HEAD` (supports
  local-only repos with no remote). Worktrees live under zmrng's `worktrees/<shortId>`.
- **`removeWorktree(repoPath, worktreePath)`** — `worktree remove --force` + `prune`
  (both best-effort).
- **`slugify(title)`** — branch-safe slug.

## WsHub — `packages/server/src/ws.ts`

Fan-out broadcast hub: tracks a `Set<WebSocket>`, evicts on close/error, `send(socket,
event)` for a single client, `broadcast(event)` to all. All sends wrapped in try/catch.

## Fastify server — `packages/server/src/index.ts`

- **REST:** `GET /api/config` (model, maxLanes, targetRepo, defaultRepoId, authMode),
  `GET /api/repos` (the registry), `GET /api/tasks`, `POST /api/tasks`
  (title/body/model/effort/style/repoId), `GET /api/tasks/:id/events`,
  `POST /api/tasks/:id/{start,message,done,cancel}`.
- **WS:** `GET /ws` — adds the socket to the hub, sends a `snapshot`.
- **Static:** serves `web/dist` in production with an SPA not-found fallback.
- **Lifecycle:** SIGINT/SIGTERM → `manager.shutdown()` (kill workers) → close. Logs
  `repoWarnings` at startup.
- `asEffort` / `asStyle` validate enum inputs from the request body.

## Web (frontend) — `packages/web/src/`

- **App.tsx** — layout (TaskList rail | TaskDetail pane); fetches config + repos +
  tasks on mount; routes WsEvents into a task map + per-task event list.
- **useWs.ts** — auto-reconnect WebSocket (1s→30s backoff).
- **api.ts** — REST client; only sets JSON content-type when a body is sent (avoids
  `FST_ERR_CTP_EMPTY_JSON_BODY` on bodyless POSTs).
- **types.ts** — MANUAL mirror of `packages/server/src/types.ts`.
- **components/** — TaskList, NewTaskForm (model/effort/style/repo selects), TaskDetail
  (badges + usage + actions), ClarifyChat, WorkerLog.
