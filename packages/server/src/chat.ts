// Parsing for the optional agent-chat adapter (U4). The chat proxy relays the
// upstream bytes to the client untouched (the client parses for live tokens),
// but the server also needs the *clean* assistant text to persist so a reloaded
// conversation renders real prose, not raw `data:` framing. These helpers turn
// a streamed HTTP body (SSE `data:` frames or raw chunked text) into that text.

/**
 * Pull a text delta out of one already-JSON-parsed SSE `data:` payload,
 * tolerating the common OpenAI-compatible and plain shapes. Returns '' when the
 * object carries no recognisable text (e.g. a role-only opening delta).
 */
function extractDelta(obj: unknown): string {
  if (typeof obj === 'string') return obj
  if (!obj || typeof obj !== 'object') return ''
  const o = obj as Record<string, unknown>
  const choices = o.choices
  if (Array.isArray(choices) && choices.length) {
    const c = choices[0] as Record<string, unknown>
    const delta = c.delta as Record<string, unknown> | undefined
    if (delta && typeof delta.content === 'string') return delta.content
    const message = c.message as Record<string, unknown> | undefined
    if (message && typeof message.content === 'string') return message.content
    if (typeof c.text === 'string') return c.text
  }
  if (typeof o.content === 'string') return o.content
  if (typeof o.text === 'string') return o.text
  if (typeof o.delta === 'string') return o.delta
  return ''
}

/**
 * Extract the clean text carried by one SSE `data:` payload string. Per the SSE
 * spec a single leading space after the colon is stripped before use.
 */
function textFromDataPayload(payload: string): string {
  const body = payload.startsWith(' ') ? payload.slice(1) : payload
  const trimmed = body.trim()
  if (!trimmed || trimmed === '[DONE]') return ''
  try {
    return extractDelta(JSON.parse(trimmed))
  } catch {
    // Not JSON — a plain-text token streamed inside an SSE frame.
    return body
  }
}

/**
 * Reduce a full streamed body to the assistant's clean text. If the body uses
 * SSE `data:` framing, concatenate the extracted deltas; otherwise treat the
 * whole body as raw streamed text. Pure and unit-testable.
 */
export function parseStreamedText(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const dataLines = lines.filter((l) => l.startsWith('data:'))
  if (dataLines.length === 0) return raw
  let out = ''
  for (const line of dataLines) {
    out += textFromDataPayload(line.slice(5))
  }
  return out
}
