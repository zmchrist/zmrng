import { useState } from 'react'
import styles from './TaskDetail.module.css'
import type { RepoTarget, ServerConfig, Task, TaskEvent } from '../types'
import { STATUS_LABEL, statusColor } from '../status'
import { ClarifyChat } from './ClarifyChat'
import { WorkerLog } from './WorkerLog'

/** Format an integer with thousands separators (locale-independent grouping). */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

interface Props {
  task: Task
  events: TaskEvent[]
  live: string
  config: ServerConfig | null
  repos: RepoTarget[]
  onStart: () => Promise<unknown>
  onMessage: (text: string) => Promise<unknown>
  onResume: () => Promise<unknown>
  onDone: () => Promise<unknown>
  onCancel: () => Promise<unknown>
}

/** Phases where the worker runs autonomously to a PR (no operator input). */
const AUTONOMOUS: ReadonlySet<string> = new Set([
  'planning',
  'executing',
  'validating',
  'building',
])

export function TaskDetail({
  task,
  events,
  live,
  config,
  repos,
  onStart,
  onMessage,
  onResume,
  onDone,
  onCancel,
}: Props) {
  const repoLabel = repos.find((r) => r.id === task.repoId)?.label ?? task.repoId
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
            {task.queued && task.status === 'planning' ? 'Queued' : STATUS_LABEL[task.status]}
          </span>
        </div>
        <p className={styles.body}>{task.body}</p>
        <div className={styles.badges}>
          {repoLabel && <span className={styles.badge}>⌂ {repoLabel}</span>}
          {task.model && <span className={styles.badge}>model: {task.model}</span>}
          {task.effort && <span className={styles.badge}>effort: {task.effort}</span>}
          {task.style && <span className={styles.badge}>style: {task.style}</span>}
        </div>
        <div className={styles.meta}>
          {task.branch && <span className={styles.metaItem}>⌥ {task.branch}</span>}
          {task.planPath && <span className={styles.metaItem}>▤ {task.planPath}</span>}
          {config && <span className={styles.metaItem}>{config.authMode}</span>}
        </div>

        {(task.status === 'review' || task.status === 'done') && (
          <div className={styles.usage}>
            <span className={styles.usageItem}>
              <span className={styles.usageLabel}>tokens in</span>
              <span className={styles.usageValue}>{fmt(task.usage.tokensIn)}</span>
            </span>
            <span className={styles.usageItem}>
              <span className={styles.usageLabel}>out</span>
              <span className={styles.usageValue}>{fmt(task.usage.tokensOut)}</span>
            </span>
            <span className={styles.usageItem}>
              <span className={styles.usageLabel}>cache</span>
              <span className={styles.usageValue}>{fmt(task.usage.tokensCache)}</span>
            </span>
            <span className={styles.usageItem} title="notional on Max OAuth">
              <span className={styles.usageLabel}>est. cost</span>
              <span className={styles.usageValue}>${task.usage.costUsd.toFixed(4)}</span>
            </span>
            <span className={styles.usageItem}>
              <span className={styles.usageLabel}>turns</span>
              <span className={styles.usageValue}>{fmt(task.usage.turns)}</span>
            </span>
          </div>
        )}

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
          {task.status === 'blocked' && (
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => run(onResume)}
            >
              Resume
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
        {AUTONOMOUS.has(task.status) && (
          <div className={styles.autobar}>
            {task.queued
              ? 'Queued — waiting for a free lane…'
              : 'Running autonomously to PR — no input needed.'}
          </div>
        )}
        {task.status === 'blocked' && (
          <div className={styles.error}>
            Blocked — a required subagent is missing from this repo. Add it, then press
            Resume.
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
