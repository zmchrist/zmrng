# Plan — Rebuild Workspace as a customizable draggable/resizable card grid

## Goal

Replace the current column-based **Workspace** mode (locked-left Files sidebar +
center `WorkspaceTabs` pane + right task rail + bottom `TerminalDock`) with a
customizable **12-column draggable/resizable card grid**, modeled on the
`Zmrng Dashboard.dc.html` mockup in `~/Downloads/Zmrng customizable dashboard/`.

Every existing window becomes a grid card, and three new derived cards are added.
The grid engine (pointer-drag move, corner-resize, reflow/swap/free compaction,
density + card-style options) is reimplemented in React with a **pure, unit-tested
reducer** — no new npm dependency (no `react-grid-layout`). Card geometry,
visibility, minimized state, and the grid's density/card-style/interaction options
persist through the existing `GlobalUiState` mechanism. The mockup's orange/yellow
palette is already the app's default theme, so the grid is wired entirely through
the existing frosted-glass design tokens (`--bg`, `--surface-strong`, `--accent`,
`--border`, …) so the 11-theme selector + dark/light toggle keep recoloring it
(Q4 = B). The bottom nav bar stays pinned statically at the bottom.

### Card roster (Q9 — the full set)

| id | title | content component | source |
|----|-------|-------------------|--------|
| `pipeline` | Pipeline | **new** `PipelineCard` | live phase counts derived from `tasks` |
| `concurrency` | Concurrency | **new** `ConcurrencyCard` | active `executing` lanes vs `config.maxLanes` + `queued` count |
| `reviewqueue` | Review queue | **new** `ReviewQueueCard` | tasks in `review`/`done` with `prUrl` |
| `newtask` | New task | existing `NewTaskForm` | — |
| `activetask` | Active task | existing `TaskControls` | selected task |
| `workerlog` | Worker log | existing `WorkerLogPanel` | selected task events/live |
| `tasklist` | Task list | existing `TaskList` | — |
| `files` | Files | existing `FileTree` (in card chrome) | worktree / projects tree |
| `viewers` | Viewers | existing `WorkspaceTabs` (file tabs) | per-task `WorkspaceLayout` |
| `chat` | Chat | existing `ChatPane` (standalone `/ws/chat`) | — |
| `terminal` | Terminal | existing `Terminal` (one PTY) | — |

Throughput/sparkline is **explicitly out of scope** (operator dropped it). The old
bottom `TerminalDock` **as a dock** is retired; its terminal becomes the `terminal`
grid card and its static nav bar is extracted into a standalone `BottomNav`.

## Approach (grilled)

### What is the simplest thing that works?

The mockup already contains a complete, working engine in `support.js`'s `Component`
class: a 12-col grid of absolutely-positioned cards translated by `translate(x,y)`
inside a scrollable container with a height spacer, `collide()`/`compact()` for
reflow, and pointer handlers for move/resize. The simplest correct path is to **port
that engine faithfully**, splitting it the same way the repo already splits its other
interactive surfaces:

- **Pure reducer + geometry** (`web/src/gridLayout.ts`) — all cell-unit array ops
  (`collide`, `compact`, `applyMove`, `applyResize`, `hideCard`, `showCard`,
  `toggleMinimize`, `hydrateGrid`/`normalizeGrid`) and the DOM-free geometry helpers
  (`cellSize(gridW, density)`, `cardRectPx(item, cell)`). This mirrors exactly how
  `workspaceLayout.ts` and `terminalDock.ts` are pure and unit-tested with no jsdom.
- **React shell** (`web/src/components/WorkspaceGrid.tsx`) — owns the `ResizeObserver`
  for grid width and the `pointerdown/move/up` handlers (these need the DOM, exactly
  like the mockup and like `WorkspaceView`'s existing split-drag handler, so they are
  not unit-tested), calls the pure reducer, and renders each visible card.
- **Derived-data helpers** (`web/src/dashboardData.ts`) — pure `pipelineCounts`,
  `concurrency`, `reviewQueue` functions, unit-tested, feeding the three new cards.

This reuses **every** existing content component unchanged (NewTaskForm,
TaskControls, TaskList, FileTree, WorkspaceTabs, WorkerLogPanel, ChatPane, Terminal),
so the only genuinely new UI code is the grid chrome + 3 small data cards.

