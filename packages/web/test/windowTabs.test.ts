import { describe, it, expect } from 'vitest'
import {
  addChatTab,
  addTerminalTab,
  closeTab,
  emptyTabs,
  hydrateChatTabs,
  hydrateTerminalTabs,
  launchChatTab,
  nextLabel,
  setActiveTab,
  setChatTabConfig,
  setTerminalTabSession,
  type ChatTabState,
  type TabsState,
  type TerminalTabState,
} from '../src/windowTabs'

function ids<T extends { id: string }>(state: TabsState<T>): string[] {
  return state.tabs.map((t) => t.id)
}

describe('emptyTabs', () => {
  it('is an empty list with nothing focused', () => {
    const s = emptyTabs<TerminalTabState>()
    expect(s.tabs).toEqual([])
    expect(s.activeId).toBeNull()
  })
})

describe('addTerminalTab', () => {
  it('appends a tab and focuses it', () => {
    const s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    expect(ids(s)).toEqual(['term-1'])
    expect(s.activeId).toBe('term-1')
    expect(s.tabs[0].label).toBe('Terminal 1')
  })

  it('keeps earlier tabs and focuses the newest', () => {
    let s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    s = addTerminalTab(s, 'term-2', 'Terminal 2')
    expect(ids(s)).toEqual(['term-1', 'term-2'])
    expect(s.activeId).toBe('term-2')
  })

  it('does not mutate the input state', () => {
    const before = emptyTabs<TerminalTabState>()
    addTerminalTab(before, 'term-1', 'Terminal 1')
    expect(before.tabs).toEqual([])
    expect(before.activeId).toBeNull()
  })
})

describe('addChatTab', () => {
  it('appends an unlaunched tab seeded with the given config and focuses it', () => {
    const s = addChatTab(emptyTabs(), 'chat-1', 'Chat 1', {
      model: 'sonnet',
      effort: 'medium',
      style: 'caveman-full',
      repoId: '',
    })
    expect(ids(s)).toEqual(['chat-1'])
    expect(s.activeId).toBe('chat-1')
    expect(s.tabs[0]).toEqual({
      id: 'chat-1',
      label: 'Chat 1',
      model: 'sonnet',
      effort: 'medium',
      style: 'caveman-full',
      repoId: '',
      launched: false,
    })
  })
})

describe('launchChatTab', () => {
  it('flips launched on the target tab only', () => {
    let s = addChatTab(emptyTabs(), 'chat-1', 'Chat 1', { model: 'sonnet', effort: 'medium', style: 'normal', repoId: '' })
    s = addChatTab(s, 'chat-2', 'Chat 2', { model: 'opus', effort: 'high', style: 'normal', repoId: '' })
    s = launchChatTab(s, 'chat-1')
    expect(s.tabs.find((t) => t.id === 'chat-1')?.launched).toBe(true)
    expect(s.tabs.find((t) => t.id === 'chat-2')?.launched).toBe(false)
  })
})

describe('setChatTabConfig', () => {
  it('patches only the targeted tab, leaving launched untouched', () => {
    let s = addChatTab(emptyTabs(), 'chat-1', 'Chat 1', { model: 'sonnet', effort: 'medium', style: 'normal', repoId: '' })
    s = setChatTabConfig(s, 'chat-1', { model: 'opus', effort: 'xhigh', repoId: 'repo-a' })
    expect(s.tabs[0]).toMatchObject({ model: 'opus', effort: 'xhigh', style: 'normal', repoId: 'repo-a', launched: false })
  })
})

describe('setTerminalTabSession', () => {
  it('records the session id on the targeted tab only', () => {
    let s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    s = addTerminalTab(s, 'term-2', 'Terminal 2')
    s = setTerminalTabSession(s, 'term-1', 'sess-abc')
    expect(s.tabs.find((t) => t.id === 'term-1')?.sessionId).toBe('sess-abc')
    expect(s.tabs.find((t) => t.id === 'term-2')?.sessionId).toBeUndefined()
  })

  it('is a no-op for an unknown id', () => {
    const s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    expect(setTerminalTabSession(s, 'ghost', 'sess-x')).toEqual(s)
  })
})

