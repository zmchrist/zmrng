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
backlog ─Start─▶ clarify ─READY─▶ planning ─PLAN_READY─▶ executing ─VALIDATING─▶ validating ─PR url─▶ review ─Done─▶ done
                (you answer Qs)   └─────── full auto: plan → implement → QA/review/docs, no stops ───────┘      (review on GitHub)
```
A worker that needs a missing subagent emits `ZMRNG_BLOCKED: <reason>` and parks in `blocked` until the operator resumes it. `building` is a legacy single-phase status, retained only for old DB rows/events.

## ⚠️ App-only focus (operator directive) — **SUSPENDED for the public-readiness plan**
> **OVERRIDE (2026-07-27):** for the duration of
> `.agents/plans/public-readiness-and-harness-productization.md` this rule is
> **suspended**. That plan is **web-interface only** — `npm run build` + `npm start`
> (or `npm run dev`) is the whole story. **Do not run `npm run desktop:build`** to
> "finish" work, and do not touch `packages/desktop`, the splash, the Tauri Rust
> code, or sidecar bundling. The shipped `.app` will carry a stale bundled copy of
> `server/dist` + `web/dist` throughout the plan; that is expected, not a bug. The
> app-only rule below **resumes** once the plan lands and the app is re-bundled as a
> separate follow-up.

**(Original rule, kept for reference — resumes after the plan above.)**
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
- **Terminal:** `node-pty` PTY sessions over `GET /ws/terminal` + `@xterm/xterm`, surfaced
  as the Workspace grid's Terminal card
- **Frontend:** React 19 + Vite, CSS Modules + design tokens (frosted-glass theme)
- **Language:** TypeScript throughout (ESM, `NodeNext`/`bundler` resolution)
- **No cloud.** Tests run on **Vitest** (both workspaces) — validate with
  `npm run typecheck && npm run lint && npm test && npm run build`

## Project structure
```
zmrng/
├── packages/
│   ├── server/
│   │   └── src/
│   │       ├── index.ts        — Fastify bootstrap: REST routes + WS + static serve
│   │       ├── config.ts       — env parsing, repo registry (config/repos.json → env → legacy)
│   │       ├── db.ts           — SQLite schema, prepared statements, idempotent migrations
│   │       ├── types.ts        — Task/Phase/WsEvent/usage/WorkspaceLayout/Attachment types (SOURCE OF TRUTH); also `ALLOWED_MEDIA_TYPES`/`MAX_ATTACHMENTS`/`MAX_ATTACHMENT_BYTES` consts for the image/PDF drop-paste feature
│   │       ├── runner.ts       — spawn + parse the claude child (stream-json), strip API key; `buildUserMessage(text, attachments?)` builds the multimodal stream-json user turn (image/document blocks before the text block), `sanitizeAttachments(raw)` is the tolerant allow-list/size/count guard shared by the REST routes and `/ws/chat`
│   │       ├── terminal.ts     — TerminalManager: spawns node-pty shells for the Workspace bottom-dock terminal (GET /ws/terminal), strips API key under oauth
│   │       ├── chatAgent.ts    — ChatManager: owns live standalone-chat `claude` Runners (GET /ws/chat) via the same RunnerFactory seam as TaskManager; chatSystemPrompt() (conversational, non-worker prompt) + parseChatClientMsg() (tolerantly accepts an `attachments` field on `input` frames, via `sanitizeAttachments`)
│   │       ├── phases.ts       — phase state machine + system/kickoff prompts + lane queue; holds new-task-box attachments in a `pendingAttachments` Map, consumed once at the first clarify send in `start()`; `executeKickoff` carries a conditional UI-screenshot step (UI-touching diffs → capture the changed view(s) via Playwright MCP, commit PNG(s) under `.github/pr-screenshots/<branch-slug>/`, post a separate `gh pr comment` before the final PR-URL line; best-effort, skipped not blocked when the browser tools are absent)
│   │       ├── worktree.ts     — git worktree create/remove per task
│   │       └── ws.ts           — WebSocket broadcast hub
│   └── web/
│       └── src/
│           ├── main.tsx        — React root
│           ├── App.tsx         — layout: topbar (drag region + mode tabs) over two top-level modes, **Workspace** (default home) and **Board**; the standalone Tasks pane is merged into Workspace (legacy `'tasks'` mode value still accepted from persisted UI state and migrated → `'workspace'`; selecting a task from the Board routes to Workspace). App owns tasks/selection/WS wiring; sources the card-grid layout from `GlobalUiState.grid` via `hydrateGrid` and persists it via `patchGlobal({grid})`, threads `connected` down (the retired pane/dock/rail/notes/split props are no longer threaded)
│           ├── theme.css       — frosted-glass design tokens
│           ├── api.ts          — REST client
│           ├── useWs.ts        — auto-reconnect WebSocket hook
│           ├── types.ts        — MANUAL MIRROR of server/src/types.ts (incl. GridCardId/GridDensity/GridCardStyle/GridInteraction/GridCardGeo/GridState + the `grid?: GridState` field on GlobalUiState — server round-trips it, never validates)
│           ├── status.ts       — statusColor() + actorColor() helpers (backed by --status-* / --actor-* tokens)
│           ├── workspaceLayout.ts — pure reducer for the Workspace mode's per-task Zed-style tab-pane layout (emptyLayout/hydrateLayout/openFile/focusTab/closeTab/openPanel/moveTab/splitWith/setLogMinimized/pruneFileTabs/dropIntent); enforces panes.length ∈ {1,2} and a single split axis; still owned by WorkspaceView, now fed into the Viewers card
│           ├── gridLayout.ts   — pure, React-free 12-column grid reducer + DOM-free geometry for the Workspace card grid (`COLS=12`, `defaultCards`/`CARD_IDS` 11-card seed, `collide`/`compact`, `applyMove`/`applyResize` under reflow|swap|free interaction modes, `hideCard`/`showCard`/`toggleMinimize`, `normalizeGrid`/`hydrateGrid` tolerant merge, `cellSize`/`cardRectPx`/`contentHeightPx`); geometry is in 12-col CELL units (screen-width-independent). Mirrors the pure-reducer style of workspaceLayout.ts / terminalDock.ts
│           ├── dashboardData.ts — pure derivations feeding the 3 data cards: `pipelineCounts(tasks)`, `concurrency(tasks, maxLanes)`, `reviewQueue(tasks)`
│           ├── cardMeta.ts     — `CARD_TITLES` + `CARD_ACCENTS` (per-card `var(--*)` accent token) string maps, shared by WorkspaceGrid and BottomNav
│           ├── terminalDock.ts — pure reducer for the bottom-dock terminal's ephemeral tab list (emptyDock/addTerminal/closeTerminal/setActive) — only open/height persist, tabs never do (module retained; TerminalDock.tsx now orphaned, no importer)
│           ├── terminalProtocol.ts — pure wire-protocol helpers for `/ws/terminal` (encodeInput/encodeResize/parseServerMsg)
│           ├── chatProtocol.ts — pure wire-protocol helpers for `/ws/chat` (encodeStart/encodeInput/encodeInterrupt/parseChatServerMsg)
│           ├── chatThread.ts   — React-free bubble-thread reducer for the standalone chat pane (emptyThread/pushUser/appendPartial/finalizeAssistant/pushToolNote/endTurn/resetThread)
│           ├── attachments.ts  — pure DOM-free-ish helpers for image/PDF drop-paste: mimeToKind/validateFile (mirrors server ALLOWED_MEDIA_TYPES/MAX_ATTACHMENT_BYTES)/fileToAttachment (FileReader → base64, no data-URL prefix)/filesFromPaste/filesFromDrop
│           ├── useAttachments.ts — shared attachment state + paste/drop handlers for the three composers (NewTaskForm, ClarifyChat, ChatPane): addFiles (validate + read, capped at MAX_ATTACHMENTS)/remove/clear/error/onPaste/onDrop
│           ├── usePanelMount.ts — hook that keeps a conditionally-rendered panel mounted for `--panel-duration` past a toggle-to-closed, so its CSS closing (minimize) animation can play before unmount; used by every toggleable "window" (Files sidebar, Workspace center pane, task rail, terminal dock body, Settings modal)
│           ├── themes.ts       — theme catalog (11 themes: one per color + black/white/grey) + pure helpers (`buildThemeVars`/`applyTheme`/`loadStoredTheme`/`saveStoredTheme`); each theme has a dark + light accent pair, swapped via CSS custom properties set on the document root; persisted to localStorage only (`zmrng-theme` key), no server involvement
│           └── components/      — TaskList, NewTaskForm (title/body + drop/paste image-PDF attachments via `useAttachments` + `AttachmentTray`; an image-only task is valid — title still required), ClarifyChat (live composer with `placeholder` prop; same drop/paste attachment wiring as NewTaskForm), AttachmentTray (thumbnail strip for pending attachments — inline image previews, a generic PDF chip, per-item remove + a validation-error line; purely presentational, state lives in `useAttachments`), WorkerLog (read-only tool/subagent/subagent_result rows color-coded by actor), WorkerLogPanel (WorkerLog + the ClarifyChat steer composer, shown in live phases — the channel that replaced TaskDetail's inline composer; forwards `attachments` through its `onMessage` to `message()`), TaskControls (compact selected-task card in the Workspace right bar: title + status pill + lifecycle buttons always visible, repo/flow/model/effort/style/description/usage behind a dropdown), WorkspaceView (the merged home, now reduced to composing `<WorkspaceGrid/>` + `<BottomNav/>`; still owns the per-task `WorkspaceLayout` (hydrate/openFile/prune) + the file-tree fetch + the agents fetch, fed into the Files + Viewers cards via a card content map. The old locked-left Files sidebar / center pane / right task rail / Files-Notes split / TerminalDock plumbing was removed from this component), WorkspaceGrid (the card-grid host: a `ResizeObserver` tracks grid width and pointer move/resize handlers call the pure `gridLayout.ts` reducer; renders a drag ghost + scroll spacer and each non-hidden card. Cards that own a live socket/session — terminal, chat, viewers — stay MOUNTED while hidden (`display:none`), never unmounted, so the session survives hide→show. Intentionally NOT unit-tested — pointer/RO glue, same policy as the other drag handlers), GridCard (presentational card chrome: ⠿ drag-handle header + title + minimize/hide buttons + corner resize handle + body; body always mounted, `display:none` when minimized), BottomNav (`BottomNav.module.css`) (the static bottom nav bar: Cards show/hide menu, density/card-style/interaction `<select>`s, Settings toggle, connection dot), PipelineCard / ConcurrencyCard / ReviewQueueCard (`DashboardCards.module.css`) (the 3 data cards, fed by `dashboardData.ts`), WorkspaceTabs (draggable tabs for file Viewers/WorkerLogPanel/Notes/Chat — max 2 panes, single split axis, native HTML5 drag-and-drop; now rendered inside the Viewers card), TerminalDock (`terminalDock.ts`/`NotesPanel` likewise remain in the tree but are now orphaned — no importer — with their tests still passing, kept per the plan), ChatPane (standalone agent-chat bubble thread — one WebSocket per instance to `/ws/chat`, mirrors Terminal.tsx not the useWs hub; per-tab model/effort/style selects default sonnet/medium/caveman-full, a config change respawns the session + resets the thread; Stop button while a turn is in flight; ephemeral, no DB persistence; same drop/paste attachment wiring as NewTaskForm/ClarifyChat, sent via `encodeInput(text, attachments)`), SettingsModal (ephemeral focused overlay with a dimmed backdrop, animates open/close via `usePanelMount`; a theme dropdown selector (native `<select>` of the 11 theme names + a live preview swatch) + sun/moon dark/light toggle backed by `themes.ts` and persisted to localStorage, plus a Reboot control — `POST /api/restart` ff-only `git pull`s zmrng's own repo to `origin/main`, runs `npm run build`, then (dev only) touches the server entry to trigger a tsx-watch respawn; always visible, no `cfg?.dev` gate), Terminal (xterm.js glue — one WebSocket per instance to `/ws/terminal`, theme-token colors, ResizeObserver fit)
│   └── desktop/                — Tauri desktop shell (wraps the server as a sidecar)
│       ├── scripts/bundle-sidecar.mjs  — esbuild server + vendor sqlite/node + web/dist
│       ├── splash/index.html   — galaxy-warp canvas loader (vanilla JS, no build); click/Enter → warp-dive → white-bloom → navigate to app; two-signal boot handshake: splash emits `splash-ready`, Rust emits `engine-ready {port}` once both sidecar + splash are ready; requires `withGlobalTauri: true` in tauri.conf.json
│       └── src-tauri/          — Rust shell: Cargo.toml (`macos-private-api` feature), tauri.conf.json (`withGlobalTauri`, `macOSPrivateApi`, `titleBarStyle: "Overlay"`, `hiddenTitle: true` — overlay traffic lights, no title strip), src/main.rs (Boot handshake, Emitter/Listener)
├── config/
│   ├── repos.json              — repo registry (gitignored; machine-specific paths)
│   └── repos.example.json      — committed template
├── worktrees/                  — per-task git worktrees (gitignored)
├── .claude/                    — this harness (rules, commands, agents, skills, docs, files)
└── .agents/                    — PIV artifacts (plans, tasks, reviews, handoffs) + loop.sh
```

## Inherits the universal Projects harness
zmrng lives inside a universal Projects workspace and **inherits** the universal
Projects harness one level up (the `CLAUDE.md` in the parent Projects directory):
the PIV loop and the three hooks
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
pills and `--actor-*` hues for color-coding the main worker and subagents by type).
Always use `var(--*)`. System font stack (`--font`) + mono (`--font-mono`).

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

### Done = local sync after the GitHub merge (never auto-push to main)
The worker still finishes autonomous work by pushing its branch and opening a **PR** —
zmrng never merges or pushes to `origin/main` itself. The operator reviews and merges the
PR on GitHub. Clicking **Done** then reconciles the *local* checkout so it stops drifting
from the merged remote: `done()` removes the worktree, fast-forwards the local default
branch to `origin/<default>`, and deletes the merged feature branch. All of this is
**safe + best-effort** (`syncLocalAfterMerge` in `worktree.ts`): `fetch` always; update
the default branch **fast-forward only** (skip + warn if the working tree is dirty or
non-ff); delete the branch with `git branch -d` only (a squash/rebase-merged PR's branch
is *kept*, never force-deleted). Each step emits a `local sync — …` note to the operator
log. Never force-push, never stash, never touch uncommitted work.

### TypeScript / logging
TS strict, no `any` (use the tolerant `asRecord`/`asString` helpers in `runner.ts` for
untyped stream-json). Pino structured logging (`app.log.info({ code }, 'msg')`) — never
string interpolation, never `console.log` in server code.

## Key services
See `.claude/docs/services-reference.md` for full method signatures and behavior.

- **Runner** (`packages/server/src/runner.ts`) — wraps one `claude` child per task;
  spawns with stream-json in/out, parses session/assistant/partial/result/tool_use/tool_result
  lines, exposes `send(text, attachments?)`/`interrupt()`/`kill()`; strips
  `ANTHROPIC_API_KEY`. Two new callbacks: `onToolUse(name, summary, isSubagent,
  subagentType?)` (main-worker tool calls and Task spawns) and `onSubagentResult(subagentType,
  summary, isError)` (Task results via a bounded `pendingTasks` map). `interrupt()` writes a
  `control_request`/`interrupt` stream-json envelope to stdin without killing the child.
  Exported `buildUserMessage(text, attachments?)` builds the outbound stream-json `user`
  message — image/document content blocks (from operator drop/paste attachments) ahead of
  the text block — and exported `sanitizeAttachments(raw)` is the tolerant allow-list
  (`ALLOWED_MEDIA_TYPES`) + per-file size (`MAX_ATTACHMENT_BYTES`, 8MB) + count
  (`MAX_ATTACHMENTS`, 10) guard shared by the REST create/message routes and the
  `/ws/chat` input frame; a bad entry is dropped, never a 500. Attachments are transient —
  never written to disk or the DB.
- **TaskManager / phases** (`packages/server/src/phases.ts`) — phase state machine
  (backlog→clarify→planning→executing→validating→review→done/failed, plus `blocked`),
  per-phase fresh sessions + kickoff prompts, control-token detection (`ZMRNG_READY`,
  `ZMRNG_PLAN_READY`, `ZMRNG_VALIDATING`, `ZMRNG_BLOCKED`, PR-URL), execute-lane cap + queue.
  `message()` gate lifted to all live phases (`clarify|planning|executing|validating`).
  New public `interrupt(taskId)` hard-stops the current turn (ESC-style); a private
  `interrupting` Set suppresses the interrupted turn's `result` from triggering a task
  failure. `interrupting` is cleaned up in `fail/done/cancel/onPr`. `createTask(...)` takes
  an optional trailing `attachments?: Attachment[]` (a new-task-box image/PDF drop/paste),
  held in a `pendingAttachments` Map and consumed once — at the first clarify send inside
  `start()` — so a re-start after a fail never double-injects them. `message(taskId, text,
  attachments?)` also takes an optional `attachments?: Attachment[]`, forwarded to
  `runner.send()` and logged with a `[n attachment(s)]` suffix. `executeKickoff` (plan
  flow only, not `directKickoff`) also instructs a conditional final-state UI screenshot:
  UI-touching diffs capture the changed view(s) with the Playwright MCP browser tools,
  commit the PNG(s) under `.github/pr-screenshots/<branch-slug>/`, and post them as a
  separate `gh pr comment` before printing the PR URL — best-effort (skipped and noted
  under Testing, never `ZMRNG_BLOCKED`, when the browser tools are unavailable).
- **Db** (`packages/server/src/db.ts`) — SQLite (WAL), `tasks` + `events` schema,
  prepared statements, idempotent `ensureColumns()` migration, atomic `addUsage()`.
- **Config** (`packages/server/src/config.ts`) — env + repo registry: explicit
  (config/repos.json → `ZMRNG_REPOS` env → legacy `ZMRNG_TARGET_REPO`) merged with an
  auto-scan of `ZMRNG_PROJECTS_DIR` (every git-repo-root under it) plus a zmrng self
  entry; default repo is zmrng unless `ZMRNG_DEFAULT_REPO` pins another. `repoById()`.
- **Worktree** (`packages/server/src/worktree.ts`) — `git worktree add` per task, base
  ref resolved `origin/<branch>` → local `<branch>` → `HEAD` for local-only repos.
- **WsHub** (`packages/server/src/ws.ts`) — fan-out broadcast of task + claude events.
- **TerminalManager** (`packages/server/src/terminal.ts`) — owns the Workspace bottom-dock
  PTY sessions; `create(cb)` spawns a shell at `config.projectsDir` with `config.shell` via
  a swappable `PtyFactory` (mirrors the runner-factory test seam), strips
  `ANTHROPIC_API_KEY` under oauth mode, self-removes from the tracked `Set` on exit;
  `killAll()` tears every session down on shutdown. Pure `parseClientMsg()` tolerantly
  decodes client `input`/`resize` frames.
- **ChatManager** (`packages/server/src/chatAgent.ts`) — owns the live standalone
  agent-chat sessions behind `GET /ws/chat`, one per socket; `create(cfg, cb)` spawns a
  conversational `claude` at `config.projectsDir` via the same `RunnerFactory` seam
  `TaskManager` uses (so tests never spawn a real `claude`), self-removes from the
  tracked `Set` on exit; `killAll()` tears every session down on shutdown.
  `chatSystemPrompt(style, projectsDir)` is a deliberately non-worker prompt — no task,
  branch, PR, or control-token protocol, just a helpful assistant with read/explore
  filesystem access, reusing the exported `styleDirective` from `phases.ts` for the
  caveman register. `parseChatClientMsg()` tolerantly decodes client `start`/`input`/
  `interrupt` frames (mirrors `terminal.ts`'s `parseClientMsg`); an `input` frame's
  `attachments` field is run through `sanitizeAttachments()` too, so a malformed/oversized
  entry is silently dropped rather than reaching the runner. Distinct from the
  existing per-task `/api/tasks/:id/chat` REST chat (`chat.ts`) — this one is
  task-independent and never touches the DB.
- **Fastify server** (`packages/server/src/index.ts`) — REST surface includes
  `GET /api/config`, `GET /api/repos`, `GET /api/tasks`, `POST /api/tasks`,
  `POST /api/tasks/:id/{start,message,interrupt,resume,done,cancel}`, `GET /api/tasks/:id/events`
  (see `.claude/docs/services-reference.md` for the full, current route list — it has grown
  since this line was last trimmed). `bodyLimit` is raised to 32MB (from Fastify's 1MB
  default) so base64 image/PDF attachments fit in a POST body; `POST /api/tasks` and
  `POST /api/tasks/:id/message` both run `body.attachments` through `sanitizeAttachments()`
  — a title-only or image-only task/message is valid (no text required once an attachment
  is present). WS: `GET /ws` (task/claude event fan-out),
  `GET /ws/terminal` (one PTY per socket, via `TerminalManager`), and `GET /ws/chat` (one
  standalone chat `claude` session per socket, via `ChatManager`). Static serve of
  `web/dist`. `shutdown()` calls `manager.shutdown()`, `terminals.killAll()`, and
  `chats.killAll()`.
- **useWs** (`packages/web/src/useWs.ts`) — auto-reconnect WebSocket hook (1s→30s backoff).

## Commands
```bash
# Install
npm install

