import { describe, it, expect } from 'vitest'
import {
  parseWorkspaceClientMsg,
  PresenceTracker,
  WorkspaceManager,
  ChannelManager,
} from '../src/workspace.js'
import { MAX_DISPLAY_NAME_LEN, MAX_MESSAGE_BODY_LEN } from '../src/types.js'
import type { Channel, Member, Message, WsWorkspaceServerMsg } from '../src/types.js'

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

  it('accepts a name at the length cap but rejects one over it (post-trim)', () => {
    const atCap = 'a'.repeat(MAX_DISPLAY_NAME_LEN)
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: atCap }))).toEqual({
      type: 'hello',
      displayName: atCap,
    })
    const overCap = 'a'.repeat(MAX_DISPLAY_NAME_LEN + 1)
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: overCap })),
    ).toBeUndefined()
    // Length is measured AFTER trimming: surrounding whitespace does not count.
    const padded = `  ${atCap}  `
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: padded }))).toEqual({
      type: 'hello',
      displayName: atCap,
    })
  })
})

describe('parseWorkspaceClientMsg — channel frames (T2)', () => {
  it('parses subscribe / unsubscribe frames with a numeric channelId', () => {
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'subscribe', channelId: 3 }))).toEqual({
      type: 'subscribe',
      channelId: 3,
    })
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'unsubscribe', channelId: 7 })),
    ).toEqual({ type: 'unsubscribe', channelId: 7 })
  })

  it('rejects subscribe/unsubscribe with a missing or non-integer channelId', () => {
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'subscribe' }))).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'subscribe', channelId: '3' })),
    ).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'subscribe', channelId: 1.5 })),
    ).toBeUndefined()
  })

  it('parses a well-formed message frame and trims the body (no client kind)', () => {
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, author: 'Ada', body: '  hi  ' }),
      ),
    ).toEqual({ type: 'message', channelId: 1, author: 'Ada', body: 'hi' })
  })

  it('ignores any client-supplied kind — a socket post is never client-authored as agent', () => {
    // A human client cannot forge an `agent` message: the parser drops `kind`
    // entirely, and the route always posts `human` (index.ts). The `agent` kind
    // is server-controlled (the future T4 agent path).
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, author: 'planner', body: 'go', kind: 'agent' }),
      ),
    ).toEqual({ type: 'message', channelId: 1, author: 'planner', body: 'go' })
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, author: 'Ada', body: 'hi', kind: 'bogus' }),
      ),
    ).toEqual({ type: 'message', channelId: 1, author: 'Ada', body: 'hi' })
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, author: 'Ada', body: 'hi' }),
      ),
    ).toEqual({ type: 'message', channelId: 1, author: 'Ada', body: 'hi' })
  })

  it('rejects a message frame with a blank body, blank author, or bad channelId, and never throws', () => {
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, author: 'Ada', body: '   ' }),
      ),
    ).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, author: '  ', body: 'hi' }),
      ),
    ).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 'x', author: 'Ada', body: 'hi' }),
      ),
    ).toBeUndefined()
  })

  it('rejects a message body longer than the cap (post-trim)', () => {
    const overCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN + 1)
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, author: 'Ada', body: overCap }),
      ),
    ).toBeUndefined()
    const atCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN)
    const parsed = parseWorkspaceClientMsg(
      JSON.stringify({ type: 'message', channelId: 1, author: 'Ada', body: atCap }),
    )
    expect(parsed?.type).toBe('message')
  })
})

