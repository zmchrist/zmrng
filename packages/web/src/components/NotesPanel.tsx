import styles from './NotesPanel.module.css'
import type { Task } from '../types'
import { Notes } from './Notes'

interface Props {
  tasks: Task[]
  /** Persisted global choice; may point at a task with no worktree (stale) or
   *  be absent — the effective task is resolved below. */
  notesTaskId: string | null
  onNotesTaskIdChange: (id: string) => void
  selectedPath: string | null
  onOpen: (path: string) => void
}

/**
 * Left-column Notes panel. Independent of the app's selected task: it owns its
 * own worktree/task dropdown (only tasks with a worktree can hold notes), and
 * the effective selection falls back to the first worktree-bearing task when
 * `notesTaskId` doesn't (or no longer) resolve to one. Auto-following the app's
 * selected task on change is handled by the parent (`WorkspaceView`), which
 * calls `onNotesTaskIdChange` when the selected task changes — this component
 * only renders the current choice and lets the operator override it.
 */
export function NotesPanel({ tasks, notesTaskId, onNotesTaskIdChange, selectedPath, onOpen }: Props) {
  const worktreeTasks = tasks.filter((t) => t.worktree)
  const effectiveId = worktreeTasks.some((t) => t.id === notesTaskId)
    ? notesTaskId
    : (worktreeTasks[0]?.id ?? null)

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.title}>Notes</span>
        <select
          className={styles.select}
          value={effectiveId ?? ''}
          disabled={worktreeTasks.length === 0}
          onChange={(e) => onNotesTaskIdChange(e.target.value)}
          aria-label="Notes worktree"
        >
          {worktreeTasks.length === 0 ? (
            <option value="">No worktrees</option>
          ) : (
            worktreeTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))
          )}
        </select>
      </div>
      <div className={styles.body}>
        <Notes taskId={effectiveId} selectedPath={selectedPath} onOpen={onOpen} />
      </div>
    </div>
  )
}
