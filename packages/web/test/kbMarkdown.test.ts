import { describe, it, expect } from 'vitest'
import { renderMarkdown, escapeHtml } from '../src/kbMarkdown'

describe('escapeHtml', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('renderMarkdown', () => {
  it('renders a text block as escaped paragraphs with <br> for single newlines', () => {
    const html = renderMarkdown('line one\nline two\n\nsecond para', 'text', null)
    expect(html).toBe('<p>line one<br />line two</p><p>second para</p>')
  })

  it('escapes HTML in a text block (no injection)', () => {
    expect(renderMarkdown('<script>alert(1)</script>', 'text', null)).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  it('renders inline bold, italic, and code spans', () => {
    expect(renderMarkdown('a **b** and *c* and `d`', 'text', null)).toBe(
      '<p>a <strong>b</strong> and <em>c</em> and <code>d</code></p>',
    )
  })

  it('renders a heading at the meta level, stripping leading #', () => {
    expect(renderMarkdown('# Title', 'heading', '{"level":1}')).toBe('<h1>Title</h1>')
  })

  it('defaults a heading with no meta level to h2', () => {
    expect(renderMarkdown('Title', 'heading', null)).toBe('<h2>Title</h2>')
  })

  it('clamps an out-of-range heading level into 1..6', () => {
    expect(renderMarkdown('Deep', 'heading', '{"level":9}')).toBe('<h6>Deep</h6>')
  })

  it('renders a code block verbatim without inline formatting', () => {
    expect(renderMarkdown('const x = **1**', 'code', null)).toBe(
      '<pre><code>const x = **1**</code></pre>',
    )
  })

  it('renders a list, stripping bullet markers', () => {
    expect(renderMarkdown('- one\n- two', 'list', null)).toBe('<ul><li>one</li><li>two</li></ul>')
  })

  it('renders a checklist with checkbox state from - [x] markers', () => {
    expect(renderMarkdown('- [ ] todo\n- [x] done', 'checklist', null)).toBe(
      '<ul>' +
        '<li><input type="checkbox" disabled /> todo</li>' +
        '<li><input type="checkbox" disabled checked /> done</li>' +
        '</ul>',
    )
  })

  it('honors meta.checked for a whole checklist block', () => {
    expect(renderMarkdown('item', 'checklist', '{"checked":true}')).toBe(
      '<ul><li><input type="checkbox" disabled checked /> item</li></ul>',
    )
  })
})
