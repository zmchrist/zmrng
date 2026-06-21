# Plan: Collapsible Left Task Pane

## Feature

Add a collapse/expand toggle to the left rail (the "task pane") so the operator
can shrink it from a full 348px slab to a thin vertical bar, giving the right
detail/session pane (TaskDetail + WorkerLog) maximum width while staying inside
a session. A toggle button lives at the rail↔detail seam (it replaces the
perceived "green line" — there is no literal green divider in source; green
appears only in status pills, and the active-task row's accent rail
(`.item::before`, pewter `--accent-grad`) is the only vertical line in the rail).
When collapsed, the rail renders a minimal vertical bar: an expand button plus
one small status-colored dot per task that stays clickable to switch tasks.

### User Story

```
As the zmrng operator watching a running task's session log,
I want to collapse the left task pane into a thin bar,
So that the detail/session pane gets maximum horizontal space while I can still
glance at task statuses and click to switch tasks.
```

### Feature type & complexity

- Type: **Enhancement** (frontend-only UI affordance)
- Complexity: **Low–Medium** (one stateful layout toggle + a collapsed-bar render
  path + CSS animation; no server, no types, no persistence layer)
- Affected workspace: **`packages/web` only**

## Scope & Constraints (locked in clarify)

- Files touched: **`packages/web/src/App.tsx`** and
  **`packages/web/src/App.module.css`** only. No new components, no new files.
- **No server change, no `types.ts` change** → the manual server↔web type mirror
  is NOT touched (purely frontend UI state).
- Collapse state is **local React UI state** in `App.tsx`
  (`railCollapsed: boolean`), not persisted, not sent to the server.
- Use existing design tokens only (`--spring`, `--accent`, `--accent-soft`,
  `--surface`, `--surface-strong`, `--surface-hover`, `--border`,
  `--border-strong`, `--radius`, `--radius-sm`, `--radius-pill`, `--text`,
  `--text-dim`, `--text-faint`, `--transition`, `--focus-ring`, and the
  `--status-*` hues via `statusColor()`). **Never hard-code colors/blur/radius.**
- Keyboard-accessible: real `<button>` elements with `aria-expanded`,
  `aria-label`, and `title`.
- Reduced-motion is already handled globally in `theme.css`
  (`@media (prefers-reduced-motion: reduce)` zeroes transition/animation
  durations) — nothing extra needed, just rely on CSS transitions.

## Context — files to read / patterns to follow

- `packages/web/src/App.tsx` — the layout owner. Renders
  `.app` grid → `.dragbar` + `<aside className={styles.rail}>` (brandbar +
  `NewTaskForm` + `TaskList`) + `<main className={styles.detail}>` (TaskDetail or
  empty state). `sorted` (memoized task array), `selectedId`, and `select(id)`
  already exist here — the collapsed bar reuses them directly.
- `packages/web/src/App.module.css` — `.app` grid is
  `grid-template-columns: 348px 1fr; grid-template-rows: auto 1fr;`. `.rail` and
  `.detail` are `grid-row: 2`. `.rail` is a flex column. Existing keyframes
  `rail-in` / `detail-in` use `var(--spring)`.
- `packages/web/src/status.ts` — `statusColor(status)` returns
  `var(--status-<status>)`; `STATUS_LABEL[status]` gives a human label. Reuse
  both for the dots (color + accessible label/title).
- `packages/web/src/components/TaskList.tsx` — pattern for mapping `tasks` to
  clickable `<button>`s with `statusColor` and `selectedId` highlight; the
  collapsed dot column mirrors this shape in miniature.
- `packages/web/src/components/TaskList.module.css` — `.item.active` uses
  `--surface-strong` + `--border-strong`; the active accent rail is
  `.item::before` with `background: var(--accent-grad)`. Follow the same
  active-state cue (ring/brightened dot) for the selected dot.
- `.claude/rules/frontend-react.md` — tokens-only, no `any`, CSS Modules, no
  nested interactive elements, derive-don't-sync-in-effect.

## Design Decision — layout & toggle mechanics

**Grid drives the width.** Add a collapsed modifier on the `.app` grid that
swaps the first track from `348px` to a thin bar width (`56px`). Because both
states are `<px> 1fr` track lists of identical structure, `grid-template-columns`
interpolates cleanly, so a single `transition: grid-template-columns var(--spring)`
on `.app` animates the collapse/expand smoothly.

```tsx
// App.tsx
const [railCollapsed, setRailCollapsed] = useState(false)
...
<div className={`${styles.app} ${railCollapsed ? styles.appCollapsed : ''}`}>
```

```css
/* App.module.css */
.app {
  display: grid;
  grid-template-columns: 348px 1fr;
  grid-template-rows: auto 1fr;
  height: 100vh;
  overflow: hidden;
  padding: 0 12px 12px;
  gap: 12px;
  transition: grid-template-columns var(--spring);
}
.appCollapsed {
  grid-template-columns: 56px 1fr;
}
```

