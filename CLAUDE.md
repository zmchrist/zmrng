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
backlog ──Start──▶ clarify ──ZMRNG_READY──▶ building ──PR url──▶ review ──Done──▶ done
                    (you answer Qs)        (full auto, no stops)  (review on GitHub)
```

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
- **Frontend:** React 19 + Vite, CSS Modules + design tokens (frosted-glass theme)
- **Language:** TypeScript throughout (ESM, `NodeNext`/`bundler` resolution)
- **No cloud. No test framework yet** — validate with
  `npm run typecheck && npm run lint && npm run build`

## Project structure
```
zmrng/
├── packages/
│   ├── server/
│   │   └── src/
│   │       ├── index.ts        — Fastify bootstrap: REST routes + WS + static serve
│   │       ├── config.ts       — env parsing, repo registry (config/repos.json → env → legacy)
│   │       ├── db.ts           — SQLite schema, prepared statements, idempotent migrations
│   │       ├── types.ts        — Task/Phase/WsEvent/usage types (SOURCE OF TRUTH)
│   │       ├── runner.ts       — spawn + parse the claude child (stream-json), strip API key
│   │       ├── phases.ts       — phase state machine + system/kickoff prompts + lane queue
│   │       ├── worktree.ts     — git worktree create/remove per task
│   │       └── ws.ts           — WebSocket broadcast hub
│   └── web/
│       └── src/
│           ├── main.tsx        — React root
│           ├── App.tsx         — layout: TaskList rail | TaskDetail pane
│           ├── theme.css       — frosted-glass design tokens
│           ├── api.ts          — REST client
│           ├── useWs.ts        — auto-reconnect WebSocket hook
│           ├── types.ts        — MANUAL MIRROR of server/src/types.ts
│           └── components/      — TaskList, NewTaskForm, TaskDetail, ClarifyChat, WorkerLog
│   └── desktop/                — Tauri desktop shell (wraps the server as a sidecar)
│       ├── scripts/bundle-sidecar.mjs  — esbuild server + vendor sqlite/node + web/dist
│       ├── splash/index.html   — frosted-glass loading splash (Tauri frontendDist)
│       └── src-tauri/          — Rust shell: Cargo.toml, tauri.conf.json, src/main.rs
├── config/
│   ├── repos.json              — repo registry (gitignored; machine-specific paths)
│   └── repos.example.json      — committed template
├── worktrees/                  — per-task git worktrees (gitignored)
├── .claude/                    — this harness (rules, commands, agents, skills, docs, files)
└── .agents/                    — PIV artifacts (plans, tasks, reviews, handoffs) + loop.sh
```

## Inherits the universal Projects harness
zmrng lives under `~/Documents/Projects/` and **inherits** the universal
`/Users/tiofeliz/Documents/Projects/CLAUDE.md` harness: the PIV loop and the three hooks
(`security_guard.py` blocks `.env`/force-push-to-main/recursive deletes;
`post_tool_use_lint.py` lints after edits; `stop_validate.py` runs lint + build before a
turn can finish). **Do not restate or duplicate those hooks here.** This file only adds
zmrng-specific conventions and overrides.

## Key conventions

### No shared package — manual type mirror
There is **no** shared workspace. `packages/server/src/types.ts` is the source of truth;
`packages/web/src/types.ts` is a **manual mirror**. **Every type change touches BOTH
files.** `npm run typecheck` over both workspaces is what catches mirror drift.

### Frosted-glass design tokens (NEVER hard-code values)
All colors, blur, radii, and motion live in `packages/web/src/theme.css`
(`--surface`, `--surface-strong`, `--blur`, `--accent`, `--accent-soft`, `--border`,
`--text`, `--text-dim`, `--radius`, `--radius-sm`, `--transition`, plus `--status-*`
pills). Always use `var(--*)`. System font stack (`--font`) + mono (`--font-mono`).

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

### TypeScript / logging
TS strict, no `any` (use the tolerant `asRecord`/`asString` helpers in `runner.ts` for
untyped stream-json). Pino structured logging (`app.log.info({ code }, 'msg')`) — never
string interpolation, never `console.log` in server code.

## Key services
See `.claude/docs/services-reference.md` for full method signatures and behavior.

- **Runner** (`packages/server/src/runner.ts`) — wraps one `claude` child per task;
  spawns with stream-json in/out, parses session/assistant/partial/result lines, exposes
  `send()`/`kill()`; strips `ANTHROPIC_API_KEY`.
- **TaskManager / phases** (`packages/server/src/phases.ts`) — phase state machine
  (backlog→clarify→building→review→done/failed), system + kickoff prompts, `ZMRNG_READY`
  + PR-URL detection, build-lane cap + queue.
- **Db** (`packages/server/src/db.ts`) — SQLite (WAL), `tasks` + `events` schema,
  prepared statements, idempotent `ensureColumns()` migration, atomic `addUsage()`.
- **Config** (`packages/server/src/config.ts`) — env + repo registry: explicit
  (config/repos.json → `ZMRNG_REPOS` env → legacy `ZMRNG_TARGET_REPO`) merged with an
  auto-scan of `ZMRNG_PROJECTS_DIR` (every git-repo-root under it) plus a zmrng self
  entry; default repo is zmrng unless `ZMRNG_DEFAULT_REPO` pins another. `repoById()`.
- **Worktree** (`packages/server/src/worktree.ts`) — `git worktree add` per task, base
  ref resolved `origin/<branch>` → local `<branch>` → `HEAD` for local-only repos.
- **WsHub** (`packages/server/src/ws.ts`) — fan-out broadcast of task + claude events.
- **Fastify server** (`packages/server/src/index.ts`) — REST surface
  (`GET /api/config`, `GET /api/repos`, `GET /api/tasks`, `POST /api/tasks`,
  `POST /api/tasks/:id/{start,message,done,cancel}`, `GET /api/tasks/:id/events`),
  `GET /ws`, static serve of `web/dist`.
- **useWs** (`packages/web/src/useWs.ts`) — auto-reconnect WebSocket hook (1s→30s backoff).

## Commands
```bash
# Install
npm install

