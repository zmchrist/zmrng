import { describe, it, expect } from 'vitest'
import {
  parseWorkspaceClientMsg,
  PresenceTracker,
  WorkspaceManager,
  ChannelManager,
  PageManager,
} from '../src/workspace.js'
import { MAX_DISPLAY_NAME_LEN, MAX_MESSAGE_BODY_LEN, MAX_EMOJI_LEN } from '../src/types.js'
import type {
  Channel,
  KbPage,
  Member,
  Message,
  ReactionSummary,
  WorkspaceMember,
  WsWorkspaceServerMsg,
} from '../src/types.js'

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

  it('parses a well-formed react frame and trims emoji + handle', () => {
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'react', channelId: 2, messageId: 7, emoji: ' 👍 ', handle: ' Ada ' }),
      ),
    ).toEqual({ type: 'react', channelId: 2, messageId: 7, emoji: '👍', handle: 'Ada' })
  })

  it('rejects react frames with a missing/blank/over-cap field', () => {
    const bad = [
      { type: 'react', channelId: 1, messageId: 1, emoji: '👍' }, // no handle
      { type: 'react', channelId: 1, messageId: 1, handle: 'Ada' }, // no emoji
      { type: 'react', channelId: 1.5, messageId: 1, emoji: '👍', handle: 'Ada' }, // non-int channel
      { type: 'react', channelId: 1, messageId: '1', emoji: '👍', handle: 'Ada' }, // non-int message
      { type: 'react', channelId: 1, messageId: 1, emoji: '   ', handle: 'Ada' }, // blank emoji
      { type: 'react', channelId: 1, messageId: 1, emoji: '👍', handle: '   ' }, // blank handle
      { type: 'react', channelId: 1, messageId: 1, emoji: 'x'.repeat(MAX_EMOJI_LEN + 1), handle: 'Ada' },
      {
        type: 'react',
        channelId: 1,
        messageId: 1,
        emoji: '👍',
        handle: 'a'.repeat(MAX_DISPLAY_NAME_LEN + 1),
      },
    ]
    for (const f of bad) expect(parseWorkspaceClientMsg(JSON.stringify(f))).toBeUndefined()
  })
})

