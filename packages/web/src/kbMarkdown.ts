// Pure, dependency-free markdown → HTML renderer for a KB page's whole body.
// The page is ONE continuous plaintext/markdown field (no per-block model) —
// this groups its lines into headings / fenced code / checklists / bullet and
// ordered lists / paragraphs and renders each, Obsidian-style. It is still
// deliberately small (no tables, images or block quotes) and kept React-free so
// it is unit-tested without a DOM.
//
// Inline conventions — these are exactly what the formatting toolbar
// (`kbEdits.ts`) emits, so the two files must change together:
//   **bold**  *italic*  `code`  ~~strike~~  ==highlight==  [text](url)
//   <u>…</u>  <mark style="background:#RRGGBB">…</mark>
//   <span style="color:#RRGGBB">…</span>
//
// SECURITY MODEL — the output goes straight into `dangerouslySetInnerHTML`, so
// the rule is: escape EVERYTHING first, then apply regexes to the escaped
// string. The handful of supported HTML tags are re-admitted by a CLOSED
// allow-list (`unescapeAllowedTags`) that matches only those exact escaped
// shapes, whose sole variable part is six hex digits. Anything else — an extra
// attribute, a named color, a 3-digit hex, any other tag — stays escaped and
// renders as visible literal text. Link hrefs go through `safeLinkHref`.
// Never un-escape generically.

/** Escape the five HTML-significant characters so raw markdown never injects. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Validate a link target from `[text](url)`, returning the href to emit or
 * `null` when the URL is not safe (the caller then leaves the whole construct
 * as literal escaped text).
 *
 * `url` arrives ALREADY HTML-escaped, which is what makes the emitted
 * `href="…"` safe to build by concatenation. The checks, in order:
 *
 * - ASCII whitespace and C0 control characters are stripped first — browsers
 *   ignore them inside a scheme, so a naive prefix test lets
 *   `java\tscript:alert(1)` through.
 * - Anything carrying an escaped `<`, `>`, `"` or `'` is rejected outright, so
 *   a URL can never smuggle markup back out through the allow-list pass that
 *   runs after this one.
 * - Protocol-relative `//host/…` is rejected: it is technically "relative" but
 *   resolves off-origin.
 * - Accepted: `http:`, `https:`, `mailto:`, a same-document `#anchor`, or a
 *   relative path with no scheme at all. Every other scheme is rejected.
 */
export function safeLinkHref(url: string): string | null {
  // A char-code filter rather than a regex: a control-character class is
  // exactly what ESLint's `no-control-regex` (rightly) flags, and spelling the
  // bound out is clearer than an escape soup anyway.
  const clean = Array.from(url)
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code > 0x20 && code !== 0x7f
    })
    .join('')
  if (clean.length === 0) return null
  if (/&lt;|&gt;|&quot;|&#39;/.test(clean)) return null
  if (clean.startsWith('//')) return null
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(clean)
  if (scheme) {
    const name = scheme[1].toLowerCase()
    return name === 'http' || name === 'https' || name === 'mailto' ? clean : null
  }
  return clean
}

/**
 * The closed allow-list pass: re-admit ONLY these exact escaped tag shapes.
 * The single variable part is a strict 6-digit hex, so no attribute, event
 * handler, `javascript:` URL or CSS `expression()` can be smuggled through.
 */
function unescapeAllowedTags(escaped: string): string {
  return escaped
    .replace(/&lt;(\/?)u&gt;/g, '<$1u>')
    .replace(/&lt;(\/?)mark&gt;/g, '<$1mark>')
    .replace(/&lt;\/span&gt;/g, '</span>')
    .replace(
      /&lt;mark style=&quot;background:(#[0-9a-fA-F]{6})&quot;&gt;/g,
      '<mark style="background:$1">',
    )
    .replace(/&lt;span style=&quot;color:(#[0-9a-fA-F]{6})&quot;&gt;/g, '<span style="color:$1">')
}

/**
 * Render inline markdown spans on an already-escaped string. Order matters:
 * strike/highlight/links run before emphasis so markup inside a link label is
 * still formatted, inline code is extracted last so its contents are not
 * re-formatted, and the allow-list un-escape runs at the very end on what is by
 * then a mix of escaped text and generated tags (which it cannot match).
 */
function renderInline(escaped: string): string {
  return unescapeAllowedTags(
    escaped
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>')
      .replace(/\[([^\]\n]*)\]\(([^)\n]+)\)/g, (whole, label: string, url: string) => {
        const href = safeLinkHref(url)
        return href === null ? whole : `<a href="${href}" rel="noopener noreferrer">${label}</a>`
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>'),
  )
}

/** True when a line is a checklist item (`- [ ]` / `- [x]`). */
function isChecklistLine(line: string): boolean {
  return /^\s*[-*]\s+\[[ xX]\]\s*/.test(line)
}

/** True when a line is a plain bullet (`- ` / `* `), not a checklist item. */
function isListLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line) && !isChecklistLine(line)
}

/** True when a line is an ordered-list item (`1. ` / `1) `). */
function isOrderedLine(line: string): boolean {
  return /^\s*\d+[.)]\s+/.test(line)
}

