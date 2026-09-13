// Pure, dependency-free markdown → HTML renderer for a KB page's whole body.
// The page is ONE continuous plaintext/markdown field (no per-block model) —
// this groups its lines into headings / fenced code / checklists / lists /
// paragraphs and renders each, Obsidian-style. It is intentionally minimal
// (headings, emphasis, inline code, no links) and kept React-free so it is
// unit-tested without a DOM.

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
 * Render inline markdown spans on an already-escaped string: `**bold**`,
 * `*italic*`, and `` `code` ``. Order matters — inline code is extracted last so
 * its contents are not re-formatted.
 */
function renderInline(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** True when a line is a checklist item (`- [ ]` / `- [x]`). */
function isChecklistLine(line: string): boolean {
  return /^\s*[-*]\s+\[[ xX]\]\s*/.test(line)
}

/** True when a line is a plain bullet (`- ` / `* `), not a checklist item. */
function isListLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line) && !isChecklistLine(line)
}

/** True when a checklist line marks its item done (`- [x]`). */
function isChecked(line: string): boolean {
  return /^\s*[-*]\s+\[[xX]\]/.test(line)
}

/** Strip a leading list/checkbox marker from one line, returning the content. */
function stripMarker(line: string): string {
  return line.replace(/^\s*[-*]\s+(\[[ xX]\]\s*)?/, '')
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
