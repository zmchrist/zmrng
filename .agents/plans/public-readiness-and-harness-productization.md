# Plan: zmrng public-readiness + harness productization

> **Goal:** make zmrng a repo a stranger can clone, run, and be impressed by — and
> that showcases the Projects harness as a *product*, not a personal dotfile.
> **Driver:** `career-guide/outbound-kit/NEXT-STEPS.md` names zmrng public-readiness
> as the single blocker gating the entire AI-engineering outbound push.
> **Author:** zc · **Date:** 2026-07-27

## Feature description

Six workstreams, ordered by leverage. Each is independently shippable as its own
branch + PR; later phases assume earlier ones landed but do not hard-block on them
except where noted.

| # | Workstream | Type | Complexity | Blocks public? |
|---|-----------|------|-----------|----------------|
| 1 | Scrub + genericize | Chore/docs | Low | **Yes — hard blocker** |
| 2 | Harness adoption in worker prompts | Enhancement | Medium | No (but it's the product story) |
| 3 | Verbosity toggle (finish it) | Feature | Low–Medium | No |
| 4 | Native kanban board | Feature | Medium–High | No |
| 5 | Tests + CI | Infra | Medium | **Yes — credibility blocker** |
| 6 | Pluggable agent runner | Architecture | High | No — **scoped separately, may defer** |

**Guiding constraint (operator decision, 2026-07-27):** the target user is
*"someone who may not necessarily have Hermes installed and just has a coding
agent."* Nothing in this plan may add a runtime dependency on Hermes, a gateway,
`~/.hermes/kanban.db`, or any other external daemon. `npm install && npm run dev`
must remain the entire setup story.

## User story

```
As a hiring manager / engineer who found zmrng on GitHub
I want to clone it, understand it in 15 seconds, run it in one command, and see
  a real autonomous task→PR loop with tests proving it works
So that I believe the author can build and operate autonomous agent systems
```

---

## Context: how it works today

Read these before editing anything:

- `packages/server/src/types.ts` — **source of truth** for `TaskStatus`, `CaveStyle`,
  `Task`, `EventPayload`, `WsEvent`. `packages/web/src/types.ts` is a **manual
  mirror**; every type change touches both files or `npm run typecheck` fails.
- `packages/server/src/db.ts` — `SCHEMA` (lines 14–46): `tasks` + `events` tables
  only. `rowToTask` (line 80), `TaskPatch` (line 119), idempotent `ensureColumns()`
  migration.
- `packages/server/src/phases.ts` (675 lines) — the state machine. `systemPrompt()`,
  `clarifyKickoff()`, `planKickoff()`, `executeKickoff()` are the prompt strings that
  encode the workflow. `detect()` drives transitions off control tokens
  (`ZMRNG_READY`, `ZMRNG_PLAN_READY`, `ZMRNG_VALIDATING`, `ZMRNG_BLOCKED`, PR URL).
- `packages/server/src/runner.ts` — `CLAUDE_ARGS_BASE` (~line 125) and the
  `spawn('claude', args, …)` call (~line 167). `ANTHROPIC_API_KEY` is deleted from
  the child env (line ~153).
- `packages/server/src/index.ts` — REST surface. `STYLES` array at line 17;
  `asStyle()` at line 28; `POST /api/tasks` at line 55. **No PATCH route exists.**
- `packages/server/src/config.ts` — `PROJECTS_DIR` default at line 37
  (`~/Documents/Projects`), legacy `ZMRNG_TARGET_REPO` fallback at line 192
  (`~/Documents/Projects/pheme`).
- `packages/web/src/components/NewTaskForm.tsx` — `STYLES` list (lines 32–35),
  `style` state (line 44). Create-time only.
- `packages/web/src/components/TaskDetail.tsx` — `AUTONOMOUS` / `LIVE` / `STOPPABLE`
  status sets (lines 27–47). This is where a live control belongs.
- `packages/web/src/App.tsx` — 2-col grid: `.rail` (TaskList) | `.detail`
  (TaskDetail). A board view is a third layout mode here.

Audit findings that motivate phase 1 (verified 2026-07-27):
- Secrets hygiene is **already clean** — `.env`, `config/repos.json`, `*.db`,
  `.DS_Store` all gitignored; nothing sensitive is tracked. No scrub needed there.
- `README.md:7` says *"v1 drives a single target repo: **Pheme**"*.
- `.agents/plans/zmrng-harness-and-multitarget.md` + `worktree-inside-target-repo.md`
  contain 15+ `Pheme` references and hardcoded `/Users/tiofeliz/...` paths,
  including a `bluebeam` (client) path at `zmrng-harness-and-multitarget.md:178`.
- `CLAUDE.md:80` and `config.ts:37,192` point at `~/Documents/Projects`; the repo
  actually lives under `~/Developer/Projects`. Stale path drift.
- No `LICENSE`, no `.github/`, no CI, no test framework.

---

## Phase 1 — Scrub + genericize (hard blocker)

**Branch:** `chore/zc/public-scrub`

### Changes

1. **`README.md` — apply the outbound-kit rewrite.**
   Source: `career-guide/outbound-kit/zmrng-readme.md` (the fenced markdown block).
   - Lead with the hook + demo placeholder + `docs/demo.gif`.
   - Keep the existing Run / Desktop / Config / Validate sections **verbatim**
     inside the `<details>` block — nothing is lost.
   - Delete the "v1 drives a single target repo: Pheme" line; replace with the
     multi-repo registry description (which is now true).
   - Byline + contact at the bottom.
2. **Sanitize `.agents/plans/*.md`.** These are the paper trail and *should stay* —
   they're evidence of the PIV discipline. Replace concrete client identifiers:
   - `Pheme` → `<target-repo>` / "a target repo" (keep sentences readable).
   - `bluebeam` registry example → a generic `example-app` entry.
   - `/Users/tiofeliz/Documents/Projects/X` → `~/Projects/X`.
   Do **not** rewrite history or delete plans — sanitize in place, one commit.
3. **Fix path drift.**
   - `config.ts:37` — default `ZMRNG_PROJECTS_DIR` to `~/Projects`, and fall back
     through `~/Developer/Projects` → `~/Documents/Projects` if the primary does not
     exist (so existing installs keep working). Document in the README config table.
   - `config.ts:192` — legacy `ZMRNG_TARGET_REPO` fallback: drop the hardcoded
     `pheme` path entirely; if the env var is unset, emit no legacy entry.
   - `CLAUDE.md:80` — point at the actual harness path, and phrase it so the
     inheritance is described generically ("the universal Projects harness one level
     up") rather than as an absolute machine path.
4. **Add `LICENSE`** — MIT, `Copyright (c) 2026 Zachary Christ`.
5. **Add `.github/`:**
   - `workflows/ci.yml` — stub in this phase (typecheck + lint + build on
     push/PR, Node 22, `npm ci`). Tests get added in phase 5.
   - `PULL_REQUEST_TEMPLATE.md` — the canonical 5-item lifecycle checklist
     (Plan / Spec-Tickets / TDD / Review / Validate), matching the one
     career-guide already injects.
   - `ISSUE_TEMPLATE/bug_report.md` + `feature_request.md` — minimal.
6. **`.env.example`** — verify it has no client paths; add the new
   `ZMRNG_PROJECTS_DIR` guidance.
7. **`config/repos.example.json`** — confirm it uses generic paths only.

### Acceptance
- `git grep -in "pheme\|bluebeam"` returns **zero** hits outside `.git/`.
- `git grep -n "/Users/"` returns zero hits in tracked files.
- `LICENSE`, `.github/workflows/ci.yml`, `.github/PULL_REQUEST_TEMPLATE.md` exist.
- `npm run typecheck && npm run lint && npm run build` green.
- A fresh `git clone` + `npm install` + `npm run dev` starts with no config file.

---

## Phase 2 — Harness adoption in worker prompts (the product story)

**Branch:** `feat/zc/harness-lifecycle`
**Depends on:** phase 1 (cosmetic only).

Today `executeKickoff()` runs qa → code-reviewer → doc-updater → typecheck/lint/build.
The current harness (`~/Developer/Projects/CLAUDE.md`, "Hermes Global Rules") mandates
**Plan → Implement + TDD → Code Review → Validate → Sync Docs**, plus branch-only
enforcement and worktree cleanup. zmrng's workers do not do TDD and do not emit the
lifecycle checklist. Closing that gap is what makes "we ship our harness as a
product" a true statement.

### Changes

1. **`phases.ts` — `executeKickoff()`:** insert an explicit TDD step *before*
   implementation:
   - "Write or update tests FIRST (RED), then implement until green (GREEN), then
     refactor. Tests land in the same commit as the source."
   - Make it conditional-tolerant: if the target repo has no test runner, the worker
     says so explicitly in the PR body rather than silently skipping.
2. **`phases.ts` — PR body:** append the 5-item lifecycle checklist to the
   `gh pr create` instruction (use `--body-file` written by the worker rather than
   `--fill`, so the checklist is guaranteed present).
3. **`phases.ts` — `systemPrompt()`:** add the branch-only hard rule and the
   worktree-cleanup rule, phrased for a generic target repo.
4. **`phases.ts` — `planKickoff()`:** add an explicit *grill the approach* step
   before the plan is written (harness rule: "No code before the plan is sharp"),
   and require the plan to name its test strategy.
5. **New `.claude/rules/coding-lifecycle.md`** in zmrng documenting the 5 steps, so
   workers driving *zmrng itself* inherit it via auto-load.
6. **README** — a "The harness" section explaining that the lifecycle is enforced by
   the orchestrator, not by operator discipline. This is the differentiator vs. every
   other "agent runs in a loop" repo.

### Acceptance
- A real task run against a scratch repo produces a PR whose body contains the
  lifecycle checklist and whose diff contains tests.
- `npm run typecheck && npm run lint && npm run build` green.

---

## Phase 3 — Verbosity toggle (finish the existing 60%)

**Branch:** `feat/zc/verbosity-toggle`

`CaveStyle` already exists end-to-end (`types.ts` both sides, `NewTaskForm`,
`index.ts` `STYLES`/`asStyle`, `phases.ts` `styleDirective`). What is missing is
**live** control — style is create-time only.

### Changes

1. **Decide `wenyan-full`'s fate.** It is a classical-Chinese register with no
   explanation anywhere in the repo; in a public repo it reads as a leftover.
   *Recommendation:* keep it but document it in the README style table as a
   deliberate second "register" demonstrating that the verbosity axis is
   pluggable — one sentence turns a wart into a feature. (Operator call.)
2. **Server:** add `PATCH /api/tasks/:id` accepting `{ style?, model?, effort? }`.
   - Validate via existing `asStyle`/`asEffort`.
   - Route through a new `TaskManager.updateControls(id, patch)` so it can decide
     what applies live vs. next-phase: **style applies live** (inject a steer message
     into the running child via the existing `message()` path), model/effort apply to
     the *next* phase spawn only (changing them mid-turn would require a respawn).
   - Emit an `operator` event so the change is visible in the log.
3. **Types:** no new types needed — reuse `CaveStyle`/`EffortLevel`. If a
   `TaskControlsPatch` type is added it goes in **both** `types.ts` files.
4. **Web:** `api.ts` — `updateTask(id, patch)`. `TaskDetail.tsx` — a compact
   segmented control in the header row showing the 5 styles; disabled when the task
   is terminal (`done`/`failed`/`cancelled`). Uses `--status-*`/`--actor-*` tokens
   only — **no hard-coded colors**.
5. **README** — style table: `normal` / `caveman-lite` / `caveman-full` /
   `caveman-ultra` / `wenyan-full`, with the hard carve-out spelled out: *code,
   commits, PR titles/bodies, and plan files are always normal professional English.*
   This carve-out is the reason a novelty feature is safe to ship publicly.

### Acceptance
- Changing style on a running `clarify` task visibly changes the next worker reply's
  register, with no respawn.
- PR bodies and commit messages produced under `caveman-ultra` are still normal English.
- Typecheck catches nothing (mirror stayed in sync); lint + build green.

---

## Phase 4 — Native kanban board

**Branch:** `feat/zc/kanban-board`
**Decision (2026-07-27):** native board inside zmrng, **modeled on Hermes Kanban's
vocabulary**, with **zero** dependency on Hermes. Rejected: reading
`~/.hermes/kanban.db` or requiring a gateway — that makes the repo unrunnable for
the target user. Deferred: an optional Hermes adapter behind a config flag (cheap to
add later precisely because the schema below matches).

### What we borrow from Hermes Kanban (concepts, not code)

| Hermes concept | zmrng mapping |
|---|---|
| Columns `triage/todo/ready/running/blocked/done/archived` | zmrng keeps its own richer phases; adds `archived` |
| `task_links` (parent→child, promote when parents done) | **new** — zmrng has no dependency concept |
| Comments as inter-agent protocol | **new** — zmrng has events but no operator-authored threaded notes |
| `blocked` with a `kind` (`needs_input` / `dependency`) | zmrng has `blocked` but no kind — add one |
| Workspace kinds (`scratch` / `dir:` / `worktree:`) | zmrng is worktree-only; document the choice, don't implement the others |
| Idempotency key | **new** — cheap, enables scripted/cron task creation |

### Changes

1. **`types.ts` (BOTH files):**
   - `TaskStatus` += `'archived'`.
   - `BlockedKind = 'needs_input' | 'dependency' | 'missing_agent'`; `Task.blockedKind:
     BlockedKind | null`, `Task.blockedReason: string | null`.
   - `TaskComment { id, taskId, author, text, ts }`, `author: 'operator' | 'worker'`.
   - `TaskLink { parentId, childId }`.
   - `Task.idempotencyKey: string | null`.
   - `WsEvent` += `{ type: 'comment'; taskId; comment: TaskComment }` and
     `{ type: 'links'; links: TaskLink[] }`.
2. **`db.ts`:** two new tables (`task_comments`, `task_links`) in `SCHEMA`; new
   columns via the existing idempotent `ensureColumns()` path (`blocked_kind`,
   `blocked_reason`, `idempotency_key`). Prepared statements + `rowTo*` mappers.
   **Migration must be non-destructive** — existing `zmrng.db` files keep working.
3. **`phases.ts`:**
   - `ZMRNG_BLOCKED: <reason>` parsing already exists — extend it to accept an
     optional `kind=` param, defaulting to `missing_agent` for back-compat.
   - Promotion rule: a task with unfinished parents cannot leave `backlog`. Enforce
     in `start()`; surface the reason in the UI.
   - `archive(id)` — terminal-only, removes from the active board without deleting rows.
4. **`index.ts`:** `POST /api/tasks/:id/comments`, `GET /api/tasks/:id/comments`,
   `POST /api/tasks/:id/archive`, `POST /api/links`, `DELETE /api/links`.
   `POST /api/tasks` accepts an optional `idempotencyKey` and returns the existing
   task on a repeat.
5. **Web — `BoardView.tsx`:**
   - Columns = phases: `backlog | clarify | planning | executing | validating |
     blocked | review | done`. `archived` and `failed` behind a toggle.
   - Cards show title, repo badge, status dot (`statusColor()`), actor colors, usage.
   - **Drag = intent, not force.** Dropping a card only triggers *legal* transitions
     (backlog→clarify = Start; review→done = Done; blocked→prev = Resume). Illegal
     drops snap back with a toast. The state machine stays authoritative — the board
     is a view, never a second source of truth. This is the single most important
     design constraint in this phase.
   - Comment thread in the card drawer.
   - Dependency arrows between linked cards (simple SVG overlay; skip if it fights
     the layout — links can render as a "blocked by" chip instead).
6. **`App.tsx`:** a Board / List toggle in the brandbar. Board becomes the default
   for >6 tasks. Layout mode is local state (match the existing non-persisted
   `railCollapsed` precedent).
7. **Styling:** columns are frosted panels using `--surface`, `--blur`, `--border`,
   `--radius`. No new hard-coded values; add tokens to `theme.css` if genuinely needed.

### Acceptance
- Board renders all existing tasks with no DB reset (migration is additive).
- Dragging a card to an illegal column is refused and explained.
- A parent→child link keeps the child in `backlog` until the parent hits `done`.
- Comments persist across a server restart and appear in the worker's next kickoff.
- Typecheck green (both mirrors updated); lint; build.

---

## Phase 5 — Tests + CI (credibility blocker)

**Branch:** `feat/zc/test-harness`

A repo whose pitch is *"autonomous agents that self-validate"* currently has **zero
tests**. `CLAUDE.md` even admits "no test framework yet." For the portfolio audience
this is the loudest negative signal on the page, and phase 2 tells workers to do TDD
in repos where zmrng itself doesn't. Fix the hypocrisy.

### Changes

1. **Vitest** in both workspaces (`packages/server`, `packages/web`). Chosen over
   Jest: native ESM, no transform config, Vite already present for web.
2. **Server unit tests — the high-value, pure-function surface:**
   - `phases.ts`: `parsePlanDecision()` (valid/invalid/missing params), control-token
     regexes (`READY_RE`, `PLAN_READY_RE`, `VALIDATING_RE`, `BLOCKED_RE`, `PR_RE`) —
     including the near-miss cases that must NOT match.
   - `runner.ts`: `summarizeTool()`, `summarizeResult()`, `parseUsage()`,
     `assistantText()`, `partialDelta()` — feed them real captured stream-json lines.
   - `db.ts`: open an in-memory/temp SQLite db, assert `ensureColumns()` is idempotent
     and that `addUsage()` accumulates atomically.
   - `config.ts`: registry precedence (repos.json → env → legacy) and auto-scan.
3. **A state-machine test** driving `TaskManager` with a **fake runner** (inject the
   Runner factory) — feed it scripted stream-json lines and assert the full
   backlog→clarify→planning→executing→validating→review path, plus the blocked and
   lane-queue paths. This is the test that actually proves the product works and is
   the one worth showing a reviewer.
   - Requires a small refactor: `TaskManager` takes a runner factory in its
     constructor (default = the real `Runner`). Keep the change minimal.
4. **Web tests:** `status.ts` helpers; a render smoke test for `TaskList` and
   `BoardView` via `@testing-library/react`.
5. **Root scripts:** `npm test` (both workspaces), `npm run test:watch`.
6. **`.github/workflows/ci.yml`:** matrix Node 22, `npm ci`, then
   `typecheck → lint → test → build`. Required check on `main`.
7. **Update `CLAUDE.md`** — remove "no test framework yet"; validation is now
   `typecheck && lint && test && build`. Update the Commands section, and
   `.claude/rules/testing.md`.
8. **README** — a test/CI badge. This is the visible proof.

### Acceptance
- `npm test` green locally and in CI on a PR.
- Coverage is not a gate, but the state-machine test must cover every
  `TaskStatus` transition that has a control token.
- No test spawns a real `claude` process or touches the network.

---

## Phase 6 — Pluggable agent runner (scoped separately; may defer)

**Branch:** `feat/zc/pluggable-runner`
**Status:** scoped here, **not committed to**. Decide after phases 1–5 land.

### The problem
`runner.ts` hardcodes `spawn('claude', …)` with Claude-specific flags
(`--output-format stream-json`, `--effort`, `--append-system-prompt`,
`--dangerously-skip-permissions`) and Claude-specific stream parsing. The stated
target user "just has a coding agent" — which today means Claude Code, **Codex**, or
**OpenCode**. Without this, zmrng's audience is exactly "people with a Claude Max
subscription," which is a much smaller pool than the outbound pitch assumes.

### Shape
1. `AgentAdapter` interface: `buildArgs(opts)`, `parseLine(json) → NormalizedEvent`,
   `encodeUserTurn(text)`, `encodeInterrupt()`, `capabilities { effort, partials,
   subagents, interrupt }`.
2. `adapters/claude.ts` — extract the current behavior **verbatim** first, prove the
   test suite from phase 5 still passes, *then* add others. Do not write the second
   adapter before the first is extracted and green.
3. `adapters/codex.ts`, `adapters/opencode.ts` — behind capability flags; features
   the adapter can't do are hidden in the UI rather than failing at runtime.
4. Config: `ZMRNG_AGENT=claude|codex|opencode`, per-task override in the registry.
5. The control-token contract (`ZMRNG_*`) is adapter-agnostic by design — it's just
   text in the output stream. That's what makes this tractable.

### Why it's last
It is the only phase that can destabilize the core loop, it has the widest blast
radius, and it is worthless without phase 5's tests to catch regressions. It is also
the phase most likely to be cut — "v1 targets Claude Code; adapter interface in
progress" is an acceptable public README line.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Kanban drag becomes a second source of truth and desyncs from `phases.ts` | Board is read-only over state; drags map to existing REST verbs, illegal drops refused |
| DB migration breaks the operator's live `zmrng.db` | All new columns via the existing idempotent `ensureColumns()`; new tables via `CREATE TABLE IF NOT EXISTS`; back up `zmrng.db` before first run of phase 4 |
| Type-mirror drift (no shared package) | Every phase touching types edits **both** `types.ts` files in the same commit; `npm run typecheck` is the gate |
| Phase 2 prompt changes degrade real worker runs | Change prompts behind a real end-to-end run against a scratch repo before merging; keep the diff to prompt strings so it is trivially revertible |
| Phase 6 destabilizes the loop | Gated behind phase 5's tests; extract-then-extend; may be cut entirely |
| Scrubbing plans destroys useful history | Sanitize in place, never delete; no history rewrite |

## Out of scope

- Merging or auto-pushing to `main` — unchanged, zmrng opens PRs only.
- Multi-user / auth / hosted mode. Single-operator, localhost, by design.
- Syncing to Hermes Kanban, Obsidian, Linear, or Jira.
- Windows/Linux desktop builds (Tauri shell stays macOS-targeted for now).
- Replacing the frosted-glass theme.

## Validation (every phase)

```bash
npm run typecheck && npm run lint && npm run build   # phases 1–4
npm run typecheck && npm run lint && npm test && npm run build   # phase 5+
```

**App-only rule (`CLAUDE.md`):** any phase touching `packages/server` or
`packages/web` is **not done** until `npm run desktop:build` produces a fresh `.app`.
`npm run build` alone only refreshes the browser view; the shipped `.app` carries a
stale bundled copy of `server/dist` + `web/dist` until re-bundled.

## Suggested execution order

1. Phase 1 (scrub) — small, unblocks everything, safe to merge same day.
2. Phase 5 (tests) — **pull forward**, before 2/3/4. Every later phase is safer with
   a suite behind it, and phase 2 tells workers to do TDD, which is not credible
   while zmrng has none.
3. Phase 2 (harness) — the product story.
4. Phase 3 (verbosity) — small, visible, good Loom material.
5. Phase 4 (kanban) — largest UI surface; best demoed last when the rest is stable.
6. Phase 6 (pluggable runner) — decide after 1–5.

Then: record the Loom from `career-guide/outbound-kit/zmrng-loom-script.md`, add
`docs/demo.gif`, flip the repo public, and unblock the outbound sequence in
`career-guide/outbound-kit/NEXT-STEPS.md`.
