import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import styles from './WorkspaceView.module.css'
import type {
  AgentSummary,
  Attachment,
  CaveStyle,
  EffortLevel,
  FlowMode,
  ModelAlias,
  PerTaskUiState,
  RepoTarget,
  ServerConfig,
  Task,
  TaskEvent,
  WorkspaceLayout,
  WorktreeFileNode,
  WorktreeFileTree,
} from '../types'
import { api } from '../api'
import { FileTree } from './FileTree'
import { WorkspaceTabs } from './WorkspaceTabs'
import { NewTaskForm } from './NewTaskForm'
import { TaskList } from './TaskList'
import { TaskControls } from './TaskControls'
import { TerminalDock } from './TerminalDock'
import { NotesPanel } from './NotesPanel'
import { LIVE_STATUSES, STATUS_LABEL, statusColor } from '../status'
import { hydrateLayout, openFile, pruneFileTabs } from '../workspaceLayout'
import { usePanelMount } from '../usePanelMount'

/** Clamp bounds for the Files/Notes split ratio (Files' share of the column). */
const MIN_SPLIT = 0.15
const MAX_SPLIT = 0.85

interface Props {
  task: Task | undefined
  events: TaskEvent[]
  live: string
  /** Per-task UI state, keyed by task id (U5). */
  perTask: Record<string, PerTaskUiState>
  onPerTaskChange: (taskId: string, patch: Partial<PerTaskUiState>) => void
  /** Right-bar task rail (the former Tasks-page left rail, merged in). */
  tasks: Task[]
  repos: RepoTarget[]
  config: ServerConfig | null
  selectedId: string | null
  railCollapsed: boolean
  onRailCollapsedChange: (v: boolean) => void
  /** Bottom-dock terminal chrome (persisted global UI state, threaded from App). */
  dockOpen: boolean
  dockHeight: number
  onDockOpenChange: (v: boolean) => void
  onDockHeightChange: (h: number) => void
  /** Bottom-nav pane visibility (persisted global UI state) + Settings modal. */
  tasksOpen: boolean
  workspaceOpen: boolean
  filesOpen: boolean
  notesOpen: boolean
  onTasksOpenChange: (v: boolean) => void
  onWorkspaceOpenChange: (v: boolean) => void
  onFilesOpenChange: (v: boolean) => void
  onNotesOpenChange: (v: boolean) => void
  /** The Notes panel's own worktree/task choice (persisted global UI state). */
  notesTaskId: string | null
  onNotesTaskIdChange: (id: string) => void
  /** Files' share (0..1) of the left column's height when Files + Notes are
   *  both open (persisted global UI state). */
  filesNotesSplit: number
  onFilesNotesSplitChange: (ratio: number) => void
  settingsOpen: boolean
  onSettingsToggle: () => void
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
  /** Selected-task lifecycle actions (moved from TaskDetail). */
  onStart: () => Promise<unknown>
  onMessage: (text: string, attachments?: Attachment[]) => Promise<unknown>
  onResume: () => Promise<unknown>
  onInterrupt: () => Promise<unknown>
  onDone: () => Promise<unknown>
  onCancel: () => Promise<unknown>
  onDelete: () => Promise<unknown>
}

/** Collect every file node's path in the tree — the set a persisted tab path
 *  must still belong to, else its tab is pruned (the deleted-file case). */
function collectFilePaths(entries: WorktreeFileNode[], acc: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.type === 'file') acc.push(entry.path)
    if (entry.children) collectFilePaths(entry.children, acc)
  }
  return acc
}

/** The active file path in the active pane, if any — used to highlight the tree
 *  row and to give Notes its `selectedPath`. */
function activeFilePath(layout: WorkspaceLayout): string | null {
  const pane = layout.panes[layout.activePane]
  const tab = pane?.tabs.find((t) => t.id === pane.activeId)
  return tab?.kind === 'file' ? (tab.path ?? null) : null
}

