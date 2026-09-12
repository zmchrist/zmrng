import { describe, it, expect } from 'vitest'
import { isBlockConflict, mergeBlock, removeBlock } from '../src/kbConflict'
import type { KbBlock } from '../src/types'

const block = (id: number, ord: number, over: Partial<KbBlock> = {}): KbBlock => ({
  id,
  pageId: 1,
  ord,
  kind: 'text',
  body: `body ${id}`,
  meta: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'Ada',
  ...over,
})

describe('isBlockConflict', () => {
  it('is a conflict when a dirty block is updated by someone else', () => {
    const incoming = block(5, 0, { updatedBy: 'Grace' })
    expect(isBlockConflict(incoming, new Set([5]), 'Ada')).toBe(true)
  })

  it('is not a conflict when the block is not locally dirty', () => {
    const incoming = block(5, 0, { updatedBy: 'Grace' })
    expect(isBlockConflict(incoming, new Set([6]), 'Ada')).toBe(false)
  })

  it('is not a conflict for the local user’s own echoed update', () => {
    const incoming = block(5, 0, { updatedBy: 'Ada' })
    expect(isBlockConflict(incoming, new Set([5]), 'Ada')).toBe(false)
  })
})

describe('mergeBlock', () => {
  it('replaces a block with the same id in place', () => {
    const blocks = [block(1, 0), block(2, 1)]
    const incoming = block(2, 1, { body: 'edited' })
    const out = mergeBlock(blocks, incoming)
    expect(out).toHaveLength(2)
    expect(out[1].body).toBe('edited')
    expect(out).not.toBe(blocks)
  })

  it('inserts a new block sorted by ord', () => {
    const blocks = [block(1, 0), block(3, 2)]
    const incoming = block(2, 1)
    const out = mergeBlock(blocks, incoming)
    expect(out.map((b) => b.id)).toEqual([1, 2, 3])
  })

  it('appends a new block with a higher ord to the end', () => {
    const blocks = [block(1, 0)]
    const incoming = block(2, 1)
    expect(mergeBlock(blocks, incoming).map((b) => b.id)).toEqual([1, 2])
  })
})

describe('removeBlock', () => {
  it('removes the block with the given id, leaving the others in order', () => {
    const blocks = [block(1, 0), block(2, 1), block(3, 2)]
    const out = removeBlock(blocks, 2)
    expect(out.map((b) => b.id)).toEqual([1, 3])
  })

  it('returns the SAME array reference (no-op) when the id is absent', () => {
    const blocks = [block(1, 0), block(2, 1)]
    const out = removeBlock(blocks, 99)
    expect(out).toBe(blocks)
  })

  it('does not mutate the input array', () => {
    const blocks = [block(1, 0), block(2, 1)]
    const out = removeBlock(blocks, 1)
    expect(blocks.map((b) => b.id)).toEqual([1, 2]) // input unchanged
    expect(out.map((b) => b.id)).toEqual([2])
    expect(out).not.toBe(blocks)
  })
})
