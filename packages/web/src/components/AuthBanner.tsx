import { useEffect, useState } from 'react'
import styles from './AuthBanner.module.css'
import { api } from '../api'
import type { PreflightResult } from '../types'

const POLL_MS = 5000

/**
 * Advisory-only banner: polls `/api/preflight` and names which of claude/gh is
 * missing. Never blocks Start or any other action — it just clears live once
 * the stranger finishes authenticating, with no server restart required.
 */
export function AuthBanner() {
  const [pf, setPf] = useState<PreflightResult | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      api
        .getPreflight()
        .then((r) => {
          if (!cancelled) setPf(r)
        })
        .catch(() => undefined)
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
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
