# Terminal mobile key bar — pinned above the keyboard, Termius-style

## Goal

On a phone (≤768px, iPhone Safari and the Home Screen app), make the terminal's
on-screen key bar usable:

1. The bar sits directly **above** the iOS soft keyboard instead of behind it, and
   the terminal shrinks and refits its rows/columns to the space above the bar so
   the cursor line is never covered. With the keyboard closed, the bar stays where
   it is today — at the bottom of the terminal.
2. The bar grows a Termius-style key set: `Esc`, `Tab`, sticky one-shot `Ctrl`,
   sticky one-shot `Alt`, arrows with hold-to-repeat, the symbols `| ~ / - _`, a
   keyboard-dismiss button, and a collapsed-by-default second row with `Home`,
   `End`, `PgUp`, `PgDn` and `F1`–`F12`. Haptic tap where `navigator.vibrate`
   exists (a no-op on iOS Safari, which does not implement it).
3. Touch behaviour on the terminal surface: pinch changes the **terminal font
   size** only (clamped 9–24px, persisted, shared live across terminal tabs),
   one-finger flick scrolls the scrollback with momentum, and a long press opens a
   small **Paste / Copy** menu.

Desktop is untouched: every new behaviour is gated on `useIsMobile()` or on a
`@media (max-width: 768px)` block, per the frontend rule's mobile section.

## Out of scope

The desktop terminal, the tab strip, other cards, the server / PTY / `types.ts`
(no wire-format or type-mirror change — this is a pure `packages/web` change),
a connection-status indicator, and every Termius feature not listed above.

## Current state (read before planning)

- `packages/web/src/components/Terminal.tsx` — xterm glue. Already renders a
  phone-only key bar (`useIsMobile()`), with a sticky `Ctrl` consumed by the next
  `onData` chunk. `fontSize: 13` is hard-coded in the `XTerm` constructor. A
  `ResizeObserver` on the xterm host calls `fit.fit()` and sends `resize`.
- `packages/web/src/terminalKeys.ts` — `TERMINAL_KEYS` (Esc, Tab, Ctrl, 4 arrows)
  and `ctrlSeq()`. Pure data + mapping; the component stays untestable glue.
- `packages/web/src/components/Terminal.module.css` — `.wrap` is a flex column
  (`.host` `flex:1`, `.keys` `flex:none`), tokens only.
- `packages/web/src/useIsMobile.ts` — `useSyncExternalStore` over `matchMedia`;
  the pattern the new viewport hook copies.
- `packages/web/src/opacity.ts` — the clamp + `localStorage` + apply pattern the
  new font-size module copies.
- The phone shell is `height: 100dvh` (`App.module.css`), and `WorkspaceView`
  renders `TerminalCard` full-screen for `mobileView === 'terminal'`.

**Why the bar is hidden today:** iOS Safari does not shrink the layout viewport
when the keyboard opens — it overlays it. `100dvh` tracks browser chrome, not the
keyboard, so the flex column keeps its full height and its last row (the key bar)
ends up underneath the keyboard.

## Approach

### 1. Keyboard inset (the core fix)

New module `packages/web/src/keyboardInset.ts`:

```ts
export const KEYBOARD_MIN_INSET = 80        // below this it is browser chrome, not a keyboard
export interface ViewportMetrics { innerHeight: number; viewportHeight: number; offsetTop: number }
export function keyboardInset(m: ViewportMetrics | null): number   // pure
export function barOffset(inset: number, gapBelowPx: number): number  // pure
export function useKeyboardInset(): number   // useSyncExternalStore over visualViewport
```

- `keyboardInset` = `innerHeight - viewportHeight - offsetTop`, clamped to
  `[0, innerHeight]`, and treated as `0` below `KEYBOARD_MIN_INSET` so Safari's
  collapsing toolbar is not mistaken for a keyboard. `null` / non-finite → `0`.
  Subtracting `offsetTop` is what keeps it correct when iOS scrolls the visual
  viewport within the layout viewport.
- `barOffset` subtracts the distance between the terminal wrap's bottom edge and
  the viewport bottom (the phone shell's `env(safe-area-inset-bottom)` padding),
  so the bar lands exactly on the keyboard rather than `safe-area` px too high.
- `useKeyboardInset` subscribes to `visualViewport`'s `resize` **and** `scroll`
  events, mirroring `useIsMobile`'s `useSyncExternalStore` shape (no
  state-in-effect, correct across an orientation change). Returns `0` when
  `visualViewport` is unavailable (jsdom, older browsers, desktop).

