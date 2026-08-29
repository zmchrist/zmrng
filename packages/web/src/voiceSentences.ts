// Pure, DOM-free sentence buffer for voice TTS. Streamed model `partial` deltas
// arrive token-by-token, but the TTS engine wants whole-ish chunks for natural
// prosody. To make the agent start SPEAKING as soon as text starts arriving —
// not only after the whole reply is printed — this reducer emits a chunk as soon
// as its boundary is proven, at three granularities (highest → lowest priority):
//
//   1. a hard sentence end   — `.`/`!`/`?`/`…` (a run) followed by whitespace, or
//                              a newline. Preferred boundary, best prosody.
//   2. a clause boundary     — `,`/`;`/`:` followed by whitespace, once the chunk
//                              is at least MIN_CLAUSE_CHARS long. Lets speech begin
//                              within the FIRST clause of a long sentence instead
//                              of waiting for the sentence to finish.
//   3. a length-cap fallback — a run with no punctuation at all (common in the
//                              terse caveman register) force-emits at a word
//                              boundary once it passes MAX_CHUNK_CHARS, so speech
//                              still starts mid-stream instead of at turn end.
//
// FIRST-CHUNK FAST PATH: the single biggest source of perceived lag is
// time-to-first-audio — the agent can't be heard until its first chunk has been
// synthesized (Kokoro inference is hundreds of ms), and a bigger first chunk means
// a longer wait before ANY sound. So while nothing has been emitted yet this turn
// (`flushed` still empty), the clause-length gate and the length cap both drop to
// much smaller values (FIRST_*), so the first few words leave for the synth engine
// almost immediately; every subsequent chunk uses the normal, prosody-friendly
// thresholds.
//
// The trailing fragment stays pending until `flush` force-emits the tail (on turn
// end). Every function takes a state and returns a NEW state; nothing mutates its
// input. Unit-tested — this is the highest-value pure logic in the voice feature.

/** The buffer: a `pending` unterminated fragment plus every `flushed` sentence. */
export interface SentenceBuffer {
  pending: string
  flushed: string[]
}

/** Sentence-terminating punctuation. A run of these collapses to one boundary. */
const TERMINATORS = new Set(['.', '!', '?', '…'])

/** Clause punctuation — a lower-priority mid-sentence boundary for early speech. */
const CLAUSE = new Set([',', ';', ':'])

/**
 * Minimum trimmed length before a clause boundary is allowed to split. Keeps
 * tiny leading clauses ("Hi,", "OK,") glued to what follows instead of synthesizing
 * a choppy one-word chunk.
 */
const MIN_CLAUSE_CHARS = 12

/**
 * A run with no boundary of any kind is force-split at the last whitespace once it
 * grows past this length. Bounds first-audio latency for unpunctuated (caveman)
 * replies that would otherwise stay wholly pending until turn end.
 */
const MAX_CHUNK_CHARS = 60

/**
 * First-chunk-only thresholds (used while `flushed` is still empty). Much lower so
 * the agent's first words go to the synth engine as fast as possible — this is what
 * kills the "text is already on screen but no sound yet" lag. After the first chunk
 * leaves, the normal thresholds above take over for natural prosody.
 */
const FIRST_MIN_CLAUSE_CHARS = 6
const FIRST_MAX_CHUNK_CHARS = 24

/** The default buffer: nothing pending, nothing flushed. */
export function emptyBuffer(): SentenceBuffer {
  return { pending: '', flushed: [] }
}

/**
 * Segment `text` into completed chunks plus a leftover fragment.
 *
 * A chunk completes at a newline; at a run of terminator punctuation followed by
 * whitespace; at a clause punctuation followed by whitespace once the chunk is at
 * least `MIN_CLAUSE_CHARS`; or, as a fallback, at a whitespace boundary once the
 * chunk has grown past `MAX_CHUNK_CHARS` with no other boundary. When `atEnd` is
 * true (a forced flush), a terminator run at the very end of the buffer and any
 * non-empty trailing fragment are also emitted. When `atEnd` is false, an
 * end-of-buffer terminator is left pending because more text may still arrive
 * (streaming), and a terminator followed by a non-space (e.g. the `.` in `3.14`)
 * is deliberately not split — a documented naive tolerance shared with
 * abbreviations.
 *
 * `hasFlushed` is whether any chunk was already emitted this turn. While it is
 * false AND nothing has been emitted yet in this call, the first-chunk fast-path
 * thresholds apply, so the agent's opening words leave for synthesis quickly.
 */
function segment(
  text: string,
  atEnd: boolean,
  hasFlushed: boolean,
): { ready: string[]; pending: string } {
  const ready: string[] = []
  let start = 0
  let i = 0
  // The first chunk of a turn uses lower gates to minimize time-to-first-audio.
  const first = () => !hasFlushed && ready.length === 0
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
    if (CLAUSE.has(ch)) {
      const next = text[i + 1] // char after the clause punctuation, or undefined
      const atBoundary = next === undefined ? atEnd : /\s/.test(next)
      const minClause = first() ? FIRST_MIN_CLAUSE_CHARS : MIN_CLAUSE_CHARS
      const seg = text.slice(start, i + 1).trim()
      if (atBoundary && seg.length >= minClause) {
        ready.push(seg)
        start = i + 1
      }
      i++
      continue
    }
    const cap = first() ? FIRST_MAX_CHUNK_CHARS : MAX_CHUNK_CHARS
    if (/\s/.test(ch) && i - start >= cap) {
      const seg = text.slice(start, i).trim()
      if (seg) ready.push(seg)
      start = i
      i++
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
  const { ready, pending } = segment(buf.pending + delta, false, buf.flushed.length > 0)
  return { buf: { pending, flushed: [...buf.flushed, ...ready] }, ready }
}

/**
 * Force-emit the trailing fragment (call on turn end). Returns the drained
 * buffer and whatever remained pending as the final sentence(s).
 */
export function flush(buf: SentenceBuffer): { buf: SentenceBuffer; ready: string[] } {
  const { ready } = segment(buf.pending, true, buf.flushed.length > 0)
  return { buf: { pending: '', flushed: [...buf.flushed, ...ready] }, ready }
}

/**
 * Strip markdown / formatting punctuation that the TTS engine would otherwise
 * pronounce literally (Kokoro says "asterisk" for `*`, "underscore" for `_`, and
 * so on). This is applied ONLY to the text handed to the synth engine — the
 * on-screen transcript keeps its original characters. Emphasis/inline-code/heading
 * markers carry no spoken meaning, so they are removed and any doubled spaces they
 * leave behind are collapsed.
 *
 * The star of the show is `*` (the model constantly emits `**bold**` / bullet
 * `* item` that read as "asterisk"); the sibling markers `_ \` ~ #` are stripped
 * for the same reason. Sentence/clause punctuation (`. , ! ? : ;`) is deliberately
 * kept — it drives prosody. Returns a trimmed string, possibly empty.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/[*_`~#]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
