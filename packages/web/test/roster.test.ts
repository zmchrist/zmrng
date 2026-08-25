import { describe, it, expect } from 'vitest'
import { emptyRoster, applyWorkspaceMsg } from '../src/roster'
import type { WorkspaceMember } from '../src/types'

const ada: WorkspaceMember = { id: 1, displayName: 'Ada', online: true }
const bo: WorkspaceMember = { id: 2, displayName: 'Bo', online: false }

describe('emptyRoster', () => {
  it('starts empty', () => {
    expect(emptyRoster()).toEqual([])
  })
})

describe('applyWorkspaceMsg', () => {
  it('a roster frame replaces the whole roster (full-snapshot semantics)', () => {
    const next = applyWorkspaceMsg([ada], { type: 'roster', members: [bo] })
    expect(next).toEqual([bo])
  })

  it('sorts members by display name (case-insensitive), online independent', () => {
    const next = applyWorkspaceMsg(emptyRoster(), {
      type: 'roster',
      members: [
        { id: 3, displayName: 'zed', online: true },
        { id: 1, displayName: 'Ada', online: false },
        { id: 2, displayName: 'bo', online: true },
      ],
    })
    expect(next.map((m) => m.displayName)).toEqual(['Ada', 'bo', 'zed'])
  })

  it('dedupes by id, keeping the last occurrence (defensive against a dup frame)', () => {
    const next = applyWorkspaceMsg(emptyRoster(), {
      type: 'roster',
      members: [
        { id: 1, displayName: 'Ada', online: false },
        { id: 1, displayName: 'Ada', online: true },
      ],
    })
    expect(next).toEqual([{ id: 1, displayName: 'Ada', online: true }])
  })

  it('reflects a member going offline on the next roster frame (leave)', () => {
    let state = applyWorkspaceMsg(emptyRoster(), { type: 'roster', members: [ada] })
    expect(state[0].online).toBe(true)
    state = applyWorkspaceMsg(state, {
      type: 'roster',
      members: [{ id: 1, displayName: 'Ada', online: false }],
    })
    expect(state[0].online).toBe(false)
  })

  it('a pong frame leaves the roster unchanged (same reference)', () => {
    const state = [ada]
    expect(applyWorkspaceMsg(state, { type: 'pong' })).toBe(state)
  })
})
