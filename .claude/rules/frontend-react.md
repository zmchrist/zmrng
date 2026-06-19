# Frontend React Conventions

## Stack
- React 19, TypeScript, Vite
- CSS Modules + design tokens (`theme.css`)
- WebSocket for real-time updates (`useWs` hook)
- **No router** — single-page layout (TaskList rail | TaskDetail pane)
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

### Type mirror
`packages/web/src/types.ts` mirrors `packages/server/src/types.ts`. When a server
type changes, update this file in the same change — there is no shared package.

### Component Structure
```
packages/web/src/
  App.tsx        — layout + WS wiring + config/repo fetch
  api.ts         — REST client
  useWs.ts       — auto-reconnect WebSocket hook
  status.ts      — status label + color helpers
  theme.css      — frosted-glass design tokens
  types.ts       — manual mirror of server types
  components/     — TaskList, NewTaskForm, TaskDetail, ClarifyChat, WorkerLog
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
Prefer CSS Modules. The one sanctioned inline style in this codebase is the
status pill `color` driven by `statusColor(status)` — follow that precedent only
when the value is genuinely dynamic.

## Accessibility
- No nested interactive elements
- All interactive elements keyboard accessible
- Sufficient contrast on translucent surfaces
- Semantic HTML elements