/** True when a checklist line marks its item done (`- [x]`). */
function isChecked(line: string): boolean {
  return /^\s*[-*]\s+\[[xX]\]/.test(line)
}

/** Strip a leading list/checkbox marker from one line, returning the content. */
function stripMarker(line: string): string {
  return line.replace(/^\s*[-*]\s+(\[[ xX]\]\s*)?/, '')
}

/** Strip a leading ordered-list marker (`1. ` / `1) `) from one line. */
function stripOrderedMarker(line: string): string {
  return line.replace(/^\s*\d+[.)]\s+/, '')
}

/**
 * Render one KB page body to an HTML string. The body is split into lines and
 * grouped into consecutive runs of the same kind:
 * - a ```` ``` ```` fence opens a `<pre><code>` block, rendered verbatim up to
 *   its closing fence (or end of body)
 * - a line starting `#`..`######` + space is its own `<h{level}>`
 * - a run of `- [ ]` / `- [x]` lines becomes one interactive `<ul>` checklist —
 *   each `<li>` carries `data-line="<n>"` (the source line index) so a click
 *   handler can toggle that exact line via `toggleChecklistLine`
 * - a run of `- ` / `* ` lines (not checklist) becomes one plain `<ul>`
 * - a run of `1. ` / `1) ` lines becomes one `<ol>` (checked AFTER the two
 *   `<ul>` branches so their detection is unchanged)
 * - a run of blank lines separates paragraphs; other consecutive lines join
 *   into one `<p>` with `<br />` between them
 */
export function renderPageMarkdown(body: string): string {
  const lines = body.split('\n')
  const html: string[] = []
  let i = 0
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const inner = paragraph.map((l) => renderInline(escapeHtml(l))).join('<br />')
    html.push(`<p>${inner}</p>`)
    paragraph = []
  }

  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*```/.test(line)) {
      flushParagraph()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      i++ // consume the closing fence (or run off the end, harmlessly)
      html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`)
      i++
      continue
    }

    if (isChecklistLine(line)) {
      flushParagraph()
      const items: string[] = []
      while (i < lines.length && isChecklistLine(lines[i])) {
        const checked = isChecked(lines[i])
        const content = renderInline(escapeHtml(stripMarker(lines[i])))
        items.push(
          `<li><input type="checkbox" data-line="${i}"${checked ? ' checked' : ''} /> ${content}</li>`,
        )
        i++
      }
      html.push(`<ul class="kb-checklist">${items.join('')}</ul>`)
      continue
    }

    if (isListLine(line)) {
      flushParagraph()
      const items: string[] = []
      while (i < lines.length && isListLine(lines[i])) {
        items.push(`<li>${renderInline(escapeHtml(stripMarker(lines[i])))}</li>`)
        i++
      }
      html.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    if (isOrderedLine(line)) {
      flushParagraph()
      const items: string[] = []
      while (i < lines.length && isOrderedLine(lines[i])) {
        items.push(`<li>${renderInline(escapeHtml(stripOrderedMarker(lines[i])))}</li>`)
        i++
      }
      html.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    if (line.trim().length === 0) {
      flushParagraph()
      i++
      continue
    }

    paragraph.push(line)
    i++
  }
  flushParagraph()
  return html.join('')
}

/**
 * Toggle the `- [ ]` / `- [x]` marker on ONE source line of a page body,
 * leaving every other line untouched. Used by the click-to-toggle checklist
 * interactivity in the rendered (non-editing) view. `line` is the 0-based
 * source-line index carried on the rendered `<li>`'s `data-line`. A
 * non-checklist or out-of-range line is returned unchanged.
 */
export function toggleChecklistLine(body: string, line: number): string {
  const lines = body.split('\n')
  if (line < 0 || line >= lines.length || !isChecklistLine(lines[line])) return body
  lines[line] = isChecked(lines[line])
    ? lines[line].replace(/\[[xX]\]/, '[ ]')
    : lines[line].replace(/\[ \]/, '[x]')
  return lines.join('\n')
}
