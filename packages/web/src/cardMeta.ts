// Presentational metadata for the dashboard-grid cards: display titles and the
// per-card accent token (used by the `accent` card-style's left edge). Pure
// string maps — no React — so both `WorkspaceGrid.tsx` (rendering) and
// `BottomNav.tsx` (the Cards show/hide menu) can import them without a cycle.
// Every accent is a `var(--*)` token, so the theme switch recolors the grid.

import type { GridCardId } from './types'

/** Human title for each card, shown in the card header and the Cards menu. */
export const CARD_TITLES: Record<GridCardId, string> = {
  pipeline: 'Pipeline',
  concurrency: 'Concurrency',
  reviewqueue: 'Review queue',
  newtask: 'New task',
  tasklist: 'Task list',
  files: 'Files',
  viewers: 'Viewers',
  chat: 'Chat',
  terminal: 'Terminal',
}

/** Accent token per card for the `accent` card-style left edge. */
export const CARD_ACCENTS: Record<GridCardId, string> = {
  pipeline: 'var(--accent)',
  concurrency: 'var(--status-executing)',
  reviewqueue: 'var(--status-review)',
  newtask: 'var(--accent)',
  tasklist: 'var(--status-backlog)',
  files: 'var(--actor-frontend-specialist)',
  viewers: 'var(--accent)',
  chat: 'var(--actor-code-reviewer)',
  terminal: 'var(--actor-backend-specialist)',
}
