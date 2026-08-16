function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

/**
 * Minimal markdown → HTML for the Viewer's live preview pane. Not a full
 * CommonMark implementation — headers, emphasis, inline code, links, fenced
 * code blocks, and lists cover the vast majority of task notes and READMEs.
 * Input is HTML-escaped before any tag is introduced, so the output is safe
 * to render with `dangerouslySetInnerHTML`.
 */
export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split('\n')
  const out: string[] = []
  let inCode = false
  let listOpen: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`)
      listOpen = null
    }
  }

  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      if (!inCode) {
        closeList()
        inCode = true
        out.push(`<pre><code class="lang-${fence[1]}">`)
      } else {
        inCode = false
        out.push('</code></pre>')
      }
      continue
    }
    if (inCode) {
      out.push(`${line}\n`)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }

    const ulItem = /^[-*]\s+(.*)$/.exec(line)
    if (ulItem) {
      if (listOpen !== 'ul') {
        closeList()
        out.push('<ul>')
        listOpen = 'ul'
      }
      out.push(`<li>${inline(ulItem[1])}</li>`)
      continue
    }

    const olItem = /^\d+\.\s+(.*)$/.exec(line)
    if (olItem) {
      if (listOpen !== 'ol') {
        closeList()
        out.push('<ol>')
        listOpen = 'ol'
      }
      out.push(`<li>${inline(olItem[1])}</li>`)
      continue
    }

    closeList()
    if (line.trim() === '') continue
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return out.join('\n')
}
