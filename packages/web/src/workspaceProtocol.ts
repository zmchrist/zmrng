// Pure wire-protocol helpers for the ONE multiplexed team-workspace socket
// (GET /ws/workspace). Kept out of the React component so they are unit-testable
// without a DOM. The encoders produce exactly the frames the server's
// `parseWorkspaceClientMsg` accepts; `parseWorkspaceServerMsg` is a tolerant
// guard over the server -> client frames (mirrors `chatProtocol.ts`).

import { MAX_DISPLAY_NAME_LEN, MAX_MESSAGE_BODY_LEN, MAX_EMOJI_LEN, KB_BLOCK_KINDS } from './types'
import type {
  Channel,
  KbBlock,
  KbBlockKind,
  Message,
  ReactionSummary,
  WorkspaceMember,
  WsWorkspaceServerMsg,
} from './types'

/**
 * Encode a client `hello` frame — self-assert a display name on first connect.
 * The name is trimmed and clamped to `MAX_DISPLAY_NAME_LEN` so an over-long
 * handle never reaches the wire (the server rejects it too — this is the
 * fast-feedback client mirror of that guard).
 */
export function encodeHello(displayName: string): string {
  return JSON.stringify({
    type: 'hello',
    displayName: displayName.trim().slice(0, MAX_DISPLAY_NAME_LEN),
  })
}

/** Encode a client `ping` heartbeat frame (the server answers with `pong`). */
export function encodePing(): string {
  return JSON.stringify({ type: 'ping' })
}

/** Encode a `subscribe` frame — register interest in a channel's live fan-out. */
export function encodeSubscribe(channelId: number): string {
  return JSON.stringify({ type: 'subscribe', channelId })
}

/** Encode an `unsubscribe` frame — drop interest as the channel closes. */
export function encodeUnsubscribe(channelId: number): string {
  return JSON.stringify({ type: 'unsubscribe', channelId })
}

/**
 * Encode a `message` frame — post to a channel. The body is trimmed and clamped
 * to `MAX_MESSAGE_BODY_LEN` (the client mirror of the server's guard). No `kind`
 * is sent — a socket post is always persisted as `human` server-side; the
 * `agent` kind is server-controlled and can never be asserted by a client.
 */
export function encodeMessage(channelId: number, author: string, body: string): string {
  return JSON.stringify({
    type: 'message',
    channelId,
    author: author.trim().slice(0, MAX_DISPLAY_NAME_LEN),
    body: body.trim().slice(0, MAX_MESSAGE_BODY_LEN),
  })
}

/**
 * Encode a `react` frame — toggle the reactor's emoji on one message. The
 * `handle` and `emoji` are trimmed and clamped to their caps (the client mirror
 * of the server's guard). Toggle semantics are server-side: the server adds the
 * reaction if absent, removes it if the same `(message, handle, emoji)` exists.
 */
export function encodeReact(
  channelId: number,
  messageId: number,
  handle: string,
  emoji: string,
): string {
  return JSON.stringify({
    type: 'react',
    channelId,
    messageId,
    handle: handle.trim().slice(0, MAX_DISPLAY_NAME_LEN),
    emoji: emoji.trim().slice(0, MAX_EMOJI_LEN),
  })
}

// ---- KB real-time sync encoders (T2, #144) ---------------------------------

/** Encode a `page.subscribe` frame — register interest in a page's live fan-out. */
export function encodePageSubscribe(pageId: number): string {
  return JSON.stringify({ type: 'page.subscribe', pageId })
}

/** Encode a `page.unsubscribe` frame — drop interest as the page closes. */
export function encodePageUnsubscribe(pageId: number): string {
  return JSON.stringify({ type: 'page.unsubscribe', pageId })
}

/**
 * Encode a `page.edit` frame — a block delta on save. `blockId: null` creates a
 * new block (appended server-side); a non-null `blockId` updates that block. The
 * `body` is clamped to `MAX_MESSAGE_BODY_LEN` but NOT trimmed (block whitespace
 * is meaningful); `author` is trimmed + clamped (the client mirror of the
 * server's guard). A socket edit is always a human author.
 */
export function encodePageEdit(
  pageId: number,
  blockId: number | null,
  kind: KbBlockKind,
  body: string,
  meta: string | null,
  author: string,
): string {
  return JSON.stringify({
    type: 'page.edit',
    pageId,
    blockId,
    kind,
    body: body.slice(0, MAX_MESSAGE_BODY_LEN),
    meta,
    author: author.trim().slice(0, MAX_DISPLAY_NAME_LEN),
  })
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** Narrow one untyped roster entry to a `WorkspaceMember`, or `undefined`. */
function asMember(v: unknown): WorkspaceMember | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  return typeof obj.id === 'number' &&
    typeof obj.displayName === 'string' &&
    typeof obj.online === 'boolean'
    ? { id: obj.id, displayName: obj.displayName, online: obj.online }
    : undefined
}

/** Narrow one untyped channel entry to a `Channel`, or `undefined`. */
function asChannel(v: unknown): Channel | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  const repoId = obj.repoId
  if (repoId !== null && typeof repoId !== 'string') return undefined
  return typeof obj.id === 'number' &&
    typeof obj.name === 'string' &&
    typeof obj.createdAt === 'string'
    ? { id: obj.id, name: obj.name, repoId, createdAt: obj.createdAt }
    : undefined
}

