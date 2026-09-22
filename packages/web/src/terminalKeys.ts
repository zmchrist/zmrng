/**
 * On-screen key bar for the phone terminal. A soft keyboard has no Esc, Tab,
 * Ctrl or arrows, which makes a shell (and anything curses-like) unusable — this
 * module holds the escape sequences those buttons send, plus the Ctrl/Alt
 * modifier mappings, as pure data so `Terminal.tsx` stays untestable glue only.
 */

/** A one-shot modifier armed by a bar button and consumed by the next chunk. */
export type TerminalMod = 'ctrl' | 'alt'

export interface TerminalKey {
  id: string
  label: string
  /** The bytes to send, or null for a sticky modifier (see `mod`). */
  seq: string | null
  /** Set when the key arms a one-shot modifier instead of sending bytes. */
  mod?: TerminalMod
  /** Set when holding the key should repeat its sequence (the arrows). */
  repeat?: boolean
}

/** Row 1 — always visible: the keys a shell needs on every line. */
export const TERMINAL_KEYS: ReadonlyArray<TerminalKey> = [
  { id: 'esc', label: 'Esc', seq: '\x1b' },
  { id: 'tab', label: 'Tab', seq: '\t' },
  { id: 'ctrl', label: 'Ctrl', seq: null, mod: 'ctrl' },
  { id: 'alt', label: 'Alt', seq: null, mod: 'alt' },
  { id: 'up', label: '↑', seq: '\x1b[A', repeat: true },
  { id: 'down', label: '↓', seq: '\x1b[B', repeat: true },
  { id: 'left', label: '←', seq: '\x1b[D', repeat: true },
  { id: 'right', label: '→', seq: '\x1b[C', repeat: true },
  { id: 'pipe', label: '|', seq: '|' },
  { id: 'tilde', label: '~', seq: '~' },
  { id: 'slash', label: '/', seq: '/' },
  { id: 'dash', label: '-', seq: '-' },
  { id: 'underscore', label: '_', seq: '_' },
]

/**
 * Row 2 — collapsed by default: navigation and the function keys. These are
 * xterm's own NORMAL-mode sequences, matching the normal-mode choice the row-1
 * arrows already make.
 */
export const TERMINAL_KEYS_EXTRA: ReadonlyArray<TerminalKey> = [
  { id: 'home', label: 'Home', seq: '\x1b[H' },
  { id: 'end', label: 'End', seq: '\x1b[F' },
  { id: 'pgup', label: 'PgUp', seq: '\x1b[5~' },
  { id: 'pgdn', label: 'PgDn', seq: '\x1b[6~' },
  { id: 'f1', label: 'F1', seq: '\x1bOP' },
  { id: 'f2', label: 'F2', seq: '\x1bOQ' },
  { id: 'f3', label: 'F3', seq: '\x1bOR' },
  { id: 'f4', label: 'F4', seq: '\x1bOS' },
  { id: 'f5', label: 'F5', seq: '\x1b[15~' },
  { id: 'f6', label: 'F6', seq: '\x1b[17~' },
  { id: 'f7', label: 'F7', seq: '\x1b[18~' },
  { id: 'f8', label: 'F8', seq: '\x1b[19~' },
  { id: 'f9', label: 'F9', seq: '\x1b[20~' },
  { id: 'f10', label: 'F10', seq: '\x1b[21~' },
  { id: 'f11', label: 'F11', seq: '\x1b[23~' },
  { id: 'f12', label: 'F12', seq: '\x1b[24~' },
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

/**
 * Apply a sticky Alt to one chunk of typed input: the standard Meta encoding is
 * an ESC prefix. Like `ctrlSeq` this only transforms a single character and
 * passes anything longer through unchanged, so arming Alt can never corrupt a
 * paste or an escape sequence.
 */
export function altSeq(data: string): string {
  if (data.length !== 1) return data
  return '\x1b' + data
}

/**
 * Compose whichever one-shot modifiers are armed over one chunk of input: Ctrl
 * first (so ctrl+c becomes 0x03), then the Alt ESC prefix — ctrl+alt+c →
 * `\x1b\x03`. Returns the input untouched when neither is armed.
 */
export function modSeq(data: string, mods: { ctrl: boolean; alt: boolean }): string {
  let out = data
  if (mods.ctrl) out = ctrlSeq(out)
  if (mods.alt) out = altSeq(out)
  return out
}