# Development
npm run dev:server       # Fastify server (tsx watch)
npm run dev:web          # Vite dev server
npm run dev              # both
#
# DEV LOOP — view http://localhost:5174 (Vite), NOT :4500. `npm run dev` runs
# BOTH watchers: Vite (:5174, HMR — web edits/merges hot-reload instantly, no
# rebuild, no browser cache) and tsx watch (:4500, server edits auto-restart
# ~1.6s). Vite proxies /api + /ws to :4500. To pick up merged code automatically,
# just keep `npm run dev` running and browse :5174 — never `npm run build` in dev.
# `npm run build` only refreshes web/dist for the shipped app; it does NOT restart
# a running server or bust browser cache, so it's the wrong tool for a dev loop.
# Pitfall: `npm start`/a bare-built server on :4500 has NO watcher — merges land on
# disk but nothing reloads and the browser serves a stale cached bundle (looks dead).

# Build & validate
npm run build            # tsc (server) + vite build (web)
npm run typecheck        # tsc --noEmit, both workspaces
npm run lint             # ESLint, both workspaces
npm test                 # Vitest run, both workspaces
npm run test:watch       # Vitest watch, both workspaces
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
  `frontend-react.md`, `error-handling.md`, `testing.md`, `planning-workflow.md`,
  `worktree-location.md`, `coding-lifecycle.md`.
