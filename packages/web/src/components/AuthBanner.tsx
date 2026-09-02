import { useEffect, useState } from 'react'
import styles from './AuthBanner.module.css'
import { api } from '../api'
import type { PreflightResult } from '../types'

// Poll fast while something is still missing (the operator is mid-login), but
// once both claude and gh are authenticated fall back to a slow heartbeat.
// Every poll spawns a `gh`/`which` subprocess server-side, so the old
// unconditional 5s interval churned subprocesses forever even at true idle with
// everything already authenticated — the prime idle-CPU/memory driver.
const FAST_POLL_MS = 5000
const SLOW_POLL_MS = 60000

/**
 * Advisory-only banner: polls `/api/preflight` and names which of claude/gh is
 * missing. Never blocks Start or any other action — it just clears live once
 * the stranger finishes authenticating, with no server restart required.
 */
export function AuthBanner() {
  const [pf, setPf] = useState<PreflightResult | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Track the last known auth state to pick the next delay without re-reading
    // React state (which the closure wouldn't see).
    let authed = false

    const schedule = () => {
      if (cancelled) return
      timer = setTimeout(run, authed ? SLOW_POLL_MS : FAST_POLL_MS)
    }
    const run = async () => {
      // Skip the subprocess-spawning fetch entirely while the tab is hidden —
      // a backgrounded window has no banner to update.
      if (typeof document !== 'undefined' && document.hidden) {
        schedule()
        return
      }
      try {
        const r = await api.getPreflight()
        if (cancelled) return
        authed = r.claude.ok && r.gh.ok
        setPf(r)
      } catch {
        // transient failure — keep polling on the current cadence
      }
      schedule()
    }
    // Re-check immediately when the tab regains focus, so a logout/login that
    // happened while hidden is reflected without waiting out the slow interval.
    const onVisible = () => {
      if (cancelled || (typeof document !== 'undefined' && document.hidden)) return
      if (timer) clearTimeout(timer)
      void run()
    }

    void run()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
    }
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }, [])

  if (!pf) return null
  const missing = [
    !pf.claude.ok && 'claude',
    !pf.gh.ok && 'gh',
  ].filter((v): v is string => Boolean(v))
  if (missing.length === 0) return null

  return (
    <div className={styles.banner} role="status">
      <span className={styles.dot} />
      <span className={styles.text}>
        {missing.join(' and ')} not authenticated —{' '}
        <span className={styles.hint}>
          {!pf.claude.ok && pf.claude.detail}
          {!pf.claude.ok && !pf.gh.ok && '; '}
          {!pf.gh.ok && pf.gh.detail}
        </span>
      </span>
    </div>
  )
}
