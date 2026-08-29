import { describe, it, expect } from 'vitest'
import { emptyBuffer, push, flush, sanitizeForSpeech, type SentenceBuffer } from '../src/voiceSentences'

describe('voiceSentences', () => {
  it('emptyBuffer starts empty', () => {
    const buf = emptyBuffer()
    expect(buf.pending).toBe('')
    expect(buf.flushed).toEqual([])
  })

  it('holds a fragment with no terminator as pending, emitting nothing', () => {
    const r = push(emptyBuffer(), 'Hello there')
    expect(r.ready).toEqual([])
    expect(r.buf.pending).toBe('Hello there')
    expect(r.buf.flushed).toEqual([])
  })

  it('does not emit a sentence until the terminator is followed by whitespace', () => {
    // A terminator at the very end of the buffer is ambiguous (more may come),
    // so it stays pending until the next delta proves the boundary.
    const r1 = push(emptyBuffer(), 'Hello world.')
    expect(r1.ready).toEqual([])
    expect(r1.buf.pending).toBe('Hello world.')

    const r2 = push(r1.buf, ' Next one')
    expect(r2.ready).toEqual(['Hello world.'])
    expect(r2.buf.pending.trim()).toBe('Next one')
  })

  it('splits a multi-sentence delta on ! and ? terminators', () => {
    const r = push(emptyBuffer(), 'One. Two! Three? four')
    expect(r.ready).toEqual(['One.', 'Two!', 'Three?'])
    expect(r.buf.pending.trim()).toBe('four')
  })

  it('treats a newline as a sentence boundary', () => {
    const r = push(emptyBuffer(), 'Line one\nLine two')
    expect(r.ready).toEqual(['Line one'])
    expect(r.buf.pending).toBe('Line two')
  })

  it('does not over-split a decimal number (terminator followed by a digit)', () => {
    const r = push(emptyBuffer(), 'Pi is 3.14 for now')
    expect(r.ready).toEqual([])
    expect(r.buf.pending).toBe('Pi is 3.14 for now')
  })

  it('collapses a run of terminators / ellipsis into one boundary', () => {
    const r = push(emptyBuffer(), 'Really?!! Well… ok')
    expect(r.ready).toEqual(['Really?!!', 'Well…'])
    expect(r.buf.pending.trim()).toBe('ok')
  })

  it('accumulates across pushes then completes a sentence', () => {
    let buf: SentenceBuffer = emptyBuffer()
    const a = push(buf, 'The quick ')
    expect(a.ready).toEqual([])
    buf = a.buf
    const b = push(buf, 'brown fox jumped. ')
    expect(b.ready).toEqual(['The quick brown fox jumped.'])
    buf = b.buf
    expect(buf.pending.trim()).toBe('')
  })

  it('flush emits the trailing fragment even without a terminator', () => {
    const r1 = push(emptyBuffer(), 'A dangling tail')
    expect(r1.ready).toEqual([])
    const r2 = flush(r1.buf)
    expect(r2.ready).toEqual(['A dangling tail'])
    expect(r2.buf.pending).toBe('')
  })

  it('flush emits a pending terminated sentence (end-of-buffer boundary)', () => {
    const r1 = push(emptyBuffer(), 'Done here.')
    expect(r1.ready).toEqual([])
    const r2 = flush(r1.buf)
    expect(r2.ready).toEqual(['Done here.'])
    expect(r2.buf.pending).toBe('')
  })

  it('flush on an empty buffer emits nothing', () => {
    const r = flush(emptyBuffer())
    expect(r.ready).toEqual([])
    expect(r.buf.pending).toBe('')
  })

  it('accumulates every emitted sentence in flushed', () => {
    const r1 = push(emptyBuffer(), 'First. Second. ')
    expect(r1.ready).toEqual(['First.', 'Second.'])
    const r2 = flush(r1.buf)
    expect(r1.buf.flushed).toEqual(['First.', 'Second.'])
    expect(r2.buf.flushed).toEqual(['First.', 'Second.'])
  })

  // --- early-speech boundaries: start speaking before the sentence finishes ---

  it('emits an early chunk at a clause boundary once long enough', () => {
    // The first clause speaks as soon as its comma + whitespace prove the
    // boundary, instead of waiting for the sentence-ending period.
    const r = push(emptyBuffer(), 'When the model streams, more text follows')
    expect(r.ready).toEqual(['When the model streams,'])
    expect(r.buf.pending.trim()).toBe('more text follows')
  })

  it('does not split a tiny leading clause below the minimum length', () => {
    const r = push(emptyBuffer(), 'Hi, there friend')
    expect(r.ready).toEqual([])
    expect(r.buf.pending).toBe('Hi, there friend')
  })

  it('splits on semicolon and colon clause boundaries', () => {
    const r1 = push(emptyBuffer(), 'One consideration here; another follows')
    expect(r1.ready).toEqual(['One consideration here;'])
    const r2 = push(emptyBuffer(), 'The plan is as follows: do the thing')
    expect(r2.ready).toEqual(['The plan is as follows:'])
  })

  it('force-emits an unpunctuated run once it passes the length cap', () => {
    // Terse caveman replies often carry no terminators at all — without a cap
    // nothing would speak until turn end. The cap emits at a word boundary.
    const long =
      'look good fix now then rebuild app and ship the whole thing right away please'
    const r = push(emptyBuffer(), long)
    expect(r.ready.length).toBeGreaterThan(0)
    // Every emitted chunk breaks on whitespace (no mid-word cuts).
    for (const chunk of r.ready) expect(chunk).not.toMatch(/\s{2,}/)
    // The tail is still shorter than the cap and stays pending.
    expect(r.buf.pending.length).toBeLessThan(60)
  })

  // --- first-chunk fast path: minimize time-to-first-audio ---

  it('force-emits the first unpunctuated chunk at the lower first-chunk cap', () => {
    // Nothing spoken yet → the first chunk force-splits past ~24 chars (not 60),
    // so the agent starts talking almost immediately on an unpunctuated stream.
    const r = push(emptyBuffer(), 'look good fix now rebuild the whole app then ship it')
    expect(r.ready.length).toBe(1)
    expect(r.ready[0].length).toBeLessThanOrEqual(30)
    expect(r.ready[0]).toBe('look good fix now rebuild')
  })

  it('splits the first clause earlier than a later one', () => {
    // First clause needs only FIRST_MIN_CLAUSE_CHARS (6); a later short clause
    // still needs the full MIN_CLAUSE_CHARS (12).
    const r = push(emptyBuffer(), 'okay so, then we keep going and going here, done')
    expect(r.ready[0]).toBe('okay so,')
    // "then we keep going and going here," is ≥ 12 so it also splits.
    expect(r.buf.flushed[0]).toBe('okay so,')
  })

  it('widens back to the normal cap after the first chunk leaves', () => {
    // Once a chunk has been flushed, a subsequent unpunctuated run holds until the
    // full 60-char cap — the fast path is first-chunk-only.
    let buf = emptyBuffer()
    const a = push(buf, 'go now ')
    buf = a.buf
    // Seed a flushed chunk via the first-chunk cap.
    const b = push(buf, 'aaaa bbbb cccc dddd eeee ')
    expect(b.buf.flushed.length).toBeGreaterThan(0)
    buf = b.buf
    // Now a ~40-char unpunctuated tail should NOT emit (under the 60 cap).
    const c = push(buf, 'short tail under sixty chars stays pending')
    expect(c.ready).toEqual([])
  })

  it('takes the terminator boundary and keeps a short trailing clause pending', () => {
    const r = push(emptyBuffer(), 'This is done. Now, the next part begins')
    // "This is done." ends on the period; the trailing "Now," clause is under
    // MIN_CLAUSE_CHARS so it stays with the pending tail rather than splitting.
    expect(r.ready).toEqual(['This is done.'])
    expect(r.buf.pending.trim()).toBe('Now, the next part begins')
  })

  // --- sanitizeForSpeech: never pronounce markdown noise like "asterisk" ---

  it('strips asterisks from bold/bullet markup', () => {
    expect(sanitizeForSpeech('this is **bold** text')).toBe('this is bold text')
    expect(sanitizeForSpeech('* first point')).toBe('first point')
  })

  it('strips underscores, backticks, tildes and hashes', () => {
    expect(sanitizeForSpeech('use _emphasis_ and `code` here')).toBe('use emphasis and code here')
    expect(sanitizeForSpeech('~~gone~~ ## Heading')).toBe('gone Heading')
  })

  it('keeps sentence and clause punctuation for prosody', () => {
    expect(sanitizeForSpeech('Wait, is it done? Yes!')).toBe('Wait, is it done? Yes!')
  })

  it('collapses doubled spaces left by stripped markers and trims', () => {
    expect(sanitizeForSpeech('  **hi**  there  ')).toBe('hi there')
  })

  it('returns empty for a chunk that is only markup', () => {
    expect(sanitizeForSpeech('**')).toBe('')
    expect(sanitizeForSpeech('   *   ')).toBe('')
  })
})
