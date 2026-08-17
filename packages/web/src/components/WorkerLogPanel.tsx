import { useState } from 'react'
import styles from './WorkerLogPanel.module.css'
import type { TaskEvent, TaskStatus } from '../types'
import { WorkerLog } from './WorkerLog'
import { ClarifyChat } from './ClarifyChat'
import { LIVE_STATUSES } from '../status'

interface Props {
  events: TaskEvent[]
  live: string
  status: TaskStatus | null
  /** Send a steering message to the running worker (POST …/message). Absent ⇒
   *  the composer is never shown (e.g. the WorkspaceTabs unit harness). */
  onMessage?: (text: string) => Promise<unknown>
}

/** Worker-Log panel: the read-only transcript plus, while the task is in a live
 *  phase, an inline composer that steers the running worker — the same channel
 *  the Tasks-page composer used, now living inside the Workspace log tab. */
export function WorkerLogPanel({ events, live, status, onMessage }: Props) {
  const [busy, setBusy] = useState(false)

  async function send(text: string) {
    if (!onMessage) return
    setBusy(true)
    try {
      await onMessage(text)
    } finally {
      setBusy(false)
    }
  }

  const canSteer = !!onMessage && status != null && LIVE_STATUSES.has(status)

  return (
    <div className={styles.panel}>
      <WorkerLog events={events} live={live} />
      {canSteer && (
        <ClarifyChat
          onSend={(t) => void send(t)}
          disabled={busy}
          placeholder={
            status === 'clarify' ? undefined : 'Steer the worker…  (⌘↵ to send)'
          }
        />
      )}
    </div>
  )
}
