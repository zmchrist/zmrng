import { describe, it, expect } from 'vitest'
import { renderPageMarkdown, escapeHtml, toggleChecklistLine } from '../src/kbMarkdown'

describe('escapeHtml', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('renderPageMarkdown — paragraphs', () => {
  it('renders consecutive lines as one paragraph with <br /> between them', () => {
    expect(renderPageMarkdown('line one\nline two')).toBe('<p>line one<br />line two</p>')
  })

  it('splits into separate paragraphs on a blank line', () => {
    expect(renderPageMarkdown('line one\n\nsecond para')).toBe(
      '<p>line one</p><p>second para</p>',
    )
  })

  it('escapes HTML in a paragraph (no injection)', () => {
    expect(renderPageMarkdown('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  it('renders inline bold, italic, and code spans', () => {
    expect(renderPageMarkdown('a **b** and *c* and `d`')).toBe(
      '<p>a <strong>b</strong> and <em>c</em> and <code>d</code></p>',
    )
  })

  it('renders an empty body as no output', () => {
    expect(renderPageMarkdown('')).toBe('')
  })
})

describe('renderPageMarkdown — headings', () => {
  it('renders each #..###### line as its own heading, stripping the leading hashes', () => {
    expect(renderPageMarkdown('# Title')).toBe('<h1>Title</h1>')
    expect(renderPageMarkdown('###### Deep')).toBe('<h6>Deep</h6>')
  })

  it('does not treat "#tag" (no space) as a heading', () => {
    expect(renderPageMarkdown('#tag not a heading')).toBe('<p>#tag not a heading</p>')
  })

  it('separates a heading from surrounding paragraphs', () => {
    expect(renderPageMarkdown('intro\n# Title\nbody')).toBe(
      '<p>intro</p><h1>Title</h1><p>body</p>',
    )
  })
})

describe('renderPageMarkdown — fenced code', () => {
  it('renders a fenced block verbatim, without inline formatting', () => {
    expect(renderPageMarkdown('```\nconst x = **1**\n```')).toBe(
      '<pre><code>const x = **1**</code></pre>',
    )
  })

  it('ignores a language tag on the opening fence', () => {
    expect(renderPageMarkdown('```ts\nconst x = 1\n```')).toBe('<pre><code>const x = 1</code></pre>')
  })

  it('preserves multiple lines and blank lines inside the fence', () => {
    expect(renderPageMarkdown('```\nline1\n\nline2\n```')).toBe(
      '<pre><code>line1\n\nline2</code></pre>',
    )
  })

  it('does not close-hang forever on an unterminated fence — renders to end of body', () => {
    expect(renderPageMarkdown('```\nunterminated')).toBe('<pre><code>unterminated</code></pre>')
  })
})

describe('renderPageMarkdown — lists', () => {
  it('groups consecutive bullet lines into one <ul>, stripping markers', () => {
    expect(renderPageMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>')
  })

  it('separates a list from surrounding paragraphs', () => {
    expect(renderPageMarkdown('before\n- one\n- two\nafter')).toBe(
      '<p>before</p><ul><li>one</li><li>two</li></ul><p>after</p>',
    )
  })
})

describe('renderPageMarkdown — checklists', () => {
  it('groups consecutive checklist lines into an interactive <ul>, checked from - [x]', () => {
    expect(renderPageMarkdown('- [ ] todo\n- [x] done')).toBe(
      '<ul class="kb-checklist">' +
        '<li><input type="checkbox" data-line="0" /> todo</li>' +
        '<li><input type="checkbox" data-line="1" checked /> done</li>' +
        '</ul>',
    )
  })

  it('carries the SOURCE line index on data-line even when the checklist is not at line 0', () => {
    expect(renderPageMarkdown('intro\n- [ ] a\n- [ ] b')).toBe(
      '<p>intro</p><ul class="kb-checklist">' +
        '<li><input type="checkbox" data-line="1" /> a</li>' +
        '<li><input type="checkbox" data-line="2" /> b</li>' +
        '</ul>',
    )
  })

  it('does not mistake a checklist run for a plain list', () => {
    expect(renderPageMarkdown('- [ ] item')).not.toContain('<ul><li>')
  })
})

describe('renderPageMarkdown — mixed document', () => {
  it('groups a full page of headings/paragraphs/lists/checklists/code in source order', () => {
    const body = [
      '# Notes',
      'Some intro text.',
      '',
      '- one',
      '- two',
      '',
      '- [ ] task a',
      '- [x] task b',
      '',
      '```',
      'code here',
      '```',
    ].join('\n')
    expect(renderPageMarkdown(body)).toBe(
      '<h1>Notes</h1>' +
        '<p>Some intro text.</p>' +
        '<ul><li>one</li><li>two</li></ul>' +
        '<ul class="kb-checklist">' +
        '<li><input type="checkbox" data-line="6" /> task a</li>' +
        '<li><input type="checkbox" data-line="7" checked /> task b</li>' +
        '</ul>' +
        '<pre><code>code here</code></pre>',
    )
  })
})

describe('toggleChecklistLine', () => {
  it('flips an unchecked line to checked', () => {
    expect(toggleChecklistLine('- [ ] a\n- [ ] b', 0)).toBe('- [x] a\n- [ ] b')
  })

  it('flips a checked line to unchecked', () => {
    expect(toggleChecklistLine('- [x] a\n- [ ] b', 0)).toBe('- [ ] a\n- [ ] b')
  })

  it('only touches the targeted line, leaving the rest of the body untouched', () => {
    expect(toggleChecklistLine('intro\n- [ ] a\n- [ ] b\noutro', 2)).toBe(
      'intro\n- [ ] a\n- [x] b\noutro',
    )
  })

  it('is a no-op for an out-of-range line', () => {
    const body = '- [ ] a'
    expect(toggleChecklistLine(body, 5)).toBe(body)
    expect(toggleChecklistLine(body, -1)).toBe(body)
  })

  it('is a no-op for a line that is not a checklist item', () => {
    const body = 'just a sentence'
    expect(toggleChecklistLine(body, 0)).toBe(body)
  })
})