# Development
npm run dev:server       # Fastify server (tsx watch)
npm run dev:web          # Vite dev server
npm run dev              # both

# Build & validate
npm run build            # tsc (server) + vite build (web)
npm run typecheck        # tsc --noEmit, both workspaces
npm run lint             # ESLint, both workspaces
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

**Plans before code. Branch before code.** Planning/brainstorming can happen on `main`;
the moment a session edits a file, create a feature branch first. Always branch from
`origin/main`: `git fetch origin && git checkout -b feat/zc/<desc> origin/main`.

## Collaboration (solo operator)
zmrng is a **solo** project — there is no two-developer protocol. Conventions:
1. **Plans before code** — write a plan in `.agents/plans/` before touching files.
2. **Branch before code** — never edit on `main`/`master`; branch from `origin/main`.
3. **Branch convention:** `<type>/zc/<short-description>` (`feat/`, `fix/`, `chore/`, `wip/`).
4. **End-of-session doc sync** — run the `sync-docs` skill before any non-trivial commit.

## Context architecture
- **Tier 1 — this file.** Always loaded: structure, commands, conventions.
- **Tier 2 — auto-loading rules** (`.claude/rules/`): `backend-typescript.md`,
  `frontend-react.md`, `error-handling.md`, `testing.md`, `planning-workflow.md`.
- **Tier 3 — reference docs** (`.claude/docs/`): `services-reference.md`,
  `implementation-history.md`. Plus `.claude/files/` (PROJECT_CONTEXT, FUTURE_IDEAS) and
  `.claude/errors.md` (known gotchas — check before debugging).

## Resolved (don't re-ask)
- Engine is the real `claude` binary via `child_process` (ToS-compliant; never proxy the token).
- Max OAuth only — `ANTHROPIC_API_KEY` stripped from worker env.
- No shared package — server↔web types are a manual mirror.
- Frosted-glass theme; no test framework yet (typecheck+lint+build is validation).
- Worktrees live under zmrng `worktrees/` (gitignored), one per task.
- Build-lane cap via `ZMRNG_MAX_LANES` (default 2); extra READY tasks queue.
