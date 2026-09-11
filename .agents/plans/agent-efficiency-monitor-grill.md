# Agent Efficiency Monitor — grill

**Goal:** a tool that surfaces every tool use / thought / habit of an AI agent so we can make
future work more efficient. Main use case: when an agent takes too long, feed its efficiency
profile to the tool and it recommends (or makes) changes.

**Standing directive (lens on every decision):** lightweight, cut agent tokens/time, not
cumbersome (inherited from the sibling `worker-pipeline-efficiency-grill.md`). Spend model tokens
only on irreducible judgment; push mechanics into deterministic code.

## Recon — capture ALREADY EXISTS (do not rebuild)
- `runner.ts:279` `handleLine` parses the worker's full stream-json: `assistant` (text + `tool_use`),
  `user` (`tool_result`), `result` (usage), `stream_event` (partial deltas).
- `db.ts:51` `events` table persists per-task `TaskEvent` rows; `EventPayload{sub, tool, actor,
  summary, isError}` (`types.ts:403-428`). Every tool use, thought (assistant text), subagent spawn,
  and result is already stored. Read path: `db.getEvents(taskId)` (`db.ts:513`), ordered by id.
- `TaskUsage` accumulates `tokensIn/Out/cache`, `costUsd`, `turns` (`db.ts:447`, race-safe against
  concurrent `result` events).
- So "output every tool use / thought" = ~80% built as RAW DATA. The novel part is aggregation +
  the feedback loop, NOT capture.

## Recon — the sibling plan proves the value
- `.agents/plans/worker-pipeline-efficiency-grill.md` (locked 2026-09-10) did BY HAND exactly what
  this tool would automate: a human read `runner.ts`/`phases.ts`, eyeballed the 12k-token/phase tax,
  the opus cost leak (D2), the wasted per-session caveman skill round-trip (D3), and locked 6 fixes.
  This tool = the automated, data-driven engine that generates future D1–D6-style findings from the
  captured event stream instead of a human squinting at code.

## Decisions (locked)

### D1 — Scope v1 to zmrng's OWN workers, not a generic external-log importer
**Decision:** v1 analyzes zmrng's own worker tasks, reading the existing `events` + `tasks` rows.
No new capture code; no "paste any agent's log file" importer.
**Why:** the data already exists in the `events` table, it closes the loop with the sibling
efficiency plan, and it needs zero new capture code. A generic external-agent "efficiency file"
importer is a later adapter once the analysis engine is proven on our own workers.
**Cost accepted:** external agents (non-zmrng) not covered in v1.
**Rejected:** generic paste-any-log tool (builds an import/parse layer before the analysis engine is
proven; the value is in the analysis, not the ingestion).

### D2 — v1 is an ANALYSIS/AGGREGATION layer, not more capture
**Decision:** v1 reads existing `events` rows → aggregates into a per-agent / per-task efficiency
profile → surfaces recurring habits. It is NOT a new live per-event firehose UI (the operator log
already is that).
**Why:** capture is done (D1 recon). The missing layer is aggregation + habit detection + a
feedback artifact.
**Cost accepted:** none material — reuses the stored stream.
**Rejected:** new live capture/firehose UI (duplicates the existing operator log).

