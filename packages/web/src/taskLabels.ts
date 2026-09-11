// Pure, React-free label helpers. Kept out of the components so formatting is
// unit-testable without a DOM (same seam pattern as `updateGate.ts`).

import type { Task } from './types'

/**
 * Status-bar label for a task's model/effort. Both `model` and `effort` persist
 * as NULL until the operator explicitly picks one or a phase resolves its own
 * default at spawn (direct → sonnet/medium, clarify → sonnet, plan → opus/high).
 * A null part therefore renders as `auto` — the resolved-at-spawn state — rather
 * than the literal string "null". No selected task → `idle`.
 */
export function modelEffortLabel(task: Task | undefined): string {
  if (!task) return 'idle'
  return `${task.model ?? 'auto'} / ${task.effort ?? 'auto'}`
}
