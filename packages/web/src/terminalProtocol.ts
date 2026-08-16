// Pure wire-protocol helpers for the bottom-dock PTY terminal. Kept out of the
// React component so they are unit-testable without a DOM. The encoders produce
// exactly the frames the server's `parseClientMsg` accepts; `parseServerMsg` is
// a tolerant guard over the server -> client frames.

import type { TermServerMsg } from './types'

/** Encode a client `input` frame (raw keystrokes -> server). */
export function encodeInput(data: string): string {
  return JSON.stringify({ type: 'input', data })
}

/** Encode a client `resize` frame (terminal geometry -> server). */
export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows })
}

/**
 * Tolerantly parse a server -> client terminal frame. Malformed JSON,
 * non-object values, unknown `type`, or ill-typed fields all return
 * `undefined` — this never throws on a stray frame.
 */
export function parseServerMsg(raw: string): TermServerMsg | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const obj = parsed as Record<string, unknown>
  if (obj.type === 'data' && typeof obj.data === 'string') {
    return { type: 'data', data: obj.data }
  }
  if (obj.type === 'exit' && (obj.code === null || typeof obj.code === 'number')) {
    return { type: 'exit', code: obj.code }
  }
  return undefined
}
