# Layman Partner Onboarding — Grill Decision Record

**Session:** 2026-08-29 · grilling · zc
**Question that opened it:** make zmrng plug-and-play for non-technical partners; ship the app, not the dev server.

## Context that reframed the whole grill

- Both named partners run **Windows**. The shipped `.app` is macOS-only (Tauri `targets:["app"]`, `main.rs` POSIX `libc::kill`/`$SHELL -lic`, `~/Library/Application Support` data dir). → **Mac packaging (sign/notarize/dmg) is deferred entirely** — zero value for Windows users. Multi-OS is a real project (per-OS Tauri build + `main.rs` POSIX rewrite + native prebuilds for `better-sqlite3`/`node-pty`), not this week.
- Claude Code runs natively on Windows (cmd/PowerShell) — confirmed by zc from experience. Retires that risk.
- Interim path for both partners: **run the dev server** on Windows until multi-OS ships.
- Partner A (chat-only, non-technical): **Pro $20 sub is fine** — chat only, no heavy autonomous work.
- Partner B (real coding): **Max sub** — planning phase is pinned opus/high, a token furnace; Pro would hit the Opus wall mid-plan.
- Vision: an all-in-one workstation where a layman contributes *without* learning harness engineering or agent-prompting. Recon confirms this is what zmrng's harness already *is* — the lifecycle (Plan→TDD→Review→Validate→branch-only→PR) is enforced from the orchestrator, not from operator discipline. The expertise lives in the tool, not the user.
- The real hole is not packaging: the harness encodes *how* an agent works, never *what* to build or *whether the output is correct*. A layman cannot tell a confident-wrong PR from a correct one. That is an accountability-architecture question — the spine of D1.

## Decisions

### D1 — All layman output ships as a review-gated PR; zc is sole merge authority
**Decision:** Every task a layman authors is delivered as a pull request that a technical reviewer (zc, for now) must review and merge. Never layman-merge, never layman autonomous ship.
**Why:** The harness guarantees the *process* was rigorous; it cannot guarantee the *result* is right, and the one person who cannot verify that is the layman who authored it. Keeps human judgment at the merge gate zmrng already has (workers open PRs, never merge — `systemPrompt` branch-only rule).
**Cost accepted:** zc is the throughput bottleneck for all partner work. Acceptable — correctness must not depend on the weakest evaluator.
**Rejected:** Layman autonomous merge — makes repo correctness depend on the weakest evaluator, the exact thing the harness was built to avoid.

### D2 — The chat partner contributes through the Team workspace, not the local app
**Decision:** Partner A's surface is the Team workspace (VPS-hosted server binary, Tailscale-perimetered): shared channels + the T4 `@agent` repo-aware bot + the T3 "Send to my zmrng" handoff into a technical partner's local backlog.
**Why:** The criterion "they contribute to *our* shared work" kills the claude.ai / local-sandbox options (no path back into the workflow). The Team workspace IS the shared collaboration surface, and the contribution wedge is already built.
**Verification (grep, not trust):** T1–T4 wired end-to-end AND unit-tested.
- Server: `workspace.ts` (WorkspaceManager presence/roster + ChannelManager fan-out, instantiated index.ts:98/105), routes `GET/POST /api/channels`, `GET /api/channels/:id/messages`, `GET /ws/workspace` (index.ts:306/315/336/713), heartbeat ping/pong + roster seed, `agentResponder.ts` @mention bot (index.ts:778, server-controlled `kind='agent'`, best-effort, never blocks the socket).
- Web: `TeamView.tsx` real mounted 3rd tab (App.tsx:33), `teamHandoff.ts` "Send to my zmrng" (TeamView.tsx:421 → `buildHandoffPrefill` → App.onSendToZmrng seeds NewTaskForm, App.tsx:187-192/274).
- Tests: `workspace.test.ts`, `agentResponder.test.ts`, `ws.test.ts`, `teamHandoff/teamConfig/roster/channelThread/workspaceProtocol.test.ts` (8 files).
**Cost accepted:** VPS infra + Tailscale perimeter is zc's one-time op. Self-asserted handles = tailnet membership IS the access control (no app-code auth gate — documented POC precondition). Partners just paste a URL into Settings.
**Rejected:** Local single-user app for the chat partner — rebuilds the claude.ai dead-end (private sandbox, no shared-work path) inside zmrng.
**Remaining gap:** Never booted against a live VPS. Construction done; only deploy + one live Tailscale smoke test left.

