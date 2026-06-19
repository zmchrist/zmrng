# Plan: Galaxy warp loading screen

## Feature

Replace the static frosted-glass splash with the **Galaxy Loader** as zmrng's launch
loading screen. The galaxy idle-loops while the Node sidecar boots; the moment the engine
is ready it performs a **warp dive** (2.5 s zoom into the galactic core) and a final
**white bloom** masks the cut over to the React app — a seamless "fly into the app"
transition. The galaxy is painted over the app's translucent **glass veil**
(`rgba(9, 11, 14, 0.46)`) on a transparent body, so the macOS vibrancy reads faintly
behind it and the splash matches the smoked-glass theme.

### User story

```
As the operator launching the zmrng desktop app
I want a galaxy loading screen that warps into the app when the engine is ready
So that startup feels intentional and on-brand instead of a bare spinner that flashes by
```

### Type & complexity

- **Type:** Enhancement (replace existing splash + add a boot handoff).
- **Complexity:** Medium. The animation port is mechanical; the risk is the Rust↔JS
  boot handshake and the cross-navigation white mask.
- **Workspaces touched:** `packages/desktop` (splash + Rust shell + Tauri config), and a
  small optional polish in `packages/web` (incoming white fade).

## Decisions (locked with operator)

1. **Integration:** Splash + warp-dive handoff. Galaxy is the Tauri `frontendDist` splash;
   Rust signals readiness; the galaxy warps; the white bloom masks the navigate to the app.
2. **Background:** Match the glass veil — transparent body + `--veil rgba(9, 11, 14, 0.46)`,
   vibrancy behind. (Not the authored solid `#03040a`.)
3. **No React / no DC runtime.** Port the canvas animation to **dependency-free vanilla JS**.
   The `loadscreen/` folder (`Galaxy Loader.dc.html`, `support.js`) is *source reference only*
   and is **not shipped** — `support.js` (the 54 KB React/DC runtime) and the Google-Fonts
   `<link>`s are dropped (the galaxy renders no text).

## Context references (read before implementing)

| File | Why |
|------|-----|
| `loadscreen/Galaxy Loader.dc.html` | **Source of the animation.** Port the canvas logic from its `componentDidMount` (lines ~130–352) verbatim; refs → `getElementById`, props → hardcoded constants. |
| `packages/desktop/splash/index.html` | The file being **replaced**. Note the glass-token mirror block + transparent body — reuse that veil approach. |
| `packages/desktop/src-tauri/src/main.rs` | The boot flow. The health-poll thread (lines ~109–126) currently calls `win.navigate(...)` directly — this is what changes. |
| `packages/desktop/src-tauri/tauri.conf.json` | `frontendDist: "../splash"`, window `transparent: true` + `hudWindow` vibrancy. Add `withGlobalTauri`. |
| `packages/desktop/src-tauri/capabilities/default.json` | `core:default` already covers event listen/emit. |
| `packages/web/src/theme.css` | Veil/smoke tokens to mirror (`--veil`, smoke radials, `--accent`). Source of truth for the "glass feel". |
| `packages/web/index.html` | Optional polish: incoming white-fade overlay so the bloom hands off seamlessly. |

## Animation port — props to hardcode

From the `.dc.html` `data-props` defaults (the galaxy never exposed these as runtime UI):

```
arms = 6, fullness = 1.65, vibrance = 1.5, tiltX = 65, tiltY = 0, spinZ = -22
```

Everything else (`buildGalaxy`, `makeBlob`, the `SPR`/`palette` tables, the `draw` loop,
the warp state machine `WARP_DUR = 2500`, `ZMAX = 19`, the white-bloom handoff) ports as-is.
Drop: the React lifecycle wrapper, `componentDidUpdate`, the `hintRef`, and the unused
`bg`/twinkle "press to enter" affordance is **kept** as the idle loop but the pointer/Enter
*manual* warp trigger is removed (warp is driven by the engine-ready event instead).

## Boot handshake (race-free)

The hazard: Rust could emit `engine-ready` before the splash's JS listener is registered,
or the splash could be ready long before the sidecar. Solve with a **two-signal handshake**;
`engine-ready` is emitted exactly once, only after BOTH are true.

```
splash JS loads ──emit "splash-ready"──▶ Rust  (sets splash_ready = true)
sidecar port up ─────────────────────▶ Rust  (sets sidecar_ready = true)
                       both true ──emit "engine-ready" { port } ──▶ splash JS
splash JS: warp dive (2.5 s) ──▶ white bloom full ──▶ window.location.replace("http://localhost:<port>/")
```

- Splash owns navigation (it has the port from the event payload) — Rust no longer calls
  `win.navigate`.
