# Frontend React Conventions

## Stack
- React 19, TypeScript, Vite
- CSS Modules + design tokens (`theme.css`)
- WebSocket for real-time updates (`useWs` hook)
- `@xterm/xterm` + `@xterm/addon-fit` for the Workspace bottom-dock terminal (own
  WebSocket to `/ws/terminal` per instance, not the `useWs` hub connection)
- Standalone agent chat (`ChatPane`) — own WebSocket to `/ws/chat` per instance, same
  own-socket pattern as the terminal, not the `useWs` hub connection
- Local Voice Chat (`VoiceView`) — own WebSocket to `/ws/chat` per enabled session, same
  own-socket pattern as `ChatPane`/`Terminal`; STT/TTS run locally in the browser
  (`@huggingface/transformers`, `kokoro-js`, `@ricky0123/vad-web`) behind the `voice/`
  backend seam — frontend-only, no new server route
- **No router** — single-page layout; two top-level modes, Workspace (default) and Board
- **No shared package** — `packages/web/src/types.ts` is a MANUAL mirror of the server types

## Design System

### Frosted-glass design tokens (NEVER hard-code values)
All colors, blur, radii, and motion live in `packages/web/src/theme.css`:
```css
--surface / --surface-strong / --surface-hover  /* translucent panels */
--blur                                           /* backdrop-filter blur */
--accent / --accent-soft                         /* interactive accent */
--border / --border-strong
--text / --text-dim / --text-faint
--status-backlog / --status-clarify / --status-planning / --status-executing / --status-validating / --status-blocked / --status-review / --status-done / --status-failed  /* --status-building kept for the legacy status */
--actor-main / --actor-frontend-specialist / --actor-backend-specialist / --actor-qa / --actor-code-reviewer / --actor-doc-updater / --actor-general-purpose / --actor-default  /* worker + subagent color-coding */
--radius / --radius-sm / --radius-pill
--transition / --shadow
--font / --font-mono
```
Always use `var(--*)`. Never write raw hex, blur, or radius values. The look is
**frosted glass** (translucent surface + `backdrop-filter: blur(var(--blur))`).

### Typography
System font stack via `--font`; monospace via `--font-mono`. No web fonts.

## Patterns

### CSS Modules
```tsx
import styles from './Component.module.css'
<div className={styles.container}>...</div>
```

### WebSocket Hook
```tsx
import { useWs } from '../useWs'
const { connected } = useWs(onWs) // auto-reconnect, 1s→30s backoff
```
WsEvent types: `snapshot` | `task` | `event` | `partial`. Partial token-deltas
stream into the live log; persisted events arrive as `event`.

### Terminal WebSocket (separate from the `useWs` hub)
`Terminal.tsx` opens its own `WebSocket` directly to `/ws/terminal` per mounted
instance — it does **not** go through `useWs`/the `/ws` fan-out hub, since each
terminal owns a dedicated PTY rather than sharing task/claude event broadcast state.
Frames are encoded/decoded with the pure helpers in `terminalProtocol.ts`
(`encodeInput`/`encodeResize`/`parseServerMsg`), never hand-rolled JSON inline.

### Chat WebSocket (same own-socket pattern as Terminal)
`ChatPane.tsx` opens its own `WebSocket` directly to `/ws/chat` per mounted instance,
mirroring `Terminal.tsx` — not the `useWs` hub, since each chat tab owns a dedicated
`claude` session. Frames are encoded/decoded with the pure helpers in
`chatProtocol.ts` (`encodeStart`/`encodeInput`/`encodeInterrupt`/`parseChatServerMsg`),
never hand-rolled JSON inline.

### Voice WebSocket (same own-socket pattern as Terminal/Chat — no new backend)
`VoiceView.tsx` opens its own `WebSocket` directly to `/ws/chat` per enabled session,
same own-socket pattern as `Terminal.tsx`/`ChatPane.tsx` — not the `useWs` hub. It is a
pure frontend I/O shell layered on the SAME `/ws/chat` route the text Chat pane already
uses (no `/ws/voice`, no server-side voice module): reuses `chatProtocol.ts` for the
wire frames and `chatThread.ts` for the bubble-thread reducer unchanged. Speech I/O
(mic capture, VAD, STT, TTS playback) is entirely local-browser, behind the swappable
`voice/backend.ts` seam (`VoiceBackend.transcribe`/`synthesize`/`warmup`/`ready`/
`sampleRate`/`dispose`) — `voice/localBackend.ts` is the one implementation shipped so
far (transformers.js Whisper + kokoro-js Kokoro-82M, each in its own Web Worker,
WebGPU→WASM fallback). `voiceSentences.ts` buffers streamed `partial` deltas into whole
sentences before handing them to TTS; `voiceTurn.ts` is the pure `idle|listening|
transcribing|thinking|speaking` state machine (freeze rule: ignore `speechEnd` while
speaking; barge-in/stop interrupt semantics). Not yet wired into the Tauri desktop
build (Phase 2, deferred) — Local Voice Chat currently works only in the browser
dev/build target.

