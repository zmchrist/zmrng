import { describe, it, expect } from 'vitest'
import {
  MOBILE_VIEWS,
  closeDrawer,
  initialMobileNav,
  mobileViewLabel,
  modeForView,
  selectView,
  toggleDrawer,
  viewForMode,
  workspaceViewFor,
} from '../src/mobileNav'

describe('mobileNav', () => {
  it('lists exactly one entry per phone view, Tasks/Worker first', () => {
    expect(MOBILE_VIEWS.map((v) => v.id)).toEqual([
      'tasks',
      'files',
      'terminal',
      'chat',
      'lanes',
      'team',
      'kb',
    ])
    expect(MOBILE_VIEWS[0].label).toBe('Tasks / Worker')
  })

  it('toggles and closes the drawer without touching the view', () => {
    const opened = toggleDrawer(initialMobileNav)
    expect(opened).toEqual({ view: 'tasks', drawerOpen: true })
    expect(toggleDrawer(opened).drawerOpen).toBe(false)
    expect(closeDrawer(opened).drawerOpen).toBe(false)
    // Already closed — same object back, so React skips a pointless re-render.
    expect(closeDrawer(initialMobileNav)).toBe(initialMobileNav)
  })

  it('selecting a view switches it and always closes the drawer', () => {
    const next = selectView({ view: 'tasks', drawerOpen: true }, 'terminal')
    expect(next).toEqual({ view: 'terminal', drawerOpen: false })
  })

  it('maps views to their App-level mode', () => {
    expect(modeForView('team')).toBe('team')
    expect(modeForView('kb')).toBe('kb')
    for (const v of ['tasks', 'files', 'terminal', 'chat', 'lanes'] as const) {
      expect(modeForView(v)).toBe('workspace')
    }
  })

  it('maps only the workspace views to a WorkspaceView sub-view', () => {
    expect(workspaceViewFor('files')).toBe('files')
    expect(workspaceViewFor('tasks')).toBe('tasks')
    expect(workspaceViewFor('lanes')).toBe('lanes')
    expect(workspaceViewFor('team')).toBeNull()
    expect(workspaceViewFor('kb')).toBeNull()
  })

  it('boots a persisted mode onto the matching view', () => {
    expect(viewForMode('kb')).toBe('kb')
    expect(viewForMode('team')).toBe('team')
    expect(viewForMode('workspace')).toBe('tasks')
    // Retired legacy modes still land somewhere real.
    expect(viewForMode('board')).toBe('tasks')
    expect(viewForMode('tasks')).toBe('tasks')
  })

  it('has no phone view for the desktop-only Loop mode and lands it on Tasks', () => {
    expect(viewForMode('loop')).toBe('tasks')
    expect(MOBILE_VIEWS.map((v) => v.id)).not.toContain('loop')
  })

  it('labels a view for the top bar crumb', () => {
    expect(mobileViewLabel('kb')).toBe('KB')
    expect(mobileViewLabel('team')).toBe('Team chat')
  })
})
