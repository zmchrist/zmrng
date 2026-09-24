// Pure wire-protocol helpers for the bottom-dock PTY terminal. Kept out of the
// React component so they are unit-testable without a DOM. The encoders produce
// exactly the frames the server's `parseClientMsg` accepts; `parseServerMsg` is
// a tolerant guard over the server -> client frames.

import type { TermServerMsg } from './types'

/**
 * Encode a client `attach` frame — the first frame a terminal socket sends. It
 * carries the tab's stored `sessionId` (when it has one) so the server reattaches
 * to the live shell instead of spawning a new one, plus the initial geometry so a
 * freshly-spawned PTY starts at the right size. Omit `sessionId` (undefined) for a
 * brand-new tab.
 */
export function encodeAttach(sessionId: string | undefined, cols: number, rows: number): string {
  return sessionId
    ? JSON.stringify({ type: 'attach', sessionId, cols, rows })
    : JSON.stringify({ type: 'attach', cols, rows })
}

/** Client -> server: kill this tab's shell now (no grace window). */
export function encodeClose(): string {
  return JSON.stringify({ type: 'close' })
}

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
  if (obj.type === 'session' && typeof obj.sessionId === 'string') {
    return { type: 'session', sessionId: obj.sessionId }
  }
  if (obj.type === 'data' && typeof obj.data === 'string') {
    return { type: 'data', data: obj.data }
  }
  if (obj.type === 'exit' && (obj.code === null || typeof obj.code === 'number')) {
    return { type: 'exit', code: obj.code }
  }
  return undefined
}
