# CLAUDE.md — zmrng

## What this is
**zmrng** is an autonomous task-orchestrator GUI. You drop in a task, answer a few
clarifying questions, then watch a Claude Code worker **plan → implement → validate →
open a PR** fully autonomously. One GUI replaces babysitting several terminals.

Each task spawns one long-lived headless `claude` process (the operator's **Max OAuth**
login) inside a dedicated git worktree of a *target* repo, and streams its events to a
React frosted-glass UI over WebSocket. Targets are chosen per task from a configured
repo registry; v1 drove a single hardcoded repo.

```
backlog ─Start─▶ clarify ─READY─▶ planning ─PLAN_READY─▶ executing ─VALIDATING─▶ validating ─PR url─▶ review ─Done─▶ done
                (you answer Qs)   └─────── full auto: plan → implement → QA/review/docs, no stops ───────┘      (review on GitHub)
```
A worker that needs a missing subagent emits `ZMRNG_BLOCKED: <reason>` and parks in `blocked` until the operator resumes it. `building` is a legacy single-phase status, retained only for old DB rows/events.

**Security-scan gate (a `validating` sub-step, NOT a new phase).** Between `validating`
and the PR there is a deterministic security scan. The worker no longer pushes/opens the
PR from its execute tail — it commits on the branch and emits `ZMRNG_SCAN_READY`, then
waits. The orchestrator runs a fixed scanner (semgrep SAST + osv-scanner SCA), machine-
asserts the verdict, and only then drives the outcome: **green** → sends the extracted
`openPrKickoff` into the same live session (→ PR url → `review`, unchanged); **red** →
sends `securityFixKickoff` and the worker iterates (bounded by `maxRounds`), re-emitting
`ZMRNG_SCAN_READY` each round; **rounds exhausted** → `blocked`; **any scanner error /
unparseable output** → fail-closed (treated as red, never a pass). The task **stays in
`validating`** the whole time — there is deliberately no `scanning` status/pill (D6). The
execute lane is freed *before* the scan runs so the deterministic machine work doesn't
idle a lane (D3). Per-repo policy via the optional `security` block in the repo registry;
scans persist to the additive `security_scans` table and surface read-only in the web
Security panel. Full contract + decisions: `.claude/docs/services-reference.md` and
`docs/adr/0001-deterministic-security-scan-gate.md`.

## ⚠️ App-only focus (operator directive)
**All work in this directory targets the desktop APP (`packages/desktop` Tauri shell),
not the browser "website".** There is one codebase — `packages/web` is the app's
frontend and `packages/server` is bundled as the app's sidecar — so every source change
is *for the app*. The trap: editing source updates the dev/browser view, but the shipped
`.app` carries a **stale bundled copy** of `server/dist` + `web/dist` until it is
re-bundled and re-built. **Any change is not "done" until the app is rebuilt:**
```bash
npm run desktop:build     # build → bundle:sidecar → tauri build → fresh .app
```
Never consider a task complete after `npm run build` alone — that only refreshes the
website. Always finish by re-bundling the app so the `.app` ships the new code.

## Tech stack
- **Monorepo:** npm workspaces (`packages/server`, `packages/web`) — **no shared package**
- **Backend:** Fastify 5 + `@fastify/websocket` + `ws`, Pino logging
- **Database:** SQLite (WAL mode) via better-sqlite3 — single `zmrng.db`
- **Engine:** Node `child_process` spawning the headless `claude` binary (stream-json)
- **Terminal:** `node-pty` PTY sessions over `GET /ws/terminal` + `@xterm/xterm`, surfaced
  as the Workspace grid's Terminal card
- **Frontend:** React 19 + Vite, CSS Modules + design tokens (frosted-glass theme)
- **Language:** TypeScript throughout (ESM, `NodeNext`/`bundler` resolution)
- **No cloud.** Tests run on **Vitest** (both workspaces) — validate with
  `npm run typecheck && npm run lint && npm test && npm run build`. Vitest's fork pool
  is capped via `ZMRNG_VITEST_MAX_FORKS` (default 3; `runner.ts` sets `2` for worker
  children) — see `.claude/rules/testing.md`.