/** In-memory stand-in for the channel/message surface ChannelManager needs. */
class FakeChannelDb {
  private channels: Channel[] = [
    { id: 1, name: 'general', repoId: null, createdAt: 't' },
    { id: 2, name: 'other', repoId: null, createdAt: 't' },
  ]
  private messages: Message[] = []
  private nextId = 1
  listChannels(): Channel[] {
    return [...this.channels]
  }
  getChannel(id: number): Channel | undefined {
    return this.channels.find((c) => c.id === id)
  }
  addMessage(
    channelId: number,
    author: string,
    body: string,
    kind: Message['kind'],
    now: string,
  ): Message {
    const m: Message = { id: this.nextId++, channelId, author, body, kind, createdAt: now }
    this.messages.push(m)
    return m
  }
  listMessages(channelId: number, before: number | null, limit: number): Message[] {
    const all = this.messages.filter((m) => m.channelId === channelId)
    const older = before === null ? all : all.filter((m) => m.id < before)
    return older.slice(-limit)
  }
}

describe('ChannelManager fan-out (T2 — acceptance-critical)', () => {
  const setup = () => {
    const db = new FakeChannelDb()
    const received: Array<{ socket: object; frame: WsWorkspaceServerMsg }> = []
    const mgr = new ChannelManager<object>(db, (socket, frame) => received.push({ socket, frame }))
    return { db, received, mgr }
  }

  it('post persists the message and returns it (with the channel-scoped fields)', () => {
    const { mgr } = setup()
    const msg = mgr.post(1, 'Ada', 'hello', 'human', '2026-08-25T00:00:00.000Z')
    expect(msg).toBeDefined()
    expect(msg?.channelId).toBe(1)
    expect(msg?.author).toBe('Ada')
    expect(msg?.kind).toBe('human')
  })

  it('post to an unknown channel returns undefined and fans out nothing', () => {
    const { mgr, received } = setup()
    expect(mgr.post(999, 'Ada', 'ghost', 'human', 't')).toBeUndefined()
    expect(received).toHaveLength(0)
  })

  it('fans a message out ONLY to sockets subscribed to that channel', () => {
    const { mgr, received } = setup()
    const sockA = {}
    const sockB = {}
    mgr.subscribe(sockA, 1) // A watches channel 1
    mgr.subscribe(sockB, 2) // B watches channel 2 only
    const msg = mgr.post(1, 'Ada', 'in one', 'human', 't')
    // Exactly one delivery — to sockA — and NEVER to sockB (subscribed to 2).
    expect(received).toHaveLength(1)
    expect(received[0].socket).toBe(sockA)
    expect(received[0].frame).toEqual({ type: 'message', message: msg })
    expect(received.some((r) => r.socket === sockB)).toBe(false)
  })

  it('fans out to every socket subscribed to the same channel (two teammates live)', () => {
    const { mgr, received } = setup()
    const sockA = {}
    const sockB = {}
    mgr.subscribe(sockA, 1)
    mgr.subscribe(sockB, 1) // both in channel 1 — the demoable payoff
    mgr.post(1, 'Ada', 'hi all', 'human', 't')
    expect(received.map((r) => r.socket)).toEqual(expect.arrayContaining([sockA, sockB]))
    expect(received).toHaveLength(2)
  })

  it('stops delivering after unsubscribe', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1)
    mgr.unsubscribe(sockA, 1)
    mgr.post(1, 'Ada', 'gone', 'human', 't')
    expect(received).toHaveLength(0)
  })

  it('unsubscribeAll removes a socket from every channel (disconnect cleanup)', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1)
    mgr.subscribe(sockA, 2)
    mgr.unsubscribeAll(sockA)
    mgr.post(1, 'Ada', 'x', 'human', 't')
    mgr.post(2, 'Ada', 'y', 'human', 't')
    expect(received).toHaveLength(0)
  })

  it('a message posted to channel A never reaches a socket subscribed only to B', () => {
    const { mgr, received } = setup()
    const onlyB = {}
    mgr.subscribe(onlyB, 2)
    mgr.post(1, 'Ada', 'for A', 'human', 't')
    expect(received).toHaveLength(0)
  })

  it('subscribe is idempotent — double subscribe still delivers exactly once', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1)
    mgr.subscribe(sockA, 1)
    mgr.post(1, 'Ada', 'once', 'human', 't')
    expect(received).toHaveLength(1)
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
