import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { GlobalUiState, PerTaskUiState, UiState } from './types'

const DEBOUNCE_MS = 400

function emptyState(): UiState {
  return { global: {}, perTask: {} }
}

/**
 * Loads `~/.zmrng/ui-state.json` once on mount and exposes the merged
 * document, debouncing writes back through `PUT /api/ui-state` so rapid
 * toggles (rail collapse, dock cards) don't hammer the endpoint. Patches are
 * gated on `loaded` so a fast interaction before the initial GET resolves
 * never gets clobbered by the subsequent `setState` from that GET.
 */
export function useUiState() {
  const [state, setState] = useState<UiState>(emptyState())
  const [loaded, setLoaded] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getUiState()
      .then((s) => {
        if (cancelled) return
        setState(s)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const persist = useCallback((next: UiState) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      api.putUiState(next).catch(() => undefined)
    }, DEBOUNCE_MS)
  }, [])

  const patchGlobal = useCallback(
    (patch: Partial<GlobalUiState>) => {
      if (!loaded) return
      setState((prev) => {
        const next = { ...prev, global: { ...prev.global, ...patch } }
        persist(next)
        return next
      })
    },
    [loaded, persist],
  )

  const patchTask = useCallback(
    (taskId: string, patch: Partial<PerTaskUiState>) => {
      if (!loaded) return
      setState((prev) => {
        const next = {
          ...prev,
          perTask: {
            ...prev.perTask,
            [taskId]: { ...prev.perTask[taskId], ...patch },
          },
        }
        persist(next)
        return next
      })
    },
    [loaded, persist],
  )

  return { state, loaded, patchGlobal, patchTask }
}