In `Terminal.tsx` the inset is written onto the wrap as a CSS custom property
from a `useEffect` (`el.style.setProperty('--kb-inset', barOffset(...) + 'px')`),
measuring the gap with one `getBoundingClientRect()`. CSS does the rest:

```css
@media (max-width: 768px) { .wrap { padding-bottom: var(--kb-inset, 0px); } }
```

Because `.host` is `flex:1` inside `.wrap`, shrinking the wrap's content box
shrinks the host, the existing `ResizeObserver` fires, and `fit.fit()` + the
`resize` frame refit rows/cols — the cursor line stays visible with no new resize
plumbing. The same effect calls `window.scrollTo(0, 0)` while the inset is
non-zero, to undo any layout-viewport scroll iOS applies on focus.

Android Chrome shrinks the layout viewport itself, so `keyboardInset()` returns
`0` there and the existing flex layout already does the right thing.

### 2. Key set (`terminalKeys.ts`)

Extend the data model, keeping `ctrlSeq()` as-is:

```ts
export type TerminalMod = 'ctrl' | 'alt'
export interface TerminalKey { id: string; label: string; seq: string | null; mod?: TerminalMod; repeat?: boolean }
export const TERMINAL_KEYS: ReadonlyArray<TerminalKey>        // row 1
export const TERMINAL_KEYS_EXTRA: ReadonlyArray<TerminalKey>  // row 2, collapsed by default
export function altSeq(data: string): string
export function modSeq(data: string, mods: { ctrl: boolean; alt: boolean }): string
```

- Row 1: `esc`, `tab`, `ctrl` (`mod:'ctrl'`), `alt` (`mod:'alt'`), `up`/`down`/
  `left`/`right` (`repeat:true`), then `|`, `~`, `/`, `-`, `_`. Existing ids and
  sequences are unchanged, so nothing that imports them breaks.
- Row 2: `home` `\x1b[H`, `end` `\x1b[F`, `pgup` `\x1b[5~`, `pgdn` `\x1b[6~`,
  `f1`–`f4` `\x1bOP`/`OQ`/`OR`/`OS`, `f5`–`f12` `\x1b[15~`,`[17~`,`[18~`,`[19~`,
  `[20~`,`[21~`,`[23~`,`[24~`. These are xterm's own normal-mode sequences
  (checked against `@xterm/xterm/src/common/input/Keyboard.ts`), matching the
  normal-mode choice the existing arrows already make.
- `altSeq` prefixes `ESC` (the standard Meta encoding). Like `ctrlSeq`, it only
  transforms a single character and passes anything longer through unchanged, so
  arming a modifier can never corrupt a paste.
- `modSeq` composes both: Ctrl first, then the Alt `ESC` prefix (`ctrl+alt+c` →
  `\x1b\x03`), and returns the input untouched when neither is armed.

