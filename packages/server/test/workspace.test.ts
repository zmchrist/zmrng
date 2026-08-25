import { describe, it, expect } from 'vitest'
import {
  parseWorkspaceClientMsg,
  PresenceTracker,
  WorkspaceManager,
} from '../src/workspace.js'
import type { Member, WsWorkspaceServerMsg } from '../src/types.js'

describe('parseWorkspaceClientMsg', () => {
  it('parses a well-formed hello frame and trims the display name', () => {
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: 'Ada' }))).toEqual({
      type: 'hello',
      displayName: 'Ada',
    })
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: '  Bo  ' })),
    ).toEqual({ type: 'hello', displayName: 'Bo' })
  })

  it('parses a bare ping frame', () => {
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'ping' }))).toEqual({ type: 'ping' })
  })

  it('returns undefined for near-miss cases and never throws', () => {
    expect(parseWorkspaceClientMsg('{not json')).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'nope' }))).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello' }))).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: '' }))).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: '   ' })),
    ).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: 5 }))).toBeUndefined()
    expect(parseWorkspaceClientMsg('')).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify(['hello']))).toBeUndefined()
  })
})

describe('PresenceTracker', () => {
  const members: Member[] = [
    { id: 1, displayName: 'Ada', createdAt: 't' },
    { id: 2, displayName: 'Bo', createdAt: 't' },
  ]

  it('marks a member online while a socket is joined, offline once it leaves', () => {
    const p = new PresenceTracker()
    const sockA = {}
    p.join(sockA, 1)
    expect(p.roster(members)).toEqual([
      { id: 1, displayName: 'Ada', online: true },
      { id: 2, displayName: 'Bo', online: false },
    ])
    p.leave(sockA)
    expect(p.onlineIds().size).toBe(0)
  })

  it('a member stays online while ANY of their sockets is live (multi-tab)', () => {
    const p = new PresenceTracker()
    const s1 = {}
    const s2 = {}
    p.join(s1, 1)
    p.join(s2, 1)
    p.leave(s1)
    expect(p.onlineIds().has(1)).toBe(true) // second socket keeps them online
    p.leave(s2)
    expect(p.onlineIds().has(1)).toBe(false)
  })

  it('leave on an unknown socket is a no-op', () => {
    const p = new PresenceTracker()
    expect(() => p.leave({})).not.toThrow()
    expect(p.onlineIds().size).toBe(0)
  })
})

/** In-memory stand-in for the members-table surface WorkspaceManager needs. */
class FakeMemberDb {
  private byName = new Map<string, Member>()
  private order: Member[] = []
  private nextId = 1
  upsertMember(displayName: string, now: string): Member {
    const existing = this.byName.get(displayName)
    if (existing) return existing
    const m: Member = { id: this.nextId++, displayName, createdAt: now }
    this.byName.set(displayName, m)
    this.order.push(m)
    return m
  }
  listMembers(): Member[] {
    return [...this.order]
  }
}

describe('WorkspaceManager', () => {
  const setup = () => {
    const db = new FakeMemberDb()
    const frames: WsWorkspaceServerMsg[] = []
    const mgr = new WorkspaceManager(db, (f) => frames.push(f))
    return { db, frames, mgr }
  }

  it('join upserts a member, marks them online, and broadcasts a fresh roster', () => {
    const { frames, mgr } = setup()
    const sockA = {}
    const member = mgr.join(sockA, 'Ada', '2026-08-24T00:00:00.000Z')
    expect(member.displayName).toBe('Ada')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({
      type: 'roster',
      members: [{ id: member.id, displayName: 'Ada', online: true }],
    })
  })

  it('a second teammate joining broadcasts a roster with both online', () => {
    const { frames, mgr } = setup()
    mgr.join({}, 'Ada', '2026-08-24T00:00:00.000Z')
    mgr.join({}, 'Bo', '2026-08-24T00:00:01.000Z')
    const last = frames[frames.length - 1]
    expect(last.type).toBe('roster')
    if (last.type !== 'roster') throw new Error('expected roster')
    expect(last.members.map((m) => [m.displayName, m.online])).toEqual([
      ['Ada', true],
      ['Bo', true],
    ])
  })

  it('leave drops the member offline but keeps them in the roster', () => {
    const { frames, mgr } = setup()
    const sockA = {}
    mgr.join(sockA, 'Ada', '2026-08-24T00:00:00.000Z')
    mgr.join({}, 'Bo', '2026-08-24T00:00:01.000Z')
    mgr.leave(sockA)
    const last = frames[frames.length - 1]
    if (last.type !== 'roster') throw new Error('expected roster')
    expect(last.members).toEqual([
      { id: 1, displayName: 'Ada', online: false },
      { id: 2, displayName: 'Bo', online: true },
    ])
  })

  it('roster() reflects the current live snapshot', () => {
    const { mgr } = setup()
    const sockA = {}
    mgr.join(sockA, 'Ada', '2026-08-24T00:00:00.000Z')
    expect(mgr.roster()).toEqual([{ id: 1, displayName: 'Ada', online: true }])
    mgr.leave(sockA)
    expect(mgr.roster()).toEqual([{ id: 1, displayName: 'Ada', online: false }])
  })
})
