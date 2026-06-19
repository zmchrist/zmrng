# Plan — Fix window not draggable (zmrng Tauri desktop app)

## Context

The zmrng `.app` window cannot be moved by grabbing its top edge. This is a **bug fix**
in the desktop app's window chrome. Per the CLAUDE.md app-only directive, the task is not
"done" until the `.app` is rebuilt with `npm run desktop:build` — editing source alone only
refreshes the browser/dev view; the shipped `.app` carries a stale bundled copy of
`web/dist` until re-bundled and re-built.

### Window setup (verified)

`packages/desktop/src-tauri/tauri.conf.json` declares the main window with:

- `"transparent": true`, `"macOSPrivateApi": true`, `windowEffects` (hudWindow, radius 12)
- `"titleBarStyle": "Overlay"`, `"hiddenTitle": true` → overlay traffic lights, **no native
  title strip**, so there is no OS-drawn draggable title bar. Dragging must be provided by
  the web content via Tauri drag regions.
- `withGlobalTauri: true` (in `app`) → Tauri's injected init script runs on the served page,
  so `data-tauri-drag-region` is honored regardless of the HTTP origin (the frontend is
  served by the sidecar over `http://127.0.0.1:<port>`).

Tauri version is **v2** (`Cargo.toml`: `tauri = { version = "2", ... }`,
`tauri.conf.json` `$schema` = config/2). In Tauri v2 + WKWebView on macOS, the supported
way to make a region draggable is the HTML attribute **`data-tauri-drag-region`** on the
element. The Electron-style CSS property `-webkit-app-region: drag` is **ignored by
WKWebView** and is dead code here.

### Current drag implementation (the bug)

Grep for drag across the repo returns exactly one site (`packages/web/`):

- `packages/web/src/App.tsx:110`
  ```tsx
  <div className={styles.dragbar} data-tauri-drag-region />
  ```
- `packages/web/src/App.module.css:11-18`
  ```css
  .dragbar {
    grid-column: 1 / -1;
    height: 28px;
    -webkit-app-region: drag;   /* Electron-only — WKWebView ignores this */
  }
  ```

Layout (`App.module.css` `.app`): a CSS grid `grid-template-columns: 348px 1fr;
grid-template-rows: auto 1fr;` with `padding: 0 12px 12px`. The `.dragbar` is row 1
(`grid-column: 1 / -1`, 28px). The visible content — `.rail` (left, contains `.brandbar`
with the "zmrng" wordmark + connection dot, then `NewTaskForm`, then `TaskList`) and
`.detail` (right pane) — sits in **row 2**.

The splash window (`packages/desktop/splash/index.html`, a separate `frontendDist`) has no
drag region and is out of scope — it is a fullscreen galaxy loader that warps on click.

### Why the window won't move

Two independent problems, both addressed:

1. **Wrong/dead mechanism.** The CSS relies on `-webkit-app-region: drag`, which WKWebView
   ignores. Only the `data-tauri-drag-region` attribute actually works in Tauri v2; the CSS
   line contributes nothing.
2. **Grab zone too thin / in the wrong place.** Even with the attribute working, the only
   draggable surface is a single **invisible 28px strip** at the very top. A user
   intuitively grabs the **visible** frosted-glass header — the `.brandbar` band showing the
   "zmrng" wordmark — which lives in grid-row 2 and is **not** a drag region. So grabbing
   the visible top of the pane does nothing.

