# Plan: zmrng public-readiness + harness productization

> **Goal:** make zmrng a repo a stranger can clone, run, and be impressed by — and
> that showcases the Projects harness as a *product*, not a personal dotfile.
> **Driver:** `career-guide/outbound-kit/NEXT-STEPS.md` names zmrng public-readiness
> as the single blocker gating the entire AI-engineering outbound push.
> **Author:** zc · **Date:** 2026-07-27 · **Rev 2** (post-grill)

## Guiding constraint

The target user is *"someone who may not necessarily have Hermes installed and just
has a coding agent"* (operator, 2026-07-27). Nothing here may add a runtime dependency
on Hermes, a gateway, `~/.hermes/kanban.db`, or any other daemon.
`npm install && npm run dev` must remain the entire setup story.

## User story

```
As a hiring manager / engineer who found zmrng on GitHub
I want to clone it, understand it in 15 seconds, run it in one command, and see
  a real autonomous task→PR loop with tests proving it works
So that I believe the author can build and operate autonomous agent systems
```

## Phases

| # | Workstream | Type | Complexity | Gates public? |
|---|-----------|------|-----------|----------------|
| 1 | Scrub + genericize | Chore | Low | **Yes** |
| 2 | Tests + CI | Infra | Medium | **Yes** |
| 3 | Harness adoption in worker prompts | Enhancement | Medium | No |
| 4 | Verbosity toggle (finish it) | Feature | Low | No |
| 5 | Native kanban board | Feature | Medium | No |
| 6 | Public launch (README, demo.gif, flip) | Docs/Release | Low | **Yes** |
| A | *Appendix:* pluggable agent runner | Architecture | High | No — **not committed** |

Execution order is the phase order. Tests are phase 2 deliberately: phase 3 tells
workers to do TDD, which is not credible while zmrng has none, and every later phase
is safer with a suite behind it.

---

## Context: how it works today

Read these before editing anything:

- `packages/server/src/types.ts` — **source of truth** for `TaskStatus`, `CaveStyle`,
  `Task`, `EventPayload`, `WsEvent`. `packages/web/src/types.ts` is a **manual
  mirror**; every type change touches both files or `npm run typecheck` fails.
- `packages/server/src/db.ts` — `SCHEMA` (lines 14–46): `tasks` + `events` only.
  `rowToTask` (line 80), `TaskPatch` (line 119), idempotent `ensureColumns()`.
- `packages/server/src/phases.ts` (675 lines) — the state machine. `systemPrompt()`,
  `clarifyKickoff()`, `planKickoff()`, `executeKickoff()` encode the workflow as
  prompt strings. `detect()` drives transitions off control tokens (`ZMRNG_READY`,
  `ZMRNG_PLAN_READY`, `ZMRNG_VALIDATING`, `ZMRNG_BLOCKED`, PR URL). `styleDirective()`
  + the style→skill map live at lines ~60–90.
- `packages/server/src/runner.ts` — `CLAUDE_ARGS_BASE` (~line 125), `spawn('claude',
  args, …)` (~line 167), `delete env.ANTHROPIC_API_KEY` (~line 153).
- `packages/server/src/index.ts` — REST surface. `STYLES` (line 17), `asStyle()`
  (line 28), `POST /api/tasks` (line 55). **No PATCH route exists.**
- `packages/server/src/config.ts` — `PROJECTS_DIR` default line 37
  (`~/Documents/Projects`), legacy `ZMRNG_TARGET_REPO` fallback line 192
  (`~/Documents/Projects/pheme`).
- `packages/web/src/components/NewTaskForm.tsx` — `STYLES` (32–35), `style` state
  (line 44). Create-time only.
- `packages/web/src/components/TaskDetail.tsx` — `AUTONOMOUS`/`LIVE`/`STOPPABLE` sets
  (27–47). Live controls belong here.
- `packages/web/src/App.tsx` — 2-col grid: `.rail` (TaskList) | `.detail` (TaskDetail).
  A board is a third layout mode here.

Audit findings, verified 2026-07-27:
- Secrets hygiene is **already clean** — `.env`, `config/repos.json`, `*.db`,
  `.DS_Store` gitignored; nothing sensitive tracked. No secret scrub needed.
