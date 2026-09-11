# ADR-0002 — Agent efficiency monitor (analysis-over-events, advisory profile)

- **Status:** Accepted (implementation not started)
- **Date:** 2026-09-10
- **Deciders:** zc
- **Plan:** `.agents/plans/agent-efficiency-monitor-grill.md`

## Context

We want a tool that surfaces every tool use / thought / habit of an AI agent so future
work runs more efficiently: when an agent takes too long, feed its efficiency profile to
the tool and it recommends changes. The ask reads greenfield, but recon overturned that
premise.

Capture already exists. `runner.ts:279` (`handleLine`) already parses the worker's full
stream-json — `assistant` (text + `tool_use`), `user` (`tool_result`), `result` (usage),
`stream_event` (partial deltas) — and `db.ts:51` persists every event as a `TaskEvent`
row (`EventPayload{sub, tool, actor, summary, isError}`), readable via
`db.getEvents(taskId)`. `TaskUsage` accumulates tokens/cost/turns per task (`db.ts:447`).
So "output every tool use / thought" is ~80% built as raw data; the missing layer is
aggregation + habit detection + a feedback artifact.

The value is also already proven by hand: `worker-pipeline-efficiency-grill.md` (locked
the same day) is a human doing exactly this — reading `runner.ts`/`phases.ts`, spotting
the 12k-token/phase tax, the opus cost leak, and the wasted caveman skill round-trip, then
locking six fixes. This tool is the automated, data-driven engine that generates future
findings of that shape from the captured stream instead of a human squinting at code.

## Decision

Ship v1 as a read-only analysis layer over the existing event store:

1. **D1 — Scope to zmrng's own workers.** Read the existing `events` + `tasks` rows; no
   new capture code and no generic "paste any agent's log" importer. External-agent
   import is a later adapter once the analysis engine is proven.
2. **D2 — Analysis/aggregation, not more capture.** Aggregate stored events into a
   per-agent/per-task efficiency profile and surface recurring habits. Not a new live
   firehose UI — the operator log already is that.
3. **D3 — Advisory efficiency profile that mutates nothing.** The deliverable is a ranked
   list of detected habits, each scored by wasted tokens/time and tagged with a *lever
   pointer* — per-task control (`model`/`effort`/`flow`), zmrng phase prompt (`phases.ts`),
   or target-repo context tax (`CLAUDE.md`/rules). The profile is the product; it edits no
   code and writes no rows.
4. **D4 — Advisory only in v1.** Auto-apply is never offered for code levers. The single
   future auto-apply candidate is the per-task controls (a bounded, reversible enum), and
   even that ships later, opt-in, operator-confirmed per change, only after the picks earn
   trust.

Granularity is bounded by the data: `TaskUsage` is aggregate-per-task, not per-event, so
v1 keys habit detection off tool-call frequency/counts and result-error rates from the
event rows plus task-level token totals — not per-tool token attribution. The read path
needs no schema change and no migration.

## Q → Decision

| Q | Decision |
|---|---|
| Q1 Scope: own workers vs generic importer | D1 — zmrng's own workers, reuse `events`/`tasks` |
| Q2 v1 = analysis vs more capture | D2 — analysis/aggregation only; capture is done |
| Q3 What does "make changes" mutate | D3 — nothing; emit an advisory profile + lever pointer |
| Q4 Advisory vs auto-apply | D4 — advisory v1; auto-apply never for code, opt-in for controls |

## Consequences

- Zero new capture code and zero migration — v1 is a pure read over `getEvents` + `usage`.
- The profile automates the hand-analysis the sibling efficiency plan did, so future
  D1–D6-style findings are generated from data, not human code-squinting.
- **Costs accepted:** external (non-zmrng) agents are uncovered in v1; a human still
  applies every fix (no time saved on applying, only on finding); habit detection is at
  task/phase granularity, not per-tool token attribution, until capture is extended.

## Rejected alternatives

- **Generic paste-any-log importer first** — builds an ingestion/parse layer before the
  analysis engine (the actual value) is proven; deferred to a later adapter.
- **New live per-event firehose UI** — duplicates the existing operator log, which is
  already too noisy to learn from (the reason this tool exists).
- **v1 auto-edits `phases.ts` / system prompts** — a meta-agent rewriting its own harness;
  highest blast radius, hard to review, must stay human.
- **v1 auto-tunes per-task controls with no confirm** — a mis-detected habit silently
  degrades every future task on that agent.
- **Raw event dump as the report** — no ranking; that is the operator log, already present.
