import { describe, expect, it } from 'vitest'
import { kbHandles } from '../src/kbHandles'

describe('kbHandles', () => {
  it('with no handle: presence falls back to anon, editing is gated off, edit author is empty', () => {
    const h = kbHandles('')
    expect(h.presenceHandle).toBe('anon')
    expect(h.editHandle).toBe('')
    expect(h.canEdit).toBe(false)
  })

  it('treats a whitespace-only handle as unset (still read-only, still no anon author)', () => {
    const h = kbHandles('   ')
    expect(h.presenceHandle).toBe('anon')
    expect(h.editHandle).toBe('')
    expect(h.canEdit).toBe(false)
  })

  it('with a real handle: presence + edit author are the same trimmed identity, editing enabled', () => {
    const h = kbHandles('Ada')
    expect(h.presenceHandle).toBe('Ada')
    expect(h.editHandle).toBe('Ada')
    expect(h.canEdit).toBe(true)
  })

  it('trims surrounding whitespace before using the handle', () => {
    const h = kbHandles('  Ada  ')
    expect(h.presenceHandle).toBe('Ada')
    expect(h.editHandle).toBe('Ada')
    expect(h.canEdit).toBe(true)
  })

  it('never authors an edit as anon: editHandle is either empty (blocked) or the real handle', () => {
    // The whole point of #150 — the presence fallback string must NEVER leak
    // into the edit-author slot. Across set/unset inputs, editHandle is only
    // ever '' or the exact trimmed handle, never the 'anon' presence fallback.
    for (const input of ['', '   ', 'anonymous', 'Bob', '  Cleo  ']) {
      const h = kbHandles(input)
      expect(h.editHandle).not.toBe('anon')
      if (h.canEdit) {
        expect(h.editHandle).toBe(input.trim())
        expect(h.editHandle.length).toBeGreaterThan(0)
      } else {
        expect(h.editHandle).toBe('')
      }
    }
  })
})
