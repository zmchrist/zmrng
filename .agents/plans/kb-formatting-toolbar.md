# KB page editor — persistent formatting toolbar

## Goal

Add a persistent Google-Docs-style formatting toolbar above the Knowledge Base page
body editor, so a user editing a KB page can apply formatting by clicking a button
instead of typing markdown syntax by hand.

Toolbar controls (the agreed v1 set, exactly eleven):

Bold · Italic · Underline · Strikethrough · Heading-style picker · Bullet list ·
Numbered list · Checklist · Link · Text color · Highlight color

Every control acts on the **current selection in the `<textarea>`**, using the same
wrap/insert mechanism the existing `⌘B` / `⌘I` / `⌘K` shortcuts already use.

**Explicitly out of scope** (settled during clarify): font family, font size, text
alignment / justify, comments & suggestions, real-time multi-cursor collaboration,
images, tables, and any change to the page storage model — `KbPage.body` stays one
continuous plaintext/markdown string, and no server type changes.

---

## Grill — interrogating the approach before writing anything

Everything below comes from reading the actual files, not from assumption:
`packages/web/src/components/KbView.tsx`, `packages/web/src/kbMarkdown.ts`,
`packages/web/src/components/KbView.module.css`, `packages/web/test/kbMarkdown.test.ts`,
`packages/web/test/KbView.spaces.test.tsx`, `packages/server/src/types.ts` (KB block),
and `packages/web/src/openExternal.ts`.

### 1. The assumption that breaks first: clicking the toolbar exits edit mode

`KbView.tsx:855-861` — the textarea carries:

```tsx
onBlur={() => { flushPending(); setEditing(false) }}
```

Edit mode is **focus-scoped**. Any mousedown on a toolbar button blurs the textarea,
which sets `editing = false`, which unmounts both the textarea *and* the toolbar
before the click ever completes. A naively-added toolbar would be 100% non-functional.

**Fix:** every toolbar control calls `e.preventDefault()` on **`onMouseDown`**. A
default-prevented mousedown never moves focus, so the textarea keeps focus and its
selection, `onBlur` never fires, and the subsequent `onClick` runs with edit mode
intact. This is the standard rich-text-toolbar pattern.

**Consequence that changes the design:** the heading picker and the two color pickers
**cannot be native `<select>` / `<input type="color">` elements** — a
default-prevented mousedown stops a native dropdown from opening at all, and letting
one take focus fires the blur that kills edit mode. They must be custom popovers
built from `<button>`s, each with the same mousedown guard. The repo already has this
exact precedent: `TeamView`'s curated emoji-picker grid (`emojiSet.ts`) is a
hand-rolled popover of buttons rather than a third-party/native picker.

*Rejected alternative:* relax `onBlur` to check `e.relatedTarget` against a toolbar
ref. Rejected because it changes save-on-blur semantics that existing behaviour and
tests depend on, `relatedTarget` is unreliable under happy-dom, and even when it
works the textarea's visible selection is lost while the control holds focus. The
mousedown guard is smaller, does not touch the existing lifecycle, and is directly
assertable in a test.

### 2. The real bulk of this task is the renderer, not the toolbar

`kbMarkdown.ts`'s `renderInline()` supports exactly three things: `**bold**`,
`*italic*`, and `` `code` ``. Its header comment even says *"intentionally minimal
(headings, emphasis, inline code, **no links**)"*. Auditing the eleven agreed buttons
against what the renderer can actually display:

| Button | Emitted syntax | Renderer today |
|---|---|---|
| Bold | `**text**` | ✅ supported |
| Italic | `*text*` | ✅ supported |
| Bullet list | `- text` | ✅ supported |
| Checklist | `- [ ] text` | ✅ supported (interactive) |
| Heading picker | `# `…`### ` | ✅ supported |
| Strikethrough | `~~text~~` | ❌ renders as literal `~~text~~` |
| Numbered list | `1. text` | ❌ **no `<ol>` support at all** — renders as a paragraph |
| Link | `[text](url)` | ❌ no `<a>` — and `⌘K` *already* inserts this today, so it is already a latent dead feature |
| Underline | — | ❌ no syntax, no rendering |
| Text color | — | ❌ no syntax, no rendering |
| Highlight color | — | ❌ no syntax, no rendering |

