import { describe, it, expect } from 'vitest'
import {
  MAX_CHANNEL_MESSAGES,
  emptyThread,
  appendMessage,
  loadScrollback,
  applyReaction,
} from '../src/channelThread'
import type { Message } from '../src/types'

const msg = (id: number, body: string, kind: Message['kind'] = 'human'): Message => ({
  id,
  channelId: 1,
  author: 'Ada',
  body,
  kind,
  createdAt: `2026-08-25T00:00:0${id}.000Z`,
})

describe('channelThread reducer', () => {
  it('emptyThread starts empty', () => {
    expect(emptyThread()).toEqual([])
  })

  it('appendMessage adds a message, keeping ascending id order', () => {
    let state = emptyThread()
    state = appendMessage(state, msg(1, 'one'))
    state = appendMessage(state, msg(2, 'two'))
    expect(state.map((m) => m.body)).toEqual(['one', 'two'])
  })

  it('appendMessage re-sorts an out-of-order arrival by id', () => {
    let state = emptyThread()
    state = appendMessage(state, msg(2, 'two'))
    state = appendMessage(state, msg(1, 'one'))
    expect(state.map((m) => m.id)).toEqual([1, 2])
  })

  it('appendMessage dedupes by id (a re-delivered message does not double up)', () => {
    let state = emptyThread()
    state = appendMessage(state, msg(1, 'one'))
    state = appendMessage(state, msg(1, 'one'))
    expect(state).toHaveLength(1)
  })

  it('appendMessage preserves message kind for distinguishable rendering', () => {
    let state = emptyThread()
    state = appendMessage(state, msg(1, 'human hi', 'human'))
    state = appendMessage(state, msg(2, 'agent hi', 'agent'))
    expect(state.map((m) => m.kind)).toEqual(['human', 'agent'])
  })

  it('loadScrollback replaces the thread with a REST page (oldest-first)', () => {
    const page = [msg(3, 'c'), msg(4, 'd')]
    expect(loadScrollback(emptyThread(), page).map((m) => m.body)).toEqual(['c', 'd'])
  })

  it('loadScrollback merges an older page in front of live messages, deduped', () => {
    let state = emptyThread()
    state = appendMessage(state, msg(4, 'd')) // a live message already arrived
    // scrollback fetch returns an older page that overlaps on id 4
    state = loadScrollback(state, [msg(2, 'b'), msg(3, 'c'), msg(4, 'd')])
    expect(state.map((m) => m.id)).toEqual([2, 3, 4])
  })

  it('caps the thread at MAX_CHANNEL_MESSAGES, keeping the newest by id', () => {
    const page = Array.from({ length: MAX_CHANNEL_MESSAGES + 100 }, (_, i) => msg(i + 1, `m${i + 1}`))
    const state = loadScrollback(emptyThread(), page)
    expect(state).toHaveLength(MAX_CHANNEL_MESSAGES)
    // Oldest 100 trimmed: lowest retained id is 101.
    expect(state[0].id).toBe(101)
    expect(state.at(-1)?.id).toBe(MAX_CHANNEL_MESSAGES + 100)
  })

  it('applyReaction swaps the target message reactions, leaving others untouched', () => {
    let state = emptyThread()
    state = appendMessage(state, msg(1, 'one'))
    state = appendMessage(state, msg(2, 'two'))
    const next = applyReaction(state, 2, [{ emoji: '👍', handles: ['Ada'] }])
    expect(next.find((m) => m.id === 2)?.reactions).toEqual([{ emoji: '👍', handles: ['Ada'] }])
    expect(next.find((m) => m.id === 1)?.reactions).toBeUndefined()
  })

  it('applyReaction returns the same reference when the message is absent', () => {
    const state = appendMessage(emptyThread(), msg(1, 'one'))
    const next = applyReaction(state, 999, [{ emoji: '👍', handles: ['Ada'] }])
    expect(next).toBe(state)
  })
})
