import type { WorkspaceMode } from './types'

/**
 * Phone navigation model. On a phone the desktop Workspace split (task panel +
 * tabbed worker pane) collapses into ONE full-screen view at a time, reached
 * from a hamburger drawer. This module is the pure, DOM-free reducer behind
 * that drawer — `MobileNav.tsx` only renders it.
 */
export type MobileView = 'tasks' | 'files' | 'terminal' | 'chat' | 'team' | 'kb'

/** The subset of views served by `WorkspaceView` (the rest are App-level modes). */
export type MobileWorkspaceView = 'tasks' | 'files' | 'terminal' | 'chat'

export const MOBILE_VIEWS: ReadonlyArray<{ id: MobileView; label: string; glyph: string }> = [
  { id: 'tasks', label: 'Tasks / Worker', glyph: '≣' },
  { id: 'files', label: 'Files', glyph: '❐' },
  { id: 'terminal', label: 'Terminal', glyph: '⌘' },
  { id: 'chat', label: 'Chat', glyph: '✦' },
  { id: 'team', label: 'Team chat', glyph: '🗨' },
  { id: 'kb', label: 'KB', glyph: '❏' },
]

export interface MobileNavState {
  view: MobileView
  drawerOpen: boolean
}

export const initialMobileNav: MobileNavState = { view: 'tasks', drawerOpen: false }

export function toggleDrawer(state: MobileNavState): MobileNavState {
  return { ...state, drawerOpen: !state.drawerOpen }
}

export function closeDrawer(state: MobileNavState): MobileNavState {
  return state.drawerOpen ? { ...state, drawerOpen: false } : state
}

/** Picking an entry switches the full-screen view and always closes the drawer. */
export function selectView(state: MobileNavState, view: MobileView): MobileNavState {
  return { ...state, view, drawerOpen: false }
}

/** Which App-level mode a view belongs to. Everything else lives in Workspace. */
export function modeForView(view: MobileView): WorkspaceMode {
  if (view === 'team') return 'team'
  if (view === 'kb') return 'kb'
  return 'workspace'
}

/** The WorkspaceView sub-view for a view, or null when it is an App-level mode. */
export function workspaceViewFor(view: MobileView): MobileWorkspaceView | null {
  return view === 'team' || view === 'kb' ? null : view
}

/** The view a persisted App mode should land on when the phone shell boots. */
export function viewForMode(mode: WorkspaceMode): MobileView {
  if (mode === 'team') return 'team'
  if (mode === 'kb') return 'kb'
  return 'tasks'
}

export function mobileViewLabel(view: MobileView): string {
  return MOBILE_VIEWS.find((v) => v.id === view)?.label ?? view
}
