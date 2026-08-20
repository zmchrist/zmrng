# Theme Revision — refined palettes + dropdown selector

## Goal
Revise zmrng's theme system while preserving the existing **accent-only-swap**
architecture and all **11 themes** (`red`, `orange`, `yellow`, `green`, `blue`,
`purple`, `pink`, `teal`, `black`, `white`, `grey` — same ids, same labels, same
`zmrng-theme` localStorage persistence, same dark/light sun-moon toggle where each
theme carries a dark **and** a light accent pair). Two concrete deliverables:

1. **Refined color values** in `packages/web/src/themes.ts` — for each theme, refine
   the bold `--bg` field color and derive fresh dark + light accent pairs using proper
   color theory (harmonious complementary / analogous relationships, WCAG-legible
   accents), so the field color and its accents sit in visual harmony. No change to the
   fixed surface / border / text tokens in `theme.css`; the per-theme override surface
   stays exactly the token set `buildThemeVars()` already produces.
2. **Dropdown selector** in `SettingsModal.tsx` (+ its CSS module) — replace the swatch
   **grid** with a `<select>` dropdown of theme **names** paired with a small **live
   preview swatch** beside it, keeping the dark/light toggle unchanged.

Frontend-only. No server change, no `types.ts` change, so **no type-mirror work**.

## Grill (interrogate the approach before writing code)

**How the tokens actually render (verified in `theme.css`).**
- `--bg` (`theme.bg`) is a **bold flat field** painted on `body` (`background: var(--bg)`,
  `theme.css:118`). The app's panels sit on top of it as **translucent dark glass**
  (`--surface: rgba(3,4,30,0.34)`, `--surface-strong: rgba(2,3,22,0.5)`), so the field
  color bleeds through everything as the ambient wash. Text is fixed light
  (`--text: #f5f5f5`).
- `--accent` and friends render **on the dark glass surfaces** (chips, focus rings,
  gradients, the `--actor-main` log color). So an accent must be legible against a
  *dark, bg-tinted translucent panel* — not against the raw `--bg`.
