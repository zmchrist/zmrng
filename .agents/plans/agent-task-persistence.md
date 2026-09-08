# Plan — Agent task persistence (restart frozen task workers after a clean quit)

## Problem

When the desktop app is clean-quit while a task worker is mid-flight, the server
process is killed and takes every task's live `claude` child down with it
(`TaskManager.shutdown()` kills the runners; `Db.close()` checkpoints the WAL). On
reopen a **fresh** `TaskManager` is constructed with an **empty** `runners` map, but
the SQLite rows still show the task in a live phase (`clarify` / `planning` /
`executing` / `validating`). Nothing rehydrates or reconciles this.

Result: the task looks alive in the UI, but:

1. There is no runner behind it. `TaskManager.message()` sees `!runner` and throws;
   `POST /api/tasks/:id/message` returns HTTP 400. The web composer
   (`WorkerLogPanel.send`) calls `onMessage` inside `try/finally` with **no catch**,
   and `ClarifyChat` fires it as `void send(...)`, so the rejected promise is
   swallowed — the operator's message vanishes with no feedback. "Frozen."

## Goal (scope locked in clarify)

Option **B** — honest dead-state recovery, no `claude --resume`:

1. **Detect** orphaned tasks on boot and surface the dead state instead of pretending
   the worker is alive.
2. **Manual "Restart agent"** button on the task's expanded panel (never automatic).
3. **Restart spawns a NEW agent** (not `--resume`) that lands in the **same worktree**
   and receives a **replayed transcript** of the prior task's persisted events via a
   resume-aware kickoff telling it to inspect prior work first and continue without
   redoing it.
4. **Stop the silent message-drop** when no live runner exists — a clear error and a
   prompt to use Restart.
5. Works for all four live phases: `clarify`, `planning`, `executing`, `validating`.

**Out of scope:** true `claude --resume`; standalone Chat cards (`/ws/chat`); the
Terminal card; automatic restart; terminal statuses (`done`/`failed`/`review`) and
`blocked` (which has its own resume path).

## Approach

### 1. A persisted `stale` flag on Task (additive migration)

The UI must be able to tell an orphaned task apart from a genuinely-live one from the
`Task` snapshot alone (status is identical in both). The server is the only place that
knows the `runners` map, so we persist the signal.

- Add a nullable/defaulted `stale` boolean to `Task` (`stale?: boolean`, mirrored
  server↔web). SQLite column `stale INTEGER NOT NULL DEFAULT 0`, migrated
  **additively** via `ensureColumns()` (matches the ADDITIVE-ONLY policy and the
  existing `queued` precedent). `rowToTask` reads `r.stale === 1`.
- Optional (not required) so the ~6 existing web/server `Task` test fixtures need no
  change and older DB rows read `false`.

`stale` is set **only** at boot reconciliation and cleared **only** when a fresh agent
is (re)spawned for the task (plus defensively in `cancel`/`done`). Normal live
operation never sets it, so the flag can never be wrongly true for a running task.

### 2. Boot-time reconciliation — `TaskManager.reconcileOrphans()`

New public method, called once from `index.ts` right after the `TaskManager` is
constructed (before `app.listen`). For every task whose status is in
`{clarify, planning, executing, validating}` with no live runner (always true at boot):
mark `stale: true`, clear `queued`, and emit a persisted `status` event noting the
session ended and Restart is available. Lanes are **not** re-acquired at boot — a lane
is taken only when the operator actually restarts a lane-holding phase.

`blocked` and legacy `building` are excluded (out of scope).

### 3. Manual restart — `TaskManager.restartAgent(taskId)`

New async public method behind `POST /api/tasks/:id/restart` (namespaced under the
task; distinct from the existing self-update `POST /api/restart`). Behavior:

- Reject if the task is not in a resumable status, or if a live runner already exists
  ("already live — nothing to restart"), or if it has no worktree/branch/repo.
- Re-resolve `repoSlug(repo.path)` into `repoSlugs` (lost on restart) so PR detection
  stays repo-scoped.
- Clear `stale`; emit a "Restart agent" status note.
- **clarify** holds no lane → spawn the fresh session directly (`beginResume`).
- **planning / executing / validating** hold an execute lane → acquire a lane
  (respecting `maxLanes`) or queue via the existing `executeQueue`. Queued restarts are
  tracked in a new `resuming: Set<string>` so that when `freeLane()` later promotes
  them through `beginPhaseForFlow`, they route to `beginResume` (a resume kickoff)
  rather than a fresh `beginPlan`/`beginDirect`.

