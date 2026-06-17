import type { TaskStatus } from './types'

/** CSS custom property carrying the pill color for a status. */
export function statusColor(s: TaskStatus): string {
  return `var(--status-${s})`
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  clarify: 'Clarifying',
  building: 'Building',
  review: 'Review',
  done: 'Done',
  failed: 'Failed',
}
