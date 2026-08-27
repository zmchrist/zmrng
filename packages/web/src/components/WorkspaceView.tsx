import { useCallback, useEffect, useState } from 'react'
import styles from './WorkspaceView.module.css'
import type {
  Attachment,
  CaveStyle,
  EffortLevel,
  FlowMode,
  ModelAlias,
  RepoTarget,
  ServerConfig,
  Task,
  TaskEvent,
  WorktreeFileNode,
  WorktreeFileTree,
} from '../types'
import { api } from '../api'
import { FileTree } from './FileTree'
import { Viewer } from './Viewer'
import { NewTaskForm } from './NewTaskForm'
import { TaskList } from './TaskList'
import { ChatPane } from './ChatPane'
import { Terminal } from './Terminal'
import { WorkerLogPanel } from './WorkerLogPanel'
import type { HandoffPrefill } from '../teamHandoff'

/** Worker-pane tabs — the fixed Cosmos IDE tab set (replaces the draggable grid). */
type PaneTab = 'worker' | 'files' | 'terminal' | 'chat'
const PANE_TABS: ReadonlyArray<{ id: PaneTab; label: string }> = [
  { id: 'worker', label: 'Worker' },
  { id: 'files', label: 'Files' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'chat', label: 'Chat' },
]

interface Props {
  task: Task | undefined
  events: TaskEvent[]
  live: string
  tasks: Task[]
  repos: RepoTarget[]
  config: ServerConfig | null
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: (
    title: string,
    body: string,
    opts: {
      model: ModelAlias
      effort: EffortLevel
      style: CaveStyle
      flow: FlowMode
      repoId: string
    },
    attachments?: Attachment[],
  ) => Promise<void>
  prefill?: HandoffPrefill | null
  onPrefillConsumed?: () => void
  onStart: () => Promise<unknown>
  onMessage: (text: string, attachments?: Attachment[]) => Promise<unknown>
  onResume: () => Promise<unknown>
  onInterrupt: () => Promise<unknown>
  onDone: () => Promise<unknown>
  onCancel: () => Promise<unknown>
  onDelete: () => Promise<unknown>
}

/** Collect every file node's path — used to highlight / clear the tree selection. */
function collectFilePaths(entries: WorktreeFileNode[], acc: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.type === 'file') acc.push(entry.path)
    if (entry.children) collectFilePaths(entry.children, acc)
  }
  return acc
}

/** Sentinel tree key for the no-task Projects-dir listing. */
const PROJECTS_KEY = '__projects__'

interface Loaded {
  id: string
  tree: WorktreeFileTree
}

/**
 * The Cosmos Workspace CENTER: a task panel (task list + new-task) beside a
 * worker pane (Worker · Files · Terminal · Chat tabs). The persistent app frame
 * (title bar, activity rail, status bar) lives in App and stays static across
 * every mode; this component only fills the center content region.
 */
