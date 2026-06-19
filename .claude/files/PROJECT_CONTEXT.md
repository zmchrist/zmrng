# Project Context — zmrng

## Vision
zmrng is a single-operator GUI that replaces babysitting several `claude` terminals.
You drop in a task, answer a few clarifying questions, then watch a Claude Code worker
plan → implement → validate → open a PR fully autonomously, with live narration. It
drives **other** repos; it is the conductor, not the orchestra.

## Core decisions
- **Engine is the real `claude` binary** via `child_process` (ToS-compliant). Never
  proxy or extract the OAuth token.
- **Max OAuth only** — `ANTHROPIC_API_KEY` is stripped from every worker's env so work
  never silently bills the metered API.
- **No shared package** — `packages/server/src/types.ts` is the source of truth, manually
  mirrored into `packages/web/src/types.ts`.
- **Frosted-glass UI** — translucent surfaces + backdrop blur, design tokens only.
- **No cloud, no test framework yet** — validation is typecheck + lint + build.
- **Caveman narration by default** for workers (per-task `style`); code/commits/PRs are
  always normal English.
- **Multi-target** — a repo registry (`config/repos.json` → env → legacy) lets each task
  pick which repo it drives; the worker obeys that repo's own harness.
- **Desktop shell is a wrapper, not a rewrite** — `packages/desktop` is a Tauri (Rust +
  WKWebView) shell that runs the *unchanged* Node server as a bundled sidecar. It picks a
  free port, injects the login-shell `PATH` (Finder launches get a minimal PATH), spawns
  the sidecar, health-polls, then navigates the window to `localhost:<port>`. Zero
  frontend changes.

## Architecture at a glance
- `packages/server` — Fastify 5 REST + WS, SQLite (WAL), Pino, the claude runner, the
  phase state machine, the repo registry, and git worktrees.
- `packages/web` — React 19 + Vite single-page UI (TaskList rail | TaskDetail pane).
- `packages/desktop` — Tauri shell + `bundle-sidecar.mjs` (esbuilds the server to ESM,
  vendors `better-sqlite3` + an official self-contained Node, copies `web/dist`).
- Phases: `backlog → clarify → planning → executing → validating → review → done`
  (+ `blocked` for a missing subagent, `failed`). Each autonomous phase runs in a fresh
  `claude` session, handed off by a control token. `building` is a legacy single-phase
  status retained only for old DB rows.
- One worktree per task under `worktrees/<shortId>` (gitignored), one `claude` child each.
- **Writable data dir** — `ZMRNG_DATA_DIR` relocates the db, worktrees, and `config/` out
  of the read-only `.app` bundle into `~/Library/Application Support/zmrng/`. Unset in dev
  → defaults to the repo root (byte-for-byte legacy behavior).

## Roadmap / open questions
See `FUTURE_IDEAS.md` for deferred features. Near-term candidates: cost/usage dashboard,
a kanban board view, and an in-app repo-management UI (currently registry is edited by
hand in `config/repos.json`).

## Inheritance
zmrng lives under `~/Documents/Projects/` and inherits the universal
`~/Documents/Projects/CLAUDE.md` harness (PIV loop + security/lint/validate hooks). The
repo's own `CLAUDE.md` only adds zmrng-specific conventions.
