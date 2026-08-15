import { useEffect, useState } from 'react'
import styles from './WorkspaceView.module.css'
import type { Task, TaskEvent, WorktreeFileTree } from '../types'
import { api } from '../api'
import { FileTree } from './FileTree'
import { WorkerLog } from './WorkerLog'

interface Props {
  task: Task | undefined
  events: TaskEvent[]
  live: string
}

/** A collapsible dock card in the right rail — a labelled slot for future U3/U4 content. */
function RailCard({
  title,
  hint,
  slot,
  defaultOpen = true,
}: {
  title: string
  hint: string
  slot: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={styles.card}>
      <button
        type="button"
        className={styles.cardHead}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden>
          ▸
        </span>
        <span className={styles.cardTitle}>{title}</span>
        <span className={styles.cardHint}>{hint}</span>
      </button>
      {open && (
        <div className={styles.cardBody}>
          <div className={styles.dockSlot}>{slot}</div>
        </div>
      )}
    </section>
  )
}

/** File tree tagged with the task id it was fetched for, so a stale tree from a
 *  previous selection is never shown against the wrong task. */
interface Loaded {
  id: string
  tree: WorktreeFileTree
}

export function WorkspaceView({ task, events, live }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [nonce, setNonce] = useState(0)

  const taskId = task?.id ?? null
  // Re-fetch when the worktree appears/changes (it is null until the branch is cut).
  const worktree = task?.worktree ?? null

  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    api
      .getFiles(taskId)
      .then((tree) => {
        if (!cancelled) setLoaded({ id: taskId, tree })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: taskId, tree: { root: null, entries: [] } })
      })
    return () => {
      cancelled = true
    }
    // `worktree` + `nonce` re-fetch when the worktree appears or on manual refresh.
  }, [taskId, worktree, nonce])

  const current = loaded && loaded.id === taskId ? loaded.tree : null
  const hasTree = !!current && current.entries.length > 0

  return (
    <div className={styles.workspace}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <span className={styles.sidebarTitle}>Files</span>
          {task && (
            <button
              type="button"
              className={styles.refresh}
              onClick={() => setNonce((n) => n + 1)}
              aria-label="Refresh file tree"
              title="Refresh file tree"
            >
              ↻
            </button>
          )}
        </div>
        <div className={styles.sidebarBody}>
          {!task ? (
            <div className={styles.empty}>Select a task to browse its worktree.</div>
          ) : !current ? (
            <div className={styles.empty}>Loading…</div>
          ) : hasTree ? (
            <FileTree entries={current.entries} />
          ) : (
            <div className={styles.empty}>
              No worktree yet — the file tree appears once this task starts working.
            </div>
          )}
        </div>
      </aside>

      <div className={styles.center}>
        <div className={styles.viewer}>
          <div className={styles.dockSlot}>
            Viewer — open a file to preview it here.
            <span className={styles.dockSlotSub}>Multi-format viewer coming soon.</span>
          </div>
        </div>
        <div className={styles.logPane}>
          {task ? (
            <WorkerLog events={events} live={live} />
          ) : (
            <div className={styles.empty}>Select a task to follow its worker log.</div>
          )}
        </div>
      </div>

      <aside className={styles.rightRail}>
        <RailCard title="Chat" hint="U4" slot="Chat with the worker — coming soon." />
        <RailCard title="Notes" hint="U3" slot="Task notes — coming soon." />
      </aside>
    </div>
  )
}
