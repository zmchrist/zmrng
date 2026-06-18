# Plan: Smokey brushed-glass UI overhaul

## Goal
Make the zmrng desktop `.app` read as **translucent, brushed smokey glass** you can
actually see through a bit — less color, more glass. Remove the flashing green
connection light, glass up the dropdowns, and switch to a distinctive modern typeface
that pops.

Operator decisions (clarify phase): **1c** real window transparency + heavy internal
frost · **2a** neutral smoke palette, keep status pills colored · **3a** kill the flash
+ green, leave a static neutral dot · **4c** pick the font (aesthetics skill → NOT the
generic Space Grotesk/Inter).

## Approach

### 1. Real see-through window (Tauri)
`packages/desktop/src-tauri/tauri.conf.json`
- Add `"transparent": true` to the `main` window.
- Add macOS vibrancy via `"windowEffects": { "effects": ["hudWindow"], "state": "active", "radius": 16 }`
  so the desktop behind is sampled + blurred into a dark smoke.
- Add `"macOSPrivateApi": true` under `app` (required for transparent macOS windows).

`packages/desktop/splash/index.html`
- Neutralize the splash to the smoke palette and make `html`/`body` transparent so the
  first paint already shows the vibrancy (no opaque flash before navigate).

### 2. Neutral smoke palette + transparent canvas
`packages/web/src/theme.css` (single source — all component CSS uses tokens, verified no
hard-coded colors elsewhere)
- `--bg` → `transparent`; drop the colorful cyan/azure/violet aurora; replace
  `body::before/::after` with a faint neutral-grey smoke haze + a translucent dark veil
  so the webview lets the vibrancy/desktop bleed through ("see through a bit").
- Glass surfaces → neutral, slightly more translucent, more blur (`--blur` 26→30px),
  lower `--glass` saturation (165%→~118%) so it reads as smoke, not color.
- Accent → muted cool **pewter/silver** instead of luminous cyan; used only for
  focus/active. Neutralize the cyan glows to plain dark shadows + a faint silver ring.
- Status hues (`--status-*`) kept (functional signal) but slightly muted to harmonize.
- Typography tokens: add `--font-display`; point `--font` at Bricolage Grotesque.

### 3. Typeface — Bricolage Grotesque (distinctive, not AI-slop)
- `npm install @fontsource-variable/bricolage-grotesque -w packages/web` (self-hosted,
  bundled by Vite — no CDN at runtime).
- Import the font CSS in `packages/web/src/main.tsx`.
- Wire `--font` / `--font-display` to it; give the brand wordmark + headings a tighter,
  bolder, silver-gradient treatment so the text pops.

### 4. Kill the flashing green dot
`packages/web/src/App.module.css`
- Remove the `dot-pulse` animation + green; `.dot` becomes a tiny static neutral dot
  (faint when disconnected, soft silver when connected). Delete the unused keyframes.

### 5. Glass dropdowns
`packages/web/src/components/NewTaskForm.module.css`
- `.select`: `appearance: none`, translucent glass background + backdrop blur, custom
  inline-SVG chevron, smoke-tinted `option` background so the open list isn't white.

## Validation
`npm run typecheck && npm run lint && npm run build` — all three green. Then rebuild the
`.app` (project memory: work targets the desktop app).

## Files
- `packages/desktop/src-tauri/tauri.conf.json`
- `packages/desktop/splash/index.html`
- `packages/web/src/theme.css`
- `packages/web/src/main.tsx`
- `packages/web/src/App.module.css`
- `packages/web/src/components/NewTaskForm.module.css`
- `packages/web/package.json` (+ lockfile) — font dependency

## Out of scope
Server/types/runner untouched (pure presentation change). No type-mirror impact.
