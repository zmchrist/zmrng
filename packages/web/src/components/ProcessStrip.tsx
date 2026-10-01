import { useEffect, useState } from 'react'
import styles from './ProcessStrip.module.css'
import { elapsedMs, formatElapsed, rowLabel, visibleRows, type ProcRow } from '../processStrip'

interface Props {
  rows: ProcRow[]
}

/** Live strip of what the agent is running right now — subagents, background
 *  shells, and slow tool calls — pinned just above a chat composer, like Claude
 *  Code's status line. Read-only: the turn-level Stop button is the only control.
 *  Renders nothing while there is nothing worth showing. */
export function ProcessStrip({ rows }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const ticking = rows.length > 0

  // One 1s tick while any row exists: it advances elapsed times AND reveals a
  // foreground tool call once it crosses the slow threshold.
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])

  const shown = visibleRows(rows, now)
  if (shown.length === 0) return null

  return (
    <ul className={styles.strip} aria-label="Running processes">
      {shown.map((r) => (
        <li key={r.id} className={styles.row} data-status={r.status}>
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.name}>{rowLabel(r)}</span>
          <span className={styles.summary} title={r.summary}>
            {r.summary}
          </span>
          <span className={styles.status}>{r.status}</span>
          <span className={styles.elapsed}>{formatElapsed(elapsedMs(r, now))}</span>
        </li>
      ))}
    </ul>
  )
}