### Palette / "glass look" tension (Q2/Q4 = B), resolved

The task says "reproduce the mockup palette (orange/yellow)" **and** "keep the glass
look" **and** "follow the styling in the html" — which superficially conflict with the
repo's hard rule *never hard-code colors, always `var(--*)`*. It resolves cleanly:
**the app's current default theme is already the mockup's palette** — `theme.css`
`:root` sets `--bg: #ff4d00` and `--accent: #edff45`, and `themes.ts` `DEFAULT_THEME_ID`
is `orange` (`bg #ff5a1f`, accent `#f2ff4d`). So "orange/yellow as the new default,
driven by tokens so the theme switch recolors it" (Q4 = B) is achieved by wiring the
grid purely through the existing tokens — `--surface-strong` for card fills,
`--border`/`--border-strong` for the brutalist hairlines, `--accent`/`--accent-line`
for the accent edge, `--well` for inset fields — never a raw hex. The mockup's four
card-style variants map directly:

| mockup `chrome()` | grid `cardStyle` | token mapping |
|---|---|---|
| Accent edge (default) | `accent` | `background: var(--surface-strong)`, `border: 1px solid var(--border)`, `border-left: 3px solid var(--accent)` |
| Flat | `flat` | `var(--surface-strong)` + `1px solid var(--border)` |
| Outline | `outline` | `var(--surface)` + `1.5px solid var(--border-strong)` |
| Elevated | `elevated` | `var(--surface-strong)` + `var(--radius)` + `var(--shadow)` |

The "glass" is the existing translucent-surface-over-flat-field look with
`backdrop-filter: blur(var(--blur))` (currently a no-op since the brutalist theme sets
`--blur: 0`, but token-driven so any theme that restores blur gets it back). We do
**not** reintroduce a hard-coded blur or the raw `#ff5a1f`/`#f2ff4d` values — that
would break the 11-theme system, which is the explicit Q4 = B requirement.

### What this breaks / what I assumed and checked

- **`WorkspaceTabs` bundles file/log/chat tabs, but the roster wants Worker-log and
  Chat as *separate* cards.** Rather than rewrite `WorkspaceTabs`, the `viewers` card
  wraps it as-is (it keeps its file-tab + split behavior), and dedicated `workerlog`
  (`WorkerLogPanel`) and `chat` (`ChatPane`) cards are added alongside. The small
  overlap (a Worker-Log tab can also live inside the Viewers card) is acceptable and
  noted; it avoids a risky rewrite of the tab reducer.
