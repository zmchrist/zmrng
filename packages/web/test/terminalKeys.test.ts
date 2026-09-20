import { describe, it, expect } from 'vitest'
import { TERMINAL_KEYS, ctrlSeq } from '../src/terminalKeys'

describe('terminalKeys', () => {
  it('offers Esc, Tab, a Ctrl modifier and the four arrows', () => {
    expect(TERMINAL_KEYS.map((k) => k.id)).toEqual([
      'esc',
      'tab',
      'ctrl',
      'up',
      'down',
      'left',
      'right',
    ])
    expect(TERMINAL_KEYS.find((k) => k.id === 'esc')?.seq).toBe('\x1b')
    expect(TERMINAL_KEYS.find((k) => k.id === 'up')?.seq).toBe('\x1b[A')
    // Ctrl is a modifier, not a sequence.
    expect(TERMINAL_KEYS.find((k) => k.id === 'ctrl')?.seq).toBeNull()
  })

  it('maps letters to their control code, case-insensitively', () => {
    expect(ctrlSeq('c')).toBe('\x03')
    expect(ctrlSeq('C')).toBe('\x03')
    expect(ctrlSeq('a')).toBe('\x01')
    expect(ctrlSeq('z')).toBe('\x1a')
  })

  it('maps the punctuation controls', () => {
    expect(ctrlSeq('[')).toBe('\x1b')
    expect(ctrlSeq(' ')).toBe('\x00')
    expect(ctrlSeq('\\')).toBe('\x1c')
  })

  it('passes anything it does not understand through unchanged', () => {
    expect(ctrlSeq('1')).toBe('1')
    expect(ctrlSeq('\x1b[A')).toBe('\x1b[A')
    expect(ctrlSeq('pasted text')).toBe('pasted text')
    expect(ctrlSeq('')).toBe('')
  })
})
