import { describe, it, expect } from 'vitest'
import {
  renderMarkdown,
  escapeHtml,
  detectKind,
  renderKbBlock,
  toEditableMarkdown,
} from '../src/kbMarkdown'

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

describe('detectKind', () => {
  it('detects a heading and its level from leading hashes', () => {
    expect(detectKind('## Title')).toEqual({ kind: 'heading', meta: '{"level":2}' })
    expect(detectKind('###### Deep')).toEqual({ kind: 'heading', meta: '{"level":6}' })
  })

  it('detects a fenced code block', () => {
    expect(detectKind('```ts\nconst x = 1\n```')).toEqual({ kind: 'code', meta: null })
  })

  it('detects a checklist when every non-empty line is a task item', () => {
    expect(detectKind('- [ ] todo\n- [x] done')).toEqual({ kind: 'checklist', meta: null })
  })

  it('detects a bullet list', () => {
    expect(detectKind('- one\n- two')).toEqual({ kind: 'list', meta: null })
  })

  it('returns null for plain prose (no strong markers)', () => {
    expect(detectKind('just a sentence')).toBeNull()
    expect(detectKind('   ')).toBeNull()
  })

  it('does not treat "#tag" (no space) as a heading', () => {
    expect(detectKind('#tag not a heading')).toBeNull()
  })
})

describe('renderKbBlock', () => {
  it('renders a body-inferred heading regardless of the stored kind', () => {
    expect(renderKbBlock('# Title', 'text', null)).toBe('<h1>Title</h1>')
  })

  it('renders a body-inferred list regardless of the stored kind', () => {
    expect(renderKbBlock('- one\n- two', 'text', null)).toBe(
      '<ul><li>one</li><li>two</li></ul>',
    )
  })

  it('strips the ``` fences from an inferred code block', () => {
    expect(renderKbBlock('```ts\nconst x = **1**\n```', 'text', null)).toBe(
      '<pre><code>const x = **1**</code></pre>',
    )
  })

  it('falls back to the stored kind for a legacy heading (no # in body)', () => {
    expect(renderKbBlock('Title', 'heading', '{"level":1}')).toBe('<h1>Title</h1>')
  })

  it('renders plain prose as a paragraph', () => {
    expect(renderKbBlock('hello world', 'text', null)).toBe('<p>hello world</p>')
  })
})

describe('toEditableMarkdown', () => {
  it('up-converts a legacy heading to markdown-native "# " form', () => {
    expect(toEditableMarkdown('Title', 'heading', '{"level":3}')).toBe('### Title')
  })

  it('up-converts a legacy list to "- " bullets', () => {
    expect(toEditableMarkdown('one\ntwo', 'list', null)).toBe('- one\n- two')
  })

  it('up-converts a legacy checklist to "- [ ] " / "- [x] " items', () => {
    expect(toEditableMarkdown('- [ ] a\n- [x] b', 'checklist', null)).toBe('- [ ] a\n- [x] b')
  })

  it('wraps a legacy code block in ``` fences', () => {
    expect(toEditableMarkdown('const x = 1', 'code', null)).toBe('```\nconst x = 1\n```')
  })

  it('leaves already-markdown-native bodies unchanged', () => {
    expect(toEditableMarkdown('# Already', 'heading', '{"level":1}')).toBe('# Already')
  })

  it('round-trips a legacy heading through toEditableMarkdown → detectKind', () => {
    const editable = toEditableMarkdown('Title', 'heading', '{"level":2}')
    expect(detectKind(editable)).toEqual({ kind: 'heading', meta: '{"level":2}' })
  })
})
