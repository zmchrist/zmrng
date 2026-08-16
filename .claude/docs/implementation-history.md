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

## Galaxy warp loading screen + boot handshake (2026-06-18)
Replaced the static frosted-glass spinner splash with a dependency-free vanilla-JS canvas galaxy loader (`packages/desktop/splash/index.html`): idle star-field loop → click or Enter → 2.5 s warp-dive → white bloom → navigate to React app. Boot flow is now a race-free two-signal handshake: a `Mutex<Boot>` in `main.rs` tracks sidecar-up and splash-ready independently; the splash emits `splash-ready` once its `engine-ready` listener is registered, the health-poll sets sidecar-ready, and Rust emits `engine-ready { port }` exactly once when both flags are true — so an early user click never lands on a dead port. The splash (not Rust) calls `window.location.href`. A JS-side 6 s safety timeout prevents the splash stranding the app. `packages/web/index.html` gains a `#boot-veil` white overlay that fades out on the app's first frame for a seamless cross-navigation handoff. Required: `withGlobalTauri: true` + `macOSPrivateApi: true` in `tauri.conf.json` and the `macos-private-api` feature in `Cargo.toml`.

## Frameless window polish — overlay title bar + collapsible task description (2026-06-18)
Three UI-only changes, no server/type modifications:
1. **Overlay title bar:** `tauri.conf.json` adds `"titleBarStyle": "Overlay"` + `"hiddenTitle": true` — macOS traffic-light controls float over the window glass; the native title strip is removed.
2. **Drag strip:** `App.tsx` / `App.module.css` — a full-width `.dragbar` div (`height: 28px`, `data-tauri-drag-region`) occupies `grid-row 1` spanning both columns; `.app` is now `grid-template-rows: auto 1fr`; `.rail`/`.detail` are pinned to `grid-row 2`. Drag is driven solely by the `data-tauri-drag-region` attribute (WKWebView/Tauri v2 ignores `-webkit-app-region`). Clears the traffic lights and keeps the frameless window draggable. The `.brandbar` header also carries `data-tauri-drag-region` so the visible band is draggable.
3. **Collapsible task description:** `TaskDetail.tsx` — `task.body` defaults collapsed; a `.bodyToggle` button (▾ Show description / ▴ Hide description, `aria-expanded`) reveals/hides it. Usage display for review/done tasks shows a single total-tokens figure (`tokensIn + tokensOut + tokensCache`) instead of a five-item breakdown; `costUsd` and `turns` are still stored on the server but no longer rendered. `TaskUsage` type is unchanged.

## Agent interaction — live chat, hard Stop interrupt, color-coded tool/subagent activity (2026-06-21)
Runner parses previously-dropped `tool_use` (assistant lines) and `tool_result` (user lines) blocks; main-worker tool calls emit `sub:'tool'` events and Task spawns emit `sub:'subagent'`; Task results emit `sub:'subagent_result'` via a bounded `pendingTasks` map. `Runner.interrupt()` writes a `control_request`/`interrupt` stream-json envelope to stdin (ESC-style, no kill). `TaskManager.interrupt()` wraps it and guards the interrupted turn's `result` with a private `interrupting` Set so the failure detector never fails an intentionally stopped task. `message()` gate lifted from clarify-only to all live phases (`clarify|planning|executing|validating`). New REST route `POST /api/tasks/:id/interrupt`. Frontend: `--actor-*` CSS token palette added to `theme.css`; `actorColor()` helper in `status.ts`; `WorkerLog` renders tool/subagent/subagent_result rows color-coded by actor; `ClarifyChat` gains a `placeholder` prop and is shown for all live phases; `TaskDetail` shows a Stop button in autonomous phases and updated autobar copy.

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

## Collapsible left task pane (2026-06-21)
Frontend-only change (`App.tsx`, `App.module.css`). A collapse button in the brandbar (`.brandbarRight`) toggles `railCollapsed` local state (not persisted). Collapsed: `.app` grid first column shrinks from 348 px to 56 px (animated via `--spring`); the rail renders a `.mini` bar with an expand button and a `.miniDots` column of one status-colored dot per task (via `statusColor`/`STATUS_LABEL`), each clickable to select that task; active dot gets an accent ring. No server, type, or route changes.