### Attachment drop/paste (shared hook, never hand-rolled per composer)
Any composer that accepts image/PDF drop/paste (`NewTaskForm`, `ClarifyChat`,
`ChatPane`) uses the shared `useAttachments()` hook (`useAttachments.ts`) rather than
rolling its own file-reading/validation: spread `onPaste`/`onDrop` from the hook onto
the textarea and render `<AttachmentTray attachments={...} onRemove={...}
error={...} />` beneath it. File validation (`validateFile` in `attachments.ts`) mirrors
the server's `ALLOWED_MEDIA_TYPES`/`MAX_ATTACHMENT_BYTES` — treat it as a fast-fail UX
convenience only; the server's `sanitizeAttachments()` is the real enforcement point, so
never skip re-validating a new attachment-accepting field on the server.

### Type mirror
`packages/web/src/types.ts` mirrors `packages/server/src/types.ts`. When a server
type changes, update this file in the same change — there is no shared package.

### Component Structure
```
packages/web/src/
  App.tsx        — layout + WS wiring + config/repo fetch
  api.ts         — REST client
  useWs.ts       — auto-reconnect WebSocket hook
  status.ts      — statusColor() + actorColor() helpers (--status-* / --actor-* tokens)
  theme.css      — frosted-glass design tokens
  types.ts       — manual mirror of server types
  workspaceLayout.ts — pure reducer for the Workspace mode's per-task Zed-style tab-pane layout (max 2 panes, single split axis); feeds the Viewers card
  gridLayout.ts   — pure, React-free 12-column grid reducer + DOM-free geometry for the Workspace card grid (COLS=12, defaultCards/CARD_IDS, collide/compact, applyMove/applyResize under reflow|swap|free, hideCard/showCard/toggleMinimize, normalizeGrid/hydrateGrid, cellSize/cardRectPx/contentHeightPx); geometry in 12-col CELL units
  dashboardData.ts — pure derivations for the 3 data cards (pipelineCounts/concurrency/reviewQueue)
  cardMeta.ts     — CARD_TITLES + CARD_ACCENTS (per-card var(--*) accent token) maps, shared by WorkspaceGrid and BottomNav
  terminalDock.ts — pure reducer for the bottom-dock's ephemeral tab list, terminal AND chat tabs coexisting in one ordered list (emptyDock/addTab/addTerminal/addChat/closeTerminal/setActive) — module retained; TerminalDock.tsx now orphaned (no importer)
  windowTabs.ts   — pure reducers for the Chat/Terminal grid cards' OWN per-card tab strips (each card owns an independent TabsState<T>, not a shared dock): emptyTabs/closeTab/setActiveTab/nextLabel/addTerminalTab/addChatTab/launchChatTab/setChatTabConfig/hydrateTerminalTabs/hydrateChatTabs. Terminal tabs auto-spawn their PTY on add; chat tabs start launched:false until Launch is pressed
  terminalProtocol.ts — pure wire helpers for /ws/terminal (encodeInput/encodeResize/parseServerMsg)
  chatProtocol.ts — pure wire helpers for /ws/chat (encodeStart/encodeInput/encodeInterrupt/parseChatServerMsg)
  chatThread.ts   — React-free bubble-thread reducer for the standalone chat pane (emptyThread/pushUser/appendPartial/finalizeAssistant/pushToolNote/endTurn/resetThread)
  attachments.ts  — pure image/PDF drop-paste helpers (mimeToKind/validateFile/fileToAttachment/filesFromPaste/filesFromDrop), mirroring the server's allow-list/size limits
  useAttachments.ts — shared hook (attachments/addFiles/remove/clear/error/onPaste/onDrop) used by NewTaskForm, ClarifyChat, and ChatPane
  voiceSentences.ts — pure sentence-buffer for Local Voice Chat (emptyBuffer/push/flush/SentenceBuffer), buffers streamed /ws/chat partial deltas into whole sentences for TTS
  voiceTurn.ts    — pure turn state machine for Local Voice Chat (initialTurn/reduce/VoiceState idle|listening|transcribing|thinking|speaking/VoiceEvent), freeze rule + barge-in/stop semantics
  voice/          — swappable local STT/TTS seam, frontend-only: backend.ts (VoiceBackend interface), localBackend.ts (transformers.js Whisper + kokoro-js Kokoro-82M, each in its own Web Worker, WebGPU→WASM fallback; not unit-tested), sttWorker.ts/ttsWorker.ts (the Web Workers), workerProtocol.ts (shared worker message types), player.ts (PcmPlayer — Web-Audio PCM playback queue with stop() for barge-in)
  themes.ts       — theme catalog (11 themes: one per color + black/white/grey) + pure helpers (buildThemeVars/applyTheme/loadStoredTheme/saveStoredTheme), persisted to localStorage only
  components/     — TaskList (list of all tasks; the selected row expands in place to reveal its lifecycle action buttons + a collapsible metadata dropdown, folded in from the old standalone activetask card), NewTaskForm (title/body + drop-paste attachments), ClarifyChat (live composer, placeholder prop, drop-paste attachments), AttachmentTray (thumbnail strip for a composer's pending attachments — image previews, PDF chip, remove + error), WorkerLog (read-only tool/subagent rows), WorkerLogPanel (WorkerLog + steer composer, forwards attachments), WorkspaceView (now just composes `<WorkspaceGrid/>` + `<BottomNav/>`; still owns the per-task WorkspaceLayout + file-tree/agents fetches, fed into the Files + Viewers cards via a card content map — the old Files-sidebar/center-pane/task-rail/TerminalDock plumbing is gone), WorkspaceGrid (the card-grid host: ResizeObserver for grid width + pointer move/resize handlers calling the pure gridLayout reducer, drag ghost + scroll spacer; socket-owning cards (terminal/chat/viewers) stay mounted `display:none` while hidden so the session survives hide→show; not unit-tested — pointer/RO glue), GridCard (presentational card chrome — ⠿ drag-handle header + title + minimize/hide + corner resize handle + body, body `display:none` when minimized), BottomNav (static bottom nav bar — Cards show/hide menu, density/card-style/interaction selects, Settings toggle, connection dot), PipelineCard/ConcurrencyCard/ReviewQueueCard (the 3 data cards, fed by dashboardData.ts, shared DashboardCards.module.css), WorkspaceTabs (draggable tabs — file Viewers/WorkerLogPanel/Notes/Chat; now rendered inside the Viewers card), TerminalDock (orphaned — no importer; Zed-style bottom dock + bottom nav bar of Terminal/Chat/Tasks/Workspace/Settings pane toggles, `+💬` new-chat tab-strip affordance, ctrl+` toggle, drag-resize), TabStrip (presentational tab strip shared by ChatCard/TerminalCard — click-to-focus tabs + × close + a trailing + add button, state lives in the caller), ChatCard (wraps the Chat grid card's `windowTabs.ts` state in a TabStrip; a new tab starts unlaunched behind a model/effort/style picker + Launch button, only mounting ChatPane once pressed; tabs stay mounted `display:none` while inactive), TerminalCard (wraps the Terminal grid card's `windowTabs.ts` state in a TabStrip; a new tab auto-spawns its PTY immediately on +, no gating; same stay-mounted policy), ChatPane (standalone agent-chat bubble thread rendered inside a ChatCard tab, one WebSocket per instance to /ws/chat, optional initialModel/initialEffort/initialStyle props seeded by the launching tab's picker, Stop button while busy, drop-paste attachments), SettingsModal (ephemeral focused overlay; theme dropdown selector + live preview swatch + dark/light toggle, backed by `themes.ts`), Terminal (xterm.js glue rendered inside a TerminalCard tab, one WebSocket per instance), VoiceView (Local Voice Chat shell — one /ws/chat WebSocket per enabled session, own-socket pattern mirroring ChatPane/Terminal; owns the mic VAD + the voice/ ML backend seam; not unit-tested — mic/VAD/socket/worker glue)
```

## Anti-Patterns

### Hard-coding Colors / blur / radius
```css
/* BAD */ .card { background: rgba(38,41,47,0.5); backdrop-filter: blur(14px); }
/* GOOD */ .card { background: var(--surface); backdrop-filter: blur(var(--blur)); }
```

### setState inside useEffect
ESLint enforces `react-hooks/set-state-in-effect`. Don't sync state in an effect —
derive it during render instead:
```tsx
// BAD
useEffect(() => { if (!repoId && defaultRepoId) setRepoId(defaultRepoId) }, [...])
// GOOD
const effectiveRepoId = repoId || defaultRepoId
```

### Nested Interactive Elements (Accessibility)
```tsx
// BAD  <a href="..."><button>Open</button></a>
// GOOD <a href="..." className={styles.linkBtn}>Open</a>
```

### Using `any` Type
Use proper types from `./types`. Mirror new shapes from the server.

### Inline Styles Over CSS Modules
Prefer CSS Modules. Two sanctioned inline style uses exist:
1. Status pill `color` driven by `statusColor(status)` (`var(--status-<s>)`).
2. Actor accent `color` / `borderLeftColor` driven by `actorColor(actor)` (`var(--actor-<slug>)` for
   known actors, `var(--actor-default)` otherwise) — used in WorkerLog's tool/subagent rows.
Follow these precedents only when the value is genuinely dynamic.

## Accessibility
- No nested interactive elements
- All interactive elements keyboard accessible
- Sufficient contrast on translucent surfaces
- Semantic HTML elements
