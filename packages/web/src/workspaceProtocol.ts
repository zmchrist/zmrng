// Pure wire-protocol helpers for the ONE multiplexed team-workspace socket
// (GET /ws/workspace). Kept out of the React component so they are unit-testable
// without a DOM. The encoders produce exactly the frames the server's
// `parseWorkspaceClientMsg` accepts; `parseWorkspaceServerMsg` is a tolerant
// guard over the server -> client frames (mirrors `chatProtocol.ts`).

import { MAX_DISPLAY_NAME_LEN, MAX_MESSAGE_BODY_LEN } from './types'
import type { Channel, Message, WorkspaceMember, WsWorkspaceServerMsg } from './types'

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

/** Narrow an untyped message object to a `Message`, or `undefined`. */
function asMessage(v: unknown): Message | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  const kind = obj.kind
  if (kind !== 'human' && kind !== 'agent') return undefined
  return typeof obj.id === 'number' &&
    typeof obj.channelId === 'number' &&
    typeof obj.author === 'string' &&
    typeof obj.body === 'string' &&
    typeof obj.createdAt === 'string'
    ? {
        id: obj.id,
        channelId: obj.channelId,
        author: obj.author,
        body: obj.body,
        kind,
        createdAt: obj.createdAt,
      }
    : undefined
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
    case 'channels': {
      if (!Array.isArray(obj.channels)) return undefined
      const channels = obj.channels
        .map(asChannel)
        .filter((c): c is Channel => c !== undefined)
      return { type: 'channels', channels }
    }
    default:
      return undefined
  }
}