- **Files card → Viewers card cross-talk.** Clicking a file in the `files` card must
  open a tab in the `viewers` card. Both render inside `WorkspaceGrid`, which continues
  to own the per-task `WorkspaceLayout` state + `openInLayout` callback (lifted from
  today's `WorkspaceView`), passing `layout` to the Viewers card and `onOpen` to the
  Files card. No new persistence — the existing `PerTaskUiState.layout` still stores it.
- **Live terminal / xterm in a reflowing grid is fiddly** (the mockup itself warns).
  `Terminal.tsx` already refits via `ResizeObserver` + `FitAddon`, and `ChatPane`/
  `Terminal` keep their own sockets; as long as a hidden/minimized card keeps the
  component **mounted** (toggle `display`, never unmount — the same rule the current
  `TerminalDock`/center-pane already follow), the PTY/`/ws/chat` session survives.
  Resize refit is a validation checkpoint, not new logic.
- **Grid geometry is stored in *cell* units (x,y,w,h ∈ 12-col space), not pixels**, so
  it is screen-width-independent and persists cleanly (same as the mockup's `layout`).
- **Persistence is global, not per-task.** Card positions describe the shell, not a
  task, so grid state lives in `GlobalUiState.grid` (round-tripped to
  `~/.zmrng/ui-state.json` via the existing `useUiState`/`patchGlobal` path — the
  "existing GlobalUiState pattern" Q7 asked for). The per-task file-tab `layout` stays
  in `PerTaskUiState`.
- **No server logic changes.** Every new card derives from data already in `tasks`
  (over WS) and `config.maxLanes` (already in `ServerConfig`). The only server edit is
  mirroring the new `GlobalUiState.grid` type + grid enums into
  `packages/server/src/types.ts` (the server just round-trips the field; it never
  validates it — per `error-handling`/type-mirror convention).
- **Large App.tsx ↔ WorkspaceView prop refactor.** Today `App` threads
  `dockOpen/filesOpen/tasksOpen/notesOpen/railCollapsed/filesNotesSplit/…` into
  `WorkspaceView`. Those pane props are superseded by grid card visibility. The old
  `panes`/`terminalDock`/`railCollapsed`/`splitSizes` fields are **left in the
  `GlobalUiState` type** (back-compat with already-persisted docs) but stop being
  threaded; `WorkspaceView` is reduced to `<WorkspaceGrid …/> + <BottomNav …/>`.

### Alternative rejected

**Add `react-grid-layout` (or `react-mosaic`) instead of hand-porting the engine.**
Rejected: (1) Q3 explicitly asked for no new dependency; (2) the mockup already ships a
complete, working reflow/swap/free engine whose exact behavior the operator approved,
so porting it guarantees the agreed feel, whereas RGL has its own (different) collision
model, no "swap" mode, and heavier DnD semantics; (3) the repo's whole design ethos is
small pure reducers with hermetic unit tests (`workspaceLayout.ts`, `terminalDock.ts`)
— a third-party grid can't be unit-tested that way and would fight the token system.
A second rejected alternative — **Option A, a separate new Dashboard tab leaving
Workspace intact** — was already ruled out by the operator (Q1 = B).

## Files

### New

- `packages/web/src/gridLayout.ts` — pure 12-col grid reducer + DOM-free geometry.
- `packages/web/src/dashboardData.ts` — pure `pipelineCounts` / `concurrency` /
  `reviewQueue` derivations for the three new cards.
- `packages/web/src/components/WorkspaceGrid.tsx` — the grid host (ResizeObserver +
  pointer move/resize, renders visible cards via the reducer).
- `packages/web/src/components/WorkspaceGrid.module.css` — grid + card-chrome styles,
  all `var(--*)` tokens.
- `packages/web/src/components/GridCard.tsx` — presentational card chrome (⠿ drag
  handle header + title + minimize/hide buttons + corner resize handle + children).
- `packages/web/src/components/BottomNav.tsx` — the extracted static bottom nav bar:
  a **Cards menu** (show/hide every card), the grid option selects
  (density/card-style/interaction), Settings toggle, and the connection dot.
- `packages/web/src/components/BottomNav.module.css`.
- `packages/web/src/components/PipelineCard.tsx` — phase-count chips + funnel bar.
- `packages/web/src/components/ConcurrencyCard.tsx` — active lanes vs max + queued.
- `packages/web/src/components/ReviewQueueCard.tsx` — review/done rows w/ PR "Open".
- (shared `*.module.css` for the three data cards, or one `DashboardCards.module.css`.)
- Tests: `packages/web/test/gridLayout.test.ts`,
  `packages/web/test/dashboardData.test.ts`.

### Changed

- `packages/server/src/types.ts` — add `GridDensity`/`GridCardStyle`/
  `GridInteraction` enums, `GridCardGeo`, and the `grid?: GridState` field on
  `GlobalUiState` (source of truth; server round-trips only).
- `packages/web/src/types.ts` — **mirror** the same additions.
- `packages/web/src/components/WorkspaceView.tsx` — reduce to composing
  `<WorkspaceGrid/> + <BottomNav/>`; keep owning the per-task `WorkspaceLayout`
  (`hydrateLayout`/`openFile`/`pruneFileTabs`) + tree fetch, now passed down to the
  Files + Viewers cards. Remove the sidebar/rail/dock column plumbing.
- `packages/web/src/App.tsx` — read/write `GlobalUiState.grid` via `patchGlobal`;
  stop threading the retired pane/dock/rail props; pass grid state + `connected` +
  `settings` toggle down. `Board` mode is untouched.
- `packages/web/src/components/WorkspaceView.module.css` — trim retired column styles
  (or superseded by the grid module).

### Possibly touched (verify, minimal)

- `packages/web/src/components/TerminalDock.tsx` / `terminalDock.ts` — the dock is
  retired from Workspace. Keep the files if nothing else imports them, but remove the
  dock render from `WorkspaceView`. The `terminalDock.ts` reducer + `Terminal`/
  `ChatPane` components are reused by the new `terminal`/`chat` cards. (Confirm no
  orphaned imports; `TerminalDock.test.tsx` stays green or is retired with the dock.)

## Implementation steps

1. **Types first (both mirrors).** Add to `server/src/types.ts` then copy verbatim to
   `web/src/types.ts`:
   - `export type GridCardId = 'pipeline' | 'concurrency' | 'reviewqueue' | 'newtask'
     | 'activetask' | 'workerlog' | 'tasklist' | 'files' | 'viewers' | 'chat' | 'terminal'`
   - `export type GridDensity = 'comfortable' | 'compact' | 'spacious'`
   - `export type GridCardStyle = 'accent' | 'flat' | 'outline' | 'elevated'`
   - `export type GridInteraction = 'reflow' | 'swap' | 'free'`
   - `export interface GridCardGeo { id: GridCardId; x: number; y: number; w: number;
     h: number; minW: number; minH: number; hidden?: boolean; minimized?: boolean }`
   - `export interface GridState { cards: GridCardGeo[]; density: GridDensity;
     cardStyle: GridCardStyle; interaction: GridInteraction }`
   - `grid?: GridState` on `GlobalUiState`.
   Run `npm run typecheck` to confirm the mirror.
2. **`gridLayout.ts` (RED→GREEN).** Port the mockup engine into pure functions:
   `COLS = 12`; `defaultCards(): GridCardGeo[]` (the seed layout, adapting the
   mockup's `state.layout` to the 11-card roster + sensible `minW/minH`);
   `collide(a,b)`; `compact(cards, pinnedId)`; `applyMove(state, id, x, y)`;
   `applyResize(state, id, w, h)` (clamp `minW/minH`, clamp `x+w ≤ COLS`);
   `hideCard`/`showCard`/`toggleMinimize`; `cellSize(gridW, density)` →
   `{ colW, gap, rowH }`; `cardRectPx(item, cell)`; `normalizeGrid`/`hydrateGrid`
   (tolerant merge of persisted `GridState` with `defaultCards()` — add missing
   roster ids, drop unknown ids, clamp geometry, dedupe). Interaction modes:
   `reflow` compacts, `swap` swaps the collided card back, `free` leaves overlaps.
3. **`dashboardData.ts` (RED→GREEN).** `pipelineCounts(tasks)` → ordered
   `{status,label,count,color}[]` + total (reuse `STATUS_LABEL`/`statusColor` order);
   `concurrency(tasks, maxLanes)` → `{ active, max, queued, lanes: {id,title}[] }`
   (active = `executing`; queued = `queued===true`); `reviewQueue(tasks)` →
   `{id,title,repoId,status,prUrl}[]` for `review`/`done`.
4. **`GridCard.tsx` + `WorkspaceGrid.module.css`.** Card chrome: header row with ⠿
   handle (`data-mode="move"`), title, minimize (−) and hide (×) buttons, body, and a
   corner resize handle (`data-mode="resize"`); `cardStyle` → token-based class; a
   minimized card renders header-only (mirrors `logMinimized`). All colors `var(--*)`.
5. **`WorkspaceGrid.tsx`.** ResizeObserver → `gridW`; `onPointerDown` on
   move/resize handles → pointer move/up updating the reducer (port the mockup's
   `onPointerMove`/`onPointerUp`, using `cellSize`/`cardRectPx`); render a ghost +
   height spacer; render each **non-hidden** card via a `CARD_REGISTRY`
   (`id → { title, accent: 'var(--…)', render(ctx) }`). Hidden/minimized cards stay
   mounted where they own a socket/session (`terminal`, `chat`, `viewers`) — toggle
   `display`, never unmount. `ctx` carries the props each content component needs
   (tasks, config, events/live, layout + onOpen, lifecycle callbacks) threaded from
   `WorkspaceView`. Persist every geo/visibility/option change via an
   `onGridChange(next: GridState)` prop → `patchGlobal({ grid })`.
6. **New data cards.** `PipelineCard`/`ConcurrencyCard`/`ReviewQueueCard` render the
   step-3 derivations with token styling (chips, funnel bar, lane bars, PR "Open"
   links — matching the mockup's structure, tokenized colors).
7. **`BottomNav.tsx`.** Static bar pinned bottom: Cards menu (checkbox list toggling
   each card's `hidden`), the three grid-option `<select>`s, a Settings button
   (existing modal), and the connection dot. Reuses the nav styling idiom.
8. **Rewire `WorkspaceView.tsx` + `App.tsx`.** `WorkspaceView` keeps the tree fetch +
   per-task `WorkspaceLayout` ownership and renders `<WorkspaceGrid/> + <BottomNav/>`.
   `App` sources `grid` from `GlobalUiState` (default via `hydrateGrid(undefined)`),
   drops the retired pane props. Remove the `TerminalDock` render.
9. **Validate + sync docs.** `npm run typecheck && npm run lint && npm test &&
   npm run build`. Run the `sync-docs` skill (this reshapes the Workspace section of
   `CLAUDE.md` + `frontend-react.md` significantly). UI-touching → capture a
   final-state screenshot of the grid via Playwright MCP and attach to the PR (best
   effort; note under Testing if unavailable). Stage the plan file.

## Test strategy

**Runner:** Vitest, web workspace (`environment: 'jsdom'`), run via `npm test`
(both workspaces) or `npm test -w @zmrng/web`. Consistent with the repo's existing
pure-reducer test suites (`workspaceLayout.test.ts`, `terminalDock.test.ts`).
The pointer/ResizeObserver/DnD glue in `WorkspaceGrid.tsx` is **not** unit-tested —
same policy as the untested drag handlers in `WorkspaceView.tsx`/`TerminalDock.tsx`;
its correctness rides on the pure reducer beneath it (which *is* tested) plus the
manual smoke + PR screenshot.

**New tests:**

- `packages/web/test/gridLayout.test.ts` — proves the ported engine:
  - `collide` — overlapping vs edge-adjacent (touching ≠ colliding) cell rects.
  - `compact` — packs cards upward with no overlaps; a `pinnedId` keeps its slot while
    others reflow around it.
  - `applyMove` — `reflow` compacts and removes overlap; `swap` exchanges positions
    with a single collided card; `free` leaves the moved card overlapping (no reflow).
  - `applyResize` — clamps to `minW`/`minH`, clamps `x + w ≤ COLS`, and reflows under
    `reflow`/`swap` but not `free`.
  - `cellSize` — the three densities yield distinct `rowH`/`gap`; `colW` is derived
    from `gridW` and never below the floor.
  - `hideCard`/`showCard`/`toggleMinimize` — flip the flags without dropping the card's
    stored geometry (so re-showing restores position).
  - `hydrateGrid`/`normalizeGrid` — seeds `defaultCards()` when given `undefined`;
    merges a partial persisted `GridState` (adds a missing roster id, drops an unknown
    id, clamps an out-of-bounds `x+w`); tolerates a malformed/non-array `cards` value
    without throwing (mirrors `hydrateLayout`'s tolerance).
- `packages/web/test/dashboardData.test.ts` — proves the card derivations against
  hand-built `Task[]` fixtures:
  - `pipelineCounts` — counts per status in the fixed display order, correct total,
    zero-count statuses handled.
  - `concurrency` — `active` counts only `executing`, `queued` counts `queued===true`,
    `max` echoes the passed `maxLanes`.
  - `reviewQueue` — includes only `review`/`done`, surfaces `prUrl`, excludes others.

**Type-mirror check:** `npm run typecheck` over both workspaces proves the
`GlobalUiState.grid` + grid-enum additions are mirrored server↔web (the cheap
convention check).

**Manual smoke (post-build):** `npm run dev` → Workspace mode: drag a card by its ⠿
header (reflow pushes neighbors), resize from the corner (clamps at min), hide a card
from its × / the Cards menu and re-show it (position restored), minimize a card
(header-only), switch density/card-style/interaction (layout + chrome update), reload
(layout persists), open the Terminal + Chat cards and confirm the PTY / `/ws/chat`
session survives hide→show, click a file in the Files card and confirm it opens in the
Viewers card, switch theme in Settings and confirm the grid recolors through tokens.
