# Worker Pipeline Efficiency — grill

**Goal:** ~10x the zmrng *worker pipeline* on efficiency/speed/cost without losing correctness.
Scope locked (zc, 2026-09-10): zmrng's own worker pipeline (`runner.ts` / `phases.ts` — code we
own and can enforce in TS), NOT the meta-harness that builds projects.

**Standing directive (lens on every decision):** lightweight, cut agent tokens/time, not cumbersome.
Push mechanics into deterministic code; spend model tokens only on irreducible judgment.

## Recon — what's ALREADY built (do not rebuild)
- Planner/implementer/validator are already **separate fresh sessions**, orchestrator-handed-off
  (`phases.ts` clarify/plan/execute kickoffs). No phase inherits another's context.
- Handoffs already **typed control tokens** on their own line, regex-watched
  (`READY_RE`/`PLAN_READY_RE`/`VALIDATING_RE`/`BLOCKED_RE`, `phases.ts:33-37`). This IS the
  "typed handoff" idea — YAML would be a downgrade.
- `FlowMode` already splits **`direct`** (clarify → execute, skip plan, lean chain) vs **`plan`**
  (full PIV). `DEFAULT_FLOW='direct'` (`types.ts:86`) — cheap path is already the default.
- Clarify already skeptical + restate-confirm gate (`phases.ts:166-167`).
- `ZMRNG_BLOCKED` reasons constrained to exactly 3 (`phases.ts:151`).

## Recon — real levers (measured receipts)
- **Per-phase fixed context tax ≈ 12k tokens**: every fresh worker session auto-reads the TARGET
  repo's `CLAUDE.md` (14.5KB) + all `.claude/rules/` (35KB) ≈ 50KB. Paid on every phase. NOTE:
  this is the *target* repo's own harness — largely out of zmrng's control when driving arbitrary
  repos. In-scope only for zmrng-as-target.
- **Unbounded `clarifyTranscript`** (`phases.ts:778-787`): concatenates ALL operator + worker
  assistant turns, no cap/condense, injected into plan + execute + resume kickoffs.
- **Model/effort default drift (BUG)**: `beginDirect` comment says direct flow "defaults
  sonnet/medium for menial work" (`phases.ts:638-639`) but `DEFAULT_MODEL='opus'` /
  `DEFAULT_EFFORT='high'` (`types.ts:82-83`). Every direct task runs the EXPENSIVE model despite
  design intent. Straight 3-5x cost leak.
- **caveman skill invoke every session**: `DEFAULT_STYLE='caveman-full'`; worker's FIRST action is
  to invoke the `caveman` skill (`phases.ts:107`) for narration only. Inline `CAVEMAN_RULES`
  fallback already exists (`phases.ts:84-90`).
- **Plan phase always opus/high** (`beginPlan`, `phases.ts:666`) + QA subagent up to 2
  revise+re-QA rounds (`phases.ts:184`).

## Locked decisions

All six locked by zc blanket-accept (2026-09-10, "go with your recs here"). Rec answers taken as-is.

### D1 — Cap + condense the clarify transcript before it enters downstream kickoffs
**Decision:** `clarifyTranscript` (`phases.ts:778-787`) currently joins ALL operator + worker
assistant turns unbounded, then injects the string into plan, execute, AND resume kickoffs. Bound
it: keep the full confirmed-scope summary (the restate-confirm block the worker emits before
`ZMRNG_READY`) always, plus tail-truncate the remaining turn history to a byte budget (~8KB ≈ 2k
tokens; derive the cap as a named constant, not a magic literal). Oldest turns drop first; the
scope summary is never dropped.
**Why:** the transcript feeds three separate fresh sessions; a long clarify convo multiplies its
cost across all three. The confirmed-scope summary is the actual brief — raw Q&A backscroll is
low-value once scope is locked.
**Cost accepted:** on a genuinely sprawling clarify, some early nuance not captured in the scope
summary is dropped. Mitigated by keeping the summary verbatim.
**Rejected:** leave unbounded (worst on exactly the hardest-clarified tasks); LLM-summarize the
transcript (adds a model round-trip — fights the directive).

