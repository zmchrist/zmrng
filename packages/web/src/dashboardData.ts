// Pure, React-free derivations feeding the three new dashboard data cards
// (Pipeline / Concurrency / Review queue). Every function takes the task list
// (already flowing over the WS hub) and returns a plain shape — no DOM, no
// fetch — so they are unit-tested directly like the other reducers in this repo.

import type { Task, TaskStatus } from './types'
import { STATUS_LABEL, statusColor } from './status'

/** The statuses shown in the pipeline funnel, in left→right display order. */
const PIPELINE_STATUSES: readonly TaskStatus[] = [
  'backlog',
  'clarify',
  'planning',
  'executing',
  'validating',
  'review',
  'done',
]

/** One step of the pipeline funnel: a status, its label + token color, and the
 *  live count of tasks currently in that status. */
export interface PipelineStep {
  status: TaskStatus
  label: string
  count: number
  /** `var(--status-<s>)` — recolors through the theme system. */
  color: string
}

/** The pipeline funnel: an ordered step list plus the summed total. */
export interface PipelineData {
  steps: PipelineStep[]
  total: number
}

/** Count tasks per pipeline status in the fixed display order. Zero-count
 *  statuses are kept (so the funnel shape is stable). `total` sums the steps —
 *  tasks in a non-pipeline status (failed/archived/blocked/building) are excluded. */
export function pipelineCounts(tasks: Task[]): PipelineData {
  const counts = new Map<TaskStatus, number>()
  for (const t of tasks) {
    if (PIPELINE_STATUSES.includes(t.status)) {
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
    }
  }
  const steps = PIPELINE_STATUSES.map((status) => ({
    status,
    label: STATUS_LABEL[status],
    count: counts.get(status) ?? 0,
    color: statusColor(status),
  }))
  const total = steps.reduce((sum, s) => sum + s.count, 0)
  return { steps, total }
}

/** One active execution lane (a currently-executing task). */
export interface Lane {
  id: string
  title: string
}

/** Concurrency snapshot: active lanes vs the configured max, plus the queued count. */
export interface ConcurrencyData {
  active: number
  max: number
  queued: number
  lanes: Lane[]
}

/** Derive the concurrency card's data: `active`/`lanes` come from `executing`
 *  tasks, `queued` from `queued === true`, `max` echoes the server's lane cap. */
export function concurrency(tasks: Task[], maxLanes: number): ConcurrencyData {
  const lanes = tasks
    .filter((t) => t.status === 'executing')
    .map((t) => ({ id: t.id, title: t.title }))
  const queued = tasks.filter((t) => t.queued === true).length
  return { active: lanes.length, max: maxLanes, queued, lanes }
}

/** One row of the review queue. */
export interface ReviewRow {
  id: string
  title: string
  repoId: string
  status: TaskStatus
  prUrl: string | null
}

/** Tasks awaiting the operator: those in `review` or `done`, carrying their PR url. */
export function reviewQueue(tasks: Task[]): ReviewRow[] {
  return tasks
    .filter((t) => t.status === 'review' || t.status === 'done')
    .map((t) => ({ id: t.id, title: t.title, repoId: t.repoId, status: t.status, prUrl: t.prUrl }))
}