### D3 — Harden the clarify phase (skeptical-by-default + restate-and-confirm)
**Decision:** Add two behaviors to `clarifyKickoff` (phases.ts:160-166):
1. **Skeptical-by-default** — the worker keeps probing vague/thin answers and refuses to emit `ZMRNG_READY` until scope is concrete.
2. **Restate-and-confirm** — before emitting `ZMRNG_READY`, the worker echoes back "here is what I understand you want" and waits for explicit operator confirmation.
**Why:** The clarify mechanism already drives the interview (worker asks, layman answers — no blank prompt box), which is sufficient to *remove prompt-craft burden*. It is NOT sufficient to *stop a premature READY on a layman's thin answer*: today the worker self-certifies "enough to plan and implement fully autonomously" and rolls into full auto → a wrong-scoped PR lands on zc's review desk (the D1 cost leak). Hardening plugs it at the cheap end (before the PR), not only at the merge gate.
**Cost accepted:** Slightly longer clarify loops; a technical operator giving crisp answers passes the confirm quickly.
**Rejected:** Task templates / an authoring wizard — puts the blank-page/prompt-craft burden back on the layman, fighting the exact thing clarify exists to remove. Also rejected: leave clarify as-is — every under-scoped task becomes a wrong PR in zc's queue.
**Self-retraction note:** I first recommended hardening, retracted it when zc said "mechanism sufficient," then zc reversed to the original hardening rec. The mechanism-sufficient call was correct about *driving the interview*; it did not cover the *premature-READY* gap. This is a narrowing→reinstatement, not a flip-flop.

### D3a — The rule lives in `clarifyKickoff` only, not `systemPrompt`
**Decision:** Add the skeptical/confirm behavior to `clarifyKickoff` (phases.ts:160-166). The token *semantics* ("ZMRNG_READY = clarify complete") stay in `systemPrompt` (phases.ts:148).
**Why:** The behavioral gate (when NOT to emit READY) is phase-specific → belongs in the clarify brief. `systemPrompt` stays cross-phase, `clarifyKickoff` stays phase-specific.
**Rejected:** systemPrompt (bleeds a clarify-only rule into every phase's prompt), or both (duplication + drift).

### D3b — Pin the new clarify rule in `prompts.test.ts`
**Decision:** Add a `describe('clarifyKickoff')` block asserting both behaviors (skeptical-READY refusal + restate-and-confirm). This also newly pins `clarifyKickoff`, which had ZERO tests.
**Why:** The contract-test pattern (prompts.test.ts) exists so a silent edit can't drop a lifecycle rule unnoticed. `clarifyKickoff` is currently the ONE unpinned layman-facing prompt — adding a skeptical-READY rule without a test would leave the most-important-for-laymen gate the least guarded.
**Cost accepted:** One new test block; `clarifyKickoff` must be exported for the test (planKickoff/executeKickoff/directKickoff already are).
**Rejected:** Ship the rule unpinned — a future silent edit to clarify would not trip CI.

### D4 — Team handoff is the only chat→task bridge; no local Chat-card bridge
**Decision:** Do NOT build a "turn this into a task" affordance in the standalone local Chat card (`ChatPane` → `/ws/chat`). The T3 Team-channel handoff (`teamHandoff.ts`) stays the sole chat→task path.
**Why:** The chat-only partner never sees the local Chat card (D2 — they live in the Team workspace on Pro; their repo-aware bot is the T4 `@agent`). The Max partner is technical — if he chats locally and finds something to build, he authors a task directly and clarify (D3) absorbs the prompt-craft. A second bridge duplicates the wedge for a user who doesn't exist yet.
**Cost accepted:** A local chat that lands on a buildable idea requires a manual retype into the new-task box. Marginal.
**Rejected:** Build a chat-thread→task-brief encoder in `ChatPane` — net-new UI maintained forever for a marginal retype-saving on a surface neither named partner contributes through. YAGNI; cheap to add later if a local layman ever appears.

## Build sequence (implementation, pending a separate go-ahead)

Only D3/D3a/D3b are code. D1/D2/D4 are policy/architecture already satisfied by the codebase.

1. Branch from `origin/main`: `feat/zc/harden-clarify-scope-gate`.
2. Export `clarifyKickoff` from `phases.ts` (currently module-private).
3. Edit `clarifyKickoff` text (phases.ts:160-166): add skeptical-by-default probing + refuse-READY-until-concrete + restate-and-confirm-before-READY, in the caveman-compatible register (behavioral rule, not code — stays subject to `styleDirective`).
4. Add `describe('clarifyKickoff')` to `prompts.test.ts` asserting both behaviors.
5. Validate: `npm run typecheck && npm run lint && npm test && npm run build`.
6. PR (never merge self, per the harness zc is dogfooding).

## The actual remaining work is ops, not code

The vision is built. The one real gap is **D2's deploy + one live Tailscale smoke test** of the VPS Team workspace — architecture is wired and tested, never run end-to-end over the tailnet. Everything else here is a small prompt hardening (D3) plus confirming settled policy (D1/D4).
