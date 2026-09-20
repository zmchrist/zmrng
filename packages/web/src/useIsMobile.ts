import { useCallback, useSyncExternalStore } from 'react'

/**
 * The phone breakpoint. At or below this width the app switches to the
 * single-view hamburger shell; above it the desktop layout is untouched.
 */
export const MOBILE_QUERY = '(max-width: 768px)'

/**
 * `true` while the viewport is phone-sized. Implemented with
 * `useSyncExternalStore` over `matchMedia` rather than a state+effect pair, so
 * it never trips the `react-hooks/set-state-in-effect` rule and stays correct
 * across an orientation change.
 */
export function useIsMobile(query: string = MOBILE_QUERY): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  }, [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