- **Tier 3 — reference docs** (`.claude/docs/`): `services-reference.md`,
  `implementation-history.md`. Plus `.claude/files/` (PROJECT_CONTEXT, FUTURE_IDEAS) and
  `.claude/errors.md` (known gotchas — check before debugging).

## Resolved (don't re-ask)
- Engine is the real `claude` binary via `child_process` (ToS-compliant; never proxy the token).
- Max OAuth only — `ANTHROPIC_API_KEY` stripped from worker env.
- No shared package — server↔web types are a manual mirror.
- Frosted-glass theme; Vitest across both workspaces (typecheck+lint+test+build is validation).
- Worktrees live under the **target repo's own** `worktrees/` dir (e.g. `<repo.path>/worktrees/<shortId>`), not a global dir. That dir should be gitignored in each target repo.
- Build-lane cap via `ZMRNG_MAX_LANES` (default 2); extra READY tasks queue.
- Workspace mode is a **customizable 12-column draggable/resizable card grid** (11-card
  roster: pipeline, concurrency, reviewqueue, newtask, activetask, workerlog, tasklist,
  files, viewers, chat, terminal). Grid geometry is in 12-col CELL units
  (screen-width-independent), persisted globally in `GlobalUiState.grid` (server
  round-trips, never validates). The pure reducer + geometry live in
  `packages/web/src/gridLayout.ts`; interaction modes are reflow|swap|free. Terminal + Chat
  seed hidden; cards that own a live socket/session (terminal/chat/viewers) stay mounted
  (`display:none`) while hidden so the session survives hide→show. The retired
  GlobalUiState pane/dock/rail/split fields are kept in the type for back-compat with
  already-persisted docs; `TerminalDock.tsx`/`terminalDock.ts` and `NotesPanel.tsx` remain
  as orphaned modules (no importer, tests still pass).
