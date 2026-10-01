import { describe, it, expect } from 'vitest'
import {
  encodeHello,
  encodePing,
  encodeSubscribe,
  encodeUnsubscribe,
  encodeMessage,
  encodeReact,
  encodePageSubscribe,
  encodePageUnsubscribe,
  encodePageEdit,
  parseWorkspaceServerMsg,
} from '../src/workspaceProtocol'
import { MAX_MESSAGE_BODY_LEN, MAX_EMOJI_LEN } from '../src/types'
import type { KbPage } from '../src/types'

describe('client encoders', () => {
  it('encodeHello produces a bare hello frame when no token is given', () => {
    // A same-origin socket is authenticated by the `zmrng_session` httpOnly
    // cookie the browser attaches to the WS handshake — there is nothing for
    // the frame to carry.
    const frame = JSON.parse(encodeHello()) as Record<string, unknown>
    expect(frame).toEqual({ type: 'hello' })
    expect(Object.keys(frame)).toEqual(['type'])
  })

  it('encodeHello carries a bearer token when one is given (cross-origin, D2)', () => {
    expect(JSON.parse(encodeHello('tok-abc'))).toEqual({ type: 'hello', token: 'tok-abc' })
  })

  it('encodeHello omits an empty/blank token rather than sending an empty string', () => {
    expect(JSON.parse(encodeHello(''))).toEqual({ type: 'hello' })
    expect(JSON.parse(encodeHello('   '))).toEqual({ type: 'hello' })
  })

  it('encodeHello NEVER emits a displayName — identity is the session, not a frame', () => {
    for (const raw of [encodeHello(), encodeHello('tok-abc')]) {
      const frame = JSON.parse(raw) as Record<string, unknown>
      expect(frame).not.toHaveProperty('displayName')
      expect(Object.keys(frame).sort()).not.toContain('displayName')
    }
  })

  it('encodePing produces a bare ping frame', () => {
    expect(JSON.parse(encodePing())).toEqual({ type: 'ping' })
  })

  it('encodeSubscribe / encodeUnsubscribe carry the channel id', () => {
    expect(JSON.parse(encodeSubscribe(4))).toEqual({ type: 'subscribe', channelId: 4 })
    expect(JSON.parse(encodeUnsubscribe(9))).toEqual({ type: 'unsubscribe', channelId: 9 })
  })

  it('encodeMessage carries ONLY channelId + body — no author, no kind', () => {
    // The author is the socket's authenticated user; the server REJECTS a frame
    // that still asserts one, so an author key would break the post outright.
    // A client never asserts `kind` either — a socket post is always `human`
    // server-side; the `agent` kind is server-controlled.
    const frame = JSON.parse(encodeMessage(1, 'hi')) as Record<string, unknown>
    expect(frame).toEqual({ type: 'message', channelId: 1, body: 'hi' })
    expect(Object.keys(frame).sort()).toEqual(['body', 'channelId', 'type'])
  })

  it('encodeMessage trims the body and clamps it to the length cap', () => {
    expect(JSON.parse(encodeMessage(1, '  hi  '))).toMatchObject({ body: 'hi' })
    const overCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN + 20)
    const frame = JSON.parse(encodeMessage(1, overCap)) as { body: string }
    expect(frame.body.length).toBe(MAX_MESSAGE_BODY_LEN)
  })

  it('encodeReact carries ONLY channel/message/emoji — no handle', () => {
    const frame = JSON.parse(encodeReact(2, 7, '👍')) as Record<string, unknown>
    expect(frame).toEqual({ type: 'react', channelId: 2, messageId: 7, emoji: '👍' })
    expect(Object.keys(frame).sort()).toEqual(['channelId', 'emoji', 'messageId', 'type'])
  })

  it('encodeReact trims the emoji and clamps it to its cap', () => {
    expect(JSON.parse(encodeReact(1, 1, '  👍  '))).toMatchObject({ emoji: '👍' })
    const frame = JSON.parse(encodeReact(1, 1, 'x'.repeat(MAX_EMOJI_LEN + 5))) as { emoji: string }
    expect(frame.emoji.length).toBe(MAX_EMOJI_LEN)
  })
})

