import { useEffect, useState } from 'react'

/**
 * Keeps a conditionally-rendered panel mounted for `duration` ms after `open`
 * flips to false, so a CSS closing animation can play out before the panel
 * is actually removed from the DOM (a plain `{open && <Panel/>}` unmounts
 * instantly, which only lets the *opening* animation ever be seen).
 *
 * Usage: `const mounted = usePanelMount(open)`, then
 * `{mounted && <div className={open ? styles.paneEnter : styles.paneExit}>}`.
 */
export function usePanelMount(open: boolean, duration = 170): boolean {
  const [mounted, setMounted] = useState(open)
  // Tracks the last `open` value reacted to, so a flip to true mounts
  // immediately during render (the "adjust state on a prop change" pattern),
  // and the effect below only ever subscribes to a close-delay timer.
  const [trackedOpen, setTrackedOpen] = useState(open)

  if (open !== trackedOpen) {
    setTrackedOpen(open)
    if (open) setMounted(true)
  }

  useEffect(() => {
    if (open) return
    const t = setTimeout(() => setMounted(false), duration)
    return () => clearTimeout(t)
  }, [open, duration])

  return mounted
}