/** Sentinel tree key for the no-task Projects-dir listing. */
const PROJECTS_KEY = '__projects__'

/** File tree tagged with the key it was fetched for (a task id, or PROJECTS_KEY
 *  for the no-task Projects-dir tree), so a stale tree from a previous selection
 *  is never shown against the wrong source. */
interface Loaded {
  id: string
  tree: WorktreeFileTree
}

export function WorkspaceView({
  task,
  events,
  live,
  perTask,
  onPerTaskChange,
  tasks,
  repos,
  config,
  selectedId,
  railCollapsed,
  onRailCollapsedChange,
  dockOpen,
  dockHeight,
  onDockOpenChange,
  onDockHeightChange,
  tasksOpen,
  workspaceOpen,
  filesOpen,
  notesOpen,
  onTasksOpenChange,
  onWorkspaceOpenChange,
  onFilesOpenChange,
  onNotesOpenChange,
  notesTaskId,
  onNotesTaskIdChange,
  filesNotesSplit,
  onFilesNotesSplitChange,
  settingsOpen,
  onSettingsToggle,
  onSelect,
  onCreate,
  onStart,
  onMessage,
  onResume,
  onInterrupt,
  onDone,
  onCancel,
  onDelete,
}: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [nonce, setNonce] = useState(0)
  const [layout, setLayout] = useState<WorkspaceLayout>(() => hydrateLayout())
  // Tracks which task `layout` was hydrated for, so a task switch re-hydrates it
  // during render (not via an effect) — same pattern as the old open-file state.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)
  // Tracks which fetched tree the layout was last pruned against, so stale file
  // tabs are dropped once per tree load without a set-state-in-effect.
  const [prunedFor, setPrunedFor] = useState<Loaded | null>(null)
  // Optional chat adapter (U4): fetched once. Empty ⇒ Chat is unavailable.
  const [agents, setAgents] = useState<AgentSummary[]>([])

  useEffect(() => {
    let cancelled = false
    api
      .listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list)
      })
      .catch(() => {
        if (!cancelled) setAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const taskId = task?.id ?? null
  // Other currently-live tasks (excluding this one) — rendered as extra tabs
  // right next to the Worker Log tab so a second concurrently running task's
  // log is one click away, without going back to the task rail.
  const liveTasks = tasks
    .filter((t) => t.id !== taskId && LIVE_STATUSES.has(t.status))
    .map((t) => ({ id: t.id, title: t.title }))
  // Re-fetch when the worktree appears/changes (it is null until the branch is cut).
  const worktree = task?.worktree ?? null
  // With a task selected, show its worktree; with none, the Projects-dir tree.
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
    // `worktree` + `nonce` re-fetch when the worktree appears or on manual refresh.
  }, [taskId, treeKey, worktree, nonce])

  // Restore the persisted tab layout when the selected task changes. Adjusted
  // during render (not an effect) per the "adjusting state on a prop change"
  // pattern — avoids the react-hooks/set-state-in-effect rule.
  if (taskId !== hydratedFor) {
    setHydratedFor(taskId)
    setPrunedFor(null)
    const stored = taskId ? perTask[taskId]?.layout : undefined
    const legacy = taskId ? perTask[taskId]?.activePath : undefined
    setLayout(hydrateLayout(stored, legacy ?? null))
  }

  const current = loaded && loaded.id === treeKey ? loaded.tree : null
  const hasTree = !!current && current.entries.length > 0

  // Drop file tabs whose path no longer exists in the freshly fetched tree
  // (deleted files). Reconciled once per tree load, in render, without an effect.
  if (current && loaded && loaded !== prunedFor && taskId === hydratedFor) {
    setPrunedFor(loaded)
    if (current.entries.length > 0) {
      const pruned = pruneFileTabs(layout, collectFilePaths(current.entries))
      if (JSON.stringify(pruned) !== JSON.stringify(layout)) setLayout(pruned)
    }
  }

  const applyLayout = useCallback(
    (next: WorkspaceLayout) => {
      setLayout(next)
      if (taskId) onPerTaskChange(taskId, { layout: next })
    },
    [taskId, onPerTaskChange],
  )

  // Opening a file always reveals the Workspace pane so its content is visible,
  // even when the pane was toggled closed (matches the "open file → show it" ask).
  const openInLayout = useCallback(
    (path: string) => {
      applyLayout(openFile(layout, path))
      if (!workspaceOpen) onWorkspaceOpenChange(true)
    },
    [applyLayout, layout, workspaceOpen, onWorkspaceOpenChange],
  )

  const selectedPath = activeFilePath(layout)

  // The Notes panel auto-follows the app's selected task (if it has a
  // worktree) whenever the selection changes; the operator's own dropdown
  // pick otherwise stands. Derived during render — the "adjust state on a
  // prop change" pattern used elsewhere in this file — rather than an effect.
  const [notesSyncedFor, setNotesSyncedFor] = useState<string | null>(null)
  if (selectedId !== notesSyncedFor) {
    setNotesSyncedFor(selectedId)
    if (selectedId && selectedId !== notesTaskId && tasks.some((t) => t.id === selectedId && t.worktree)) {
      onNotesTaskIdChange(selectedId)
    }
  }

  // The Files sidebar, the Notes panel, the Workspace centre pane, and the
  // Tasks rail each toggle from the bottom nav bar. Each stays mounted a beat
  // past its toggle-off so its closing (minimize) animation can play —
  // `usePanelMount` — while `columns` reserves grid space for the whole
  // mounted lifetime so the exit animation has room to play before its
  // column collapses. Files and Notes share the left column: both mounted ⇒
  // a 50/50-by-default vertical split (draggable); only one mounted ⇒ it
  // fills the column.
  const sidebarMounted = usePanelMount(filesOpen)
  const notesMounted = usePanelMount(notesOpen)
  const centerMounted = usePanelMount(workspaceOpen)
  const rightMounted = usePanelMount(tasksOpen)
  const leftMounted = sidebarMounted || notesMounted
  const leftSplit = sidebarMounted && notesMounted

  const columns: string[] = []
  if (leftMounted) columns.push('240px')
  if (centerMounted) columns.push('minmax(0, 1fr)')
  if (rightMounted) columns.push(railCollapsed ? '56px' : '348px')
  const gridTemplateColumns = columns.join(' ') || '0px'

  const leftColumnRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startY: number; startSplit: number } | null>(null)
  const onSplitDragStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const columnHeight = leftColumnRef.current?.clientHeight || 1
      dragRef.current = { startY: e.clientY, startSplit: filesNotesSplit }
      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return
        const delta = (ev.clientY - drag.startY) / columnHeight
        const next = Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, drag.startSplit + delta))
        onFilesNotesSplitChange(next)
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [filesNotesSplit, onFilesNotesSplitChange],
  )

  return (
    <div className={styles.shell}>
      <div className={styles.workspace} style={{ gridTemplateColumns }}>
        {leftMounted && (
        <div ref={leftColumnRef} className={styles.leftColumn}>
        {sidebarMounted && (
        <aside
          className={`${styles.sidebar} ${filesOpen ? styles.paneEnter : styles.paneExit}`}
          style={leftSplit ? { flex: `${filesNotesSplit} 1 0` } : undefined}
        >
        <div className={styles.sidebarHead}>
          <span className={styles.sidebarTitle}>{task ? 'Files' : 'Projects'}</span>
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
        <div className={styles.sidebarBody}>
          {!current ? (
            <div className={styles.empty}>Loading…</div>
          ) : hasTree ? (
            <FileTree entries={current.entries} onOpen={openInLayout} selectedPath={selectedPath} />
          ) : task ? (
            <div className={styles.empty}>
              No worktree yet — the file tree appears once this task starts working.
            </div>
          ) : (
            <div className={styles.empty}>No projects found in the configured directory.</div>
          )}
        </div>
      </aside>
      )}

      {leftSplit && (
        <div
          className={styles.leftDivider}
          onPointerDown={onSplitDragStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize Files/Notes split"
        />
      )}

      {notesMounted && (
        <aside
          className={`${styles.notesAside} ${notesOpen ? styles.paneEnter : styles.paneExit}`}
          style={leftSplit ? { flex: `${1 - filesNotesSplit} 1 0` } : undefined}
        >
          <NotesPanel
            tasks={tasks}
            notesTaskId={notesTaskId}
            onNotesTaskIdChange={onNotesTaskIdChange}
            selectedPath={selectedPath}
            onOpen={openInLayout}
          />
        </aside>
      )}
      </div>
      )}

      {centerMounted && (
        <div className={`${styles.center} ${workspaceOpen ? styles.paneEnter : styles.paneExit}`}>
          <WorkspaceTabs
            taskId={taskId}
            taskTitle={task?.title ?? null}
            status={task?.status ?? null}
            events={events}
            live={live}
            agents={agents}
            layout={layout}
            onLayoutChange={applyLayout}
            onMessage={task ? onMessage : undefined}
            liveTasks={liveTasks}
            onSelectTask={onSelect}
          />
        </div>
      )}

      {rightMounted && (
      <aside
        className={`${styles.rightbar} ${railCollapsed ? styles.rightbarMini : ''} ${tasksOpen ? styles.paneEnter : styles.paneExit}`}
      >
        {railCollapsed ? (
          <div className={styles.mini}>
            <button
              type="button"
              className={styles.collapseBtn}
              aria-expanded={false}
              aria-label="Expand task pane"
              title="Expand task pane"
              onClick={() => onRailCollapsedChange(false)}
            >
              ‹
            </button>
            <div className={styles.miniDots}>
              {tasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.miniDot} ${t.id === selectedId ? styles.miniDotActive : ''}`}
                  style={{ background: statusColor(t.status) }}
                  aria-label={`${t.title} — ${STATUS_LABEL[t.status]}`}
                  aria-current={t.id === selectedId ? 'true' : undefined}
                  title={`${t.title} — ${STATUS_LABEL[t.status]}`}
                  onClick={() => onSelect(t.id)}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className={styles.brandbar}>
              <span className={styles.railTitle}>Tasks</span>
              <button
                type="button"
                className={styles.collapseBtn}
                aria-expanded={true}
                aria-label="Collapse task pane"
                title="Collapse task pane"
                onClick={() => onRailCollapsedChange(true)}
              >
                ›
              </button>
            </div>
            <div className={styles.rbBody}>
              <NewTaskForm
                repos={repos}
                defaultRepoId={config?.defaultRepoId ?? ''}
                onCreate={onCreate}
              />
              {task && (
                <TaskControls
                  task={task}
                  config={config}
                  repos={repos}
                  onStart={onStart}
                  onResume={onResume}
                  onInterrupt={onInterrupt}
                  onDone={onDone}
                  onCancel={onCancel}
                  onDelete={onDelete}
                />
              )}
              <TaskList tasks={tasks} repos={repos} selectedId={selectedId} onSelect={onSelect} />
            </div>
          </>
        )}
      </aside>
      )}
      </div>

      <TerminalDock
        open={dockOpen}
        height={dockHeight}
        onOpenChange={onDockOpenChange}
        onHeightChange={onDockHeightChange}
        tasksOpen={tasksOpen}
        workspaceOpen={workspaceOpen}
        filesOpen={filesOpen}
        notesOpen={notesOpen}
        settingsOpen={settingsOpen}
        onTasksToggle={() => onTasksOpenChange(!tasksOpen)}
        onWorkspaceToggle={() => onWorkspaceOpenChange(!workspaceOpen)}
        onFilesToggle={() => onFilesOpenChange(!filesOpen)}
        onNotesToggle={() => onNotesOpenChange(!notesOpen)}
        onSettingsToggle={onSettingsToggle}
      />
    </div>
  )
}
