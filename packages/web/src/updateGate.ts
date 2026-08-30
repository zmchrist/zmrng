// Pure, React-free helpers for the local-app update UX (WS-B / D3, D3a). Kept
// out of the React components so the gating logic is unit-testable without a
// DOM. The banner/App components stay thin; these are the pure seams.

import type { Task, TaskStatus } from './types'

/**
 * Statuses that mean a local task is actively mid-flight — updating (which
 * restarts the server) would interrupt them. D3a blocks-with-confirm while any
 * task is in one of these.
 */
const LIVE_STATUSES: readonly TaskStatus[] = ['planning', 'executing', 'validating']

/** Normalise the tasks container (array or id-keyed record) to a flat list. */
function toList(tasks: Task[] | Record<string, Task>): Task[] {
  return Array.isArray(tasks) ? tasks : Object.values(tasks)
}

/** How many tasks are in a live status (planning/executing/validating). */
export function liveTaskCount(tasks: Task[] | Record<string, Task>): number {
  return toList(tasks).filter((t) => LIVE_STATUSES.includes(t.status)).length
}

/** True iff any task is live — the update must block-with-confirm (D3a). */
export function shouldBlockUpdate(tasks: Task[] | Record<string, Task>): boolean {
  return liveTaskCount(tasks) > 0
}

/**
 * True iff a self-update is actually available: both shas are known (non-empty)
 * and differ. An unknown local or advertised sha (empty/undefined) is never a
 * confident "update available" — we would rather under-prompt than nag.
 */
export function updateAvailable(
  localSha: string | undefined,
  advertisedSha: string | undefined,
): boolean {
  if (!localSha || !advertisedSha) return false
  return localSha !== advertisedSha
}
