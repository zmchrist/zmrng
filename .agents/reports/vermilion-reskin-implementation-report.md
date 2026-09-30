# Vermilion Press reskin — implementation report

**Branch:** `feat/zc/vermilion-reskin`
**Date:** 2026-09-29
**Source direction:** `~/design-lab/zmrng-workspace-reskin/HANDOFF.md` (approved by zc)

## What changed

Reskinned the zmrng web app from the dark frosted-glass **Cosmos** look to the
approved flat editorial **Vermilion Press** (BOLD Swiss, light mode) as the new
**default**. Cosmos is preserved as an optional selectable theme.

### Decision taken (surfaced to zc, proceeded with the handoff's recommendation)
**Flat-as-default vs selectable-theme?** → **flat-as-default.** The base `:root`
becomes flat Vermilion; Cosmos keeps working as an opt-in `data-backdrop` theme.
This is the boldest option and matches "hit the rest of zmrng with it." If zc wants
Vermilion as *one more theme* alongside an unchanged Cosmos default instead, it's a
straightforward inversion — say the word.

Sub-decisions (defaults chosen, easy to flip):
- **Weapon color:** vermilion `#ff4d1a` shipped as default; **cobalt** `#1a4dff`
  added as a selectable theme ("Cobalt Press") for the A/B.
- **Radius:** hard `0` (matches the prototypes).
- **Status/actor color-coding:** flattened to an ink/gray ramp + vermilion for the
  live/alert states (strict 3-color Swiss). Per-subagent hue coding is intentionally
  collapsed — flag if legible actor colors matter more than palette purity.

### Files
1. **`packages/web/src/theme.css`** — rewrote `:root` to the flat Vermilion token map
   (paper `#f7f5f0` / ink `#16130f` / vermilion `#ff4d1a`; `--blur:0`, `--glass:none`,
   `--radius:0`, `--shadow:none`, ink hairlines, 1px rings instead of glows). The old
   glass tokens (translucent surfaces, blur, soft borders, rounded corners, floating
   shadows, cool status/actor ramp) are re-declared under `html[data-backdrop='cosmos']`
   so Cosmos reads exactly as before. The nebula + starfield backdrop layers are
   unchanged (still gated on `[data-backdrop='cosmos']`; the flat default paints none).
2. **`packages/web/src/themes.ts`** — added `vermilion` (default) + `cobalt` ThemeDefs;
   `DEFAULT_THEME_ID='vermilion'`, `DEFAULT_THEME_MODE='light'`. `buildThemeVars` now
   emits a flat solid `--accent-grad` for single-hue themes (accent===gradTo) so the
   "no gradient" promise holds literally; multi-stop color themes still build a gradient.
3. **`packages/web/test/themes.test.ts`** — catalog count 12→14, id-set + default
   assertions updated (vermilion default/light, cosmos still carries its backdrop).
4. **Component CSS modules (10 files)** — converted 16 hardcoded glass/glow/radius
   leftovers to tokens so they flatten on paper and stay glassy on Cosmos:
   - `backdrop-filter: blur(Npx)` → `var(--glass)` (WorkspaceView, BottomNav, TeamView)
   - glow rings/box-shadows → `var(--accent-soft)` / `var(--glow-accent)` / token-tracked
     (AuthBanner, TeamView `.dotOn`, TaskList pill glow removed, WorkerLog streaming caret)
   - hardcoded `border-radius` (4/2/7/14/999px) → `var(--radius*)` (Viewer, ChatPane,
     WorkerLog, ActivityRail, WorkspaceView)
   - off-palette dark scrims `rgba(2,3,8/0,0,0,…)` → neutral ink `rgba(22,19,15,…)`
   - `SettingsModal` swatch border `rgba(0,0,0,.25)` → `var(--border-strong)`

The xterm terminal already reads `--well`/`--text`/`--accent` via a `token()` helper,
so it picks up paper/ink/vermilion with no change.

## Gates — all green
```
npm run typecheck   ✓ (server + web)
npm run lint        ✓ (server + web)
npm test            ✓ 717 passed / 67 files
npm run build       ✓ tsc(server) + vite build(web), 156 modules
```

## Live verification (computed-style probes on :5174 — vision tool is blind in this env)
Default (Vermilion):
```
--accent #ff4d1a · --bg #f7f5f0 · --blur 0 · --radius 0 · --glass none · --shadow none
body bg rgb(247,245,240) · body color rgb(22,19,15) · data-backdrop null
counts over 184 els → rounded 0, shadowed 0, blurred 0, gradients 0
```
Cosmos glass gate (`data-backdrop='cosmos'`): `--blur 20px`, `--glass blur(20px) saturate(1.1)`,
`--radius 11px`, glass navy surface, `--text #e9e6dd` — fully restored.
Team + KB render clean, zero JS errors.

## Notes / not done
- `--surface-opacity` (Tauri window opacity slider) mechanism left intact but is largely
  meaningless on flat paper — flagged, not ripped out.
- The 11 legacy color themes now render as flat-paper + color field + accent (pre-Cosmos
  brutalist behavior). Coherent, not retuned — out of scope for this pass.
