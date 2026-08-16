# Plan — Zed-style collapsible tab panes in the Workspace view

## Task

In the **Workspace** mode, rebuild the center region so the currently-fixed
"top window" (file Viewer) and "bottom window" (Worker Log) — plus the Notes and
Chat cards from the right rail — become **draggable tabs** in a Zed-like tab
area. The Files tree stays fixed on the left; the right rail is removed. The tab
area holds **at most two panes** (one pane, two side-by-side, or two stacked —
one split axis, never a 2×2). Many files can be open as tabs at once. Layout
persists **per task** across restarts.

This is a **frontend-only** feature. The only backend touch is the shared
`PerTaskUiState` type (source of truth → mirror), because the persistence path
round-trips whatever the client stores under `perTask[taskId]`.

## Agreed scope (from clarify)

- **What tab-ifies:** file Viewers (many open at once), Worker Log, Notes, Chat.
  Files tree stays fixed left. Right rail removed.
- **Split depth:** max 2 panes total; one split axis at a time (1 pane, 2
  side-by-side, or 2 stacked). Never 2×2.
- **Drag mechanics:** drop on a pane's **center** → move the tab into that pane's
  tab strip; drop near an **edge** → split that axis. With max-2, the first
  edge-drop creates the split; further edge-drops just move a tab between the two
  panes. Emptying a pane collapses it; the sibling grows to fill.
- **Open file:** click a file in the tree → open as a new tab in the **active
  pane** and focus it; if already open, just focus the existing tab.
- **Closeable/fixed:** file tabs, Notes, and Chat are freely closeable via an X.
  A small **button bar** re-opens closed panels (Notes, Chat, Worker Log).
- **Worker Log:** cannot be **closed** while the agent is still working (X
  disabled/absent); can only be **minimized** — its pane collapses to a thin
  click-to-expand strip. Becomes closeable once the task reaches a terminal state
  (PR up / stop / cancel / exit).
- **Persistence:** open tabs, active tab per pane, split arrangement, active pane,
  and minimized state persist **per task** across app restarts, reusing the
  existing `perTask` UI-state mechanism.

## Current state (read before planning)

- `packages/web/src/components/WorkspaceView.tsx` — 3-column CSS grid:
  `.sidebar` (FileTree) | `.center` (fixed 2-row grid: `.viewer` = `<Viewer>`,
  `.logPane` = `<WorkerLog>`) | `.rightRail` (`<RailCard>` wrappers around
  `<Chat>` and `<Notes>`). Single open-file path is tracked in local state
  (`openPathState`), hydrated from `perTask[taskId].activePath`, persisted via
  `onPerTaskChange(taskId, { activePath })`. A `treeContains()` helper drops a
  stale open path that no longer exists in the fetched tree.
- Child components (all reused **unchanged**):
  - `Viewer` — props `{ taskId, path }`, renders one file.
  - `WorkerLog` — props `{ events, live }`.
  - `Notes` — props `{ taskId, selectedPath, onOpen }`.
  - `Chat` — props `{ taskId, agents }`; only mounted when the optional chat
    adapter returns ≥1 agent (`api.listAgents()`).
  - `FileTree` — props `{ entries, onOpen, selectedPath }`.
- Persistence: `packages/web/src/uiState.ts` (`useUiState`) debounces
  `PUT /api/ui-state`; `packages/server/src/uiState.ts` writes
  `{ global, perTask }` verbatim to `~/.zmrng/ui-state.json` with **no per-field
  validation** — so a new nested field on `PerTaskUiState` round-trips with **no
  server logic change**. `pruneTask(taskId)` drops a task's entry on worktree
  removal (already wired; needs no change).
- `PerTaskUiState` today: `{ openPaths?: string[]; activePath?: string | null }`.
  Source of truth `packages/server/src/types.ts:129`; manual mirror
  `packages/web/src/types.ts:129`.
- Terminal statuses: `cancel()` transitions to `failed` (`phases.ts:800`); "PR
  up" is `review`/`done`. So the Worker-Log close-guard opens at
  `status ∈ { review, done, failed, archived }`.
- Tests: Vitest, web workspace in jsdom + `@testing-library/react`
  (`packages/web/test/`, e.g. `TaskList.test.tsx`, `status.test.ts`).

## Approach — grilled

### Data model (the core decision)

