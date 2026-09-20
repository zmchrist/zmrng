/**
 * On-screen key bar for the phone terminal. A soft keyboard has no Esc, Tab,
 * Ctrl or arrows, which makes a shell (and anything curses-like) unusable — this
 * module holds the escape sequences those buttons send, plus the Ctrl modifier
 * mapping, as pure data so `Terminal.tsx` stays untestable glue only.
 */
export interface TerminalKey {
  id: string
  label: string
  /** The bytes to send, or null for the sticky Ctrl modifier. */
  seq: string | null
}

export const TERMINAL_KEYS: ReadonlyArray<TerminalKey> = [
  { id: 'esc', label: 'Esc', seq: '\x1b' },
  { id: 'tab', label: 'Tab', seq: '\t' },
  { id: 'ctrl', label: 'Ctrl', seq: null },
  { id: 'up', label: '↑', seq: '\x1b[A' },
  { id: 'down', label: '↓', seq: '\x1b[B' },
  { id: 'left', label: '←', seq: '\x1b[D' },
  { id: 'right', label: '→', seq: '\x1b[C' },
]

/**
 * Apply a sticky Ctrl to one chunk of typed input. Letters map to their control
 * code (ctrl+c → 0x03); the documented punctuation controls map too. Anything
 * else (a multi-byte paste, an already-escaped sequence) passes through
 * unchanged, so arming Ctrl can never corrupt input it doesn't understand.
 */
export function ctrlSeq(data: string): string {
  if (data.length !== 1) return data
  const ch = data.toLowerCase()
  const code = ch.charCodeAt(0)
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96) // a-z → 0x01-0x1a
  switch (ch) {
    case '@':
    case ' ':
      return '\x00'
    case '[':
      return '\x1b'
    case '\\':
      return '\x1c'
    case ']':
      return '\x1d'
    case '^':
      return '\x1e'
    case '_':
    case '?':
      return '\x1f'
    default:
      return data
  }
}