- `README.md:7` says *"v1 drives a single target repo: **Pheme**"*.
- `.agents/plans/zmrng-harness-and-multitarget.md` + `worktree-inside-target-repo.md`
  hold 15+ `Pheme` references and hardcoded `/Users/tiofeliz/…` paths, including a
  client `bluebeam` path (`zmrng-harness-and-multitarget.md:178`).
- `CLAUDE.md:80` and `config.ts:37,192` point at `~/Documents/Projects`; the repo
  actually lives under `~/Developer/Projects`. Stale path drift.
- `wenyan-full` appears at exactly 6 sites: `server/types.ts:25`, `server/index.ts:22`,
  `server/phases.ts:69,80`, `web/types.ts:25`, `web/NewTaskForm.tsx:35`.
- No `LICENSE`, no `.github/`, no CI, no test framework.

---

## Phase 1 — Scrub + genericize

**Branch:** `chore/zc/public-scrub`

**Grill note:** the original plan put the full hiring-facing README rewrite here.
Rejected — that README advertises tests, a harness story, and a board that do not
exist until phases 2–5. It would ship a README that lies for weeks and then be
rewritten four more times. Phase 1 makes the README *true*; phase 6 makes it *sell*.

### Changes

1. **`README.md` — truth-fix only.** Delete the "v1 drives a single target repo:
   Pheme" line; replace with the multi-repo registry description (which is now
   accurate). Add a note that each target repo should gitignore its own `worktrees/`.
   No structural rewrite yet.
2. **Sanitize `.agents/plans/*.md`.** These stay — they are the paper trail and the
   evidence of PIV discipline. Sanitize **in place**, one commit, no deletions, no
   history rewrite:
   - `Pheme` → `<target-repo>` / "a target repo" (keep sentences readable)
   - `bluebeam` registry example → a generic `example-app` entry
   - `/Users/tiofeliz/Documents/Projects/X` → `~/Projects/X`
