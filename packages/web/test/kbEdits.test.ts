import { describe, it, expect } from 'vitest'
import {
  HEADING_LEVELS,
  KB_HIGHLIGHT_COLORS,
  KB_TEXT_COLORS,
  applyHeading,
  applyHighlight,
  applyLink,
  applyTextColor,
  removeHighlight,
  removeTextColor,
  toggleLinePrefix,
  toggleOrderedList,
  toggleWrap,
} from '../src/kbEdits'
import { renderPageMarkdown } from '../src/kbMarkdown'

describe('toggleWrap', () => {
  it('wraps the selection and keeps the returned selection spanning the original text', () => {
    const out = toggleWrap('hello world', 0, 5, '**', '**')
    expect(out.text).toBe('**hello** world')
    expect(out.text.slice(out.selStart, out.selEnd)).toBe('hello')
  })

  it('supports every inline marker the toolbar emits', () => {
    expect(toggleWrap('abc', 0, 3, '*', '*').text).toBe('*abc*')
    expect(toggleWrap('abc', 0, 3, '~~', '~~').text).toBe('~~abc~~')
    expect(toggleWrap('abc', 0, 3, '<u>', '</u>').text).toBe('<u>abc</u>')
  })

  it('strips the markers when they sit immediately OUTSIDE the selection', () => {
    const out = toggleWrap('**hello** world', 2, 7, '**', '**')
    expect(out.text).toBe('hello world')
    expect(out.text.slice(out.selStart, out.selEnd)).toBe('hello')
  })

  it('strips the markers when the selection INCLUDES them', () => {
    const out = toggleWrap('**hello** world', 0, 9, '**', '**')
    expect(out.text).toBe('hello world')
    expect(out.text.slice(out.selStart, out.selEnd)).toBe('hello')
  })

  it('is idempotent over two calls (the toggle-off contract)', () => {
    const once = toggleWrap('hello world', 0, 5, '**', '**')
    const twice = toggleWrap(once.text, once.selStart, once.selEnd, '**', '**')
    expect(twice.text).toBe('hello world')
    expect(twice.selStart).toBe(0)
    expect(twice.selEnd).toBe(5)
  })

  it('inserts both markers with an empty selection and leaves the caret between them', () => {
    const out = toggleWrap('ab', 1, 1, '**', '**')
    expect(out.text).toBe('a****b')
    expect(out.selStart).toBe(3)
    expect(out.selEnd).toBe(3)
  })
})

describe('toggleLinePrefix', () => {
  it('prefixes EVERY line a multi-line selection touches', () => {
    const out = toggleLinePrefix('one\ntwo', 0, 7, '- ')
    expect(out.text).toBe('- one\n- two')
    expect(out.text.slice(out.selStart, out.selEnd)).toBe('one\n- two')
  })

  it('applies to the caret line even with an empty selection', () => {
    expect(toggleLinePrefix('one\ntwo', 5, 5, '- ').text).toBe('one\n- two')
  })

  it('toggles every line off when they all already carry the prefix', () => {
    expect(toggleLinePrefix('- one\n- two', 0, 11, '- ').text).toBe('one\ntwo')
  })

  it('replaces a competing list marker instead of stacking on top of it', () => {
    expect(toggleLinePrefix('- one', 0, 5, '- [ ] ').text).toBe('- [ ] one')
    expect(toggleLinePrefix('- [ ] one', 0, 9, '- ').text).toBe('- one')
    expect(toggleLinePrefix('1. one', 0, 6, '- ').text).toBe('- one')
  })

  it('toggles a checklist prefix off', () => {
    expect(toggleLinePrefix('- [ ] a', 0, 7, '- [ ] ').text).toBe('a')
  })
})

describe('toggleOrderedList', () => {
  it('numbers the touched lines sequentially from one', () => {
    const out = toggleOrderedList('one\ntwo\nthree', 0, 13)
    expect(out.text).toBe('1. one\n2. two\n3. three')
  })

  it('toggles an already-numbered run off', () => {
    expect(toggleOrderedList('1. one\n2. two', 0, 13).text).toBe('one\ntwo')
  })

  it('renumbers from one when the source numbering is wrong', () => {
    expect(toggleOrderedList('a\nb', 0, 3).text).toBe('1. a\n2. b')
  })

  it('replaces a bullet marker rather than stacking on it', () => {
    expect(toggleOrderedList('- a', 0, 3).text).toBe('1. a')
  })
})