export function WorkspaceView({
  task,
  events,
  live,
  tasks,
  repos,
  config,
  selectedId,
  onSelect,
  onCreate,
  prefill,
  onPrefillConsumed,
  onStart,
  onMessage,
  onResume,
  onInterrupt,
  onDone,
  onCancel,
  onDelete,
}: Props) {
  const [tab, setTab] = useState<PaneTab>('worker')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [nonce, setNonce] = useState(0)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [seenPrefill, setSeenPrefill] = useState<HandoffPrefill | null>(null)

  const taskId = task?.id ?? null
  const worktree = task?.worktree ?? null
  const treeKey = taskId ?? PROJECTS_KEY

  useEffect(() => {
    let cancelled = false
    const fetchTree = taskId ? api.getFiles(taskId) : api.getProjectFiles()
    fetchTree
      .then((tree) => {
        if (!cancelled) setLoaded({ id: treeKey, tree })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: treeKey, tree: { root: null, entries: [] } })
      })
    return () => {
      cancelled = true
    }
  }, [taskId, treeKey, worktree, nonce])

  const current = loaded && loaded.id === treeKey ? loaded.tree : null
  const hasTree = !!current && current.entries.length > 0

  // Clear the selected file when it no longer exists in a freshly fetched tree
  // (adjust-state-during-render pattern — avoids a set-state-in-effect).
  if (current && selectedPath && !collectFilePaths(current.entries).includes(selectedPath)) {
    setSelectedPath(null)
  }

  // A one-shot handoff prefill (Team → "Send to my zmrng") pops the modal open.
  // Guarded by object identity so it fires once per send, in render.
  if (prefill && prefill !== seenPrefill) {
    setSeenPrefill(prefill)
    setNewTaskOpen(true)
  }

  const openFile = useCallback((path: string) => {
    setSelectedPath(path)
    setTab('files')
  }, [])

  const status = task?.status ?? null

  return (
    <div className={styles.center}>
      <aside className={styles.tasksPanel}>
        <div className={styles.tasksHead}>
          <span className={styles.tasksLabel}>Tasks</span>
          <button
            type="button"
            className={styles.addTask}
            aria-label="New task"
            title="New task"
            onClick={() => setNewTaskOpen(true)}
          >
            +
          </button>
        </div>
        <div className={styles.tasksScroll}>
          <TaskList
            tasks={tasks}
            repos={repos}
            selectedId={selectedId}
            onSelect={onSelect}
            config={config}
            onStart={onStart}
            onResume={onResume}
            onInterrupt={onInterrupt}
            onDone={onDone}
            onCancel={onCancel}
            onDelete={onDelete}
          />
        </div>
      </aside>

      <section className={styles.pane}>
        <div className={styles.tabStrip} role="tablist" aria-label="Worker pane">
          {PANE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.paneBody}>
          {/* Worker */}
          <div
            className={styles.tabPanel}
            style={{ display: tab === 'worker' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <WorkerLogPanel
              events={events}
              live={live}
              status={status}
              onMessage={task ? onMessage : undefined}
            />
          </div>

          {/* Files */}
          <div
            className={styles.tabPanel}
            style={{ display: tab === 'files' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <div className={styles.filesSplit}>
              <div className={styles.fileTreeCol}>
                <div className={styles.filesToolbar}>
                  <span className={styles.filesLabel}>{task ? 'Files' : 'Projects'}</span>
                  <button
                    type="button"
                    className={styles.refresh}
                    onClick={() => setNonce((n) => n + 1)}
                    aria-label="Refresh file tree"
                    title="Refresh file tree"
                  >
                    ↻
                  </button>
                </div>
                <div className={styles.fileTreeScroll}>
                  {!current ? (
                    <div className={styles.paneEmpty}>Loading…</div>
                  ) : hasTree ? (
                    <FileTree
                      entries={current.entries}
                      onOpen={openFile}
                      selectedPath={selectedPath}
                    />
                  ) : task ? (
                    <div className={styles.paneEmpty}>
                      No worktree yet — the file tree appears once this task starts working.
                    </div>
                  ) : (
                    <div className={styles.paneEmpty}>
                      No projects found in the configured directory.
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.viewerCol}>
                <Viewer taskId={taskId} path={selectedPath} />
              </div>
            </div>
          </div>

          {/* Terminal — kept mounted so the PTY session survives tab switches. */}
          <div
            className={styles.tabPanel}
            style={{ display: tab === 'terminal' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <Terminal id="workspace-terminal" />
          </div>

          {/* Chat — kept mounted so the /ws/chat session survives tab switches. */}
          <div
            className={styles.tabPanel}
            style={{ display: tab === 'chat' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <ChatPane id="workspace-chat" />
          </div>
        </div>
      </section>

      {/* new-task modal */}
      {newTaskOpen && (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setNewTaskOpen(false)
          }}
        >
          <div className={styles.modalPanel} role="dialog" aria-modal="true" aria-label="New task">
            <div className={styles.modalHead}>
              <span className={styles.modalTitle}>New task</span>
              <button
                type="button"
                className={styles.modalClose}
                aria-label="Close"
                title="Close"
                onClick={() => setNewTaskOpen(false)}
              >
                ×
              </button>
            </div>
            <NewTaskForm
              repos={repos}
              defaultRepoId={config?.defaultRepoId ?? ''}
              onCreate={onCreate}
              prefill={prefill}
              onPrefillConsumed={onPrefillConsumed}
              embedded
              onRequestClose={() => setNewTaskOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
