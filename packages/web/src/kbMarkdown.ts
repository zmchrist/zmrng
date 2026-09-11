// Pure, dependency-free markdown → HTML renderer for KB block bodies. The wire
// + DB format stays markdown regardless (blocks are edited as a markdown
// textarea); this only produces the read-only HTML shown on blur. It is
// intentionally minimal — headings, emphasis, inline code, links-free — honoring
// the five KbBlock kinds. Kept React-free so it is unit-tested without a DOM.

import type { KbBlockKind } from './types'

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

/** Parse a block's `meta` JSON string into a plain record (empty on failure). */
function parseMeta(meta: string | null): Record<string, unknown> {
  if (!meta) return {}
  try {
    const parsed: unknown = JSON.parse(meta)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Clamp a heading level from meta `{level}` into the 1..6 range (default 2). */
function headingLevel(meta: Record<string, unknown>): number {
  const raw = meta.level
  const n = typeof raw === 'number' ? raw : 2
  return Math.min(6, Math.max(1, Math.trunc(n)))
}

/** True when a checklist body/meta marks the item done (`- [x]` or meta.checked). */
function isChecked(line: string, meta: Record<string, unknown>): boolean {
  if (/^\s*[-*]\s*\[[xX]\]/.test(line)) return true
  return meta.checked === true
}

/** Strip a leading list/checkbox marker from one line, returning the content. */
function stripMarker(line: string): string {
  return line.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '')
}

/**
 * Render one KB block to an HTML string, dispatched by kind:
 * - `heading`  → `<h{level}>` (level from meta, default 2)
 * - `code`     → `<pre><code>` (no inline formatting, escaped verbatim)
 * - `checklist`→ a `<ul>` of checkbox items (checked from `- [x]` or meta)
 * - `list`     → a `<ul>` of bullet items
 * - `text`     → paragraphs split on blank lines, single newlines as `<br>`
 */
export function renderMarkdown(body: string, kind: KbBlockKind, meta: string | null): string {
  const metaObj = parseMeta(meta)
  const lines = body.split('\n')

  if (kind === 'code') {
    return `<pre><code>${escapeHtml(body)}</code></pre>`
  }

  if (kind === 'heading') {
    const level = headingLevel(metaObj)
    const text = renderInline(escapeHtml(body.replace(/^#+\s*/, '').trim()))
    return `<h${level}>${text}</h${level}>`
  }

  if (kind === 'checklist') {
    const items = lines
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const checked = isChecked(l, metaObj)
        const content = renderInline(escapeHtml(stripMarker(l)))
        return `<li><input type="checkbox" disabled${checked ? ' checked' : ''} /> ${content}</li>`
      })
      .join('')
    return `<ul>${items}</ul>`
  }

  if (kind === 'list') {
    const items = lines
      .filter((l) => l.trim().length > 0)
      .map((l) => `<li>${renderInline(escapeHtml(stripMarker(l)))}</li>`)
      .join('')
    return `<ul>${items}</ul>`
  }

  // text: split into paragraphs on blank lines; single newlines become <br>.
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const inner = p
        .split('\n')
        .map((line) => renderInline(escapeHtml(line)))
        .join('<br />')
      return `<p>${inner}</p>`
    })
  return paragraphs.join('')
}
