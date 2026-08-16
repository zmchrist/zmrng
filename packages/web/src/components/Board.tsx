import styles from './Board.module.css'
import type { RepoTarget, Task, TaskStatus } from '../types'
import { STATUS_LABEL, statusColor } from '../status'

/** Column order for the board — mirrors the engine's phase state machine, plus
 * the manual `archived` shelf. `building` is a legacy status and gets no column. */
const COLUMNS: TaskStatus[] = [
  'backlog',
  'clarify',
  'planning',
  'executing',
  'validating',
  'review',
  'done',
  'blocked',
  'archived',
]

interface Props {
  tasks: Task[]
  repos: RepoTarget[]
  onSelectTask: (id: string) => void
  onArchive: (id: string) => void
}

export function Board({ tasks, repos, onSelectTask, onArchive }: Props) {
  const showRepo = repos.length > 1
  const byStatus = new Map<TaskStatus, Task[]>()
  for (const status of COLUMNS) byStatus.set(status, [])
  for (const t of tasks) byStatus.get(t.status)?.push(t)

  return (
    <div className={styles.board}>
      {COLUMNS.map((status) => {
        const column = byStatus.get(status) ?? []
        return (
          <section key={status} className={styles.column} aria-label={STATUS_LABEL[status]}>
            <header className={styles.columnHeader}>
              <span className={styles.columnDot} style={{ background: statusColor(status) }} />
              <span className={styles.columnTitle}>{STATUS_LABEL[status]}</span>
              <span className={styles.columnCount}>{column.length}</span>
            </header>
            <div className={styles.cards}>
              {column.length === 0 ? (
                <div className={styles.emptyColumn}>—</div>
              ) : (
                column.map((t) => {
                  const repoLabel = repos.find((r) => r.id === t.repoId)?.label ?? t.repoId
                  const archivable = t.status === 'done' || t.status === 'failed'
                  return (
                    <div key={t.id} className={styles.card} style={{ borderLeftColor: statusColor(t.status) }}>
                      <button
                        type="button"
                        className={styles.cardMain}
                        onClick={() => onSelectTask(t.id)}
                      >
                        <div className={styles.cardTop}>
                          <span
                            className={styles.cardDot}
                            style={{ background: statusColor(t.status) }}
                          />
                          <span className={styles.cardTitle}>{t.title}</span>
                        </div>
                        {showRepo && repoLabel && (
                          <span className={styles.cardRepo}>⌂ {repoLabel}</span>
                        )}
                        <div className={styles.cardBadges}>
                          {t.model && <span className={styles.cardBadge}>{t.model}</span>}
                          {t.effort && <span className={styles.cardBadge}>{t.effort}</span>}
                        </div>
                      </button>
                      {archivable && (
                        <button
                          type="button"
                          className={styles.archiveBtn}
                          onClick={() => onArchive(t.id)}
                        >
                          Archive
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
