// Pure, React-free selection transforms behind the KB page editor's formatting
// toolbar (and its ⌘B/⌘I/⌘U/⌘K shortcuts — both drive THESE helpers, so there is
// one mechanism rather than two divergent copies).
//
// Every function takes the editor's whole text plus the current selection range
// and returns the new text with the selection that should be restored after
// React re-renders. No DOM, no React — unit-tested without a document.
//
// The markdown conventions emitted here are exactly the ones `kbMarkdown.ts`
// renders: `**bold**`, `*italic*`, `~~strike~~`, `<u>underline</u>`,
// `==highlight==`, `<mark style="background:#RRGGBB">`,
// `<span style="color:#RRGGBB">`, `#`-headings, `- `/`- [ ] `/`1. ` lists and
// `[text](url)` links. Change one side and the other stops rendering.

/** The result of one editor transform: the new text plus the selection to restore. */
export interface SelectionEdit {
  text: string
  selStart: number
  selEnd: number
}

/** One curated document color (palette entry), as `{ name, hex }`. */
export interface KbColor {
  name: string
  /** A 6-digit `#RRGGBB` hex — the ONLY shape the renderer's allow-list accepts. */
  hex: string
}

/**
 * The curated text-color palette, modelled on `emojiSet.ts`'s `REACTION_EMOJI`:
 * a small static constant (no picker library, no full color wheel) so the
 * control works offline in the bundled desktop app.
 *
 * These hexes are DOCUMENT CONTENT — they are written into the page body and
 * must survive being read outside our stylesheet — so a literal hex is correct
 * here and does not violate the design-token rule. The toolbar's own chrome
 * uses `var(--*)` exclusively.
 */
export const KB_TEXT_COLORS: readonly KbColor[] = [
  { name: 'Red', hex: '#d93025' },
  { name: 'Orange', hex: '#e8710a' },
  { name: 'Yellow', hex: '#f2b705' },
  { name: 'Green', hex: '#188038' },
  { name: 'Blue', hex: '#1a73e8' },
  { name: 'Purple', hex: '#8430ce' },
  { name: 'Grey', hex: '#5f6368' },
]

/** The curated highlight-color palette (same rationale as `KB_TEXT_COLORS`). */
export const KB_HIGHLIGHT_COLORS: readonly KbColor[] = [
  { name: 'Yellow', hex: '#fff275' },
  { name: 'Green', hex: '#b7f0c2' },
  { name: 'Blue', hex: '#b3dcff' },
  { name: 'Pink', hex: '#ffc0d9' },
  { name: 'Orange', hex: '#ffd6a5' },
  { name: 'Grey', hex: '#e0e0e0' },
]

/** The heading-style picker's entries; level 0 is "Normal text" (strip only). */
export const HEADING_LEVELS: readonly { level: number; label: string }[] = [
  { level: 0, label: 'Normal text' },
  { level: 1, label: 'Heading 1' },
  { level: 2, label: 'Heading 2' },
  { level: 3, label: 'Heading 3' },
]

/** The `<span style="color:#RRGGBB">` wrapper this module emits for a text color. */
export function textColorOpen(hex: string): string {
  return `<span style="color:${hex}">`
}

/** The `<mark style="background:#RRGGBB">` wrapper this module emits for a highlight. */
export function highlightOpen(hex: string): string {
  return `<mark style="background:${hex}">`
}

const SPAN_CLOSE = '</span>'
const MARK_CLOSE = '</mark>'
const TEXT_COLOR_OPEN_RE = /<span style="color:#[0-9a-fA-F]{6}">/
const HIGHLIGHT_OPEN_RE = /<mark style="background:#[0-9a-fA-F]{6}">/

// ---- inline wraps -----------------------------------------------------------

/**
 * Wrap the selection in `before`/`after` — or, when it is ALREADY wrapped
 * (markers immediately inside or immediately outside the selection), strip them
 * instead, so the toolbar button toggles like Google Docs' does.
 *
 * With an empty selection both markers are inserted and the caret is left
 * between them (this is the pre-existing `⌘B`-with-no-selection behaviour).
 */
export function toggleWrap(
  text: string,
  s: number,
  e: number,
  before: string,
  after: string,
): SelectionEdit {
  const inner = text.slice(s, e)
  if (
    inner.length >= before.length + after.length &&
    inner.startsWith(before) &&
    inner.endsWith(after)
  ) {
    const stripped = inner.slice(before.length, inner.length - after.length)
    return {
      text: text.slice(0, s) + stripped + text.slice(e),
      selStart: s,
      selEnd: s + stripped.length,
    }
  }
  if (text.slice(s - before.length, s) === before && text.slice(e, e + after.length) === after) {
    return {
      text: text.slice(0, s - before.length) + inner + text.slice(e + after.length),
      selStart: s - before.length,
      selEnd: e - before.length,
    }
  }
  return {
    text: text.slice(0, s) + before + inner + after + text.slice(e),
    selStart: s + before.length,
    selEnd: e + before.length,
  }
}