`beginResume(task)` spawns via the existing `spawnPhase` seam (planning forces
`opus`/`high`; other phases reuse the task's persisted `model`/`effort`), clears
`resuming`/`queued`/`stale`, emits a status note, and sends `resumeKickoff(...)` seeded
with `clarifyTranscript(taskId)` (which already condenses all operator + assistant
turns across every phase, not just clarify).

`freeLane()`'s promotion guard is widened to also promote a queued `validating` task
(only reachable via a resumed task); `beginPhaseForFlow` checks `resuming` first.

### 4. Resume-aware kickoff — `resumeKickoff(task, branch, defaultBranch, transcript)`

New exported prompt builder in `phases.ts`. A RESUME preamble (normal English) that:
states a fresh agent is taking over after an app restart; names the phase; carries
title/body; **orders the agent to inspect the worktree (files, `git log`/`status`/
`diff`, plan file) BEFORE acting and to continue rather than redo**; then **delegates
to the existing, already-pinned per-phase kickoff** so the heavy content
(RED→GREEN→REFACTOR, PR body, grill/test-strategy) is reused verbatim, not duplicated:

- `clarify` → preamble + transcript block + `clarifyKickoff(task)`
- `planning` → preamble + `planKickoff(task, transcript)` (transcript lives inside it,
  so it is not repeated in the preamble)
- `executing` / `validating` → preamble + transcript block +
  `executeKickoff(branch, defaultBranch, task.planPath)`

Reusing the existing kickoffs keeps the harness contract single-sourced; only the
preamble is new text.

### 5. Kill the silent message-drop

- **Server** (`message()`): when the status is live but there is no runner, throw a
  *specific* error — `This task's worker session has ended (the app was restarted).
  Press "Restart agent" to continue talking to it.` — distinct from the generic
  not-live message. Still a 400, but now actionable.
- **Web** (`WorkerLogPanel`): add an `err` state; wrap the `onMessage` call in
  `try/catch` and render the error beneath the composer (mirroring `ClarifyChat`'s
  error tray). Pass a `stale` prop through so that, when the task is stale, the panel
  shows a "session ended — press Restart agent" notice and disables the composer up
  front rather than only after a failed send.

### 6. UI — Restart button + honest status

`TaskList` (expanded panel): new optional `onRestart` prop. When `t.stale` and the
status is in the four live phases, render a **Restart agent** primary button and a
notice explaining the worker session ended after an app restart. Gate the misleading
`AUTONOMOUS` "Running autonomously…" autobar and the `STOPPABLE` Stop button on
`!t.stale`. Wire `onRestart` through `WorkspaceView` → `App` (`api.restartAgent`).

## Alternatives rejected

- **True `claude --resume`** — explicitly out of scope (operator chose B). Session ids
  are stored but resuming is unwired and fragile across a restarted worktree/phase.
- **Runtime-only staleness (no DB column), overlaid onto WS broadcasts** — would
  require threading a transient field through `db.listTasks()` snapshots and every
  `patch()`/broadcast site; invasive and easy to miss one. A persisted additive column
  is the codebase's established pattern (`queued`).
- **A dedicated `stale`/`orphaned` TaskStatus** — loses the phase the task was in
  (which the resume kickoff needs) and forces churn through every status pill, label,
  and state-machine guard. A boolean flag orthogonal to status is smaller and safer.
- **A brand-new self-contained resume prompt with its own copy of the execute/PR
  ceremony** — duplicates the pinned harness text (RED→GREEN, PR body) and risks drift
  from `prompts.test.ts`. Composing the preamble over the existing kickoffs avoids it.

## Files to change

**Server**
- `packages/server/src/types.ts` — add `stale?: boolean` to `Task`.
- `packages/server/src/db.ts` — `SCHEMA` + `ensureColumns()` add `stale`; `TaskRow`,
  `rowToTask`, `TaskPatch`, `COLUMN_BY_FIELD`.
- `packages/server/src/phases.ts` — `resumeKickoff()` (exported); `reconcileOrphans()`,
  `restartAgent()`, `beginResume()`, `resuming` set; `beginPhaseForFlow` checks
  `resuming` **before** the flow dispatch; `freeLane` promotion guard widened to include
  `validating`; specific `message()` error; clear `stale` in `cancel`/`done`, and also
  discard `resuming` in `cancel`/`done`/`deleteTask` (transient-set hygiene, alongside
  the existing `interrupting`/`blockedFrom` cleanup).
- `packages/server/src/index.ts` — call `manager.reconcileOrphans()` at boot; add
  `POST /api/tasks/:id/restart`.

**Web (mirror + UI)**
- `packages/web/src/types.ts` — mirror `stale?: boolean`.
- `packages/web/src/api.ts` — `restartAgent(id)` → `POST /api/tasks/:id/restart`.
- `packages/web/src/components/TaskList.tsx` — `onRestart` prop, Restart button,
  stale notice, gate autobar/Stop on `!stale`.
- `packages/web/src/components/WorkerLogPanel.tsx` — error surfacing + `stale` prop
  (notice + disabled composer).
- `packages/web/src/components/WorkspaceView.tsx` — thread `onRestart` to `TaskList`
  and `stale` to `WorkerLogPanel`.
- `packages/web/src/App.tsx` — wire `onRestart={() => api.restartAgent(selected.id)}`.
- CSS modules (`TaskActions.module.css` / `WorkerLogPanel.module.css`) — reuse
  existing token-based classes for the notice; no hard-coded values.

**Docs (Sync Docs step)**
- `.claude/docs/services-reference.md` — new TaskManager methods + `message()` change +
  the new route.
- `CLAUDE.md` / `.claude/rules/frontend-react.md` — one-line notes on `stale`/Restart if
  warranted; `.claude/errors.md` if a gotcha surfaces.

## Step-by-step implementation (TDD)

1. **DB (RED→GREEN):** extend `db.test.ts` — `stale` migrates onto a legacy schema,
   idempotent re-open, `updateTask` sets/reads it back. Then add the column + mapping.
2. **Type mirror:** add `stale?: boolean` to both `types.ts`; `npm run typecheck`
   catches drift.
3. **Prompt (RED→GREEN):** add a `resumeKickoff` describe to `prompts.test.ts` (see
   Test strategy). Then implement `resumeKickoff`.
4. **State machine (RED→GREEN):** add a `restart after orphan` describe to
   `taskManager.test.ts` (see Test strategy). Then implement `reconcileOrphans`,
   `restartAgent`, `beginResume`, `resuming`, the `message()` error, and lane routing.
5. **Server route + boot call** in `index.ts`.
6. **Web:** `api.restartAgent`; `TaskList` button/notice/gating (+ test); `WorkerLogPanel`
   error surfacing + stale notice (+ test); `WorkspaceView`/`App` wiring.
7. **Validate + Sync Docs + screenshot** (UI-touching → capture the expanded stale task
   panel via Playwright MCP, best-effort).

## Test strategy

Runner: **Vitest**, both workspaces — `npm test` (server `node`, web `jsdom`). Hermetic
per repo rules: state-machine test uses the real temp git repo already set up in
`taskManager.test.ts` with the injected `FakeRunner`; no real `claude`/`gh`/network.

- **`packages/server/test/db.test.ts`** (extend) — `stale` column: added by
  `ensureColumns()` on a pre-`stale` schema; idempotent on re-open; `updateTask({stale:
  true})` round-trips through `getTask`. Proves the additive migration + mapping.
- **`packages/server/test/prompts.test.ts`** (extend, new `resumeKickoff` describe) —
  for each phase: contains the RESUME preamble ("RESUME", "inspect", "do NOT redo",
  carries title/body); `clarify` embeds `CLARIFY PHASE`; `planning` embeds `PLAN PHASE`
  + grill + the transcript **exactly once** (assert the `OPERATOR:`-prefixed transcript
  appears a single time for the planning case, so the preamble does not double-inject
  what `planKickoff` already carries); `executing`/`validating` embed `EXECUTE PHASE` +
  `RED —` + the transcript. Assert the delegated kickoff is present **verbatim**
  (`expect(prompt).toContain(clarifyKickoff(...)/planKickoff(...)/executeKickoff(...))`),
  proving reuse rather than a divergent copy.
- **`packages/server/test/taskManager.test.ts`** (extend, new `restart after orphan`
  describe, sharing the existing temp-repo + `FakeRunner` harness) —
  1. Drive a task to `executing` on `mgr`; construct a second `TaskManager` on the
     **same `db`** (empty runners = a simulated restart); `reconcileOrphans()` marks it
     `stale: true` and emits the ended-session status event.
  2. On the restarted manager, `message()` on that task **rejects** with the specific
     "worker session has ended … Restart agent" error (proves the silent-drop fix at
     the source).
  3. `restartAgent()` clears `stale`, spawns a fresh `FakeRunner`, sends a kickoff
     containing `RESUME` + `EXECUTE PHASE`, keeps status `executing`, and takes a lane;
     then a scripted PR URL drives it to `review` (proves the restarted agent completes).
  4. `restartAgent()` on a `clarify` orphan respawns with a `CLARIFY`-phase resume and
     holds no lane.
  5. `restartAgent()` **rejects** when a live runner already exists and when the status
     is not resumable (e.g. `review`).
  6. `maxLanes = 1`: two `executing` orphans, restart both → the second is `queued`;
     driving the first to a PR frees its lane and promotes the second **via a resume
     kickoff** (assert its runner received `RESUME`, not a fresh `PLAN`/`DIRECT`
     kickoff). Proves queue-promotion preserves resume context.
- **`packages/web/test/TaskList.test.tsx`** (extend) — a `stale` live-phase task renders
  a **Restart agent** button (fires `onRestart`) and the stale notice, and does **not**
  render the "Running autonomously…" autobar or the Stop button.
- **`packages/web/test/WorkerLogPanel.test.tsx`** (add if absent, else extend) — a
  rejected `onMessage` renders the error text; a `stale` task shows the session-ended
  notice.

No production code path here is untestable; there is no tolerance clause to invoke.