- A JS-side **safety timeout** (e.g. 6 s after `engine-ready`) forces the navigate even if
  the warp loop errors, so the app can never be stranded behind the splash.

## Implementation tasks

### 1. `packages/desktop/splash/index.html` — rewrite as the vanilla galaxy

- Replace the card markup with: `<canvas id="gl-canvas">`, the edge-vignette div
  (`z-index: 2`, the authored `radial-gradient(... rgba(2,3,8,0.55) 100%)`), and the white
  bloom div `<div id="gl-bloom">` (`z-index: 9`, `opacity: 0`, `background:#fff`).
- **Background = glass veil, not solid.** Body `background: transparent`; add a fixed veil
  layer mirroring `theme.css`:
  - `--veil: rgba(9, 11, 14, 0.46)` plus the two `--smoke-floor`-style corner radials.
  - Remove the authored opaque `#03040a` body bg and the opaque radial-gradient backdrop
    div — the galaxy must composite over the veil + vibrancy, not a black plate.
- Inline `<script>` (no modules, no imports): port the animation. Structure:
  - constants (props above), `makeBlob`, `SPR`, `palette`, `buildGalaxy`, `resize`, `draw`.
  - `phase` state machine: `idle` → (on `engine-ready`) `warp` → `done`.
  - `startWarp()` triggered by the Tauri event, not pointer/keydown.
  - On the final white frame (`wp >= 1`): set bloom opacity 1, then navigate
    `window.location.replace("http://localhost:" + port + "/")`.
- **Tauri glue (uses `window.__TAURI__`, requires `withGlobalTauri`):**
  ```js
  const T = window.__TAURI__;
  if (T?.event) {
    T.event.listen('engine-ready', (e) => startWarp(e.payload /* port */));
    T.event.emit('splash-ready');
  }
  ```
  Guard for the plain-browser dev case (`T` undefined) → galaxy just idle-loops forever
  (acceptable; the splash is only ever seen inside the Tauri shell).
- Respect `prefers-reduced-motion` (skip the warp swirl intensification; still navigate).

### 2. `packages/desktop/src-tauri/tauri.conf.json` — enable the global API

- Add `"withGlobalTauri": true` under `"app"` so the no-build splash can reach
  `window.__TAURI__.event`. (Without this the splash has no Tauri API and the handshake
  silently no-ops.)
- Leave `frontendDist`, `transparent`, and `windowEffects` unchanged.

### 3. `packages/desktop/src-tauri/src/main.rs` — emit instead of navigate

- Add `use tauri::{Emitter, Listener};` (alongside the existing `Manager`).
- Introduce a small shared readiness state (single-emit guarded), e.g.:
  ```rust
  struct Boot { port: u16, sidecar: bool, splash: bool, emitted: bool }
  ```
  stored as `Mutex<Boot>` via `app.manage(...)`. Provide `try_emit_ready(app)` that locks,
  flips the flag once both `sidecar && splash && !emitted`, sets `emitted = true`, and
  `app.emit("engine-ready", port)`.
- **Health-poll thread:** on `TcpStream::connect` success, set `sidecar = true` and call
  `try_emit_ready(...)` — **remove** the direct `win.navigate(...)` block.
- **Listen for the splash:** in `setup`, `app.listen("splash-ready", move |_| { set splash = true; try_emit_ready(...) })`.
- Keep the `~15 s` poll window; if it expires without the port, do nothing (same failure
  mode as today — the galaxy keeps looping; consider a future visible error, out of scope).

### 4. `packages/web/index.html` — incoming white fade (polish, recommended)

To make the bloom→app cut seamless across the page navigation, add an inline overlay that
paints white immediately on the app's first frame and fades out (no React dependency, so it
covers the React mount gap):

```html
<div id="boot-veil"></div>
<style>
  #boot-veil { position: fixed; inset: 0; z-index: 9999; background: #fff;
    pointer-events: none; animation: boot-fade 520ms ease-out forwards; }
  @keyframes boot-fade { to { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { #boot-veil { animation: none; opacity: 0; } }
</style>
<script>setTimeout(() => document.getElementById('boot-veil')?.remove(), 600);</script>
```

This is a tiny, self-contained addition; it also smooths a normal browser reload. If the
operator dislikes a white flash on every dev reload, gate it behind a `?boot=1` query the
splash appends to the navigate URL.

### 5. Cleanup / housekeeping

- Leave `loadscreen/` as untracked reference, **or** move it under `.claude/files/` /
  delete it — it must never end up in `splash/` or the bundle. Decide at implementation time;
  default: delete after the port is verified (it is pure reference).
