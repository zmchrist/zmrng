import { useState } from 'react'
import styles from './TaskDetail.module.css'
import type { ServerConfig, Task, TaskEvent } from '../types'
import { STATUS_LABEL, statusColor } from '../status'
import { ClarifyChat } from './ClarifyChat'
import { WorkerLog } from './WorkerLog'

interface Props {
  task: Task
  events: TaskEvent[]
  live: string
  config: ServerConfig | null
  onStart: () => Promise<unknown>
  onMessage: (text: string) => Promise<unknown>
  onDone: () => Promise<unknown>
  onCancel: () => Promise<unknown>
}

export function TaskDetail({
  task,
  events,
  live,
  config,
  onStart,
  onMessage,
  onDone,
  onCancel,
}: Props) {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setErr(null)
    setBusy(true)
    try {
      await action()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{task.title}</h1>
          <span className={styles.pill} style={{ color: statusColor(task.status) }}>
            {task.queued && task.status === 'building' ? 'Queued' : STATUS_LABEL[task.status]}
          </span>
        </div>
        <p className={styles.body}>{task.body}</p>
        <div className={styles.meta}>
          {task.branch && <span className={styles.metaItem}>⌥ {task.branch}</span>}
          {task.model && <span className={styles.metaItem}>{task.model}</span>}
          {config && <span className={styles.metaItem}>{config.authMode}</span>}
        </div>

        <div className={styles.actions}>
          {(task.status === 'backlog' || task.status === 'failed') && (
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => run(onStart)}
            >
              {task.status === 'failed' ? 'Restart' : 'Start'}
            </button>
          )}
          {task.status === 'review' && task.prUrl && (
            <a
              className={styles.linkBtn}
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open PR ↗
            </a>
          )}
          {task.status === 'review' && (
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => run(onDone)}
            >
              Mark done
            </button>
          )}
          {task.status !== 'done' && task.status !== 'backlog' && (
            <button
              type="button"
              className={styles.danger}
              disabled={busy}
              onClick={() => run(onCancel)}
            >
              Cancel
            </button>
          )}
        </div>
        {err && <div className={styles.error}>{err}</div>}
        {task.status === 'building' && (
          <div className={styles.autobar}>
            {task.queued
              ? 'Queued — waiting for a free build lane…'
              : 'Running autonomously to PR — no input needed.'}
          </div>
        )}
      </header>

      <WorkerLog events={events} live={live} />

      {task.status === 'clarify' && (
        <ClarifyChat onSend={(text) => run(() => onMessage(text))} disabled={busy} />
      )}
    </div>
  )
}
