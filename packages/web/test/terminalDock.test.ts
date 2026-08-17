import { describe, it, expect } from 'vitest'
import {
  addChat,
  addTab,
  addTerminal,
  closeTerminal,
  emptyDock,
  focusKind,
  setActive,
  type DockState,
} from '../src/terminalDock'

/** Convenience: the terminal ids present, in order. */
function ids(state: DockState): string[] {
  return state.tabs.map((t) => t.id)
}

describe('emptyDock', () => {
  it('is an empty dock with no active terminal', () => {
    const d = emptyDock()
    expect(d.tabs).toEqual([])
    expect(d.activeId).toBeNull()
  })
})

describe('addTerminal', () => {
  it('appends a terminal and focuses the new id', () => {
    const d = addTerminal(emptyDock(), 'term-1')
    expect(ids(d)).toEqual(['term-1'])
    expect(d.activeId).toBe('term-1')
    expect(d.tabs[0].kind).toBe('terminal')
  })

  it('appends and focuses subsequent terminals, keeping earlier ones', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = addTerminal(d, 'term-2')
    expect(ids(d)).toEqual(['term-1', 'term-2'])
    expect(d.activeId).toBe('term-2')
  })

  it('does not mutate the input state', () => {
    const before = emptyDock()
    addTerminal(before, 'term-1')
    expect(before.tabs).toEqual([])
    expect(before.activeId).toBeNull()
  })
})

describe('closeTerminal', () => {
  it('removes a terminal and moves focus to the left neighbor', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = addTerminal(d, 'term-2')
    d = addTerminal(d, 'term-3') // active: term-3
    d = closeTerminal(d, 'term-3')
    expect(ids(d)).toEqual(['term-1', 'term-2'])
    expect(d.activeId).toBe('term-2')
  })

  it('focuses the left neighbor when a middle active tab is closed', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = addTerminal(d, 'term-2')
    d = addTerminal(d, 'term-3')
    d = setActive(d, 'term-2')
    d = closeTerminal(d, 'term-2')
    expect(ids(d)).toEqual(['term-1', 'term-3'])
    expect(d.activeId).toBe('term-1')
  })

  it('keeps the active id when a non-active tab is closed', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = addTerminal(d, 'term-2')
    d = setActive(d, 'term-2')
    d = closeTerminal(d, 'term-1')
    expect(ids(d)).toEqual(['term-2'])
    expect(d.activeId).toBe('term-2')
  })

  it('falls back to null active when the last tab is closed', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = closeTerminal(d, 'term-1')
    expect(ids(d)).toEqual([])
    expect(d.activeId).toBeNull()
  })

  it('is a no-op for an unknown id', () => {
    const d = addTerminal(emptyDock(), 'term-1')
    expect(closeTerminal(d, 'term-9')).toEqual(d)
  })
})

describe('addChat / addTab (tab kinds)', () => {
  it('addChat appends a chat-kind tab and focuses it', () => {
    const d = addChat(emptyDock(), 'chat-1')
    expect(ids(d)).toEqual(['chat-1'])
    expect(d.activeId).toBe('chat-1')
    expect(d.tabs[0].kind).toBe('chat')
  })

  it('addTab sets the requested kind', () => {
    expect(addTab(emptyDock(), 't', 'terminal').tabs[0].kind).toBe('terminal')
    expect(addTab(emptyDock(), 'c', 'chat').tabs[0].kind).toBe('chat')
  })

  it('terminal and chat tabs coexist in one ordered list, closed/focused by id across kinds', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = addChat(d, 'chat-1')
    d = addTerminal(d, 'term-2')
    expect(ids(d)).toEqual(['term-1', 'chat-1', 'term-2'])
    expect(d.tabs.map((t) => t.kind)).toEqual(['terminal', 'chat', 'terminal'])
    d = setActive(d, 'chat-1')
    expect(d.activeId).toBe('chat-1')
    d = closeTerminal(d, 'chat-1')
    expect(ids(d)).toEqual(['term-1', 'term-2'])
    expect(d.activeId).toBe('term-1')
  })
})

describe('setActive', () => {
  it('switches focus to an existing terminal', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = addTerminal(d, 'term-2')
    d = setActive(d, 'term-1')
    expect(d.activeId).toBe('term-1')
  })

  it('is a no-op for an unknown id', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = addTerminal(d, 'term-2')
    expect(setActive(d, 'term-9')).toEqual(d)
  })
})

describe('focusKind (nav-button reuse behavior)', () => {
  it('spawns a fresh tab of the kind when none exists', () => {
    const d = focusKind(emptyDock(), 'chat', 'chat-1')
    expect(ids(d)).toEqual(['chat-1'])
    expect(d.activeId).toBe('chat-1')
    expect(d.tabs[0].kind).toBe('chat')
  })

  it('reuses the last-active tab of that kind instead of spawning', () => {
    let d = addChat(emptyDock(), 'chat-1')
    d = addChat(d, 'chat-2') // active: chat-2 (last-active chat)
    d = addTerminal(d, 'term-1') // active: term-1, different kind
    d = focusKind(d, 'chat', 'chat-3')
    expect(ids(d)).toEqual(['chat-1', 'chat-2', 'term-1']) // no new tab spawned
    expect(d.activeId).toBe('chat-2') // reopened on the last-active chat
  })

  it('falls back to the first tab of the kind if the last-active one was closed', () => {
    let d = addChat(emptyDock(), 'chat-1')
    d = addChat(d, 'chat-2') // active + last-active chat: chat-2
    d = closeTerminal(d, 'chat-2') // last-active chat cleared, focus falls to chat-1
    d = addTerminal(d, 'term-1') // active: term-1, different kind
    d = focusKind(d, 'chat', 'chat-3')
    expect(ids(d)).toEqual(['chat-1', 'term-1'])
    expect(d.activeId).toBe('chat-1')
  })

  it('is a same-state focus when the dock is already on that kind (idempotent)', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = focusKind(d, 'terminal', 'term-2')
    expect(ids(d)).toEqual(['term-1']) // no duplicate spawned
    expect(d.activeId).toBe('term-1')
  })

  it('tracks last-active per kind independently across interleaved focus switches', () => {
    let d = addTerminal(emptyDock(), 'term-1')
    d = addChat(d, 'chat-1')
    d = addTerminal(d, 'term-2') // last-active terminal: term-2
    d = setActive(d, 'chat-1') // last-active chat: chat-1, active now chat-1
    d = focusKind(d, 'terminal', 'term-3')
    expect(d.activeId).toBe('term-2') // reused, not term-3
    expect(ids(d)).toEqual(['term-1', 'chat-1', 'term-2'])
  })
})