describe('closeTab', () => {
  it('removes a tab and focuses the left neighbor when the active tab is closed', () => {
    let s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    s = addTerminalTab(s, 'term-2', 'Terminal 2')
    s = addTerminalTab(s, 'term-3', 'Terminal 3')
    s = closeTab(s, 'term-3')
    expect(ids(s)).toEqual(['term-1', 'term-2'])
    expect(s.activeId).toBe('term-2')
  })

  it('keeps the active id when a non-active tab is closed', () => {
    let s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    s = addTerminalTab(s, 'term-2', 'Terminal 2')
    s = setActiveTab(s, 'term-2')
    s = closeTab(s, 'term-1')
    expect(ids(s)).toEqual(['term-2'])
    expect(s.activeId).toBe('term-2')
  })

  it('falls back to null when the last tab is closed', () => {
    let s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    s = closeTab(s, 'term-1')
    expect(ids(s)).toEqual([])
    expect(s.activeId).toBeNull()
  })

  it('is a no-op for an unknown id', () => {
    const s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    expect(closeTab(s, 'nope')).toEqual(s)
  })
})

describe('setActiveTab', () => {
  it('switches focus to an existing tab', () => {
    let s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    s = addTerminalTab(s, 'term-2', 'Terminal 2')
    s = setActiveTab(s, 'term-1')
    expect(s.activeId).toBe('term-1')
  })

  it('is a no-op for an unknown id', () => {
    const s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    expect(setActiveTab(s, 'nope')).toEqual(s)
  })
})

describe('nextLabel', () => {
  it('numbers one past the current tab count', () => {
    expect(nextLabel('Terminal', emptyTabs())).toBe('Terminal 1')
    const s = addTerminalTab(emptyTabs(), 'term-1', 'Terminal 1')
    expect(nextLabel('Terminal', s)).toBe('Terminal 2')
  })
})

describe('hydrateTerminalTabs', () => {
  it('seeds one default auto-spawned tab when the doc has none', () => {
    const s = hydrateTerminalTabs(undefined)
    expect(ids(s)).toEqual(['terminal-1'])
    expect(s.activeId).toBe('terminal-1')
  })

  it('seeds a default tab for an empty persisted list too', () => {
    const s = hydrateTerminalTabs({ tabs: [], activeId: null })
    expect(ids(s)).toEqual(['terminal-1'])
  })

  it('passes through a persisted non-empty list unchanged', () => {
    const stored: TabsState<TerminalTabState> = {
      tabs: [{ id: 't-9', label: 'Terminal 9' }],
      activeId: 't-9',
    }
    expect(hydrateTerminalTabs(stored)).toEqual(stored)
  })

  it('repairs a persisted activeId pointing at a missing tab', () => {
    const stored: TabsState<TerminalTabState> = {
      tabs: [{ id: 't-1', label: 'Terminal 1' }],
      activeId: 'ghost',
    }
    expect(hydrateTerminalTabs(stored).activeId).toBe('t-1')
  })
})

describe('hydrateChatTabs', () => {
  it('seeds one default unlaunched tab when the doc has none', () => {
    const s = hydrateChatTabs(undefined)
    expect(ids(s)).toEqual(['chat-1'])
    expect(s.tabs[0].launched).toBe(false)
  })

  it('uses the caller-supplied seed id for the fresh default tab', () => {
    const s = hydrateChatTabs(undefined, 'chat-unique-xyz')
    expect(ids(s)).toEqual(['chat-unique-xyz'])
    expect(s.tabs[0].label).toBe('Chat 1')
    expect(s.tabs[0].launched).toBe(false)
  })

  it('ignores the seed id when a persisted list already exists', () => {
    const stored: TabsState<ChatTabState> = {
      tabs: [
        { id: 'c-9', label: 'Chat 9', model: 'opus', effort: 'low', style: 'normal', repoId: '', launched: true },
      ],
      activeId: 'c-9',
    }
    expect(ids(hydrateChatTabs(stored, 'chat-unique-xyz'))).toEqual(['c-9'])
  })

  it('passes through a persisted non-empty list unchanged', () => {
    const stored: TabsState<ChatTabState> = {
      tabs: [
        { id: 'c-9', label: 'Chat 9', model: 'opus', effort: 'low', style: 'normal', repoId: 'repo-a', launched: true },
      ],
      activeId: 'c-9',
    }
    expect(hydrateChatTabs(stored)).toEqual(stored)
  })
})