### D2 — Direct flow defaults to sonnet/medium; opus/high reserved for plan flow + explicit override
**Decision:** stop coalescing `model/effort` to `DEFAULT_MODEL`/`DEFAULT_EFFORT` at task create
(`phases.ts:886-887`) — persist NULL when the operator didn't explicitly pick (schema already
nullable, `types.ts:136-137`). Then resolve the default per phase: `beginDirect` →
`task.model ?? 'sonnet'` / `task.effort ?? 'medium'`; `beginPlan` already force-spawns opus/high
and is untouched; execute-after-plan already takes the agent-chosen `decision.model`. An explicit
operator pick in the UI still overrides (non-null persists and wins).
**Why:** `beginDirect`'s own comment claims "defaults sonnet/medium for menial work"
(`phases.ts:638-639`) but the create-time coalesce made `task.model` always `opus` — so its
`?? DEFAULT_MODEL` fallback is DEAD CODE and every direct task silently ran opus/high. `direct` is
`DEFAULT_FLOW` (`types.ts:86`), so this is a 3-5x cost leak on the common path. Single biggest win.
**Cost accepted:** direct tasks that genuinely need opus now require an explicit operator pick (or
promotion to `plan` flow). Acceptable — direct is by definition the menial path.
**Rejected:** flow-aware coalesce at create time (couples create to flow, and re-hides the
operator-explicit vs defaulted distinction that the NULL sentinel restores); leave as-is (the leak).

### D3 — Drop the per-session `caveman` skill invoke; use the inline register rules
**Decision:** remove the "your VERY FIRST action MUST be to invoke the `caveman` skill" directive
(`phases.ts:107`) from `styleDirective`; inline the mapped `CAVEMAN_RULES` register (`phases.ts:84-90`)
directly into the system prompt instead.
**Why:** the skill invoke is a wasted tool round-trip on every phase of every task, purely for log
register. The inline fallback rules already exist and produce the same caveman register with zero
round-trips.
**Cost accepted:** lose the skill's wenyan intensity levels for workers. Nobody runs workers in
wenyan; the `wenyan-full` CaveStyle can map to its inline rule or be dropped from the worker path.
**Rejected:** keep the skill invoke (round-trip tax for prettiness).

### D4 — Run the clarify phase on sonnet, not the task's (opus) model
**Decision:** spawn the clarify session on `sonnet` regardless of the task's persisted model; the
plan/execute phases still get the model they earn (plan forces opus; execute takes the agent pick).
**Why:** clarify is scoping Q&A + a restate-confirm gate, not architecture. Sonnet clarifies fine.
**Cost accepted:** marginally less sharp questions on a gnarly scope — caught by the mandatory
restate-confirm gate (`phases.ts:166-167`) before `ZMRNG_READY`.
**Rejected:** clarify on the task model (pays opus rates to ask questions).

### D5 — Keep the planner's agent-judged model/effort pick; do NOT add a deterministic router
**Decision:** leave `ZMRNG_PLAN_READY model=X effort=Y` as the planner's own complexity assessment
(`phases.ts:185`). No files-touched / diff-size heuristic.
**Why:** this is the ONE place the token spend buys an irreducible judgment call — a crude heuristic
picks wrong on small-but-subtle work. Pushing this to code would be a downgrade, against the "spend
tokens only on judgment" principle rather than for it.
**Cost accepted:** the pick stays a model decision (small, bounded token cost in the plan phase).
**Rejected:** deterministic router (crude; mis-picks coupled/subtle small diffs).

### D6 — Reject 3-sonnet execute fan-out as default; keep as manual opt-in for pre-decomposed work
**Decision:** single-opus (agent-chosen model) execute stays the default. Fan-out remains a manual
`wave-delegation` / `parallel-claude-issue-agents` invocation for work with clean independent seams.
**Why:** fan-out only pays when seams are clean+independent; coupled logic makes 3 agents thrash and
you pay an integrator to reconcile 3 branches. `maxLanes=2` (`config.ts:577`) already bounds
parallelism; zc memory records 3 lanes thrash/rate-limit on the laptop.
**Cost accepted:** no automatic parallelism for large decomposable tasks — operator invokes fan-out
by hand when the shape warrants.
**Rejected:** default fan-out (coordination + reconciliation overhead exceeds the win on the common
coupled case).

## Build sequence (when implementing)
1. **D2** first — highest value, smallest change: null-at-create + per-phase default resolution.
   Touch `phases.ts` (`createTask`, `beginDirect`), verify db/web mirror handles null model/effort.
2. **D3 + D4** — both edit the system-prompt / spawn path in `phases.ts` (`styleDirective`,
   clarify spawn model). Land together.
3. **D1** — transcript cap constant + `clarifyTranscript` condense; unit-test the byte budget and
   scope-summary-always-kept invariant.
4. D5/D6 are no-ops (decisions to NOT build).

Every code change: update `packages/web/src/types.ts` mirror if any type moves, then
`npm run typecheck && npm run lint && npm test && npm run build`; the task is not done until the
`.app` is re-bundled (`npm run desktop:build`) per CLAUDE.md app-only directive.