describe('parseWorkspaceServerMsg', () => {
  it('decodes a roster frame with members', () => {
    const frame = {
      type: 'roster',
      members: [
        { id: 1, displayName: 'Ada', online: true },
        { id: 2, displayName: 'Bo', online: false },
      ],
    }
    expect(parseWorkspaceServerMsg(JSON.stringify(frame))).toEqual(frame)
  })

  it('decodes an empty roster frame', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'roster', members: [] }))).toEqual({
      type: 'roster',
      members: [],
    })
  })

  it('decodes a pong frame', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'pong' }))).toEqual({ type: 'pong' })
  })

  it('decodes an unauthorized frame (no session / expired session)', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'unauthorized' }))).toEqual({
      type: 'unauthorized',
    })
  })

  it('ignores stray fields on an unauthorized frame', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'unauthorized', why: 'x' }))).toEqual({
      type: 'unauthorized',
    })
  })

  it('decodes a live message frame', () => {
    const message = {
      id: 5,
      channelId: 1,
      author: 'Ada',
      body: 'hi',
      kind: 'human',
      createdAt: '2026-08-25T00:00:00.000Z',
    }
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'message', message }))).toEqual({
      type: 'message',
      message,
    })
  })

  it('decodes an agent-kind message frame', () => {
    const message = {
      id: 6,
      channelId: 1,
      author: 'planner',
      body: 'on it',
      kind: 'agent',
      createdAt: '2026-08-25T00:00:01.000Z',
    }
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'message', message }))?.type).toBe(
      'message',
    )
  })

  it('rejects a message frame with an ill-typed or unknown-kind message', () => {
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'message', message: { id: 'x' } })),
    ).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(
        JSON.stringify({
          type: 'message',
          message: { id: 1, channelId: 1, author: 'A', body: 'b', kind: 'bogus', createdAt: 't' },
        }),
      ),
    ).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'message' }))).toBeUndefined()
  })

  it('decodes a channels frame, dropping ill-typed channel entries', () => {
    const raw = JSON.stringify({
      type: 'channels',
      channels: [
        { id: 1, name: 'general', repoId: null, createdAt: 't' },
        { id: 'x', name: 'bad', repoId: null, createdAt: 't' },
        { id: 2, name: 'zmrng-dev', repoId: 'zmrng', createdAt: 't' },
      ],
    })
    expect(parseWorkspaceServerMsg(raw)).toEqual({
      type: 'channels',
      channels: [
        { id: 1, name: 'general', repoId: null, createdAt: 't' },
        { id: 2, name: 'zmrng-dev', repoId: 'zmrng', createdAt: 't' },
      ],
    })
  })

  it('drops ill-typed member entries inside a roster, keeping the valid ones', () => {
    const raw = JSON.stringify({
      type: 'roster',
      members: [
        { id: 1, displayName: 'Ada', online: true },
        { id: 'x', displayName: 'Bad', online: true }, // bad id
        { id: 2, displayName: 3, online: true }, // bad name
        { id: 3, displayName: 'Cy', online: 'yes' }, // bad online
        { id: 4, displayName: 'Di', online: false },
      ],
    })
    expect(parseWorkspaceServerMsg(raw)).toEqual({
      type: 'roster',
      members: [
        { id: 1, displayName: 'Ada', online: true },
        { id: 4, displayName: 'Di', online: false },
      ],
    })
  })

  it('decodes a message frame carrying reactions', () => {
    const message = {
      id: 5,
      channelId: 1,
      author: 'Ada',
      body: 'hi',
      kind: 'human',
      reactions: [{ emoji: '👍', handles: ['Bo', 'Cy'] }],
      createdAt: '2026-08-25T00:00:00.000Z',
    }
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'message', message }))).toEqual({
      type: 'message',
      message,
    })
  })

  it('degrades an ill-typed reactions field on a message to an empty array', () => {
    const raw = JSON.stringify({
      type: 'message',
      message: {
        id: 5,
        channelId: 1,
        author: 'Ada',
        body: 'hi',
        kind: 'human',
        reactions: 'nope',
        createdAt: 't',
      },
    })
    const parsed = parseWorkspaceServerMsg(raw)
    expect(parsed?.type).toBe('message')
    if (parsed?.type === 'message') expect(parsed.message.reactions).toEqual([])
  })

  it('decodes a reaction frame', () => {
    const frame = {
      type: 'reaction',
      channelId: 1,
      messageId: 7,
      reactions: [{ emoji: '👍', handles: ['Ada'] }],
    }
    expect(parseWorkspaceServerMsg(JSON.stringify(frame))).toEqual(frame)
  })

  it('rejects a reaction frame missing ids or reactions, dropping bad entries', () => {
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'reaction', messageId: 1, reactions: [] })),
    ).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'reaction', channelId: 1, messageId: 1 })),
    ).toBeUndefined()
    // Ill-typed entries inside a valid frame are dropped, not fatal.
    const raw = JSON.stringify({
      type: 'reaction',
      channelId: 1,
      messageId: 1,
      reactions: [{ emoji: '👍', handles: ['Ada', 3] }, { emoji: 5, handles: [] }, { nope: true }],
    })
    expect(parseWorkspaceServerMsg(raw)).toEqual({
      type: 'reaction',
      channelId: 1,
      messageId: 1,
      reactions: [{ emoji: '👍', handles: ['Ada'] }],
    })
  })

  it('decodes a new-version frame carrying a string sha', () => {
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'new-version', sha: 'deadbeef' })),
    ).toEqual({ type: 'new-version', sha: 'deadbeef' })
  })

  it('rejects a new-version frame with a missing or non-string sha', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'new-version' }))).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'new-version', sha: 42 })),
    ).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'new-version', sha: null })),
    ).toBeUndefined()
  })

  it('returns undefined for near-miss cases and never throws', () => {
    expect(parseWorkspaceServerMsg('{not json')).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'nope' }))).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'unauthorised' }))).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'roster' }))).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'roster', members: 'x' }))).toBeUndefined()
    expect(parseWorkspaceServerMsg('')).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify(['roster']))).toBeUndefined()
  })
})