/**
 * Strip a wrapper matched by `openRe` (plus its literal `close`) from around or
 * inside the selection. Returns the resulting edit and the exact opening tag
 * that was removed, or `null` when no such wrapper is present.
 */
function unwrapMatching(
  text: string,
  s: number,
  e: number,
  openRe: RegExp,
  close: string,
): { edit: SelectionEdit; removed: string } | null {
  const inner = text.slice(s, e)
  const insideOpen = new RegExp(`^(?:${openRe.source})`).exec(inner)
  if (insideOpen && inner.endsWith(close) && inner.length >= insideOpen[0].length + close.length) {
    return {
      removed: insideOpen[0],
      edit: toggleWrap(text, s, e, insideOpen[0], close),
    }
  }
  const outsideOpen = new RegExp(`(?:${openRe.source})$`).exec(text.slice(0, s))
  if (outsideOpen && text.slice(e, e + close.length) === close) {
    return {
      removed: outsideOpen[0],
      edit: toggleWrap(text, s, e, outsideOpen[0], close),
    }
  }
  return null
}

/**
 * Apply a text color to the selection. Toggles off when the SAME color already
 * wraps it, and replaces (rather than nesting) a different one.
 */
export function applyTextColor(text: string, s: number, e: number, hex: string): SelectionEdit {
  const open = textColorOpen(hex)
  const existing = unwrapMatching(text, s, e, TEXT_COLOR_OPEN_RE, SPAN_CLOSE)
  if (!existing) return toggleWrap(text, s, e, open, SPAN_CLOSE)
  if (existing.removed === open) return existing.edit
  const { text: t, selStart, selEnd } = existing.edit
  return toggleWrap(t, selStart, selEnd, open, SPAN_CLOSE)
}

/** Remove any text-color span around the selection (the picker's "None" entry). */
export function removeTextColor(text: string, s: number, e: number): SelectionEdit {
  return unwrapMatching(text, s, e, TEXT_COLOR_OPEN_RE, SPAN_CLOSE)?.edit ?? {
    text,
    selStart: s,
    selEnd: e,
  }
}

/**
 * Highlight the selection: `hex === null` emits the bare Obsidian-style
 * `==text==`, a hex emits `<mark style="background:#RRGGBB">`. Toggles off when
 * the same construct already wraps the selection, and replaces a different one.
 */
export function applyHighlight(
  text: string,
  s: number,
  e: number,
  hex: string | null,
): SelectionEdit {
  if (hex === null) {
    const colored = unwrapMatching(text, s, e, HIGHLIGHT_OPEN_RE, MARK_CLOSE)
    if (colored) {
      const { text: t, selStart, selEnd } = colored.edit
      return toggleWrap(t, selStart, selEnd, '==', '==')
    }
    return toggleWrap(text, s, e, '==', '==')
  }
  const open = highlightOpen(hex)
  const existing = unwrapMatching(text, s, e, HIGHLIGHT_OPEN_RE, MARK_CLOSE)
  if (!existing) {
    const bare = unwrapMatching(text, s, e, /==/, '==')
    if (bare) {
      const { text: t, selStart, selEnd } = bare.edit
      return toggleWrap(t, selStart, selEnd, open, MARK_CLOSE)
    }
    return toggleWrap(text, s, e, open, MARK_CLOSE)
  }
  if (existing.removed === open) return existing.edit
  const { text: t, selStart, selEnd } = existing.edit
  return toggleWrap(t, selStart, selEnd, open, MARK_CLOSE)
}

/** Remove any highlight (bare `==` or colored `<mark>`) around the selection. */
export function removeHighlight(text: string, s: number, e: number): SelectionEdit {
  return (
    unwrapMatching(text, s, e, HIGHLIGHT_OPEN_RE, MARK_CLOSE)?.edit ??
    unwrapMatching(text, s, e, /==/, '==')?.edit ?? { text, selStart: s, selEnd: e }
  )
}

/**
 * Turn the selection into a markdown link. A non-empty selection becomes the
 * label and the caret lands on the `url` placeholder so it can be typed over
 * immediately; an empty selection inserts the whole `[text](url)` skeleton with
 * the `text` placeholder selected instead (the label is what you type first).
 */
