import { useEffect, useRef } from 'react'
import styles from './WorkerLog.module.css'
import type { TaskEvent } from '../types'

interface Props {
  events: TaskEvent[]
  live: string
}

function renderEvent(ev: TaskEvent) {
  const { kind, payload } = ev
  if (kind === 'operator') {
    return (
      <div className={`${styles.row} ${styles.operatorRow}`} key={ev.id}>
        <div className={`${styles.bubble} ${styles.operator}`}>{payload.text}</div>
      </div>
    )
  }
  if (kind === 'error') {
    return (
      <div className={styles.error} key={ev.id}>
        ⚠ {payload.text}
      </div>
    )
  }
  if (kind === 'status') {
    const label =
      payload.note ?? (payload.to ? `→ ${payload.to}` : 'status update')
    return (
      <div className={styles.status} key={ev.id}>
        {label}
      </div>
    )
  }
  // kind === 'claude'
  if (payload.sub === 'init') {
    return (
      <div className={styles.status} key={ev.id}>
        session {payload.sessionId?.slice(0, 8)} · {payload.model}
      </div>
    )
  }
  if (payload.sub === 'result') {
    return (
      <div
        className={`${styles.result} ${payload.isError ? styles.resultError : ''}`}
        key={ev.id}
      >
        {payload.text || (payload.isError ? 'turn failed' : 'turn complete')}
      </div>
    )
  }
  // assistant
  return (
    <div className={styles.row} key={ev.id}>
      <div className={`${styles.bubble} ${styles.assistant}`}>{payload.text}</div>
    </div>
  )
}

export function WorkerLog({ events, live }: Props) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events, live])

  return (
    <div className={styles.log}>
      {events.length === 0 && !live && (
        <div className={styles.placeholder}>No activity yet.</div>
      )}
      {events.map(renderEvent)}
      {live && (
        <div className={styles.row}>
          <div className={`${styles.bubble} ${styles.assistant} ${styles.streaming}`}>
            {live}
            <span className={styles.caret} />
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
