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
import { ChatCard } from './ChatCard'
import { TerminalCard } from './TerminalCard'
import { WorkerLogPanel } from './WorkerLogPanel'
import { SecurityPanel } from './SecurityPanel'
import type { ChatTabState, TabsState, TerminalTabState } from '../windowTabs'
import type { HandoffPrefill } from '../teamHandoff'
import type { SecurityScan } from '../types'

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
  /** Persisted security-scan rounds for the selected task (Security panel). */
  securityScans: SecurityScan[]
  live: string
  tasks: Task[]
  repos: RepoTarget[]
  config: ServerConfig | null
  selectedId: string | null
  /** Whether the Tasks side panel is collapsed (ephemeral, driven by re-clicking
   *  the Workspace activity-rail button). */
  tasksCollapsed: boolean
  /** Per-tab state for the multi-tab Chat and Terminal panes + their
   *  persistence sinks (global UI state). Feed the tabbed ChatCard/TerminalCard
   *  dropped into the IDE's Chat/Terminal tabs. */
  chatTabs: TabsState<ChatTabState>
  onChatTabsChange: (next: TabsState<ChatTabState>) => void
  terminalTabs: TabsState<TerminalTabState>
  onTerminalTabsChange: (next: TabsState<TerminalTabState>) => void
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
  onRestart: () => Promise<unknown>
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
  securityScans,
  live,
  tasks,
  repos,
  config,
  selectedId,
  tasksCollapsed,
  chatTabs,
  onChatTabsChange,
  terminalTabs,
  onTerminalTabsChange,
  onSelect,
  onCreate,
  prefill,
  onPrefillConsumed,
  onStart,
  onMessage,
  onResume,
  onRestart,
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

  // Clicking a task row selects it AND brings the Worker pane to the front, so
  // the operator always lands on that task's live worker log (#95).
  const onSelectRow = useCallback(
    (id: string) => {
      onSelect(id)
      setTab('worker')
    },
    [onSelect],
  )

  const status = task?.status ?? null

  return (
    <div className={styles.center}>
      <aside
        className={`${styles.tasksPanel} ${tasksCollapsed ? styles.tasksPanelCollapsed : ''}`}
        aria-hidden={tasksCollapsed || undefined}
      >
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
            onSelect={onSelectRow}
            config={config}
            onStart={onStart}
            onResume={onResume}
            onRestart={onRestart}
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
              stale={task?.stale}
              onMessage={task ? onMessage : undefined}
            />
            {task && (task.securityStatus !== undefined || securityScans.length > 0) && (
              <SecurityPanel securityStatus={task.securityStatus} scans={securityScans} />
            )}
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

          {/* Terminal — multi-tab card; every PTY tab stays mounted so sessions
              survive both card-tab and pane-tab switches. */}
          <div
            className={styles.tabPanel}
            style={{ display: tab === 'terminal' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <TerminalCard tabs={terminalTabs} onTabsChange={onTerminalTabsChange} />
          </div>

          {/* Chat — multi-tab card (per-tab repo picker); every /ws/chat tab stays
              mounted so sessions survive tab switches. */}
          <div
            className={styles.tabPanel}
            style={{ display: tab === 'chat' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <ChatCard tabs={chatTabs} onTabsChange={onChatTabsChange} repos={repos} />
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
