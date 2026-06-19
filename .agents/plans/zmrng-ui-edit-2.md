# Plan — zmrng UI edit 2 (embedded window controls · collapsible description pane · total-tokens usage)

## Context

Three frontend-focused UI edits to the desktop app. All work targets the desktop **app**
(`packages/desktop` Tauri shell), so the task is not "done" until the `.app` is rebuilt
with `npm run desktop:build` (per CLAUDE.md app-only directive).

The window today uses the **native macOS title bar**: `tauri.conf.json` declares the main
window with `transparent: true`, `macOSPrivateApi: true`, and `windowEffects` (hudWindow),
but no `titleBarStyle` / `decorations` override → the OS draws a standard title bar above
our frosted-glass content. There is **no** custom drag region anywhere in the codebase
(grep for `tauri-drag-region` / `app-region` returns nothing).

The app's React frontend is served by the sidecar over `http://127.0.0.1:<port>`; the
Tauri webview loads it with `withGlobalTauri: true`, so Tauri's injected init script runs
on the page and `data-tauri-drag-region` is honored regardless of the HTTP origin.

`TaskDetail` (`packages/web/src/components/TaskDetail.tsx`) renders the right-pane header:
title + status pill, then the full `task.body` description (`.body`, `white-space: pre-wrap`,
no height cap), then badges (repo/model/effort/style), then meta (branch/plan/auth), then —
only when `status === 'review' || 'done'` — a usage box with **five** items:
`tokens in`, `out`, `cache`, `est. cost` (`$costUsd`), `turns`.

`TaskUsage` (`packages/{server,web}/src/types.ts`) is
`{ tokensIn, tokensOut, tokensCache, costUsd, turns }`. **No type change is needed** —
`costUsd` and `turns` stay on the type (the server still records them); we only stop
rendering them and instead render a single summed total.

## User story

```
As the solo operator of zmrng
I want a minimal embedded window chrome, a compact (collapsible) task description, and a
single total-tokens count instead of a cost/turns breakdown
So that the window looks clean and minimal, the chat gets the vertical space, and the usage
readout reflects my Max subscription (tokens, not dollars)
```

## Design decisions (assumptions carried from clarify)

1. **Window chrome** → native **overlay** title bar (`titleBarStyle: "Overlay"` +
   `hiddenTitle: true`). This keeps the real, working traffic-light buttons (close /
   minimize / maximize) inset top-left and floating over our transparent content, while
   removing the title-bar strip. This is the minimal/native path — we do NOT hand-build
   HTML buttons (that would mean reimplementing window controls and is more fragile).
2. **Description pane** → default **collapsed** (title + pill + badges + meta only). A
   toggle arrow at the **bottom** of the header expands to reveal the full `task.body`
   (current behavior) and collapses back. Local `useState` drives it.
3. **Token display** → single **total tokens** value = `tokensIn + tokensOut + tokensCache`;
   drop `est. cost` and `turns`. Still gated to detail view (TaskDetail is the detail view)
   + `review`/`done` status.

## Changes

### 1. Embedded window controls — `packages/desktop/src-tauri/tauri.conf.json`

In the single `app.windows[0]` object, add two keys (alongside the existing
`transparent`, `windowEffects`, etc.):

```jsonc
"titleBarStyle": "Overlay",
"hiddenTitle": true,
```

- `titleBarStyle: "Overlay"` (Tauri v2 enum `Visible | Transparent | Overlay`) hides the
  title-bar strip but keeps the native traffic-light controls, overlaid on the webview
  content at the top-left. Decorations stay enabled (default) — required for the buttons.
- `hiddenTitle: true` suppresses the "zmrng" title text so nothing but the buttons shows.
- Keep `transparent: true`, `macOSPrivateApi: true`, and `windowEffects` as-is.

### 2. Top drag strip + traffic-light clearance — web shell

