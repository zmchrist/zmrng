import type { WorkspaceMode } from './types'

/**
 * Pure activity-rail click reducer. Owns the interaction between the current
 * mode and the ephemeral "Tasks panel collapsed" flag: clicking the Workspace
 * rail button while already in Workspace mode toggles the Tasks side panel
 * open/closed; any other click just switches modes and always re-expands the
 * panel (so a mode-away-and-back leaves it open again).
 */
export interface RailState {
  mode: WorkspaceMode
  tasksCollapsed: boolean
}

export function nextRailState(current: RailState, clicked: WorkspaceMode): RailState {
  if (clicked === 'workspace' && current.mode === 'workspace') {
    return { mode: current.mode, tasksCollapsed: !current.tasksCollapsed }
  }
  return { mode: clicked, tasksCollapsed: false }
}
