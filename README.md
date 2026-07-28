# zmrng

[![CI](https://github.com/zmchrist/zmrng/actions/workflows/ci.yml/badge.svg)](https://github.com/zmchrist/zmrng/actions/workflows/ci.yml)

Autonomous task orchestrator GUI. Drop in a task, answer a few clarifying
questions, then watch a Claude Code worker **plan → implement → validate → open a
PR** fully autonomously. One GUI replaces babysitting five terminals.

zmrng drives a **registry of target repos** — each task picks which repo it
operates on from a configured list (`config/repos.json`), merged with every git
repo auto-discovered under `ZMRNG_PROJECTS_DIR` plus a self entry for zmrng
itself, so it is drivable out of the box with no config file present.

> **Note:** each task's git worktree is created inside its target repo's own
> `worktrees/` folder, so add `worktrees/` to that repo's `.gitignore`.

## How it works

Each task spawns one long-lived headless `claude` process inside a dedicated git
worktree of the target repo:

```
backlog ─Start─▶ clarify ─READY─▶ planning ─PLAN_READY─▶ executing ─VALIDATING─▶ validating ─PR url─▶ review ─Done─▶ done
                (you answer Qs)   └─────── full auto: plan → implement → QA/review/docs, no stops ───────┘      (review on GitHub)
```

- **clarify** — the agent asks scoping questions; you answer in the UI. It stays
  one native session via `claude --input-format stream-json` on stdin.
- **planning** — on the `ZMRNG_READY` sentinel a *fresh* session (always opus/high),
  seeded with the clarify transcript, runs `/core_piv_loop:plan-feature`, QA's the plan,
  and emits `ZMRNG_PLAN_READY` with the execute-phase model/effort/plan path.
- **executing → validating** — another fresh session implements the plan in the
  worktree (already cut from `origin/main`), prints `ZMRNG_VALIDATING`, runs the
  qa/code-reviewer/doc-updater chain plus `typecheck && lint && build`, commits, pushes,
  and opens a PR.
- **review** — the PR URL surfaces in the UI; you review on GitHub and mark done.
- **blocked** — a worker missing a required subagent emits `ZMRNG_BLOCKED: <reason>` and
  waits, lane held, until you add the agent and resume it.

## Safety

- **Max OAuth only.** The server strips `ANTHROPIC_API_KEY` from every worker so
  `claude` uses your subscription login, never the metered API. Do **not** export
  `ANTHROPIC_API_KEY` in this shell.
- **`--dangerously-skip-permissions`** suppresses prompts, but the target repo's
  own `security_guard.py` hook still blocks `.env` access, force-push to main, and
  recursive deletes. Workers operate in isolated worktrees and never touch `main`.
- **Lane cap.** `ZMRNG_MAX_LANES` (default 2) bounds concurrent autonomous (plan→PR)
  tasks to respect the Max weekly cap; extra READY tasks queue.

## Run

```bash
npm install
cp .env.example .env          # optional — every var has a sane default
npm run dev                   # server :4500 + web :5174
```

Open http://localhost:5174.

Production build + serve (web is served by the Fastify server from `web/dist`):

```bash
npm run build
npm start                     # serves API + built UI on ZMRNG_PORT
```

## Desktop app (Tauri)

zmrng can run as a native macOS `.app` (Tauri + WKWebView) that bundles the Node
server as a sidecar — no terminal, no browser tab. The server is unchanged; the
Tauri shell picks a free port, injects the login-shell `PATH` (so `claude`/`git`/`gh`
resolve under a Finder launch), spawns the sidecar, and points the window at it.

```bash
npm run desktop:dev           # native window running the bundled sidecar
npm run desktop:build         # build → bundle:sidecar → tauri build  → a .app
```

Build prerequisites: **Rust** (`https://rustup.rs`), Xcode CLT, and app icons
(`npm run tauri -w @zmrng/desktop -- icon path/to/logo.png`). The bundle pipeline
(`npm run bundle:sidecar`) esbuilds the server, vendors `better-sqlite3` + an
official self-contained Node runtime, and copies `web/dist` into `src-tauri/`.

In the desktop app the SQLite db, git worktrees, and the repo registry live in a
writable per-user dir — `~/Library/Application Support/zmrng/` — not inside the
read-only bundle (so `config/repos.json` lives at
`~/Library/Application Support/zmrng/config/repos.json`). `npm run dev` is unchanged:
with no env set everything still resolves under the repo root.

## Config (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `ZMRNG_PROJECTS_DIR` | first existing of `~/Projects` → `~/Developer/Projects` → `~/Documents/Projects` | Dir auto-scanned for git repos to list |
| `ZMRNG_DEFAULT_REPO` | `zmrng` | Registry id of the default target repo |
| `ZMRNG_TARGET_REPO` | _(unset)_ | Legacy single-repo fallback; no entry emitted when unset |
| `ZMRNG_PORT` | `4500` | Fastify port |
| `ZMRNG_MODEL` | `opus` | Default model for new tasks (opus \| sonnet) |
| `ZMRNG_MAX_LANES` | `2` | Max concurrent autonomous (plan→PR) tasks |
| `ZMRNG_DATA_DIR` | repo root | Writable dir for db + worktrees + `config/` (desktop sets this) |
| `ZMRNG_WEB_DIST` | `packages/web/dist` | Built UI dir the server serves (desktop sets this) |

## Validate

```bash
npm run typecheck && npm run lint && npm run build
```

## Layout

```
packages/server/  Fastify + WS + SQLite; spawns/parses the claude child (runner.ts)
packages/web/     React + Vite frosted-glass UI (list + detail pane)
packages/desktop/ Tauri shell (Rust) + sidecar bundle pipeline (the .app)
worktrees/        per-task git worktrees (gitignored)
plans/            standalone copy of the implementation plan
```
