import { useState } from 'react'
import styles from './TaskControls.module.css'
import type { RepoTarget, ServerConfig, Task } from '../types'
import { STATUS_LABEL, statusColor } from '../status'

/** Format an integer with thousands separators (locale-independent grouping). */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Phases where the worker runs autonomously to a PR (optional operator steer). */
const AUTONOMOUS: ReadonlySet<string> = new Set([
  'planning',
  'executing',
  'validating',
  'building',
])

/** Autonomous live phases where a hard Stop (interrupt) is offered. */
const STOPPABLE: ReadonlySet<string> = new Set([
  'planning',
  'executing',
  'validating',
])

/** Terminal statuses (no live runner attached) where a hard delete is safe. */
const DELETABLE: ReadonlySet<string> = new Set(['backlog', 'done', 'failed'])

interface Props {
  task: Task
  config: ServerConfig | null
  repos: RepoTarget[]
  onStart: () => Promise<unknown>
  onResume: () => Promise<unknown>
  onInterrupt: () => Promise<unknown>
  onDone: () => Promise<unknown>
  onCancel: () => Promise<unknown>
  onDelete: () => Promise<unknown>
}

/** Compact controls for the selected task, tucked into the Workspace right bar.
 *  A title row (title + status pill) with the action buttons stays visible; the
 *  metadata (repo/flow/model/effort/style/description/usage) hides behind a
 *  dropdown. Steering the worker lives in the Worker-Log composer, not here. */
export function TaskControls({
  task,
  config,
  repos,
  onStart,
  onResume,
  onInterrupt,
  onDone,
  onCancel,
  onDelete,
}: Props) {
  const repoLabel = repos.find((r) => r.id === task.repoId)?.label ?? task.repoId
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

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

  const statusLabel =
    task.queued && task.status === 'planning' ? 'Queued' : STATUS_LABEL[task.status]

  return (
    <section className={styles.card}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.chevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className={styles.title}>{task.title}</span>
        <span className={styles.pill} style={{ color: statusColor(task.status) }}>
          {statusLabel}
        </span>
      </button>

      <div className={styles.actions}>
        {(task.status === 'backlog' || task.status === 'failed') && (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => run(onStart)}>
            {task.status === 'failed' ? 'Restart' : 'Start'}
          </button>
        )}
        {task.status === 'blocked' && (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => run(onResume)}>
            Resume
          </button>
        )}
        {task.status === 'review' && task.prUrl && (
          <a className={styles.linkBtn} href={task.prUrl} target="_blank" rel="noreferrer">
            Open PR ↗
          </a>
        )}
        {task.status === 'review' && (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => run(onDone)}>
            Mark done
          </button>
        )}
        {STOPPABLE.has(task.status) && (
          <button type="button" className={styles.danger} disabled={busy} onClick={() => run(onInterrupt)}>
            Stop
          </button>
        )}
        {task.status !== 'done' && task.status !== 'backlog' && (
          <button type="button" className={styles.danger} disabled={busy} onClick={() => run(onCancel)}>
            Cancel
          </button>
        )}
        {DELETABLE.has(task.status) && (
          <button type="button" className={styles.danger} disabled={busy} onClick={() => run(onDelete)}>
            Delete
          </button>
        )}
      </div>

      {err && <div className={styles.error}>{err}</div>}

      {AUTONOMOUS.has(task.status) && (
        <div className={styles.autobar}>
          {task.queued
            ? 'Queued — waiting for a free lane…'
            : 'Running autonomously — type in the Worker Log to steer, Stop to interrupt.'}
        </div>
      )}
      {task.status === 'blocked' && (
        <div className={styles.error}>
          Blocked — a required subagent is missing from this repo. Add it, then press Resume.
        </div>
      )}

      {open && (
        <div className={styles.details}>
          <div className={styles.badges}>
            {repoLabel && <span className={styles.badge}>⌂ {repoLabel}</span>}
            <span className={styles.badge}>flow: {task.flow}</span>
            {task.model && <span className={styles.badge}>model: {task.model}</span>}
            {task.effort && <span className={styles.badge}>effort: {task.effort}</span>}
            {task.style && <span className={styles.badge}>style: {task.style}</span>}
          </div>
          {(task.branch || task.planPath || config) && (
            <div className={styles.meta}>
              {task.branch && <span className={styles.metaItem}>⌥ {task.branch}</span>}
              {task.planPath && <span className={styles.metaItem}>▤ {task.planPath}</span>}
              {config && <span className={styles.metaItem}>{config.authMode}</span>}
            </div>
          )}
          {task.body && <p className={styles.body}>{task.body}</p>}
          {(task.status === 'review' || task.status === 'done') && (
            <div className={styles.usage}>
              <span className={styles.usageLabel}>tokens</span>
              <span className={styles.usageValue}>
                {fmt(task.usage.tokensIn + task.usage.tokensOut + task.usage.tokensCache)}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