/** Narrow one untyped reaction entry to a `ReactionSummary`, or `undefined`. */
function asReaction(v: unknown): ReactionSummary | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  if (typeof obj.emoji !== 'string' || !Array.isArray(obj.handles)) return undefined
  const handles = obj.handles.filter((h): h is string => typeof h === 'string')
  return { emoji: obj.emoji, handles }
}

/** Narrow an untyped reactions array (ill-typed entries dropped), or `undefined`. */
function asReactions(v: unknown): ReactionSummary[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.map(asReaction).filter((r): r is ReactionSummary => r !== undefined)
}

/** Narrow an untyped message object to a `Message`, or `undefined`. */
function asMessage(v: unknown): Message | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  const kind = obj.kind
  if (kind !== 'human' && kind !== 'agent') return undefined
  if (
    typeof obj.id !== 'number' ||
    typeof obj.channelId !== 'number' ||
    typeof obj.author !== 'string' ||
    typeof obj.body !== 'string' ||
    typeof obj.createdAt !== 'string'
  ) {
    return undefined
  }
  // `reactions` is optional on the wire — a fresh message omits it. A present
  // but ill-typed value degrades to an empty set rather than failing the frame.
  const reactions = obj.reactions === undefined ? undefined : (asReactions(obj.reactions) ?? [])
  return {
    id: obj.id,
    channelId: obj.channelId,
    author: obj.author,
    body: obj.body,
    kind,
    ...(reactions !== undefined ? { reactions } : {}),
    createdAt: obj.createdAt,
  }
}

/** Narrow one untyped block object to a `KbBlock`, or `undefined` (T2). */
function asBlock(v: unknown): KbBlock | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  const kind = obj.kind
  if (typeof kind !== 'string' || !(KB_BLOCK_KINDS as readonly string[]).includes(kind))
    return undefined
  const meta = obj.meta
  if (meta !== null && typeof meta !== 'string') return undefined
  if (
    typeof obj.id !== 'number' ||
    typeof obj.pageId !== 'number' ||
    typeof obj.ord !== 'number' ||
    typeof obj.body !== 'string' ||
    typeof obj.updatedAt !== 'string' ||
    typeof obj.updatedBy !== 'string'
  ) {
    return undefined
  }
  return {
    id: obj.id,
    pageId: obj.pageId,
    ord: obj.ord,
    // `includes` above validates membership but doesn't narrow the `string`;
    // the cast is safe because we just confirmed `kind` is a KbBlockKind.
    kind: kind as KbBlockKind,
    body: obj.body,
    meta,
    updatedAt: obj.updatedAt,
    updatedBy: obj.updatedBy,
  }
}

/**
 * Tolerantly parse a server -> client workspace frame. Malformed JSON, non-object
 * values, unknown `type`, or ill-typed fields all return `undefined` — this never
 * throws on a stray frame. Ill-typed member entries inside a `roster` are dropped
 * individually rather than failing the whole frame.
 */
export function parseWorkspaceServerMsg(raw: string): WsWorkspaceServerMsg | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const obj = asRecord(parsed)
  if (!obj) return undefined
  switch (obj.type) {
    case 'roster': {
      if (!Array.isArray(obj.members)) return undefined
      const members = obj.members
        .map(asMember)
        .filter((m): m is WorkspaceMember => m !== undefined)
      return { type: 'roster', members }
    }
    case 'pong':
      return { type: 'pong' }
    case 'message': {
      const message = asMessage(obj.message)
      return message ? { type: 'message', message } : undefined
    }
    case 'reaction': {
      const reactions = asReactions(obj.reactions)
      return typeof obj.channelId === 'number' &&
        typeof obj.messageId === 'number' &&
        reactions !== undefined
        ? { type: 'reaction', channelId: obj.channelId, messageId: obj.messageId, reactions }
        : undefined
    }
    case 'channels': {
      if (!Array.isArray(obj.channels)) return undefined
      const channels = obj.channels
        .map(asChannel)
        .filter((c): c is Channel => c !== undefined)
      return { type: 'channels', channels }
    }
    case 'new-version':
      return typeof obj.sha === 'string' ? { type: 'new-version', sha: obj.sha } : undefined
    case 'page.update': {
      const block = asBlock(obj.block)
      return typeof obj.pageId === 'number' && block
        ? { type: 'page.update', pageId: obj.pageId, block }
        : undefined
    }
    case 'page.presence': {
      if (typeof obj.pageId !== 'number' || !Array.isArray(obj.viewers)) return undefined
      const viewers = obj.viewers
        .map(asMember)
        .filter((m): m is WorkspaceMember => m !== undefined)
      return { type: 'page.presence', pageId: obj.pageId, viewers }
    }
    case 'page.delete':
      return typeof obj.pageId === 'number' && typeof obj.blockId === 'number'
        ? { type: 'page.delete', pageId: obj.pageId, blockId: obj.blockId }
        : undefined
    default:
      return undefined
  }
}
