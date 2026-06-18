import styles from './TaskList.module.css'
import type { RepoTarget, Task } from '../types'
import { STATUS_LABEL, statusColor } from '../status'

interface Props {
  tasks: Task[]
  repos: RepoTarget[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function TaskList({ tasks, repos, selectedId, onSelect }: Props) {
  if (tasks.length === 0) {
    return <div className={styles.empty}>No tasks yet.</div>
  }
  // Only worth showing a per-row repo when more than one target is configured.
  const showRepo = repos.length > 1
  return (
    <ul className={styles.list}>
      {tasks.map((t) => {
        const repoLabel = repos.find((r) => r.id === t.repoId)?.label ?? t.repoId
        return (
          <li key={t.id}>
            <button
              type="button"
              className={`${styles.item} ${t.id === selectedId ? styles.active : ''}`}
              onClick={() => onSelect(t.id)}
            >
              <span className={styles.main}>
                <span className={styles.title}>{t.title}</span>
                {showRepo && repoLabel && (
                  <span className={styles.repo}>⌂ {repoLabel}</span>
                )}
              </span>
              <span className={styles.pill} style={{ color: statusColor(t.status) }}>
                {t.queued && t.status === 'planning' ? 'Queued' : STATUS_LABEL[t.status]}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
