# GUI workflow presets — grill

**Status:** CLOSED (blanket accept — "go with all your recs", zc, 2026-09-11)
**Date opened:** 2026-09-11
**Driver (zc):** expose our workflows (grill, wayfinder, teach-me, …) directly in the
zmrng GUI — e.g. a workflow dropdown in the chat tab — so users discover/use them
without being taught the harness skills.

## Scope
- IN: how (and whether) to surface named "workflow" presets in the GUI; which surface
  (Chat card / task creation / both); what a "workflow" IS in zmrng terms; ownership +
  source of truth; single-session viability.
- OUT (zc, 2026-09-11): building the grill/wayfinder/teach-me content bodies themselves
  (this grill decides the mechanism + first slice, not the prose); any multi-session
  orchestration engine work; wiring the worker/task pipeline to host workflows.

## Verified baseline (recon 2026-09-11, with file:line)
- **The named workflows don't exist for the zmrng runtime.** grill/wayfinder/teach-me are
  Hermes-agent skills (`~/.hermes/profiles/projects/skills/`), a DIFFERENT agent system
  from the Claude Code `claude` binary zmrng spawns. Not in the harness, not in
  `~/.claude/skills` (which holds canvas-design, caveman, find-skills, frontend-aesthetics,
  ui-ux-pro-max, validation + loose pr/tdd/refactor .md — none of them grill/wayfinder).
- **Harness inventory** (`.claude/`): commands = core_piv_loop {plan-feature, execute,
  prime, prime-frontend, prime-backend}, validation {validate, code-review,
  code-review-fix, execution-report, full-validation, pre-flight, system-review}, git
  {commit, push}. skills = {sync-docs, create-task, caveman}.
- **Harness is seeded into WORKER worktrees only**, not the chat session
  (`worktree.ts:177-240` copies harness/ into each task worktree; `chatAgent.ts:160-167`
  spawns at repo root / projectsDir with no seeding).
- **Two distinct chat surfaces:**
  - `Chat.tsx` — per-task Chat card, talks to a task's `agents` via `api.sendChat`
    (agentResponder). Task-scoped.
  - `ChatCard.tsx` + `ChatPane.tsx` → `/ws/chat` (`chatAgent.ts`) — standalone
    conversational side channel with model/effort/style/repo dropdowns. THIS is the "chat
    tab" the driver means.
- **The mechanism already exists.** `style` dropdown → `styleDirective(style)` inlines a
  register block into the chat system prompt (`chatAgent.ts:32`, `phases.ts:200-208`).
  A workflow preset = same pattern, different directive body. Zero tool round-trips
  (the register is inlined into the prompt, not invoked as a skill — `phases.ts:194-199`).
- **Wire path is fully typed and pure-testable.** `ChatClientMsg.start` carries
  model/effort/style/repoId/voice (`types.ts:554-568`), encoded by `encodeStart`
  (`chatProtocol.ts:16-31`), parsed by `parseChatClientMsg` (`chatAgent.ts:88-127`).
  Tab config persists in `ChatTabMeta` (`types.ts:375-382`) with a manual web mirror in
  `windowTabs.ts` (`ChatTabState`, `setChatTabConfig` Pick, `addChatTab` defaults).
- **The worker ALREADY runs a workflow** — the whole PIV pipeline (plan→execute→validate→
  scan→PR) is the task lifecycle. "Workflow" for a task is not new; it's the pipeline.

## Premise verdict
OVERTURNED. The ask is framed as "surface skills users already have," but those skills
don't exist in zmrng's runtime, and the target surface can't reach even the ones that do.
So the gating question was not "which dropdown UI" — it was **what a zmrng workflow IS**
and **where it attaches**. Recon-first reframed the whole grill before Q1.

## Decisions (locked)

