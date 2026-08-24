import styles from './DashboardCards.module.css'
import type { RepoTarget, Task } from '../types'
import { reviewQueue } from '../dashboardData'
import { STATUS_LABEL, statusColor } from '../status'

interface Props {
  tasks: Task[]
  repos: RepoTarget[]
  /** Select a task (clicking a row focuses it in the rest of the grid). */
  onSelect: (id: string) => void
}

/** The Review queue card: tasks in `review`/`done`, each with its repo, status
 *  pill, and a PR "Open" link. Derives from `tasks` (pure). */
export function ReviewQueueCard({ tasks, repos, onSelect }: Props) {
  const rows = reviewQueue(tasks)
  const repoLabel = (id: string) => repos.find((r) => r.id === id)?.label ?? id

  if (rows.length === 0) {
    return (
      <div className={styles.rqPad}>
        <div className={styles.empty}>Nothing in review yet.</div>
      </div>
    )
  }

  return (
    <div className={styles.rqPad}>
      {rows.map((r) => (
        <div key={r.id} className={styles.rqRow}>
          <button type="button" className={styles.rqMain} onClick={() => onSelect(r.id)}>
            <div className={styles.rqTitle}>{r.title}</div>
            <div className={styles.rqMeta}>
              {repoLabel(r.repoId)} · {STATUS_LABEL[r.status]}
            </div>
          </button>
          <span className={styles.rqBadge} style={{ color: statusColor(r.status) }}>
            {STATUS_LABEL[r.status]}
          </span>
          {r.prUrl && (
            <a className={styles.rqOpen} href={r.prUrl} target="_blank" rel="noreferrer">
              Open ↗
            </a>
          )}
        </div>
      ))}
    </div>
  )
}
