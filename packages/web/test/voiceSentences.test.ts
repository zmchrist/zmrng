import { describe, it, expect } from 'vitest'
import { emptyBuffer, push, flush, type SentenceBuffer } from '../src/voiceSentences'

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
})
