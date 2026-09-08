import { describe, it, expect } from 'vitest'
import {
  MAX_THREAD_ITEMS,
  appendPartial,
  emptyThread,
  endTurn,
  finalizeAssistant,
  isAwaitingReply,
  pushToolNote,
  pushUser,
  resetThread,
} from '../src/chatThread'

describe('emptyThread', () => {
  it('has no items and is not busy', () => {
    expect(emptyThread()).toEqual({ items: [], busy: false })
  })
})

describe('pushUser', () => {
  it('appends a user bubble and marks the thread busy', () => {
    const s = pushUser(emptyThread(), 'hi')
    expect(s.items).toEqual([{ kind: 'user', text: 'hi' }])
    expect(s.busy).toBe(true)
  })

  it('does not mutate the input state', () => {
    const before = emptyThread()
    pushUser(before, 'hi')
    expect(before.items).toEqual([])
    expect(before.busy).toBe(false)
  })
})

describe('appendPartial', () => {
  it('opens a streaming agent bubble on the first delta', () => {
    const s = appendPartial(pushUser(emptyThread(), 'hi'), 'to')
    expect(s.items.at(-1)).toEqual({ kind: 'agent', text: 'to', streaming: true })
  })

  it('extends the same streaming bubble on subsequent deltas', () => {
    let s = pushUser(emptyThread(), 'hi')
    s = appendPartial(s, 'to')
    s = appendPartial(s, 'ken')
    const agents = s.items.filter((i) => i.kind === 'agent')
    expect(agents).toHaveLength(1)
    expect(agents[0]).toEqual({ kind: 'agent', text: 'token', streaming: true })
  })
})

describe('finalizeAssistant', () => {
  it('closes the open streaming bubble to final text', () => {
    let s = pushUser(emptyThread(), 'hi')
    s = appendPartial(s, 'par')
    s = finalizeAssistant(s, 'partial done')
    const agents = s.items.filter((i) => i.kind === 'agent')
    expect(agents).toHaveLength(1)
    expect(agents[0]).toEqual({ kind: 'agent', text: 'partial done', streaming: false })
  })

  it('pushes a closed bubble when no stream is open', () => {
    const s = finalizeAssistant(pushUser(emptyThread(), 'hi'), 'answer')
    expect(s.items.at(-1)).toEqual({ kind: 'agent', text: 'answer', streaming: false })
  })
})

describe('pushToolNote', () => {
  it('inserts a tool row carrying its actor', () => {
    const s = pushToolNote(pushUser(emptyThread(), 'hi'), {
      name: 'Read',
      summary: 'file.ts',
      actor: 'main',
    })
    expect(s.items.at(-1)).toEqual({ kind: 'tool', name: 'Read', summary: 'file.ts', actor: 'main' })
  })
})

describe('endTurn', () => {
  it('clears busy and closes any open streaming bubble', () => {
    let s = pushUser(emptyThread(), 'hi')
    s = appendPartial(s, 'streaming')
    s = endTurn(s)
    expect(s.busy).toBe(false)
    const agents = s.items.filter((i) => i.kind === 'agent')
    expect(agents[0]).toEqual({ kind: 'agent', text: 'streaming', streaming: false })
  })
})

describe('resetThread', () => {
  it('yields a fresh empty thread', () => {
    expect(resetThread()).toEqual({ items: [], busy: false })
  })
})

describe('isAwaitingReply (thinking-dots gate)', () => {
  it('is false for an empty, idle thread', () => {
    expect(isAwaitingReply(emptyThread())).toBe(false)
  })

  it('is true right after the operator sends, before any agent output', () => {
    const s = pushUser(emptyThread(), 'hello')
    expect(isAwaitingReply(s)).toBe(true)
  })

  it('stays true while only tool notes have arrived (no reply text yet)', () => {
    let s = pushUser(emptyThread(), 'hello')
    s = pushToolNote(s, { name: 'Read', summary: 'a.ts', actor: 'main' })
    expect(isAwaitingReply(s)).toBe(true)
  })

  it('becomes false the moment the first token opens an agent bubble', () => {
    let s = pushUser(emptyThread(), 'hello')
    s = appendPartial(s, 'hi')
    expect(isAwaitingReply(s)).toBe(false)
  })

  it('is false once the reply is finalized', () => {
    let s = pushUser(emptyThread(), 'hello')
    s = finalizeAssistant(s, 'done')
    expect(isAwaitingReply(s)).toBe(false)
  })

  it('is false when the turn has ended (not busy)', () => {
    let s = pushUser(emptyThread(), 'hello')
    s = endTurn(s)
    expect(isAwaitingReply(s)).toBe(false)
  })
})

describe('item cap (idle memory bound)', () => {
  it('caps the thread at MAX_THREAD_ITEMS, dropping the oldest', () => {
    let s = emptyThread()
    // Push tool notes (each a distinct item that never merges) past the cap.
    for (let i = 0; i < MAX_THREAD_ITEMS + 50; i++) {
      s = pushToolNote(s, { name: 'Read', summary: `f${i}.ts`, actor: 'main' })
    }
    expect(s.items).toHaveLength(MAX_THREAD_ITEMS)
    // Oldest 50 dropped: the first retained item is f50.
    const first = s.items[0]
    expect(first.kind === 'tool' && first.summary).toBe('f50.ts')
  })

  it('a streaming bubble that extends in place does not count toward the cap', () => {
    let s = pushUser(emptyThread(), 'hi')
    for (let i = 0; i < MAX_THREAD_ITEMS * 2; i++) s = appendPartial(s, 'x')
    // user bubble + one streaming agent bubble — well under the cap.
    expect(s.items).toHaveLength(2)
  })
})
