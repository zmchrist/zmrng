import { useState } from 'react'
import styles from './TaskList.module.css'
import ctrl from './TaskActions.module.css'
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
const STOPPABLE: ReadonlySet<string> = new Set(['planning', 'executing', 'validating'])

/** Terminal statuses (no live runner attached) where a hard delete is safe. */
const DELETABLE: ReadonlySet<string> = new Set(['backlog', 'done', 'failed'])

interface Props {
  tasks: Task[]
  repos: RepoTarget[]
  selectedId: string | null
  onSelect: (id: string) => void
  config?: ServerConfig | null
  onStart?: () => Promise<unknown>
  onResume?: () => Promise<unknown>
  onInterrupt?: () => Promise<unknown>
  onDone?: () => Promise<unknown>
  onCancel?: () => Promise<unknown>
  onDelete?: () => Promise<unknown>
}

/** Task list. Clicking a row selects it; the selected row also expands in place
 *  to reveal its action buttons, status notices, and a collapsible metadata
 *  dropdown (repo/flow/model/effort/style/branch/plan-path/body/usage) — the
 *  former standalone "active task" card folded into this list. The action
 *  callbacks are optional so the list still renders read-only in contexts that
 *  don't wire task control (e.g. a future reuse without lifecycle actions). */
export function TaskList({
  tasks,
  repos,
  selectedId,
  onSelect,
  config = null,
  onStart,
  onResume,
  onInterrupt,
  onDone,
  onCancel,
  onDelete,
}: Props) {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  async function run(action?: () => Promise<unknown>) {
    if (!action) return
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

  if (tasks.length === 0) {
    return <div className={styles.empty}>No tasks yet.</div>
  }
  // Only worth showing a per-row repo when more than one target is configured.
  const showRepo = repos.length > 1
  return (
    <ul className={styles.list}>
      {tasks.map((t) => {
        const repoLabel = repos.find((r) => r.id === t.repoId)?.label ?? t.repoId
        const active = t.id === selectedId
        const statusLabel = t.queued && t.status === 'planning' ? 'Queued' : STATUS_LABEL[t.status]
        return (
          <li key={t.id}>
            <div className={`${styles.item} ${active ? styles.active : ''}`}>
              <button type="button" className={styles.row} onClick={() => onSelect(t.id)}>
                <span className={styles.main}>
                  <span className={styles.title}>{t.title}</span>
                  {showRepo && repoLabel && <span className={styles.repo}>⌂ {repoLabel}</span>}
                </span>
                <span className={styles.pill} style={{ color: statusColor(t.status) }}>
                  {statusLabel}
                </span>
              </button>

              {active && (
                <div className={styles.expanded}>
                  <div className={ctrl.actions}>
                    {(t.status === 'backlog' || t.status === 'failed') && (
                      <button
                        type="button"
                        className={ctrl.primary}
                        disabled={busy}
                        onClick={() => run(onStart)}
                      >
                        {t.status === 'failed' ? 'Restart' : 'Start'}
                      </button>
                    )}
                    {t.status === 'blocked' && (
                      <button
                        type="button"
                        className={ctrl.primary}
                        disabled={busy}
                        onClick={() => run(onResume)}
                      >
                        Resume
                      </button>
                    )}
                    {t.status === 'review' && t.prUrl && (
                      <a className={ctrl.linkBtn} href={t.prUrl} target="_blank" rel="noreferrer">
                        Open PR ↗
                      </a>
                    )}
                    {t.status === 'review' && (
                      <button
                        type="button"
                        className={ctrl.primary}
                        disabled={busy}
                        onClick={() => run(onDone)}
                      >
                        Mark done
                      </button>
                    )}
                    {STOPPABLE.has(t.status) && (
                      <button
                        type="button"
                        className={ctrl.danger}
                        disabled={busy}
                        onClick={() => run(onInterrupt)}
                      >
                        Stop
                      </button>
                    )}
                    {t.status !== 'done' && t.status !== 'backlog' && (
                      <button
                        type="button"
                        className={ctrl.danger}
                        disabled={busy}
                        onClick={() => run(onCancel)}
                      >
                        Cancel
                      </button>
                    )}
                    {DELETABLE.has(t.status) && (
                      <button
                        type="button"
                        className={ctrl.danger}
                        disabled={busy}
                        onClick={() => run(onDelete)}
                      >
                        Delete
                      </button>
                    )}
                  </div>

                  {err && <div className={ctrl.error}>{err}</div>}

                  {AUTONOMOUS.has(t.status) && (
                    <div className={ctrl.autobar}>
                      {t.queued
                        ? 'Queued — waiting for a free lane…'
                        : 'Running autonomously — type in the Worker Log to steer, Stop to interrupt.'}
                    </div>
                  )}
                  {t.status === 'blocked' && (
                    <div className={ctrl.error}>
                      Blocked — a required subagent is missing from this repo. Add it, then press
                      Resume.
                    </div>
                  )}

                  <button
                    type="button"
                    className={styles.detailsToggle}
                    aria-expanded={detailsOpen}
                    onClick={() => setDetailsOpen((v) => !v)}
                  >
                    <span aria-hidden="true">{detailsOpen ? '▾' : '▸'}</span> Details
                  </button>

                  {detailsOpen && (
                    <div className={ctrl.details}>
                      <div className={ctrl.badges}>
                        {repoLabel && <span className={ctrl.badge}>⌂ {repoLabel}</span>}
                        <span className={ctrl.badge}>flow: {t.flow}</span>
                        {t.model && <span className={ctrl.badge}>model: {t.model}</span>}
                        {t.effort && <span className={ctrl.badge}>effort: {t.effort}</span>}
                        {t.style && <span className={ctrl.badge}>style: {t.style}</span>}
                      </div>
                      {(t.branch || t.planPath || config) && (
                        <div className={ctrl.meta}>
                          {t.branch && <span className={ctrl.metaItem}>⌥ {t.branch}</span>}
                          {t.planPath && <span className={ctrl.metaItem}>▤ {t.planPath}</span>}
                          {config && <span className={ctrl.metaItem}>{config.authMode}</span>}
                        </div>
                      )}
                      {t.body && <p className={ctrl.body}>{t.body}</p>}
                      {(t.status === 'review' || t.status === 'done') && (
                        <div className={ctrl.usage}>
                          <span className={ctrl.usageLabel}>tokens</span>
                          <span className={ctrl.usageValue}>
                            {fmt(t.usage.tokensIn + t.usage.tokensOut + t.usage.tokensCache)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