- Workspace bottom-dock terminal shells are ephemeral (never persisted) — only the dock's
  `open`/`height` chrome round-trips through `GlobalUiState.terminalDock`. Desktop-sidecar
  vendoring of `node-pty`'s native binding is an explicit out-of-scope follow-up (the
  public-readiness plan's web-only override applies here too).
- Standalone chat-panel sessions (`/ws/chat`, `ChatManager`) are equally ephemeral — no
  DB persistence, no task lifecycle — and independent of the pre-existing per-task
  `/api/tasks/:id/chat` REST chat (`chat.ts`); the two are separate features that happen
  to share the word "chat".
- Image/PDF drop-paste attachments (`Attachment`/`AttachmentKind` in `types.ts`) are
  equally ephemeral — never written to disk or the DB, held only long enough to build one
  outbound stream-json `user` message (`buildUserMessage`), then discarded. The
  allow-list/size/count limits (`ALLOWED_MEDIA_TYPES`/`MAX_ATTACHMENT_BYTES`/
  `MAX_ATTACHMENTS`) live once in `packages/server/src/types.ts` and are mirrored into
  `packages/web/src/types.ts` like every other shared type; `sanitizeAttachments()` is the
  single server-side enforcement point (REST + `/ws/chat`), `validateFile()` in
  `packages/web/src/attachments.ts` is the client-side mirror for fast feedback before a
  file is even uploaded.
