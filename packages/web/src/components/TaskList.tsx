import styles from './TaskList.module.css'
import type { Task } from '../types'
import { STATUS_LABEL, statusColor } from '../status'

interface Props {
  tasks: Task[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function TaskList({ tasks, selectedId, onSelect }: Props) {
  if (tasks.length === 0) {
    return <div className={styles.empty}>No tasks yet.</div>
  }
  return (
    <ul className={styles.list}>
      {tasks.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            className={`${styles.item} ${t.id === selectedId ? styles.active : ''}`}
            onClick={() => onSelect(t.id)}
          >
            <span className={styles.title}>{t.title}</span>
            <span className={styles.pill} style={{ color: statusColor(t.status) }}>
              {t.queued && t.status === 'building' ? 'Queued' : STATUS_LABEL[t.status]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
