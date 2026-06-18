# Plan — zmrng PIV workflow (clarify → plan → execute pipeline)

## Feature

Rework the zmrng phase machine so each task flows
`backlog → clarify → planning → executing → validating → review → done`
(plus `failed` and a new `blocked` state), each surfaced as its own status pill.

Today a single long-lived `claude` child carries a task from clarify straight through
to PR. The new workflow splits the autonomous work across **three fresh children** with
clean context, orchestrated by the server via control tokens emitted by the worker:

1. **clarify** child — workshop Q&A, emits `ZMRNG_READY` (unchanged).
2. **planning** child — fresh, always opus/high. Runs `/core_piv_loop:plan-feature`,
   writes the plan to the *target repo's* `.agents/plans/<slug>.md`, has a QA subagent
   vet the plan (≤2 revise+re-QA rounds, then proceed), and emits
   `ZMRNG_PLAN_READY model=<opus|sonnet> effort=<level> plan=<relative path>`.
3. **executing** child — fresh, on the plan-chosen model/effort (default effort high).
   Runs `/core_piv_loop:execute <plan path>`, routes frontend work to
   `frontend-specialist` and backend work to `backend-specialist`, then runs the
   post-implementation chain `qa → code-reviewer → doc-updater (sync-docs)` — emitting
   `ZMRNG_VALIDATING` when that chain starts — and finally commits, pushes, opens a PR.

If a required subagent is missing from the target repo, the worker emits
`ZMRNG_BLOCKED: <reason>` and stops; the server flags the task `blocked` (keeping the
child alive) and waits for the operator to add the agent and hit **Resume**.

## Control-token protocol (worker → server, each on its own line)

- `ZMRNG_READY` — clarify complete.
- `ZMRNG_PLAN_READY model=<opus|sonnet> effort=<low|medium|high|xhigh|max> plan=<relative path>` — plan complete.
- `ZMRNG_VALIDATING` — execute child moved from implementation into the QA/review/docs chain.
- `ZMRNG_BLOCKED: <reason>` — a required subagent is missing; stop and wait for resume.
- A GitHub PR URL — execute complete → review.

## Child lifecycle (server)

- `start` → spawn **clarify** child (existing).
- `onReady` → kill clarify child, transition `planning`; acquire an execute lane (held
  through the whole autonomous run) or queue; `beginPlan` spawns the **plan** child (opus/high).
- `onPlanReady` → persist chosen model/effort/planPath, kill plan child, transition
  `executing`, spawn the **execute** child, send the execute kickoff.
- `onValidating` → transition `validating`.
- `onBlocked` → transition `blocked` (remember prior phase, keep child + lane).
- `resume` → send a continue turn, restore the prior phase.
- `onPr` → transition `review`, free lane (promotes next queued task into `beginPlan`),
  kill child, keep worktree.

Intentional kills during a handoff are tracked in a `replacing` set so the child's
`exit` event is not mistaken for a crash.

## Files

- `packages/server/src/types.ts` — extend `TaskStatus`; add `planPath` to `Task`.
- `packages/web/src/types.ts` — mirror the above.
- `packages/server/src/db.ts` — `plan_path` column + schema + idempotent migration + row mapping; `TaskPatch`.
- `packages/server/src/phases.ts` — new state machine, prompts, token parsing, multi-child handoff, `resume`.
- `packages/server/src/index.ts` — `POST /api/tasks/:id/resume`.
- `packages/web/src/status.ts` — labels for new statuses.
- `packages/web/src/theme.css` — `--status-planning/-executing/-validating/-blocked` tokens.
- `packages/web/src/api.ts` — `resume` client.
- `packages/web/src/App.tsx` — wire `onResume`.
- `packages/web/src/components/TaskDetail.tsx` — Resume button, plan badge, autobar/queued for new phases.
- `packages/web/src/components/TaskList.tsx` — queued pill check for `executing`.

## Validation

`npm run typecheck && npm run lint && npm run build`, then rebuild the desktop `.app`
(`npm run desktop:build`). Commit (Conventional Commit), push, open PR.

## Acceptance

- New pills render with distinct colors; queued state shows during executing wait.
- Worker advances clarify → planning → executing → validating → review driven only by tokens.
- Plan child runs opus/high; execute child runs the plan-chosen model/effort.
- Blocked tasks expose a Resume action; resuming continues the worker.
- Server↔web types stay mirrored; all three validation commands pass.
