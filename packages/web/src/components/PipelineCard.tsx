import styles from './DashboardCards.module.css'
import type { Task } from '../types'
import { pipelineCounts } from '../dashboardData'

interface Props {
  tasks: Task[]
}

/** The Pipeline card: a chip per pipeline status with its live count, plus a
 *  proportional funnel bar. Counts derive from the `tasks` list (pure). */
export function PipelineCard({ tasks }: Props) {
  const { steps, total } = pipelineCounts(tasks)
  const funnel = steps.filter((s) => s.count > 0)

  return (
    <div className={styles.pad}>
      <div className={styles.chips}>
        {steps.map((s) => (
          <span key={s.status} className={styles.chip}>
            <span className={styles.chipDot} style={{ background: s.color }} />
            <span className={styles.chipLabel}>{s.label}</span>
            <span className={styles.chipCount}>{s.count}</span>
          </span>
        ))}
      </div>
      <div className={styles.funnel} aria-hidden="true">
        {funnel.map((s) => (
          <span
            key={s.status}
            className={styles.funnelSeg}
            style={{ flex: s.count, background: s.color }}
          />
        ))}
      </div>
      <span className={styles.total}>{total} total</span>
    </div>
  )
}
