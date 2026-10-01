# Code review — Loop tab (gauntlet loop)

- **Date:** 2026-10-01
- **Plan:** `.agents/plans/gauntlet-loop-tab.md`
- **Branch:** `feat/zmrng/loop-1fd592c2`
- **Verdict:** **APPROVE after fixes.** The reviewer's single blocking item was a false
  positive. Two further gaps found in the lead's own review pass were fixed with tests.

## Scope reviewed

The whole feature. On the server: `loop.ts` (`LoopManager`), `loopMap.ts`,
`loopPrompts.ts`, `loopGithub.ts`, `loopLoad.ts` and `loopRoutes.ts`; the edits to
`db.ts`, `config.ts`, `worktree.ts`, `index.ts` and `types.ts`; and every test file.
On the web: `loopMap.ts`, `loopState.ts`, `loopProtocol.ts`, the four `Loop*`
components, and the `App.tsx`/`api.ts`/`ActivityRail.tsx`/`NavIcon.tsx` edits. Also
`docs/adr/0003-gauntlet-loop.md`.

## Properties verified

- **Lane pool.** It is capped at `LOOP_MAX_LANES` across runs by a synchronous
  `acquire`. Every lane-ending path goes through one `releaseLane`. `resume` re-acquires
  slots synchronously before its first await.
- **Fold mutex.** The mutex is claimed synchronously before any await. A stale or
  duplicate `onFoldSettled` is ignored. A queued ticket keeps its lane.
- **Generation guards.** These sit on every step runner callback, so a killed child's
  late `onResult`/`onExit` is inert.
- **Machine assertions.**
  - Builder: tree clean and HEAD advanced.
  - Critic: HEAD unchanged and tree clean (read-only).
  - Fold: the ticket tip is an ancestor of integ HEAD and the tree is clean. Only then
    does the server push integ.
  - The only server push is `git push origin <integ>`: never forced, never the default
    branch.
- **Final PR.** The URL must belong to this run's own repo slug, and fenced code is
  ignored. The final security scan fails closed.
- **Spawning and shelling out.**
  - Every `claude` child is spawned through the `RunnerFactory` seam, so the
    `ANTHROPIC_API_KEY` strip holds.
  - `gh` runs via `execFile` with no shell, after slug and issue-number validation.
  - The `createWorktree` `dir` override cannot escape `worktreesDir`.
- **Migration.** It is additive only (`CREATE … IF NOT EXISTS`), and the data-loss guard
  is extended to the loop tables.
- **Untouched pipeline.** `phases.ts` and `taskManager.test.ts` are byte-identical to
  HEAD.
- **Type mirror.** The server and web `types.ts` diffs are identical.
- **Web.** It uses design tokens only, has no `any`, and runs Loop fetches only while
  `mode === 'loop'`. A phone coerces `'loop'` to `'workspace'`.

## Findings

### 1. "`phases.ts` modified" (reviewer, major) — FALSE POSITIVE

The reviewer reported three removed lines in `phases.ts` (`onProcess` plus two broadcast
calls). `git diff --quiet HEAD -- packages/server/src/phases.ts
packages/server/test/taskManager.test.ts` is clean, QA's contract check agrees, and
`phases.ts` contains no `onProcess` symbol at all. No change was needed.

### 2. A ticket queued on the fold mutex rendered as an "idle lane" (lead, minor) — FIXED

A ticket waiting for the serial fold holds a pool slot but has no live child, so
`view().lanes` (built only from live runners) omitted it. The web padded that slot as
"idle lane" while `Pool n/3` counted it as used. `view()` now adds a placeholder lane
for every held slot without a live runner: step `fold` with activity "queued — waiting
for the serial fold", or "starting…" mid-pick. Test: `loopManager.test.ts` › "a ticket
queued on the fold mutex still shows as a lane (every held slot is a lane card)". It was
RED before the fix.

### 3. Failed background jobs without a run were silently swallowed (lead, minor) — FIXED

`track()` recorded a rejected fire-and-forget job only as a run event, so a job with no
run id (e.g. a pump) vanished with no log. A rejecting load probe also failed closed
without any log line.

- `LoopDeps.log?: LoopLog` was added, and `index.ts` passes Pino's `app.log`.
- `track()` now always logs `loop background job failed`.
- The probe failure logs `loop load probe failed — picks deferred` and still defers.

Tests: "logs every failed background job, and records it on the run when it has one"
(RED proved by reverting the log line) and "a rejecting probe fails closed (picks
deferred) and is logged".

## Noted, not changed

- `chat()` spawns the orchestrator before persisting the operator line, so a respawn
  recap does not duplicate the message. This is intended.
- A ticket added while the run is `finalizing` reopens the run and ignores the in-flight
  scan result. Without that, the final PR could ship without the new ticket.
- Stopping a ticket returns it to `todo` without an immediate re-pick. It is re-picked on
  the next pump trigger, and skip removes it for good. This is documented in
  `services-reference.md`.