- `--accent-ink` **is** `theme.bg` and is used as **ink/text painted on top of an accent
  fill** (e.g. an accent button's label). So the relationship that matters most for
  legibility is **accent ↔ bg contrast**: the accent fill must be light/saturated enough
  that the bg-colored ink on it reads. This is the real WCAG constraint here, and it is
  exactly why the legacy palettes pair a **bold saturated bg** with a **bright, near-luminous
  accent** (orange bg `#ff4d00` + chartreuse accent `#edff45`).

**Simplest thing that works.** Only two files carry real change: the value table in
`themes.ts` and the picker markup in `SettingsModal.tsx`/`.module.css`. The pure helpers
(`buildThemeVars`, `hexToRgba`, `getTheme`, `loadStoredTheme`, `saveStoredTheme`,
`applyTheme`) and the `ThemeDef`/`AccentPair` shapes **do not change** — the accent-only
architecture is already exactly what the operator confirmed, so touching the helper
signatures would be scope creep. Refining values needs **only** edits to the `THEMES`
array literal.

**What this breaks (must be handled, not discovered later).**
- `packages/web/test/themes.test.ts` **pins exact legacy values**: `buildThemeVars` for
  `orange/dark` is asserted field-by-field against the legacy hexes (`#ff4d00`, `#edff45`,
  gradient `… #d4e800 …`), and `red/dark`'s gradient is pinned to `#ffd23f`/`#ff8c42`.
  Refining `orange` and `red` values **will** turn these red. They must be **updated in the
  same change** to the new values (TDD RED→GREEN: update the pins to the new intended
  values first, watch them fail against the old table, then edit the table green). The
  operator explicitly authorized refining every bg including orange (q5), so the "unchanged
  default" framing of that test is deliberately being retired.
- `getTheme('teal').label` is asserted `'Teal'` — labels are unchanged, so this stays green.
- No other source reads a specific hex; `status.ts`/components read only the CSS vars, so
  the value refresh is contained.

**Assumptions checked against the code (not assumed).**
- Each theme *already* has a `dark` and `light` `AccentPair`; "inherently dark/light per
  toggle" (q3) is the **existing** behavior — the toggle swaps the pair, bg is mode-invariant
  (`buildThemeVars` reads `theme.bg` regardless of mode; pinned by the existing "bg does not
  change with mode" test). So q3 requires **no architectural change**, only good light-pair
  values. Confirmed — I am not adding a per-theme "is dark" flag.
- `orange` currently uses a `gradTo` override; the `gradTo?` field is optional and honored by
  `buildThemeVars`. I will keep using it where a two-stop gradient wants a hand-tuned end stop,
  and omit it (falls back to `accent2`) otherwise. No helper change needed.

**Alternative rejected — go "deeper" (per-theme surface/text/border palettes).** A richer
redesign would give each theme its own surface/text/border set for fully distinct looks. The
operator explicitly chose **accent-only swap (q2)** and "no changes to fixed surface/border/text
tokens," so per-theme surfaces are **out of scope**. Rejected: it contradicts the agreed scope,
balloons the change surface, and risks WCAG regressions on text that is currently a single audited
value.

**Alternative rejected — keep the swatch grid, add names as tooltips.** The task explicitly asks
for a **dropdown** of theme names with a small preview swatch beside it (q4). A grid-with-tooltips
does not satisfy that. Rejected.

**Alternative rejected — a custom popover listbox with per-row swatches.** Prettier, but it means
hand-rolling keyboard nav / focus-trap / a11y roles. The repo already has a proven, token-styled
native `<select>` (`NewTaskForm.module.css .select`, custom chevron, smoke-tinted `option`s) that
is accessible for free. A native `<select>` + one preview swatch beside it is the smallest thing
that meets the ask. Rejected the custom listbox as unjustified complexity.

## Approach

### 1. `themes.ts` — refined value table (only the `THEMES` array literal changes)
For each of the 11 themes, set:
- **`bg`** — keep each theme's established identity hue but refine the exact field color for
  harmony with its new accents (saturation/lightness tuning; the color *name* still reads true,
  e.g. red stays unmistakably red).
- **`dark` pair** — `accent` + `accent2` (+ optional `gradTo`) tuned for a **dark** presentation:
  brighter/more-luminous accents that pop on the dark glass and give legible bg-ink contrast.
- **`light` pair** — the same hue family pushed lighter/softer for the **light** toggle.

Palette method (applied per theme, documented inline where non-obvious):
- Pick accents in a **harmonious relationship** to the bg hue — complementary (opposite wheel,
  max contrast: orange bg ↔ chartreuse/yellow accent, the legacy move) or **analogous**
  (neighbors, calmer) as fits each field.
- Keep accents **saturated and bright enough** that `--accent-ink` (= bg) painted on an accent
  fill stays legible, and that the accent reads on the dark translucent surface. `black`/`white`/
  `grey` are neutral fields, so their accents carry the whole chroma — keep those vivid.
- `accent2` completes the duotone/gradient; choose it either analogous to `accent` (smooth
  gradient) or as a second harmonious pop. Add a hand-tuned `gradTo` only where the raw
  `accent→accent2` gradient needs a cleaner end stop.

No signature, no helper, no exported-constant change. `DEFAULT_THEME_ID`/`DEFAULT_THEME_MODE`
stay `orange`/`dark`.

### 2. `SettingsModal.tsx` — swatch grid → dropdown + preview swatch
In the Theme section, replace the `.swatchGrid` block (the `THEMES.map(...)` radio grid) and the
trailing `.swatchLabel` with:
- a **row** containing a small **preview swatch** (the selected theme's `bg` field with its
  `--accent-grad` pill on top — reuse the existing `.swatch`/`.swatchAccent` visual, non-interactive
  now, just a live preview of the current `themeId`+`mode`) and a native **`<select>`** whose
  `<option>`s are `THEMES.map` → `{theme.label}` with `value={theme.id}`.
- `value={themeId}`, `onChange` → the existing `selectTheme(id)` handler (unchanged; already sets
  state + `applyTheme` + `saveStoredTheme`). The dark/light `toggleMode` button and the whole
  Reboot section stay exactly as-is.
- The preview swatch recomputes `buildThemeVars(getTheme(themeId), mode)` so it live-updates when
  either the dropdown **or** the mode toggle changes.
- a11y: `<select>` gets `aria-label="Theme"`; the preview swatch is `aria-hidden` (decorative — the
  select is the labeled control). Drop the now-unused `role="radiogroup"`/`role="radio"` markup.

### 3. `SettingsModal.module.css` — dropdown styling
- Add a `.themeRow` flex container (preview swatch + select side by side, `gap`, `align-items:center`).
- Add a `.themeSelect` rule **mirroring** `NewTaskForm.module.css .select` (token-driven translucent
  surface, custom chevron data-URI, smoke-tinted `option`, focus ring) so the dropdown matches the
  app's other selects. `flex: 1` so it fills the row beside the swatch.
- For the preview, add a dedicated non-interactive `.swatchPreview` class (reuse the bg + accent-pill
  visuals from `.swatch`/`.swatchAccent` but drop the button-only hover/`translateY`/active styling);
  the preview is a `<span>`/`<div>`, not a button. Assert only-if-present for the optional `gradTo`.
- Remove `.swatchGrid` and `.swatchLabel` (grid + centered label no longer used). Leave the modal
  chrome, mode toggle, and reboot styles untouched.

## Files expected to change
- `packages/web/src/themes.ts` — refined `THEMES` value table (values only).
- `packages/web/src/components/SettingsModal.tsx` — grid → dropdown + preview swatch.
- `packages/web/src/components/SettingsModal.module.css` — `.themeRow` + `.themeSelect`; drop
  `.swatchGrid`/`.swatchLabel`.
- `packages/web/test/themes.test.ts` — update the pinned `orange/dark` + `red/dark` value
  assertions to the new intended values; keep the structural/invariant assertions.

_No server files, no `types.ts` (either copy), no `theme.css`._

## Test strategy
**Runner:** Vitest, web workspace — `npm test -w @zmrng/web` while iterating, `npm test` (both
workspaces) for the full gate. Full validation: `npm run typecheck && npm run lint && npm test &&
npm run build`.

**Tests updated — `packages/web/test/themes.test.ts` (the single test file that touches this
change):**
- **Update** the `buildThemeVars` "orange/dark" case: re-pin `--bg`, `--accent`, `--accent-2`,
  `--accent-bright`, `--accent-soft`, `--accent-line`, `--accent-grad`, `--accent-ink` to the **new**
  orange values. *Proves:* `buildThemeVars` still wires every accent token from the pair + bg
  correctly, now against the refined default. (TDD RED: update pins first → fail against old table →
  edit table → GREEN.)
- **Update** the `buildThemeVars` "red/dark" gradient case to red's **new** `accent`/`accent2`.
  *Proves:* the two-stop `accent→accent2` gradient path (no `gradTo`) still holds after refinement.
- **Keep + strengthen** the catalog invariants (already present): 11 themes, exact id set unchanged,
  every theme has dark+light pairs matching `/^#[0-9a-f]{6}$/i`. Add an assertion that **every
  theme's `bg`** also matches `/^#[0-9a-f]{6}$/i` and that `accent2`/optional `gradTo` are valid
  hex. *Proves:* the refined table stays structurally well-formed (no typo'd hex, no dropped field).
- **Keep** `getTheme` (by-id + fallback), `hexToRgba`, the "bg does not change with mode" assertion,
  and all three persistence tests — unchanged behavior, they guard against regressions in the parts
  that must **not** move (ids, labels, mode-invariant bg, localStorage round-trip).

**Why no new SettingsModal render test:** the modal's logic (`selectTheme`/`toggleMode`) is unchanged
— only the markup that *invokes* it swaps grid→select. The repo has no existing SettingsModal render
test and the change is presentational; adding a jsdom render test for a native `<select>` onChange
would assert framework behavior, not our logic. The dropdown is instead verified by the manual smoke
+ the mandatory **final-state UI screenshot** (this is a UI-touching change): run `npm run dev`, open
Settings, confirm the dropdown lists all 11 names, selecting one re-themes live and the preview swatch
tracks it, the mode toggle still flips dark/light, and the choice persists across reload; capture the
Settings panel via the Playwright MCP browser tools, commit the PNG under
`.github/pr-screenshots/<branch-slug>/`, and post it as a separate PR comment (best-effort; skip +
note under Testing if the browser tools are unavailable — never `ZMRNG_BLOCKED`).

## Validation
`npm run typecheck && npm run lint && npm test && npm run build` — all green before the PR. Then run
`sync-docs` and stage any doc updates (the `themes.ts`/SettingsModal descriptions in `CLAUDE.md` and
`frontend-react.md` mention the "swatch grid" — update to "dropdown + preview swatch"), and stage this
plan file so the PR checklist link is live.
