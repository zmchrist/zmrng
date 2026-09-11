# ADR-0002 — GUI workflow presets (Chat-card prompt presets)

- **Status:** Accepted (implementation not started)
- **Date:** 2026-09-11
- **Deciders:** zc
- **Plan:** `.agents/plans/gui-workflow-presets-grill.md` (grill closed, blanket accept)

## Context

The operator asked to surface "our workflows" (grill, wayfinder, teach-me, …) directly in
the zmrng GUI — a workflow dropdown in the chat tab — so users discover and use them
without being taught the harness skills.

Recon overturned the premise. grill/wayfinder/teach-me do **not** exist for the zmrng
runtime: they are Hermes-agent skills (`~/.hermes/profiles/projects/skills/`), a different
agent system from the Claude Code `claude` binary zmrng spawns. They are absent from the
harness (`.claude/skills` = sync-docs, create-task, caveman; `.claude/commands` =
plan-feature, execute, prime*, validate, code-review*, commit, push) and from
`~/.claude/skills`. Moreover the target surface — the standalone Chat card
(`ChatCard.tsx`/`ChatPane.tsx` → `/ws/chat`, `chatAgent.ts`) — gets **no** harness seeded
(only worker worktrees do, `worktree.ts:177-240`), so it can't reach even the workflows
that DO exist.

So the real question was never "which dropdown UI" but "what is a zmrng workflow, and where
does it attach." One asset already answers the *how*: the `style` dropdown maps to
`styleDirective(style)`, a register block inlined into the chat system prompt with zero tool
round-trips (`chatAgent.ts:32`, `phases.ts:194-208`). A workflow is the same mechanism with
a different directive body.

## Decision

Ship GUI workflows as **Chat-card prompt presets**:

1. **D1 — A workflow is a prompt preset**, a named directive block appended to the chat
   system prompt (`workflowDirective(workflow)`, structurally identical to `styleDirective`).
   No seeded skill/command files; no native skill discovery.
2. **D2 — Attach to the Chat card (`/ws/chat`) only**, as an additive `workflow` dropdown
   beside model/effort/style. The worker/task pipeline is untouched — it already *is* a
   workflow (plan→execute→validate→scan→PR).
3. **D3 — zmrng owns its own committed copies** of the preset bodies, authored for zmrng
   users; not read from or symlinked to the operator's `~/.hermes` skills at runtime.
4. **D4 — Ship only single-session-viable presets first**: grill, teach-me, and candidate
   code-review. wayfinder and any multi-session / subagent-spawning workflow are out of the
   first slice.
5. **D5 — The workflow preset composes with the style directive**, not replaces it: style is
   narration register, workflow is session behavior; both append. `workflow = 'none'` (the
   default) appends nothing, so current behavior is byte-unchanged and the change is additive
   with no migration.

## Q → Decision

| Q | Decision |
|---|---|
| Q1 What a workflow mechanically is | D1 — prompt preset (append a directive), not seeded files or slash-passthrough |
| Q2 Which surface it attaches to | D2 — Chat card `/ws/chat` only; worker pipeline untouched |
| Q3 Source of truth for content | D3 — zmrng owns committed in-repo copies; drift from Hermes accepted |
| Q4 Which workflows ship first | D4 — single-session-viable only (grill, teach-me, code-review); wayfinder out |
| Q2b Compose vs replace style | D5 — compose; `workflow`⊥`style`, both append, default `none` |

## Consequences

- The dropdown teaches users the workflows by making them selectable — the driver's goal —
  without any harness-skill onboarding.
- Zero new runtime: reuses the proven `styleDirective` inlining path and the existing typed
  `start`-frame seam (`chatProtocol.encodeStart` / `parseChatClientMsg`).
- Additive and migration-free: `workflow?: WorkflowPreset` defaults to `'none'`; an old
  persisted tab or `start` frame hydrates unchanged.
- Both type mirrors change together (no shared package): the `WorkflowPreset` union + the
  `start` field land in `packages/server/src/types.ts` AND `packages/web/src/types.ts`;
  `npm run typecheck` over both catches mirror drift.
- **Costs accepted:** presets carry instructions only, not multi-file skill assets (deferred
  until a workflow needs them); wayfinder is absent from v1; zmrng's committed preset bodies
  drift from the operator's evolving personal Hermes skills (allowed — different audiences).

## Rejected alternatives

- **Seed `.claude/` skill/command files into the chat session** — net-new seeding into a
  surface that has none, for no gain over an inlined preset until a workflow needs file assets.
- **Slash-command passthrough** (`/plan-feature …` injected as the first message) — brittle,
  only works for commands that already exist in the target repo, and the chat session is not
  a worker so `/execute`-style lifecycle commands have nothing to drive.
- **Attach on task creation (or both surfaces)** — the worker pipeline is already a workflow;
  a second selector there conflates the lifecycle with a chat register.
- **Read/symlink the live `~/.hermes` skills at runtime** — breaks the self-contained-harness
  guarantee; couples every install to one machine's profile.
- **Ship all named workflows including wayfinder** — a single conversational claude cannot
  embody a multi-session subagent-spawning workflow; the preset would over-promise.
- **Workflow replaces the style block** — forces users to give up caveman to run a grill; the
  two are orthogonal (D5).
