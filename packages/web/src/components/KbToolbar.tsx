import { useState } from 'react'
import styles from './KbToolbar.module.css'
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
} from '../kbEdits'
import type { SelectionEdit } from '../kbEdits'

interface Props {
  /** The editor's current text (the body draft). */
  value: string
  /** The textarea's current selection range within `value`. */
  selection: { start: number; end: number }
  /** Apply a computed edit — the caller writes it back and restores the selection. */
  onApply: (edit: SelectionEdit) => void
  /** Put focus back on the editor (used when Escape closes a popover). */
  onRequestFocus?: () => void
}

type Popover = 'heading' | 'textColor' | 'highlight'

/** One pure transform over `(text, selectionStart, selectionEnd)`. */
type Edit = (text: string, s: number, e: number) => SelectionEdit

/**
 * The persistent, Google-Docs-style formatting bar above the KB page editor.
 * Purely presentational: every control turns a click into one of `kbEdits.ts`'s
 * pure transforms and hands the result to `onApply` — no editor state lives here
 * beyond which popover is open.
 *
 * CRITICAL: every button and swatch default-prevents its `mousedown`. KB edit
 * mode is focus-scoped (the textarea's `onBlur` leaves it), so a mousedown that
 * moved focus would unmount the editor AND this bar before the click landed —
 * the toolbar would be 100% non-functional. A default-prevented mousedown never
 * moves focus, so the textarea keeps both focus and selection. This is also why
 * the heading and color pickers are hand-rolled button popovers rather than a
 * native `<select>` / `<input type="color">`, which cannot open at all without
 * taking focus. `KbToolbar.test.tsx` pins the guard.
 */
export function KbToolbar({ value, selection, onApply, onRequestFocus }: Props) {
  const [open, setOpen] = useState<Popover | null>(null)

  /** Keep focus (and therefore the selection, and therefore edit mode) on the textarea. */
  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

  const apply = (edit: Edit): void => {
    onApply(edit(value, selection.start, selection.end))
    setOpen(null)
  }

  const toggle = (popover: Popover): void => setOpen((cur) => (cur === popover ? null : popover))

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape' || open === null) return
    e.preventDefault()
    e.stopPropagation()
    setOpen(null)
    onRequestFocus?.()
  }

  const action = (label: string, edit: Edit, node: React.ReactNode) => (
    <button
      type="button"
      className={styles.btn}
      title={label}
      aria-label={label}
      onMouseDown={keepFocus}
      onClick={() => apply(edit)}
    >
      {node}
    </button>
  )

  const trigger = (label: string, popover: Popover, node: React.ReactNode) => (
    <button
      type="button"
      className={styles.btn}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open === popover}
      onMouseDown={keepFocus}
      onClick={() => toggle(popover)}
    >
      {node}
      <Chevron />
    </button>
  )

  const swatches = (
    colors: readonly { name: string; hex: string }[],
    edit: (hex: string) => Edit,
    clear: Edit,
    label: string,
  ) => (
    <div className={styles.popover} role="menu" aria-label={label}>
      <div className={styles.swatches}>
        {colors.map((c) => (
          <button
            key={c.hex}
            type="button"
            role="menuitem"
            className={styles.swatch}
            // A document color, not a theme color: it is written into the page
            // body verbatim, so it is genuinely dynamic data (like the status
            // pills' statusColor()) rather than a hard-coded design value.
            style={{ background: c.hex }}
            title={c.name}
            aria-label={c.name}
            onMouseDown={keepFocus}
            onClick={() => apply(edit(c.hex))}
          />
        ))}
      </div>
      <button
        type="button"
        role="menuitem"
        className={styles.menuItem}
        onMouseDown={keepFocus}
        onClick={() => apply(clear)}
      >
        None
      </button>
    </div>
  )

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Formatting" onKeyDown={onKeyDown}>
      <div className={styles.group}>
        {action('Bold', (t, s, e) => toggleWrap(t, s, e, '**', '**'), <b aria-hidden>B</b>)}
        {action('Italic', (t, s, e) => toggleWrap(t, s, e, '*', '*'), <i aria-hidden>I</i>)}
        {action(
          'Underline',
          (t, s, e) => toggleWrap(t, s, e, '<u>', '</u>'),
          <u aria-hidden>U</u>,
        )}
        {action(
          'Strikethrough',
          (t, s, e) => toggleWrap(t, s, e, '~~', '~~'),
          <s aria-hidden>S</s>,
        )}
      </div>

      <div className={styles.group}>
        <div className={styles.menuWrap}>
          {trigger('Heading style', 'heading', <span className={styles.glyph}>H</span>)}
          {open === 'heading' && (
            <div className={styles.popover} role="menu" aria-label="Heading style">
              {HEADING_LEVELS.map((h) => (
                <button
                  key={h.level}
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onMouseDown={keepFocus}
                  onClick={() => apply((t, s, e) => applyHeading(t, s, e, h.level))}
                >
                  {h.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.group}>
        {action('Bulleted list', (t, s, e) => toggleLinePrefix(t, s, e, '- '), <BulletIcon />)}
        {action('Numbered list', toggleOrderedList, <OrderedIcon />)}
        {action(
          'Checklist',
          (t, s, e) => toggleLinePrefix(t, s, e, '- [ ] '),
          <ChecklistIcon />,
        )}
      </div>

      <div className={styles.group}>{action('Insert link', applyLink, <LinkIcon />)}</div>

      <div className={styles.group}>
        <div className={styles.menuWrap}>
          {trigger('Text color', 'textColor', <span className={styles.glyph}>A</span>)}
          {open === 'textColor' &&
            swatches(
              KB_TEXT_COLORS,
              (hex) => (t, s, e) => applyTextColor(t, s, e, hex),
              removeTextColor,
              'Text color',
            )}
        </div>
        <div className={styles.menuWrap}>
          {trigger('Highlight color', 'highlight', <HighlightIcon />)}
          {open === 'highlight' &&
            swatches(
              KB_HIGHLIGHT_COLORS,
              (hex) => (t, s, e) => applyHighlight(t, s, e, hex),
              removeHighlight,
              'Highlight color',
            )}
        </div>
      </div>
    </div>
  )
}

// ---- icons (inline SVG, `currentColor`, matching KbView's existing set) ----

function Chevron() {
  return (
    <svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function BulletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="3" cy="4" r="1" fill="currentColor" />
      <circle cx="3" cy="8" r="1" fill="currentColor" />
      <circle cx="3" cy="12" r="1" fill="currentColor" />
    </svg>
  )
}

function OrderedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M2 2.5h1V6M1.6 9.2c.2-.5.7-.8 1.2-.6.6.2.7.9.3 1.3L1.7 11.5H3.2"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChecklistIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M7 4h8M7 11h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M1.5 4l1.2 1.2L5 2.8M1.5 11l1.2 1.2L5 9.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6.5 9.5a2.5 2.5 0 0 1 0-3.5l2-2a2.5 2.5 0 0 1 3.5 3.5l-1 1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M9.5 6.5a2.5 2.5 0 0 1 0 3.5l-2 2A2.5 2.5 0 0 1 4 8.5l1-1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function HighlightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.5 2.5l4 4-5 5H5l-1.5-1.5 6-7.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M2 14h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
