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
(`encodeInput`/`encodeResize`/`parseServerMsg`), never hand-rolled JSON inline.

### Chat WebSocket (same own-socket pattern as Terminal)
`ChatPane.tsx` opens its own `WebSocket` directly to `/ws/chat` per mounted instance,
mirroring `Terminal.tsx` — not the `useWs` hub, since each chat tab owns a dedicated
`claude` session. Frames are encoded/decoded with the pure helpers in
`chatProtocol.ts` (`encodeStart`/`encodeInput`/`encodeInterrupt`/`parseChatServerMsg`),
never hand-rolled JSON inline.

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
  workspaceLayout.ts — pure reducer for the Workspace mode's Zed-style tab-pane layout (max 2 panes, single split axis)
  terminalDock.ts — pure reducer for the bottom-dock's ephemeral tab list, terminal AND chat tabs coexisting in one ordered list (emptyDock/addTab/addTerminal/addChat/closeTerminal/setActive)
  terminalProtocol.ts — pure wire helpers for /ws/terminal (encodeInput/encodeResize/parseServerMsg)
  chatProtocol.ts — pure wire helpers for /ws/chat (encodeStart/encodeInput/encodeInterrupt/parseChatServerMsg)
  chatThread.ts   — React-free bubble-thread reducer for the standalone chat pane (emptyThread/pushUser/appendPartial/finalizeAssistant/pushToolNote/endTurn/resetThread)
  themes.ts       — theme catalog (11 themes: one per color + black/white/grey) + pure helpers (buildThemeVars/applyTheme/loadStoredTheme/saveStoredTheme), persisted to localStorage only
  components/     — TaskList, NewTaskForm, ClarifyChat (live composer, placeholder prop), WorkerLog (read-only tool/subagent rows), WorkerLogPanel (WorkerLog + steer composer), TaskControls (compact selected-task card + dropdown), WorkspaceView (locked-left Files sidebar + toggleable WorkspaceTabs center + toggleable task rail right bar + global TerminalDock; Files tree shows the Projects dir when no task is selected), WorkspaceTabs (draggable tabs — file Viewers/WorkerLogPanel/Notes/Chat), TerminalDock (Zed-style bottom dock + bottom nav bar of Terminal/Chat/Tasks/Workspace/Settings pane toggles, `+💬` new-chat tab-strip affordance, ctrl+` toggle, drag-resize), ChatPane (standalone agent-chat bubble thread, one WebSocket per instance to /ws/chat, per-tab model/effort/style selects, Stop button while busy), SettingsModal (ephemeral focused overlay; theme swatch grid + dark/light toggle, backed by `themes.ts`), Terminal (xterm.js glue, one WebSocket per instance)
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
