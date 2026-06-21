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