The fix makes the whole top header band reliably draggable (covering both "nothing moves at
all" and "the grabbable strip is too thin to hit") while keeping every interactive control
clickable.

### Tauri v2 drag-region semantics (critical correctness constraint)

A drag begins **only when the element that the user pressed on is itself marked
`data-tauri-drag-region`** (the attribute does not "bubble" to make children draggable, and
children do not inherit it). Therefore:

- Marking a container (e.g. `.brandbar`) makes only its **own empty padding area**
  initiate a drag.
- Child elements **without** the attribute (buttons, inputs, the connection dot, the
  wordmark text, `NewTaskForm` fields, `TaskList` rows) remain normal click targets — they
  are never the drag element, so their clicks/focus are unaffected.

This is why widening the drag region to the brandbar is safe: nested interactive controls
keep working precisely because the press target is the child, not the marked container.

## User story

```
As the solo operator of zmrng
I want to grab the top of the window and move it like any normal macOS window
So that I can position the app where I want instead of it being stuck in place
```

## Design decisions (assumptions carried from clarify)

1. **Keep the borderless overlay chrome.** Do not revert to a native title bar. The fix
   stays within the web drag-region approach the app already chose
   (`titleBarStyle: Overlay`, `hiddenTitle`). No `tauri.conf.json` window changes are
   required — the existing `macOSPrivateApi` + overlay config already supports
   `data-tauri-drag-region`; we verify (not modify) it.
2. **Widen the grab zone to the visible header.** Keep the full-width top strip (it clears
   the traffic-light band) **and** make the visible `.brandbar` band draggable so grabbing
   the obvious "top of the pane" works.
3. **Remove the dead `-webkit-app-region` line** rather than leave misleading Electron-only
   CSS in the file.
4. **No type changes.** This is a pure window-chrome/CSS + JSX-attribute fix; it does not
   touch `types.ts`, so the server↔web type mirror is unaffected.
5. **Out of scope:** the splash window, the right detail pane's interactive header, and any
   broader window-controls redesign. Keep the change minimal and focused on drag.

## Files to change

- `packages/web/src/App.tsx` — add `data-tauri-drag-region` to the `.brandbar` container
  (the visible header band) so grabbing the wordmark area drags the window.
- `packages/web/src/App.module.css` — delete the dead `-webkit-app-region: drag` line from
  `.dragbar`; update the explanatory comment to reflect that dragging is driven solely by
  `data-tauri-drag-region` in Tauri v2 (WKWebView ignores `-webkit-app-region`). Optionally
  ensure the strip remains a comfortable height (≈28px) to clear the traffic lights.

No new files. No backend changes. No `tauri.conf.json` / `main.rs` changes.

## Implementation steps

1. **`packages/web/src/App.tsx` — make the brandbar draggable.**
   On the brandbar wrapper (currently `<div className={styles.brandbar}>` at ~line 112),
   add the `data-tauri-drag-region` attribute:
   ```tsx
   <div className={styles.brandbar} data-tauri-drag-region>
     <span className={styles.brand}>zmrng</span>
     <span className={`${styles.dot} ${connected ? styles.dotOn : ''}`} title={...} />
   </div>
   ```
   The child `<span>`s do not carry the attribute, so they are not drag elements; the dot's
   tooltip and the wordmark stay as-is. Dragging starts only from the brandbar's own empty
   space (its `padding: 20px 20px 14px` and the gap between wordmark and dot). Leave the
   existing top `.dragbar` strip in place (`App.tsx:110`) — it stays the primary grab band
   spanning the full width below the traffic lights.

2. **`packages/web/src/App.module.css` — remove dead CSS, fix the comment.**
   In the `.dragbar` rule (lines ~11-18), delete `-webkit-app-region: drag;`. Update the
   block comment so it states the truth for Tauri v2: the strip is draggable via the
   `data-tauri-drag-region` attribute in the native WKWebView window; `-webkit-app-region`
   is an Electron-only property that WKWebView ignores, so it is intentionally absent. Keep
   `grid-column: 1 / -1;` and the height (≈28px) so the strip still clears the traffic
   lights. (No `.brandbar` CSS change is required — the attribute is the only thing that
   makes it draggable; its existing layout/padding is the grab area.)

3. **Do NOT mark interactive controls.** Confirm by reading the JSX that no `<button>`,
   `<input>`, `<select>`, `<a>`, `TaskList` row, or `NewTaskForm` field receives
   `data-tauri-drag-region`. Only the empty header containers (`.dragbar` strip via the
   existing attribute, `.brandbar` via the new attribute) are drag regions. This preserves
   the Tauri v2 rule that nested controls keep their clicks because the press target is the
   child, not a marked container.

4. **Rebundle + rebuild the `.app` (mandatory — app-only directive).**
   Source edits only refresh the dev/browser view. The shipped `.app` ships a stale bundled
   `web/dist` until rebuilt, so finish with:
   ```bash
   npm run desktop:build   # build → bundle:sidecar → tauri build → fresh .app
   ```
   This re-runs `vite build` for `web/dist`, re-bundles the sidecar, and produces a fresh
   `.app` that actually carries the working drag region. The task is **not done** after
   `npm run build` alone.

## Testing strategy

There is no test framework — validation is typecheck + lint + build, plus a manual drag
smoke test in the rebuilt `.app`.

### Automated validation (run in order)

```bash
npm run lint        # ESLint, both workspaces
npm run typecheck   # tsc --noEmit, both workspaces (catches any JSX/type slip + mirror drift)
npm run build       # tsc (server) + vite build (web)
npm run desktop:build   # build → bundle:sidecar → tauri build → fresh .app (REQUIRED)
```

### Manual smoke test (in the rebuilt native `.app`, not the browser)

1. Launch the freshly built `.app`.
2. Press-and-drag on the **top strip** below the traffic lights → window moves.
3. Press-and-drag on the **visible "zmrng" header band** (brandbar empty area) → window
   moves.
4. Click the connection **dot** → still shows its tooltip / is not swallowed by a drag.
5. Click into the **New Task** title/body fields and the model/effort/style/repo selects →
   all focus and accept input normally (no drag hijack).
6. Click a **task row** in the list → it selects normally.
7. Confirm the **traffic-light buttons** (close/minimize/zoom) still work and are not
   covered by the drag strip.

## Validation commands

```bash
# Level 1 — Syntax & Style
npm run lint

# Level 2 — Type Safety
npm run typecheck

# Level 3 — Build (website)
npm run build

# Level 4 — App rebuild (REQUIRED; ships the fix into the .app)
npm run desktop:build
```

## Acceptance criteria

- [ ] Dragging the top strip below the traffic lights moves the window.
- [ ] Dragging the visible "zmrng" header band (brandbar) moves the window.
- [ ] The dead `-webkit-app-region: drag` line is removed and the comment reflects the
      Tauri v2 `data-tauri-drag-region` mechanism (WKWebView ignores `-webkit-app-region`).
- [ ] All nested interactive controls (NewTaskForm inputs/selects, task rows, the connection
      dot, buttons) still receive clicks/focus — no drag hijack.
- [ ] Traffic-light buttons remain functional and unobscured.
- [ ] `npm run lint`, `npm run typecheck`, and `npm run build` all pass.
- [ ] `npm run desktop:build` completes and produces a fresh `.app` that ships the working
      drag region (verified by the manual smoke test in the native window).
- [ ] No changes to `packages/{server,web}/src/types.ts` (no type-mirror impact).

## Risks & gotchas

- **App-only trap (highest risk).** Forgetting `npm run desktop:build` leaves the shipped
  `.app` unchanged even though the dev view works. The fix is only real once the `.app` is
  rebuilt. This is the single most likely way to "fix it" and still ship a broken window.
- **Marking an interactive ancestor.** If `data-tauri-drag-region` were placed on a
  container that wraps buttons/inputs such that the user presses the container itself, those
  presses would start a drag. Mitigation: only mark the empty header containers
  (`.dragbar`, `.brandbar`); never mark an element a user is meant to click. Verified in
  step 3.
- **Verifying in the browser instead of the app.** `data-tauri-drag-region` is inert in a
  plain browser (no Tauri runtime), so the dev/browser view will *always* appear
  "undraggable." Drag must be validated in the native `.app`, not `npm run dev:web`.
- **Traffic-light overlap.** Keep the strip height (~28px) and avoid making any element that
  visually sits under the traffic lights consume their clicks. The existing 28px clears the
  band; do not shrink it.

## Confidence

**One-pass success confidence: 9/10.** The root cause is identified and isolated to two
small edits in two frontend files with no type or backend impact. The only residual
uncertainty is environmental — the `tauri build` toolchain (Rust) must be present for
`npm run desktop:build` to complete; if it is unavailable in the execute environment, the
source fix + `npm run build` still validate, and the app rebuild is the documented final
step.
