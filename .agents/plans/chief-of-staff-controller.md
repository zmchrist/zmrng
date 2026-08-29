# Plan: Chief of Staff — voice controller for zmrng

**Slug:** `chief-of-staff-controller`
**Branch:** `feat/zc/chief-of-staff-controller` (from `origin/main`) — not yet cut
**Type:** New capability (voice-driven orchestration layer)
**Status:** GRILLING (decisions locking inline)

---

## Scope

A **Chief of Staff (CoS)** voice agent that lets the operator run zmrng's whole
task pipeline hands-free: spin up tasks, feed clarifications, watch the board,
surface blockers, and close tasks out — by talking, not clicking. The CoS is a
**controller** that marshals the existing autonomous workers; it does not write
code itself.

### Explicitly OUT of scope (zc, 2026-08-29)
- CoS becoming a coding agent / super-worker (rejected in D1 — workers keep the hands).
- Any change to the worker leg (runner/worktree/phase machine/PR flow) — untouched.
- Team-workspace (`/ws/workspace`) integration — separate feature.

---

## Baseline facts (verified, with receipts)

- **Voice already ships, deliberately read-only.** `VoiceView` drives `/ws/chat`
  with `voice:true` → `voiceSystemPrompt` (chatAgent.ts:45), whose contract is
  "no tasks, phases, branches, PRs, or control tokens. Just talk, explore, help."
  So voice today is a blind narrator with read/explore filesystem access only.
- **The orchestrator control surface is complete and un-actuated by any agent.**
  REST: `POST /api/tasks` + `/start /message /interrupt /resume /done /cancel
  /archive`, `DELETE /api/tasks/:id`, `GET /api/tasks`, `GET /api/tasks/:id/events`
  (index.ts:266-565). TaskManager mirror: `createTask/start/message/interrupt/
  resume/done/cancel/deleteTask` (phases.ts:693-917).
- **The frontend already has a complete typed control client.** `api.*` in
  api.ts:169-203 covers every op above; it lives in the browser next to
  `VoiceView`, alongside the `/ws` event hub (`useWs`).
- **No MCP infrastructure exists.** 0 matches for `mcp|--mcp-config|--allowed-tools`
  across `packages/`. Runner spawns with a fixed base arg set (runner.ts:194-233) +
  `--dangerously-skip-permissions`; no tool bridge to the orchestrator.
- **Control-token precedent exists.** The phase machine already detects
  `ZMRNG_READY / ZMRNG_PLAN_READY / ZMRNG_VALIDATING / ZMRNG_BLOCKED` + a PR-URL in
  worker stdout (phases.ts). Parsing structured directives out of agent output is
  an established in-repo pattern, not a new invention.
- **Mode-flag precedent exists.** `/ws/chat` `start` already carries a `voice:true`
  flag (chatAgent.ts:109, index.ts:693) selecting `voiceSystemPrompt`. A
  `controller` capability can ride the same seam rather than a new route.

---

## Decisions (locked)

### D1 — The Chief of Staff is a CONTROLLER over autonomous workers, not a super-worker
**Decision:** The CoS marshals zmrng's existing worker pipeline via the
orchestrator control surface — create/start/steer/resume/close tasks — and never
writes code itself. Workers remain the only hands (isolated worktrees, phase
machine, PR flow).
**Why:** zmrng's whole thesis is autonomous workers that plan→implement→validate→PR
in sandboxed worktrees. The missing piece is a *brain that speaks and actuates the
orchestrator*, not another pair of hands. The control surface already exists
end-to-end (receipts above); a controller is a thin orchestration layer on top of
working machinery.
**Cost accepted:** Needs a real actuation path into the orchestrator (D2) and a
controller system prompt distinct from the read-only `voiceSystemPrompt` (D3) —
new but small machinery.
**Rejected:** *Super-worker that codes by voice* — would re-implement the worker
leg inside a chat session with no worktree, no lane cap, no PR discipline, throwing
away the product to answer the ask worse; and a voice-misheard destructive command
would then have hands on the real repo instead of a sandboxed task.

---

## Open decisions (grill queue)
- **Q2 (gating for the actuation cluster):** actuation mechanism — MCP control
  tools vs server-side Bash-curl vs frontend intent-routing through the typed `api`.
- **Q3:** session/prompt architecture — extend `/ws/chat` with a `controller`
  capability flag (mirroring `voice:true`) vs a new route/manager; controller
  system prompt content.  *(content depends on Q2)*
- **Q4:** clarify-loop authority — does the CoS answer worker clarifications
  autonomously from an operator briefing, or relay them to the human by voice?
- **Q5:** state observation — poll REST vs subscribe to the `/ws` event hub to
  narrate progress / detect READY / PLAN_READY / BLOCKED / PR.  *(depends on Q2)*
- **Q6:** safety gating — which ops are voice-triggerable outright (create/start/
  message) vs confirm-gated (cancel/delete/PR-merge/done).  *(depends on Q2)*
- **Q7:** concurrency/repo marshalling — voice repo selection; one task at a time
  vs multiple concurrent (lane cap already `ZMRNG_MAX_LANES`, default 2).
- **Q8:** MVP scope / phasing — smallest first cut.