### D3 — v1 emits an advisory EFFICIENCY PROFILE; it mutates nothing directly
**Decision:** the deliverable is a per-agent/per-task **efficiency profile** (the "efficiency file"
zc named) — a ranked list of detected habits, each scored by wasted tokens/time, each carrying a
**lever pointer** naming where the fix would land: (a) per-task controls (`model`/`effort`/`flow` on
the `tasks` row — the D2/D4 levers of the sibling plan), (b) zmrng's own phase prompts (`phases.ts`
`styleDirective`/transcript cap/kickoffs — the D1/D3 levers), or (c) the target-repo context tax
(`CLAUDE.md`/`.claude/rules` — largest single win but out of zmrng's control on arbitrary repos).
The profile is the product; it changes no code and writes no `tasks` rows itself.
**Why:** the four candidate lever surfaces have wildly different blast radii, but every one of them
is best decided by a human reading a ranked diagnosis first. The profile is the irreducible v1 —
detection + ranking + a pointer — and it is exactly what the sibling plan produced by hand.
**Cost accepted:** a human still applies the fixes in v1; no time saved on the *applying*, only on
the *finding*.
**Rejected:** v1 directly edits per-task controls (auto-apply risk before the picks are trusted —
see D4); v1 edits `phases.ts`/prompts (a meta-agent rewriting its own harness — highest risk, hard
to review); report is a raw event dump with no ranking (that is the operator log, which already
exists and is the thing that's too noisy to learn from).

### D4 — Advisory in v1; auto-apply never for code, opt-in + operator-confirmed for controls only
**Decision:** v1 is advisory-only. Auto-apply is NEVER offered for code levers (b)/(c). The single
future auto-apply candidate is per-task controls (a) — a bounded enum (`model`/`effort`/`flow`),
reversible — and even that ships later, opt-in, and operator-confirmed per change, only once the
profile's picks have proven trustworthy against hand judgment.
**Why:** a tool that auto-edits `phases.ts` or a system prompt is a meta-agent rewriting the harness
that runs it — high blast radius, hard to review, exactly the class of change that must stay human.
Per-task controls are the only lever whose entire value space is a small reversible enum, so they
are the only safe eventual auto-apply target.
**Cost accepted:** no closed-loop auto-tuning in v1; the operator is the actuator.
**Rejected:** auto-apply code edits (harness self-rewrite risk); fully-automatic control tuning with
no confirm (a mis-detected habit silently degrades every future task on that agent).

### Follows without a separate ruling
- **Granularity constraint (verified):** `TaskUsage` is aggregate-per-task (`db.ts:447`), NOT
  per-event. Token cost is therefore attributable at task/phase granularity, not per individual
  tool call. So v1 habit detection keys off tool-call FREQUENCY/COUNTS and result-error rates from
  the `events` rows, plus the task-level `usage` totals — not per-tool token attribution. Per-event
  token cost would need new capture (out of scope by D2).
- **Read-only data path:** the aggregation reads `db.getEvents(taskId)` + the `tasks.usage` column;
  it needs no schema change and no migration (consistent with the additive-only DB rule).

## Build sequence (when implementing)
1. **Aggregator (D2):** a pure function over `getEvents(taskId)` + `task.usage` → a per-task
   `EfficiencyProfile` (tool-call histogram, subagent spawn count, result-error rate, turns, token
   totals). No I/O beyond the existing read path.
2. **Habit detectors (D2/D3):** a set of pure predicates over the aggregate that flag recurring
   waste patterns (e.g. repeated failed tool calls, opus-on-menial via task model vs flow, subagent
   thrash), each emitting a finding `{habit, wastedEstimate, lever}` where `lever ∈ {control,
   phase-prompt, target-context}` (D3).
3. **Profile surface (D3):** render the ranked findings as the advisory efficiency file (per-agent
   rollup across that agent's tasks). Advisory only — no mutation (D4).
4. Per-task-control opt-in auto-apply is explicitly OUT of v1 (D4) — a later loop.

Every code change: update `packages/web/src/types.ts` mirror if any type moves, then
`npm run typecheck && npm run lint && npm test && npm run build`; the task is not done until the
`.app` is re-bundled (`npm run desktop:build`) per CLAUDE.md app-only directive.

## Empirical premise test (2026-09-10) — ran the queries before building; verdict: DON'T BUILD v1 as scoped

zc asked for a skeptic pass. Ran 4 diagnostic SQL passes over the real history
(repo-root `zmrng.db`: 48 tasks, 6850 events). Result INVALIDATES the plan's D2/D3
detector set. The build is deferred; the analysis is a saved SQL script, not a product.

**What the data supports (real, actionable):**
- **Opus-on-`direct` cost leak** — `opus/medium/direct` = 15 tasks, $77.29, avg 28.5k tok
  (2nd-biggest bucket). Confirms sibling `worker-pipeline-efficiency-grill.md` D2. NOT a new
  find — already has a fix waiting.
- **Same-file re-read/re-edit thrash** — task `a205e1ae` re-`Read` `phases.ts` **18×** AND
  re-`Edit`ed it **11×** (verified full-path identical, not just same prefix). Genuine new
  habit, NOT in the sibling plan. The ONE thing the queries surfaced that's both new and
  actionable.
- **Bash-dominance** — 1894/4182 tool calls (45%) are `Bash`; `Read`=1059, `Edit`=750.
  Possible "use structured Read/Grep not cat/grep" habit; needs interpretation.
- **Skill-invoke tax** — 109 `Skill` calls, mostly the per-session caveman invoke. Confirms
  sibling D3. Not new.

**What the data CANNOT support (capture is blind — kills the detector set):**
- **`isError` exists ONLY on `result` events** (151 rows, 2 true). `tool`/`assistant`/`status`
  events carry NO `isError` field at all. So **"repeated failed tool calls" — a flagship
  detector named in D2/D3 — has ZERO signal.** Main-worker `tool_result`s are dropped by
  design (`runner.ts:362`). The tool cannot see the waste it most wants to detect.
- **`actor` is ALWAYS `main`** (4182/4182). Subagent internals never enter the parent stream,
  so **"subagent thrash" — the other flagship detector — also has ZERO signal.**
- **`turns` is decoupled from effort** — task `37095ff4`: 201 tool calls / **4 turns** (only
  2 `result` events fired; `turns` counts result-boundaries, not work). So any "tokens/turn"
  or turns-as-difficulty metric is meaningless.
- The 4 `error`-kind events are orchestration failures (blocked / worktree-create-failed /
  execute-turn-ended), i.e. reliability signals, NOT behavioral-efficiency habits.

**Verdict:** of the 3 detectors the plan leaned on, 2 are capture-blind and 1 is already known.
The data yields exactly ONE new actionable habit (re-read thrash), extractable in ~20 lines of
SQL (this session's queries). That FAILS the "rich seam of recurring NEW actionable habits" bar
for a product.

**Reframe if zc still wants this:** the real v1 is NOT an analysis engine — it is a ~10-line
CAPTURE fix in `runner.ts` (surface main-worker `tool_result` + `isError`, currently dropped at
`runner.ts:362`) so edit-retry / failed-tool loops become visible. That inverts D2
("analysis-only, no new capture"). Even then the analysis stays a saved SQL script until task
volume outgrows eyeballing (team-workspace scale). Diagnostic queries saved for reuse.

**Order of operations:** (1) implement the sibling plan's known fixes (opus-direct leak first —
the $77 receipt is now confirmed in data); (2) keep the SQL script for ad-hoc curiosity; (3)
revisit a tool only if volume + a capture fix ever justify it. D1–D4 above stay recorded but the
build is DEFERRED, not greenlit.

## Docs produced
- `docs/adr/0002-agent-efficiency-monitor.md` — analysis-over-existing-events, advisory profile.
- `CONTEXT.md` — glossary terms: "efficiency profile", "habit (finding)", "lever pointer".
