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
import { MAX_DISPLAY_NAME_LEN, MAX_MESSAGE_BODY_LEN, MAX_EMOJI_LEN } from '../src/types'
import type { KbBlock } from '../src/types'

describe('client encoders', () => {
  it('encodeHello produces a hello frame carrying the display name', () => {
    expect(JSON.parse(encodeHello('Ada'))).toEqual({ type: 'hello', displayName: 'Ada' })
  })

  it('encodeHello trims surrounding whitespace from the display name', () => {
    expect(JSON.parse(encodeHello('  Ada  '))).toEqual({ type: 'hello', displayName: 'Ada' })
  })

  it('encodeHello clamps an over-long name to the length cap (post-trim)', () => {
    const overCap = `  ${'a'.repeat(MAX_DISPLAY_NAME_LEN + 50)}  `
    const frame = JSON.parse(encodeHello(overCap)) as { type: string; displayName: string }
    expect(frame.type).toBe('hello')
    expect(frame.displayName).toBe('a'.repeat(MAX_DISPLAY_NAME_LEN))
    expect(frame.displayName.length).toBe(MAX_DISPLAY_NAME_LEN)
  })

  it('encodePing produces a bare ping frame', () => {
    expect(JSON.parse(encodePing())).toEqual({ type: 'ping' })
  })

  it('encodeSubscribe / encodeUnsubscribe carry the channel id', () => {
    expect(JSON.parse(encodeSubscribe(4))).toEqual({ type: 'subscribe', channelId: 4 })
    expect(JSON.parse(encodeUnsubscribe(9))).toEqual({ type: 'unsubscribe', channelId: 9 })
  })

  it('encodeMessage produces a message frame with author/body and NO kind', () => {
    // A client never asserts `kind` — a socket post is always `human`
    // server-side; the `agent` kind is server-controlled (future T4).
    expect(JSON.parse(encodeMessage(1, 'Ada', 'hi'))).toEqual({
      type: 'message',
      channelId: 1,
      author: 'Ada',
      body: 'hi',
    })
  })

  it('encodeMessage trims the body and clamps it to the length cap', () => {
    expect(JSON.parse(encodeMessage(1, 'Ada', '  hi  '))).toMatchObject({ body: 'hi' })
    const overCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN + 20)
    const frame = JSON.parse(encodeMessage(1, 'Ada', overCap)) as { body: string }
    expect(frame.body.length).toBe(MAX_MESSAGE_BODY_LEN)
  })

  it('encodeReact produces a react frame with channel/message/handle/emoji', () => {
    expect(JSON.parse(encodeReact(2, 7, 'Ada', '👍'))).toEqual({
      type: 'react',
      channelId: 2,
      messageId: 7,
      handle: 'Ada',
      emoji: '👍',
    })
  })

  it('encodeReact trims handle + emoji and clamps them to their caps', () => {
    expect(JSON.parse(encodeReact(1, 1, '  Ada  ', '  👍  '))).toMatchObject({
      handle: 'Ada',
      emoji: '👍',
    })
    const frame = JSON.parse(
      encodeReact(1, 1, 'a'.repeat(MAX_DISPLAY_NAME_LEN + 5), 'x'.repeat(MAX_EMOJI_LEN + 5)),
    ) as { handle: string; emoji: string }
    expect(frame.handle.length).toBe(MAX_DISPLAY_NAME_LEN)
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

  it('encodePageEdit produces a create frame (blockId null) preserving body whitespace', () => {
    expect(
      JSON.parse(encodePageEdit(3, null, 'code', '  indented\n', '{"lang":"ts"}', '  Ada  ')),
    ).toEqual({
      type: 'page.edit',
      pageId: 3,
      blockId: null,
      kind: 'code',
      body: '  indented\n', // NOT trimmed
      meta: '{"lang":"ts"}',
      author: 'Ada', // trimmed + clamped
    })
  })

  it('encodePageEdit produces an update frame (non-null blockId) with null meta', () => {
    expect(JSON.parse(encodePageEdit(3, 12, 'text', 'hello', null, 'Bo'))).toEqual({
      type: 'page.edit',
      pageId: 3,
      blockId: 12,
      kind: 'text',
      body: 'hello',
      meta: null,
      author: 'Bo',
    })
  })

  it('encodePageEdit clamps an over-long body to the cap', () => {
    const overCap = 'a'.repeat(MAX_MESSAGE_BODY_LEN + 50)
    const frame = JSON.parse(encodePageEdit(1, null, 'text', overCap, null, 'Ada')) as {
      body: string
    }
    expect(frame.body.length).toBe(MAX_MESSAGE_BODY_LEN)
  })
})

describe('parseWorkspaceServerMsg — KB page frames (T2, #144)', () => {
  const block: KbBlock = {
    id: 7,
    pageId: 3,
    ord: 0,
    kind: 'text',
    body: 'hi',
    meta: null,
    updatedAt: '2026-09-10T00:00:00.000Z',
    updatedBy: 'Ada',
  }

  it('decodes a page.update frame carrying a well-formed block', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'page.update', pageId: 3, block }))).toEqual(
      { type: 'page.update', pageId: 3, block },
    )
  })

  it('rejects a page.update with a missing/ill-typed block or pageId', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'page.update', pageId: 3 }))).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(JSON.stringify({ type: 'page.update', pageId: '3', block })),
    ).toBeUndefined()
    expect(
      parseWorkspaceServerMsg(
        JSON.stringify({ type: 'page.update', pageId: 3, block: { ...block, kind: 'bogus' } }),
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
})