**Rail content swaps on collapse.** The `<aside className={styles.rail}>` keeps
its glass slab styling in both states; only its *contents* change:

- **Expanded** (unchanged behavior + one new button): brandbar (brand + dot +
  **new collapse button**), `NewTaskForm`, `TaskList`.
- **Collapsed**: a minimal vertical bar — an **expand button** at the top, then a
  scrollable vertical column of small **status dots** (one per task in `sorted`),
  each a `<button>` that calls `select(t.id)`; the selected task's dot gets an
  accent ring.

```tsx
<aside className={`${styles.rail} ${railCollapsed ? styles.railCollapsed : ''}`}>
  {railCollapsed ? (
    <div className={styles.mini}>
      <button
        type="button"
        className={styles.collapseBtn}
        aria-expanded={false}
        aria-label="Expand task pane"
        title="Expand task pane"
        onClick={() => setRailCollapsed(false)}
      >
        {/* chevron-right glyph, e.g. › */}
      </button>
      <div className={styles.miniDots}>
        {sorted.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`${styles.miniDot} ${t.id === selectedId ? styles.miniDotActive : ''}`}
            style={{ background: statusColor(t.status) }}
            aria-label={`${t.title} — ${STATUS_LABEL[t.status]}`}
            aria-current={t.id === selectedId ? 'true' : undefined}
            title={`${t.title} — ${STATUS_LABEL[t.status]}`}
            onClick={() => select(t.id)}
          />
        ))}
      </div>
    </div>
  ) : (
    <>
      <div className={styles.brandbar} data-tauri-drag-region>
        <span className={styles.brand}>zmrng</span>
        <span className={styles.brandbarRight}>
          <span
            className={`${styles.dot} ${connected ? styles.dotOn : ''}`}
            title={connected ? 'connected' : 'disconnected'}
          />
          <button
            type="button"
            className={styles.collapseBtn}
            aria-expanded={true}
            aria-label="Collapse task pane"
            title="Collapse task pane"
            onClick={() => setRailCollapsed(true)}
          >
            {/* chevron-left glyph, e.g. ‹ */}
          </button>
        </span>
      </div>
      <NewTaskForm ... />
      <TaskList ... />
    </>
  )}
</aside>
```

**Why this placement counts as the "seam" toggle.** The collapse button sits at
the top-right of the rail (the edge that abuts the detail pane), i.e. the seam
side. This is robust inside a CSS-grid+gap layout where there is no literal
divider element to attach to, and it keeps the button keyboard-reachable in both
states. (If a button visually straddling the gap is later wanted, it can be
absolutely positioned against the rail's right edge — noted as an optional
refinement, not required by scope.)

**New imports in App.tsx:** `statusColor` and `STATUS_LABEL` from `./status`
(for the dots). `useState` is already imported.

## Step-by-step implementation tasks

1. **App.tsx — state.** Add `const [railCollapsed, setRailCollapsed] = useState(false)`
   alongside the other `useState` hooks.
2. **App.tsx — imports.** Add `import { STATUS_LABEL, statusColor } from './status'`.
3. **App.tsx — grid class.** Change the root `<div className={styles.app}>` to
   `className={`${styles.app} ${railCollapsed ? styles.appCollapsed : ''}`}`.
4. **App.tsx — collapse button (expanded state).** Wrap the existing connection
   `dot` and a new collapse `<button>` in a `brandbarRight` span inside the
   brandbar; button toggles `setRailCollapsed(true)` with `aria-expanded={true}`,
   `aria-label`/`title` "Collapse task pane". Keep `data-tauri-drag-region` on the
   brandbar but NOT on the button (so the button stays clickable, not a drag
   target).
5. **App.tsx — collapsed render path.** Conditionally render the `mini` bar
   (expand button + `miniDots` column) when `railCollapsed`, else the existing
   brandbar + `NewTaskForm` + `TaskList`. Reuse `sorted`, `selectedId`, `select`,
   `statusColor`, `STATUS_LABEL`.
6. **App.module.css — grid transition + collapsed track.** Add
   `transition: grid-template-columns var(--spring)` to `.app`; add `.appCollapsed`
   with `grid-template-columns: 56px 1fr`.
7. **App.module.css — brandbarRight + collapseBtn.** `.brandbarRight` = flex row,
   `align-items: center`, `gap: 8px`. `.collapseBtn` = small square glass button
   using `--surface`/`--surface-hover` on hover, `--border`, `--radius-sm`,
   `--text-dim` → `--text` on hover, `--transition`; focus handled globally by
   `:focus-visible { box-shadow: var(--focus-ring) }` in theme.css.
