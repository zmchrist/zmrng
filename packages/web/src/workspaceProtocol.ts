// Pure wire-protocol helpers for the ONE multiplexed team-workspace socket
// (GET /ws/workspace). Kept out of the React component so they are unit-testable
// without a DOM. The encoders produce exactly the frames the server's
// `parseWorkspaceClientMsg` accepts; `parseWorkspaceServerMsg` is a tolerant
// guard over the server -> client frames (mirrors `chatProtocol.ts`).

import { MAX_DISPLAY_NAME_LEN } from './types'
import type { WorkspaceMember, WsWorkspaceServerMsg } from './types'

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
    default:
      return undefined
  }
}