## Project structure
```
zmrng/
├── packages/
│   ├── server/     — Fastify + SQLite + the claude runner (source of truth for types)
│   ├── web/        — React frontend (types.ts is a MANUAL MIRROR of the server's)
│   └── desktop/    — Tauri shell wrapping the server as a sidecar
├── config/         — repo registry (repos.json gitignored, repos.example.json committed)
├── worktrees/      — per-task git worktrees (gitignored)
├── .claude/        — this harness (rules, commands, agents, skills, docs, files)
└── .agents/        — PIV artifacts (plans, tasks, reviews, handoffs) + loop.sh
```
**Annotated per-file map: `.claude/docs/codemap.md`** — read it before hunting for
where something lives, rather than grepping the tree.

## Self-contained harness (runs from this repo)
The enforcing harness lives **inside this repo** so a fresh clone has it with no
external setup — run Claude Code from the zmrng root and `.claude/settings.json`
wires six hooks automatically (they are `chmod +x`; stock macOS `python3` 3.9 is
fine — every hook carries `from __future__ import annotations`):

| Hook | When | What |
|------|------|------|
| `security_guard.py` | Before any file/bash op | Blocks `.env` access, recursive deletes, force-push to main, `git reset --hard` |
| `branch_guard.py` | Before Edit/Write/MultiEdit | Blocks edits when the repo is on `main`/`master` — branch first. Override: `HERMES_ALLOW_PROTECTED_EDIT=1` |
| `worktree_guard.py` | Before Edit/Write/MultiEdit | Blocks a **second** concurrent session from editing a worktree already claimed by another live session — each agent works in its own worktree (branches don't isolate agents, directories do). Stale locks self-expire (`HERMES_WORKTREE_LOCK_TTL`, default 3600s). Override: `HERMES_ALLOW_SHARED_WORKTREE=1`. Operator-harness only — NOT seeded into workers (each already gets a dedicated worktree). |
| `pr_shape_guard.py` | Before Bash | Rejects `gh pr create` with `--fill` or without `--body-file`. Override: `HERMES_ALLOW_PR_FILL=1` |
| `post_tool_use_lint.py` | After editing code | Advisory linter (tsc for TS) — never blocks |
| `stop_validate.py` | When the turn tries to end | Runs `.claude/validate.sh` (→ `verify.sh --fast`, scoped to the workspaces the turn changed — see `.claude/rules/testing.md`); blocks the stop if it fails |

Hooks fire only when Claude Code is launched from this repo (project-root
`.claude/`). zmrng **workers** run inside a target repo and do NOT inherit these
hooks — their guardrails are the prompt strings in `phases.ts` (pinned by
`prompts.test.ts`). When a target repo registers its own copy of one of these hook
scripts, `seedHarness` skips seeding the duplicate (except `security_guard.py`) so it
doesn't fire twice per event — override with `ZMRNG_FORCE_SEED_HOOKS=1`. Detail:
`.claude/docs/services-reference.md`.

## Key conventions

### No shared package — manual type mirror
There is **no** shared workspace. `packages/server/src/types.ts` is the source of truth;
`packages/web/src/types.ts` is a **manual mirror**. **Every type change touches BOTH
files.** `npm run typecheck` over both workspaces is what catches mirror drift.

### Frosted-glass design tokens (NEVER hard-code values)
All colors, blur, radii, and motion live in `packages/web/src/theme.css`
(`--surface`, `--surface-strong`, `--blur`, `--accent`, `--accent-soft`, `--border`,
`--text`, `--text-dim`, `--radius`, `--radius-sm`, `--transition`, plus `--status-*`
pills and `--actor-*` hues for color-coding the main worker and subagents by type).
Always use `var(--*)`. System font stack (`--font`) + mono (`--font-mono`).

### Runner safety — Max OAuth only
`runner.ts` **strips `ANTHROPIC_API_KEY` from the child env** so `claude` authenticates
with the operator's Max subscription, never the metered API. Never export
`ANTHROPIC_API_KEY` in this shell, and never extract or proxy the OAuth token. Workers
run with `--dangerously-skip-permissions`; the *target repo's* own security hook still
guards `.env`/force-push/recursive deletes.

### Caveman narration is the worker default
zmrng workers default to a terse caveman register for narration/status/log (per-task
`style` select, default `caveman-full`). The carve-out is absolute: **code, commit
messages, PR titles/bodies, and plan files stay normal, professional English.** When
*you* (Claude Code helping build zmrng) work in this repo, write normal English unless
asked otherwise.

### Per-task controls
Each task records `model` (opus/sonnet), `effort` (low/medium/high/xhigh/max),
`style` (caveman levels — non-`normal` makes the worker invoke the `caveman` skill at
the mapped intensity), and `repoId` (which target repo it drives). Token/cost usage
accumulates across stream-json `result` events and shows once the task hits review/done.

### Stale task recovery (Restart agent)
A task's `claude` worker dies with the server process (e.g. a clean app quit); on
reboot `reconcileOrphans()` marks any task still sitting in a live phase `stale`
rather than pretending it's alive. The operator's only recovery is the manual
**Restart agent** action (`POST /api/tasks/:id/restart`), which spawns a **fresh**
agent in the same worktree (never `claude --resume`). Details:
`.claude/docs/services-reference.md`.

### Done = local sync after the GitHub merge (never auto-push to main)
The worker still finishes autonomous work by pushing its branch and opening a **PR** —
zmrng never merges or pushes to `origin/main` itself. The operator reviews and merges the
PR on GitHub. Clicking **Done** then reconciles the *local* checkout so it stops drifting
from the merged remote: `done()` removes the worktree, fast-forwards the local default
branch to `origin/<default>`, and deletes the merged feature branch. All of this is
**safe + best-effort** (`syncLocalAfterMerge` in `worktree.ts`): `fetch` always; update
the default branch **fast-forward only** (skip + warn if the working tree is dirty or
non-ff); delete the branch with `git branch -d` only (a squash/rebase-merged PR's branch
is *kept*, never force-deleted). Each step emits a `local sync — …` note to the operator
log. Never force-push, never stash, never touch uncommitted work.

### SQLite migrations are ADDITIVE-ONLY (never lose VPS chats)
Migrations in `db.ts` (`ensureColumns()`) may **only** `ALTER … ADD COLUMN` /
`CREATE … IF NOT EXISTS` — **never** drop/rename a column or table, and **never** rewrite
existing rows. The VPS team-workspace instance redeploys in place
(`scripts/autoupdate-workspace.sh` reopens the same populated `zmrng.db` under
`ZMRNG_DATA_DIR`, untouched by the checkout `reset --hard`), so a destructive or rewriting
migration is the **one** thing that could lose live channels/messages/reactions/members
across a redeploy. A genuine column drop/rename needs an explicit, reviewed migration path — not the
best-effort idempotent reopen. (D2a of `.agents/plans/instance-update-distribution-grill.md`.)

### TypeScript / logging
TS strict, no `any` (use the tolerant `asRecord`/`asString` helpers in `runner.ts` for
untyped stream-json). Pino structured logging (`app.log.info({ code }, 'msg')`) — never
string interpolation, never `console.log` in server code.

## Key services
Full method signatures, callbacks, wire types, and per-service behavior live in
**`.claude/docs/services-reference.md`** (server: runner, phases, terminal, chatAgent,
lanes, db, config, worktree, ws, index; frontend: `packages/web/src/`; team workspace).
Read that file when touching a service — it is the reference, not this file.

## Commands
```bash
# Install
npm install

# Development
npm run dev:server       # Fastify server (tsx watch)
npm run dev:web          # Vite dev server
npm run dev              # both
#
# DEV LOOP — view http://localhost:5174 (Vite), NOT :4500. `npm run dev` runs
# BOTH watchers: Vite (:5174, HMR — web edits/merges hot-reload instantly, no
# rebuild, no browser cache) and tsx watch (:4500, server edits auto-restart
# ~1.6s). Vite proxies /api + /ws to :4500. To pick up merged code automatically,
# just keep `npm run dev` running and browse :5174 — never `npm run build` in dev.
# `npm run build` only refreshes web/dist for the shipped app; it does NOT restart
# a running server or bust browser cache, so it's the wrong tool for a dev loop.
# Pitfall: `npm start`/a bare-built server on :4500 has NO watcher — merges land on
# disk but nothing reloads and the browser serves a stale cached bundle (looks dead).

# Build & validate
npm run build            # tsc (server) + vite build (web)
npm run typecheck        # tsc --noEmit, both workspaces
npm run lint             # ESLint, both workspaces
npm test                 # Vitest run, both workspaces
npm run test:watch       # Vitest watch, both workspaces
npm start                # serve API + built UI

# Desktop app (Tauri) — native macOS .app wrapping the server as a sidecar
npm run desktop:dev      # native window running the bundled sidecar (needs Rust)
npm run bundle:sidecar   # esbuild server + vendor better-sqlite3/node + copy web/dist
npm run desktop:build    # build → bundle:sidecar → tauri build → a .app

# Autonomous loop (Mode 3)
.agents/scripts/loop.sh .agents/tasks/<task>.md
.agents/scripts/loop.sh .agents/tasks/<task>.md --max-iterations 10
```

## Workflow: PIV Loop (Plan → Implement → Validate → Review)
| Step | Command | Output |
|------|---------|--------|
| 1. Plan | `/plan-feature <desc>` | `.agents/plans/<slug>.md` |
| 2. Implement | `/execute .agents/plans/<slug>.md` | working changes |
| 3. Validate | `/validate` | PASS/FAIL per check |
| 4. Review | `/code-review` | `.agents/code-reviews/<slug>.md` |

**Plans before code. Branch before code.** Planning can happen on `main`; the first
file edit requires a feature branch off `origin/main` — now enforced by the
`branch_guard` hook. Full rule: `.claude/rules/coding-lifecycle.md`. Validate via
`.claude/verify.sh` (the one gate shared by the agent, `loop.sh`, and the Stop hook).

## Collaboration (solo operator)
zmrng is a **solo** project — there is no two-developer protocol. Conventions:
1. **Plans before code** — write a plan in `.agents/plans/` before touching files.
2. **Branch before code** — `<type>/zc/<desc>` off `origin/main` (`branch_guard`-enforced;
   see `.claude/rules/coding-lifecycle.md`).
3. **End-of-session doc sync** — run the `sync-docs` skill before any non-trivial commit.

## Context architecture
- **Tier 1 — this file.** Always loaded, and kept deliberately small: conventions,
  commands, and pointers. Detail belongs in Tier 3, not here — when a section grows
  past a screen, move it to `.claude/docs/` and leave a one-line pointer.
- **Tier 2 — auto-loading rules** (`.claude/rules/`): `backend-typescript.md`,
  `frontend-react.md`, `error-handling.md`, `testing.md`, `planning-workflow.md`,
  `worktree-location.md`, `coding-lifecycle.md`.
- **Tier 3 — reference docs** (`.claude/docs/`): `codemap.md` (annotated file tree —
  where things live), `services-reference.md` (method signatures + behavior),
  `resolved-decisions.md` (settled calls, don't re-ask), `implementation-history.md`.
  Plus `.claude/files/` (PROJECT_CONTEXT, FUTURE_IDEAS) and
  `.claude/errors.md` (known gotchas — check before debugging).

## Team workspace (POC)
Optional **Team** mode tab talking to a VPS-hosted instance of the same server binary
over one multiplexed WebSocket (`GET /ws/workspace`): presence roster, channels, live
messaging, emoji reactions on messages, repo-scoped channels with a "Send to my zmrng"
handoff, and one shared `@agent` that plans but never executes. Architecture detail is in
`.claude/docs/codemap.md`; the deploy runbook is `docs/team-workspace-deploy.md`.

> **POC exposure precondition (Tailscale is the perimeter):** the VPS
> workspace port MUST be reachable **only over Tailscale** — firewall it to the
> tailnet interface, or bind the server to the Tailscale IP. **Never expose it
> publicly.** Because the handle is self-asserted with no verification, the
> tailnet membership *is* the access control. This is an operational
> precondition documented here **only** — there is deliberately **no app-code
> gate, no server bind change, and no auth** in the T1 scope.

## Resolved decisions
Settled calls that should not be re-litigated live in
**`.claude/docs/resolved-decisions.md`**. Read it before proposing a change that
revisits engine choice, the team-workspace T1–T4 scope, or migration strategy.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout -- `CONTEXT.md` + `docs/adr/` at repo root (not yet created; this file already serves that role in depth, so the `domain-modeling` skill can extract from it lazily). See `docs/agents/domain.md`.