describe('parseWorkspaceClientMsg — KB page frames (T2, #144)', () => {
  it('parses page.subscribe / page.unsubscribe with a positive-int pageId', () => {
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'page.subscribe', pageId: 5 }))).toEqual({
      type: 'page.subscribe',
      pageId: 5,
    })
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'page.unsubscribe', pageId: 9 })),
    ).toEqual({ type: 'page.unsubscribe', pageId: 9 })
  })

  it('rejects page.subscribe/unsubscribe with a missing / non-int / non-positive pageId', () => {
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'page.subscribe' }))).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'page.subscribe', pageId: '5' })),
    ).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'page.subscribe', pageId: 1.5 })),
    ).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'page.subscribe', pageId: 0 })),
    ).toBeUndefined()
  })

  it('parses a page.edit whole-body autosave, preserving body whitespace and trimming the author', () => {
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'page.edit', pageId: 3, body: '  indented\n', author: '  Ada  ' }),
      ),
    ).toEqual({
      type: 'page.edit',
      pageId: 3,
      body: '  indented\n', // NOT trimmed — leading/trailing whitespace is meaningful
      author: 'Ada', // author IS trimmed
    })
  })

  it('allows an empty body but rejects an over-cap body', () => {
    const empty = parseWorkspaceClientMsg(
      JSON.stringify({ type: 'page.edit', pageId: 1, body: '', author: 'Ada' }),
    )
    expect(empty?.type).toBe('page.edit')
    const overCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN + 1)
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'page.edit', pageId: 1, body: overCap, author: 'Ada' }),
      ),
    ).toBeUndefined()
  })

  it('rejects a non-string body, a bad pageId, and a blank/missing author', () => {
    const bad = [
      { type: 'page.edit', pageId: 1, body: 5, author: 'Ada' },
      { type: 'page.edit', pageId: 0, body: 'x', author: 'Ada' },
      { type: 'page.edit', pageId: 1, body: 'x', author: '   ' },
      { type: 'page.edit', pageId: 1, body: 'x' },
    ]
    for (const f of bad) expect(parseWorkspaceClientMsg(JSON.stringify(f))).toBeUndefined()
  })

  it('never throws on malformed page frames', () => {
    expect(parseWorkspaceClientMsg('{not json')).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'page.edit' }))).toBeUndefined()
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
  // ---- reactions ----
  private reactions: { messageId: number; handle: string; emoji: string }[] = []
  getMessageChannelId(messageId: number): number | undefined {
    return this.messages.find((m) => m.id === messageId)?.channelId
  }
  private summarize(messageId: number): ReactionSummary[] {
    const byEmoji = new Map<string, string[]>()
    for (const r of this.reactions.filter((r) => r.messageId === messageId)) {
      const list = byEmoji.get(r.emoji) ?? []
      list.push(r.handle)
      byEmoji.set(r.emoji, list)
    }
    return [...byEmoji.entries()].map(([emoji, handles]) => ({ emoji, handles }))
  }
  toggleReaction(messageId: number, handle: string, emoji: string): ReactionSummary[] {
    const idx = this.reactions.findIndex(
      (r) => r.messageId === messageId && r.handle === handle && r.emoji === emoji,
    )
    if (idx >= 0) this.reactions.splice(idx, 1)
    else this.reactions.push({ messageId, handle, emoji })
    return this.summarize(messageId)
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

  it('react toggles a reaction and fans the updated set out to channel subscribers', () => {
    const { db, mgr, received } = setup()
    const msg = db.addMessage(1, 'Ada', 'hi', 'human', 't')
    const sockA = {}
    const sockB = {}
    mgr.subscribe(sockA, 1)
    mgr.subscribe(sockB, 1)
    const set = mgr.react(1, msg.id, 'Bo', '👍', 't')
    expect(set).toEqual([{ emoji: '👍', handles: ['Bo'] }])
    // Both subscribers get the reaction frame.
    expect(received).toHaveLength(2)
    expect(received[0].frame).toEqual({
      type: 'reaction',
      channelId: 1,
      messageId: msg.id,
      reactions: [{ emoji: '👍', handles: ['Bo'] }],
    })
    // Same reactor + emoji again removes it (toggle).
    const set2 = mgr.react(1, msg.id, 'Bo', '👍', 't')
    expect(set2).toEqual([])
  })

  it('react only reaches sockets subscribed to that channel', () => {
    const { db, mgr, received } = setup()
    const msg = db.addMessage(1, 'Ada', 'hi', 'human', 't')
    const onlyB = {}
    mgr.subscribe(onlyB, 2) // subscribed to a different channel
    mgr.react(1, msg.id, 'Bo', '👍', 't')
    expect(received).toHaveLength(0)
  })

  it('react on a message that does not belong to the channel is a no-op', () => {
    const { db, mgr, received } = setup()
    const msg = db.addMessage(1, 'Ada', 'hi', 'human', 't') // in channel 1
    const sockA = {}
    mgr.subscribe(sockA, 2)
    // Claim the message is in channel 2 — mismatch → no persist, no fan-out.
    expect(mgr.react(2, msg.id, 'Bo', '👍', 't')).toBeUndefined()
    expect(received).toHaveLength(0)
    // Unknown message id likewise.
    expect(mgr.react(1, 99999, 'Bo', '👍', 't')).toBeUndefined()
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

/**
 * In-memory stand-in for the KB page-body surface PageManager needs. Mirrors
 * T1 Db semantics closely enough for the fan-out/presence tests:
 * updatePageBody FIRST snapshots the prior state into `revisions` THEN
 * replaces the body (the load-bearing revision-on-save property).
 */
class FakePageDb {
  private pages = new Map<number, KbPage>(
    [1, 2].map((id) => [
      id,
      {
        id,
        spaceId: 1,
        folderId: null,
        title: `Page ${id}`,
        body: '',
        author: 'Ada',
        updatedBy: 'Ada',
        createdAt: 't0',
        updatedAt: 't0',
      },
    ]),
  )
  /** Prior-body revision snapshots, in write order (asserts the T1 property). */
  revisions: Array<{ pageId: number; body: string }> = []

  getPage(id: number): KbPage | undefined {
    return this.pages.get(id)
  }
  updatePageBody(id: number, body: string, updatedBy: string, now: string): KbPage | undefined {
    const existing = this.pages.get(id)
    if (!existing) return undefined
    // FIRST snapshot the PRIOR state (the revision-on-save property).
    this.revisions.push({ pageId: id, body: existing.body })
    const next: KbPage = { ...existing, body, updatedBy, updatedAt: now }
    this.pages.set(id, next)
    return next
  }
}

const member = (id: number, displayName: string): WorkspaceMember => ({
  id,
  displayName,
  online: true,
})

describe('PageManager fan-out (T2, #144 — acceptance-critical)', () => {
  const setup = () => {
    const db = new FakePageDb()
    const received: Array<{ socket: object; frame: WsWorkspaceServerMsg }> = []
    const mgr = new PageManager<object>(db, (socket, frame) => received.push({ socket, frame }))
    return { db, received, mgr }
  }
  const updates = (received: Array<{ socket: object; frame: WsWorkspaceServerMsg }>) =>
    received.filter((r) => r.frame.type === 'page.update')

  it('savePage persists the whole body, returns the updated page, and fans a page.update', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    const page = mgr.savePage(1, 'hello', 'Ada', 't')
    expect(page).toBeDefined()
    expect(page?.id).toBe(1)
    expect(page?.body).toBe('hello')
    const upd = updates(received)
    expect(upd).toHaveLength(1)
    expect(upd[0].socket).toBe(sockA)
    expect(upd[0].frame).toEqual({ type: 'page.update', pageId: 1, page })
  })

  it('savePage on an unknown page is a no-op returning undefined (nothing fanned)', () => {
    const { mgr, received } = setup()
    mgr.subscribe({}, 999, member(1, 'Ada'))
    expect(mgr.savePage(999, 'ghost', 'Ada', 't')).toBeUndefined()
    expect(updates(received)).toHaveLength(0)
  })

  it('savePage fans a page.update AND writes a prior-state revision (T1 property)', () => {
    const { db, mgr, received } = setup()
    db.updatePageBody(1, 'v1', 'Ada', 't0')
    const sockA = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    const updated = mgr.savePage(1, 'v2', 'Bo', 't2')
    expect(updated?.body).toBe('v2')
    expect(updated?.updatedBy).toBe('Bo')
    // The save fanned a page.update.
    const upd = updates(received)
    expect(upd).toHaveLength(1)
    expect(upd[0].frame).toEqual({ type: 'page.update', pageId: 1, page: updated })
    // A revision captured the PRIOR state ('v1') before the patch applied.
    expect(db.revisions).toEqual(
      expect.arrayContaining([{ pageId: 1, body: 'v1' }]),
    )
  })

  it('fans a page.update ONLY to sockets subscribed to that page (cross-page isolation)', () => {
    const { mgr, received } = setup()
    const sockA = {}
    const sockB = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.subscribe(sockB, 2, member(2, 'Bo'))
    mgr.savePage(1, 'in one', 'Ada', 't')
    const upd = updates(received)
    expect(upd).toHaveLength(1)
    expect(upd[0].socket).toBe(sockA)
    expect(upd.some((r) => r.socket === sockB)).toBe(false)
  })

  it('stops delivering page.update after unsubscribe', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.unsubscribe(sockA, 1)
    mgr.savePage(1, 'gone', 'Ada', 't')
    expect(updates(received)).toHaveLength(0)
  })

  it('unsubscribeAll removes a socket from every page (disconnect cleanup)', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.subscribe(sockA, 2, member(1, 'Ada'))
    mgr.unsubscribeAll(sockA)
    mgr.savePage(1, 'x', 'Ada', 't')
    mgr.savePage(2, 'y', 'Ada', 't')
    expect(updates(received)).toHaveLength(0)
  })

  it('subscribe is idempotent — double subscribe delivers a page.update exactly once', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.savePage(1, 'once', 'Ada', 't')
    expect(updates(received)).toHaveLength(1)
  })

  it('subscribe re-broadcasts the page presence viewer set to that page', () => {
    const { mgr, received } = setup()
    const sockA = {}
    const sockB = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.subscribe(sockB, 1, member(2, 'Bo'))
    const presence = received.filter((r) => r.frame.type === 'page.presence')
    const last = presence[presence.length - 1].frame
    if (last.type !== 'page.presence') throw new Error('expected page.presence')
    expect(last.pageId).toBe(1)
    expect(last.viewers).toEqual([
      { id: 1, displayName: 'Ada', online: true },
      { id: 2, displayName: 'Bo', online: true },
    ])
  })

  it('unsubscribe re-broadcasts the shrunken viewer set to the remaining viewers', () => {
    const { mgr, received } = setup()
    const sockA = {}
    const sockB = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.subscribe(sockB, 1, member(2, 'Bo'))
    mgr.unsubscribe(sockB, 1)
    const presence = received.filter(
      (r) => r.frame.type === 'page.presence' && r.socket === sockA,
    )
    const last = presence[presence.length - 1].frame
    if (last.type !== 'page.presence') throw new Error('expected page.presence')
    expect(last.viewers).toEqual([{ id: 1, displayName: 'Ada', online: true }])
  })

  it('unsubscribeAll re-broadcasts the shrunken viewer set to remaining viewers of each left page', () => {
    const { mgr, received } = setup()
    const sockA = {}
    const sockB = {}
    // Bo views pages 1 and 2; Ada stays on page 1 only.
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.subscribe(sockB, 1, member(2, 'Bo'))
    mgr.subscribe(sockB, 2, member(2, 'Bo'))
    // Bo disconnects: dropped from every page, and page 1's remaining viewer
    // (Ada) must be told Bo is gone.
    mgr.unsubscribeAll(sockB)
    const toAda = received.filter(
      (r) => r.frame.type === 'page.presence' && r.socket === sockA,
    )
    const last = toAda[toAda.length - 1].frame
    if (last.type !== 'page.presence') throw new Error('expected page.presence')
    expect(last.pageId).toBe(1)
    expect(last.viewers).toEqual([{ id: 1, displayName: 'Ada', online: true }])
  })

  it('dedupes viewers by member id (multi-tab: two sockets, one viewer)', () => {
    const { mgr } = setup()
    mgr.subscribe({}, 1, member(1, 'Ada'))
    mgr.subscribe({}, 1, member(1, 'Ada')) // same member, second tab
    expect(mgr.viewers(1)).toEqual([{ id: 1, displayName: 'Ada', online: true }])
  })
})
