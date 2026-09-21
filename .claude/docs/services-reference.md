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
- **Vitest fork cap for workers:** immediately after that strip, the constructor also
  sets `env.ZMRNG_VITEST_MAX_FORKS = '2'` in the child env. A worker turn ends by
  running the validation gate (`verify.sh`), and vitest's own default (`cores - 1`
  forks) meant several concurrent workers validating at once oversubscribed the host —
  load-induced flakes. `packages/server/vitest.config.ts` / `packages/web/vitest.config.ts`
  read `ZMRNG_VITEST_MAX_FORKS` (default 3, used by the operator's own interactive
  `npm test`) into `test.poolOptions.forks.maxForks`; the worker's tighter `2` only
  applies inside the spawned `claude` child's env, never the operator's shell.
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
- **`send(text, attachments?: Attachment[])`** writes a stream-json `user` turn to the
  child's stdin, built via `buildUserMessage(text, attachments)`.
- **`interrupt()`** writes a `{type:'control_request', request_id:<uuid>, request:{subtype:'interrupt'}}` line to stdin (ESC-style hard stop; child stays alive and idles). Wrapped in try/catch for a closed stdin.
- **Process group:** the child is spawned `detached: true`, so it becomes its own
  process-group leader (pgid == child.pid). This lets `kill()` signal the **whole tree**
  — `claude` *and* the grandchildren it spawns (subagent claudes, bash, git, semgrep,
  osv-scanner, vitest, tsc, vite) — instead of the bare pid, which would leave those
  grandchildren orphaned to launchd (PPID 1) burning CPU/RAM.
- **`kill()`** ends stdin and `signalTree('SIGTERM')`, then arms a 5s (`SIGKILL_GRACE_MS`)
  `unref`'d timer that `signalTree('SIGKILL')`s a wedged child; the exit handler clears it.
  **`signalTree(signal)`** sends `process.kill(-pid, signal)` (the group), falling back to a
  bare-pid `child.kill(signal)` if the group send throws (child already reaped, or no pgroup).
- **`killGroupSync()`** — synchronous, timer-free group `SIGKILL` for the `process.on('exit')`
  backstop in `index.ts` (see `TaskManager.hardKillAll`); guarantees the worker tree dies
  with the server even when the 2s force-exit beats the async 5s escalation. Exposed as an
  optional method on the `RunnerLike` seam (test doubles may omit it).
- **`pendingTasks`** — bounded `Map<tool_use_id, subagent_type>`; prunes on result; capped at 200 entries (oldest evicted) to prevent unbounded growth.
- Callbacks: `onSession`, `onAssistantText`, `onPartial`, `onResult`, `onToolUse(name, summary, isSubagent, subagentType?)`, `onSubagentResult(subagentType, summary, isError)`, `onExit`, `onSpawnError`.
- Helpers `asRecord` / `asString` keep parsing typed without `any`. `summarizeTool(name, input)` and `summarizeResult(content)` produce compact one-line summaries.

### Multimodal attachments (operator image/PDF drop/paste)
- **`Attachment`** (`types.ts`) — `{ kind: 'image' | 'document'; mediaType: string;
  dataBase64: string; name?: string }`. `dataBase64` carries no `data:...;base64,`
  prefix. Never persisted to disk or the DB — transient, held only long enough to build
  one outbound stream-json message.
- **`ALLOWED_MEDIA_TYPES`** — `image/png`, `image/jpeg`, `image/gif`, `image/webp`,
  `application/pdf`. **`MAX_ATTACHMENTS`** — 10 per turn. **`MAX_ATTACHMENT_BYTES`** —
  8 MB, checked against the *decoded* size (`Math.floor(base64.length * 3 / 4)`).
- **`sanitizeAttachments(raw: unknown): Attachment[]`** — tolerant coercion of untyped
  request/frame input: drops any entry with a bad shape, a disallowed `mediaType`, or an
  oversized decoded payload, and caps the array at `MAX_ATTACHMENTS`. `kind` is always
  *derived* from the (allow-listed) `mediaType` — `application/pdf` → `document`, else
  `image` — so a mismatched/absent client-supplied `kind` field can never smuggle a PDF in
  as an image or vice-versa. Never throws — a bad attachment is dropped, never a 500.
  Shared by `POST /api/tasks`, `POST /api/tasks/:id/message`, and the `/ws/chat` `input`
  frame parser.
- **`buildUserMessage(text: string, attachments?: Attachment[]): object`** — builds the
  stream-json `{type:'user', message:{role:'user', content:[...]}}` envelope. Attachments
  become leading content blocks (`{type:'image', source:{type:'base64', media_type, data}}`
  for images, `{type:'document', ...}` for PDFs) ahead of the trailing `{type:'text',
  text}` block, per the Anthropic content-ordering convention; a text-only turn keeps the
  pre-feature single-text-block shape. PDFs are sent inline as base64 `document` blocks
  over stream-json stdin under Max OAuth — if a future CLI version rejects inline
  documents, the sanctioned fallback (spilling to `os.tmpdir()` and referencing the path in
  the text block) stays isolated to this function.

## TaskManager / phases — `packages/server/src/phases.ts`

The phase state machine and orchestration.

- **States:** `backlog → clarify → planning → executing → validating → review → done`
  (plus `blocked` for a missing subagent, and `failed`). Each autonomous phase
  (planning/executing) runs in its own fresh `claude` session. `building` is a legacy
  single-phase status, retained only for old DB rows/events.
- **`createTask(title, body, model?, effort?, style?, repoId?, flow?, attachments?:
  Attachment[])`** — resolves `repoId` against the registry (falls back to
  `config.defaultRepoId`), inserts, broadcasts. A non-empty `attachments` (new-task-box
  drop/paste) is held in the private `pendingAttachments: Map<taskId, Attachment[]>` —
  it is not sent yet, since the runner doesn't exist until `start()`.
- **`start(taskId)`** — resolves the target repo via `repoById`, creates a worktree in
  it, transitions to `clarify`, spawns the runner, sends the clarify kickoff. Consumes (and
  deletes) any `pendingAttachments` entry for the task at this single send, so a re-start
  after a `fail` never double-injects the original attachments.
- **`systemPrompt(branch, repoPath, defaultBranch, style)`** — repo-agnostic; tells the
  worker it operates on the target repo at `repoPath`, on branch `branch` cut from
  `defaultBranch`, to obey *that repo's* CLAUDE.md/.claude/rules, never touch the
  default branch, and apply the per-task caveman `style` to narration only.
- **Detection (control tokens):** `ZMRNG_READY` (clarify→planning); `ZMRNG_PLAN_READY
  model=… effort=… plan=…` (planning→executing, carries the execute-phase model/effort/
  plan path); `ZMRNG_VALIDATING` (executing→validating); `ZMRNG_SCAN_READY` (the worker
  committed and is waiting for the security scan — handled BEFORE PR detection; see the
  Security-scan gate below); a GitHub PR URL (→review, only after `openPrKickoff`);
  `ZMRNG_BLOCKED: <reason>` (any autonomous phase → `blocked`, lane held, child alive).
- **Per-phase fresh sessions:** each autonomous phase is its own `claude` child. On
  `ZMRNG_READY` the clarify child is replaced by a planning child (always `opus`/`high`,
  seeded with the condensed clarify transcript); on `ZMRNG_PLAN_READY` it is replaced by
  an execute child on the plan's chosen model/effort, which runs through validate → PR.