3. **Fix path drift.**
   - `config.ts:37` — default `ZMRNG_PROJECTS_DIR` to the first of
     `~/Projects` → `~/Developer/Projects` → `~/Documents/Projects` that exists,
     so current installs keep working. Document in the README config table.
   - `config.ts:192` — drop the hardcoded `pheme` legacy path; if
     `ZMRNG_TARGET_REPO` is unset, emit no legacy entry at all.
   - `CLAUDE.md:80` — describe the inheritance generically ("the universal Projects
     harness one level up"), not as an absolute machine path.
4. **`LICENSE`** — MIT, `Copyright (c) 2026 Zachary Christ`.
5. **`.github/`:**
   - `workflows/ci.yml` — `ubuntu-latest`, Node 22, `npm ci`, then
     `typecheck → lint → build`. Tests join in phase 2.
     **Do not build the Tauri `.app` in CI** — Rust toolchain + macOS runner cost for
     zero signal. Desktop bundling stays a local pre-merge step (see Validation).
   - `PULL_REQUEST_TEMPLATE.md` — the canonical 5-item lifecycle checklist
     (Plan / Spec-Tickets / TDD / Review / Validate), matching career-guide's.
   - `ISSUE_TEMPLATE/bug_report.md` + `feature_request.md` — minimal.
6. **`.env.example`** — no client paths; document the new `ZMRNG_PROJECTS_DIR`
   resolution order.
7. **`config/repos.example.json`** — generic paths only.

### Acceptance
- `git grep -in "pheme\|bluebeam"` → zero hits in tracked files.
- `git grep -n "/Users/"` → zero hits in tracked files.
- `LICENSE`, `.github/workflows/ci.yml`, `.github/PULL_REQUEST_TEMPLATE.md` exist.
- CI green on the PR.
- A fresh clone + `npm install` + `npm run dev` starts with no config file present.

---

## Phase 2 — Tests + CI

**Branch:** `feat/zc/test-harness`

A repo pitching *"autonomous agents that self-validate"* has **zero tests**;
`CLAUDE.md` admits "no test framework yet." For the portfolio audience that is the
loudest negative signal on the page. Fix it before phase 3 tells workers to do TDD.

**Grill note:** the original plan proposed injecting mocks for the whole world.
Rejected. Only the `Runner` is faked; git runs for real against a temp repo. Mocking
git would test the mock, and worktree/branch behavior is exactly the part worth
proving. A temp git repo costs ~50ms.

### Changes

1. **Vitest** in both workspaces. Over Jest: native ESM, no transform config, Vite
   already present for web.
2. **Server unit tests — the pure-function surface:**
   - `phases.ts`: `parsePlanDecision()` (valid / invalid / missing params) and every
     control-token regex (`READY_RE`, `PLAN_READY_RE`, `VALIDATING_RE`, `BLOCKED_RE`,
     `PR_RE`) — **including near-miss cases that must NOT match** (a token quoted
     inside prose, a PR URL for a different repo, trailing whitespace).
   - `runner.ts`: `summarizeTool()`, `summarizeResult()`, `parseUsage()`,
     `assistantText()`, `partialDelta()` — fed real captured stream-json lines
     checked in as fixtures.
   - `db.ts`: temp-file SQLite; assert `ensureColumns()` is idempotent across two
     runs and `addUsage()` accumulates atomically.
   - `config.ts`: registry precedence (repos.json → env → legacy) + auto-scan.
3. **The state-machine test** — the one worth showing a reviewer. Drive `TaskManager`
   with a **fake runner** over a **real temp git repo**:
   - Refactor: `TaskManager` takes an optional runner factory (default = real
     `Runner`). Minimal seam, one constructor param. *This seam is also what makes
     the appendix (pluggable adapters) cheap later — build it with that in mind.*
   - `git init` a temp repo with one commit as the target; let `createWorktree` /
     `removeWorktree` run for real.
   - Feed scripted stream-json lines; assert the full
     backlog→clarify→planning→executing→validating→review path, plus `blocked`,
     the lane cap + queue, and `interrupt()` suppressing the failure path.
   - `gh pr create` never runs — the PR URL arrives as a scripted assistant line.
4. **Web tests:** `status.ts` helpers; render smoke tests for `TaskList` and (once it
   exists) `BoardView` via `@testing-library/react`.
5. **Root scripts:** `npm test`, `npm run test:watch`.
6. **`.github/workflows/ci.yml`** gains the `test` step; make it a required check on
   `main`.
7. **`CLAUDE.md`** — remove "no test framework yet"; validation becomes
   `typecheck && lint && test && build`. Update Commands and `.claude/rules/testing.md`.
8. **README** — CI badge. The visible proof.

### Acceptance
- `npm test` green locally and in CI.
- Coverage is not a gate, but the state-machine test covers **every `TaskStatus`
  transition that has a control token**.
- No test spawns a real `claude` process, calls `gh`, or touches the network.

---

## Phase 3 — Harness adoption in worker prompts

**Branch:** `feat/zc/harness-lifecycle`

`executeKickoff()` today runs qa → code-reviewer → doc-updater → typecheck/lint/build.
The current harness (`~/Developer/Projects/CLAUDE.md`, "Hermes Global Rules") mandates
**Plan → Implement + TDD → Code Review → Validate → Sync Docs**, plus branch-only
enforcement and worktree cleanup. Closing that gap is what makes *"we ship our harness
as a product"* a true statement rather than a claim.

### Changes

1. **`executeKickoff()`** — insert an explicit TDD step *before* implementation:
   RED (write/update tests) → GREEN (implement) → REFACTOR, tests landing in the same
   commit as the source. Tolerant: if the target repo has no test runner, the worker
   must say so **explicitly in the PR body** rather than silently skipping.
2. **PR body** — switch `gh pr create --fill` to `--body-file` written by the worker,
   so the 5-item lifecycle checklist is guaranteed present rather than hoped for.
3. **`systemPrompt()`** — add the branch-only hard rule and the worktree-cleanup rule,
   phrased for a generic target repo.
4. **`planKickoff()`** — add an explicit *grill the approach* step before the plan is
   written ("no code before the plan is sharp") and require the plan to name its test
   strategy.
5. **New `.claude/rules/coding-lifecycle.md`** in zmrng, so workers driving *zmrng
   itself* inherit the 5 steps via auto-load.
6. **README** — a "The harness" section: the lifecycle is enforced by the
   orchestrator, not by operator discipline. This is the differentiator against every
   other "agent in a loop" repo.

### Acceptance
- One real task run against the sandbox repo (below) produces a PR whose body contains
  the lifecycle checklist and whose diff contains tests.
- **Sandbox:** a private throwaway repo `zmchrist/zmrng-e2e-sandbox` — a real remote is
  required because this phase's whole point is exercising `gh pr create`. Registered in
  local `config/repos.json` only; never committed.
- Full validation green.

---

## Phase 4 — Verbosity toggle

**Branch:** `feat/zc/verbosity-toggle`

`CaveStyle` already exists end-to-end (`types.ts` both sides, `NewTaskForm`,
`index.ts` `STYLES`/`asStyle`, `phases.ts` `styleDirective`). What is missing is
**live** control — style is create-time only.

### Changes

1. **Remove `wenyan-full`** (operator decision, 2026-07-27: *"strangers don't need
   wenyan"*). Six sites: `server/types.ts:25`, `server/index.ts:22`,
   `server/phases.ts:69,80`, `web/types.ts:25`, `web/NewTaskForm.tsx:35`. Add a
   `ensureColumns`-adjacent read-side guard: existing DB rows carrying
   `style='wenyan-full'` must degrade to `'normal'` on load rather than throwing —
   `rowToTask` already coerces, verify it does. Shipping list becomes
   `normal | caveman-lite | caveman-full | caveman-ultra`.
2. **Server:** `PATCH /api/tasks/:id` accepting `{ style?, model?, effort? }`,
   validated via the existing `asStyle`/`asEffort`. Routes through a new
   `TaskManager.updateControls(id, patch)`.
   - **model / effort apply to the next phase spawn only** — changing them mid-turn
     would require a respawn.
   - **style applies live**, via a one-shot steer message on the existing `message()`
     path. **Grill note / required investigation:** the style directive currently
     lives in `--append-system-prompt`, fixed at spawn. A steer message is a weaker
     mechanism *and* risks polluting the transcript handed to the next phase's
     kickoff. Before implementing, read how `planKickoff`'s `transcript` is
     assembled in `phases.ts` and **exclude operator-steer messages from it**. If
     that exclusion turns out to be messy, fall back to next-spawn-only and label the
     control "applies from next phase" — correctness beats immediacy here.
   - Emit an `operator` event so the change is visible in the log.
3. **Types:** reuse `CaveStyle`/`EffortLevel`. Any new `TaskControlsPatch` goes in
   **both** `types.ts` files, same commit.
4. **Web:** `api.ts` → `updateTask(id, patch)`. `TaskDetail.tsx` → a compact segmented
   control in the header row; disabled on terminal statuses (`done`/`failed`).
   `--status-*` / `--actor-*` tokens only, **no hard-coded colors**.
5. **README** — style table with the hard carve-out spelled out: *code, commit
   messages, PR titles/bodies, and plan files are always normal professional English.*
   That carve-out is the reason a novelty feature is safe to ship publicly.

### Acceptance
- Changing style on a running `clarify` task changes the next worker reply's register
  with no respawn — **or** the control is honestly labeled next-phase-only.
- PR bodies and commit messages produced under `caveman-ultra` are still normal English.
- No `wenyan` hits in tracked files; a pre-existing task row with the old value loads.

---

## Phase 5 — Native kanban board

**Branch:** `feat/zc/kanban-board`

**Decision (2026-07-27):** native board inside zmrng, **modeled on Hermes Kanban's
vocabulary**, **zero** dependency on Hermes. Rejected: reading `~/.hermes/kanban.db`
or requiring a gateway — that makes the repo unrunnable for the target user. Deferred:
an optional Hermes adapter behind a config flag, cheap later precisely because the
vocabulary matches.

**Grill note — scope cut.** The original plan borrowed `task_links` (parent→child
dependencies, promotion on parent completion, SVG dependency arrows) and
`idempotencyKey`. **Both are cut from v1.** Nobody has asked for dependencies between
zmrng tasks, and zmrng tasks are independent by construction — each owns its own
worktree and branch. A real dependency feature has to answer "does the child rebase
onto the parent's branch?", which is a design question, not a UI question. Half of it
is worse than none. That also settles the dependency-arrow question by deletion:
**no arrows, no chips, no links** — the honest answer. Logged to
`.claude/files/FUTURE_IDEAS.md` instead. Same for idempotency keys: no scripted task
creation exists yet to need them.

### What we borrow (concepts, not code)

| Hermes concept | zmrng v1 |
|---|---|
| Column model | zmrng's own richer phases; adds `archived` |
| `blocked` with a `kind` | **adopt** — zmrng has `blocked` but no kind |
| Comments as the inter-agent protocol | **adopt** — zmrng has events but no operator-authored notes |
| `task_links` / dependencies | **cut from v1** → FUTURE_IDEAS |
| Idempotency key | **cut from v1** → FUTURE_IDEAS |
| Workspace kinds (`scratch`/`dir:`/`worktree:`) | zmrng is worktree-only; document the choice, don't implement |

### Changes

1. **`types.ts` (BOTH files):**
   - `TaskStatus` += `'archived'`. **Every exhaustive consumer must be updated in the
     same commit** — `statusColor()`, `STATUS_LABEL`, the `AUTONOMOUS`/`LIVE`/
     `STOPPABLE` sets in `TaskDetail.tsx`, and the legacy `building` handling.
   - `BlockedKind = 'needs_input' | 'dependency' | 'missing_agent'`;
     `Task.blockedKind: BlockedKind | null`, `Task.blockedReason: string | null`.
   - `TaskComment { id, taskId, author: 'operator' | 'worker', text, ts }`.
   - `WsEvent` += `{ type: 'comment'; taskId; comment: TaskComment }`.
2. **`db.ts`:** one new table (`task_comments`) via `CREATE TABLE IF NOT EXISTS`; new
   columns (`blocked_kind`, `blocked_reason`) via the existing idempotent
   `ensureColumns()`. **Non-destructive** — existing `zmrng.db` files keep working.
   Back up `zmrng.db` before the first local run.
3. **`phases.ts`:**
   - Extend `ZMRNG_BLOCKED: <reason>` parsing to accept an optional `kind=` param,
     defaulting to `missing_agent` for back-compat with in-flight tasks.
   - `archive(id)` — terminal statuses only; removes from the active board without
     deleting rows.
   - Operator comments are appended to the next phase kickoff so the worker sees them.
4. **`index.ts`:** `GET|POST /api/tasks/:id/comments`, `POST /api/tasks/:id/archive`.
5. **Web — `BoardView.tsx`:**
   - Columns: `backlog | clarify | planning | executing | validating | blocked |
     review | done`. `archived` and `failed` behind a toggle.
   - Cards: title, repo badge, status dot (`statusColor()`), actor colors, usage.
   - **Drag = intent, not force.** A drop fires an existing REST verb only when the
     transition is legal (backlog→clarify = Start, review→done = Done, blocked→prior =
     Resume, done→archived = Archive). Illegal drops snap back with a toast.
     `phases.ts` stays authoritative; the board is a view, never a second source of
     truth. **This is the single most important design constraint in this phase.**
   - Comment thread in the card drawer.
6. **`App.tsx`:** Board / List toggle in the brandbar. **Board is the default** —
   it is the better demo and the reason this phase exists. Persist the choice in
   `localStorage` (a layout mode is worth persisting; this deliberately differs from
   the non-persisted `railCollapsed`). No auto-switching on task count — surprising
   layout changes are worse than a wrong-but-stable default.
7. **Styling:** columns are frosted panels using `--surface`, `--blur`, `--border`,
   `--radius`. No hard-coded values; add tokens to `theme.css` if genuinely needed.

### Acceptance
- Board renders all existing tasks with **no DB reset** (migration is additive).
- Dragging a card to an illegal column is refused and explained.
- Comments persist across a server restart and appear in the worker's next kickoff.
- A task blocked with `kind=needs_input` is visually distinct from `missing_agent`.

---

## Phase 6 — Public launch

**Branch:** `docs/zc/public-launch`

Everything the README will claim is now true. Only now does it get to sell.

1. **Apply the outbound-kit README rewrite** — source:
   `career-guide/outbound-kit/zmrng-readme.md` (the fenced block). Hook → demo →
   architecture → engineering signals on top; existing Run / Desktop / Config /
   Validate sections preserved **verbatim** inside the `<details>` block. Byline +
   contact at the bottom.
2. **`docs/demo.gif`** — 10–15s loop of a task going to PR, recorded from the `.app`.
3. **Record the Loom** from `career-guide/outbound-kit/zmrng-loom-script.md`; drop the
   link at the top of the README.
4. **Final sweep:** re-run the phase 1 grep gates; confirm CI badge is green; confirm
   `npm run desktop:build` produces a fresh `.app` from a clean clone.
5. **Flip the repo public.**
6. **Update `career-guide/outbound-kit/NEXT-STEPS.md`** — mark the blocker cleared and
   unblock the outbound sequence (Loom → profiles → 10 DMs).

---

## Appendix A — Pluggable agent runner (not committed)

**Grill note:** this was phase 6 in rev 1 with a stated ~60% chance of being cut.
Keeping a committed phase we expect to cut invites scope creep, so it is demoted to an
appendix. Decide after phases 1–6 land.

`runner.ts` hardcodes `spawn('claude', …)` with Claude-specific flags
(`--output-format stream-json`, `--effort`, `--append-system-prompt`,
`--dangerously-skip-permissions`) and Claude-specific stream parsing. "Someone who just
has a coding agent" today means Claude Code, **Codex**, or **OpenCode** — so without
this, the real audience is "people with a Claude Max subscription," a much smaller pool
than the outbound pitch assumes. That is a real limitation and the README should say so
plainly rather than imply otherwise: *"v1 targets Claude Code; an adapter interface is
in progress."*

Shape, if built:
1. `AgentAdapter`: `buildArgs(opts)`, `parseLine(json) → NormalizedEvent`,
   `encodeUserTurn(text)`, `encodeInterrupt()`, `capabilities { effort, partials,
   subagents, interrupt }`.
2. `adapters/claude.ts` — extract current behavior **verbatim**, prove phase 2's suite
   still passes, *then* add others. Never write the second adapter before the first is
   extracted and green.
3. `adapters/codex.ts`, `adapters/opencode.ts` — capability-gated; features an adapter
   cannot do are hidden in the UI rather than failing at runtime.
4. `ZMRNG_AGENT=claude|codex|opencode`, per-task override in the registry.
5. The `ZMRNG_*` control-token contract is already adapter-agnostic — it is just text
   in the output stream. That is what makes this tractable at all.

Phase 2's runner-factory seam is the enabling refactor; it is built regardless.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Board drag becomes a second source of truth and desyncs from `phases.ts` | Board is a view over state; drags map to existing REST verbs; illegal drops refused |
| DB migration breaks the operator's live `zmrng.db` | Additive only — `CREATE TABLE IF NOT EXISTS` + idempotent `ensureColumns()`; back up before first run of phase 5 |
| Removing `wenyan-full` breaks existing task rows | Read-side coercion to `'normal'`; covered by a phase 4 test |
| Type-mirror drift (no shared package) | Every type change edits **both** `types.ts` files in one commit; `npm run typecheck` is the gate |
| Phase 3 prompt changes degrade real worker runs | Verified by a real end-to-end run against the sandbox repo before merge; diff confined to prompt strings, so revert is trivial |
| `TaskStatus += 'archived'` misses an exhaustive consumer | Enumerated in phase 5 step 1; `npm run typecheck` catches the rest |
| Sanitizing plans destroys useful history | Sanitize in place, never delete; no history rewrite |
| README claims outrun reality | README rewrite deferred to phase 6, after every claim is true |

## Out of scope

- Merging or auto-pushing to `main` — unchanged, zmrng opens PRs only.
- Multi-user / auth / hosted mode. Single-operator, localhost, by design.
- Syncing to Hermes Kanban, Obsidian, Linear, or Jira.
- Task dependencies / links (→ FUTURE_IDEAS), idempotency keys (→ FUTURE_IDEAS).
- Windows/Linux desktop builds (Tauri shell stays macOS-targeted).
- Replacing the frosted-glass theme.

## Validation (every phase)

```bash
npm run typecheck && npm run lint && npm run build            # phase 1
npm run typecheck && npm run lint && npm test && npm run build # phase 2+
```

**App-only rule (`CLAUDE.md`):** any phase touching `packages/server` or
`packages/web` is **not done** until `npm run desktop:build` produces a fresh `.app`.
`npm run build` alone only refreshes the browser view; the shipped `.app` carries a
stale bundled copy of `server/dist` + `web/dist` until re-bundled. This is a **local
pre-merge step** — CI deliberately does not build the `.app` (Rust toolchain + macOS
runner cost, zero added signal over the local build).
