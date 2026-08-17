import { describe, it, expect } from 'vitest'
import type { WorkspaceLayout } from '../src/types'
import {
  closeTab,
  dropIntent,
  emptyLayout,
  fileTabId,
  focusTab,
  hydrateLayout,
  moveTab,
  openFile,
  openPanel,
  pruneFileTabs,
  setLogMinimized,
  splitWith,
} from '../src/workspaceLayout'

/** Convenience: the tab ids present in a pane, in order. */
function ids(layout: WorkspaceLayout, pane: number): string[] {
  return layout.panes[pane].tabs.map((t) => t.id)
}

describe('emptyLayout', () => {
  it('is a single pane holding the focused Worker Log tab', () => {
    const l = emptyLayout()
    expect(l.panes).toHaveLength(1)
    expect(ids(l, 0)).toEqual(['log'])
    expect(l.panes[0].activeId).toBe('log')
    expect(l.split).toBeNull()
    expect(l.activePane).toBe(0)
    expect(l.logMinimized).toBe(false)
  })
})

describe('openFile', () => {
  it('appends a focused file tab to the active pane', () => {
    const l = openFile(emptyLayout(), 'src/a.ts')
    expect(ids(l, 0)).toEqual(['log', fileTabId('src/a.ts')])
    expect(l.panes[0].activeId).toBe(fileTabId('src/a.ts'))
  })

  it('only focuses an already-open path (no duplicate tab), selecting its pane', () => {
    let l = openFile(emptyLayout(), 'src/a.ts')
    l = openFile(l, 'src/b.ts')
    // move b into a second pane so a and b live in different panes
    l = splitWith(l, fileTabId('src/b.ts'), 'right')
    const before = l.panes.map((p) => p.tabs.length)
    const reopened = openFile(l, 'src/a.ts')
    expect(reopened.panes.map((p) => p.tabs.length)).toEqual(before)
    // a lives in pane 0 → that pane becomes active and focuses a
    expect(reopened.activePane).toBe(0)
    expect(reopened.panes[0].activeId).toBe(fileTabId('src/a.ts'))
  })

  it('keeps a path containing a colon safe (id is opaque, path lives on the tab)', () => {
    const weird = 'a:b/c.ts'
    const l = openFile(emptyLayout(), weird)
    const tab = l.panes[0].tabs.find((t) => t.kind === 'file')
    expect(tab?.path).toBe(weird)
    expect(tab?.id).toBe(`file:${weird}`)
  })
})

describe('focusTab', () => {
  it('sets the pane active id and the active pane', () => {
    let l = openFile(emptyLayout(), 'src/a.ts')
    l = focusTab(l, 0, 'log')
    expect(l.panes[0].activeId).toBe('log')
    expect(l.activePane).toBe(0)
  })
})

describe('closeTab', () => {
  it('removes a tab and focuses the tab to its left', () => {
    let l = openFile(emptyLayout(), 'a.ts') // [log, file:a]
    l = openFile(l, 'b.ts') // [log, file:a, file:b], active file:b
    l = closeTab(l, fileTabId('b.ts'))
    expect(ids(l, 0)).toEqual(['log', fileTabId('a.ts')])
    expect(l.panes[0].activeId).toBe(fileTabId('a.ts'))
  })

  it('collapses a pane when its last tab is closed; sibling survives, split → null', () => {
    let l = openFile(emptyLayout(), 'a.ts')
    l = splitWith(l, fileTabId('a.ts'), 'right') // pane0 [log], pane1 [file:a]
    expect(l.panes).toHaveLength(2)
    l = closeTab(l, fileTabId('a.ts'))
    expect(l.panes).toHaveLength(1)
    expect(l.split).toBeNull()
    expect(l.activePane).toBe(0)
    expect(ids(l, 0)).toEqual(['log'])
  })

  it('refuses to remove the log tab (backstop for the close-guard)', () => {
    const l = emptyLayout()
    expect(closeTab(l, 'log')).toEqual(l)
  })
})

describe('openPanel', () => {
  it('re-opens a closed singleton into the active pane and focuses it', () => {
    let l = emptyLayout()
    l = openPanel(l, 'chat')
    expect(ids(l, 0)).toContain('chat')
    expect(l.panes[0].activeId).toBe('chat')
  })

  it('never duplicates an already-open singleton, just focuses it', () => {
    let l = openPanel(emptyLayout(), 'chat')
    l = focusTab(l, 0, 'log')
    l = openPanel(l, 'chat')
    expect(ids(l, 0).filter((id) => id === 'chat')).toHaveLength(1)
    expect(l.panes[0].activeId).toBe('chat')
  })

  it('un-minimizes the log when the log panel is re-opened', () => {
    let l = setLogMinimized(emptyLayout(), true)
    l = openPanel(l, 'log')
    expect(l.logMinimized).toBe(false)
  })
})