Given the max-2 / single-axis constraint, a **recursive pane tree is
unnecessary**. A flat, closed shape is enough and far easier to test:

```ts
export type WsTabKind = 'file' | 'log' | 'notes' | 'chat'
export interface WsTab { id: string; kind: WsTabKind; path?: string } // path only for kind==='file'
export interface WsPane { tabs: WsTab[]; activeId: string | null }
export type WsSplit = 'row' | 'column' | null      // row = side-by-side, column = stacked
export interface WorkspaceLayout {
  panes: WsPane[]        // length 1 or 2 (invariant, enforced by the reducer)
  split: WsSplit         // null iff panes.length === 1
  activePane: number     // 0 | 1 — target for new file tabs & panel re-open
  logMinimized?: boolean // only meaningful while the log tab exists
}
```

Tab id convention: file → `file:<path>`; singletons → literal `log` / `notes` /
`chat` (so a singleton can never be opened twice). The id is treated as an
**opaque key** — never parsed; the file path lives on `tab.path`, so a path
containing `:` is safe. Singleton ids can never collide with a `file:` id.

**Focus-after-close rule:** when the active tab is closed, focus falls to the
tab to its left (or the new first tab if it was leftmost); when a pane collapses,
`activePane` becomes the surviving pane and its `activeId` is preserved.

`WorkspaceLayout` (and the sub-types) are added to `PerTaskUiState.layout?` —
optional, so old persisted docs and the type mirror stay backward-compatible.

### Layout reducer — the testable heart

A new **pure** module `packages/web/src/workspaceLayout.ts` holds all mutation
logic as pure `(layout, …) => layout` functions. No React, no DOM — so it is
fully unit-testable and the fiddly invariants live in one place:

- `emptyLayout()` → one pane `[log]`, `activeId: 'log'`, `split: null`,
  `activePane: 0`.
- `hydrateLayout(stored?, legacyActivePath?)` → return `stored` if present;
  else seed a default: one pane with the `log` tab, plus a file tab for
  `legacyActivePath` (made active) when set. Guarantees the invariants below even
  for hand-edited / older JSON (clamp `panes` to 1–2, fix `split`/`activePane`).
- `openFile(layout, path)` → focus existing file tab if open (select its pane +
  set `activePane`); else append a file tab to `panes[activePane]` and focus it.
- `focusTab(layout, paneIdx, id)` → set that pane's `activeId` + `activePane`.
- `closeTab(layout, id)` → remove the tab; if its pane empties, **collapse**
  (drop the pane, remaining pane becomes sole, `split: null`, `activePane: 0`).
  Reducer refuses to remove the `log` tab (callers gate on the close-guard, but
  the reducer is the backstop).
- `openPanel(layout, kind)` → re-open a singleton (`log`/`notes`/`chat`) into
  `panes[activePane]` if not already present; focus it.
- `moveTab(layout, id, targetPane, index)` → reorder within a pane or move
  between the two existing panes (used by center-drop and by edge-drop when a
  split already exists). Collapses a pane emptied by the move.
- `splitWith(layout, id, edge)` → `edge ∈ 'left'|'right'|'top'|'bottom'`. Only
  when `panes.length === 1`: create a second pane holding the dragged tab, set
  `split` to `row` (left/right) or `column` (top/bottom), order the two panes by
  the edge. If a split already exists, **degrade to `moveTab`** into the other
  pane (upholds max-2 / single-axis). No-op if the tab is the source pane's only
  tab (nothing to split off).
- `setLogMinimized(layout, on)`.
- `pruneFileTabs(layout, existingPaths)` → drop file tabs whose path is no longer
  in the fetched tree (the multi-tab generalization of today's `treeContains`
  stale-path drop); collapse any pane emptied by pruning.