### D1 — A "workflow" is a PROMPT PRESET (named directive block), not seeded files
**Decision:** A zmrng workflow is a named block of instructions appended to the chat
session's system prompt at spawn, structurally identical to `styleDirective`. Add a
`workflowDirective(workflow)` producing the block; append it in `chatSystemPrompt`
alongside `styleDirective` (`chatAgent.ts:24-33`). No `.claude/` skill/command files are
seeded into the chat session; no native skill discovery is involved.
**Why:** The mechanism is already proven and in-repo (`styleDirective`, inlined with zero
tool round-trips, `phases.ts:194-208`). The chat session has NO harness seeded
(`chatAgent.ts:160-167`), so native discovery would be net-new plumbing for no gain. A
preset is self-contained — matches the harness "fresh clone works with no external setup"
principle (CLAUDE.md).
**Cost accepted:** A preset can only carry *instructions*, not multi-file skill assets
(scripts, templates, reference docs). A workflow that genuinely needs those can't be a
pure preset — deferred until one does (none in the first slice, D4).
**Rejected:**
- Seeded skill/command files into the chat session (option b) — net-new seeding into a
  surface that has none; overkill until a workflow needs file assets.
- Slash-command passthrough that injects `/plan-feature …` text (option c) — brittle,
  only works for commands that already exist in the target repo, and the chat session
  isn't a worker so `/execute`-style commands have no lifecycle to drive.

### D2 — Attach to the Chat card (`/ws/chat`) ONLY; leave the worker pipeline alone
**Decision:** Surface workflows as an additive `workflow` dropdown in the Chat card,
next to model/effort/style — in the unlaunched-tab picker (`ChatCard.tsx:103-155`) and
the live config row (`ChatPane.tsx:179-245`), seeded through `ChatTabMeta`/`ChatTabState`
exactly like `style`. Task creation (`NewTaskForm` → worker) is untouched.
**Why:** grill/teach-me are *interactive* workflows that fit a free conversational
side-channel; the worker already runs the full PIV pipeline autonomously, so it needs no
workflow selector. The Chat card is the surface where a named interview loop makes sense.
**Cost accepted:** A user who wants a workflow to *drive a task* (e.g. "wayfinder this
into tickets") won't get it from the chat card — that's the worker's job and is out of
scope here.
**Rejected:**
- Task-creation surface (or both) — the worker pipeline IS already a workflow; adding a
  second selector there conflates the lifecycle with a chat register.

### D3 — zmrng OWNS its own committed copies of workflow content
**Decision:** The preset bodies live in zmrng's own source (in-repo, committed), authored
for zmrng users. They are NOT read from `~/.hermes` at runtime and NOT symlinked to the
operator's personal Hermes skills.
**Why:** Self-contained-harness rule (CLAUDE.md): a fresh clone must work with no external
setup. Runtime dependence on `~/.hermes` would break every non-operator install.
**Cost accepted:** Two loosely-synced copies — the operator's evolving Hermes grill skill
vs zmrng's frozen preset — will drift. Accepted because the audiences differ (zmrng users
≠ the operator) so the bodies are *allowed* to diverge; they are not the same artifact.
**Rejected:**
- Read/symlink the live `~/.hermes` skills — breaks portability; couples every install to
  one machine's profile.

### D4 — Ship only SINGLE-SESSION-VIABLE presets first
**Decision:** First slice ships only presets a single `/ws/chat` claude can actually
*be*: **grill**, **teach-me**, and (candidate) **code-review**. wayfinder and any
multi-session / subagent-spawning workflow are OUT of the first slice.
**Why:** wayfinder spawns subagents and writes plan files across sessions; one
conversational claude cannot embody it, so a "wayfinder" preset would over-promise. grill
and teach-me are self-contained interview loops that fit one session.
**Cost accepted:** The flashiest workflow (wayfinder) is absent from v1; the dropdown
starts small.
**Rejected:**
- Ship all named workflows including wayfinder — a preset that can't deliver its promise
  is worse than its absence.