`Terminal.tsx` keeps one `armed` ref/state pair per modifier and runs every
`onData` chunk through `modSeq`, clearing both after one chunk (one-shot, exactly
today's Ctrl semantics).

### 3. Bar UI

- Two `role="toolbar"` rows inside a `.bar` container; row 2 is rendered only when
  an `expanded` state is true, toggled by a `⌃`/`⌄` button at the end of row 1.
  Both rows scroll horizontally on overflow (`overflow-x:auto`), 44px targets.
- Hold-to-repeat: for keys with `repeat`, `onPointerDown` starts a 400ms delay
  then a 60ms interval resending the sequence; `onPointerUp`/`onPointerCancel`/
  `onPointerLeave` and unmount clear both timers.
- A keyboard-dismiss button (`aria-label="Hide keyboard"`) blurs the xterm
  textarea (`term.blur()`), which closes the soft keyboard; the inset hook then
  returns the bar to the bottom of the terminal.
- Haptics: a `tap()` helper calling `navigator.vibrate?.(8)` inside `try/catch`
  on every bar press. Documented as a no-op on iOS Safari.
- Buttons keep the existing `onMouseDown` preventDefault and add the same for
  `onTouchStart`, so pressing a key never blurs the terminal and closes the
  keyboard.

### 4. Font size (pinch)

New module `packages/web/src/terminalFont.ts`, modelled on `opacity.ts` but with
a tiny subscribe/notify store so a pinch in one tab updates every mounted
terminal (tabs stay mounted; a remount-only approach would leave the other tabs
stale):

```ts
export const DEFAULT_TERMINAL_FONT_SIZE = 13, MIN_TERMINAL_FONT_SIZE = 9, MAX_TERMINAL_FONT_SIZE = 24
export function clampFontSize(n: number): number
export function pinchFontSize(base: number, scale: number): number
export function getFontSize(): number          // cached; hydrated from localStorage on first read
export function setFontSize(n: number): void   // clamp → persist (`zmrng-term-font`) → notify
export function subscribeFontSize(fn: () => void): () => void
```

`Terminal.tsx` reads it with `useSyncExternalStore(subscribeFontSize, getFontSize,
() => DEFAULT_TERMINAL_FONT_SIZE)`, seeds the `XTerm` constructor with it, and in
an effect assigns `term.options.fontSize` then refits when the value changes.
`DEFAULT_TERMINAL_FONT_SIZE = 13` becomes the single source of truth for the
default: the literal `fontSize: 13` currently hard-coded in the `XTerm`
constructor is removed, not left as a second copy.

### 5. Touch gestures

New module `packages/web/src/terminalTouch.ts` — the whole gesture *arithmetic*,
DOM-free, so `Terminal.tsx` stays thin glue:

```ts
export function pinchDistance(a: TouchPoint, b: TouchPoint): number
export function pinchScale(startDist: number, currentDist: number): number   // guards a 0 start
export function flickVelocity(samples: FlickSample[]): number                // px/ms over the last ~100ms
export function momentumStep(velocity: number, dtMs: number): { velocity: number; distance: number }  // exponential friction
export function scrollLinesFor(distancePx: number, lineHeightPx: number, carry: number): { lines: number; carry: number }
export function longPressMoved(start: TouchPoint, current: TouchPoint, slopPx?: number): boolean
export function clampMenuPosition(at: TouchPoint, menu: Size, bounds: Size, margin?: number): { left: number; top: number }
```

One non-passive `touchstart/move/end/cancel` listener set on the xterm host
element drives them:

- **2 touches** → pinch: `setFontSize(pinchFontSize(baseAtGestureStart, pinchScale(...)))`,
  applied on a rAF so a drag does not thrash xterm reflows; `preventDefault()`
  stops iOS page zoom.
- **1 touch** → drag-scroll: `scrollLinesFor` converts pixel delta (with a
  sub-line carry, so a slow drag still moves) into `term.scrollLines(-lines)`;
  on release `flickVelocity` seeds a rAF loop stepping `momentumStep` until the
  velocity falls under the stop threshold. A new touch cancels the loop.
  `momentumStep` uses exponential friction — `v * MOMENTUM_FRICTION ** (dtMs/16.7)`
  with `MOMENTUM_FRICTION ≈ 0.95` per frame — and reports `velocity: 0` once the
  speed drops below `MOMENTUM_MIN_VELOCITY` (~0.02 px/ms), which is what
  guarantees the loop terminates. Both constants are exported so the tests pin
  the decay rather than re-deriving it; the exact feel is a smoke-test judgement.
- **Long press** (500ms, movement under slop) → `Paste` / `Copy` menu positioned
  with `clampMenuPosition`. Paste uses `navigator.clipboard.readText()` (the
  button tap is the user gesture iOS requires) and sends the text to the PTY;
  Copy writes `term.getSelection()` to the clipboard. Both are wrapped so a
  denied clipboard permission just closes the menu.

All gesture listeners are registered only while `useIsMobile()` is true, and the
host gets `touch-action: none` inside the phone media block so the browser does
not claim the gestures first.

## Alternatives considered and rejected

- **Float the bar with `position: fixed` + a `visualViewport` transform.** The
  common trick, and a smaller diff — rejected because the terminal keeps its full
  height, so the *cursor line* stays hidden behind the keyboard, which is the
  actual complaint. Shrinking the wrap fixes both the bar and the content, and it
  reuses the existing `ResizeObserver` → `fit()` path instead of introducing a
  fixed-position element into the card grid's stacking contexts.
- **`<meta name="viewport" content="...,interactive-widget=resizes-content">`.**
  One line, and it makes the layout viewport shrink with the keyboard — but iOS
  Safari ignores it (Chromium-only), and it would change behaviour for every view
  in the app, not just the terminal. Not the mechanism; Android already works via
  its own layout-viewport resize.
- **`env(keyboard-inset-bottom)` / the VirtualKeyboard API.** The standards-track
  answer, unsupported in Safari. Rejected for the same reason.
- **Pinch = page zoom** (allowing `user-scalable=yes`). Rejected: it zooms the
  whole app chrome and breaks the fixed-height phone shell; the operator asked
  for terminal text sizing.
- **Native momentum via CSS on `.xterm-viewport`** (`-webkit-overflow-scrolling`).
  Rejected because the pinch handler must `preventDefault()` `touchmove` to stop
  iOS page zoom, which disables native scrolling anyway — so one handler owns
  both gestures and their feel stays consistent.
- **Putting the new logic directly in `Terminal.tsx`.** Rejected: the component is
  deliberately untestable glue (jsdom has no canvas + live socket). Arithmetic
  goes in pure modules that Vitest can drive, matching `terminalProtocol.ts` /
  `terminalKeys.ts`.

## Risks / assumptions

- `navigator.vibrate` is unimplemented in iOS Safari → haptics are a no-op there.
  Accepted by the operator during clarify.
- `navigator.clipboard.readText()` may prompt or reject on iOS; the menu fails
  closed (no paste, menu dismissed).
- iOS sometimes scrolls the layout viewport on focus; mitigated by the
  `window.scrollTo(0, 0)` pin while the inset is non-zero.
- xterm 6 also listens for some touch events; our listeners sit on the host
  element and `preventDefault()` only for gestures we own. To be confirmed by the
  manual smoke, not by unit tests.
- `KEYBOARD_MIN_INSET = 80` is a heuristic threshold (keyboards are ≥200px tall,
  Safari's collapsing toolbar is well under 80px).

## Files

Changed:
- `packages/web/src/terminalKeys.ts` — Alt/symbol/second-row keys, `altSeq`, `modSeq`
- `packages/web/src/components/Terminal.tsx` — inset wiring, two-row bar, repeat,
  haptics, dismiss, font size, touch gestures, paste/copy menu
- `packages/web/src/components/Terminal.module.css` — bar rows, `--kb-inset`
  padding, `touch-action`, menu styling (tokens only)
- `packages/web/test/terminalKeys.test.ts` — extended
- `.claude/rules/frontend-react.md`, `.claude/docs/codemap.md` — new modules in
  the component/file maps (via the `sync-docs` skill)

Added:
- `packages/web/src/keyboardInset.ts`
- `packages/web/src/terminalFont.ts`
- `packages/web/src/terminalTouch.ts`
- `packages/web/test/keyboardInset.test.tsx`
- `packages/web/test/terminalFont.test.ts`
- `packages/web/test/terminalTouch.test.ts`

No server file changes, so no `types.ts` mirror work.

## Step-by-step implementation (TDD: RED → GREEN → REFACTOR per step)

1. **`terminalKeys`** — update `test/terminalKeys.test.ts` for the new rows,
   modifiers and `altSeq`/`modSeq` (RED), then extend `terminalKeys.ts` (GREEN).
2. **`keyboardInset`** — write `test/keyboardInset.test.tsx` (RED), then the
   module with its pure functions and the `useSyncExternalStore` hook (GREEN).
3. **`terminalFont`** — write `test/terminalFont.test.ts` (RED), then the module
   (GREEN).
4. **`terminalTouch`** — write `test/terminalTouch.test.ts` (RED), then the module
   (GREEN).
5. **`Terminal.tsx` + CSS glue** — wire all four modules in: inset effect, the
   two-row bar with repeat/haptics/dismiss/expand, the font-size store, the touch
   handlers and the long-press menu. Not unit-tested (documented policy for this
   component); verified by the whole suite staying green plus the manual smoke.
6. **Validate** — `npm run typecheck && npm run lint && npm test && npm run build`.
7. **Review** — `zmrng-code-reviewer` pass against this plan; address findings.
8. **Sync docs** — run the `sync-docs` skill; stage the docs it updates and this
   plan file.
9. **Re-bundle the app** — `npm run build && npm run bundle:sidecar`. See the
   note below about `tauri build`.

## Test strategy

**Runner:** Vitest. `npm test` runs both workspaces; `npm test -w @zmrng/web`
runs the web suite alone during the loop. Web tests are jsdom +
`@testing-library/react` under `packages/web/test/`.

Tests cover the pure logic only — `Terminal.tsx` is the project's documented
"untestable glue" (jsdom has no canvas and no live WebSocket), exactly as
`terminalProtocol.ts`/`terminalKeys.ts` are tested today while the component is
not.

| File | What it proves |
|------|----------------|
| `packages/web/test/terminalKeys.test.ts` (update) | Row 1 contains Esc/Tab/Ctrl/Alt/arrows/`\| ~ / - _` with the existing ids and sequences unchanged; `ctrl` and `alt` carry `mod` and a `null` seq; arrows carry `repeat`. Row 2 contains Home/End/PgUp/PgDn and F1–F12 with their exact xterm sequences. `altSeq` prefixes ESC for one character and passes longer input through. `modSeq` applies Ctrl alone, Alt alone, both together (`ctrl+alt+c` → `\x1b\x03`), and is the identity with neither armed. Existing `ctrlSeq` cases still pass. |
| `packages/web/test/keyboardInset.test.tsx` (new) | `keyboardInset` returns 0 with the keyboard closed, the keyboard height when open, 0 for sub-threshold chrome noise, the correct value when the visual viewport is scrolled (`offsetTop` subtracted), 0 for `null`/non-finite metrics, and never a negative number. `barOffset` subtracts the safe-area gap below the bar and floors at 0. `useKeyboardInset` renders 0 without `visualViewport` and re-renders with the new inset when a stubbed `visualViewport` fires `resize` — the same stub-and-`act` shape as `useIsMobile.test.tsx`. |
| `packages/web/test/terminalFont.test.ts` (new) | `clampFontSize` holds the 9–24 bounds, rounds, and falls back to the default for non-finite input. `pinchFontSize` scales up and down from a base and clamps at both ends. `setFontSize`/`getFontSize` round-trip through `localStorage`, a corrupt or absent stored value yields the default, and a disabled `localStorage` does not throw. `subscribeFontSize` notifies every listener on change and stops after unsubscribe — which is what makes a pinch in one tab reach the others. |
| `packages/web/test/terminalTouch.test.ts` (new) | `pinchDistance` on a known triangle; `pinchScale` grows/shrinks and guards a zero start distance. `flickVelocity` returns signed px/ms, ignores samples older than the window, and returns 0 for a single sample. `momentumStep` decays monotonically and reports a stopped velocity below the threshold (proving the loop terminates). `scrollLinesFor` converts pixels to whole lines and carries the sub-line remainder so successive small deltas eventually scroll. `longPressMoved` respects the slop radius. `clampMenuPosition` keeps the menu inside the bounds at all four edges. |

**Manual smoke (device, after the build):** on iPhone Safari open the phone
Terminal view, tap the terminal — the keyboard opens and the bar sits directly on
top of it with the prompt still visible; press Ctrl then `c` (SIGINT), expand row
2 and press `F1`/`PgUp`, hold `↑` to repeat, pinch to resize the text and confirm
it survives a reload and shows in a second terminal tab, flick to scroll the
scrollback, long-press for Paste, and press the dismiss button to close the
keyboard and return the bar to the bottom.

## Validation

`npm run typecheck && npm run lint && npm test && npm run build` — all must pass.

**Baseline (verified in this worktree during planning):** server 479 tests, web
494 tests, typecheck and lint clean. Getting there needed environment work the
execute phase should know about: this shell has `NODE_ENV=production`, so a plain
`npm install` **silently omits every devDependency** (vitest, vite, eslint,
typescript, testing-library) and the suite then fails with duplicate-React
`Cannot read properties of null (reading 'useState')` errors as it resolves
`@testing-library`/`react-dom` from the parent checkout. The fix is
`npm install --include=dev`, `npm install-scripts approve esbuild better-sqlite3
node-pty` (npm 12 blocks install scripts by default), and `npm rebuild
better-sqlite3 node-pty`. Dependencies are already installed and built in this
worktree. The `allowScripts` block that `approve` writes into the root
`package.json` is a local environment artifact and **must not be committed**.

**App re-bundle.** CLAUDE.md requires the app to be re-bundled before a change
counts as done: `npm run desktop:build`. This worker runs on Linux with no Rust
toolchain (`cargo` is absent) and the target artifact is a macOS `.app`, so the
executable part here is `npm run build && npm run bundle:sidecar` — which is what
refreshes the bundled `server/dist` + `web/dist` the `.app` ships. The final
`npm run tauri -w @zmrng/desktop -- build` step must be run by the operator on
macOS; the PR body will say so explicitly under **Validation**.
