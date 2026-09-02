import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadChatOrder,
  loadChatThread,
  removeChatThread,
  saveChatOrder,
  saveChatThread,
  serializeTranscript,
} from '../src/chatPersistence'
import type { ThreadItem } from '../src/chatThread'
import { MAX_THREAD_ITEMS } from '../src/chatThread'

describe('chat tab order persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to an empty order with no active id when nothing is stored', () => {
    expect(loadChatOrder()).toEqual({ order: [], activeId: null })
  })

  it('round-trips a saved tab order + active id', () => {
    saveChatOrder(['chat-0', 'chat-1'], 'chat-1')
    expect(loadChatOrder()).toEqual({ order: ['chat-0', 'chat-1'], activeId: 'chat-1' })
  })

  it('falls back to defaults on corrupt stored JSON', () => {
    localStorage.setItem('zmrng-chat-sessions', '{not json')
    expect(loadChatOrder()).toEqual({ order: [], activeId: null })
  })
})

describe('chat transcript persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns an empty transcript for an id with nothing saved', () => {
    expect(loadChatThread('chat-0')).toEqual([])
  })

  it('round-trips a saved transcript', () => {
    const items: ThreadItem[] = [
      { kind: 'user', text: 'hi' },
      { kind: 'agent', text: 'hello', streaming: false },
    ]
    saveChatThread('chat-0', items)
    expect(loadChatThread('chat-0')).toEqual(items)
  })

  it('keeps separate tabs independent', () => {
    saveChatThread('chat-0', [{ kind: 'user', text: 'a' }])
    saveChatThread('chat-1', [{ kind: 'user', text: 'b' }])
    expect(loadChatThread('chat-0')).toEqual([{ kind: 'user', text: 'a' }])
    expect(loadChatThread('chat-1')).toEqual([{ kind: 'user', text: 'b' }])
  })

  it('removeChatThread drops only the targeted tab', () => {
    saveChatThread('chat-0', [{ kind: 'user', text: 'a' }])
    saveChatThread('chat-1', [{ kind: 'user', text: 'b' }])
    removeChatThread('chat-0')
    expect(loadChatThread('chat-0')).toEqual([])
    expect(loadChatThread('chat-1')).toEqual([{ kind: 'user', text: 'b' }])
  })

  it('preserves the tab order + active id when a transcript is saved', () => {
    saveChatOrder(['chat-0'], 'chat-0')
    saveChatThread('chat-0', [{ kind: 'user', text: 'hi' }])
    expect(loadChatOrder()).toEqual({ order: ['chat-0'], activeId: 'chat-0' })
  })

  it('caps the on-disk transcript at MAX_THREAD_ITEMS, keeping the newest', () => {
    const items: ThreadItem[] = Array.from({ length: MAX_THREAD_ITEMS + 50 }, (_, i) => ({
      kind: 'user',
      text: `m${i}`,
    }))
    saveChatThread('chat-0', items)
    const loaded = loadChatThread('chat-0')
    expect(loaded).toHaveLength(MAX_THREAD_ITEMS)
    const first = loaded[0]
    expect(first.kind === 'user' && first.text).toBe('m50')
  })
})

describe('serializeTranscript', () => {
  it('returns an empty string for an empty transcript', () => {
    expect(serializeTranscript([])).toBe('')
  })

  it('renders user/agent bubbles as labeled lines, skipping tool notes', () => {
    const text = serializeTranscript([
      { kind: 'user', text: 'what is 2+2' },
      { kind: 'tool', name: 'Read', summary: 'file.ts', actor: 'main' },
      { kind: 'agent', text: '4', streaming: false },
    ])
    expect(text).toContain('User: what is 2+2')
    expect(text).toContain('Assistant: 4')
    expect(text).not.toContain('Read')
  })
})
