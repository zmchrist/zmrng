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
- **Execute lanes:** cap = `config.maxLanes` (`ZMRNG_MAX_LANES`, default 4). A task takes
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
  work never idles one of the lanes. (3) preflight the binaries; missing/unprovisionable
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

### Lane-viewer feed (`workerMeta`, `laneSnapshot()`)
`TaskManager` also feeds the Lanes panel (see the `LaneEmitter` section below):
- **`workerMeta: Map<taskId, WorkerMeta>`** (private) — one entry per LIVE runner, keyed off
  `this.runners`; written fresh in `spawn()` (`{model, effort, style, startedAt, subagents:
  []}` — the values the child was ACTUALLY spawned with, not the task row's own fields,
  which stay null until a phase resolves them) and `delete`d everywhere a runner is removed
  (`fail`, `replaceChild`, `onPr`, `onExit`, `cancel`, `done`, `deleteTask`, `shutdown`) —
  a `WorkerMeta` never outlives its runner. A phase handoff (`replaceChild` → a fresh
  `spawn`) therefore starts the new child with an empty subagent list.
- **`startSubagent`/`finishSubagent`** (private) — append a `running` `LaneSubagent` row
  from `onToolUse(..., isSubagent, subagentType)`, close it from `onSubagentResult`. Events
  carry no subagent id, so `finishSubagent` matches the OLDEST still-`running` row of the
  same `type` (FIFO) — two concurrent subagents of the same type have their first result
  close the older row; that is the event stream's honest limit, not a bug. Both call
  `trimSubagents` (bounded at `MAX_SUBAGENT_ROWS = 50`, dropping COMPLETED rows oldest-first;
  a list of nothing but running rows is left over-bound rather than hiding live work).
- **`laneSnapshot(): { execute: LaneOccupancy; workers: LaneWorker[] }`** — the task half of
  the lane snapshot. `execute` is `{cap: config.maxLanes, holders: [...executeLanes], queued:
  [...executeQueue]}`; `workers` is one `LaneWorker` per live runner (dead runners can never
  render a stale row — including a boot-time orphan, since a fresh `TaskManager` has an empty
  `runners` map), each `holdsLane` mirroring `executeLanes.has(taskId)` and `subagents` a
  defensive copy so a later append can't mutate an already-emitted frame.
- **`onLanesChange: () => void`** — optional trailing 5th constructor param (default no-op);
  fired from `patch()`, every lane acquire/release (`takeLane`/`queueLane`/`freeLane`,
  replacing direct `executeLanes.add`/`executeQueue.push`), `spawn()`, subagent start/finish,
  and every runner-removal site above. `index.ts` wires it to `() => emitter.notify()`.

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
  `TermSession` wraps the `PtySession` + `shell`/`cwd`/`startedAt` recorded at spawn time +
  a bounded byte-capped ring buffer of recent output + a pending grace-timer handle). Three
  extra injectable seams alongside `PtyFactory`: a `TimerFns` (`setTimeout`/`clearTimeout`,
  default the real globals), an id factory (default `randomUUID`), and an optional trailing
  `onChange: () => void` (default no-op) — both timer/id seams swappable so tests can
  fast-forward grace expiry without real timers; `onChange` fires on spawn, attach-to-
  existing (an `attached` flip), detach, grace reap, exit, and `killAll()`, wired by
  `index.ts` to `() => emitter.notify()`.
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
  - **`snapshot(): LaneTerminal[]`** — one read-only row per LIVE session, for the lane
    viewer: `{id, shell, cwd, startedAt, attached}`, `attached` DERIVED from `cb !== null`
    so a shell kept alive inside its detach grace window reports `attached: false` rather
    than looking like an open terminal.

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
- **`ChatManager`** — tracks live sessions in a `Map<RunnerLike, ChatSessionMeta>` (the
  runner handle is the identity the route holds; `ChatSessionMeta` carries the controls the
  session was spawned with, its resolved `repoId`/`null`, `voice`, `startedAt`, and a running
  `TaskUsage` accumulator). Constructed with the same `RunnerFactory` seam `TaskManager`
  uses (`defaultRunnerFactory` by default) so tests never spawn a real `claude`, plus two
  optional trailing seams: an `idFactory` (default `randomUUID`, mirrors `TerminalManager`'s)
  assigning each session's `LaneChat.id`, and an `onChange: () => void` (default no-op)
  firing on create/exit/`killAll()` and on every `onResult` usage fold-in — wired by
  `index.ts` to `() => emitter.notify()`.
  - **`create(cfg: ChatConfig, cb: RunnerCallbacks): RunnerLike`** — spawns one
    conversational `claude` rooted at `config.projectsDir` with `chatSystemPrompt(cfg.style,
    config.projectsDir)` as its system prompt, wraps `onResult` to fold the turn's `usage`
    delta into the session's accumulator BEFORE calling through (so a caller reacting to
    `onResult` already sees the updated snapshot) and `onExit` to self-remove the session
    from the tracked map *before* notifying the caller (so a later `killAll()` never
    double-kills an already-exited session), and tracks the result. The OAuth env-strip
    already lives inside `Runner`'s constructor, so (unlike `TerminalManager`) this
    manager does not repeat it.
  - **`killAll(): void`** — best-effort `kill()` (try/catch) on every tracked session, then
    clears the map. Called from `index.ts`'s `shutdown()` alongside `manager.shutdown()`
    and `terminals.killAll()`.
  - **`laneId(session): string | undefined`** — the id a live session is listed under in
    `snapshot()`, or `undefined` once it has exited; the `/ws/chat` route sends it as the
    `lane` frame.
  - **`snapshot(): LaneChat[]`** — one read-only row per LIVE session, for the lane viewer
    (`{id, model, effort, style, repoId, voice, startedAt, usage}`); `usage` is copied so a
    later fold-in can't mutate an already-emitted frame.

## Lanes — `packages/server/src/lanes.ts`

Assembles the read-only, in-memory "everything zmrng is running right now" snapshot behind
the Lanes panel (`GET /api/lanes` + the `lanes` WS frame). zmrng has exactly **one** capped
lane pool (`config.maxLanes`, held planning → executing → validating plus security fix
rounds); `clarify` holds no lane and is uncapped — the snapshot reports that truth (an
uncapped clarify group) rather than inventing a second pool. Nothing here is persisted; the
whole snapshot is rebuilt from the three live-session managers on every push.

> **Loop lanes are NOT in this snapshot.** The gauntlet Loop's lane pool
> (`LOOP_MAX_LANES = 3`, owned by `LoopManager`) is deliberately separate from
> `config.maxLanes`: it never counts against the execute-lane cap and is never read by
> `buildLaneSnapshot` — Loop lanes are shown in the Loop tab (see **LoopManager** below).

- **`LaneSources`** — the three managers reduced to the read-only accessors
  `buildLaneSnapshot` actually needs: `tasks(): { execute: LaneOccupancy; workers:
  LaneWorker[] }` (→ `TaskManager.laneSnapshot()`), `chats(): LaneChat[]` (→
  `ChatManager.snapshot()`), `terminals(): LaneTerminal[]` (→ `TerminalManager.snapshot()`).
  Injecting the accessors rather than the managers is what keeps `buildLaneSnapshot` pure
  and hermetic — it only ever type-imports `terminal.ts` (for `TimerFns`), never imports
  `node-pty` at runtime, so the lanes module stays unit-testable without it.
- **`buildLaneSnapshot(sources: LaneSources, at: string): LaneSnapshot`** — pure. Reads each
  source exactly once and returns `{at, execute, workers, chats, terminals}` — the exact
  payload both `GET /api/lanes` and the `lanes` WS frame carry.
- **`LaneEmitter`** — coalescing broadcaster. A single subagent tool event can fire several
  `onChange`/`onLanesChange` notifications in a row, and a busy instance fires them from all
  three managers at once, so rebuilding + re-serializing per event would be wasteful.
  - **`notify(): void`** — requests a push; absorbed into an already-pending one (trailing,
    not leading — a burst inside the coalescing window collapses to one send at the end of
    it). The pending timer is cleared *before* the send so a `notify()` raised from inside
    the send path re-arms the window instead of being swallowed.
  - **`snapshot(): LaneSnapshot`** — builds immediately, without scheduling or sending;
    used by both `GET /api/lanes` and the `/ws` connect frame (mirrors `snapshot: tasks`
    seeding the board over `/ws`).
  - Constructor: `(sources, send: (snapshot) => void, timers: TimerFns = realTimers, delayMs
    = 150, clock: () => string = () => new Date().toISOString())` — `timers`/`delayMs`/
    `clock` are injectable so tests drive the coalescing window synchronously and pin the
    `at` instant, mirroring `TerminalManager`'s `TimerFns` seam.
