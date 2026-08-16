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
  - `assistant` → `onAssistantText(concatenated text blocks)` + `handleToolUse()` (walks
    the content array for `tool_use` blocks; `name==='Task'` → records the id in
    `pendingTasks` and calls `onToolUse(name, summary, true, subagentType)`;
    any other tool → `onToolUse(name, summary, false)`)
  - `user` → `handleToolResult()` (walks content for `tool_result` blocks; if the
    `tool_use_id` is in `pendingTasks`, calls `onSubagentResult` and prunes the entry;
    main-worker tool results are intentionally ignored)
  - `result` → `onResult(result, is_error, usage)`; `parseUsage` reads
    `input_tokens` / `output_tokens` / `cache_*` / `total_cost_usd` / `num_turns`.
  - all other types (including `control_response`) → tolerant no-op.
- **`send(text)`** writes a stream-json `user` turn to the child's stdin.
- **`interrupt()`** writes a `{type:'control_request', request_id:<uuid>, request:{subtype:'interrupt'}}` line to stdin (ESC-style hard stop; child stays alive and idles). Wrapped in try/catch for a closed stdin.
- **`kill()`** ends stdin and sends SIGTERM (both wrapped in try/catch).
- **`pendingTasks`** — bounded `Map<tool_use_id, subagent_type>`; prunes on result; capped at 200 entries (oldest evicted) to prevent unbounded growth.
- Callbacks: `onSession`, `onAssistantText`, `onPartial`, `onResult`, `onToolUse(name, summary, isSubagent, subagentType?)`, `onSubagentResult(subagentType, summary, isError)`, `onExit`, `onSpawnError`.
- Helpers `asRecord` / `asString` keep parsing typed without `any`. `summarizeTool(name, input)` and `summarizeResult(content)` produce compact one-line summaries.

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
- **`message(taskId, text)`** — accepted while `status ∈ {clarify, planning, executing,
  validating}` and a runner exists (gate lifted from clarify-only); throws otherwise.
  Emits an `operator` event and calls `runner.send(text)`.
- **`interrupt(taskId)`** (new) — looks up the runner (throws if none); adds the task to
  the private `interrupting` Set; calls `runner.interrupt()`; emits a `status` note. Does
  **not** change the task's status (worker idles awaiting the next `message()`).
- **`interrupting` guard in `detect()`** — at the top of `detect()`, if
  `interrupting.has(taskId)` and `isResult` is true, the flag is consumed, a
  `'turn interrupted — awaiting your direction'` status event is emitted, and the method
  returns early — skipping all token detection and the `isError`-fail branch. This
  prevents a hard Stop from failing the task.
- **`resume` / `done` / `cancel` / `shutdown`** — resume a `blocked` task after the
  missing agent is added; finish + local-sync after merge + remove worktree; cancel +
  remove worktree; kill all live runners. `done()`/`cancel()`/`fail()`/`onPr()` each call
  `interrupting.delete(taskId)` to prevent flag leakage across a task's lifecycle.
- `planKickoff` → run `/core_piv_loop:plan-feature`, QA the plan, emit `ZMRNG_PLAN_READY`.
  `executeKickoff(branch, defaultBranch, planPath)` → `/core_piv_loop:execute` →
  `ZMRNG_VALIDATING` → qa/code-reviewer/doc-updater chain → commit → push →
  `gh pr create --base <defaultBranch>` → print PR URL.

## Terminal — `packages/server/src/terminal.ts`

Owns the PTY sessions backing the Workspace bottom-dock terminal (one shell per
`GET /ws/terminal` WebSocket). Mirrors `runner.ts`'s factory-seam pattern so tests never
spawn a real shell.

- **`PtySession`** — `write(data)` / `resize(cols, rows)` / `kill()`; a node-pty handle
  satisfies this, and so can a test double.
