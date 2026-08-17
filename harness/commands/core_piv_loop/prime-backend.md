---
description: Orient on the backend — Fastify server, claude runner, phases, and SQLite
---

# Prime Backend: Server, Runner & Phase Orientation

## Objective

Orient on the backend package (`packages/server`) before working on the Fastify server, the `claude` child runner, the phase state machine, the repo registry, worktrees, or SQLite.

## Process

### 1. Understand the Package Structure

```bash
ls packages/server/src/
```

### 2. Understand Types & Config (sources of truth)

Read `packages/server/src/types.ts` — Task, TaskStatus, per-task controls (model/effort/style), `RepoTarget`, `TaskUsage`, `WsEvent`, and `ClaudeStreamLine`. This is the SOURCE OF TRUTH that `packages/web/src/types.ts` mirrors.

Read `packages/server/src/config.ts` — env parsing and the repo registry: `config/repos.json` → `ZMRNG_REPOS` env → legacy `ZMRNG_TARGET_REPO`; startup validation skips non-git paths; `repoById()` resolves a target.

### 3. Understand the Runner

Read `packages/server/src/runner.ts` — spawns one headless `claude` child per task with `--output-format stream-json`, parses session/assistant/partial/result lines, exposes `send()`/`kill()`, and **strips `ANTHROPIC_API_KEY`** so workers use Max OAuth.

### 4. Understand Phases

Read `packages/server/src/phases.ts` — `TaskManager`: phase state machine (backlog→clarify→building→review→done/failed), `systemPrompt()` + kickoff prompts, `ZMRNG_READY` and PR-URL detection, build-lane cap (`ZMRNG_MAX_LANES`) + queue.

Read `packages/server/src/worktree.ts` — `git worktree add` per task; base ref resolved `origin/<branch>` → local `<branch>` → `HEAD`.

### 5. Understand the Server & DB

Read `packages/server/src/index.ts` — Fastify bootstrap: REST routes, WebSocket, static serve of `web/dist`, graceful shutdown.

Read `packages/server/src/db.ts` — SQLite schema (`tasks`, `events`), prepared statements, WAL pragmas, idempotent `ensureColumns()` migration, atomic `addUsage()`.

### 6. Check Recent Backend Activity

```bash
git log -8 --oneline -- packages/server/
```

### 7. Load Deep Reference (if needed)

Read `.claude/docs/services-reference.md` for service API documentation.

## Output

Summarize (under 300 words):

### Engine Pipeline
- New Task → worktree → `claude` child (stream-json) → events broadcast over WS
- Phases: clarify (operator Q&A) → ZMRNG_READY → building (autonomous) → PR → review
- API key stripped; Max OAuth only

### Server Architecture
- Fastify REST + WebSocket hub; SQLite (WAL) with prepared statements
- Build-lane cap + queue; graceful shutdown lifecycle

### Config / Registry
- Multi-target repo registry with fallback chain; `repoById()`
- Per-task `repoId` recorded and persisted

### API Surface
- `GET /api/config`, `GET /api/repos`, `GET /api/tasks`, `POST /api/tasks`
- `POST /api/tasks/:id/{start,message,done,cancel}`, `GET /api/tasks/:id/events`, `GET /ws`

### Recent Changes
- Last few backend commits
