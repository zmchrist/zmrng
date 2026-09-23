import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KbToolbar } from '../src/components/KbToolbar'
import { KB_TEXT_COLORS } from '../src/kbEdits'
import type { SelectionEdit } from '../src/kbEdits'

const onApply = vi.fn<(edit: SelectionEdit) => void>()

beforeEach(() => {
  onApply.mockReset()
})

/** Render the toolbar over the text `hello world` with `hello` selected. */
function renderToolbar(value = 'hello world', selection = { start: 0, end: 5 }) {
  render(<KbToolbar value={value} selection={selection} onApply={onApply} />)
}

const CONTROLS = [
  'Bold',
  'Italic',
  'Underline',
  'Strikethrough',
  'Heading style',
  'Bulleted list',
  'Numbered list',
  'Checklist',
  'Insert link',
  'Text color',
  'Highlight color',
]

describe('<KbToolbar>', () => {
  it('renders all eleven controls with accessible names', () => {
    renderToolbar()
    for (const name of CONTROLS) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
  })

  it('default-prevents mousedown so the textarea never loses focus (edit mode survives)', () => {
    renderToolbar()
    for (const name of CONTROLS) {
      // A default-prevented mousedown never moves focus, so the editor's
      // onBlur (which exits edit mode) cannot fire. Dropping this guard would
      // silently kill the whole feature — hence an explicit assertion.
      expect(fireEvent.mouseDown(screen.getByRole('button', { name }))).toBe(false)
    }
  })

  it('applies bold to the current selection', () => {
    renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))
    expect(onApply).toHaveBeenCalledWith({ text: '**hello** world', selStart: 2, selEnd: 7 })
  })

  it('applies a bulleted list to the caret line', () => {
    renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Bulleted list' }))
    expect(onApply.mock.calls[0][0].text).toBe('- hello world')
  })

  it('opens the heading popover on click and applies the chosen level', () => {
    renderToolbar('Title', { start: 0, end: 0 })
    const trigger = screen.getByRole('button', { name: 'Heading style' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menuitem', { name: 'Heading 2' })).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    const item = screen.getByRole('menuitem', { name: 'Heading 2' })
    expect(fireEvent.mouseDown(item)).toBe(false)
    fireEvent.click(item)
    expect(onApply).toHaveBeenCalledWith({ text: '## Title', selStart: 3, selEnd: 3 })
    // Choosing an item closes the popover.
    expect(screen.queryByRole('menuitem', { name: 'Heading 2' })).not.toBeInTheDocument()
  })

  it('applies a palette text color and removes it via the "None" entry', () => {
    const first = KB_TEXT_COLORS[0]
    const { rerender } = render(
      <KbToolbar value="hello world" selection={{ start: 0, end: 5 }} onApply={onApply} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Text color' }))
    fireEvent.click(screen.getByRole('menuitem', { name: first.name }))
    const colored = `<span style="color:${first.hex}">hello</span> world`
    expect(onApply.mock.calls[0][0].text).toBe(colored)

    onApply.mockReset()
    const start = colored.indexOf('hello')
    rerender(
      <KbToolbar value={colored} selection={{ start, end: start + 5 }} onApply={onApply} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Text color' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'None' }))
    expect(onApply.mock.calls[0][0].text).toBe('hello world')
  })

  it('applies a highlight color', () => {
    renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Highlight color' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Yellow' }))
    expect(onApply.mock.calls[0][0].text).toBe(
      '<mark style="background:#fff275">hello</mark> world',
    )
  })

  it('closes an open popover on Escape and asks for editor focus back', () => {
    const onRequestFocus = vi.fn()
    render(
      <KbToolbar
        value="hello"
        selection={{ start: 0, end: 5 }}
        onApply={onApply}
        onRequestFocus={onRequestFocus}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Heading style' }))
    expect(screen.getByRole('menu', { name: 'Heading style' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Heading style' })).not.toBeInTheDocument()
    expect(onRequestFocus).toHaveBeenCalled()
  })
})
