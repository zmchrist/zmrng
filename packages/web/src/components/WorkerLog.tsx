import { useEffect } from 'react'
import styles from './WorkerLog.module.css'
import type { TaskEvent } from '../types'
import { actorColor } from '../status'
import { useAutoScroll } from '../useAutoScroll'

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
  if (payload.sub === 'tool') {
    const color = actorColor('main')
    return (
      <div className={styles.tool} style={{ borderLeftColor: color }} key={ev.id}>
        <span className={styles.toolName} style={{ color }}>
          ⚙ {payload.tool}
        </span>
        {payload.summary ? `: ${payload.summary}` : ''}
      </div>
    )
  }
  if (payload.sub === 'subagent') {
    const color = actorColor(payload.subagentType ?? payload.actor ?? '')
    return (
      <div className={styles.subagent} style={{ borderLeftColor: color }} key={ev.id}>
        <span className={styles.subagentName} style={{ color }}>
          ▸ {payload.subagentType}
        </span>
        {payload.summary ? ` — ${payload.summary}` : ''}
      </div>
    )
  }
  if (payload.sub === 'subagent_result') {
    const color = actorColor(payload.subagentType ?? payload.actor ?? '')
    return (
      <div
        className={`${styles.subagentResult} ${payload.isError ? styles.resultError : ''}`}
        style={{ borderLeftColor: color }}
        key={ev.id}
      >
        <span className={styles.subagentName} style={{ color }}>
          ◂ {payload.subagentType}
        </span>
        {payload.summary ? `: ${payload.summary}` : ''}
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
  const { ref, onScroll, scrollToBottom, notifyContentChanged, hasNew } =
    useAutoScroll<HTMLDivElement>()

  useEffect(() => {
    notifyContentChanged()
  }, [events, live, notifyContentChanged])

  return (
    <div className={styles.logWrap}>
      <div className={styles.log} ref={ref} onScroll={onScroll}>
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
      </div>
      {hasNew && (
        <button type="button" className={styles.newMsgPill} onClick={scrollToBottom}>
          ↓ New message
        </button>
      )}
    </div>
  )
}