export function applyLink(text: string, s: number, e: number): SelectionEdit {
  const label = text.slice(s, e)
  if (label.length === 0) {
    return {
      text: `${text.slice(0, s)}[text](url)${text.slice(e)}`,
      selStart: s + 1,
      selEnd: s + 5,
    }
  }
  const inserted = `[${label}](url)`
  const urlStart = s + label.length + 3
  return {
    text: text.slice(0, s) + inserted + text.slice(e),
    selStart: urlStart,
    selEnd: urlStart + 3,
  }
}

// ---- line-level edits -------------------------------------------------------

/**
 * A line split into its indent, leading list marker (bullet / checklist /
 * ordered — whichever is present) and remaining content. This is the seam that
 * lets one list style REPLACE another instead of stacking on top of it.
 */
interface SplitLine {
  indent: string
  marker: string
  content: string
}

const LINE_RE = /^([ \t]*)((?:[-*][ \t]+\[[ xX]\][ \t]+)|(?:[-*][ \t]+)|(?:\d+[.)][ \t]+))?(.*)$/

function splitLine(line: string): SplitLine {
  const m = LINE_RE.exec(line)
  // The regex is total (every part is optional), so a null match is impossible.
  return { indent: m?.[1] ?? '', marker: m?.[2] ?? '', content: m?.[3] ?? line }
}

/**
 * Run `transform` over every line the selection touches, then map the selection
 * through the change. Because these transforms only add or remove text at the
 * START of a line, a position's new offset is its column plus that line's
 * length delta (clamped into the rewritten line).
 */
function editTouchedLines(
  text: string,
  s: number,
  e: number,
  transform: (lines: string[]) => string[],
): SelectionEdit {
  const blockStart = text.lastIndexOf('\n', Math.max(0, s - 1)) + 1
  const nextBreak = text.indexOf('\n', e)
  const blockEnd = nextBreak === -1 ? text.length : nextBreak
  const lines = text.slice(blockStart, blockEnd).split('\n')
  const next = transform(lines)

  const mapPos = (p: number): number => {
    let srcOffset = blockStart
    let outOffset = blockStart
    for (let i = 0; i < lines.length; i++) {
      if (p <= srcOffset + lines[i].length) {
        const col = p - srcOffset + (next[i].length - lines[i].length)
        return outOffset + Math.max(0, Math.min(next[i].length, col))
      }
      srcOffset += lines[i].length + 1
      outOffset += next[i].length + 1
    }
    return outOffset
  }

  return {
    text: text.slice(0, blockStart) + next.join('\n') + text.slice(blockEnd),
    selStart: mapPos(s),
    selEnd: mapPos(e),
  }
}

/**
 * Toggle a list marker (`- ` or `- [ ] `) on every line the selection touches.
 * When every touched line already carries exactly this marker the whole run is
 * un-marked; otherwise any competing marker is replaced by this one.
 */
export function toggleLinePrefix(
  text: string,
  s: number,
  e: number,
  prefix: string,
): SelectionEdit {
  return editTouchedLines(text, s, e, (lines) => {
    const parts = lines.map(splitLine)
    const allHave = parts.every((p) => p.marker === prefix)
    return parts.map((p) => (allHave ? p.indent + p.content : p.indent + prefix + p.content))
  })
}

/**
 * Number every line the selection touches `1. `, `2. `, … (always renumbering
 * from one), or strip the numbering when every touched line already has it.
 */
export function toggleOrderedList(text: string, s: number, e: number): SelectionEdit {
  return editTouchedLines(text, s, e, (lines) => {
    const parts = lines.map(splitLine)
    const allNumbered = parts.every((p) => /^\d+[.)][ \t]+$/.test(p.marker))
    return parts.map((p, i) =>
      allNumbered ? p.indent + p.content : `${p.indent}${i + 1}. ${p.content}`,
    )
  })
}

/**
 * Set the heading level on every line the selection touches, replacing any
 * heading already there. `level === 0` is "Normal text" — strip only.
 */
export function applyHeading(text: string, s: number, e: number, level: number): SelectionEdit {
  return editTouchedLines(text, s, e, (lines) =>
    lines.map((line) => {
      const bare = line.replace(/^([ \t]*)#{1,6}[ \t]+/, '$1')
      if (level <= 0) return bare
      const indent = /^[ \t]*/.exec(bare)?.[0] ?? ''
      return `${indent}${'#'.repeat(level)} ${bare.slice(indent.length)}`
    }),
  )
}
