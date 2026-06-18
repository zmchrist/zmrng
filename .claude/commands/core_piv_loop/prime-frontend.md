---
description: Orient on the frontend — React components, WebSocket hook, and frosted-glass theme
---

# Prime Frontend: React UI Orientation

## Objective

Orient on the frontend (`packages/web/src/`) before working on UI components, the WebSocket hook, or the frosted-glass theme.

## Process

### 1. Understand the App Structure

```bash
ls packages/web/src/
ls packages/web/src/components/
```

Read `packages/web/src/App.tsx` — top-level layout: TaskList rail (left) | TaskDetail pane (right); WS wiring; config + repo registry fetch.

### 2. Understand Components

Read `packages/web/src/components/TaskList.tsx` — task rail with status pills + optional repo label.
Read `packages/web/src/components/NewTaskForm.tsx` — new-task form with model/effort/style/repo selects.
Read `packages/web/src/components/TaskDetail.tsx` — header (badges, usage), action buttons, log, clarify chat.
Read `packages/web/src/components/ClarifyChat.tsx` and `WorkerLog.tsx` — clarify input + streamed event log.

### 3. Understand Types & API

Read `packages/web/src/types.ts` — **manual mirror** of `packages/server/src/types.ts` (every server type change touches this file too).
Read `packages/web/src/api.ts` — REST client (`getConfig`, `listRepos`, `listTasks`, `createTask`, …).

### 4. Understand WebSocket Integration

Read `packages/web/src/useWs.ts` — auto-reconnect hook with exponential backoff (1s→30s), message parsing, connection state.

### 5. Understand Design Tokens

Read `packages/web/src/theme.css` — all CSS variables: frosted-glass surfaces (`--surface`, `--blur`), accent (`--accent`, `--accent-soft`), borders, text, `--status-*` pills, `--radius*`, `--transition`. Never hard-code values.

### 6. Understand Build Config

Read `packages/web/vite.config.ts` — dev server proxy configuration (`/api` and `/ws` → the Fastify port).

### 7. Check Recent Frontend Activity

```bash
git log -8 --oneline -- packages/web/
```

## Output

Summarize (under 250 words):

### Layout
- TaskList rail | TaskDetail pane (single-page, no router)
- Per-task selection drives event/log loading

### Component Patterns
- CSS Modules for styling (`.module.css` files)
- Design tokens via CSS variables (never hard-code hex)
- Manual server↔web type mirror

### Real-Time Architecture
- `useWs` hook with auto-reconnect
- WsEvent types: `snapshot`, `task`, `event`, `partial`
- Partial token-deltas stream into the live log

### Design System
- Frosted-glass dark theme (translucent surfaces + backdrop blur)
- System font stack + mono; `--status-*` pill colors per phase

### Recent Changes
- Last few frontend commits
