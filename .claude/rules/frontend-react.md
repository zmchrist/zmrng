# Frontend React Conventions

## Stack
- React 19, TypeScript, Vite
- CSS Modules + design tokens (`theme.css`)
- WebSocket for real-time updates (`useWs` hook)
- `@xterm/xterm` + `@xterm/addon-fit` for the Workspace bottom-dock terminal (own
  WebSocket to `/ws/terminal` per instance, not the `useWs` hub connection)
- Standalone agent chat (`ChatPane`) — own WebSocket to `/ws/chat` per instance, same
  own-socket pattern as the terminal, not the `useWs` hub connection
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
(`encodeAttach`/`encodeInput`/`encodeResize`/`parseServerMsg`), never hand-rolled JSON
inline. The PTY itself now survives a transient socket drop: `Terminal.tsx` runs a
reconnect loop with backoff and always sends `attach` with its stored `sessionId` (from
`localStorage`, `zmrng-term-<tabId>`) first, so a reconnect within the server's grace
window reattaches to the same session and replays missed output rather than spawning a
fresh shell. On a phone, `Terminal.tsx` also owns non-passive `touchstart`/`touchmove`/
`touchend` listeners on the xterm host for pinch-to-resize and flick-scroll-with-momentum
(arithmetic in `terminalTouch.ts`) — separate from the socket, but gated the same way as
the rest of the phone-only behavior (`useIsMobile()` / a `@media (max-width: 768px)`
block).

