import { useState } from 'react'
import styles from './WorkerLogPanel.module.css'
import type { Attachment, TaskEvent, TaskStatus } from '../types'
import { WorkerLog } from './WorkerLog'
import { ClarifyChat } from './ClarifyChat'
import { LIVE_STATUSES } from '../status'
import { ProcessStrip } from './ProcessStrip'
import type { ProcRow } from '../processStrip'

interface Props {
  events: TaskEvent[]
  live: string
  status: TaskStatus | null
  /** Send a steering message to the running worker (POST …/message). Absent ⇒
   *  the composer is never shown (e.g. the WorkspaceTabs unit harness). */
  onMessage?: (text: string, attachments?: Attachment[]) => Promise<unknown>
  /** True when the worker session was lost to an app restart. Shows a
   *  session-ended notice and disables the composer up front. */
  stale?: boolean
  /** What the worker is running right now, shown in a strip above the composer. */
  processes?: ProcRow[]
}

/** Worker-Log panel: the read-only transcript plus, while the task is in a live
 *  phase, an inline composer that steers the running worker — the same channel
 *  the Tasks-page composer used, now living inside the Workspace log tab. */
export function WorkerLogPanel({ events, live, status, onMessage, stale, processes }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function send(text: string, attachments?: Attachment[]) {
    if (!onMessage) return
    setErr(null)
    setBusy(true)
    try {
      await onMessage(text, attachments)
    } catch (e) {
      // Surface the failure instead of letting the rejected promise vanish —
      // e.g. steering an orphaned worker returns the "session has ended" error.
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const inLivePhase = status != null && LIVE_STATUSES.has(status)
  const canSteer = !!onMessage && inLivePhase && !stale

  // Show the thinking dots in the gap after an operator turn (the steer/answer
  // POST is in flight, or the operator message is the newest event) until the
  // worker's first token lands. `WorkerLog` suppresses it while `live` streams.
  const thinking =
    inLivePhase && !stale && (busy || events.at(-1)?.kind === 'operator')

  return (
    <div className={styles.panel}>
      <WorkerLog events={events} live={live} thinking={thinking} />
      {processes && <ProcessStrip rows={processes} />}
      {stale && inLivePhase && (
        <div className={styles.staleNotice}>
          Worker session ended after an app restart — press “Restart agent” in the task
          panel to continue.
        </div>
      )}
      {canSteer && (
        <ClarifyChat
          onSend={(t, a) => void send(t, a)}
          disabled={busy}
          placeholder={
            status === 'clarify' ? undefined : 'Steer the worker…  (⌘↵ to send)'
          }
        />
      )}
      {err && <div className={styles.error}>{err}</div>}
    </div>
  )
}
