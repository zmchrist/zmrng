// Pure, DOM-free sentence buffer for voice TTS. Streamed model `partial` deltas
// arrive token-by-token, but the TTS engine wants whole sentences for natural
// prosody and low first-audio latency. This reducer accumulates deltas and emits
// a sentence only once its boundary is proven, keeping the trailing fragment
// pending until `flush` force-emits the tail (on turn end). Every function takes
// a state and returns a NEW state; nothing mutates its input. Unit-tested — this
// is the highest-value pure logic in the voice feature.

/** The buffer: a `pending` unterminated fragment plus every `flushed` sentence. */
export interface SentenceBuffer {
  pending: string
  flushed: string[]
}

/** Sentence-terminating punctuation. A run of these collapses to one boundary. */
const TERMINATORS = new Set(['.', '!', '?', '…'])

/** The default buffer: nothing pending, nothing flushed. */
export function emptyBuffer(): SentenceBuffer {
  return { pending: '', flushed: [] }
}

/**
 * Segment `text` into completed sentences plus a leftover fragment.
 *
 * A sentence completes at a newline, or at a run of terminator punctuation that
 * is followed by whitespace. When `atEnd` is true (a forced flush), a terminator
 * run at the very end of the buffer and any non-empty trailing fragment are also
 * emitted. When `atEnd` is false, an end-of-buffer terminator is left pending
 * because more text may still arrive (streaming), and a terminator followed by a
 * non-space (e.g. the `.` in `3.14`) is deliberately not split — a documented
 * naive tolerance shared with abbreviations.
 */
function segment(text: string, atEnd: boolean): { ready: string[]; pending: string } {
  const ready: string[] = []
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\n') {
      const seg = text.slice(start, i).trim()
      if (seg) ready.push(seg)
      start = i + 1
      i = start
      continue
    }
    if (TERMINATORS.has(ch)) {
      let j = i
      while (j < text.length && TERMINATORS.has(text[j])) j++
      const next = text[j] // char after the terminator run, or undefined at end
      const boundary = next === undefined ? atEnd : /\s/.test(next)
      if (boundary) {
        const seg = text.slice(start, j).trim()
        if (seg) ready.push(seg)
        start = j
      }
      i = j
      continue
    }
    i++
  }
  const tail = text.slice(start)
  if (atEnd) {
    const seg = tail.trim()
    if (seg) ready.push(seg)
    return { ready, pending: '' }
  }
  return { ready, pending: tail }
}

/**
 * Append a streamed token delta. Returns the buffer's next state and any
 * newly-completed sentences (also appended to `buf.flushed`).
 */
export function push(buf: SentenceBuffer, delta: string): { buf: SentenceBuffer; ready: string[] } {
  const { ready, pending } = segment(buf.pending + delta, false)
  return { buf: { pending, flushed: [...buf.flushed, ...ready] }, ready }
}

/**
 * Force-emit the trailing fragment (call on turn end). Returns the drained
 * buffer and whatever remained pending as the final sentence(s).
 */
export function flush(buf: SentenceBuffer): { buf: SentenceBuffer; ready: string[] } {
  const { ready } = segment(buf.pending, true)
  return { buf: { pending: '', flushed: [...buf.flushed, ...ready] }, ready }
}