8. **App.module.css — mini bar.** `.mini` = flex column, `align-items: center`,
   padding clearing the traffic-light band at top (match the rail's existing top
   inset feel), `gap`. `.miniDots` = flex column, `gap`, `overflow-y: auto`,
   `min-height: 0`, `flex: 1`, centered. `.miniDot` = ~12px circle,
   `border-radius: var(--radius-pill)`, `border: 1px solid var(--border)`,
   `transition`, hover lift (scale/translate like `.item:hover`). `.miniDotActive`
   = accent ring via `box-shadow: 0 0 0 3px var(--accent-soft)` +
   `border-color: var(--border-strong)` (mirrors `.dotOn` / active-row cue).
9. **Verify drag region.** Confirm the collapsed `mini` bar still leaves the
   top `.dragbar` strip (full-width, grid-row 1) intact so the window stays
   draggable; the mini bar lives in grid-row 2 like the rail, so the dragbar is
   unaffected.

## Edge cases & considerations

- **Empty task list while collapsed:** `sorted` is empty → `miniDots` renders no
  dots; the expand button is still present. Fine, no special-case needed.
- **Long task list while collapsed:** `miniDots` scrolls (`overflow-y: auto`,
  `min-height: 0`) inside the fixed-height rail. Reuse the global scrollbar
  styling from theme.css.
- **Selection persists across collapse/expand:** `selectedId` is independent of
  `railCollapsed`, so the detail pane keeps showing the selected task; expanding
  restores the full list with the same selection highlighted.
- **No nested interactive elements:** dots and toggle are standalone `<button>`s
  (rule compliance).
- **Accessibility:** `aria-expanded` on the toggle reflects state; dots expose
  title+status via `aria-label`/`title` and mark the active one with
  `aria-current`.

## Risks & mitigations

- **`grid-template-columns` animation in WKWebView (Tauri):** animating grid
  track lists is supported in modern Safari/WebKit; both states are
  `<px> 1fr` so they interpolate. If a target WKWebView ever fails to animate,
  the layout still snaps correctly (functional, just not animated) — acceptable
  fallback, and reduced-motion users get the snap anyway. No JS fallback needed.
- **Button vs. drag region conflict:** the collapse button must NOT carry
  `data-tauri-drag-region` (the brandbar does); otherwise clicks become drags.
  Step 4 keeps the attribute on the brandbar container only.
- **Stale `.app` bundle:** per CLAUDE.md, source edits only refresh the dev/
  browser view; the shipped `.app` carries a stale bundle until re-bundled.
  Mitigation: finish with `npm run desktop:build` (see Validation).

## Testing strategy

No test framework in this repo — validation is typecheck + lint + build, plus a
manual smoke and a final app re-bundle.

### Automated validation

```bash
npm run typecheck   # tsc --noEmit, both workspaces (catches type/mirror issues)
npm run lint        # ESLint, both workspaces (react-hooks rules, a11y)
npm run build       # tsc (server) + vite build (web)
```

### Manual smoke (browser dev view)

```bash
npm run dev:web   # (or npm run dev for server+web)
```

- Click the collapse button → rail animates to the thin bar; detail pane widens.
- Collapsed bar shows one dot per task with the correct status color; hover lifts.
- Click a dot → that task selects in the detail pane (verify against expanded
  list selection).
- Click expand → rail animates back to 348px with full `NewTaskForm` + `TaskList`,
  selection preserved.
- Tab through: collapse/expand button and dots are keyboard-focusable with the
  accent focus ring; `aria-expanded` flips.
- Toggle macOS reduce-motion → collapse/expand snaps without animation.

### Final app re-bundle (REQUIRED — app-only directive)

```bash
npm run desktop:build   # build → bundle:sidecar → tauri build → fresh .app
```

The task is NOT done after `npm run build` alone; the shipped `.app` must carry
the change.

## Acceptance criteria

- [ ] A keyboard-accessible collapse button appears at the rail's seam edge
      (brandbar right) when expanded; clicking it shrinks the rail to a thin bar
      (~56px) and widens the detail pane.
- [ ] Collapsed rail shows an expand button + one clickable, status-colored dot
      per task; clicking a dot selects that task in the detail pane.
- [ ] Expand restores the full rail (NewTaskForm + TaskList) with selection
      preserved.
- [ ] The transition is animated via `--spring` and respects reduced-motion.
- [ ] Only `App.tsx` + `App.module.css` change; no server/types/mirror changes.
- [ ] All values use existing design tokens — no hard-coded colors/blur/radius.
- [ ] `npm run typecheck && npm run lint && npm run build` all pass.
- [ ] `npm run desktop:build` produces a fresh `.app` carrying the change.

## Validation commands (summary)

```bash
npm run typecheck && npm run lint && npm run build   # gate
npm run desktop:build                                # ship into the .app
```
