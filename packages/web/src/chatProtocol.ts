// Pure wire-protocol helpers for the bottom-dock standalone agent chat. Kept out
// of the React component so they are unit-testable without a DOM. The encoders
// produce exactly the frames the server's `parseChatClientMsg` accepts;
// `parseChatServerMsg` is a tolerant guard over the server -> client frames.

import type { Attachment, CaveStyle, ChatServerMsg, EffortLevel, WorkflowPreset } from './types'

/**
 * Encode a client `start` frame — (re)spawn a session with the chosen controls.
 * `repoId` picks which registered repo the session's cwd is rooted at; omit it
 * (or pass `''`) for "Projects root" (`config.projectsDir`, the default).
 * `voice` opts the session into the server's spoken `voiceSystemPrompt` (set
 * only by the Local Voice Chat surface); when falsy the frame is byte-identical
 * to the pre-voice one, so the text chat path is unchanged. `workflow` names an
 * optional working-mode preset; it is omitted when `'none'`/falsy (same as
 * `repoId`/`voice`), so a default frame stays byte-identical to the pre-workflow one.
 */
export function encodeStart(
  model: string,
  effort: EffortLevel,
  style: CaveStyle,
  repoId?: string,
  voice?: boolean,
  workflow?: WorkflowPreset,
): string {
  return JSON.stringify({
    type: 'start',
    model,
    effort,
    style,
    ...(repoId ? { repoId } : {}),
    ...(voice ? { voice: true } : {}),
    ...(workflow && workflow !== 'none' ? { workflow } : {}),
  })
}

/** Encode a client `input` frame (one operator turn -> server), optionally with attachments. */
export function encodeInput(text: string, attachments?: Attachment[]): string {
  return attachments && attachments.length > 0
    ? JSON.stringify({ type: 'input', text, attachments })
    : JSON.stringify({ type: 'input', text })
}

/** Encode a client `interrupt` frame (stop the in-flight turn). */
export function encodeInterrupt(): string {
  return JSON.stringify({ type: 'interrupt' })
}

/**
 * Tolerantly parse a server -> client chat frame. Malformed JSON, non-object
 * values, unknown `type`, or ill-typed fields all return `undefined` — this
 * never throws on a stray frame (mirrors `terminalProtocol.parseServerMsg`).
 */
export function parseChatServerMsg(raw: string): ChatServerMsg | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const obj = parsed as Record<string, unknown>
  switch (obj.type) {
    case 'ready':
      return typeof obj.sessionId === 'string' ? { type: 'ready', sessionId: obj.sessionId } : undefined
    case 'partial':
      return typeof obj.text === 'string' ? { type: 'partial', text: obj.text } : undefined
    case 'assistant':
      return typeof obj.text === 'string' ? { type: 'assistant', text: obj.text } : undefined
    case 'tool':
      return typeof obj.name === 'string' &&
        typeof obj.summary === 'string' &&
        typeof obj.actor === 'string' &&
        typeof obj.isSubagent === 'boolean'
        ? {
            type: 'tool',
            name: obj.name,
            summary: obj.summary,
            actor: obj.actor,
            isSubagent: obj.isSubagent,
          }
        : undefined
    case 'result':
      return typeof obj.isError === 'boolean' ? { type: 'result', isError: obj.isError } : undefined
    case 'exit':
      return obj.code === null || typeof obj.code === 'number'
        ? { type: 'exit', code: obj.code }
        : undefined
    case 'error':
      return typeof obj.text === 'string' ? { type: 'error', text: obj.text } : undefined
    default:
      return undefined
  }
}
