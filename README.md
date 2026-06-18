# zmrng

Autonomous task orchestrator GUI. Drop in a task, answer a few clarifying
questions, then watch a Claude Code worker **plan → implement → validate → open a
PR** fully autonomously. One GUI replaces babysitting five terminals.

v1 drives a single target repo: **Pheme** (`~/Documents/Projects/pheme`).

## How it works

Each task spawns one long-lived headless `claude` process inside a dedicated git
worktree of the target repo:

```
backlog ──Start──▶ clarify ──ZMRNG_READY──▶ building ──PR url──▶ review ──Done──▶ done
                     (you answer Qs)        (full auto, no stops)   (review on GitHub)
```

- **clarify** — the agent asks scoping questions; you answer in the UI. It stays
  one native session via `claude --input-format stream-json` on stdin.
- **building** — on the `ZMRNG_READY` sentinel the server auto-sends the build
  instruction. The agent branches' worktree is already cut from `origin/main`; it
  implements, runs `typecheck && lint && build`, commits, pushes, and opens a PR.
- **review** — the PR URL surfaces in the UI; you review on GitHub and mark done.

## Safety

- **Max OAuth only.** The server strips `ANTHROPIC_API_KEY` from every worker so
  `claude` uses your subscription login, never the metered API. Do **not** export
  `ANTHROPIC_API_KEY` in this shell.
- **`--dangerously-skip-permissions`** suppresses prompts, but the target repo's
  own `security_guard.py` hook still blocks `.env` access, force-push to main, and
  recursive deletes. Workers operate in isolated worktrees and never touch `main`.
- **Lane cap.** `ZMRNG_MAX_LANES` (default 2) bounds concurrent building tasks to
  respect the Max weekly cap; extra READY tasks queue.

## Run

```bash
npm install
cp .env.example .env          # optional — defaults target Pheme
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
| `ZMRNG_TARGET_REPO` | `~/Documents/Projects/pheme` | Repo zmrng drives |
| `ZMRNG_PORT` | `4500` | Fastify port |
| `ZMRNG_MODEL` | `opus` | Default model for new tasks |
| `ZMRNG_MAX_LANES` | `2` | Max concurrent building tasks |
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
