import { useCallback, useState } from 'react'
import { loadPanelPosition, panelState, savePanelPosition, stepPanel } from './mobileTaskPanel'
import type { PanelMove, PanelState } from './mobileTaskPanel'

/**
 * The phone list/detail split for one view, persisted under its own
 * localStorage key. Returns the current state and a `move` that steps it.
 */
export function usePanelSplit(storageKey: string): [PanelState, (move: PanelMove) => void] {
  const [state, setState] = useState(() => panelState(loadPanelPosition(storageKey)))
  const move = useCallback(
    (m: PanelMove) => {
      setState((prev) => {
        const next = stepPanel(prev, m)
        savePanelPosition(storageKey, next.position)
        return next
      })
    },
    [storageKey],
  )
  return [state, move]
}