### Chat WebSocket (same own-socket pattern as Terminal)
`ChatPane.tsx` opens its own `WebSocket` directly to `/ws/chat` per mounted instance,
mirroring `Terminal.tsx` — not the `useWs` hub, since each chat tab owns a dedicated
`claude` session. Frames are encoded/decoded with the pure helpers in
`chatProtocol.ts` (`encodeStart`/`encodeInput`/`encodeInterrupt`/`parseChatServerMsg`),
never hand-rolled JSON inline.

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
  api.ts         — REST client; every call goes through one auth-aware `send()` (same-origin rides the httpOnly session cookie, cross-origin rides `Authorization: Bearer`), and a 401 clears that origin's session and throws `AuthError` (`isAuthError(err)`) so a surface re-shows its login pane instead of rendering a raw HTTP message
  auth.ts        — pure, React-free ORIGIN-KEYED session store (localStorage only): loadSession/saveSession/clearSession/isSessionExpired/authHeaders(origin) + loginToOrigins(origins, username, password, post). Origin-keyed because a session is issued by ONE server and the desktop app talks to two (local sidecar for the KB, VPS for Team); `loginToOrigins` dedupes the list and POSTs the same credentials to each in parallel, so the operator types their password once. A partial failure still stores the origin that succeeded
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
  mobileNav.ts    — pure phone-navigation model (MOBILE_VIEWS / MobileNavState / toggleDrawer / closeDrawer / selectView / modeForView / workspaceViewFor / viewForMode). Below the 768px phone breakpoint the Workspace split collapses to ONE full-screen view at a time, picked from the hamburger drawer
  teamNav.ts      — pure Team-tab navigation model (RailTab 'channels'|'roster' / TeamPane 'list'|'thread' / loadOpenChannelId / saveOpenChannelId / initialPane / resolveOpenChannelId). The rail's channels and roster lists are TABS, one at a time, on desktop and phone alike; below 768px the rail and the thread are two full-screen panes. The open channel id persists to localStorage (zmrng-team-open-channel) on both shells
  mobileTaskPanel.ts — pure phone-only helper behind the Tasks / Worker view's swipe-to-hide task panel (SWIPE_THRESHOLD_PX / beginSwipe / resolveSwipe / loadTasksCollapsed / saveTasksCollapsed). Swipe up on the handle collapses the task list, swipe down or tap restores it; the flag is one global setting persisted to localStorage (zmrng-mobile-tasks-collapsed)
  useIsMobile.ts  — useSyncExternalStore over matchMedia(MOBILE_QUERY = '(max-width: 768px)'); true while the viewport is phone-sized
  terminalKeys.ts — TERMINAL_KEYS (row 1: Esc/Tab/sticky Ctrl+Alt/arrows/shell symbols) + TERMINAL_KEYS_EXTRA (collapsed row 2: Home/End/PgUp/PgDn/F1-F12) + ctrlSeq()/altSeq()/modSeq() for the phone terminal's on-screen key bar
  keyboardInset.ts — the phone soft-keyboard inset: KEYBOARD_MIN_INSET, pure keyboardInset(m)/barOffset(inset, gapBelowPx), and useKeyboardInset() (useSyncExternalStore over visualViewport resize+scroll, same shape as useIsMobile.ts) — iOS overlays the keyboard instead of shrinking the layout viewport, so Terminal.tsx pads its wrap by this to keep the key bar and cursor line above it
  terminalFont.ts — terminal font-size store (DEFAULT/MIN/MAX_TERMINAL_FONT_SIZE, clampFontSize/pinchFontSize/getFontSize/setFontSize/subscribeFontSize), modelled on opacity.ts but with a subscribe/notify layer so a pinch in one mounted terminal tab reaches every other one live; localStorage-only (zmrng-term-font)
  terminalTouch.ts — DOM-free arithmetic for the phone terminal's touch gestures: pinchDistance/pinchScale, flickVelocity/momentumStep (with FLICK_WINDOW_MS/MOMENTUM_FRICTION/MOMENTUM_MIN_VELOCITY), scrollLinesFor, longPressMoved/clampMenuPosition (LONG_PRESS_SLOP_PX) for the Paste/Copy menu
  useAttachments.ts — shared hook (attachments/addFiles/remove/clear/error/onPaste/onDrop) used by NewTaskForm, ClarifyChat, and ChatPane
  themes.ts       — theme catalog (11 themes: one per color + black/white/grey) + pure helpers (buildThemeVars/applyTheme/loadStoredTheme/saveStoredTheme), persisted to localStorage only
  opacity.ts      — Window-opacity control (Settings → Window opacity): pure helpers (clampOpacity/loadStoredOpacity/saveStoredOpacity/applyOpacity) setting the --surface-opacity multiplier that scales only the frosted-glass panel alphas (theme.css --surface/--surface-strong/--well/--well-strong), 0–100% (default 100), localStorage-only (zmrng-opacity), applied at boot in main.tsx
  mentions.ts     — pure, DOM-free helpers for the Team chat @-mention UX: mentionCandidates(members, botHandle)/activeMention(text, caret)/filterCandidates(candidates, query)/applyMention(text, start, caretEnd, name)/parseMentions(body, names); types MentionCandidate/MentionSegment. Word-boundary matching mirrors the server's detectMention rule; frontend-only visual autocomplete + highlight, the server's @agent reply trigger is unchanged
  teamUnread.ts   — pure, React-free unread tracking for the Team rail orb (emptyUnread/observeTip/observeTips/markRead/hasUnread). Because the workspace socket is gated on the Team tab being active (#149), App polls each channel's newest message over REST while off the Team tab and folds the tips through this reducer; the operator's own posts never count, the agent's replies do, and a channel clears only when it is opened. In-memory only — no server, DB or persistence
  emojiSet.ts     — REACTION_EMOJI, a curated static ~40-emoji constant for the Team chat reaction picker (no picker library, no full-Unicode list — offline-safe by design)
  kbEdits.ts      — pure, React-free selection transforms behind the KB page editor's formatting toolbar AND its ⌘B/⌘I/⌘U/⌘K shortcuts (one shared mechanism, not two divergent copies): toggleWrap/toggleLinePrefix/toggleOrderedList/applyHeading/applyLink/applyTextColor/removeTextColor/applyHighlight/removeHighlight, plus the curated KB_TEXT_COLORS/KB_HIGHLIGHT_COLORS palettes and HEADING_LEVELS (modelled on emojiSet.ts's static-constant approach)
  components/     — ActivityRail (the persistent left activity-rail nav: one button per mode plus Settings; the Team button is an inline outline messenger-bubble SVG carrying the unread orb — a pulsing var(--accent) dot shown only while the operator is off the Team tab; not rendered on the phone shell), MobileNav (phone shell top bar: hamburger drawer of the six views, crumb, connection dot, Settings gear; replaces the desktop title bar/activity rail/status bar when useIsMobile() is true), TaskList (list of all tasks; the selected row expands in place to reveal its lifecycle action buttons + a collapsible metadata dropdown, folded in from the old standalone activetask card), NewTaskForm (title/body + drop-paste attachments), ClarifyChat (live composer, placeholder prop, drop-paste attachments), AttachmentTray (thumbnail strip for a composer's pending attachments — image previews, PDF chip, remove + error), WorkerLog (read-only tool/subagent rows), WorkerLogPanel (WorkerLog + steer composer, forwards attachments), WorkspaceView (now just composes `<WorkspaceGrid/>` + `<BottomNav/>`; still owns the WorkspaceLayout + file-tree/agents fetches, fed into the Files + Viewers cards via a card content map — the Files tree and the Viewer always target the configured Projects dir (`/api/projects/file[s]`, read + write), independent of task selection; a task worktree is not browsable there — the old Files-sidebar/center-pane/task-rail/TerminalDock plumbing is gone), WorkspaceGrid (the card-grid host: ResizeObserver for grid width + pointer move/resize handlers calling the pure gridLayout reducer, drag ghost + scroll spacer; socket-owning cards (terminal/chat/viewers) stay mounted `display:none` while hidden so the session survives hide→show; not unit-tested — pointer/RO glue), GridCard (presentational card chrome — ⠿ drag-handle header + title + minimize/hide + corner resize handle + body, body `display:none` when minimized), BottomNav (static bottom nav bar — Cards show/hide menu, density/card-style/interaction selects, Settings toggle, connection dot), PipelineCard/ConcurrencyCard/ReviewQueueCard (the 3 data cards, fed by dashboardData.ts, shared DashboardCards.module.css), WorkspaceTabs (draggable tabs — file Viewers/WorkerLogPanel/Notes/Chat; now rendered inside the Viewers card), TerminalDock (orphaned — no importer; Zed-style bottom dock + bottom nav bar of Terminal/Chat/Tasks/Workspace/Settings pane toggles, `+💬` new-chat tab-strip affordance, ctrl+` toggle, drag-resize), TabStrip (presentational tab strip shared by ChatCard/TerminalCard — click-to-focus tabs + × close + a trailing + add button, state lives in the caller), ChatCard (wraps the Chat grid card's `windowTabs.ts` state in a TabStrip; a new tab starts unlaunched behind a model/effort/style picker + Launch button, only mounting ChatPane once pressed; tabs stay mounted `display:none` while inactive), TerminalCard (wraps the Terminal grid card's `windowTabs.ts` state in a TabStrip; a new tab auto-spawns its PTY immediately on +, no gating; same stay-mounted policy), ChatPane (standalone agent-chat bubble thread rendered inside a ChatCard tab, one WebSocket per instance to /ws/chat, optional initialModel/initialEffort/initialStyle props seeded by the launching tab's picker, Stop button while busy, drop-paste attachments), SettingsModal (ephemeral focused overlay; theme dropdown selector + live preview swatch + dark/light toggle, backed by `themes.ts`), Terminal (xterm.js glue rendered inside a TerminalCard tab, one WebSocket per instance; on a phone also renders a two-row on-screen key bar (terminalKeys.ts, row 2 collapsed by default), pads for the soft keyboard (keyboardInset.ts), and wires pinch-to-resize/flick-scroll-with-momentum plus a long-press Paste/Copy menu (terminalFont.ts/terminalTouch.ts) — all gated on useIsMobile()/a phone media block, desktop unchanged), TeamView (Team-mode tab — owns the /ws/workspace socket, same own-socket pattern as Terminal.tsx; renders the channels and roster lists as two tabs inside the rail (teamNav.ts), the scrollback-plus-live thread, and the composer; on a phone the rail and the thread are two full-screen panes — tap a channel to enter the thread, the header back arrow to return — and the open channel id persists to localStorage on both shells; composer wires mentions.ts for a live @-mention autocomplete dropdown, candidates = roster names + cfg.botHandle; thread bodies render @name tokens as colored pills via parseMentions — visual only, the server-side @agent trigger is unchanged; each message bubble also renders reaction-count pills, human and agent messages alike, driven by channelThread.ts's applyReaction — click a pill to toggle your own reaction, click the count for a "who reacted" popup, or open a curated emoji-picker grid via a ☺ add-button backed by emojiSet.ts), KbToolbar (the persistent Google-Docs-style formatting bar above the KB page editor — Bold/Italic/Underline/Strikethrough, a heading-style picker, bullet/numbered/checklist lists, insert-link, and text/highlight color pickers; purely presentational, every control turns a click into one of kbEdits.ts's pure transforms via onApply; every button/swatch default-prevents mousedown so it never steals focus from the textarea, since KB edit mode exits on blur — this is also why the heading and color pickers are hand-rolled button popovers rather than a native select/input[type=color])
