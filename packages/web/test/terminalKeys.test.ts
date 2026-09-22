import { describe, it, expect } from 'vitest'
import {
  TERMINAL_KEYS,
  TERMINAL_KEYS_EXTRA,
  altSeq,
  ctrlSeq,
  modSeq,
} from '../src/terminalKeys'

describe('terminalKeys', () => {
  it('offers Esc, Tab, the two modifiers, the arrows and the shell symbols', () => {
    expect(TERMINAL_KEYS.map((k) => k.id)).toEqual([
      'esc',
      'tab',
      'ctrl',
      'alt',
      'up',
      'down',
      'left',
      'right',
      'pipe',
      'tilde',
      'slash',
      'dash',
      'underscore',
    ])
    // Existing ids and sequences are unchanged — nothing importing them breaks.
    expect(TERMINAL_KEYS.find((k) => k.id === 'esc')?.seq).toBe('\x1b')
    expect(TERMINAL_KEYS.find((k) => k.id === 'tab')?.seq).toBe('\t')
    expect(TERMINAL_KEYS.find((k) => k.id === 'up')?.seq).toBe('\x1b[A')
    expect(TERMINAL_KEYS.find((k) => k.id === 'down')?.seq).toBe('\x1b[B')
    expect(TERMINAL_KEYS.find((k) => k.id === 'left')?.seq).toBe('\x1b[D')
    expect(TERMINAL_KEYS.find((k) => k.id === 'right')?.seq).toBe('\x1b[C')
  })

  it('marks the modifiers with a mod and a null seq', () => {
    const ctrl = TERMINAL_KEYS.find((k) => k.id === 'ctrl')
    const alt = TERMINAL_KEYS.find((k) => k.id === 'alt')
    expect(ctrl?.seq).toBeNull()
    expect(ctrl?.mod).toBe('ctrl')
    expect(alt?.seq).toBeNull()
    expect(alt?.mod).toBe('alt')
    // Only the modifiers have a null seq.
    expect(TERMINAL_KEYS.filter((k) => k.seq === null).map((k) => k.id)).toEqual(['ctrl', 'alt'])
  })

  it('marks only the arrows as hold-to-repeat', () => {
    expect(TERMINAL_KEYS.filter((k) => k.repeat).map((k) => k.id)).toEqual([
      'up',
      'down',
      'left',
      'right',
    ])
  })

  it('sends the literal character for each shell symbol', () => {
    const seqOf = (id: string) => TERMINAL_KEYS.find((k) => k.id === id)?.seq
    expect(seqOf('pipe')).toBe('|')
    expect(seqOf('tilde')).toBe('~')
    expect(seqOf('slash')).toBe('/')
    expect(seqOf('dash')).toBe('-')
    expect(seqOf('underscore')).toBe('_')
  })

  it('puts navigation and the function keys on the second row', () => {
    expect(TERMINAL_KEYS_EXTRA.map((k) => k.id)).toEqual([
      'home',
      'end',
      'pgup',
      'pgdn',
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
      'f6',
      'f7',
      'f8',
      'f9',
      'f10',
      'f11',
      'f12',
    ])
    const seqOf = (id: string) => TERMINAL_KEYS_EXTRA.find((k) => k.id === id)?.seq
    expect(seqOf('home')).toBe('\x1b[H')
    expect(seqOf('end')).toBe('\x1b[F')
    expect(seqOf('pgup')).toBe('\x1b[5~')
    expect(seqOf('pgdn')).toBe('\x1b[6~')
    // xterm's own normal-mode function-key sequences.
    expect(seqOf('f1')).toBe('\x1bOP')
    expect(seqOf('f2')).toBe('\x1bOQ')
    expect(seqOf('f3')).toBe('\x1bOR')
    expect(seqOf('f4')).toBe('\x1bOS')
    expect(seqOf('f5')).toBe('\x1b[15~')
    expect(seqOf('f6')).toBe('\x1b[17~')
    expect(seqOf('f7')).toBe('\x1b[18~')
    expect(seqOf('f8')).toBe('\x1b[19~')
    expect(seqOf('f9')).toBe('\x1b[20~')
    expect(seqOf('f10')).toBe('\x1b[21~')
    expect(seqOf('f11')).toBe('\x1b[23~')
    expect(seqOf('f12')).toBe('\x1b[24~')
    // The second row is all literal sequences — no modifiers, no repeat.
    expect(TERMINAL_KEYS_EXTRA.every((k) => k.seq !== null && !k.mod && !k.repeat)).toBe(true)
  })

  it('never reuses an id across the two rows', () => {
    const ids = [...TERMINAL_KEYS, ...TERMINAL_KEYS_EXTRA].map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
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

  it('prefixes a single character with ESC for Alt', () => {
    expect(altSeq('a')).toBe('\x1ba')
    expect(altSeq('.')).toBe('\x1b.')
  })

  it('passes multi-character input through Alt unchanged, so a paste survives', () => {
    expect(altSeq('pasted text')).toBe('pasted text')
    expect(altSeq('\x1b[A')).toBe('\x1b[A')
    expect(altSeq('')).toBe('')
  })

  it('composes the armed modifiers over one chunk', () => {
    expect(modSeq('c', { ctrl: false, alt: false })).toBe('c')
    expect(modSeq('c', { ctrl: true, alt: false })).toBe('\x03')
    expect(modSeq('c', { ctrl: false, alt: true })).toBe('\x1bc')
    // Ctrl first, then the Alt ESC prefix.
    expect(modSeq('c', { ctrl: true, alt: true })).toBe('\x1b\x03')
  })

  it('leaves a multi-character chunk alone however the modifiers are armed', () => {
    expect(modSeq('pasted text', { ctrl: true, alt: true })).toBe('pasted text')
  })
})
