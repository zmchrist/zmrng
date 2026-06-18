# Implementation History

Chronological record of completed zmrng features. One entry per milestone, newest last.

---

## v1 — Autonomous task orchestrator (2026-06-17)
The initial orchestrator. A Fastify 5 + @fastify/websocket + better-sqlite3 (WAL) +
Pino backend and a React 19 + Vite + CSS Modules frosted-glass frontend. Per task it
spawns a headless `claude` child (`child_process`, stream-json) inside a dedicated git
worktree of a single hardcoded target repo and drives the phase state machine
backlog → clarify → building → review → done/failed. `ZMRNG_READY` advances clarify→
building; a detected GitHub PR URL advances building→review. Build-lane cap with a
queue. Runner strips `ANTHROPIC_API_KEY` (Max OAuth only). WebSocket hub streams task
+ claude events (including partial token deltas) to the UI. SQLite persists tasks +
events.

## Per-task controls — model · effort · style + token usage (2026-06-17)
Each task records `model` (opus/sonnet/fable), `effort` (low/medium/high/xhigh/max),
and `style` (caveman register applied to narration only — code/commits/PRs stay normal
English). The New Task form exposes the three as selects; phases inject a style
directive into the system prompt and pass model/effort to the runner. Token/cost usage
(`tokens_in/out/cache`, `cost_usd`, `turns`) accumulates atomically across stream-json
`result` events and renders in TaskDetail once a task reaches review/done. SQLite
migrated via idempotent `ensureColumns()`.

## Self-harness + multi-target repo selection (2026-06-17)
- **Self-harness:** a Claude Code working harness scaffolded into the repo
  (`CLAUDE.md`, `.claude/{rules,commands,agents,skills,docs,files,errors.md}`, `.agents/`),
  tailored to zmrng's own stack (Fastify/SQLite/runner/React/frosted-glass) and stripped
  of all prior domain. Inherits the universal `~/Documents/Projects/CLAUDE.md` hooks.
- **Multi-target:** generalized the single hardcoded `ZMRNG_TARGET_REPO` into a repo
  registry (`config/repos.json` → `ZMRNG_REPOS` env → legacy fallback). Each task records
  a `repoId`; the New Task form has a Repo select; the worker spawns against the chosen
  repo (cwd + worktree + `--add-dir`), branches from that repo's default branch, and
  opens the PR there. `systemPrompt` is repo-agnostic and relies on the target repo's
  own harness. Worktree base-ref resolution degrades gracefully for local-only repos.
  SQLite migrated with `repo_id` (null backfills to `defaultRepoId` on read).
