import { describe, it, expect } from 'vitest'
import { nextRailState } from '../src/railState'

describe('nextRailState', () => {
  it('collapses the Tasks panel when re-clicking the active Workspace button', () => {
    const s = nextRailState({ mode: 'workspace', tasksCollapsed: false }, 'workspace')
    expect(s).toEqual({ mode: 'workspace', tasksCollapsed: true })
  })

  it('re-expands the Tasks panel on a third click (toggle back)', () => {
    const s = nextRailState({ mode: 'workspace', tasksCollapsed: true }, 'workspace')
    expect(s).toEqual({ mode: 'workspace', tasksCollapsed: false })
  })

  it('switches to another mode without collapsing and re-expands the panel', () => {
    // From Workspace (collapsed) to Board: just switch, panel resets to expanded.
    const s = nextRailState({ mode: 'workspace', tasksCollapsed: true }, 'board')
    expect(s).toEqual({ mode: 'board', tasksCollapsed: false })
  })

  it('clicking Workspace from another mode just switches, never toggles collapse', () => {
    const s = nextRailState({ mode: 'board', tasksCollapsed: true }, 'workspace')
    expect(s).toEqual({ mode: 'workspace', tasksCollapsed: false })
  })

  it('clicking the already-active non-Workspace mode leaves it expanded', () => {
    const s = nextRailState({ mode: 'board', tasksCollapsed: false }, 'board')
    expect(s).toEqual({ mode: 'board', tasksCollapsed: false })
  })
})