So **6 of 11 buttons would be dead on arrival** without renderer work. Extending
`kbMarkdown.ts` is not scope creep here — it is the precondition for the feature
being real rather than decorative. The agreed scope anticipated this ("adding
markdown conventions … that `renderPageMarkdown` can already render consistently
with its existing style").

### 3. Choosing the syntax conventions — and not inventing anything exotic

- **Strikethrough → `~~text~~`** — GitHub-Flavored Markdown standard.
- **Highlight (default) → `==text==` → `<mark>`** — the Obsidian standard, and the KB
  is explicitly modelled on Obsidian (`types.ts`: *"Obsidian-style live markdown
  rendering"*).
- **Underline → `<u>text</u>`** — markdown has no underline. This exact convention was
  named and accepted during clarify. Inline HTML is legal markdown, and `<u>` is what
  Obsidian and GitHub comments both emit for underline.
- **Text color → `<span style="color:#RRGGBB">text</span>`**
- **Colored highlight → `<mark style="background:#RRGGBB">text</mark>`**

*Rejected alternative for color:* a class-based palette token
(`<span class="kb-c-red">`) or an invented brace syntax (`{red}text{/red}`). Rejected
because a class-only body is meaningless outside our own stylesheet — copy the page
into any other markdown tool and the color silently vanishes — and an invented brace
syntax is exactly the "something exotic" the clarify ruled out. `style="color:#hex"`
is self-describing, portable, and is what every comparable markdown editor emits.

### 4. What the HTML conventions break: the renderer's security posture

`renderPageMarkdown` output goes straight into `dangerouslySetInnerHTML`
(`KbView.tsx:876`). Its entire safety model is *escape everything first, then apply
regexes to the escaped string* — `escapeHtml()` neutralises `<`, `>`, `&`, `"`, `'`,
and there is a pinned test asserting `<script>alert(1)</script>` survives as escaped
text. Supporting `<u>` / `<span style>` / `<mark style>` must not weaken this.

**The rule:** never un-escape generically. After `escapeHtml()`, run a
**closed allow-list pass** that recognises only these exact escaped token shapes and
nothing else:

- `&lt;u&gt;` / `&lt;/u&gt;`
- `&lt;mark&gt;` / `&lt;/mark&gt;`
- `&lt;mark style=&quot;background:#RRGGBB&quot;&gt;`
- `&lt;span style=&quot;color:#RRGGBB&quot;&gt;` / `&lt;/span&gt;`

where `#RRGGBB` is matched by a strict `#[0-9a-fA-F]{6}` regex. Because the only
variable part is six hex digits, no attribute, event handler, `javascript:` URL or
CSS `expression()` can be smuggled through. Anything that does not match the exact
shape — `<span onclick=…>`, `<span style="color:red">`, a 3-digit `#fff`, `<u
class=x>`, `<img src=x onerror=…>` — stays escaped and renders as visible literal
text. These near-miss cases get explicit tests; `.claude/rules/testing.md` calls out
"near-miss cases that must NOT match" as a required testing convention here.

**Link URLs** get the same treatment: `[text](url)` renders as an anchor only when
the URL passes an allow-list. `javascript:` and `data:` URLs are rejected and the
whole construct is left as escaped literal text. The allow-list is defined precisely,
because the sloppy version of this check has well-known bypasses:

- Before testing the scheme, strip ASCII whitespace and C0 control characters from
  the URL. Browsers ignore them inside a scheme, so a naive prefix test lets
  `java\tscript:alert(1)` and `java&#10;script:alert(1)` through.
- Accept: `http://…`, `https://…`, `mailto:…`, a same-document anchor (`#…`), or a
  relative path that contains no `:` before its first `/`.
- **Reject protocol-relative `//host/…`** — it is technically "relative" but resolves
  to an off-origin URL, so it must not slip past the relative-path branch.
- Reject everything else, including any other scheme.

The href is emitted from the **already-escaped** string, so `"` is already `&quot;`
and cannot break out of the attribute. Anchors render with
`rel="noopener noreferrer"`, and the click is handled by `openExternal()` (see §6)
rather than by `target="_blank"`.

### 5. Behaviour change to existing pages (accept, but name it)

Adding `<ol>` and `<a>` rendering changes how **already-saved** KB pages display: a
page whose body contains `1. first` renders as a numbered list instead of a
paragraph, and `[text](url)` becomes a clickable link instead of literal text. This
is correct markdown behaviour and is the point of the change, but it is a visible
change to existing content, not purely additive. Accepted deliberately.

### 6. Links inside the rendered body vs. click-to-edit

`onBodyClick` (`KbView.tsx:539-552`) currently treats **any** click that is not a
checkbox as "enter edit mode". Once anchors render, clicking a link would open the
editor instead of the link. The handler needs an anchor branch. It must also route
through the existing `openExternal()` helper rather than relying on
`target="_blank"` — `openExternal.ts` documents that the Tauri webview silently
swallows plain `target="_blank"` navigations. This is a small, necessary addition,
not a redesign.

### 7. "Persistent" bar — what it actually means here

The agreed wording is "persistent bar … while a KB page is open in edit mode". Edit
mode in this component is entered by clicking the body and left on blur; the bar is
therefore visible exactly while the editor is. The mousedown guard is what makes that
*feel* persistent (the bar does not vanish when you use it). Changing the edit-mode
lifecycle itself — e.g. a sticky "editing" state that survives clicking away — is a
different feature and is **out of scope**.

### 8. Simplest thing that works, and where the logic lives

The simplest version that works is: pure selection-transform functions + a
presentational toolbar + renderer support. Repo convention is unambiguous here —
React-free logic lives in its own `packages/web/src/*.ts` module with a matching
`packages/web/test/*.test.ts` (`kbMarkdown.ts`, `terminalKeys.ts`, `terminalTouch.ts`,
`windowTabs.ts`, `mentions.ts`). So:

- `kbEdits.ts` — pure `(text, selStart, selEnd) → { text, selStart, selEnd }`
  transforms plus the curated color palette constant. No DOM, no React, fully
  unit-testable.
- `components/KbToolbar.tsx` — presentational; receives the current value +
  selection and an `onApply` callback. State stays in `KbView`.
- `KbView.tsx` — existing `wrapSelection` is re-pointed at `kbEdits.ts` so the
  keyboard shortcuts and the buttons share **one** mechanism rather than two
  divergent copies.

**Toggle-off is included.** Google Docs' buttons toggle: pressing Bold on
already-bold text un-bolds it. The pure helpers detect an existing wrap / line prefix
and strip it. This is cheap to implement and cheap to unit-test, and without it the
buttons feel broken.

**Accepted limitation:** wrapping an inline mark across a blank line produces markdown
that does not render as a single span. This already matches the existing `⌘B`
behaviour and is not worth special-casing in v1.

---

## Files changed

| File | Change |
|---|---|
| `packages/web/src/kbEdits.ts` | **new** — pure selection transforms + `KB_TEXT_COLORS` / `KB_HIGHLIGHT_COLORS` palettes + `HEADING_LEVELS` |
| `packages/web/src/components/KbToolbar.tsx` | **new** — the presentational toolbar (buttons + heading popover + two color popovers) |
| `packages/web/src/components/KbToolbar.module.css` | **new** — toolbar chrome, design tokens only |
| `packages/web/src/kbMarkdown.ts` | strikethrough, `==highlight==`, allow-listed `<u>`/`<span style="color:#hex">`/`<mark style="background:#hex">`, `<ol>` runs, sanitized `[text](url)` links |
| `packages/web/src/components/KbView.tsx` | render `<KbToolbar>` above the textarea; re-point `wrapSelection`/`onEditorKeyDown` at `kbEdits.ts`; anchor branch in `onBodyClick`; refresh `editorHint` text |
| `packages/web/src/components/KbView.module.css` | styles for newly-rendered elements (`ol`, `a`, `mark`, `u`, `del`); editor layout room for the toolbar; additive phone block |
| `packages/web/test/kbEdits.test.ts` | **new** |
| `packages/web/test/kbMarkdown.test.ts` | extended |
| `packages/web/test/KbToolbar.test.tsx` | **new** |
| `packages/web/test/KbView.toolbar.test.tsx` | **new** |

**No server change, no type change.** `KbPage.body` stays a plain string and
rendering is client-only (verified: `renderPageMarkdown` has no server-side
counterpart), so the manual `types.ts` server↔web mirror is untouched.

---

## Implementation steps

Each step is RED → GREEN → REFACTOR; tests land in the same commit as the source.

### Step 1 — `kbEdits.ts`, the pure transform layer

Write `packages/web/test/kbEdits.test.ts` first and watch it fail.

Shared type:

```ts
export interface SelectionEdit { text: string; selStart: number; selEnd: number }
```

Functions:

- `toggleWrap(text, s, e, before, after)` — wrap the selection; if it is already
  wrapped (markers immediately inside or outside the selection) strip them instead.
  With an empty selection, insert both markers and leave the caret between them
  (preserving today's `⌘B` behaviour).
- `toggleLinePrefix(text, s, e, prefix)` — for `- ` and `- [ ] `. Applies to **every
  line the selection touches**; if every such line already has the prefix, remove it.
  Replaces a different list marker rather than stacking on top of it.
- `toggleOrderedList(text, s, e)` — prefix touched lines `1. `, `2. `, `3. …`,
  renumbering from one; toggles off when already numbered.
- `applyHeading(text, s, e, level)` — strip any existing `#{1,6} ` prefix from touched
  lines, then apply `'#'.repeat(level) + ' '`. `level === 0` means "Normal text"
  (strip only).
- `applyLink(text, s, e)` — `[selection](url)` with the selection as the label; with
  an empty selection insert `[text](url)`. Caret lands on the `url` placeholder so it
  can be typed over immediately.
- `applyTextColor(text, s, e, hex)` / `applyHighlight(text, s, e, hex | null)` —
  wrap in the span / mark conventions; `null` highlight means bare `==text==`. Both
  toggle off when the selection is already wrapped in the same construct.
- Palettes: `KB_TEXT_COLORS` and `KB_HIGHLIGHT_COLORS`, small curated arrays of
  `{ name, hex }`, modelled directly on `emojiSet.ts`'s `REACTION_EMOJI` (a static,
  offline-safe curated constant). These are **document content**, not theme, so
  literal hex here is correct and does not violate the design-token rule — the
  toolbar's own chrome uses `var(--*)` exclusively.

### Step 2 — renderer support in `kbMarkdown.ts`

Extend `packages/web/test/kbMarkdown.test.ts` first.

- `renderInline()` gains, in a deliberate order (inline code extracted last, as the
  existing comment requires): `~~strike~~` → `<del>`, `==highlight==` → `<mark>`,
  `[text](url)` → sanitized `<a>`, then the closed allow-list un-escape pass for
  `<u>`, `<span style="color:#RRGGBB">`, `<mark style="background:#RRGGBB">`.
- New `safeLinkHref(url)` helper: returns the href when it matches
  `http:` / `https:` / `mailto:` / a relative or `#` path, else `null` (caller then
  leaves the construct as literal escaped text).
- Block level: a run of `1. ` / `1) ` lines (that are not checklist or bullet lines)
  groups into one `<ol>`, mirroring the existing `<ul>` grouping branch exactly. It
  must sit **after** the checklist and bullet branches so their detection is
  unchanged.
- Update the module header comment — it currently claims "no links".

### Step 3 — `KbToolbar.tsx` + its CSS

Props: `value`, the textarea ref (or the current selection range), and
`onApply(edit: SelectionEdit)`. It holds only its own popover-open state.

- `role="toolbar"`, grouped with thin `var(--border)` dividers between logical groups
  (inline marks · heading · lists · link · colors).
- **Every** button and swatch: `onMouseDown={(e) => e.preventDefault()}`, plus a
  `title` and an `aria-label`.
- Heading picker: a button with `aria-expanded` opening a popover listing Normal
  text / Heading 1 / Heading 2 / Heading 3.
- Color pickers: an `A`-with-underbar button and a highlighter button, each opening a
  swatch grid from the `kbEdits.ts` palettes, plus a "None / remove" entry.
- All three popovers are keyboard-reachable and carry explicit roles — the trigger
  gets `aria-haspopup` + `aria-expanded`, the popover itself `role="menu"` with
  `role="menuitem"` entries, and `Escape` closes it and returns focus to the
  textarea. No nested interactive elements (the accessibility rule in
  `.claude/rules/frontend-react.md`).
- Icons follow the file's existing convention — inline `<svg stroke="currentColor">`,
  as already used by the tree-footer create buttons.
- CSS uses `var(--*)` only: `--surface` / `--surface-hover` / `--border` /
  `--radius-sm` / `--text` / `--text-dim` / `--accent` / `--transition`. No literal
  colors, blurs or radii.

### Step 4 — wire into `KbView.tsx`

- Render `<KbToolbar>` as the first child of `.bodyEditor`, above the `<textarea>`.
- Replace the body of `wrapSelection` with a generic
  `applyEdit(fn: (text, s, e) => SelectionEdit)` that reads
  `selectionStart`/`selectionEnd`, calls the pure function, pushes the result through
  the existing `onBodyChange` (so autosave/debounce behaviour is unchanged), and
  restores the returned selection in the existing `requestAnimationFrame` callback.
- Re-point `onEditorKeyDown`'s `⌘B`/`⌘I`/`⌘K` at `kbEdits.ts` so shortcuts and
  buttons share one code path. Add `⌘U` for underline, matching Google Docs.
- `onBodyClick`: if the click target is (or is inside) an `<a>` with a resolvable
  href, `preventDefault()` and hand it to `openExternal()` instead of entering edit
  mode.
- Update the `.editorHint` line to reflect the new syntaxes.

### Step 5 — CSS for newly-rendered elements

In `KbView.module.css`, alongside the existing `.bodyRendered :global(ul)` rules, add
`:global(ol)` (matching list metrics), `:global(a)` (accent color, underline on
hover), `:global(mark)` (respects an inline `background`, default falls back to a
token), `:global(u)`, `:global(del)`. Give `.bodyEditor` room for the toolbar so the
textarea still fills the remaining height. Extend the existing
`@media (max-width: 768px)` block so the toolbar scrolls horizontally
(`overflow-x: auto`) with ≥44px touch targets — additive only, per the mobile rule.

### Step 6 — validate + sync docs

`npm run typecheck && npm run lint && npm test && npm run build`, then run the
`sync-docs` skill. Documentation gaps this change must close:

- `.claude/rules/frontend-react.md` — add `kbEdits.ts` and `KbToolbar` to the
  component/module structure list.
- `.claude/docs/codemap.md` — the KB surface is currently **absent** from the codemap
  (verified by grep); at minimum add the new modules.
- `packages/server/src/types.ts` KB comment block and its web mirror — the wording
  "Obsidian-style live markdown rendering" is still accurate but should mention the
  supported inline conventions. Comment-only; no type change.

Per this repo's app-only directive, finish with `npm run desktop:build` so the
shipped `.app` carries the new code. **Note:** a saved memory records that Rust is
unavailable on this host, in which case `npm run build && npm run bundle:sidecar` is
the correct substitute and the limitation is stated plainly in the PR body.

---

## Test strategy

**Runner:** Vitest, both workspaces. This change is web-only.

- Whole suite: `npm test`
- This workspace: `npm run test -w @zmrng/web`
- Full gate: `npm run typecheck && npm run lint && npm test && npm run build`

Fork concurrency is capped via `ZMRNG_VITEST_MAX_FORKS` (`.claude/rules/testing.md`);
no test may spawn `claude`, call `gh`, or touch the network.

### `packages/web/test/kbEdits.test.ts` — **new**

Proves every toolbar action produces correct text *and* correct resulting selection,
with no DOM involved.

- `toggleWrap` applies `**`/`*`/`~~`/`<u>` around a selection, and the returned
  selection still spans the original text.
- `toggleWrap` on an **already-wrapped** selection strips the markers (the toggle-off
  contract) and is therefore idempotent over two calls.
- `toggleWrap` with an empty selection inserts both markers and leaves the caret
  between them — pins today's `⌘B`-with-no-selection behaviour.
- `toggleLinePrefix` prefixes **every** line a multi-line selection touches, toggles
  all of them off when all already carry the prefix, and replaces a competing list
  marker instead of stacking on it.
- `toggleOrderedList` numbers from 1 sequentially across a multi-line selection and
  toggles off.
- `applyHeading` applies, replaces an existing different level, and strips at
  level 0.
- `applyLink` uses the selection as the label and leaves the caret on the `url`
  placeholder; the empty-selection case inserts the full `[text](url)` skeleton.
- `applyTextColor` / `applyHighlight` emit exactly the conventions the renderer
  parses (round-trip guard: the emitted string is fed to `renderPageMarkdown` and
  asserted to produce a real `<span>` / `<mark>`), and toggle off. `applyHighlight`
  with `null` emits bare `==text==`.
- Palette constants are non-empty and every entry is a valid 6-digit hex — the exact
  shape the renderer's allow-list accepts, so a palette entry can never render as
  literal text.

### `packages/web/test/kbMarkdown.test.ts` — **extended**

Proves each new button's output actually renders, and that the allow-list cannot be
widened by accident.

Rendering:
- `~~x~~` → `<del>`; `==x==` → `<mark>`.
- `<u>x</u>` → a real `<u>` element.
- `<span style="color:#ff0000">x</span>` and
  `<mark style="background:#ffff00">x</mark>` → real elements with the hex preserved.
- A run of `1. `/`1) ` lines → one `<ol>` with one `<li>` per line; a single numbered
  line inside a paragraph does not disturb the surrounding paragraph grouping.
- `[text](https://x)` → an `<a>` with that href; bullet, checklist, heading, fenced
  code and paragraph grouping are all unchanged (the existing assertions must still
  pass verbatim).

Security / near-miss — each must remain **escaped literal text**, never an element:
- `<script>alert(1)</script>` (the existing pinned case, unchanged).
- `<span onclick="x()">` — extra attribute.
- `<span style="color:red">` — named color, not hex.
- `<span style="color:#fff">` — 3-digit hex.
- `<span style="color:#ff0000;position:fixed">` — extra CSS declaration.
- `<u class="x">` — attribute on an allow-listed tag.
- `<img src=x onerror=alert(1)>` — non-allow-listed tag.
- `[x](javascript:alert(1))` and `[x](data:text/html,…)` — rejected schemes stay
  literal text.
- `[x](java\tscript:alert(1))` with an embedded tab/newline — the whitespace-stripping
  scheme check must still reject it.
- `[x](//evil.example.com)` — protocol-relative URLs are rejected, not treated as a
  relative path.
- `[x](/local/page)` and `[x](#anchor)` — genuinely relative targets still render as
  anchors, so the sanitizer is not simply rejecting everything.

### `packages/web/test/KbToolbar.test.tsx` — **new**

Component-level, rendering `KbToolbar` directly against a stub value + selection and a
spy `onApply` (no `api` mocking needed).

- All eleven controls render with accessible names.
- Clicking Bold with a selection calls `onApply` with the `**`-wrapped result.
- **`mousedown` on a toolbar button is default-prevented** — the assertion that
  directly pins the blur trap from grill §1. If someone later drops that guard, this
  test fails instead of the feature silently dying.
- The heading popover opens on click and "Heading 2" applies `## `.
- A text-color swatch applies the span convention; the "None" entry removes it.

### `packages/web/test/KbView.toolbar.test.tsx` — **new** (integration)

The one end-to-end test, reusing the `api`-mock shape already established in
`KbView.spaces.test.tsx` (`active={false}` so no workspace socket opens), seeded with
one space containing one page.

- The toolbar is **not** rendered in read mode, and **is** rendered after clicking the
  body to enter edit mode.
- Clicking Bold with a textarea selection updates the textarea value **and leaves the
  editor in edit mode** — the real regression this feature would otherwise hit in
  production but not in an isolated component test.
- A read-only viewer (empty `teamHandle`, so `canEdit` is false) never sees the
  toolbar.

### Manual smoke

Per `.claude/rules/testing.md`, using the dev loop at `http://localhost:5174`
(`npm run dev` — never `npm run build` for a dev loop): open KB → open a page → click
into the body → exercise each of the eleven controls on a selection → click away and
confirm the rendered output matches, reload to confirm it persisted, and check the
toolbar at a phone viewport width.
