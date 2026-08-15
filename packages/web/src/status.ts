import type { TaskStatus } from './types'

/** CSS custom property carrying the pill color for a status. */
export function statusColor(s: TaskStatus): string {
  return `var(--status-${s})`
}

/** Known actors backed by a dedicated --actor-* token in theme.css. */
const KNOWN_ACTORS = new Set([
  'main',
  'frontend-specialist',
  'backend-specialist',
  'qa',
  'code-reviewer',
  'doc-updater',
  'general-purpose',
])

/**
 * CSS custom property carrying the accent color for an actor (the main worker
 * or a subagent type). Slugifies the actor to match the token names; falls
 * back to a neutral --actor-default for any unknown actor.
 */
export function actorColor(actor: string): string {
  const slug = actor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return KNOWN_ACTORS.has(slug) ? `var(--actor-${slug})` : 'var(--actor-default)'
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  clarify: 'Clarifying',
  planning: 'Planning',
  executing: 'Executing',
  validating: 'Validating',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  failed: 'Failed',
  building: 'Building',
  archived: 'Archived',
}
