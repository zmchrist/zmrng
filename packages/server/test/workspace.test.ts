import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  parseWorkspaceClientMsg,
  MAX_HELLO_TOKEN_LEN,
  PresenceTracker,
  WorkspaceManager,
  ChannelManager,
  PageManager,
} from '../src/workspace.js'
import { Db } from '../src/db.js'
import { MAX_MESSAGE_BODY_LEN, MAX_EMOJI_LEN } from '../src/types.js'
import type {
  Channel,
  KbPage,
  Member,
  Message,
  PublicUser,
  ReactionSummary,
  WorkspaceMember,
  WsWorkspaceServerMsg,
} from '../src/types.js'

/** An authenticated identity, the only thing that may name a member now. */
const user = (id: number, displayName: string): PublicUser => ({
  id,
  username: displayName.toLowerCase(),
  displayName,
})

describe('parseWorkspaceClientMsg', () => {
  it('parses a bare hello frame — identity is the session, not the frame', () => {
    // A same-origin socket rides the session cookie sent on its HTTP handshake,
    // so its `hello` carries nothing at all.
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello' }))).toEqual({ type: 'hello' })
  })

  it('parses a hello carrying the cross-origin bearer token', () => {
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', token: 'abc123' }))).toEqual({
      type: 'hello',
      token: 'abc123',
    })
  })

  it('rejects a hello whose token is not a string, and caps its length', () => {
    // The token rides straight into a session lookup — an unbounded or
    // ill-typed field never gets that far.
    for (const token of [5, null, true, { t: 'x' }, ['x']]) {
      expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', token }))).toBeUndefined()
    }
    const atCap = 'a'.repeat(MAX_HELLO_TOKEN_LEN)
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', token: atCap }))).toEqual({
      type: 'hello',
      token: atCap,
    })
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'hello', token: 'a'.repeat(MAX_HELLO_TOKEN_LEN + 1) }),
      ),
    ).toBeUndefined()
  })

  it('treats an empty token as no token (the handshake cookie still gets its turn)', () => {
    // `resolveSocketIdentity` prefers the hello token over the cookie, so a
    // blank one must not win that race and blank out an authenticated socket.
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', token: '' }))).toEqual({
      type: 'hello',
    })
  })

  it('never carries a client displayName through as identity', () => {
    // An outdated client still sending `displayName` connects — its SESSION
    // names it — but the string is dropped and never parsed as identity.
    const parsed = parseWorkspaceClientMsg(JSON.stringify({ type: 'hello', displayName: 'Ada' }))
    expect(parsed).toEqual({ type: 'hello' })
    expect(parsed && 'displayName' in parsed).toBe(false)
  })

  it('parses a bare ping frame', () => {
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'ping' }))).toEqual({ type: 'ping' })
  })

  it('returns undefined for near-miss cases and never throws', () => {
    expect(parseWorkspaceClientMsg('{not json')).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'nope' }))).toBeUndefined()
    expect(parseWorkspaceClientMsg('')).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify(['hello']))).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify(null))).toBeUndefined()
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
      parseWorkspaceClientMsg(JSON.stringify({ type: 'message', channelId: 1, body: '  hi  ' })),
    ).toEqual({ type: 'message', channelId: 1, body: 'hi' })
  })

  it('REJECTS a message frame that still asserts an identity (anti-spoofing contract)', () => {
    // THE point of the change: identity can no longer be asserted over the wire.
    // The server names the author from the socket's authenticated session, so an
    // outdated client that still sends `author`/`handle` fails LOUDLY — the frame
    // is dropped — rather than silently posting under a server-chosen name.
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, body: 'hi', author: 'Ada' }),
      ),
    ).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, body: 'hi', handle: 'Ada' }),
      ),
    ).toBeUndefined()
  })

  it('ignores any client-supplied kind — a socket post is never client-authored as agent', () => {
    // A human client cannot forge an `agent` message: the parser drops `kind`
    // entirely, and the route always posts `human` (index.ts). The `agent` kind
    // is server-controlled (the future T4 agent path).
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, body: 'go', kind: 'agent' }),
      ),
    ).toEqual({ type: 'message', channelId: 1, body: 'go' })
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'message', channelId: 1, body: 'hi', kind: 'bogus' }),
      ),
    ).toEqual({ type: 'message', channelId: 1, body: 'hi' })
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'message', channelId: 1, body: 'hi' })),
    ).toEqual({ type: 'message', channelId: 1, body: 'hi' })
  })

  it('rejects a message frame with a blank body or bad channelId, and never throws', () => {
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'message', channelId: 1, body: '   ' })),
    ).toBeUndefined()
    expect(parseWorkspaceClientMsg(JSON.stringify({ type: 'message', channelId: 1 }))).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'message', channelId: 'x', body: 'hi' })),
    ).toBeUndefined()
  })

  it('rejects a message body longer than the cap (post-trim)', () => {
    const overCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN + 1)
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'message', channelId: 1, body: overCap })),
    ).toBeUndefined()
    const atCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN)
    const parsed = parseWorkspaceClientMsg(
      JSON.stringify({ type: 'message', channelId: 1, body: atCap }),
    )
    expect(parsed?.type).toBe('message')
  })

  it('parses a well-formed react frame and trims the emoji', () => {
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'react', channelId: 2, messageId: 7, emoji: ' 👍 ' }),
      ),
    ).toEqual({ type: 'react', channelId: 2, messageId: 7, emoji: '👍' })
  })

  it('REJECTS a react frame that still asserts a handle (anti-spoofing contract)', () => {
    // Same contract as `message`: the reactor is the socket's authenticated
    // user, so a self-asserted handle on the wire is refused outright.
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'react', channelId: 1, messageId: 1, emoji: '👍', handle: 'Ada' }),
      ),
    ).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'react', channelId: 1, messageId: 1, emoji: '👍', author: 'Ada' }),
      ),
    ).toBeUndefined()
  })

  it('rejects react frames with a missing/blank/over-cap field', () => {
    const bad = [
      { type: 'react', channelId: 1, messageId: 1 }, // no emoji
      { type: 'react', channelId: 1.5, messageId: 1, emoji: '👍' }, // non-int channel
      { type: 'react', channelId: 1, messageId: '1', emoji: '👍' }, // non-int message
      { type: 'react', channelId: 1, messageId: 1, emoji: '   ' }, // blank emoji
      { type: 'react', channelId: 1, messageId: 1, emoji: 'x'.repeat(MAX_EMOJI_LEN + 1) },
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

  it('parses a page.edit whole-body autosave, preserving body whitespace', () => {
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'page.edit', pageId: 3, body: '  indented\n' })),
    ).toEqual({
      type: 'page.edit',
      pageId: 3,
      body: '  indented\n', // NOT trimmed — leading/trailing whitespace is meaningful
    })
  })

  it('REJECTS a page.edit that still asserts an author (anti-spoofing contract)', () => {
    // A KB edit is attributed to the socket's authenticated user and written to
    // the changelog under that name, so a wire-supplied author is refused — the
    // outdated client fails loudly instead of having its edit misattributed.
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'page.edit', pageId: 3, body: 'x', author: 'Ada' }),
      ),
    ).toBeUndefined()
    expect(
      parseWorkspaceClientMsg(
        JSON.stringify({ type: 'page.edit', pageId: 3, body: 'x', handle: 'Ada' }),
      ),
    ).toBeUndefined()
  })

  it('allows an empty body but rejects an over-cap body', () => {
    const empty = parseWorkspaceClientMsg(JSON.stringify({ type: 'page.edit', pageId: 1, body: '' }))
    expect(empty?.type).toBe('page.edit')
    const overCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN + 1)
    expect(
      parseWorkspaceClientMsg(JSON.stringify({ type: 'page.edit', pageId: 1, body: overCap })),
    ).toBeUndefined()
  })

  it('rejects a non-string body and a bad pageId', () => {
    const bad = [
      { type: 'page.edit', pageId: 1, body: 5 },
      { type: 'page.edit', pageId: 0, body: 'x' },
      { type: 'page.edit', pageId: 1 },
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

  it('attributes a post to the identity passed BY THE CALLER, never one from the frame', () => {
    const { mgr } = setup()
    // The parsed frame carries no identity at all — there is nothing on the wire
    // to attribute to. The caller (the route) supplies the socket's
    // AUTHENTICATED display name, and that is what is persisted.
    const frame = parseWorkspaceClientMsg(
      JSON.stringify({ type: 'message', channelId: 1, body: 'hi' }),
    )
    expect(frame && 'author' in frame).toBe(false)
    const authed = user(7, 'Ada')
    const msg = mgr.post(1, authed.displayName, 'hi', 'human', 't')
    expect(msg?.author).toBe('Ada')
  })

  it('attributes a reaction to the identity passed BY THE CALLER, never one from the frame', () => {
    const { db, mgr } = setup()
    const posted = db.addMessage(1, 'Ada', 'hi', 'human', 't')
    const frame = parseWorkspaceClientMsg(
      JSON.stringify({ type: 'react', channelId: 1, messageId: posted.id, emoji: '👍' }),
    )
    expect(frame && 'handle' in frame).toBe(false)
    const authed = user(9, 'Bo')
    expect(mgr.react(1, posted.id, authed.displayName, '👍', 't')).toEqual([
      { emoji: '👍', handles: ['Bo'] },
    ])
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
    { id: 1, displayName: 'Ada', userId: 1, createdAt: 't' },
    { id: 2, displayName: 'Bo', userId: 2, createdAt: 't' },
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
  private byUserId = new Map<number, Member>()
  private order: Member[] = []
  private nextId = 1
  /** Mirrors `Db.memberForUser`: keyed on the user id, never on a display name. */
  memberForUser(u: { id: number; displayName: string }, now: string): Member {
    const existing = this.byUserId.get(u.id)
    if (existing) return existing
    const m: Member = {
      id: this.nextId++,
      displayName: u.displayName,
      userId: u.id,
      createdAt: now,
    }
    this.byUserId.set(u.id, m)
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

  it('join resolves the authenticated user to a member, marks them online, and broadcasts a fresh roster', () => {
    const { frames, mgr } = setup()
    const sockA = {}
    const member = mgr.join(sockA, user(1, 'Ada'), '2026-08-24T00:00:00.000Z')
    expect(member.displayName).toBe('Ada')
    expect(member.userId).toBe(1)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({
      type: 'roster',
      members: [{ id: member.id, displayName: 'Ada', online: true }],
    })
  })

  it('a second teammate joining broadcasts a roster with both online', () => {
    const { frames, mgr } = setup()
    mgr.join({}, user(1, 'Ada'), '2026-08-24T00:00:00.000Z')
    mgr.join({}, user(2, 'Bo'), '2026-08-24T00:00:01.000Z')
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
    mgr.join(sockA, user(1, 'Ada'), '2026-08-24T00:00:00.000Z')
    mgr.join({}, user(2, 'Bo'), '2026-08-24T00:00:01.000Z')
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
    mgr.join(sockA, user(1, 'Ada'), '2026-08-24T00:00:00.000Z')
    expect(mgr.roster()).toEqual([{ id: 1, displayName: 'Ada', online: true }])
    mgr.leave(sockA)
    expect(mgr.roster()).toEqual([{ id: 1, displayName: 'Ada', online: false }])
  })
})

describe('WorkspaceManager.join — member identity is the authenticated user (real Db)', () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zmrng-ws-'))
    db = new Db(path.join(dir, 'zmrng.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const manager = () => new WorkspaceManager(db, () => {})

  it('maps a user to a STABLE member row across reconnects (the roster never grows per session)', () => {
    const mgr = manager()
    const ada = user(1, 'Ada')
    const firstSocket = {}
    const first = mgr.join(firstSocket, ada, '2026-09-23T00:00:00.000Z')
    mgr.leave(firstSocket)
    // A reconnect is a brand-new socket carrying the SAME session identity.
    const second = mgr.join({}, ada, '2026-09-23T00:05:00.000Z')
    expect(second.id).toBe(first.id)
    expect(second.userId).toBe(ada.id)
    expect(db.listMembers()).toHaveLength(1)
  })

  it('maps distinct users to distinct member rows', () => {
    const mgr = manager()
    const ada = mgr.join({}, user(1, 'Ada'), '2026-09-23T00:00:00.000Z')
    const bo = mgr.join({}, user(2, 'Bo'), '2026-09-23T00:00:01.000Z')
    expect(bo.id).not.toBe(ada.id)
    expect(db.listMembers().map((m) => m.userId)).toEqual([1, 2])
  })

  it('a renamed user keeps their member row — the key is the user id, not the name', () => {
    const mgr = manager()
    const first = mgr.join({}, user(1, 'Ada'), '2026-09-23T00:00:00.000Z')
    const again = mgr.join({}, { id: 1, username: 'ada', displayName: 'Ada L' }, 't')
    expect(again.id).toBe(first.id)
    expect(db.listMembers()).toHaveLength(1)
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
  /** Every changelog actor handed to `updatePageBody`, in write order. */
  actors: Array<{ userId: number | null; username: string } | undefined> = []

  getPage(id: number): KbPage | undefined {
    return this.pages.get(id)
  }
  updatePageBody(
    id: number,
    body: string,
    updatedBy: string,
    now: string,
    actor?: { userId: number | null; username: string },
  ): KbPage | undefined {
    const existing = this.pages.get(id)
    if (!existing) return undefined
    // FIRST snapshot the PRIOR state (the revision-on-save property).
    this.revisions.push({ pageId: id, body: existing.body })
    this.actors.push(actor)
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
    const page = mgr.savePage(1, 'hello', user(1, 'Ada'), 't')
    expect(page).toBeDefined()
    expect(page?.id).toBe(1)
    expect(page?.body).toBe('hello')
    const upd = updates(received)
    expect(upd).toHaveLength(1)
    expect(upd[0].socket).toBe(sockA)
    expect(upd[0].frame).toEqual({ type: 'page.update', pageId: 1, page })
  })

  it('attributes the save to the identity passed BY THE CALLER, never one from the frame', () => {
    const { db, mgr } = setup()
    // The parsed frame carries no author — the caller passes the socket's
    // authenticated user, whose display name lands in `updated_by` and whose
    // username/id go to the KB changelog.
    const frame = parseWorkspaceClientMsg(JSON.stringify({ type: 'page.edit', pageId: 1, body: 'x' }))
    expect(frame && 'author' in frame).toBe(false)
    const saved = mgr.savePage(1, 'x', user(42, 'Ada'), 't')
    expect(saved?.updatedBy).toBe('Ada')
    expect(db.actors).toEqual([{ userId: 42, username: 'ada' }])
  })

  it('savePage on an unknown page is a no-op returning undefined (nothing fanned)', () => {
    const { mgr, received } = setup()
    mgr.subscribe({}, 999, member(1, 'Ada'))
    expect(mgr.savePage(999, 'ghost', user(1, 'Ada'), 't')).toBeUndefined()
    expect(updates(received)).toHaveLength(0)
  })

  it('savePage fans a page.update AND writes a prior-state revision (T1 property)', () => {
    const { db, mgr, received } = setup()
    db.updatePageBody(1, 'v1', 'Ada', 't0')
    const sockA = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    const updated = mgr.savePage(1, 'v2', user(2, 'Bo'), 't2')
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
    mgr.savePage(1, 'in one', user(1, 'Ada'), 't')
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
    mgr.savePage(1, 'gone', user(1, 'Ada'), 't')
    expect(updates(received)).toHaveLength(0)
  })

  it('unsubscribeAll removes a socket from every page (disconnect cleanup)', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.subscribe(sockA, 2, member(1, 'Ada'))
    mgr.unsubscribeAll(sockA)
    mgr.savePage(1, 'x', user(1, 'Ada'), 't')
    mgr.savePage(2, 'y', user(1, 'Ada'), 't')
    expect(updates(received)).toHaveLength(0)
  })

  it('subscribe is idempotent — double subscribe delivers a page.update exactly once', () => {
    const { mgr, received } = setup()
    const sockA = {}
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.subscribe(sockA, 1, member(1, 'Ada'))
    mgr.savePage(1, 'once', user(1, 'Ada'), 't')
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

describe('PageManager.savePage — authenticated attribution + KB changelog (real Db)', () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zmrng-ws-page-'))
    db = new Db(path.join(dir, 'zmrng.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records the actor in updated_by AND a page.edit changelog entry', () => {
    const space = db.createSpace('Team', '2026-09-23T00:00:00.000Z')
    const page = db.createPage(space.id, null, 'Notes', 'seed', '2026-09-23T00:00:00.000Z')
    const mgr = new PageManager<object>(db, () => {})
    const authed: PublicUser = { id: 42, username: 'ada', displayName: 'Ada Lovelace' }
    const saved = mgr.savePage(page.id, 'body v1', authed, '2026-09-23T00:10:00.000Z')
    expect(saved?.body).toBe('body v1')
    // The page's own attribution is the authenticated DISPLAY name...
    expect(saved?.updatedBy).toBe('Ada Lovelace')
    // ...and the changelog records who did it, by id + username.
    const entry = db.listChangelog(space.id, 10).find((e) => e.action === 'page.edit')
    expect(entry).toBeDefined()
    expect(entry?.username).toBe('ada')
    expect(entry?.userId).toBe(42)
    expect(entry?.pageId).toBe(page.id)
  })

  it('an unknown page writes no changelog entry at all (no-op)', () => {
    const space = db.createSpace('Team', '2026-09-23T00:00:00.000Z')
    const mgr = new PageManager<object>(db, () => {})
    expect(
      mgr.savePage(99999, 'ghost', { id: 42, username: 'ada', displayName: 'Ada' }, 't'),
    ).toBeUndefined()
    expect(db.listChangelog(space.id, 10)).toEqual([])
  })
})