The traffic lights now float over the **top-left** of the content (the left rail). Two
things are needed: (a) a draggable region so the frameless window can still be moved, and
(b) top padding so content (the rail's "zmrng" brand) clears the buttons.

**`packages/web/src/App.tsx`** — add a slim full-width drag strip as the first child of
`.app`, spanning both grid columns:

```tsx
<div className={styles.dragbar} data-tauri-drag-region />
```

Because `.app` is a 2-col grid, give the dragbar `grid-column: 1 / -1` so it spans the top.
The `data-tauri-drag-region` attribute is intercepted by Tauri to drag the window; in the
plain browser dev view it is an inert empty div (harmless).

**`packages/web/src/App.module.css`** — add the dragbar and shift the grid down so the
strip + traffic lights have room:

```css
.app {
  /* existing: display:grid; grid-template-columns: 348px 1fr; height:100vh;
     overflow:hidden; gap:12px; */
  grid-template-rows: auto 1fr;        /* dragbar row + content row */
  padding: 0 12px 12px;                /* drop top padding; dragbar provides it */
}

.dragbar {
  grid-column: 1 / -1;
  height: 28px;                        /* clears the macOS traffic lights */
  -webkit-app-region: drag;            /* belt-and-suspenders for the drag */
}
```

Notes:
- `.rail` and `.detail` currently sit in an implicit single row; adding
  `grid-template-rows: auto 1fr` puts the dragbar in row 1 and both panels in row 2. The
  rail/detail must therefore live in row 2 — set `grid-row: 2` is unnecessary because
  they are the 2nd and 3rd grid items after the dragbar; instead give the dragbar
  `grid-column: 1 / -1` (full first row) and the two panels flow into row 2 automatically.
  **Verify in the dev view that rail + detail render side-by-side in row 2** (if the
  auto-placement misbehaves, pin `.rail { grid-row: 2 } .detail { grid-row: 2 }`).
- Keep using design tokens; the dragbar has no visible styling (transparent), so no token
  is required for it. Height `28px` is a structural value (matches the macOS traffic-light
  band), acceptable like the existing structural `padding`/`gap` pixel values in this file.
- Do not remove `overflow: hidden` / `height: 100vh`.

### 3. Collapsible description pane — `packages/web/src/components/TaskDetail.tsx`

- Add local state: `const [showBody, setShowBody] = useState(false)` (default collapsed).
- Gate the description: render `<p className={styles.body}>{task.body}</p>` **only when**
  `showBody` is true. Render it only if `task.body` is non-empty (avoid an empty expand).
- Add a toggle control at the **bottom of the header**, after the `.meta` row and before
  the usage box, shown only when `task.body` is non-empty:

```tsx
{task.body && (
  <button
    type="button"
    className={styles.bodyToggle}
    aria-expanded={showBody}
    onClick={() => setShowBody((v) => !v)}
  >
    {showBody ? '▴ Hide description' : '▾ Show description'}
  </button>
)}
```

- Keep title/pill/badges/meta always visible (the collapsed state shows name + pills).
- Move the `<p className={styles.body}>` so it sits between `.meta` and the toggle, or keep
  it above and gate it — order to land on: **badges → meta → (body when expanded) → toggle**,
  so the arrow is always at the bottom of the header as requested. Implement by rendering
  the gated `.body` right after `.meta` and the toggle right after `.body`.

**`packages/web/src/components/TaskDetail.module.css`** — add a minimal frosted-token
toggle button:

```css
.bodyToggle {
  align-self: flex-start;
  margin-bottom: 14px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-dim);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: color var(--transition), background var(--transition),
    border-color var(--transition);
}
.bodyToggle:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
```

(Header is not a flexbox today; `align-self` is harmless. If alignment looks off, drop
`align-self` — the button is block-level and left-aligned by default.)

### 4. Simplified total-tokens usage — `packages/web/src/components/TaskDetail.tsx`

Replace the five `.usageItem` spans with a single total:

```tsx
{(task.status === 'review' || task.status === 'done') && (
  <div className={styles.usage}>
    <span className={styles.usageItem}>
      <span className={styles.usageLabel}>tokens</span>
      <span className={styles.usageValue}>
        {fmt(task.usage.tokensIn + task.usage.tokensOut + task.usage.tokensCache)}
      </span>
    </span>
  </div>
)}
```

- Drop `est. cost` (`costUsd`) and `turns` from the render. No reference to `costUsd` /
  `turns` remains in the component, so no unused-var lint issue (they were read inline off
  `task.usage`, never destructured).
- Keep the existing `.usage` / `.usageItem` / `.usageLabel` / `.usageValue` CSS as-is
  (now styling a single item). No CSS change required here.
- `fmt()` already rounds + groups with `toLocaleString('en-US')`.

### 5. No type changes

`TaskUsage` keeps `costUsd` and `turns` (server `runner.ts`/`db.ts` still record them).
This is intentional: we change presentation only. **Do not** edit `types.ts` in either
workspace (no mirror drift to manage).

### 6. Docs sync (end of session, before commit)

Run the `sync-docs` skill. Likely touch:
- `CLAUDE.md` splash/desktop note → mention the overlay title bar + drag strip.
- `.claude/docs/implementation-history.md` → short entry for this UI pass.
Keep it light; this is a UI-only change.

## Files touched

| File | Change |
|------|--------|
| `packages/desktop/src-tauri/tauri.conf.json` | add `titleBarStyle: "Overlay"`, `hiddenTitle: true` to the window |
| `packages/web/src/App.tsx` | add top `data-tauri-drag-region` strip spanning the grid |
| `packages/web/src/App.module.css` | dragbar styles + `grid-template-rows`, adjust `.app` padding |
| `packages/web/src/components/TaskDetail.tsx` | collapsible `showBody` state + toggle; single total-tokens render |
| `packages/web/src/components/TaskDetail.module.css` | add `.bodyToggle` button styles |
| docs (CLAUDE.md / implementation-history.md) | brief sync via `sync-docs` |

## Testing / validation strategy

No test framework — validation is typecheck + lint + build, then the app rebuild + manual
smoke. Run from the zmrng repo root:

```bash
npm run typecheck        # both workspaces; catches any TSX slip
npm run lint             # ESLint both workspaces (watch react-hooks rules)
npm run build            # tsc(server) + vite build(web)
npm run desktop:build    # build → bundle:sidecar → tauri build → fresh .app  (REQUIRED)
```

Manual smoke (web dev view covers 2 of 3; window chrome needs the native app):
- `npm run dev:web` → confirm the description pane is collapsed by default; the bottom
  arrow toggles the full body in/out; rail + detail still render side-by-side under the
  drag strip.
- Select a `review`/`done` task → usage box shows a single `tokens` total, no cost/turns.
- After `npm run desktop:build`, launch the `.app` → no native title-bar strip; traffic
  lights float top-left over the rail and work (close/min/max); dragging the top strip
  moves the window; the brand "zmrng" is not hidden behind the buttons.

## Acceptance criteria

- [ ] Native title-bar strip gone; traffic-light buttons embedded top-left and functional.
- [ ] Window is draggable via the top strip; content clears the traffic lights.
- [ ] TaskDetail description pane defaults to collapsed (name + pill + badges + meta only).
- [ ] A bottom arrow expands to the full description and collapses back (▾/▴).
- [ ] Finished-task usage shows a single total-tokens number; no cost, no turns.
- [ ] Usage still only appears in detail view for `review`/`done` tasks.
- [ ] `typecheck`, `lint`, `build` all pass; `.app` rebuilt via `desktop:build`.
- [ ] No `types.ts` changes (no mirror drift); design tokens used (no new hard-coded colors).

## Risks / gotchas

- **Overlay + transparent interaction.** `titleBarStyle: "Overlay"` with `transparent:true`
  + hudWindow is the intended combo, but verify the traffic lights are visible/clickable
  over the frosted surface after `desktop:build`. If the buttons are hard to see against
  light content, that is cosmetic only (still functional). Fallback if Overlay misbehaves:
  `titleBarStyle: "Transparent"` (same idea, buttons slightly differently inset).
- **Drag region only works in the native app**, not the browser dev view — that's expected;
  `data-tauri-drag-region` is inert in a plain browser. Don't treat the dev view's
  non-dragging strip as a bug.
- **Grid row auto-placement.** Adding `grid-template-rows: auto 1fr` + a full-width dragbar
  must leave rail/detail in row 2 side-by-side. If they collapse into one column, pin
  `grid-row: 2` on both `.rail` and `.detail` (documented above).
- **Rebuild trap (CLAUDE.md).** `npm run build` only refreshes the website bundle; the
  shipped `.app` carries a stale `web/dist` until `desktop:build` re-bundles. The task is
  not complete until `desktop:build` runs clean.
- **react-hooks lint.** `showBody` is plain `useState` toggled in an `onClick`, not synced
  in an effect — compliant with the repo's `set-state-in-effect` rule.

## Confidence

**High (8.5/10)** for one-pass success. The collapsible pane and token summary are
self-contained React/CSS edits with no type or server changes. The only real unknown is
the exact visual result of the overlay title bar on the transparent hudWindow, which is a
config two-liner with a documented fallback and is only fully verifiable after
`desktop:build`.