- **`PtyCallbacks`** — `onData(data)` / `onExit(code)`, forwarded by the PTY to its owner.
- **`PtySpawnOptions`** — `{ cwd, shell, env }`, everything a factory needs to spawn one shell.
- **`PtyFactory`** — `(opts: PtySpawnOptions, cb: PtyCallbacks) => PtySession`; swappable
  for tests/adapters. **`defaultPtyFactory`** wraps `node-pty`'s `pty.spawn` (`name:
  'xterm-color'`, `cols: 80`/`rows: 24` initial geometry) and adapts its `onData`/`onExit`
  events onto `PtyCallbacks`; `kill()` is wrapped in try/catch for an already-exited shell.
- **`parseClientMsg(raw: string): TermClientMsg | undefined`** — pure, tolerant parse of one
  client→server frame: malformed JSON, a non-object, an unknown `type`, or an ill-typed
  field all yield `undefined` rather than throwing. Accepts `{type:'input', data:string}`
  and `{type:'resize', cols:number, rows:number}`.
- **`TerminalManager`** — tracks live sessions in a `Set<PtySession>`.
  - **`create(cb: PtyCallbacks): PtySession`** — copies `process.env`, deletes
    `ANTHROPIC_API_KEY` when `config.authMode === 'oauth'` (mirrors the runner so a
    `claude` launched inside the terminal uses Max OAuth, never the metered API), spawns
    via the injected `factory` at `cwd: config.projectsDir` / `shell: config.shell`, wraps
    `onExit` to self-remove the session from the tracked set *before* notifying the caller
    (so a later `killAll()` never double-kills an already-exited shell), and tracks the
    result.
  - **`killAll(): void`** — best-effort `kill()` (try/catch) on every tracked session, then
    clears the set. Called from `index.ts`'s `shutdown()` alongside `manager.shutdown()`.

## Db — `packages/server/src/db.ts`

SQLite (better-sqlite3, WAL).

- **Tables:** `tasks` (id, title, body, status, session_id, branch, worktree, pr_url,
  model, effort, style, **repo_id**, usage counters, queued, timestamps) and `events`
  (autoincrement id, task_id, ts, kind, payload JSON) + `idx_events_task`.
- **Migrations:** `ensureColumns()` reads `PRAGMA table_info(tasks)` and `ALTER`s any
  missing column (idempotent); columns also live in `SCHEMA` for fresh DBs.
- **Durability:** constructor sets `wal_autocheckpoint = 1000` to bound in-run WAL
  growth. **`close()`** runs `wal_checkpoint(TRUNCATE)` then closes the handle — called
  from the `shutdown()` (SIGINT/SIGTERM) path in `index.ts` so recent tasks are flushed
  into the durable `.db` and never left living only in the `-wal` sidecar (which, if
  dropped/reset, would revert the DB to a stale checkpoint and "vanish" tasks).
- **`rowToTask`** maps `repo_id` → `repoId`, backfilling `config.defaultRepoId` when null.
- **`createTask`**, **`addUsage`** (atomic `col = col + delta`), `getTask`, `listTasks`,
  `updateTask` (field→column patch), `insertEvent`, `getEvents`, **`taskCount`** (logged
  at startup alongside `dbPath` to surface which DB loaded).

## Config — `packages/server/src/config.ts`

Env parsing + repo registry.

- **`config`**: `port`, `targetRepo` (default repo path, back-compat), `repos[]`,
  `defaultRepoId`, `repoWarnings[]`, `agents[]`, `defaultModel`, `maxLanes`, `repoRoot`,
  `dataDir` (writable per-user data dir — `REPO_ROOT` in dev, `~/Library/Application
  Support/zmrng` in the bundled app), `dbPath`, `webDist`, `authMode` (`'oauth'` default
  strips `ANTHROPIC_API_KEY` from worker/terminal child envs; `'apikey'` preserves it),
  **`projectsDir`** (root dir for the workspace terminal's PTY, == `PROJECTS_DIR`),
  **`shell`** (login shell for the workspace terminal — `SHELL` env, else `/bin/sh`).
  (`worktreesDir` was removed — each task derives the worktrees dir from
  `path.join(repo.path, 'worktrees')` at spawn time.)
- **`resolveAuthMode(env)`** — pure: any `ZMRNG_AUTH_MODE` other than `'apikey'`
  (case-insensitive) resolves to the safe default, `'oauth'`.
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
  local-only repos with no remote). Worktrees live under the **target repo's own**
  `worktrees/<shortId>` (e.g. `<repo.path>/worktrees/<shortId>`); `phases.ts` passes
  `path.join(repo.path, 'worktrees')` at spawn time.
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
  `POST /api/tasks/:id/{start,message,interrupt,resume,done,cancel}`.
  `interrupt` is bodyless; mirrors the `resume` route's try/catch + 400 on error shape.
  (This list predates several routes — `/api/agents`, `/api/preflight`, `/api/ui-state`,
  `/api/tasks/:id/{files,file,notes,chat}`, `/api/tasks/:id/archive`, and the
  Projects-dir browsing pair `GET /api/projects/files` (dotfile-skipping, depth-capped
  tree of `config.projectsDir`) + `GET /api/projects/file?path=` (read-only read of an
  arbitrary project file, for no-task file viewing) — that already exist in `index.ts`; a
  fuller pass is owed here, tracked as a doc-sync gap rather than documented speculatively
  in this change.)
- **WS:** `GET /ws` — adds the socket to the hub, sends a `snapshot`. `GET /ws/terminal` —
  one PTY per socket via `TerminalManager.create()`; forwards PTY output as
  `{type:'data', data}` frames and relays the exit code as `{type:'exit', code}` before
  closing the socket; client `input`/`resize` frames are parsed with the tolerant
  `parseClientMsg()` from `terminal.ts`. Spawn failures and mid-session errors close the
  socket rather than throwing.
- **Static:** serves `web/dist` in production with an SPA not-found fallback.
- **Lifecycle:** SIGINT/SIGTERM → `manager.shutdown()` (kill workers) + `terminals.killAll()`
  (kill PTYs) → close. Logs `repoWarnings` at startup.
- `asEffort` / `asStyle` validate enum inputs from the request body.

## Web (frontend) — `packages/web/src/`

> The `App.tsx`/`components/` bullets below predate the Workspace/Board merge (see the
> root `CLAUDE.md` project-structure tree for the current `App.tsx`/`WorkspaceView`
> shape — `TaskDetail` no longer exists, replaced by `TaskControls` + `WorkspaceTabs`).
> Left as-is rather than speculatively rewritten in this change; the terminal-dock
> bullets at the end of this section are current as of 2026-08-16.

- **App.tsx** — layout (TaskList rail | TaskDetail pane); fetches config + repos +
  tasks on mount; routes WsEvents into a task map + per-task event list.
  Passes `onInterrupt={() => api.interrupt(selected.id)}` into `TaskDetail`.
- **useWs.ts** — auto-reconnect WebSocket (1s→30s backoff).
- **api.ts** — REST client; only sets JSON content-type when a body is sent (avoids
  `FST_ERR_CTP_EMPTY_JSON_BODY` on bodyless POSTs). Includes `interrupt(id)` (bodyless POST).
- **types.ts** — MANUAL mirror of `packages/server/src/types.ts`. `EventSub` includes
  `'tool' | 'subagent' | 'subagent_result'`; `EventPayload` includes `tool?`, `actor?`,
  `subagentType?`, `summary?`.
- **status.ts** — `statusColor(status)` backed by `--status-*` tokens; `actorColor(actor)`
  backed by `--actor-*` tokens (`main`, `frontend-specialist`, `backend-specialist`, `qa`,
  `code-reviewer`, `doc-updater`, `general-purpose`, with `--actor-default` fallback).
- **theme.css** — adds `--actor-*` palette block (muted hues distinct per actor type, all
  glass-legible); no `--status-*` changes.
- **components/**:
  - `TaskList`, `NewTaskForm` (model/effort/style/repo selects) — unchanged.
  - `TaskDetail` — `Props` now includes `onInterrupt`; defines `LIVE` set
    (`clarify|planning|executing|validating`) and `STOPPABLE` set (`planning|executing|validating`);
    renders `<ClarifyChat>` for all `LIVE` phases (not just clarify), with a phase-appropriate
    `placeholder`; shows a **Stop** button (wired to `onInterrupt`) for `STOPPABLE` phases;
    autobar copy updated to `'Running autonomously — type to steer, Stop to interrupt.'`.
  - `ClarifyChat` — generalized into the always-on live composer; new optional `placeholder`
    prop (default: clarify copy); behavior unchanged.
  - `WorkerLog` — renders `tool` events as compact `⚙ {tool}: {summary}` rows,
    `subagent` as `▸ {subagentType} — {summary}`, and `subagent_result` as
    `◂ {subagentType}: {summary}`; all actor rows left-accented with `actorColor(...)`
    as a sanctioned dynamic inline style.
  - `TerminalDock` (`components/TerminalDock.tsx`) — the Zed-style bottom-dock terminal,
    now doubling as the **bottom nav bar**: its always-visible bar holds four
    content-sized pane toggles — **Terminal** (the dock body, unchanged), **Tasks** (the
    right rail), **Workspace** (the centre tab pane), **Settings** (an overlay modal). Each
    button highlights while its pane is open. Tasks/Workspace visibility persists in
    `GlobalUiState.panes` (both default closed → a fresh load shows only the Files tree);
    Settings is an ephemeral, non-persisted modal (`SettingsModal`). Global (not per-task),
    rendered by `WorkspaceView` regardless of task selection.
    `open`/`height` are controlled props sourced from `App.tsx`'s
    `GlobalUiState.terminalDock` (default closed / 300px, clamped `[120, 640]`); the tab
    list itself is local `useState` driven by the pure `terminalDock.ts` reducer
    (`emptyDock`/`addTerminal`/`closeTerminal`/`setActive`) — ephemeral, never persisted,
    so a reload always starts with no shells. Auto-seeds one terminal only on the
    closed→open transition (derived-during-render pattern, not a `useEffect`, per the
    `react-hooks/set-state-in-effect` rule). Ctrl+` toggles the dock at the window level;
    a drag handle resizes the body via `pointerdown`/`pointermove`/`pointerup`. Tabs are
    unmounted (not just hidden) while the dock is closed, so no PTY exists until opened.
  - `Terminal` (`components/Terminal.tsx`) — one `@xterm/xterm` instance + one WebSocket to
    `/ws/terminal` per mounted instance (keyed by the dock tab's `id`). `@xterm/addon-fit`
    + a `ResizeObserver` keep the PTY geometry in sync, sending a `resize` frame on open
    and on every observed resize. Terminal colors are read live from the `--font-mono`,
    `--well`, `--text`, `--accent` CSS custom properties (no hard-coded values).
    `attachCustomKeyEventHandler` swallows ctrl+` so the dock-toggle chord never reaches a
    focused shell. Not unit-tested (jsdom has no canvas) — the protocol logic it depends on
    (`terminalProtocol.ts`) is.
- **terminalDock.ts** — pure reducer, `DockState { tabs: DockTab[]; activeId: string | null
  }`. `emptyDock()`, `addTerminal(state, id)` (appends + focuses), `closeTerminal(state,
  id)` (focus falls to the left neighbor, or `null` once empty), `setActive(state, id)`.
  Ids are always caller-supplied (never `Math.random`/`Date.now` inside the module) so it
  stays pure and deterministic to test.
- **terminalProtocol.ts** — `encodeInput(data)` / `encodeResize(cols, rows)` produce exactly
  the frames the server's `parseClientMsg` accepts; `parseServerMsg(raw)` tolerantly parses
  a server→client `TermServerMsg` (`data` | `exit`), returning `undefined` on anything
  malformed rather than throwing.
