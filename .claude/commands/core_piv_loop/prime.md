---
description: Prime agent with codebase understanding
---

# Prime: Load Project Context

## Objective

Build comprehensive understanding of the zmrng codebase by analyzing structure, documentation, and key files.

## Process

### 1. Analyze Project Structure

List all tracked files:
!`git ls-files`

Show directory structure:
```bash
find packages -type f -name '*.ts*' -not -path '*/node_modules/*' -not -path '*/dist/*' | head -50
```

### 2. Read Core Documentation

- Read CLAUDE.md
- Read `.claude/files/PROJECT_CONTEXT.md`
- Read `.claude/docs/services-reference.md`

### 3. Identify Key Files

Based on the structure, identify and read:
- `packages/server/src/types.ts` — Task/WsEvent/usage types (SOURCE OF TRUTH)
- `packages/web/src/types.ts` — manual mirror of server types
- `packages/server/src/config.ts` — env parsing + repo registry
- `packages/server/src/runner.ts` — spawns + parses the `claude` child (stream-json)
- `packages/server/src/phases.ts` — phase state machine + prompts + lane queue
- `packages/server/src/db.ts` — SQLite schema + prepared statements + migrations
- `packages/server/src/index.ts` — Fastify REST routes + WebSocket + static serve
- `packages/web/src/App.tsx` — layout: TaskList rail | TaskDetail pane
- `packages/web/src/theme.css` — frosted-glass design tokens
- `package.json` — workspace config

### 4. Understand Current State

Check recent activity:
!`git log -10 --oneline`

Check current branch and status:
!`git status`

## Output Report

Provide a concise summary covering:

### Project Overview
- Purpose and type of application (autonomous task-orchestrator GUI driving `claude` workers)
- Primary technologies and frameworks
- Current version/state

### Architecture
- Monorepo workspace structure (`packages/server`, `packages/web`, no shared package)
- Data flow: New Task → clarify (operator Q&A) → ZMRNG_READY → build (autonomous) → PR → review
- Engine: `child_process` spawn of headless `claude` per task, stream-json over a worktree

### Tech Stack
- TypeScript throughout, npm workspaces
- Fastify 5 + @fastify/websocket, SQLite (better-sqlite3, WAL), Pino, React 19 + Vite, CSS Modules

### Current State
- Active branch
- Recent changes or development focus
- Any immediate observations

**Make this summary easy to scan - use bullet points and clear headers.**