- **Wiring (`index.ts`)** — `terminals`/`chats`/`manager` are each constructed with a
  trailing `onChange`/`onLanesChange` arrow deferring to `emitter.notify()`, and `emitter`
  itself is constructed afterward (reading the three managers via closures, so the
  construction-order cycle resolves through the arrow indirection, not a forward reference).

## LoopManager — `packages/server/src/{loop,loopMap,loopPrompts,loopGithub,loopLoad,loopRoutes}.ts`

The **Loop** mode's engine (ADR-0003: `docs/adr/0003-gauntlet-loop.md`; plan
`.agents/plans/gauntlet-loop-tab.md`). It runs a map of GitHub-issue tickets (an epic's
sub-issues) to completion with the *gauntlet loop*: per ticket a fresh BUILDER builds, a
separate fresh READ-ONLY CRITIC does a blind binary A/B against the ticket's **bar** and
names the single biggest gap, a loss feeds that gap into the next builder round, and a win
goes on to validate → sync docs → a serial fold into a per-run integration branch. When
every ticket is done there is **one** final PR integ → default branch, never auto-merged.
It is a **separate manager, not Task rows** (D1): `phases.ts` is only *imported from*
(`styleDirective`, `PR_BODY_TEMPLATE`, `PR_BODY_FILE`, `PR_RE`) — `TaskManager`, its lane
accounting and `taskManager.test.ts` are untouched. Every child is spawned through the same
injected `RunnerFactory` seam as `TaskManager`/`ChatManager`, so the `ANTHROPIC_API_KEY`
strip holds by construction and the engine tests stay hermetic.

> **Credit.** The technique is the *gauntlet loop* from **robonuggets/gauntlet-loop**
> (licensed **CC-BY-4.0**), itself after Matt Shumer's "Claude of Duty". zmrng reimplements
> it server-side; no code or skill from the source is invoked or vendored. Keep this credit
> wherever the technique is documented.

### Pure modules (no IO — every rule pinned by a unit test)

- **`loopMap.ts`** — `parseBar(body)` (a `## Bar` section at any heading level wins, else
  a `Bar:` line, plain/bold/bulleted; fenced code and HTML comments never count; null when
  absent/empty), `parseBlockedByFallback(body)` (`Blocked by #N` / `Depends on #N` lines
  only — `#N` in prose, code spans and fences is ignored), `parseEpicChildrenFallback(body)`
  (`- [ ] #N` / `- [x] #N` task-list lines), `stripFencedCode(text)`,
  `deriveStates(tickets, external?)` (recomputes `todo` vs `blocked`; an in-map blocker is
  satisfied iff `done`/`skipped`, an out-of-map one iff `external` says `closed`),
  `findCycle(tickets)`, `frontier(...)`, `pickNext(tickets, priority, freeSlots, external?)`
  (frontier tickets **with a bar**, `priority` first then ascending issue number, at most
  `freeSlots`), `barless(...)`, `percentComplete(tickets)` (done ÷ non-skipped, rounded),
  `verdictOutcome(letter, oursLabel)` (WIN only when the letter is OUR server-randomized
  label — markdown emphasis/quotes/trailing period tolerated; a tie, garbage or no answer
  is a LOSE), `nextAfterLoss(ticket, gap)` (round fuse: `MAX_ROUNDS = LOOP_MAX_ROUNDS = 6`,
  losing round 6 lands on round 7 → `parked`), `randomLabel(rand?)`.
