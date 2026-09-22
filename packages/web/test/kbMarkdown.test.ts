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

describe('renderPageMarkdown — extended inline conventions', () => {
  it('renders ~~strike~~ as <del>', () => {
    expect(renderPageMarkdown('a ~~b~~ c')).toBe('<p>a <del>b</del> c</p>')
  })

  it('renders ==highlight== as <mark>', () => {
    expect(renderPageMarkdown('a ==b== c')).toBe('<p>a <mark>b</mark> c</p>')
  })

  it('renders the allow-listed <u> tag as a real element', () => {
    expect(renderPageMarkdown('a <u>b</u> c')).toBe('<p>a <u>b</u> c</p>')
  })

  it('renders an allow-listed colored span, preserving the hex', () => {
    expect(renderPageMarkdown('<span style="color:#ff0000">red</span>')).toBe(
      '<p><span style="color:#ff0000">red</span></p>',
    )
  })

  it('renders an allow-listed colored mark, preserving the hex', () => {
    expect(renderPageMarkdown('<mark style="background:#ffff00">hi</mark>')).toBe(
      '<p><mark style="background:#ffff00">hi</mark></p>',
    )
  })

  it('renders an explicit <mark> tag as a real element', () => {
    expect(renderPageMarkdown('<mark>hi</mark>')).toBe('<p><mark>hi</mark></p>')
  })
})

describe('renderPageMarkdown — ordered lists', () => {
  it('groups a run of "1." lines into one <ol>, stripping the markers', () => {
    expect(renderPageMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>')
  })

  it('accepts the "1)" marker style too', () => {
    expect(renderPageMarkdown('1) one\n2) two')).toBe('<ol><li>one</li><li>two</li></ol>')
  })

  it('separates an ordered list from surrounding paragraphs', () => {
    expect(renderPageMarkdown('before\n1. one\n2. two\nafter')).toBe(
      '<p>before</p><ol><li>one</li><li>two</li></ol><p>after</p>',
    )
  })

  it('leaves bullet and checklist detection untouched', () => {
    expect(renderPageMarkdown('- one')).toBe('<ul><li>one</li></ul>')
    expect(renderPageMarkdown('- [ ] one')).toContain('kb-checklist')
  })

  it('does not disturb paragraph grouping for a number that is not at line start', () => {
    expect(renderPageMarkdown('costs 1. fifty\nand more')).toBe(
      '<p>costs 1. fifty<br />and more</p>',
    )
  })

  it('does not treat "1.5" (no space after the dot) as a list item', () => {
    expect(renderPageMarkdown('1.5 million')).toBe('<p>1.5 million</p>')
  })
})

describe('renderPageMarkdown — links', () => {
  it('renders [text](https://…) as an anchor with rel="noopener noreferrer"', () => {
    expect(renderPageMarkdown('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer">site</a></p>',
    )
  })

  it('accepts http, mailto, a same-document anchor and a relative path', () => {
    expect(renderPageMarkdown('[a](http://x.test)')).toContain('href="http://x.test"')
    expect(renderPageMarkdown('[a](mailto:x@y.test)')).toContain('href="mailto:x@y.test"')
    expect(renderPageMarkdown('[a](#anchor)')).toContain('href="#anchor"')
    expect(renderPageMarkdown('[a](/local/page)')).toContain('href="/local/page"')
  })

  it('formats inline markup inside the link label', () => {
    expect(renderPageMarkdown('[**bold**](https://x.test)')).toBe(
      '<p><a href="https://x.test" rel="noopener noreferrer"><strong>bold</strong></a></p>',
    )
  })
})

describe('renderPageMarkdown — security: the allow-list must not widen', () => {
  const literal = (body: string, needle: string): void => {
    const html = renderPageMarkdown(body)
    expect(html).toContain(needle)
  }

  it('keeps the pinned <script> case escaped', () => {
    expect(renderPageMarkdown('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  it('rejects an extra attribute on an allow-listed tag', () => {
    literal('<span onclick="x()">a</span>', '&lt;span onclick=')
    literal('<u class="x">a</u>', '&lt;u class=')
    literal('<mark id="x">a</mark>', '&lt;mark id=')
  })

  it('rejects a named color (only #RRGGBB is allowed)', () => {
    literal('<span style="color:red">a</span>', '&lt;span style=&quot;color:red&quot;&gt;')
  })

  it('rejects a 3-digit hex', () => {
    literal('<span style="color:#fff">a</span>', '&lt;span style=&quot;color:#fff&quot;&gt;')
  })

  it('rejects an extra CSS declaration smuggled after the hex', () => {
    literal('<span style="color:#ff0000;position:fixed">a</span>', '&lt;span style=')
  })

  it('rejects a non-allow-listed tag', () => {
    literal('<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;')
  })

  it('leaves a javascript: link as literal text', () => {
    expect(renderPageMarkdown('[x](javascript:alert(1))')).not.toContain('<a ')
    expect(renderPageMarkdown('[x](javascript:alert(1))')).toContain('[x](javascript:alert(1')
  })

  it('leaves a data: link as literal text', () => {
    expect(renderPageMarkdown('[x](data:text/html,<b>hi</b>)')).not.toContain('<a ')
  })

  it('rejects a scheme broken up by whitespace or control characters', () => {
    expect(renderPageMarkdown('[x](java\tscript:alert(1))')).not.toContain('<a ')
    expect(renderPageMarkdown('[x](  javascript:alert(1))')).not.toContain('<a ')
  })

  it('rejects a protocol-relative URL rather than treating it as a relative path', () => {
    expect(renderPageMarkdown('[x](//evil.example.com)')).not.toContain('<a ')
  })

  it('escapes quotes inside an accepted href so it cannot break out of the attribute', () => {
    expect(renderPageMarkdown('[x](https://a.test/"onmouseover="alert(1))')).not.toContain(
      'onmouseover="alert',
    )
  })
})