describe('applyHeading', () => {
  it('applies the requested level to the caret line', () => {
    expect(applyHeading('Title', 0, 0, 2).text).toBe('## Title')
  })

  it('replaces an existing heading of a different level', () => {
    expect(applyHeading('# Title', 0, 0, 3).text).toBe('### Title')
  })

  it('strips the heading at level 0 ("Normal text")', () => {
    expect(applyHeading('### Title', 0, 0, 0).text).toBe('Title')
  })

  it('applies to every line a multi-line selection touches', () => {
    expect(applyHeading('a\nb', 0, 3, 1).text).toBe('# a\n# b')
  })
})

describe('applyLink', () => {
  it('uses the selection as the label and leaves the caret on the url placeholder', () => {
    const out = applyLink('click here', 0, 5)
    expect(out.text).toBe('[click](url) here')
    expect(out.text.slice(out.selStart, out.selEnd)).toBe('url')
  })

  it('inserts the full skeleton with an empty selection, selecting the label', () => {
    const out = applyLink('', 0, 0)
    expect(out.text).toBe('[text](url)')
    expect(out.text.slice(out.selStart, out.selEnd)).toBe('text')
  })
})

describe('applyTextColor / removeTextColor', () => {
  it('emits exactly the convention the renderer parses', () => {
    const out = applyTextColor('abc', 0, 3, '#ff0000')
    expect(out.text).toBe('<span style="color:#ff0000">abc</span>')
    expect(renderPageMarkdown(out.text)).toBe('<p><span style="color:#ff0000">abc</span></p>')
    expect(out.text.slice(out.selStart, out.selEnd)).toBe('abc')
  })

  it('toggles the same color off', () => {
    const on = applyTextColor('abc', 0, 3, '#ff0000')
    const off = applyTextColor(on.text, on.selStart, on.selEnd, '#ff0000')
    expect(off.text).toBe('abc')
  })

  it('replaces a different color rather than nesting spans', () => {
    const red = applyTextColor('abc', 0, 3, '#ff0000')
    const blue = applyTextColor(red.text, red.selStart, red.selEnd, '#0000ff')
    expect(blue.text).toBe('<span style="color:#0000ff">abc</span>')
  })

  it('removeTextColor strips an existing span and is a no-op otherwise', () => {
    const red = applyTextColor('abc', 0, 3, '#ff0000')
    expect(removeTextColor(red.text, red.selStart, red.selEnd).text).toBe('abc')
    expect(removeTextColor('abc', 0, 3).text).toBe('abc')
  })
})

describe('applyHighlight / removeHighlight', () => {
  it('emits a bare == highlight when no color is given', () => {
    const out = applyHighlight('abc', 0, 3, null)
    expect(out.text).toBe('==abc==')
    expect(renderPageMarkdown(out.text)).toBe('<p><mark>abc</mark></p>')
  })

  it('emits a colored <mark> the renderer parses', () => {
    const out = applyHighlight('abc', 0, 3, '#ffff00')
    expect(out.text).toBe('<mark style="background:#ffff00">abc</mark>')
    expect(renderPageMarkdown(out.text)).toBe(
      '<p><mark style="background:#ffff00">abc</mark></p>',
    )
  })

  it('toggles the same highlight off and replaces a different one', () => {
    const yellow = applyHighlight('abc', 0, 3, '#ffff00')
    expect(applyHighlight(yellow.text, yellow.selStart, yellow.selEnd, '#ffff00').text).toBe('abc')
    const green = applyHighlight(yellow.text, yellow.selStart, yellow.selEnd, '#00ff00')
    expect(green.text).toBe('<mark style="background:#00ff00">abc</mark>')
  })

  it('removeHighlight strips both the bare and the colored form', () => {
    const bare = applyHighlight('abc', 0, 3, null)
    expect(removeHighlight(bare.text, bare.selStart, bare.selEnd).text).toBe('abc')
    const colored = applyHighlight('abc', 0, 3, '#ffff00')
    expect(removeHighlight(colored.text, colored.selStart, colored.selEnd).text).toBe('abc')
  })
})

describe('palettes', () => {
  it('are non-empty and every entry is a 6-digit hex the renderer allow-list accepts', () => {
    expect(KB_TEXT_COLORS.length).toBeGreaterThan(0)
    expect(KB_HIGHLIGHT_COLORS.length).toBeGreaterThan(0)
    for (const c of [...KB_TEXT_COLORS, ...KB_HIGHLIGHT_COLORS]) {
      expect(c.hex).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(c.name.length).toBeGreaterThan(0)
    }
  })

  it('every text-color palette entry actually renders as a span (never literal text)', () => {
    for (const c of KB_TEXT_COLORS) {
      const edit = applyTextColor('x', 0, 1, c.hex)
      expect(renderPageMarkdown(edit.text)).toContain(`<span style="color:${c.hex}">`)
    }
  })

  it('offers Normal text plus headings 1-3', () => {
    expect(HEADING_LEVELS.map((h) => h.level)).toEqual([0, 1, 2, 3])
  })
})