describe('splitWith', () => {
  it('left/right split builds a row; the new pane leads for left', () => {
    let l = openFile(emptyLayout(), 'a.ts') // pane0 [log, file:a]
    l = splitWith(l, fileTabId('a.ts'), 'left')
    expect(l.split).toBe('row')
    expect(l.panes).toHaveLength(2)
    expect(ids(l, 0)).toEqual([fileTabId('a.ts')]) // left → new pane first
    expect(ids(l, 1)).toEqual(['log'])
    expect(l.activePane).toBe(0)
  })

  it('top/bottom split builds a column; the new pane trails for bottom', () => {
    let l = openFile(emptyLayout(), 'a.ts')
    l = splitWith(l, fileTabId('a.ts'), 'bottom')
    expect(l.split).toBe('column')
    expect(ids(l, 0)).toEqual(['log'])
    expect(ids(l, 1)).toEqual([fileTabId('a.ts')])
    expect(l.activePane).toBe(1)
  })

  it('is a no-op when the tab is the pane’s only tab (nothing to split off)', () => {
    const l = emptyLayout() // pane0 [log] only
    expect(splitWith(l, 'log', 'right')).toEqual(l)
  })

  it('degrades to a move into the other pane once a split already exists (never 2×2)', () => {
    let l = openFile(emptyLayout(), 'a.ts') // [log, file:a]
    l = openFile(l, 'b.ts') // [log, file:a, file:b]
    l = splitWith(l, fileTabId('a.ts'), 'right') // pane0 [log, file:b], pane1 [file:a]
    expect(l.panes).toHaveLength(2)
    l = splitWith(l, fileTabId('b.ts'), 'bottom') // already split → move b into pane1
    expect(l.panes).toHaveLength(2)
    expect(l.split).toBe('row') // axis unchanged, still single-axis
    expect(ids(l, 0)).toEqual(['log'])
    expect(ids(l, 1)).toEqual([fileTabId('a.ts'), fileTabId('b.ts')])
  })
})

describe('moveTab', () => {
  it('reorders within a pane', () => {
    let l = openFile(emptyLayout(), 'a.ts') // [log, file:a]
    l = openFile(l, 'b.ts') // [log, file:a, file:b]
    l = moveTab(l, fileTabId('b.ts'), 0, 0) // move b to the front
    expect(ids(l, 0)).toEqual([fileTabId('b.ts'), 'log', fileTabId('a.ts')])
  })

  it('moves a tab between panes, collapsing an emptied source pane', () => {
    let l = openFile(emptyLayout(), 'a.ts')
    l = splitWith(l, fileTabId('a.ts'), 'right') // pane0 [log], pane1 [file:a]
    l = moveTab(l, fileTabId('a.ts'), 0, 1) // move a back into pane0 → pane1 empties
    expect(l.panes).toHaveLength(1)
    expect(l.split).toBeNull()
    expect(ids(l, 0)).toEqual(['log', fileTabId('a.ts')])
  })
})

describe('setLogMinimized', () => {
  it('toggles the flag', () => {
    expect(setLogMinimized(emptyLayout(), true).logMinimized).toBe(true)
    expect(setLogMinimized(setLogMinimized(emptyLayout(), true), false).logMinimized).toBe(false)
  })
})

describe('pruneFileTabs', () => {
  it('drops file tabs whose path is gone and keeps singletons', () => {
    let l = openFile(emptyLayout(), 'a.ts')
    l = openFile(l, 'gone.ts')
    l = pruneFileTabs(l, ['a.ts'])
    expect(ids(l, 0)).toEqual(['log', fileTabId('a.ts')])
  })

  it('collapses a pane emptied by pruning', () => {
    let l = openFile(emptyLayout(), 'gone.ts')
    l = splitWith(l, fileTabId('gone.ts'), 'right') // pane1 [file:gone]
    l = pruneFileTabs(l, []) // gone.ts removed → pane1 empties
    expect(l.panes).toHaveLength(1)
    expect(l.split).toBeNull()
    expect(ids(l, 0)).toEqual(['log'])
  })
})

describe('hydrateLayout', () => {
  it('returns a well-formed stored layout as-is', () => {
    const stored: WorkspaceLayout = {
      panes: [
        { tabs: [{ id: 'log', kind: 'log' }], activeId: 'log' },
        { tabs: [{ id: fileTabId('a.ts'), kind: 'file', path: 'a.ts' }], activeId: fileTabId('a.ts') },
      ],
      split: 'row',
      activePane: 1,
      logMinimized: false,
    }
    expect(hydrateLayout(stored)).toEqual(stored)
  })

  it('seeds a default from a legacy activePath when there is no stored layout', () => {
    const l = hydrateLayout(undefined, 'legacy.ts')
    expect(ids(l, 0)).toEqual(['log', fileTabId('legacy.ts')])
    expect(l.panes[0].activeId).toBe(fileTabId('legacy.ts'))
  })

  it('defaults to a single log pane when nothing is stored', () => {
    expect(hydrateLayout(undefined)).toEqual(emptyLayout())
  })

  it('clamps a malformed stored layout back to the invariants', () => {
    const malformed = {
      panes: [
        { tabs: [{ id: 'log', kind: 'log' }], activeId: 'nope' },
        { tabs: [{ id: fileTabId('a.ts'), kind: 'file', path: 'a.ts' }], activeId: fileTabId('a.ts') },
        { tabs: [{ id: fileTabId('b.ts'), kind: 'file', path: 'b.ts' }], activeId: fileTabId('b.ts') },
      ],
      split: null,
      activePane: 9,
    } as unknown as WorkspaceLayout
    const l = hydrateLayout(malformed)
    expect(l.panes.length).toBeLessThanOrEqual(2)
    expect(l.split).toBe('row') // 2 panes ⇒ non-null split
    expect(l.activePane).toBe(0) // clamped into range
    expect(l.panes[0].activeId).toBe('log') // bad activeId repaired to a tab it owns
  })
})

describe('dropIntent', () => {
  it('resolves the center band to a center (move) drop', () => {
    expect(dropIntent(50, 50, 100, 100)).toBe('center')
  })

  it('maps each edge band to that edge', () => {
    expect(dropIntent(10, 50, 100, 100)).toBe('left')
    expect(dropIntent(90, 50, 100, 100)).toBe('right')
    expect(dropIntent(50, 10, 100, 100)).toBe('top')
    expect(dropIntent(50, 90, 100, 100)).toBe('bottom')
  })

  it('resolves a corner to a single axis (never a diagonal)', () => {
    expect(['left', 'top']).toContain(dropIntent(5, 5, 100, 100))
  })
})