Every function returns a **new** object (immutable) and preserves the invariants
(`panes.length ∈ {1,2}`, `split === null ⇔ 1 pane`, `activePane` in range, each
pane's `activeId` refers to a tab it owns).

### Rendering

`WorkspaceView` keeps the left FileTree and its data-loading effects. The center
+ (removed) right rail collapse into one **tab area** driven by the layout:

- New presentational components (co-located, one CSS module):
  `WorkspaceTabs.tsx` — owns the live layout state, renders the panel **button
  bar** (re-open Notes / Chat / Worker Log when closed) + the pane grid
  (`grid-template-columns`/`rows` from `split`), and wires drag/drop → reducer
  calls. Renders one `Pane` per pane.
  `Pane` (same file) — a tab strip (`Tab` buttons with an X, `draggable`) + the
  active tab's content, plus edge/center **drop-zone overlays** shown during a
  drag. A minimized log pane renders only a thin click-to-expand strip.
- Content dispatch by `tab.kind`: `file → <Viewer taskId path>`,
  `log → <WorkerLog events live>`, `notes → <Notes …>`, `chat → <Chat …>`.
  Existing components reused **unchanged**.
- Worker-Log close-guard: `logCloseable = LOG_CLOSEABLE.has(task.status)` where
  `LOG_CLOSEABLE = { review, done, failed, archived }`. While not closeable, the
  log Tab renders **no X** (minimize control only).
- State ownership: `WorkspaceTabs` holds the layout in local React state,
  hydrated from `perTask[taskId].layout` on task switch (adjust-state-on-prop-
  change pattern, mirroring the existing `hydratedFor` guard — **no
  `setState`-in-effect**, per the ESLint rule). Every reducer call is followed by
  `onPerTaskChange(taskId, { layout: next })` to persist.

### Drag & drop

Use **native HTML5 DnD** (`draggable` + `onDragStart`/`onDragOver`/`onDrop`) —
**no new dependency** (repo has no DnD lib and favors the smallest change). A Tab
sets its id on `dataTransfer` at drag start. A pane computes drop **intent** from
the pointer position over its rect (center band → move into strip; left/right/top/
bottom edge band → split/target that axis) and calls the matching reducer
function. Because all geometry resolves to a single reducer call, the **layout
logic is verified by unit tests on the pure functions**, not by simulating pixel
drags in jsdom (jsdom has no layout box model). Drop-zone highlighting is
cosmetic.

### Styling

New `.module.css` rules for the tab area, tab strip, tabs, pane grid, drop-zone
overlays, and the minimized log strip — **design tokens only** (`--surface`,
`--surface-strong`, `--surface-hover`, `--border`, `--accent`, `--radius*`,
`--transition`, `--glass`, etc.); no raw hex/blur/radius. The pane grid switches
`grid-template-columns` (row split) / `grid-template-rows` (column split) / single
cell (no split).

### Alternatives rejected

1. **Full recursive Zed pane tree** (N-deep nested splits). Rejected: the
   operator explicitly chose max-2 / single-axis (clarify Q4). A recursive tree
   multiplies edge cases, rendering, and test surface for capability that is out
   of scope.
2. **A drag-and-drop library (dnd-kit / react-dnd).** Rejected: adds a
   dependency to a repo that has none and prizes the smallest change. The
   constrained model (reorder + edge-zone split, desktop-only Tauri shell) is
   well within native HTML5 DnD.
3. **Keep Viewer/Log fixed, only add file tabs.** Rejected: fails the ask —
   Notes/Chat/Log must become movable tabs and participate in splits.

### Assumptions / risks

- **Persistence needs no server change.** Verified: `writeUiState` stores
  `{ global, perTask }` verbatim with no field validation, so the nested
  `layout` rides along. Only the shared **type** changes (both mirrors).
- **Default layout.** When a task has no stored layout and no legacy
  `activePath`, default to a single pane showing the Worker Log (the primary
  live view); files open as new tabs on demand. (Flagged for QA — an alternative
  default is a column split of file-over-log to echo today's look.)
- **jsdom can't drive real drags.** Mitigated by the pure-reducer decomposition;
  DnD handlers stay thin.
- **Chat tab** only appears when the chat adapter is configured; the re-open
  button bar hides the Chat button when no agents exist (mirrors today's
  conditional mount).

## Files to change

- `packages/server/src/types.ts` — **source of truth**: add `WsTabKind`,
  `WsTab`, `WsPane`, `WsSplit`, `WorkspaceLayout`; add `layout?: WorkspaceLayout`
  to `PerTaskUiState`.
- `packages/web/src/types.ts` — **mirror** the same additions (same change).
- `packages/web/src/workspaceLayout.ts` — **new** pure reducer module.
- `packages/web/src/components/WorkspaceView.tsx` — remove the right rail + fixed
  center grid; keep the FileTree sidebar; render `<WorkspaceTabs>` for the center;
  route `openFile` through the reducer; prune stale file tabs on tree load.
- `packages/web/src/components/WorkspaceTabs.tsx` — **new** (Pane / Tab / button
  bar / DnD wiring).
- `packages/web/src/components/WorkspaceTabs.module.css` — **new** (tokens only).
- `packages/web/src/components/WorkspaceView.module.css` — trim right-rail/center
  rules, adjust the grid to `Files | tab-area` (2 columns).
- (No change to `Viewer`/`WorkerLog`/`Notes`/`Chat`/`FileTree`, `uiState.ts`,
  server `uiState.ts`, or `index.ts`.)

## Test strategy

**Runner / command:** Vitest, run via `npm test` (both workspaces; web tests run
in jsdom with `@testing-library/react`, per `packages/web/vitest.config.ts`).
Full validation: `npm run typecheck && npm run lint && npm test && npm run build`.

**New test files and what each proves:**

1. `packages/web/test/workspaceLayout.test.ts` — unit tests for the pure reducer
   (the primary coverage; RED first):
   - `openFile` appends a focused file tab; opening an already-open path **only
     focuses** it (no duplicate tab), selecting its pane.
   - `closeTab` removes a tab; closing the **last** tab in a pane **collapses**
     the pane (`split → null`, one pane left, `activePane → 0`).
   - `closeTab('log')` is **refused** by the reducer (backstop for the
     close-guard).
   - `openPanel('notes'|'chat'|'log')` re-opens a closed singleton into the
     active pane and never creates a duplicate.
   - `splitWith` from a single pane creates the second pane with the correct
     `split` (`left/right → row`, `top/bottom → column`) and pane order; a second
     `splitWith` **degrades to a move** (still max-2, single axis, never 2×2).
   - `moveTab` reorders within a pane and moves between panes, collapsing an
     emptied source pane.
   - `setLogMinimized` toggles the flag.
   - `pruneFileTabs` drops file tabs whose path is absent and collapses an
     emptied pane; keeps singleton tabs.
   - `hydrateLayout` returns stored layout as-is, seeds a default from a legacy
     `activePath`, and **clamps** a malformed stored layout back to the
     invariants (≤2 panes, `split`/`activePane` consistent).
   - `dropIntent(rect-relative point)` — a pure helper mapping a pointer position
     within a pane to `center | left | right | top | bottom` (thirds bands). Unit
     tested directly (center, each edge, corners resolve to a single axis) so the
     DnD geometry is proven without a jsdom pixel drag.

2. `packages/web/test/WorkspaceTabs.test.tsx` — render/interaction tests
   (`@testing-library/react`), no pixel-drag simulation:
   - Renders a tab per open tab and the active tab's content.
   - Worker-Log tab shows **no close (X) control** while the task is active
     (e.g. `executing`) and **shows** it once terminal (e.g. `review`) —
     asserted for both statuses.
   - The minimize control collapses the log pane to the thin strip; clicking the
     strip restores it.
   - Closing Notes/Chat then clicking its **button-bar** button re-opens the tab.
   - Clicking a file tab's X removes it (via the reducer path).
   - **Accessibility:** the tab strip carries `role="tablist"`, tabs
     `role="tab"` + `aria-selected`, content `role="tabpanel"`; the minimize /
     close controls have explicit `aria-label`s. Tabs are keyboard-focusable and
     activate on Enter/Space; a test asserts the tablist/tab roles and the
     control labels are present. No nested interactive elements (the close X is a
     sibling button, not nested in the tab button).

**Type-mirror check:** `npm run typecheck` over both workspaces fails if the new
`WorkspaceLayout`/`PerTaskUiState` additions drift between
`packages/server/src/types.ts` and `packages/web/src/types.ts`.

**No new backend tests** — the server carries no new logic (types-only touch);
the existing `uiState`/state-machine tests continue to pass unchanged.

## Out of scope

- Recursive / >2-pane splits, 2×2 grids.
- Resizable split handles / draggable pane dividers (the `splitSizes` global
  field already exists and is untouched; equal split only, per clarify Q4).
- Any change to Viewer/WorkerLog/Notes/Chat internals, the Tasks/Board modes, or
  server routes/DB.
- Touch/mobile drag support (desktop Tauri shell only).