- No `bundle-sidecar.mjs` change — the splash is Tauri `frontendDist`, not part of the
  Node sidecar bundle.
- No `capabilities/default.json` change expected (`core:default` covers `event` listen/emit).
  If `engine-ready`/`splash-ready` are blocked at runtime, add explicit
  `"core:event:allow-listen"` and `"core:event:allow-emit"`.

## Testing strategy

No automated tests exist (typecheck + lint + build is the gate). Validation:

1. **Static gate (must pass):**
   ```bash
   npm run typecheck && npm run lint && npm run build
   ```
   (These cover `packages/web` only; the splash is static HTML and the Rust shell is built
   by Tauri. The web index.html change must not break the Vite build.)
2. **Rust compile:** `cargo check` inside `packages/desktop/src-tauri` (or via the desktop
   build) — confirm the `Emitter`/`Listener` imports and the `Mutex<Boot>` state compile.
3. **Full app build (the real "done" per CLAUDE.md):**
   ```bash
   npm run desktop:build
   ```
   Then launch the produced `.app` and confirm the manual smoke below.
4. **Manual smoke (desktop):**
   - Galaxy paints immediately on launch over the glass veil (desktop faintly visible behind),
     idle-loops while the engine boots.
   - When the engine is ready the galaxy warps in, white-blooms, and the app appears with no
     hard cut or long blank/black flash.
   - Cold boot (slow engine) and warm boot (fast engine) both reach the app — the handshake
     fires once, warp always plays, safety timeout never strands the splash.
   - Quit still cleanly kills the sidecar (handshake changes don't touch `kill_sidecar`).
5. **Dev sanity:** `npm run dev:web` in a browser still loads the app (the splash/handshake
   only runs inside Tauri; `window.__TAURI__` is absent → no errors).

## Validation commands

```bash
# Level 1–3 — syntax / types / web build
npm run lint
npm run typecheck
npm run build

# Level 4 — Rust shell compiles
( cd packages/desktop/src-tauri && cargo check )

# Level 5 — the real artifact: a fresh .app
npm run desktop:build
```

## Acceptance criteria

- [ ] Launching the `.app` shows the galaxy (not the old spinner card) over the glass veil,
      with vibrancy faintly visible behind it.
- [ ] The galaxy idle-loops during sidecar boot and warp-dives into the app the moment the
      engine is ready; the white bloom masks the transition (no jarring black/blank flash).
- [ ] The boot handshake is race-free: warp always plays exactly once regardless of boot
      speed, and a stalled warp can never strand the app behind the splash (safety timeout).
- [ ] The splash ships **no** React, `support.js`, DC runtime, or external font requests.
- [ ] `npm run typecheck && npm run lint && npm run build` pass; `cargo check` passes;
      `npm run desktop:build` produces a runnable `.app`.
- [ ] Quitting the app still SIGTERMs the sidecar and reaps the claude children.

## Risks & gotchas

- **`withGlobalTauri` is mandatory.** A no-build static splash cannot `import` the Tauri API;
  without `withGlobalTauri: true` the handshake silently does nothing and the app never loads.
  This is the single highest-risk item — verify first.
- **Event race.** Do not emit `engine-ready` from the health-poll thread unconditionally — it
  may beat the splash listener. The two-signal handshake (`splash-ready` + sidecar-up) is what
  prevents a hang.
- **Cross-navigation flash.** `window.location.replace` tears down the splash (and its white
  bloom) before the app paints. The `packages/web/index.html` boot-veil (task 4) is what keeps
  the white continuous; without it expect a brief vibrancy flash (soft, but present).
- **Contrast over the veil.** The galaxy was authored on solid `#03040a`; on the 0.46 veil the
  fainter stars lose contrast against a bright desktop. The edge vignette + veil keep the core
  readable; if it reads washed out, nudge `--veil` toward `0.55` (still within "glass feel")
  rather than reintroducing an opaque plate.
- **`prefers-reduced-motion`.** Honour it — skip the swirl ramp but still navigate, or the
  app never loads for reduced-motion users.
- **Branch hygiene.** The working tree currently holds unrelated staged PIV-workflow changes
  on `feat/zc/task-dropdown-options`. Implement this on its own branch off `origin/main`
  (`feat/zc/galaxy-loadscreen`) to keep the diff clean.

## Confidence

**~8/10** for one-pass success. The animation port is low-risk (verbatim canvas code). The
two genuine unknowns are the `withGlobalTauri` + capability surface (mitigated: documented and
`core:default` already covers events) and the exact `Emitter`/`Listener` API shape for the
handshake (mitigated: standard Tauri v2 traits). The visual polish of the veil-contrast and
the cross-navigation white may need one tuning pass after the first `desktop:build`.