- **`loopPrompts.ts`** — the harness contract, pinned by `loopPrompts.test.ts` the way
  `prompts.test.ts` pins `phases.ts`. **Control tokens** are line-anchored (like
  `READY_RE`), so a token quoted mid-sentence never matches: `GAUNTLET_STATUS_RE`
  (`GAUNTLET_STATUS=BUILT|GREEN|RED [reason]`; `GREENISH`/lower case never match),
  `GAUNTLET_VERDICT_RE` (`GAUNTLET_VERDICT: <A|B>`), `GAUNTLET_GAP_RE`,
  `GAUNTLET_QUESTION_RE`. `parseStepResult(text)` strips fenced code FIRST (a token or PR
  URL inside a fence never counts) and takes the LAST occurrence of each token.
  **`STEP_PROFILES`**: builder/critic/fold/orchestrator = opus·high; validate/finish/final
  = sonnet·medium. Prompt builders (each returns `{system, kickoff}`): `builderPrompt`
  (round > 1 carries the critic's last gap verbatim; "build, do not judge"), `criticPrompt`
  (harsh, READ-ONLY, blind A/B with provenance stripped, a single LETTER never a score,
  one biggest gap; both candidates described neutrally in A-then-B order),
  `validatePrompt`, `finishPrompt` (docs sync), `foldPrompt`, `finalPrKickoff` (`--body-file`
  from `PR_BODY_TEMPLATE` + one `Closes #n` per done ticket, never `--fill`, never merge),
  plus `loopOrchestratorPrompt` / `orchestratorKickoff(ctx, recap?)` /
  `orchestratorRecap(input)`. Every step system prompt carries the branch-only +
  worktree-hygiene rules (a step worker is told it never pushes — the server does; the
  final-PR agent's only remote write is the integ push), the `GAUNTLET_QUESTION`
  protocol, and `styleDirective(style)`.
- **`loopGithub.ts`** — the GitHub seam. `LoopGitHub { fetchMap(slug, epic): LoopMapFetch;
  fetchIssue(slug, n): GhTicket }`; `ghLoopGitHub(ghExec = defaultGhExec)` shells out to
  `gh api` via `promisify(execFile)` (no shell; 60s timeout, 16MB buffer, ≤4 calls in
  flight) and validates the slug and issue number before any call. **A map is the epic's
  native sub-issues** (`repos/<slug>/issues/<epic>/sub_issues`), **falling back** — on an
  error OR an empty list — to the `- [ ] #N` task list in the epic body (a listed child that
  cannot be fetched fails the whole map rather than silently vanishing). **Dependencies are
  GitHub's native `dependencies/blocked_by` links**, **falling back** on an error to
  `Blocked by #N` lines in the ticket body. Blockers outside the map get their state
  fetched (`external`: closed ⇒ satisfied; unknown/errored ⇒ `open`, never silently done).
  `mapIssueJson` reads any state other than `closed` as `open`. `LoopManager` tests inject a
  fake, so `gh` never runs under test.
- **`loopLoad.ts`** — the machine-load probe (D7). `parseMeminfo(text)` (Linux
  `MemAvailable`, kB → whole MB, null when absent), `parseVmStat(text)` (macOS: header page
  size × (free + inactive + speculative + purgeable) pages; null on a malformed header or
  no `Pages free` line), `assessLoad(raw, thresholds, now?)` → `LoopLoad`, and
  `defaultLoadProbe(thresholds, platform?, readers?)` (`LoadProbe.sample()` never rejects;
  every reader — file, `execFile`, `cpus`/`loadavg`/`totalmem`/`freemem` — is injectable, so
  the platform branches run under test without `/proc` or `vm_stat`). **Memory is
  *available* memory, not `os.freemem()`**: on macOS `freemem()` counts only truly free
  pages and excludes the inactive/purgeable cache, so it reads a few hundred MB on a healthy
  Mac and a gate on it would block every pick; any parse/read failure (or another platform)
  falls back to `freemem()`. `loadPerCore = loadAvg1 / cores`, 2 dp; the gate trips when
  `loadPerCore` is strictly **over** `maxLoadPerCore` or `memAvailableMb` strictly **under**
  `minFreeMemMb`; `reason` names each tripped threshold with its numbers (joined `; `). A
  `[0,0,0]` load average (Windows) never trips the CPU half — memory still gates.

### `LoopManager` (`loop.ts`)

- **Constructor:** `new LoopManager(db, broadcast, deps: LoopDeps)`. Required deps:
  `runnerFactory`, `github: LoopGitHub`, `load: LoadProbe`, `scanFactory:
  ScanRunnerFactory` (the same seam the task scan gate uses), `apiBase` (the server's own
  loopback origin, `http://127.0.0.1:<config.port>` — never hard-coded; it is what the
  orchestrator `curl`s). Optional: `pumpIntervalMs` (default `config.loopPumpIntervalMs`; 0
  disables the timer), `coalesceMs` (default 150; 0 broadcasts synchronously), `clock`,
  `random` (feeds `randomLabel`), `repoLookup`, `slugOf`, `seed`, `securityPolicy`, `style`,
  and **`log: LoopLog`** (a `{error(obj, msg)}` slice of Pino — `index.ts` passes
  `app.log`; every failed fire-and-forget job is logged there AND, when it belongs to a run,
  recorded as that run's `error` event, so a rejection is never unhandled).
- **Public API** (mirrors the routes): `load()`, `listRuns()`, `view(runId)`,
  `events(runId, limit?)`, `createRun({repoId, epic, lanes?})`, `start`, `pause`,
  `setLanes`, `setPriority`, `refresh`, `addTicket`, `skipTicket`, `stopTicket`,
  `retryTicket`, `answer`, `chat`, `resume`, `archive`, plus `reconcileOrphans()`,
  `pump()`, `shutdown()`, `hardKillAll()`, and **`whenIdle()`** (the test seam — resolves
  once every tracked async job has settled, so tests never sleep). Failures are a typed
  **`LoopError(status 400|404|409|502, msg)`** that the routes map straight onto HTTP
  (400 bad input / unknown repo / no GitHub origin, 404 unknown run or ticket, 409 an
  action the current state forbids — including any action on an `archived` run — and 502 a
  failed GitHub fetch).
- **Run lifecycle** (`LoopRunStatus`): `draft ─start─▶ running ⇄ paused`; every ticket done
  → `finalizing` → final PR URL → `complete`; a red/erroring final scan or a failed final-PR
  agent → `blocked` (`start` on a blocked run re-scans, and adding a ticket reopens it to
  `running`); a boot with a live run → `stale` ─`resume`▶ its previous status; any state
  ─`archive`▶ `archived`. `start` accepts `draft`/`paused`/`blocked` only (a `stale` run
  must `resume`); `pause` only from `running` and lets in-flight steps finish while
  picking nothing new. Ticket states (`LoopTicketState`): `todo`,
  `blocked` (DERIVED — an open ticket with an unfinished blocker), `executing`,
  `reviewing`, `validating`, `finishing`, `folding` (1:1 with the five steps), `waiting`,
  `done`, `needs-human`, `skipped`. A ticket whose GitHub issue is already **closed** is
  `done` from the start.
- **Lane pool (D3).** A global in-memory `Set<'<runId>:<issue>'>` capped at
  **`LOOP_MAX_LANES = 3` across ALL Loop runs** — NOT per run, and entirely **separate
  from `config.maxLanes`**. Loop lanes never count against the task execute-lane cap and
  **never appear in the task Lanes tab** (`lanes.ts`'s snapshot does not read this pool;
  they are shown in the Loop tab). The operator accepted that Loop lanes plus task lanes can
  mean 8+ `claude` processes; the load gate below is the practical bound. `run.lanes`
  (0–3) is a run's TARGET within the pool: free slots =
  `min(run.lanes - heldByRun, LOOP_MAX_LANES - pool.size)`, and `pump()` walks `running`
  runs oldest first. A new run starts at `lanes = 1`; the orchestrator's first turn picks
  the real count. A lane is held from pick until `done`, `needs-human`, a stop/skip, or an
  archive — a ticket waiting on the fold mutex **keeps its lane**, and `view()` renders
  every held slot as a lane card even with no live child ("queued — waiting for the serial
  fold" / "starting…"). Every path that ends a lane goes through the single
  `releaseLane()`. Each acquire mints a fresh **lane token**; an async continuation (a
  pick's git work, a step's setup) captures it and aborts if the lane was released or
  re-acquired meanwhile.
- **Load gate (D7) + pump.** `pump()` (serialized — a request during a pump sets a flag and
  the running pump loops once more) first parks every frontier ticket with **no bar**
  `needs-human` ("ticket has no bar" — there is no fallback to acceptance criteria), then —
  only if a pick is actually possible — samples the probe ONCE. A closed gate
  (`allowsNewLane: false`, or a probe that throws: **fail-closed**, logged via `deps.log`)
  defers every new pick: the run's `note` becomes `picks deferred: <reason>` and the
  orchestrator is told **once per deferral episode** (a `loadDeferred` flag cleared when a
  pick next succeeds), never on every re-check. The gate only **defers new picks** — it never
  kills an in-flight step and never rewrites `run.lanes`. A pump timer
  (`config.loopPumpIntervalMs`) re-runs `pump()` so a deferred pick resumes once load drops;
  it is `unref()`-ed and cleared by `shutdown()`. The latest sample rides every `LoopRunView`
  as `load`, with the pool as `pool: {used, max}`; a new sample re-broadcasts running
  runs' views only when `allowsNewLane` flips or a displayed number changes at its
  formatted precision, so the timer does not spam the socket. A running run with no lane,
  nothing pickable and a `needs-human` backlog is reported to the orchestrator once
  ("run idle: N ticket(s) need a human").
- **Git topology** (inside the target repo, per `.claude/rules/worktree-location.md`; `run8`
  = the first 8 chars of the run id). Integration branch **`gauntlet/<run8>/integ`**, cut
  from the default branch's resolved base at run creation, in worktree
  `<repo>/worktrees/loop-<run8>-integ`. Ticket branch **`gauntlet/<run8>/t<n>`**, cut from
  the integ TIP **at pick time** (so it carries every earlier fold), in worktree
  `<repo>/worktrees/loop-<run8>-t<n>`. Both are created with `createWorktree`'s
  `{branch, base, dir}` override and seeded with `seedHarness`. After a ticket's fold its
  worktree is removed and the branch is kept; archiving removes every worktree of the run.
  Branches are never force-deleted. The target repo should gitignore `worktrees/`.
- **Per-ticket step flow.** Every step is a **fresh** runner (`stepRunners` keyed
  `<runId>:<n>`, with a spawn `gen` that makes a stale callback inert), killed once its
  result is accepted:
  `todo ─pick─▶ builder ─BUILT─▶ critic ─WIN─▶ validate ─GREEN─▶ finish ─GREEN─▶ fold ─verified─▶ done`.
  A critic **LOSE** feeds the gap into the next builder round (`round + 1`); a validate or
  finish **RED** is also a loss (the reason becomes the gap); losing past `MAX_ROUNDS`
  (6) parks the ticket `needs-human`. A fold **RED** parks it `needs-human` directly.
  Tokens each step must end with: builder `GAUNTLET_STATUS=BUILT`; critic
  `GAUNTLET_VERDICT: A|B` then `GAUNTLET_GAP: …`; validate/finish/fold
  `GAUNTLET_STATUS=GREEN` or `RED <reason>`. **Blind A/B (D5):** the server randomizes
  which label (`A`/`B`) is the ticket's work (`oursLabel`), the critic answers with a
  letter, and `verdictOutcome` maps it to WIN/LOSE — a tie or unparseable answer is a LOSE
  because the work must *beat* the bar. The critic cannot be literally blind (it fetches the
  bar itself); "blind" is enforced by neutral prompts + label randomization. **Questions:**
  any step may print `GAUNTLET_QUESTION: …` → the ticket goes `waiting` (lane held, runner
  kept alive), the question is queued to the orchestrator, and `answer()` sends the text
  into that same live runner so the step continues. **Nudge:** a turn that ends with no
  valid token (or an error result) gets exactly ONE nudge; a second miss, an unexpected
  exit or a spawn error parks the ticket `needs-human` (a child that exits mid-assertion is
  deferred to the same decision).
- **Machine assertions** (deterministic, after the agent's claim — the scan gate's
  pattern): **builder** — tree clean AND HEAD advanced (else a nudge to commit);
  **critic** — HEAD unchanged AND tree clean (a violation → `needs-human` at once, and no
  fold is ever enqueued); **fold** — `git merge-base --is-ancestor <ticket branch> HEAD` in
  the integ worktree AND integ tree clean (else a nudge). Only then does the **server**
  `git push origin <integ>` (a non-default branch, never forced). A failed push is recorded
  (run note + `error` event + orchestrator notice) but the ticket still completes — the
  merge itself is verified.
- **Fold mutex.** Folding is serial per run: `foldInFlight: Map<runId, n>` plus a FIFO
  `foldQueue`. `enqueueFold` claims the mutex **synchronously** (no await between check and
  set) or queues the ticket (state `folding`, lane kept); `onFoldSettled` ignores a
  stale/duplicate settle; stopping a queued ticket only dequeues it; a `needs-human`/stop of
  the folding ticket first best-effort `git merge --abort`s integ, then settles. A completed
  fold: push, ticket `done` with `foldSha`, ticket worktree removed, lane released, mutex
  settled (starting the next queued fold), then `maybeFinalize`.
- **Final scan + PR (D4, D6).** `maybeFinalize(runId)` runs automatically the moment at
  least one ticket is done and every non-skipped ticket is (neither operator nor
  orchestrator triggers it): the run goes `finalizing`, then the existing deterministic
  scan runs on the integ worktree (`scanFactory`, policy =
  `mergeSecurityPolicy(config.security, repo.security)`, `baseRef` = the default branch,
  `sast: true`; `policy.enabled === false` skips the scan). A `ScannerUnavailableError`, any
  other scanner error, or unparseable output (`wellFormedScanOutput`) is **fail-closed** →
  `blocked`; a red verdict (`evaluateThreshold`) → `blocked` with
  `formatFindingsForAgent(blocking)` relayed to the orchestrator; green → the **final-PR
  agent** (sonnet·medium, in the integ worktree) pushes integ (`git push -u origin <integ>`,
  never forced), writes `PR_BODY_FILE` from `PR_BODY_TEMPLATE` + one `Closes #n` per done
  ticket, and opens ONE PR with `gh pr create --base <default> --head <integ> --body-file`
  (never `--fill`, never `gh pr merge`). Only a PR URL **of the run's own repo** counts
  (`prUrlFor`: fences stripped, last URL wins) → `complete` with `prUrl`; no URL after one
  nudge, an exit or a spawn error → `blocked`. **There are deliberately NO automatic
  security-fix rounds** (unlike the task pipeline's RED → FIX loop): on red the operator
  adds a fix ticket (which reopens the map) or fixes it by hand. A `finalizing` run whose
  map gains open work again (`reopenIfIncomplete`) returns to `running`, kills the PR agent
  and ignores a late scan result.
- **Orchestrator.** One persistent `claude` session per run (opus·high, cwd = the integ
  worktree), the operator's chat partner and the run's driver. `loopOrchestratorPrompt`
  states its role (guide the run; NEVER edit code, commit, merge or push — the lanes do the
  code work and the server does every push), the run facts, a **curl cheat sheet** for
  every route below, a `gh` cheat sheet for editing issues / sub-issue links / blocked-by
  links (followed by `…/refresh`), the lane + machine-load rules, and the `[loop event]`
  protocol. It is spawned at run creation (kickoff: read the map and `GET /load`, set the
  lane count, explain it, and do NOT start the run), and **lazily** by
  `ensureOrchestrator(runId, withRecap)` — on an operator `chat`, on `resume`, or on a loop
  event for a run whose orchestrator is not alive — always as a FRESH session with
  `buildRecap` (run facts + a per-ticket state table + the **last 20 chat lines**, DB state
  only). It is killed when its run reaches `complete` or is archived, so idle runs hold no
  process. **Outbox / coalescing:** loop events (`pendingNotes`) and operator texts
  (`pendingOps`) are never sent into a busy orchestrator; `flushOutbox` runs only when it is
  idle (a spawn starts busy on its kickoff turn) and sends **ONE** message — operator texts
  first, then a single `[loop event]` block with one `- line` per note. Events relayed:
  ticket WIN / LOSE (with the gap) / done / `needs-human`, a lane question, a deferred pick
  (once per episode), a run going idle, the map completing, a blocked run, an integ-push
  failure. Its transcript persists in `loop_events` (kind `chat`, roles
  `operator|orchestrator|tool|loop`); its token deltas stream only as `loop-partial` frames.
- **Restart (`reconcileOrphans` / `resume`).** Boot marks every `running`/`paused`/
  `finalizing` run `stale` (remembering `prevStatus`) — nothing is alive after a restart.
  `resume` (stale only) restores the previous status (a `finalizing` run restarts as
  `running` and re-runs the final scan), **synchronously re-acquires a pool slot for each
  in-flight ticket without consulting the load gate** (they were already admitted; a full
  pool sends the ticket back to `todo` rather than exceeding the cap), respawns the
  orchestrator with the recap, re-runs each in-flight step FRESH in its existing (or
  recreated) worktree, and re-enqueues tickets persisted in `folding` serially in
  ticket-number order after a best-effort `merge --abort`.
- **Archive.** Kills every step / final-PR / orchestrator child, releases every lane,
  clears the fold maps, outbox and timers, sets `archived` (in-flight tickets read `todo`),
  removes the ticket and integ worktrees (branches kept) and broadcasts `loop-removed`.
  `shutdown()` kills every child and clears timers; `hardKillAll()` is the synchronous
  group-SIGKILL backstop `index.ts` runs on `process.on('exit')` beside the task manager's.

### Routes — `loopRoutes.ts` (`/api/loop/*`, UNGATED like the Workspace surface)

`registerLoopRoutes(app, { loop })` is a **plain function**, not a `fastify-plugin` plugin
(same reason as `registerKbRoutes`: attachable to a bare `Fastify()` and driven with
`app.inject()`); it takes the narrow `LoopRoutesManager` interface so tests hand it a stub.
It is not in `isProtectedPath` — its main caller is a run's own orchestrator `curl`ing it
over loopback. **Every body is validated here** (the orchestrator is an LLM and may send
anything): a bad body is a 400 that never reaches the manager.

| Method / path | Body | Effect |
|---|---|---|
| `GET /api/loop/load` | — | a fresh `LoopLoad` sample plus `pool: {used, max}` (`LoopLoadResponse`) |
| `GET /api/loop/runs` | — | `LoopRun[]`, non-archived first |
| `GET /api/loop/runs/:id` | — | `LoopRunView` (run + tickets + live lanes + pool + load) |
| `GET /api/loop/runs/:id/events?limit=` | — | the most recent `limit` (1..1000) `LoopEvent[]`, oldest → newest |
| `POST /api/loop/runs` | `{ repoId, epic, lanes? }` | 201 — fetch the map, cut integ, spawn the orchestrator, status `draft` (`epic` a positive int, `lanes` an int 0..3) |
| `POST …/:id/start` · `pause` · `resume` · `refresh` | — | `LoopRunView` |
| `POST …/:id/archive` | — | `{ ok: true }` |
| `POST …/:id/lanes` | `{ count: 0..3 }` | the run's target lane count (0 = stop picking); the pool and load gate still apply at pick time |
| `POST …/:id/priority` | `{ order: number[] }` | pick priority among UNBLOCKED tickets (dependencies stay authoritative) |
| `POST …/:id/chat` | `{ text }` | operator message → orchestrator → `{ ok: true }` (text trimmed, non-empty, ≤ 20,000 chars) |
| `POST …/:id/tickets` | `{ number }` | add issue #N to the run |
| `DELETE …/:id/tickets/:n` | — | skip ticket #n |
| `POST …/:id/tickets/:n/stop` | — | kill the step (or dequeue a queued fold), release the lane, ticket → `todo` (round + worktree kept); no immediate re-pick — it is picked again on the next pump trigger; `DELETE …/tickets/:n` (skip) removes it for good |
| `POST …/:id/tickets/:n/retry` | — | `needs-human` → `todo`, rounds reset |
| `POST …/:id/tickets/:n/answer` | `{ text }` | answer a `waiting` ticket |

Error mapping: a request-shape problem → 400; an error carrying a numeric HTTP `status`
(`LoopError`) keeps it; anything else → 500, always `{ error }`. **Bodyless POSTs must not
send a JSON content-type** — a `content-type: application/json` with an empty body is
Fastify's `FST_ERR_CTP_EMPTY_JSON_BODY` 400 (see `.claude/errors.md`); the orchestrator's
cheat sheet says so and the web client's `postBare` sends none.

### WS frames (additive `WsEvent` members on the existing `/ws` hub)

`{type:'loop', run: LoopRunView}` — a run's full view, **coalesced per run** with a 150ms
trailing window (the `LaneEmitter` pattern); never sent for an archived run.
`{type:'loop-event', runId, event: LoopEvent}` — one persisted event (chat / activity /
status / error). `{type:'loop-partial', runId, text}` — orchestrator token deltas only,
transient and never persisted. `{type:'loop-removed', runId}` — the run was archived.
Every client gets every run's frames; the web filters on its open run id. Mirrored in
`packages/web/src/types.ts` with the rest of the Loop types (`LoopRun`, `LoopTicket`,
`LoopLane`, `LoopLoad`, `LoopPool`, `LoopLoadResponse`, `LoopRunView`, `LoopEvent`,
`LoopEventPayload`, `LoopCreateRequest`, `LOOP_MAX_LANES`, `LOOP_MAX_ROUNDS`); `'loop'`
joined `WorkspaceMode`.

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
  Login adds three more additive tables: **`users`** (username UNIQUE, display_name,
  password_hash, timestamps), **`sessions`** (user_id, token_hash UNIQUE, expires_at) and
  **`kb_changelog`** (space_id, page_id nullable, user_id nullable, username, action,
  detail, created_at), plus a nullable **`members.user_id`**. There is deliberately NO
  `page_revisions.user_id`: a revision snapshots the page's PRIOR body, whose author is
  the free-text `pages.updated_by` string with no user id behind it, so the column could
  only ever be null — and the additive-only rule means a column added today can never be
  removed.
  The gauntlet Loop adds three more additive tables (declared once as `LOOP_SCHEMA`):
  **`loop_runs`** (id, repo_id, epic, title, status, prev_status, lanes, integ_branch,
  integ_worktree, priority JSON, pr_url, note, usage JSON, timestamps), **`loop_tickets`**
  (PK `(run_id, number)`; title/body/url, gh_state, blocked_by JSON, bar, state, step,
  round, last_gap, branch, worktree, fold_sha, question, note, usage JSON, started_at,
  step_started_at, updated_at) and **`loop_events`** (autoincrement id, run_id, ticket
  nullable, kind, payload JSON, created_at) + the `loop_events_run(run_id, id)` index.
  Enum columns store the TypeScript literals verbatim (lower-case, e.g. `needs-human`);
  the JSON columns are parsed defensively on read and fall back to their empty value.
- **Migrations:** `ensureColumns()` reads `PRAGMA table_info(tasks)` and `ALTER`s any
  missing column (idempotent); `ensurePageColumns()` and **`ensureAuthSchema()`** do the
  same for the KB and login schema; **`ensureLoopSchema()`** (called from the `Db`
  constructor) re-runs `LOOP_SCHEMA` — three `CREATE TABLE IF NOT EXISTS` + one `CREATE
  INDEX IF NOT EXISTS`, no column change to any existing table; columns also live in
  `SCHEMA` for fresh DBs.
  Strictly additive — `db.test.ts` carries an explicit DATA-LOSS GUARD asserting that
  pre-existing task/page/member/message rows are unchanged after the migration (extended
  to cover the loop tables: every existing table keeps its exact rows AND columns),
  because the VPS redeploys in place over its live database.
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
- **Auth/KB additions:** `createUser` / `getUserByUsername` / `getUserById` /
  `setUserPassword`; `createSession` / `getSession(tokenHash)` / `touchSession` /
  `deleteSession` / `deleteExpiredSessions(now)`; **`memberForUser(user, now)`** (upserts
  the roster row keyed on `members.user_id`, so it is stable across reconnects and
  renames — it deliberately does NOT adopt legacy handle-only rows); `addChangelogEntry`
  / `listChangelog(spaceId, limit)` (newest first, space-scoped). `updatePageBody` takes
  an optional 5th `actor` argument and, when given, also writes a **throttled** (30s,
  keyed on the changelog's own newest `page.edit` row for that page) `page.edit` entry
  inside the same transaction. `upsertMember` is retained but is now LEGACY — nothing in
  the running server calls it.
- **Loop additions:** `insertLoopRun` / `getLoopRun` / `listLoopRuns` (non-archived first,
  each group newest `created_at` first) / `updateLoopRun(id, patch, now)`;
  `upsertLoopTicket` / `getLoopTicket` / `listLoopTickets(runId)` (ascending issue number) /
  `updateLoopTicket(runId, n, patch, now)`; `insertLoopEvent(runId, ticket, kind, payload,
  now)` and `listLoopEvents(runId, {limit?, kind?})` (the MOST RECENT `limit` events —
  default 200, clamped 1..1000 — returned oldest → newest, mirroring `listMessages`);
  **`addLoopUsage(runId, ticket|null, delta, now)`** (atomic `col = col + delta` like
  `addUsage`; adds to the run AND the ticket, or only the run when `ticket` is null — the
  orchestrator's usage — and is a silent no-op for an unknown run/ticket). `LoopRunPatch` /
  `LoopTicketPatch` go through fixed field→column maps: an unknown key is ignored (never
  interpolated), `undefined` means "unchanged", `null` clears, and `usage` is excluded.

## Auth — `password.ts` / `session.ts` / `auth.ts` / `authRoutes.ts` / `cli/createUser.ts`

Username/password login gating the **Knowledge Base** and **Team Chat** surfaces. The
**Workspace** task orchestrator is deliberately ungated. Full rationale and the rejected
alternatives: `.agents/plans/zmrng-login-auth.md`.

- **`password.ts`** — `hashPassword(password)` / `verifyPassword(password, stored)` over
  `node:crypto` **scrypt** (`SCRYPT_N=32768`, `SCRYPT_R=8`, `SCRYPT_P=1`, 32-byte salt,
  64-byte key), stored as `scrypt$N$r$p$<salt-b64>$<key-b64>`. Verify re-derives using the
  parameters PARSED FROM the stored string, so an old-parameter hash keeps working, and
  compares with `timingSafeEqual` after a length check. It never throws: a malformed,
  truncated, unknown-prefix or bad-base64 stored hash is simply `false`. Synchronous by
  choice — login is a rare, throttled path. **`scryptSync` needs an explicitly raised
  `maxmem` at these parameters** (128·N·r is exactly the 32 MiB default) or it throws.
  This is scrypt rather than the originally-specified argon2id (D3) because argon2 is a
  node-gyp addon that `packages/desktop/scripts/bundle-sidecar.mjs` would have to
  hand-vendor; the versioned prefix keeps a later swap to a one-file change.
- **`session.ts`** — pure, no DB. `newToken()` (32 random bytes → base64url),
  `hashToken()` (sha256 hex — **only this is stored**), `expiryFrom(nowIso, ttlMs?)`,
  `isExpired` (fail-closed on an unparseable date), `shouldRenew`. `SESSION_TTL_MS` = 7
  days; `SESSION_RENEW_BELOW_MS` = 6 days, so a session slides only once ~24h of its
  window is spent — a fresh session causes **no DB write per request**.
- **`auth.ts`** — `AuthService(db, ttlMs)`:
  - `login(username, password, now?)` → `{ user, token, expiresAt }` or `undefined` for
    BOTH a wrong password and an unknown username. An unknown username still runs a full
    scrypt verify against a lazily-derived dummy hash, so a miss costs what a hit costs
    and the endpoint is not a username oracle. Callers report `GENERIC_LOGIN_ERROR`.
  - `resolve(authorization, cookieHeader, now?)` — bearer header first, then the
    `zmrng_session` cookie. Rejects unknown/tampered/deleted/expired tokens (sweeping an
    expired row as it notices it) and slides an active session past the renewal window.
  - `resolveSocketIdentity(cookieHeader, helloToken, now?)` — the `/ws/workspace`
    analogue. The `hello` bearer token WINS over the handshake cookie (an explicitly
    presented credential beats an ambient one).
  - `logout(token)`, `sweep(now?)` (delete expired rows; called once at boot).
  - `LoginThrottle` — fixed window, in-memory: **5** failures per `(username, IP)` per
    **15 min**, then `429` until the window lapses. A restart clears it, by design.
  - `sessionCookie(token, {secure, maxAgeMs})` / `clearCookie({secure})` — always
    `HttpOnly; SameSite=Strict; Path=/`. **`Secure` is conditional on purpose (D2):**
    browsers silently DROP a `Secure` cookie on a plain-http origin, and the VPS is plain
    http on the tailnet, so an unconditional flag would break login there outright.
  - `PROTECTED_PREFIXES` / `isProtectedPath(url)` — the single gated-route list:
    `/api/spaces`, `/api/pages`, `/api/folders`, `/api/page-revisions`, `/api/channels`,
    `/api/auth/me`, `/api/auth/logout`. Matches a prefix exactly or at a segment
    boundary. `/api/tasks`, `/api/config`, `/api/preflight`, `/api/settings`,
    `/api/auth/login` and the static UI are NOT gated.
- **`authRoutes.ts`** — `registerAuth(app, { auth, secureCookies, sessionTtlMs?, throttle? })`
  installs the `onRequest` gate (attaches `req.authUser`; 401s a gated path with no
  session; skips `OPTIONS` so a CORS preflight is never gated) and three routes:
  `POST /api/auth/login` (200 + `Set-Cookie` + a body `token`; 401 with **no** cookie on
  bad credentials; 400 on a missing field; 429 when throttled),
  `POST /api/auth/logout`, `GET /api/auth/me`. Also exports `requireUser(req, reply)`.
  It is a **plain function, not a `fastify-plugin` plugin** — an encapsulated plugin's
  hook would not cover the parent instance's routes, and `requireUser` reads exactly the
  `req.authUser` that hook sets. That also makes it registerable on a bare `Fastify()`
  and drivable with `app.inject()` in tests, which is how the gate is proven.
- **Two transports, one token (D2).** Same-origin browsing rides the httpOnly cookie and
  never exposes the token to JS. The desktop app's **cross-origin** Team connection to
  the VPS cannot send a `SameSite=Strict` cookie over plain http at all, so it stores the
  returned token in `localStorage` and sends `Authorization: Bearer`. Because the
  cross-origin path uses a header, `access-control-allow-credentials` is never sent and
  the existing reflected-origin CORS policy stays safe; the only CORS change was allowing
  the `authorization` request header.
- **One login, not one account (D1).** A session belongs to the server that issued it.
  The web client keeps an **origin-keyed** store and submits one credential pair to every
  gated origin in parallel, so the operator types their password once — but the servers
  do not trust each other and `create-user` must be run on each host.
- **`cli/createUser.ts`** — `npm run create-user -- --username <u> [--display-name <d>]
  [--password <p>]` (prompts with echo off when `--password` is omitted; errors if stdin
  is not a TTY). Re-running for an existing username **RESETS the password** and never
  renames the user — the documented recovery path, since there is no reset flow.
  Minimum 8 characters, no composition rules, no maximum beyond `MAX_PASSWORD_LEN`.
  `parseArgs` / `validatePassword` / `provisionUser` are exported separately from the
  `process.argv`+TTY entrypoint so tests drive the logic without executing the script.

## KB routes — `packages/server/src/kbRoutes.ts`

`registerKbRoutes(app, { db, broadcast, log })` — the whole Knowledge Base REST surface
(spaces / folders / pages / revisions CRUD, plus `GET /api/spaces/:id/changelog`),
extracted from `index.ts` as a plain function for the same reason as `registerAuth`, and
tested the same way. Every write calls `requireUser` and attributes the page to the
**authenticated** user: a client-supplied `author` is ignored entirely. Each write also
records a `kb_changelog` entry (`page.create` / `page.rename` / `page.move` /
`page.edit` / `page.delete`). One deliberate carve-out: a page promoted from a channel
message keeps the canonical MESSAGE author (that is its provenance, and the provenance
line carries only the channel and message id), while the changelog records who performed
the promotion.

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
- **Loop load gate (D7):** `config.loopMaxLoadPerCore` (`ZMRNG_LOOP_MAX_LOAD_PER_CORE`,
  default `1.0` — no NEW Loop ticket is picked while the 1-minute load average per core
  exceeds it), `config.loopMinFreeMemMb` (`ZMRNG_LOOP_MIN_FREE_MEM_MB`, default `2048` — no
  new pick while *available* memory is below it) and `config.loopPumpIntervalMs`
  (`ZMRNG_LOOP_PUMP_INTERVAL_MS`, default `30000` — how often the Loop pump re-checks a
  deferred pick), spread into `config` from **`resolveLoopConfig(env)`** (pure, mirrors
  `resolveSecurityPolicy`). Each field falls back to its default **independently** on a
  blank, non-numeric, non-finite, zero or negative value, so a typo can never disable the
  gate (e.g. a 0 memory floor) or spin the pump. `index.ts` builds the production
  `defaultLoadProbe` from the first two. See **LoopManager** above.
- Loads `.env` at repo root into `process.env` (dev convenience).

## Worktree — `packages/server/src/worktree.ts`

- **`createWorktree(repoPath, defaultBranch, worktreesDir, taskId, title)`** — best-effort
  `git fetch origin`, then `git worktree add -b feat/zmrng/<slug>-<shortId> <path> <base>`.
  Base resolved `origin/<defaultBranch>` → local `<defaultBranch>` → `HEAD` (supports
  local-only repos with no remote). Worktrees live under the **target repo's own**
  `worktrees/<shortId>` (e.g. `<repo.path>/worktrees/<shortId>`); `phases.ts` passes
  `path.join(repo.path, 'worktrees')` at spawn time.
  **Optional trailing `opts: { branch?, base?, dir? }`** (omitted ⇒ the behaviour above,
  byte-identical for existing callers) — used by the gauntlet Loop to name its own
  branches and dirs: `branch` replaces `feat/zmrng/<slug>-<shortId>`; `base` replaces the
  resolved default-branch base as the start point of a FRESH branch (an existing branch is
  reattached as-is, never recut); `dir` replaces the `<shortId>` directory NAME under
  `worktreesDir` and must be a plain directory name (a path-bearing, empty or `..` value is
  rejected before anything is created). The call stays idempotent under overrides.
- **`gitIn(cwd, args)`** — exported face of the module's private git helper: runs `git -C
  <cwd> <args>`, resolves the trimmed stdout, rejects on a non-zero exit. Used by
  `LoopManager` for `rev-parse`, `merge-base`, `status --porcelain` and `push`.
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
  `botHandle` for the Team tab — see Team workspace below),
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
  **`GET /api/lanes`** (→ `emitter.snapshot()`) — everything zmrng is running right now
  (Lanes panel); read-only and in-memory, built on demand from the three live-session
  managers, never persisted. Serves the client's initial load; the same payload streams
  live as the `lanes` WS frame (see WS below). The panel's per-row **Close** (inline
  "Close?" confirm) maps to `POST /api/tasks/:id/close-lane` (`TaskManager.closeLane`:
  kills the worker or dequeues it, parks the task `blocked`, frees the lane;
  `restartAgent` accepts a lane-closed `blocked` task and restores its phase),
  `POST /api/lanes/chat/:id/close` (`ChatManager.close`) and
  `POST /api/lanes/terminal/:id/close` (`TerminalManager.close`); the web then closes
  the owning chat/terminal tab. Subagent rows have no Close.
  **`/api/loop/*`** — the gauntlet Loop's REST surface, installed by
  `registerLoopRoutes(app, { loop })` (ungated; route table + validation in the
  **LoopManager** section above). `index.ts` constructs `LoopManager` after
  `manager.reconcileOrphans()` with `runnerFactory: defaultRunnerFactory`,
  `github: ghLoopGitHub()`, `load: defaultLoadProbe({ maxLoadPerCore, minFreeMemMb })` from
  config, `scanFactory: defaultScanRunnerFactory`, `apiBase: http://127.0.0.1:<config.port>`,
  `pumpIntervalMs: config.loopPumpIntervalMs` and `log: app.log`, broadcasting through
  `hub.broadcast`; then calls `loop.reconcileOrphans()` so a run left live by the previous
  process boots `stale` (the operator resumes it, mirroring Restart-agent).
  `GET`/`PUT /api/settings` returns/patches the durable per-user `WorkspaceSettings`
  (`{ teamHandle }`) persisted in `zmrng.db` (the `settings` kv table) — the Team
  display-name handle moved here from browser `localStorage`, which was unreliable
  across refresh/app-reopen/rebuild in the desktop shell; the sidecar DB lives in the
  persistent per-user data dir. `PUT` is PATCH-style (only the keys present are written;
  a blank value clears one) and echoes the full document. The Team workspace **URL is
  not a setting**: it is fixed in the web client (`teamConfig.WORKSPACE_URL`), so
  `ZMRNG_WORKSPACE_URL` is gone and a `workspace_url` row left by an older build is
  never read or accepted again (additive-only migrations — the dead row stays).
  (This list predates several routes — `/api/agents`, `/api/preflight`, `/api/ui-state`,
  `/api/tasks/:id/{files,file,notes,chat}`, `/api/tasks/:id/archive`, and the
  Projects-dir browsing trio `GET /api/projects/files` (dotfile-skipping, depth-capped
  tree of `config.projectsDir`) + `GET`/`PUT /api/projects/file` (read + text-file write
  of an arbitrary project file, both guarded by `files.ts`'s traversal/symlink checks, with
  `PUT` additionally rejecting image/PDF paths) — that already exist in `index.ts`; a
  fuller pass is owed here, tracked as a doc-sync gap rather than documented speculatively
  in this change.)
- **WS:** `GET /ws` — adds the socket to the hub, sends a `snapshot`, then seeds the Lanes
  panel with a `{type:'lanes', snapshot: emitter.snapshot()}` frame (exactly as `snapshot`
  seeds the board) — live updates thereafter arrive as further `lanes` frames broadcast by
  the `LaneEmitter` (see `lanes.ts` above) whenever a worker/chat/terminal session changes.
  The same hub also carries the four `loop*` frames (see **LoopManager** → WS frames); `/ws`
  seeds NO Loop state on connect — the web fetches the runs list / open run / events over
  REST when the Loop mode is entered, and the frames keep it live from then on.
  `GET /ws/terminal` —
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
- **Lifecycle:** SIGINT/SIGTERM → `manager.shutdown()` (kill workers) + `loop.shutdown()`
  (kill every Loop step / final-PR / orchestrator child, stop the pump timer) +
  `terminals.killAll()` (kill PTYs) + `chats.killAll()` (kill standalone chat sessions) →
  close. `process.on('exit')` group-SIGKILLs both `manager.hardKillAll()` and
  `loop.hardKillAll()`. Logs `repoWarnings` at startup.
- `asEffort` / `asStyle` validate enum inputs from the request body.

### Chat wire types (`types.ts`, mirrored)
- **`ChatClientMsg`** (client→server, over `GET /ws/chat`) — `{type:'start'; model:
  string; effort: EffortLevel; style: CaveStyle}` (spawns a fresh session with the
  chosen controls, killing any prior one on the socket) | `{type:'input'; text: string;
  attachments?: Attachment[]}` (one operator turn, optionally carrying image/PDF
  drop/paste attachments) | `{type:'interrupt'}` (cuts the in-flight turn without killing
  the session).
- **`ChatServerMsg`** (server→client) — `{type:'ready'; sessionId: string}` |
  `{type:'lane'; laneId: string}` (the session's Lanes row id, `LaneChat.id`, sent right
  after every (re)spawn via `ChatManager.laneId(session)`; `ChatCard` stores it on the tab
  as `ChatTabMeta.laneId` so a Lanes chat-row click can focus that tab) |
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
  `getLanes()` → `GET /api/lanes` (`LaneSnapshot`) — the Lanes panel's boot load; live
  updates thereafter arrive as `lanes` frames over the `/ws` hub, not repeated polling.
  `req` is **exported** so a typed route group kept in its own module (`loopProtocol.ts`)
  rides the same auth-aware `send()` instead of a second fetch wrapper.
- **types.ts** — MANUAL mirror of `packages/server/src/types.ts`. `EventSub` includes
  `'tool' | 'subagent' | 'subagent_result'`; `EventPayload` includes `tool?`, `actor?`,
  `subagentType?`, `summary?`. `Task.stale?: boolean` — true when the task is in a live
  phase but its worker session was lost (the app was restarted); set only at boot
  reconciliation, cleared when a fresh agent is (re)spawned. `LaneSubagent` /
  `LaneWorker` / `LaneChat` / `LaneTerminal` / `LaneOccupancy` / `LaneSnapshot` — the Lanes
  panel's wire types, mirrored verbatim from the server (see the `lanes.ts` section above
  for field-by-field detail). `WsEvent` gained `{type:'lanes'; snapshot: LaneSnapshot}`.
  The gauntlet Loop's types (`LoopRun`/`LoopTicket`/`LoopLane`/`LoopLoad`/`LoopPool`/
  `LoopLoadResponse`/`LoopRunView`/`LoopEvent`/`LoopEventPayload`/`LoopCreateRequest`, the
  `LOOP_MAX_LANES`/`LOOP_MAX_ROUNDS` constants, `'loop'` in `WorkspaceMode`) and the four
  `loop*` `WsEvent` variants are mirrored the same way (see **LoopManager** above).
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
- **laneRows.ts** (current as of 2026-09-23) — pure, React-free join feeding the Lanes tab.
  The server's `LaneSnapshot` deliberately carries only what the client cannot know
  (subagents, chat sessions, PTYs, lane occupancy); this module joins it against the
  `Task[]`/`RepoTarget[]` the client already holds over the `/ws` hub — same
  no-duplication pattern as `dashboardData.ts`. **`laneRows(snapshot, tasks, repos):
  LaneRows`** — `{execute: {used, cap, queued}, lanes, clarify, chats, terminals}`; a
  worker or queued entry whose task id isn't in `tasks` is dropped (no title/status to
  show, so no row). **`repoLabel(repoId, repos)`** — a chat session's repo label; `null`
  or an unresolvable id both read `PROJECTS_ROOT_LABEL` ("Projects root"). **`taskRepoLabel
  (repoId, repos)`** — a task's repo label; unlike a chat, a task always targets a
  registered repo, so an id missing from the registry falls back to the raw id (mirrors
  `TaskList`'s convention), never to the Projects root. **`formatElapsed(startedAt, now)`**
  — `45s` / `2m 05s` / `2h 03m`; clock skew clamps to `0s`, an unparseable timestamp reads
  as `—`. **`formatTokens(n)`** — thousands-grouped integer, matching the task list's usage
  formatting. Unit-tested in `packages/web/test/laneRows.test.ts`.
- **components/LanesPanel.tsx** (current as of 2026-09-24) — the Lanes tab. Every row is a
  native `<button>` reporting a `LaneTarget` (`laneRows.ts`) through `onOpen`: worker,
  queued, clarify and subagent rows → `{kind:'task'}` (a subagent opens its parent task);
  chat rows → `{kind:'chat', laneId}`; terminal rows → `{kind:'terminal', sessionId}`.
  `WorkspaceView.openLane` selects the task + Worker tab, or focuses the exact owning tab
  via `windowTabs.ts`'s `focusChatLane`/`focusTerminalSession` (a no-op when no tab here
  owns the session), and on the phone shell also calls `onMobileViewChange`. It is
  rendered inside `WorkspaceView`'s fixed pane-tab strip (`PaneTab` gained `'lanes'`
  alongside `worker`/`files`/`terminal`/`chat`; `MobileWorkspaceView`/`MobileView` in
  `mobileNav.ts` gained the matching `'lanes'` entry for the phone drawer, and
  `NavIconName` gained a `'lanes'` glyph — three stacked lanes of decreasing length).
  Purely presentational: every row comes from `laneRows()`, so the component owns nothing
  but a 1s elapsed-time tick that runs ONLY while its tab is the active one (`active` prop)
  — going inactive or unmounting clears the interval, and the immediate first tick on
  re-activation catches the clock up rather than showing a stale elapsed until the next
  interval fires. Renders four groups in order: **Execute lanes** (the single capped pool
  — lane-holding workers, then a "Queued (n)" sub-list in promotion order), **Clarify**
  (uncapped, only rendered when non-empty — the deliberate second, un-pooled group rather
  than a second invented lane pool), **Chat sessions**, **Terminals**; an empty snapshot
  across all four renders "Nothing running right now." A worker row lists its subagent
  child rows indented beneath it, color-accented via the existing `actorColor(type)`;
  status pills reuse `statusColor(status)`. Not unit-tested itself (its logic is the pure
  `laneRows.ts` module); `WorkspaceView` passes it `lanes` (the `App.tsx`-owned
  `laneSnapshot` state, fetched once via `api.getLanes()` on boot and kept current by the
  `lanes` case in `App.tsx`'s `onWs` switch), `tasks`, `repos`, and `active`.
- **Loop mode** (gauntlet loop; engine in the **LoopManager** section above; current as of
  2026-10-01) — a fifth `WorkspaceMode` (`'loop'`, an `ActivityRail` button with a new
  `'loop'` outline `NavIcon`) that is **desktop-only**: the phone shell has no Loop view,
  `mobileNav.viewForMode('loop')` falls back to `'tasks'`, `MOBILE_VIEWS` gains no entry,
  and `App.tsx` coerces a persisted `'loop'` to `'workspace'` on a phone WITHOUT rewriting
  the stored mode (the desktop still reopens Loop) and never mounts `LoopView` there. Pure
  modules (React-free, each unit-tested):
  - **`loopMap.ts`** — `layoutMap(tickets)` (a layered DAG: column = the length of a ticket's
    LONGEST in-map blocker chain, row = order by issue number within the column; a cycle
    falls back to column 0 rather than throwing; out-of-map blockers are ignored — there is
    no node to draw), `mapEdges(tickets)` (blocker → ticket, in-map only), the fixed node
    geometry (`MAP_NODE_W`/`MAP_NODE_H`/`MAP_COL_GAP`/`MAP_ROW_GAP`/`MAP_PAD`, `nodeBox`,
    `mapSize`, `edgeLine`), `doneCount`/`percentComplete`/`mapHeader` (`2 of 4 · 50%`;
    skipped tickets are out of scope), `ticketGlyph(state)` (checked / unchecked / active /
    warn / skipped), `stepLabel`/`phaseColor` (existing `--status-*`/`--actor-*`/`--accent`
    tokens only — NO `--loop-*` token), `RUN_STATUS_LABEL`/`runStatusColor`,
    `formatRound` (`round 2/6`), `laneCards(view)` (the server's live lanes joined with
    their tickets, padded with idle slots up to the run's lane target — never above the
    pool cap, never dropping a live lane), and `poolSummary(view)` (`Pool 2/3 · load
    0.62/core · 5.1 GB free`, degrading to `Pool 2/3` before the first sample, plus the
    `gateClosed` flag and tripped `reason` behind the "picks paused" chip).
    `formatElapsed`/`formatTokens` are reused from `laneRows.ts`.
  - **`loopState.ts`** — the open run persisted to `localStorage` (`zmrng-loop-open-run`:
    `loadOpenRunId`/`saveOpenRunId`), `upsertRun`/`removeRun` (an archived run is dropped),
    `appendLoopEvent`/`mergeLoopEvents` (kept in event-id order, deduped, capped at
    `MAX_LOOP_EVENTS` = 1000 so a long run cannot grow the chat DOM unbounded),
    `isOrchestratorReply`, `appendLoopPartial` (tail-capped at `MAX_LOOP_PARTIAL_CHARS`), and
    `loopThread(events)` — the orchestrator transcript as chat items, **reusing the
    `chatThread.ts` reducer** rather than growing a second one (operator = user bubble,
    orchestrator reply = agent bubble, its tool calls / the loop notifications / errors =
    compact notes; lane `activity` and `status` lines belong to the lanes/map, not the chat).
  - **`loopProtocol.ts`** — `loopApi`, the typed REST helpers for `/api/loop/*`, built on
    `api.ts`'s now-**exported `req`** so they ride the one auth-aware `send()` path;
    `postBare` sends NO content-type (a bodyless POST must not send a JSON one) and a 4xx
    surfaces the server's `{ error }` text.
  - **`App.tsx` wiring** — runs list, the ONE open run, its view + events + the
    orchestrator's streamed partial (coalesced per animation frame like the task `partial`
    stream). Fetched only while Loop is the active mode (never at boot) and kept live by
    the four `loop*` cases in `onWs`; breadcrumb `Loop › #<epic> <title>`.
  - **`components/LoopView.tsx`** — the mode root. No run open: a run picker plus a new-run
    form (repo select + epic number; the lane count is the orchestrator's call). One open:
    a slim header ("All runs", status pill, repo · integ branch, Start / Pause / Resume per
    status, a 0–3 lane-count select, Open PR, Archive with an inline confirm) over a FIXED
    CSS grid — `LoopChat` full height on the left third, `LoopLanes` above `LoopMap` on the
    right two thirds; no dragging or resizing. **`LoopChat.tsx`** — the orchestrator bubble
    thread + composer (Enter sends, Shift+Enter a newline; no attachments, by scope).
    **`LoopLanes.tsx`** — the pool/load header line, a "picks paused: high load" chip while
    the gate is closed, then up to three lane cards (`#n` title link, step pill, round,
    tokens, a 1s elapsed tick running only while Loop is the visible mode, model, the latest
    activity line, the question when `waiting`, and a Stop button with an inline confirm)
    plus muted "idle lane" slots. **`LoopMap.tsx`** — the "N of M · P%" progress header and
    the DAG: nodes with read-only `role="checkbox"` status boxes (checked = done) positioned
    from `layoutMap` as inline styles (the sanctioned dynamic-value case) and straight SVG
    connectors. Presentational over `loopMap.ts`; `LoopView` takes an injectable `client`
    so its tests need no fetch.

---

## Team workspace — `packages/server/src/workspace.ts` + `/ws/workspace`

The shared multi-human comms layer (the **Team** mode tab), run on a VPS. Data lives in the
same `zmrng.db`; local task execution is untouched. One multiplexed WebSocket per teammate at
`GET /ws/workspace` carries channel-tagged frames — never one socket per channel or resource.

- **parseWorkspaceClientMsg(raw)** — tolerant guard over client→server frames (mirrors
  `terminal.ts`/`chatAgent.ts`): malformed JSON, unknown `type`, or a missing/ill-typed/blank
  field all yield `undefined`, never a throw. **Identity has left the wire**: a socket is
  named by its AUTHENTICATED session, never by a frame field. Accepts `hello` (no display
  name; an optional bearer `token` up to `MAX_HELLO_TOKEN_LEN`, for a cross-origin socket
  that has no cookie it can send — an empty token is treated as absent so it cannot blank
  out a cookie-authenticated socket), `ping`, `subscribe`/`unsubscribe` (integer
  `channelId`), `message` (integer `channelId` + non-blank trimmed `body`), `react`
  (integer `channelId`/`messageId` + trimmed `emoji`) and `page.edit` (`pageId` + a capped,
  deliberately un-trimmed `body`). **`message`, `react` and `page.edit` REJECT a frame that
  still carries an `author`/`handle`** — an outdated client fails loudly instead of having
  its post silently attributed to a server-chosen name. (A legacy `hello.displayName` is
  merely dropped, not rejected: it names nothing that gets persisted, and refusing it would
  lock out an otherwise-authenticated socket.) **A `message` frame carries no `kind`** —
  any client-supplied `kind` is dropped, so a human client can never forge an `agent`
  message.
- **Socket authentication** — the `/ws/workspace` route resolves the socket's identity on
  `hello` via `AuthService.resolveSocketIdentity(handshakeCookie, msg.token)`. A socket
  with no usable session is sent `{type:'unauthorized'}` and CLOSED; so is any socket that
  sends a non-`hello`/`ping` frame before authenticating. Nothing is persisted from an
  unauthenticated socket, and the roster/`new-version` seeds are sent only AFTER a
  successful `hello` — an anonymous socket learns nothing, not even who is present.
- **PresenceTracker<S>** — connection-based presence, generic over the socket type for
  testability. `join(socket, memberId)` / `leave(socket)` / `onlineIds()` /
  `roster(members)`. A member is online while holding ≥1 live socket (multi-tab safe); the
  member goes offline only when their last socket leaves.
- **WorkspaceManager** — ties the `members` table to a `PresenceTracker` and a broadcast sink
  (`(frame) => hub.broadcastRoom('workspace', …)`). **`join(socket, user: PublicUser)`**
  resolves the roster row via `Db.memberForUser` (keyed on the user id, so it is stable
  across reconnects and renames) + marks online, `leave(socket)` recomputes, both
  re-broadcast the full roster snapshot (no history replay). `roster()` merges live
  presence over `Db.listMembers()`.
- **ChannelManager<S>** — owns channel message posting + live fan-out via the ticket's
  `Map<channel_id, Set<socket>>` subscription registry (a dedicated map, NOT `WsHub` rooms — a
  deliberate choice so the acceptance-critical fan-out test is crisp). `subscribe(socket,
  channelId)` / `unsubscribe(socket, channelId)` / `unsubscribeAll(socket)` (disconnect
  cleanup — drops the socket from every channel). `post(channelId, author, body, kind, now?)`
  returns `undefined` if the channel does not exist (nothing persisted); otherwise persists via
  `Db.addMessage` and fans the `{type:'message', message}` frame out ONLY to sockets subscribed
  to that channel. The `/ws/workspace` route always calls `post(..., 'human')` — the `agent`
  kind is reserved for the future T4 server-side agent path. `react(channelId, messageId,
  handle, emoji, now)` — the `author`/`handle` arguments are unchanged in shape, but the
  route now passes the socket's AUTHENTICATED display name rather than a wire field. It
  validates the message belongs to the channel (via
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
  empty page). The VPS base the tab talks to is the fixed `teamConfig.WORKSPACE_URL`
  constant — not server config, not a per-user setting.
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
  component owns the socket (glue, like `Terminal.tsx`); Settings has no workspace-URL
  field — the base is a code constant.
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
