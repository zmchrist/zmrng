import { describe, it, expect } from 'vitest'
import {
  appendPartial,
  emptyThread,
  endTurn,
  finalizeAssistant,
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