```

### Gated surfaces (KB + Team)
The Knowledge Base and Team Chat surfaces require a login; the Workspace orchestrator
does not. `App.tsx` holds one session per gated ORIGIN and renders `<LoginPane>` in place
of the surface when that origin has none — `LoginPane` never unmounts itself, so the
parent must stop rendering it. Gate each surface on `loadSession(itsOrigin)`, not on
"`onAuthed` fired": a partial multi-origin login can authenticate one surface and not the
other.

Identity is never asserted from the client. Components read the authenticated
`PublicUser` handed down as a prop; `encodeHello()` takes no display name (a same-origin
socket is authenticated by the handshake cookie, a cross-origin one passes its bearer
token), and `encodeMessage`/`encodeReact`/`encodePageEdit` carry no author or handle —
the server REJECTS a frame that still does, so a stale call site breaks posting outright.
On an `unauthorized` frame or an `isAuthError(err)`, clear the surface and re-show the
login pane.

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

## Mobile (phones only)

Below `MOBILE_QUERY` (768px) the app is a single-view phone shell: `MobileNav`'s
hamburger drawer picks one of six full-screen views, `WorkspaceView` takes a
`mobileView` prop instead of its tab strip, and the panels stack vertically —
no horizontal scrolling anywhere. Rules:

- Touch targets are at least 44px; inputs/textareas/selects are **16px**
  (anything smaller makes iOS Safari zoom the page on focus).
- Use `100dvh`, not `100vh`, so the layout tracks collapsing browser chrome, and
  pad with `env(safe-area-inset-*)` for the notch/home bar.
- Mobile rules are additive `@media (max-width: 768px)` blocks (or the
  `data-mobile` flag on `WorkspaceView`'s center) — never edit a desktop rule.
- The phone terminal (`Terminal.tsx`) gets its own on-screen key bar (`terminalKeys.ts`
  — Esc/Tab/sticky Ctrl+Alt/arrows/symbols, plus a collapsed Home/End/PgUp/PgDn/F-key
  row) since a soft keyboard has none of those, a `--kb-inset` padding fix
  (`keyboardInset.ts`) so the bar and cursor line stay above the keyboard instead of
  under it, and pinch-to-resize/flick-scroll gestures (`terminalFont.ts`/
  `terminalTouch.ts`) on the xterm host.
- In the Team view the rail's Channels and Roster lists are tabs (one at a
  time, desktop included), and on a phone the rail and the message thread are
  two full-screen panes rather than a stacked column: tapping a channel opens
  its thread, the header's back arrow returns to the list. The open channel is
  persisted (`teamNav.ts`), so the tab reopens in the last channel's thread.
- In the Tasks / Worker view a 44px handle bar sits at the task panel's bottom
  edge: swipe up on it to collapse the panel (the worker log grows into the
  space), swipe down or tap to restore it. The gesture is recognised on the
  handle only, so list/log scrolling is untouched, and the state persists via
  `mobileTaskPanel.ts`.
- The app is installable to the Home Screen (`public/manifest.webmanifest` +
  iOS/Android meta tags in `index.html`). There is deliberately **no service
  worker** — the UI is a live WebSocket client and useless offline.

## Accessibility
- No nested interactive elements
- All interactive elements keyboard accessible
- Sufficient contrast on translucent surfaces
- Semantic HTML elements