## Workspace mode — Zed-style collapsible tab panes (2026-08-16)
The Workspace mode's center region is now a draggable Zed-style tab area (`WorkspaceTabs`), replacing the old fixed Viewer-over-WorkerLog stack plus a right rail of collapsible `RailCard`s (Chat + Notes) — the right rail is gone; the layout is a 2-column grid (Files sidebar | tab area). File Viewers (any number open at once), Worker Log, Notes, and Chat are now draggable tabs via native HTML5 drag-and-drop (no new dependency). Panes are capped at 2 on a single split axis — 1 pane, side-by-side, or stacked, never a 2×2 — enforced by a new pure reducer `packages/web/src/workspaceLayout.ts` (`emptyLayout`/`hydrateLayout`/`openFile`/`focusTab`/`closeTab`/`openPanel`/`moveTab`/`splitWith`/`setLogMinimized`/`pruneFileTabs`/`dropIntent`). The Worker Log tab can only be minimized (not closed) while its task is live; it becomes closeable at terminal statuses (`review`/`done`/`failed`/`archived`). New `WorkspaceLayout`/`WsTab`/`WsPane`/`WsSplit`/`WsTabKind` types added to `packages/server/src/types.ts` (source of truth, mirrored in `packages/web/src/types.ts`); `PerTaskUiState` gained an optional `layout` field that round-trips through the existing per-task ui-state persistence — no server logic change. `WorkspaceView.tsx` now owns the layout state (hydrated/pruned/persisted per task) and renders `<WorkspaceTabs>` for the center column instead of Viewer/WorkerLog/Notes/Chat directly; `App.tsx` no longer passes `railCards`/`onRailCardChange` into it.

## Workspace bottom-dock PTY terminal (2026-08-16)
A global Zed-style bottom-dock terminal in the Workspace page, independent of task
selection. New server module `terminal.ts`: a `PtyFactory`/`PtySession`/`PtyCallbacks`/
`PtySpawnOptions` test seam mirroring `runner.ts`, `defaultPtyFactory` wrapping the new
`node-pty` dependency, a pure tolerant `parseClientMsg()`, and a `TerminalManager` class
(`create(cb)` spawns a shell at `config.projectsDir` with `config.shell`, stripping
`ANTHROPIC_API_KEY` under oauth mode; `killAll()` runs from `shutdown()`). New WebSocket
route `GET /ws/terminal` — one PTY per socket, separate from the existing `/ws` fan-out
hub. `Config` gained `projectsDir` (== `PROJECTS_DIR`) and `shell` (`SHELL` env, else
`/bin/sh`). New mirrored types: `TermClientMsg` (`input`/`resize`), `TermServerMsg`
(`data`/`exit`), and `GlobalUiState.terminalDock?: { open?; height? }` (only open/height
persist — shells are ephemeral). Frontend: new pure modules `terminalProtocol.ts`
(encode/parse the wire frames) and `terminalDock.ts` (ephemeral tab-list reducer,
unpersisted by design); new components `Terminal` (xterm.js glue via `@xterm/xterm` +
`@xterm/addon-fit`, one WebSocket per instance, theme-token colors) and `TerminalDock`
(always-visible status-bar toggle, ctrl+` shortcut, tab strip, drag-resize, terminals
mounted only while open, auto-seeds the first terminal only on the closed→open
transition). `WorkspaceView` wraps its 3-column grid plus the dock in a vertical flex
shell so the dock renders regardless of task selection; `App.tsx` derives
`dockOpen`/`dockHeight` from `GlobalUiState.terminalDock` and threads setters through
`patchGlobal`. Known gotcha: `node-pty`'s prebuilt `spawn-helper` binary can lose its
executable bit during npm extraction (fix: `chmod +x` it) — see `.claude/errors.md`.
Desktop-sidecar vendoring of `node-pty`'s native binding is an explicit out-of-scope
follow-up (the public-readiness plan's web-only override applies).