- **Execute lanes:** cap = `config.maxLanes` (`ZMRNG_MAX_LANES`, default 2). A task takes
  a lane at `ZMRNG_READY`; extra READY tasks park in `planning` with `queued=true` in
  `executeQueue`; `freeLane` (on PR/done/cancel/fail) promotes the next via
  `beginPhaseForFlow` — normally `beginPlan`/`beginDirect`, but a queued **restart**
  (see below) can also park in `validating`, and `beginPhaseForFlow` checks the private
  `resuming` Set first, routing those to `beginResume` instead.
- **`message(taskId, text, attachments?: Attachment[])`** — accepted while `status ∈
  {clarify, planning, executing, validating}` and a runner exists (gate lifted from
  clarify-only); throws otherwise. A live status with **no** runner (the worker session
  was lost to an app restart) throws a specific, actionable error — `This task's worker
  session has ended (the app was restarted). Press "Restart agent" to continue talking
  to it.` — instead of the generic "operator messages are only accepted while the
  worker is live". Emits an `operator` event (its logged text gains a trailing `[n
  attachment(s)]` suffix when `attachments` is non-empty) and calls
  `runner.send(text, attachments)`.
- **Stale-task recovery (option B — a fresh agent, never `claude --resume`):** a task's
  `claude` child dies with the server process (e.g. a clean app quit); a freshly
  constructed `TaskManager` has an empty `runners` map even though SQLite may still show
  a task in a live phase. Persisted `Task.stale: boolean` (SQLite `stale INTEGER NOT
  NULL DEFAULT 0`, additive migration) lets the UI tell an orphaned task apart from a
  genuinely-live one, since `status` alone is identical in both cases. `stale` is set
  only by `reconcileOrphans()` and cleared only when a fresh agent is (re)spawned (plus
  defensively in `cancel`/`done`).
  - **`reconcileOrphans(): void`** — called once from `index.ts` right after
    construction, before `app.listen`. For every task whose status is `clarify`,
    `planning`, `executing`, or `validating` with no live runner (always true at boot):
    marks it `stale: true`, clears `queued`, and emits a persisted `status` event noting
    the session ended and Restart is available. Does **not** re-acquire a lane —
    a lane is only taken when the operator actually restarts a lane-holding phase.
    `blocked` and legacy `building` are excluded (out of scope; `blocked` has its own
    resume path).
  - **`async restartAgent(taskId: string): Promise<void>`** — the manual "Restart
    agent" action, behind `POST /api/tasks/:id/restart`. Rejects (throws) if the task
    is not in a resumable status (the same four live phases), already has a live
    runner ("already live — nothing to restart"), or has no worktree/branch/repo.
    Re-resolves `repoSlug(repo.path)` into `repoSlugs` (lost on restart) so PR
    detection stays repo-scoped. Clears `stale`; emits a "Restart agent" status note.
    `clarify` holds no lane → spawns the fresh session directly via `beginResume`.
    `planning`/`executing`/`validating` hold an execute lane → acquires a lane
    (respecting `config.maxLanes`) and calls `beginResume`, or — if lanes are full —
    adds the task to the private `resuming: Set<string>`, sets `queued: true`, and
    pushes it onto `executeQueue`; when `freeLane()` later promotes it, `resuming`
    membership routes it to `beginResume` instead of a fresh `beginPlan`/`beginDirect`.
  - **`beginResume(task)`** (private) — spawns via the existing `spawnPhase` seam
    (planning forces `opus`/`high`, mirroring `beginPlan`; other phases reuse the
    task's persisted `model`/`effort`), clears `resuming`/`queued`/`stale`, emits a
    status note, and sends `resumeKickoff(task, branch, defaultBranch, transcript)`
    seeded with `clarifyTranscript(taskId)` (already condenses every operator +
    assistant turn across all phases, not just clarify).
  - **`resumeKickoff(task, branch, defaultBranch, transcript): string`** (exported, for
    prompt-contract tests) — composes a RESUME preamble (normal English: a fresh agent
    is taking over after an app restart, names the phase, carries title/body, orders
    the agent to inspect the worktree — files, `git log`/`status`/`diff`, the plan file
    — **before** acting and to continue rather than redo prior work) over the
    **existing, already-pinned per-phase kickoff**, so the heavy content (RED→GREEN→
    REFACTOR, PR body, grill/test-strategy) is reused verbatim rather than duplicated:
    `clarify` → preamble + transcript block + `clarifyKickoff(task)`; `planning` →
    preamble + `planKickoff(task, transcript)` (transcript already lives inside
    `planKickoff`, so it is not repeated); `executing`/`validating` → preamble +
    transcript block + `executeKickoff(branch, defaultBranch, task.planPath)`.
  - Transient-set hygiene: `resuming` is deleted alongside `interrupting`/
    `blockedFrom` in `fail`/`cancel`/`done`/`deleteTask`; `cancel`/`done` also clear
    `stale` defensively.
- **`interrupt(taskId)`** (new) — looks up the runner (throws if none); adds the task to
  the private `interrupting` Set; calls `runner.interrupt()`; emits a `status` note. Does
  **not** change the task's status (worker idles awaiting the next `message()`).
- **`interrupting` guard in `detect()`** — at the top of `detect()`, if
  `interrupting.has(taskId)` and `isResult` is true, the flag is consumed, a
  `'turn interrupted — awaiting your direction'` status event is emitted, and the method
  returns early — skipping all token detection and the `isError`-fail branch. This
  prevents a hard Stop from failing the task. `pendingAttachments` is cleaned up the same
  way — deleted in `cancel()`/`deleteTask()` alongside `interrupting`/`blockedFrom` — so an
  un-started task's held attachments never leak past its lifecycle.
- **`resume` / `done` / `cancel` / `shutdown` / `hardKillAll`** — resume a `blocked` task
  after the missing agent is added; finish + local-sync after merge + remove worktree; cancel
  + remove worktree; `shutdown()` `kill()`s all live runners (graceful SIGTERM→SIGKILL).
  `hardKillAll()` is the synchronous last-resort called from `index.ts`'s `process.on('exit')`
  backstop — it group-`SIGKILL`s every live worker tree (`runner.killGroupSync?.()`) so a
  force-exit that beats the async escalation can't strand `claude` grandchildren orphaned to
  launchd. `done()`/`cancel()`/`fail()`/`onPr()` each call `interrupting.delete(taskId)` to
  prevent flag leakage across a task's lifecycle.
- `planKickoff` → run `/core_piv_loop:plan-feature`, QA the plan, emit `ZMRNG_PLAN_READY`.
  `executeKickoff(branch, defaultBranch, planPath)` → `/core_piv_loop:execute` →
  `ZMRNG_VALIDATING` → qa/code-reviewer/doc-updater chain → commit **on the branch** →
  emit `ZMRNG_SCAN_READY` → **stop and wait** (no self-push, no self-PR). The push/PR
  ceremony was extracted out of the execute tail into `openPrKickoff` (below), sent by
  the orchestrator only after the security scan passes. `directKickoff` gets the same
  commit-and-wait tail.

### Security-scan gate — `packages/server/src/{phases,scanRunner,securityScan}.ts`

A deterministic scan that brackets the probabilistic worker between `validating` and the
PR (ADR-0001). The task **stays in `validating`** throughout — there is deliberately no
`scanning` status (D6). Pieces:

- **`SCAN_READY_RE`** (`/^\s*ZMRNG_SCAN_READY\s*$/m`) — the anchored control token the
  worker prints once it has committed and is ready for the scan.
- **`openPrKickoff(branch, defaultBranch, planPath?)`** (exported) — the extracted
  push + `gh pr create` ceremony (reuses `PR_BODY_TEMPLATE` verbatim), sent into the
  **same live session** when the scan is green. The worker then prints the PR URL and the
  existing PR detection drives `validating → review` unchanged.
- **`securityFixKickoff(findings, round, maxRounds)`** (exported) — sent when the scan is
  red. Carries the `formatFindingsForAgent` report, orders the worker to FIX every
  blocking finding (patch code / pin or replace the vulnerable dep — not merely note it),
  TDD where a regression test is meaningful, re-commit in place, and re-emit
  `ZMRNG_SCAN_READY`. States the round budget. The `direct` flow's fix prompt is framed
  SCA-only (D2).
- **`scanFactory: ScanRunnerFactory`** — the injected 4th `TaskManager` constructor arg
  (defaults to `defaultScanRunnerFactory`); tests pass a `FakeScanRunner`. Plus a private
  `securityRounds: Map<taskId, number>`, cleared alongside the other transient sets in
  `fail`/`cancel`/`done`/`deleteTask`.
- **`onScanReady(task)`** (private) — the core: (1) resolve the effective policy via
  `mergeSecurityPolicy(config.security, repoOverride)`; if `enabled === false` →
  `openPrKickoff` + `securityStatus:'skipped'`, no scan row (the only silent skip). (2)
  **D3:** `freeLane(task.id)` *before* awaiting the scan, so the deterministic machine
  work never idles one of the 2 lanes. (3) preflight the binaries; missing/unprovisionable
  → `onBlocked`. (4) `await scanFactory({ worktree, baseRef: defaultBranch, policy, sast })`.
  (5) normalize + `evaluateThreshold`. (6) persist a `security_scans` row (round, verdict,
  findings JSON, tool versions), `patch(securityStatus)`, emit a `security` event. (7)
  **green** → `openPrKickoff`; **red & round < maxRounds** → re-acquire a lane (queues
  behind the cap like any execute work, routed back into the **existing** live session,
  never a fresh child), bump the round, `securityFixKickoff`; **rounds exhausted** →
  `onBlocked` with the findings summary; **any factory rejection / unparseable output** →
  fail-closed (treated as red-blocked, never a pass).
- **`ScannerUnavailableError`** (from `scanRunner.ts`) is the seam that distinguishes a
  missing binary (→ `blocked`, actionable install message) from a scan that ran but
  errored (→ fail-closed red). `defaultScanRunnerFactory` execFiles semgrep + osv-scanner
  offline/vendored (`--baseline-commit <git merge-base defaultBranch HEAD>`,
  `--config <policy.semgrepConfig>`; D4) and auto-provisions on first use (D5). It is
  exercised by **no automated test** (semgrep/osv absent on dev) — a planted-vuln hand-
  verification is an orchestrator/user-owned post-merge step.
- **Route:** `GET /api/tasks/:id/security-scans` → `db.listSecurityScansForTask(id)`.
- **Web:** `SecurityPanel` (read-only) renders `securityStatus` + round count + latest
  blocking findings, fed by the route and the live `security` ws event.

## Terminal — `packages/server/src/terminal.ts`

Owns the PTY sessions backing the Workspace Terminal card (`GET /ws/terminal`). Sessions
are **server-owned and keyed by id**, not tied 1:1 to a socket — a transient socket drop
(machine lock, network blip, page reload) no longer kills the shell; the session survives
under a grace timer and a reconnecting client reattaches to it. Mirrors `runner.ts`'s
factory-seam pattern so tests never spawn a real shell.

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
  field all yield `undefined` rather than throwing. Accepts `{type:'attach', sessionId?:
  string, cols:number, rows:number}`, `{type:'input', data:string}`, and
  `{type:'resize', cols:number, rows:number}`.
- **`TerminalManager`** — tracks live sessions in a `Map<sessionId, TermSession>` (each
  `TermSession` wraps the `PtySession` + a bounded byte-capped ring buffer of recent
  output + a pending grace-timer handle). Two extra injectable seams alongside
  `PtyFactory`: a `TimerFns` (`setTimeout`/`clearTimeout`, default the real globals) and
  an id factory (default `randomUUID`) — both swappable so tests can fast-forward grace
  expiry without real timers.
  - **`attach(sessionId: string | undefined, cb: PtyCallbacks): { sessionId: string;
    replay: string }`** — resolve-or-spawn. A known, still-live id cancels its pending
    grace timer, swaps in the new socket's callbacks, and returns its ring-buffered
    output as `replay` so the reattaching client can catch up. An unknown, expired, or
    omitted id spawns a fresh PTY under a newly-generated id (same env-strip-under-oauth
    + `cwd`/`shell` spawn as before) and returns an empty `replay`.
  - **`write(sessionId, data)` / `resize(sessionId, cols, rows)`** — route to the
    session's PTY; a no-op (never throws) if `sessionId` is unknown.
  - **`detach(sessionId): void`** — called on socket close. Does **not** kill the PTY;
    starts a grace timer (`config.terminalGraceMs`, default 600000ms/10min via
    `ZMRNG_TERMINAL_GRACE_MS`). If nothing calls `attach()` with that id before the timer
    fires, the session is reaped (`kill()` + removed from the map).
  - **`killAll(): void`** — best-effort `kill()` (try/catch) on every tracked session,
    clears all pending grace timers, then clears the map. Called from `index.ts`'s
    `shutdown()` alongside `manager.shutdown()`.

## ChatManager — `packages/server/src/chatAgent.ts`

Owns the live standalone agent-chat sessions backing the bottom-dock Chat tab (one
`claude` session per `GET /ws/chat` WebSocket). Independent of the task lifecycle and
distinct from the existing per-task `/api/tasks/:id/chat` REST chat (`chat.ts`,
`ChatMessage`) — this is a free-form, ephemeral side channel, never persisted to the DB.

- **`chatSystemPrompt(style: CaveStyle, projectsDir: string): string`** — the
  conversational system prompt. Deliberately NOT `phases.ts`'s worker `systemPrompt()`:
  no task, branch, PR, or control-token protocol. Frames the agent as a helpful
  assistant embedded in the zmrng chat panel with read/explore filesystem access to
  `projectsDir`, asks it to keep tool use purposeful, and appends the shared
  `styleDirective(style)` (exported from `phases.ts` — was module-private — so the
  caveman contract stays DRY between the worker and the chat agent).
- **`parseChatClientMsg(raw: string): ChatClientMsg | undefined`** — pure, tolerant
  parse of one client→server frame (mirrors `terminal.ts`'s `parseClientMsg`):
  malformed JSON, a non-object, an unknown `type`, or an ill-typed field all yield
  `undefined` rather than throwing. Accepts `{type:'start', model, effort, style}`,
  `{type:'input', text, attachments?}`, and `{type:'interrupt'}`. An `input` frame's
  `attachments` field is run through `sanitizeAttachments()` (from `runner.ts`) — a
  malformed/oversized/disallowed entry is silently dropped rather than reaching the
  runner; the field is entirely omitted from the returned object when the sanitized
  array is empty.
- **`ChatConfig`** — `{ model: string; effort: EffortLevel; style: CaveStyle }`, the
  per-tab controls chosen for one session.
- **`ChatManager`** — tracks live sessions in a `Set<RunnerLike>`; constructed with the
  same `RunnerFactory` seam `TaskManager` uses (`defaultRunnerFactory` by default) so
  tests never spawn a real `claude`.
  - **`create(cfg: ChatConfig, cb: RunnerCallbacks): RunnerLike`** — spawns one
    conversational `claude` rooted at `config.projectsDir` with `chatSystemPrompt(cfg.style,
    config.projectsDir)` as its system prompt, wraps `onExit` to self-remove the session
    from the tracked set *before* notifying the caller (so a later `killAll()` never
    double-kills an already-exited session), and tracks the result. The OAuth env-strip
    already lives inside `Runner`'s constructor, so (unlike `TerminalManager`) this
    manager does not repeat it.
  - **`killAll(): void`** — best-effort `kill()` (try/catch) on every tracked session, then
    clears the set. Called from `index.ts`'s `shutdown()` alongside `manager.shutdown()`
    and `terminals.killAll()`.

## Db — `packages/server/src/db.ts`

SQLite (better-sqlite3, WAL).

- **Tables:** `tasks` (id, title, body, status, session_id, branch, worktree, pr_url,
  model, effort, style, **repo_id**, usage counters, queued, **stale**, **security_status**,
  timestamps); `events` (autoincrement id, task_id, ts, kind, payload JSON) +
  `idx_events_task`; and **`security_scans`** (autoincrement id, task_id, round, verdict,
  findings JSON, tool_versions JSON, ts) + its task index. All additive.
  `stale INTEGER NOT NULL DEFAULT 0` (additive, `ensureColumns()`) marks a task whose
  worker session was lost to an app restart — see `reconcileOrphans()`/`restartAgent()`
  in the TaskManager section above. `security_status` (nullable) carries the latest scan
  verdict (`pass`/`fail`/`skipped`) for the task.
- **Migrations:** `ensureColumns()` reads `PRAGMA table_info(tasks)` and `ALTER`s any
  missing column (idempotent); columns also live in `SCHEMA` for fresh DBs.
- **Durability:** constructor sets `wal_autocheckpoint = 1000` to bound in-run WAL
  growth. **`close()`** runs `wal_checkpoint(TRUNCATE)` then closes the handle — called
  from the `shutdown()` (SIGINT/SIGTERM) path in `index.ts` so recent tasks are flushed
  into the durable `.db` and never left living only in the `-wal` sidecar (which, if
  dropped/reset, would revert the DB to a stale checkpoint and "vanish" tasks).
- **`rowToTask`** maps `repo_id` → `repoId`, backfilling `config.defaultRepoId` when null.
- **`createTask`**, **`addUsage`** (atomic `col = col + delta`), `getTask`, `listTasks`,
  `updateTask` (field→column patch, incl. `securityStatus`), `insertEvent`, `getEvents`,
  **`insertSecurityScan(...)`** / **`listSecurityScansForTask(taskId)`** (the scan-row
  persistence reused by `onScanReady` and the `security-scans` route), **`taskCount`**
  (logged at startup alongside `dbPath` to surface which DB loaded).

## Config — `packages/server/src/config.ts`

Env parsing + repo registry.

- **`config`**: `port`, `targetRepo` (default repo path, back-compat), `repos[]`,
  `defaultRepoId`, `repoWarnings[]`, `agents[]`, `defaultModel`, `maxLanes`, `repoRoot`,
  `dataDir` (writable per-user data dir — `REPO_ROOT` in dev, `~/Library/Application
  Support/zmrng` in the bundled app), `dbPath`, `webDist`, `authMode` (`'oauth'` default
  strips `ANTHROPIC_API_KEY` from worker/terminal child envs; `'apikey'` preserves it),
  **`projectsDir`** (root dir for the workspace terminal's PTY, == `PROJECTS_DIR`),
  **`shell`** (login shell for the workspace terminal — `SHELL` env, else `/bin/sh`),
  **`terminalGraceMs`** (`ZMRNG_TERMINAL_GRACE_MS`, default 600000/10min — how long a
  detached terminal PTY stays alive waiting for a reattach before `TerminalManager`
  reaps it), **`terminalBufferBytes`** (`ZMRNG_TERMINAL_BUFFER_BYTES`, default
  262144/256KiB — cap on each session's replay ring buffer).
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
- **Security policy:** `config.security` is the global default `SecurityPolicy`
  (`enabled=true`, `maxRounds=2`, `semgrepConfig` with no owasp, `minSeverity='ERROR'`),
  from **`resolveSecurityPolicy(env)`**. A `RepoTarget` may carry an optional `security`
  override block (see `config/repos.example.json`); **`mergeSecurityPolicy(global,
  override)`** is the per-task seam `onScanReady` calls to get a repo's effective policy —
  never re-implement the merge.
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
- **Hook dedupe (`seedHarness`)** — before seeding `.claude/zmrng-hooks/` and
  registering them into `.claude/settings.local.json`, `seedHarness` calls
  **`targetRegisteredHooks(worktreePath)`**: reads the worktree's own (target-repo-owned)
  `.claude/settings.json`, defensively walks every hook event (missing/malformed file →
  empty set, seed everything), and collects `.py` basenames out of each hook's `command`
  string via `command.match(/[A-Za-z0-9_.-]+\.py/g)`. Matching is on **basename only**
  because the seeded copy lives under `.claude/zmrng-hooks/<name>` while the target's own
  copy lives under `.claude/hooks/<name>` — only the basename is stable across the two
  paths. For every hook script the target already registers, `seedHarness` skips **both**
  the file copy into `.claude/zmrng-hooks/` and the `settings.local.json` registration,
  and pushes a `harness hook <name> not seeded — target repo registers its own` note —
  registering the same script twice would fire it twice per event (Claude Code merges
  `settings.json` with `settings.local.json`), which for `stop_validate.py` meant running
  the whole validation gate twice per turn.
  - **`HOOK_DEDUPE_EXEMPT`** (`Set(['security_guard.py'])`) — always seeded regardless of
    what the target registers; it's the one hook whose absence costs safety rather than
    speed, and the two implementations are known to differ in source. The duplicated cost
    is one `python3` startup per tool call, not a test suite.
  - **`ZMRNG_FORCE_SEED_HOOKS=1`** — escape hatch env var that restores the old
    seed-everything behaviour (treats `targetRegisteredHooks` as empty).
  - **`zmrngHooksConfig(skip)`** — now takes the skip set and filters it out of every
    hook group across every event before the config is merged into
    `settings.local.json`; a group left with zero hooks (or an event left with zero
    groups) is dropped entirely rather than registered empty.
  - Settled in `.agents/plans/worker-fleet-cpu-contention.md` (T1).

## WsHub — `packages/server/src/ws.ts`

Fan-out broadcast hub: tracks a `Set<WebSocket>`, evicts on close/error, `send(socket,
event)` for a single client, `broadcast(event)` to all. All sends wrapped in try/catch.

## Fastify server — `packages/server/src/index.ts`

- **Body limit:** Fastify's default 1MB `bodyLimit` is raised to `32 * 1024 * 1024` (32MB)
  at construction (`Fastify({ logger: true, bodyLimit: ... })`) so a POST body carrying
  base64-encoded image/PDF attachments (up to `MAX_ATTACHMENTS` × `MAX_ATTACHMENT_BYTES`
  each) doesn't hit `FST_ERR_CTP_BODY_TOO_LARGE`.
- **REST:** `GET /api/config` (model, maxLanes, targetRepo, defaultRepoId, authMode; also
  `workspaceUrl` and `botHandle` for the Team tab — see Team workspace below),
  `GET /api/repos` (the registry), `GET /api/tasks`, `POST /api/tasks`
  (title/body/model/effort/style/repoId/flow/**attachments**), `GET /api/tasks/:id/events`,
  **`GET /api/tasks/:id/security-scans`** (→ `db.listSecurityScansForTask(id)`, mirrors the
  events route), `POST /api/tasks/:id/{start,message,interrupt,resume,done,cancel,restart}`.
  `interrupt` is bodyless; mirrors the `resume` route's try/catch + 400 on error shape.
  `POST /api/tasks/:id/restart` (bodyless) calls `manager.restartAgent(id)` — namespaced
  under the task, distinct from the self-update `POST /api/restart` (git-pull + rebuild
  zmrng's own repo, see the Web `components/` bullets below).
  `POST /api/tasks` and `POST /api/tasks/:id/message` both run `body.attachments` through
  `sanitizeAttachments()` (from `runner.ts`) before handing it to `manager.createTask()` /
  `manager.message()`; each route's title/text is now required *or* an attachment is
  present (image/PDF-only turns are valid — `POST /api/tasks` still always requires a
  title, `POST /api/tasks/:id/message` requires text or an attachment).
  `GET`/`PUT /api/settings` returns/patches the durable per-user `WorkspaceSettings`
  (`{ workspaceUrl, teamHandle }`) persisted in `zmrng.db` (the `settings` kv table) —
  the Team workspace URL + display-name handle moved here from browser `localStorage`,
  which was unreliable across refresh/app-reopen/rebuild in the desktop shell; the
  sidecar DB lives in the persistent per-user data dir. `PUT` is PATCH-style (only the
  keys present are written; a blank value clears one) and echoes the full document. The
  stored `workspaceUrl` wins over the `ZMRNG_WORKSPACE_URL` env default (App merges).
  (This list predates several routes — `/api/agents`, `/api/preflight`, `/api/ui-state`,
  `/api/tasks/:id/{files,file,notes,chat}`, `/api/tasks/:id/archive`, and the
  Projects-dir browsing pair `GET /api/projects/files` (dotfile-skipping, depth-capped
  tree of `config.projectsDir`) + `GET /api/projects/file?path=` (read-only read of an
  arbitrary project file, for no-task file viewing) — that already exist in `index.ts`; a
  fuller pass is owed here, tracked as a doc-sync gap rather than documented speculatively
  in this change.)
- **WS:** `GET /ws` — adds the socket to the hub, sends a `snapshot`. `GET /ws/terminal` —
  the socket ATTACHES to a server-owned session rather than owning the shell outright.
  The first client frame is `attach` (carrying the stored `sessionId` if the client has
  one); the server resolves-or-spawns via `TerminalManager.attach()`, replies with a
  `{type:'session', sessionId}` frame, then replays any buffered output before streaming
  live PTY output as `{type:'data', data}` frames and relaying the exit code as
  `{type:'exit', code}` before closing the socket. Client `input`/`resize` frames are
  parsed with the tolerant `parseClientMsg()` from `terminal.ts` and routed via
  `write`/`resize`. Socket **close calls `terminals.detach(sessionId)`, NOT kill** — the
  PTY survives under a grace timer for a reconnecting client to reattach to. Spawn
  failures and mid-session errors close the socket rather than throwing. `GET /ws/chat` —
  one socket owns at most one live chat
  session; a `start` frame (re)spawns via `ChatManager.create()` (killing any prior
  session on the socket first, so a config change respawns cleanly), an `input` frame
  sends a turn (`session.send(msg.text, msg.attachments)` — the frame's already-sanitized
  `attachments`, if any, ride along), `interrupt` stops the in-flight turn without killing
  the session. Runner
  callbacks map to server→client `ChatServerMsg` frames: `onSession`→`ready`,
  `onPartial`→`partial`, `onAssistantText`→`assistant`, `onToolUse`→`tool` (`actor` is
  the subagent type or `'main'`), `onResult`→`result`, `onExit`→`exit` (then closes the
  socket), `onSpawnError`→`error` (then closes the socket); `onSubagentResult` is
  intentionally **not** forwarded — the thread only shows the agent's own turns, tools,
  and big decisions. Client frames are parsed with `parseChatClientMsg()` from
  `chatAgent.ts`. Socket `close`/`error` kills the session.
- **Static:** serves `web/dist` in production with an SPA not-found fallback.
- **Lifecycle:** SIGINT/SIGTERM → `manager.shutdown()` (kill workers) + `terminals.killAll()`
  (kill PTYs) + `chats.killAll()` (kill standalone chat sessions) → close. Logs
  `repoWarnings` at startup.
- `asEffort` / `asStyle` validate enum inputs from the request body.

### Chat wire types (`types.ts`, mirrored)
- **`ChatClientMsg`** (client→server, over `GET /ws/chat`) — `{type:'start'; model:
  string; effort: EffortLevel; style: CaveStyle}` (spawns a fresh session with the
  chosen controls, killing any prior one on the socket) | `{type:'input'; text: string;
  attachments?: Attachment[]}` (one operator turn, optionally carrying image/PDF
  drop/paste attachments) | `{type:'interrupt'}` (cuts the in-flight turn without killing
  the session).
- **`ChatServerMsg`** (server→client) — `{type:'ready'; sessionId: string}` |
  `{type:'partial'; text: string}` | `{type:'assistant'; text: string}` |
  `{type:'tool'; name: string; summary: string; actor: string; isSubagent: boolean}` |
  `{type:'result'; isError: boolean}` | `{type:'exit'; code: number | null}` |
  `{type:'error'; text: string}` — one variant per meaningful `Runner` callback.

## Web (frontend) — `packages/web/src/`

> The `App.tsx`/`components/` bullets below predate the Workspace/Board merge (see the
> root `CLAUDE.md` project-structure tree for the current `App.tsx`/`WorkspaceView`
> shape — `TaskDetail` no longer exists, replaced by `TaskList`'s expand-in-place
> row controls + `WorkspaceTabs`).
> Left as-is rather than speculatively rewritten in this change; the terminal-dock /
> chat bullets at the end of this section are current as of 2026-08-17.

- **App.tsx** — layout (TaskList rail | TaskDetail pane); fetches config + repos +
  tasks on mount; routes WsEvents into a task map + per-task event list.
  Passes `onInterrupt={() => api.interrupt(selected.id)}` into `TaskDetail`.
- **useWs.ts** — auto-reconnect WebSocket (1s→30s backoff).
- **api.ts** — REST client; only sets JSON content-type when a body is sent (avoids
  `FST_ERR_CTP_EMPTY_JSON_BODY` on bodyless POSTs). Includes `interrupt(id)` (bodyless POST).
  `createTask(...)` and `message(id, text, attachments?)` both take an optional trailing
  `attachments?: Attachment[]`, sent as-is in the JSON body for the server's
  `sanitizeAttachments()` to re-validate. `restartAgent(id)` → bodyless
  `POST /api/tasks/:id/restart`, distinct from the self-update `POST /api/restart`.
- **types.ts** — MANUAL mirror of `packages/server/src/types.ts`. `EventSub` includes
  `'tool' | 'subagent' | 'subagent_result'`; `EventPayload` includes `tool?`, `actor?`,
  `subagentType?`, `summary?`. `Task.stale?: boolean` — true when the task is in a live
  phase but its worker session was lost (the app was restarted); set only at boot
  reconciliation, cleared when a fresh agent is (re)spawned.
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
  - `TerminalDock` (`components/TerminalDock.tsx`) — the Zed-style bottom-dock terminal
    (now hosting both PTY terminal tabs AND standalone chat tabs), doubling as the
    **bottom nav bar**: its always-visible bar holds five content-sized pane toggles —
    **Terminal** (the dock body), **Chat** (opens the dock + appends a new chat tab),
    **Tasks** (the right rail), **Workspace** (the centre tab pane), **Settings** (an
    overlay modal). Each button highlights while its pane is open. Tasks/Workspace
    visibility persists in `GlobalUiState.panes` (both default closed → a fresh load
    shows only the Files tree); Settings is an ephemeral, non-persisted modal
    (`SettingsModal`). Global (not per-task), rendered by `WorkspaceView` regardless of
    task selection.
    `open`/`height` are controlled props sourced from `App.tsx`'s
    `GlobalUiState.terminalDock` (default closed / 300px, clamped `[120, 640]`); the tab
    list itself is local `useState` driven by the pure `terminalDock.ts` reducer
    (`emptyDock`/`addTab`/`addTerminal`/`addChat`/`closeTerminal`/`setActive`) —
    ephemeral, never persisted, so a reload always starts with no shells/sessions.
    Auto-seeds one terminal only on the closed→open transition (derived-during-render
    pattern, not a `useEffect`, per the `react-hooks/set-state-in-effect` rule); a `+💬`
    button in the tab strip (alongside the `+` new-terminal button) appends a chat tab
    without triggering that auto-seed. Per-kind tab labels ("Terminal N" / "Chat N",
    counted independently). Ctrl+` toggles the dock at the window level; a drag handle
    resizes the body via `pointerdown`/`pointermove`/`pointerup`. Tabs are unmounted
    (not just hidden) while the dock is closed, so no PTY/chat session exists until
    opened; each visible tab renders `<ChatPane>` or `<Terminal>` based on `t.kind`.
  - `Terminal` (`components/Terminal.tsx`) — one `@xterm/xterm` instance + one WebSocket to
    `/ws/terminal` per mounted instance (keyed by the dock tab's `id`). `@xterm/addon-fit`
    + a `ResizeObserver` keep the PTY geometry in sync, sending a `resize` frame on open
    and on every observed resize. Terminal colors are read live from the `--font-mono`,
    `--well`, `--text`, `--accent` CSS custom properties (no hard-coded values).
    `attachCustomKeyEventHandler` swallows ctrl+` so the dock-toggle chord never reaches a
    focused shell. Not unit-tested (jsdom has no canvas) — the protocol logic it depends on
    (`terminalProtocol.ts`) is.
  - `ChatPane` (`components/ChatPane.tsx`) — the standalone agent-chat pane: a bubble
    messaging thread (user/agent bubbles + slim tool-use notes) plus a config row (model
    `sonnet`/`opus`, effort, style — defaulting `sonnet`/`medium`/`caveman-full`,
    independent of the task-level `DEFAULT_*` controls) and a composer (Enter to send,
    Shift+Enter for a newline). Owns one `WebSocket` to `/ws/chat` per instance, keyed by
    the dock tab's `id` (mirrors `Terminal.tsx`, not the `useWs` hub); sends a `start`
    frame on open and on every config change (a config change resets the thread and
    respawns the session). Shows a **Stop** button (sends `interrupt`) while a turn is in
    flight, else a **Send** button. Tool rows are left-colored via `actorColor(...)` (a
    sanctioned dynamic inline style, same precedent as `WorkerLog`). All the testable
    messaging logic lives in the pure `chatThread.ts` / `chatProtocol.ts` modules; the
    component itself is not unit-tested (jsdom has no WebSocket glue worth exercising).
    Wired for image/PDF drop/paste (see the `AttachmentTray` bullet below): a local
    `useAttachments()` feeds the tray + sends via `encodeInput(text, attachments)`.
  - `AttachmentTray` (`components/AttachmentTray.tsx`, current as of 2026-08-17) —
    purely presentational thumbnail strip for one composer's pending `Attachment[]`:
    image attachments render an inline `<img>` preview (built from a `data:` URL via
    `dataUrl(a)`), PDFs render a generic "PDF" chip, each item has a remove button, and a
    validation/limit error string (if any) renders on its own line below. Renders `null`
    when there are no attachments and no error. All state lives in the `useAttachments()`
    hook that owns it — shared, in the same shape, by `NewTaskForm`, `ClarifyChat`, and
    `ChatPane`, each of which spreads `onPaste`/`onDrop` from the hook onto its textarea
    and renders `<AttachmentTray attachments={...} onRemove={...} error={...} />`
    beneath it. `NewTaskForm`'s submit and `ClarifyChat`'s `onSend` gain an optional
    trailing `attachments?: Attachment[]` argument (an image-only task/message is valid);
    `WorkerLogPanel`'s `onMessage(text, attachments?)` forwards straight through to
    `api.message(id, text, attachments)`.
- **terminalDock.ts** — pure reducer, `DockState { tabs: DockTab[]; activeId: string |
  null }` where each `DockTab` now carries a `kind: 'terminal' | 'chat'` so terminal and
  chat tabs coexist in one ordered list. `emptyDock()`, `addTab(state, id, kind)`
  (appends + focuses a tab of the given kind), `addTerminal(state, id)` (back-compat
  shorthand for `addTab(state, id, 'terminal')`), `addChat(state, id)` (shorthand for
  `addTab(state, id, 'chat')`), `closeTerminal(state, id)` (focus falls to the left
  neighbor, or `null` once empty — kind-agnostic despite the name), `setActive(state,
  id)` (kind-agnostic). Ids are always caller-supplied (never `Math.random`/`Date.now`
  inside the module) so it stays pure and deterministic to test.
- **terminalProtocol.ts** — `encodeAttach(sessionId, cols, rows)` / `encodeInput(data)` /
  `encodeResize(cols, rows)` produce exactly the frames the server's `parseClientMsg`
  accepts; `parseServerMsg(raw)` tolerantly parses a server→client `TermServerMsg`
  (`session` | `data` | `exit`), returning `undefined` on anything malformed rather than
  throwing.
- **chatProtocol.ts** — `encodeStart(model, effort, style)` / `encodeInput(text,
  attachments?)` (omits the `attachments` field entirely when the array is empty/absent) /
  `encodeInterrupt()` produce exactly the frames the server's `parseChatClientMsg`
  accepts; `parseChatServerMsg(raw)` tolerantly parses a server→client `ChatServerMsg`
  (`ready`/`partial`/`assistant`/`tool`/`result`/`exit`/`error`), returning `undefined` on
  anything malformed rather than throwing (mirrors `terminalProtocol.parseServerMsg`).
- **attachments.ts** — pure helpers turning dropped/pasted browser `File`s into the
  transient `Attachment` shape, unit-testable without a DOM: `mimeToKind(mime)` (PDFs are
  documents, everything else an image), `validateFile(file)` (checks against
  `ALLOWED_MEDIA_TYPES`/`MAX_ATTACHMENT_BYTES`, mirroring the server's limits — returns a
  human-readable error string or `null`), `fileToAttachment(file)` (async `FileReader` →
  base64, strips the `data:...;base64,` prefix), `filesFromPaste(e)` /
  `filesFromDrop(e)` (pull the `File[]` off a clipboard-paste / drag-drop event).
- **useAttachments.ts** — the `useAttachments()` hook shared by the three composers
  (`NewTaskForm`, `ClarifyChat`, `ChatPane`) so the drop/paste glue is DRY: `attachments`,
  `addFiles(files)` (validates + reads, surfacing the first validation error, appending
  survivors up to `MAX_ATTACHMENTS` and reporting when the cap is hit), `remove(index)`,
  `clear()`, `error`, and ready-to-spread `onPaste`/`onDrop` handlers (each calls
  `e.preventDefault()` only when it actually found files, so normal text paste/drop is
  untouched).
- **chatThread.ts** — pure, React-free reducer for the chat bubble thread, `ThreadState {
  items: ThreadItem[]; busy: boolean }` (`ThreadItem` is a `user` bubble, a `agent` bubble
  with a `streaming` flag, or a slim `tool` note). `emptyThread()`, `pushUser(state, text)`
  (appends + marks busy), `appendPartial(state, delta)` (opens or extends the current
  streaming agent bubble), `finalizeAssistant(state, text)` (closes the turn's bubble to
  final text), `pushToolNote(state, note)`, `endTurn(state)` (clears `busy`, closes any
  still-open streaming bubble), `resetThread()` (discards the whole thread — used on a
  config change). Every function takes a state and returns a new one; nothing mutates its
  input.
- **gridLayout.ts** — pure, React-free reducer + DOM-free geometry for the Workspace
  **12-column card grid**. `COLS = 12`; `CARD_IDS`/`defaultCards()` seed the 9-card roster
  (pipeline, concurrency, reviewqueue, newtask, tasklist, files, viewers, chat, terminal —
  the Worker Log has no standalone card, it lives only in the Viewers card's `log` tab, and
  the active-task controls live inline in the selected TaskList row rather than a standalone
  card) as a non-overlapping arrangement. `collide(a, b)` /
  `compact(cards, pinnedId?)` are the overlap + gravity primitives; `applyMove(state, id,
  x, y)` / `applyResize(state, id, w, h)` reflow the grid under one of three interaction
  modes (`reflow` | `swap` | `free`). `hideCard`/`showCard`/`toggleMinimize` toggle a card's
  visibility/minimized flags. `normalizeGrid`/`hydrateGrid(stored?)` do a tolerant merge of a
  persisted `GridState` against the current roster (missing cards seeded, unknown dropped).
  `cellSize(gridW, density)` / `cardRectPx(item, cell)` / `contentHeightPx(cards, cell)` are
  the DOM-free geometry helpers — grid units are 12-col CELL units (screen-width-independent),
  turned into px only at render. Mirrors the pure-reducer style of `workspaceLayout.ts` /
  `terminalDock.ts`; unit-tested in `packages/web/test/gridLayout.test.ts`.
- **dashboardData.ts** — pure derivations feeding the 3 data cards: `pipelineCounts(tasks)`
  (per-phase counts), `concurrency(tasks, maxLanes)` (lane occupancy), `reviewQueue(tasks)`
  (tasks awaiting review). Unit-tested in `packages/web/test/dashboardData.test.ts`.
- **cardMeta.ts** — `CARD_TITLES` + `CARD_ACCENTS` (per-card `var(--*)` accent token)
  `Record<GridCardId, string>` maps, shared by `WorkspaceGrid` and `BottomNav`.

---

## Team workspace — `packages/server/src/workspace.ts` + `/ws/workspace`

The shared multi-human comms layer (the **Team** mode tab), run on a VPS. Data lives in the
same `zmrng.db`; local task execution is untouched. One multiplexed WebSocket per teammate at
`GET /ws/workspace` carries channel-tagged frames — never one socket per channel or resource.

- **parseWorkspaceClientMsg(raw)** — tolerant guard over client→server frames (mirrors
  `terminal.ts`/`chatAgent.ts`): malformed JSON, unknown `type`, or a missing/ill-typed/blank
  field all yield `undefined`, never a throw. Accepts `hello` (trimmed display name, rejected
  if blank or > `MAX_DISPLAY_NAME_LEN`), `ping`, `subscribe`/`unsubscribe` (integer
  `channelId`), and `message` (integer `channelId` + non-blank trimmed `author`/`body` within
  the length caps). **A `message` frame carries no `kind`** — the parser drops any
  client-supplied `kind`, so a human client can never forge an `agent` message. Also
  accepts `react` (integer `channelId`/`messageId` + non-blank trimmed `emoji`/`handle`,
  emoji capped at `MAX_EMOJI_LEN`).
- **PresenceTracker<S>** — connection-based presence, generic over the socket type for
  testability. `join(socket, memberId)` / `leave(socket)` / `onlineIds()` /
  `roster(members)`. A member is online while holding ≥1 live socket (multi-tab safe); the
  member goes offline only when their last socket leaves.
- **WorkspaceManager** — ties the `members` table to a `PresenceTracker` and a broadcast sink
  (`(frame) => hub.broadcastRoom('workspace', …)`). `join(socket, displayName)` upserts the
  member + marks online, `leave(socket)` recomputes, both re-broadcast the full roster
  snapshot (no history replay). `roster()` merges live presence over `Db.listMembers()`.
- **ChannelManager<S>** — owns channel message posting + live fan-out via the ticket's
  `Map<channel_id, Set<socket>>` subscription registry (a dedicated map, NOT `WsHub` rooms — a
  deliberate choice so the acceptance-critical fan-out test is crisp). `subscribe(socket,
  channelId)` / `unsubscribe(socket, channelId)` / `unsubscribeAll(socket)` (disconnect
  cleanup — drops the socket from every channel). `post(channelId, author, body, kind, now?)`
  returns `undefined` if the channel does not exist (nothing persisted); otherwise persists via
  `Db.addMessage` and fans the `{type:'message', message}` frame out ONLY to sockets subscribed
  to that channel. The `/ws/workspace` route always calls `post(..., 'human')` — the `agent`
  kind is reserved for the future T4 server-side agent path. `react(channelId, messageId,
  handle, emoji, now)` validates the message belongs to the channel (via
  `Db.getMessageChannelId`), toggles the reaction through `Db.toggleReaction`, and fans the
  resulting `{type:'reaction', channelId, messageId, reactions}` frame out to that channel's
  subscribers only.
- **Emoji reactions**: additive `reactions(id, message_id, handle, emoji, created_at,
  UNIQUE(message_id, handle, emoji))` table + `idx_reactions_message` index (`CREATE TABLE
  IF NOT EXISTS`, so it never rewrites an existing DB on reopen — same additive-only
  contract as the rest of the SCHEMA). `Db.toggleReaction(messageId, handle, emoji, now)`
  adds or removes one handle's reaction and returns the message's updated aggregated
  `ReactionSummary[]`; `Db.listReactions`/`Db.reactionsForMessages` (batch) back
  `Db.listMessages`, which now attaches each message's aggregated `reactions` so scrollback
  loads with them already applied. Reactor identity is the same self-asserted free-text
  `handle` as message authorship — no login/member-id. Frontend: `workspaceProtocol.ts`
  gained `encodeReact(...)` and a `reaction` server-frame case in
  `parseWorkspaceServerMsg`; `channelThread.ts` gained `applyReaction(state, messageId,
  reactions)` (swaps one message's reaction set, same-reference no-op if the message isn't
  loaded); `emojiSet.ts` exports `REACTION_EMOJI`, a static ~40-emoji curated set (no picker
  library, no full-Unicode list — offline-safe by design). `TeamView` renders reaction-count
  pills under each bubble (human and agent messages alike): click a pill to toggle your own
  reaction, click the count to open a "who reacted" popup, or open the emoji-picker grid via
  a `☺` add-button.
- **DB surface** (`db.ts`): `members(id, display_name, created_at)` + `upsertMember`/
  `listMembers`; `channels(id, name UNIQUE, repo_id nullable, created_at)` +
  `messages(id, channel_id, author, body, kind, created_at)` in the idempotent SCHEMA, with an
  index on `messages(channel_id, id)`; `#general` seeded via `INSERT OR IGNORE`;
  `listChannels`/`getChannel`/`addMessage`/`listMessages(channelId, before?, limit)` (now
  reactions-attached), `getMessageChannelId`, `listReactions`, `reactionsForMessages`,
  `toggleReaction` (see Emoji reactions above).
- **REST**: `GET /api/channels` (list) · `GET /api/channels/:id/messages?before=&limit=`
  (paginated scrollback, `limit` clamped to `MAX_MESSAGE_PAGE`, always 200 — a bad id yields an
  empty page). `GET /api/config` carries `workspaceUrl` (optional server default for the tab).
- **WsHub rooms**: `join(room, socket)` / `leaveAll(socket)` / `broadcastRoom(room, data)` over
  a `Map<string, Set<socket>>`, alongside the flat `/ws` broadcast set. The workspace socket
  joins the `'workspace'` room for roster re-broadcasts.
- **Frontend pure modules**: `workspaceProtocol.ts` (`encodeHello`/`encodePing`/
  `encodeSubscribe`/`encodeUnsubscribe`/`encodeMessage`/`encodeReact` + tolerant
  `parseWorkspaceServerMsg` for `roster`/`pong`/`message`/`channels`/`reaction`), `roster.ts`
  (React-free full-snapshot presence reducer), `channelThread.ts` (`emptyThread`/
  `appendMessage`/`loadScrollback`/`applyReaction` — dedupes by id so REST scrollback and live
  frames merge cleanly), `teamConfig.ts` (localStorage handle/URL + socket-URL resolution),
  `emojiSet.ts` (`REACTION_EMOJI` curated static set for the reaction picker). `TeamView`
  component owns the socket (glue, like `Terminal.tsx`); Settings holds the VPS workspace-URL
  field.
- **Repo-scoped channels + handoff (T3)**: `POST /api/channels` creates a channel via
  `Db.createChannel(name, repoId|null, now)` then broadcasts `{type:'channels', channels}` to
  the `workspace` room (blank → 400, duplicate name → existing row, never a 500). A channel's
  nullable `repo_id` ties it to a target repo; repo-tied channels render distinguishably (rail
  accent dot + header badge). Web-only pure module `teamHandoff.ts`:
  `buildHandoffPrefill(channel, message)` (title from the first message line + body with a
  `From team channel #<name> (message #<id>)` provenance line), `resolveSuggestedRepoId(id,
  repos)` — keeps a channel's suggested repoId ONLY if it exists in the teammate's LOCAL
  registry, so no VPS-supplied repoId is auto-bound (D6). "Send to my zmrng" lifts a
  `HandoffPrefill` to `App`, switches to Workspace, and seeds `NewTaskForm` (one-shot `prefill`
  prop + `onPrefillConsumed` so the prefill is dropped after seeding); the task is created via
  the existing LOCAL `POST /api/tasks` → backlog, no auto-start.
- **@mention team agent (T4)** — `agentResponder.ts`: the ONE shared team agent, constructed
  once alongside `ChannelManager`. Pure seams `detectMention(body, botHandle)` (word-boundary
  anchored — `@agent` matches, `@agentsmith`/`foo@agent.com` do not), `botAuthorFromHandle`,
  `buildAgentMessages` (last-N scrollback → agent chat turns), `parseAgentReply` (tolerant
  `reply`/`content`/`text`/`message`), `resolveBotAgent` (`''` → first configured agent). The
  injectable `AgentResponder.handleMention(channelId)` best-effort `git pull --ff-only`s a
  read-only reference checkout (skipped when unset, never throws), gathers the last N messages,
  relays them to the bot `AgentTarget` via the U4 `fetch(agent.url)` adapter bounded by an
  `AbortController` timeout (default 60s), and posts the reply back as a server-controlled
  `kind='agent'` message — never a worktree, never code execution (D1/D8). Fired async
  fire-and-forget from the `/ws/workspace` message handler AFTER the human message persists as
  `kind='human'`; every failure path is logged with no agent post. Config keys (server-only):
  `workspaceRepoPath`/`workspaceBotAgentId`/`workspaceBotHandle` (`@agent`)/`workspaceScrollback`
  (20)/`workspaceAgentTimeoutMs` (60000). No agents configured → responder disabled, mentions a
  graceful no-op. Live checkout path + bot agent id are orchestrator/operator-owned deployment
  config.
- **`@`-mention autocomplete + highlight (frontend-only)**: `GET /api/config` gained
  `botHandle: string` (`config.workspaceBotHandle`, mirrored in `ServerConfig` on both sides —
  no server `ServerConfig` type exists, the route returns an inline literal). New web-only pure
  module `mentions.ts`: `mentionCandidates(members, botHandle)` (roster + bot),
  `activeMention(text, caret)` (word-boundary-anchored, mirrors `agentResponder.ts`'s
  `detectMention`), `filterCandidates(candidates, query)`, `applyMention(text, start, caretEnd,
  name)` (splice the picked name into composer text, returns the new caret position),
  `parseMentions(body, names)` (splits a posted body into plain-text/mention segments for pill
  rendering); types `MentionCandidate`/`MentionSegment`. `TeamView`'s composer opens a
  keyboard-navigable dropdown (arrow keys, Enter/Tab to pick, Esc to dismiss, click) on an active
  `@query`; thread message bodies render `@name` tokens as colored pills. Purely visual for
  person mentions — no server behavior change; the actual `@agent` reply trigger
  (`detectMention` in `agentResponder.ts`) is untouched.
- **POC security precondition** (doc-only, no app code): the VPS workspace port is
  **Tailscale-only** — the tailnet is the perimeter and the access control. Self-asserted
  handle, no verification. Public exposure is gated on GitHub OAuth + org/repo allowlist +
  per-message author verification (D2/D10, deferred).
