import styles from './DashboardCards.module.css'
import type { Task } from '../types'
import { concurrency } from '../dashboardData'

interface Props {
  tasks: Task[]
  maxLanes: number
}

/** The Concurrency card: active execution lanes vs the configured max, a bar per
 *  active lane, and the queued count. Derives from `tasks` + `maxLanes` (pure). */
export function ConcurrencyCard({ tasks, maxLanes }: Props) {
  const { active, max, queued, lanes } = concurrency(tasks, maxLanes)
  const fillPct = max > 0 ? Math.min(100, (active / max) * 100) : 0

  return (
    <div className={styles.pad}>
      <div className={styles.laneCount}>
        <span className={styles.laneBig}>{active}</span>
        <span className={styles.laneMax}>/ {max}</span>
        <span className={styles.laneUnit}>lanes active</span>
      </div>

      {lanes.length > 0 ? (
        <div className={styles.lanes}>
          {lanes.map((ln) => (
            <div key={ln.id} className={styles.lane}>
              <div className={styles.laneHead}>
                <span className={styles.laneTitle}>{ln.title}</span>
              </div>
              <div className={styles.laneTrack}>
                <div className={styles.laneFill} style={{ width: '100%' }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.laneTrack} aria-hidden="true">
          <div className={styles.laneFill} style={{ width: `${fillPct}%` }} />
        </div>
      )}

      {queued > 0 && <span className={styles.queued}>{queued} queued</span>}
    </div>
  )
}