describe('KB page encoders (T2, #144)', () => {
  it('encodePageSubscribe / encodePageUnsubscribe carry the page id', () => {
    expect(JSON.parse(encodePageSubscribe(5))).toEqual({ type: 'page.subscribe', pageId: 5 })
    expect(JSON.parse(encodePageUnsubscribe(9))).toEqual({ type: 'page.unsubscribe', pageId: 9 })
  })

  it('encodePageEdit carries ONLY pageId + body, preserving body whitespace', () => {
    // The editor is the socket's authenticated user; an `author` key would be
    // rejected by the server, not ignored.
    const frame = JSON.parse(encodePageEdit(3, '  indented\n')) as Record<string, unknown>
    expect(frame).toEqual({
      type: 'page.edit',
      pageId: 3,
      body: '  indented\n', // NOT trimmed
    })
    expect(Object.keys(frame).sort()).toEqual(['body', 'pageId', 'type'])
  })

  it('encodePageEdit clamps an over-long body to the cap', () => {
    const overCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN + 50)
    const frame = JSON.parse(encodePageEdit(1, overCap)) as { body: string }
    expect(frame.body.length).toBe(MAX_MESSAGE_BODY_LEN)
  })
})

describe('parseWorkspaceServerMsg — KB page frames (T2, #144)', () => {
  const page: KbPage = {
    id: 3,
    spaceId: 1,
    folderId: null,
    title: 'Page',
    body: 'hi',
    author: 'Ada',
    updatedBy: 'Ada',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }

  it('decodes a page.update frame carrying a well-formed page', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'page.update', pageId: 3, page }))).toEqual(
      { type: 'page.update', pageId: 3, page },
    )
  })

  it('rejects a page.update with a missing/ill-typed page or pageId', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'page.update', pageId: 3 }))).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'page.update', pageId: '3', page })),
    ).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(
        JSON.stringify({ type: 'page.update', pageId: 3, page: { ...page, body: 5 } }),
      ),
    ).toBeUndefined()
  })

  it('decodes a page.presence frame and drops ill-typed viewer entries', () => {
    const raw = JSON.stringify({
      type: 'page.presence',
      pageId: 3,
      viewers: [
        { id: 1, displayName: 'Ada', online: true },
        { id: 2, displayName: 'Bo' }, // missing online — dropped
        { nope: true }, // junk — dropped
      ],
    })
    expect(parseWorkspaceServerMsg(raw)).toEqual({
      type: 'page.presence',
      pageId: 3,
      viewers: [{ id: 1, displayName: 'Ada', online: true }],
    })
  })

  it('rejects a page.presence with a missing/ill-typed pageId or viewers', () => {
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'page.presence', pageId: 3 })),
    ).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'page.presence', pageId: '3', viewers: [] })),
    ).toBeUndefined()
  })

  it('decodes a space.tree convergence frame carrying a numeric spaceId', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'space.tree', spaceId: 5 }))).toEqual({
      type: 'space.tree',
      spaceId: 5,
    })
  })

  it('rejects a space.tree with a missing/ill-typed spaceId', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'space.tree' }))).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'space.tree', spaceId: '5' })),
    ).toBeUndefined()
  })
})