### D5 — Workflow preset COMPOSES with the style directive (does not replace it)
**Decision:** `workflow` and `style` are orthogonal and both append to the system prompt:
style governs *how narration reads* (caveman register), workflow governs *what the session
does* (interview loop). Default `workflow = 'none'` appends nothing, so today's behavior is
byte-unchanged. (Queued mid-grill under rule 5, ruled here under the blanket accept.)
**Why:** They answer different questions; forcing a choice between "caveman" and "grill"
would be a false exclusivity. The start frame already carries `style`; `workflow` rides
alongside it the same way `voice` does (`types.ts:554-568`).
**Cost accepted:** Two directive blocks concatenated — slightly longer prompt; negligible.
**Rejected:**
- Workflow replaces the style block — would force users to give up caveman to run a grill.

**Follows without a separate ruling**
- **Additive, zero migration.** `workflow?: WorkflowPreset` is an optional field on
  `ChatTabMeta` + its `windowTabs` mirror + the `start` wire frame, defaulting to `'none'`.
  A persisted tab without the field hydrates as `'none'` — no DB/localStorage migration.
- **Both type mirrors change.** Per the no-shared-package rule, the new `WorkflowPreset`
  union + the `start` frame field land in BOTH `packages/server/src/types.ts` and
  `packages/web/src/types.ts`; `npm run typecheck` over both catches drift.
- **Voice surface ignores it.** `voice` sessions use `voiceSystemPrompt` and already
  ignore `style`; they ignore `workflow` the same way (`chatAgent.ts:166`).
- **Server-side home is `chatAgent.ts`, not `phases.ts`.** Because workflows are chat-only
  (D2), `workflowDirective` lives beside `chatSystemPrompt`, not in the worker's `phases.ts`.

## Build sequence
1. **Types (both mirrors).** Add `export type WorkflowPreset = 'none' | 'grill' | 'teach-me' | 'code-review'`
   and a `workflow?: WorkflowPreset` field to `ChatClientMsg.start` + `ChatTabMeta` in
   `packages/server/src/types.ts` AND `packages/web/src/types.ts`. (D1, D2, D5, Follows)
2. **Server directive.** Add `workflowDirective(workflow)` to `chatAgent.ts` (preset
   bodies for grill / teach-me / code-review; `'none'` → `''`), and append it in
   `chatSystemPrompt` after `styleDirective`. Thread `workflow` through `ChatConfig` →
   `ChatManager.create` → `SpawnOptions.systemPrompt`. (D1, D3, D5)
3. **Frame parse/encode.** Extend `parseChatClientMsg` (`chatAgent.ts`) and `encodeStart`
   (`chatProtocol.ts`) to carry the optional `workflow`, defaulting to `'none'`. (Follows)
4. **Web tab state.** Add `workflow` to `NEW_TAB_DEFAULTS`, `addChatTab` defaults,
   `setChatTabConfig` Pick, and `hydrateChatTabs` seed in `windowTabs.ts`. (Follows)
5. **Web UI.** Add the `workflow` `<select>` to the unlaunched picker (`ChatCard.tsx`) and
   the live config row (`ChatPane.tsx`), passing it into `encodeStart` on socket open;
   a live change respawns the session via the existing `resetForConfigChange` path. (D2)
6. **Preset bodies (in-repo, committed).** Author the grill / teach-me / code-review
   directive strings in zmrng's own source — NOT read from `~/.hermes`. (D3, D4)
7. **Tests.** Extend `chatAgent.test.ts` (`parseChatClientMsg` round-trips the new field,
   `chatSystemPrompt` includes/excludes the block per workflow) and any `windowTabs`
   reducer test. `npm run typecheck && lint && test && build`, then `desktop:build`
   (CLAUDE.md app-only rule — a source change isn't shipped until the .app re-bundles).

_Ticketing (`to-tickets`) may re-derive the real blocking edges; steps 1–2 are the root._

## Docs produced
- `docs/adr/0002-gui-workflow-presets.md` — the decision cluster (D1–D5).
- `CONTEXT.md` — glossary terms **Workflow preset**, **Workflow directive**.

## Open decisions (grill queue)
_(empty — all locked under the blanket accept)_
