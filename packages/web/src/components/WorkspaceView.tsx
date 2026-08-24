import { useCallback, useEffect, useState, type ReactNode } from 'react'
import viewStyles from './WorkspaceView.module.css'
import gridStyles from './WorkspaceGrid.module.css'
import type {
  AgentSummary,
  Attachment,
  CaveStyle,
  EffortLevel,
  FlowMode,
  GridCardId,
  GridState,
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
import { WorkerLogPanel } from './WorkerLogPanel'
import { ChatPane } from './ChatPane'
import { Terminal } from './Terminal'
import { PipelineCard } from './PipelineCard'
import { ConcurrencyCard } from './ConcurrencyCard'
import { ReviewQueueCard } from './ReviewQueueCard'
import { WorkspaceGrid } from './WorkspaceGrid'
import { BottomNav } from './BottomNav'
import { LIVE_STATUSES } from '../status'
import { hydrateLayout, openFile, pruneFileTabs } from '../workspaceLayout'
import { showCard } from '../gridLayout'

interface Props {
  task: Task | undefined
  events: TaskEvent[]
  live: string
  /** Per-task UI state, keyed by task id (U5). */
  perTask: Record<string, PerTaskUiState>
  onPerTaskChange: (taskId: string, patch: Partial<PerTaskUiState>) => void
  tasks: Task[]
  repos: RepoTarget[]
  config: ServerConfig | null
  selectedId: string | null
  /** The Workspace dashboard-grid state + its persistence sink (global UI state). */
  grid: GridState
  onGridChange: (next: GridState) => void
  settingsOpen: boolean
  onSettingsToggle: () => void
  connected: boolean
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

/** The active file path in the active pane, if any — used to highlight the tree. */
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
  grid,
  onGridChange,
  settingsOpen,
  onSettingsToggle,
  connected,
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
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)
  const [prunedFor, setPrunedFor] = useState<Loaded | null>(null)
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
  const liveTasks = tasks
    .filter((t) => t.id !== taskId && LIVE_STATUSES.has(t.status))
    .map((t) => ({ id: t.id, title: t.title }))
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

  // Restore the persisted tab layout when the selected task changes (in render,
  // per the "adjust state on a prop change" pattern — avoids set-state-in-effect).
  if (taskId !== hydratedFor) {
    setHydratedFor(taskId)
    setPrunedFor(null)
    const stored = taskId ? perTask[taskId]?.layout : undefined
    const legacy = taskId ? perTask[taskId]?.activePath : undefined
    setLayout(hydrateLayout(stored, legacy ?? null))
  }

  const current = loaded && loaded.id === treeKey ? loaded.tree : null
  const hasTree = !!current && current.entries.length > 0

  // Drop file tabs whose path no longer exists in the freshly fetched tree.
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

  // Opening a file always reveals the Viewers card so its content is visible,
  // even when that card was hidden (matches the "open file → show it" ask).
  const openInLayout = useCallback(
    (path: string) => {
      applyLayout(openFile(layout, path))
      if (grid.cards.find((c) => c.id === 'viewers')?.hidden) {
        onGridChange(showCard(grid, 'viewers'))
      }
    },
    [applyLayout, layout, grid, onGridChange],
  )

  const selectedPath = activeFilePath(layout)

  const filesBody: ReactNode = (
    <>
      <div className={gridStyles.filesToolbar}>
        <span className={gridStyles.filesLabel}>{task ? 'Files' : 'Projects'}</span>
        <button
          type="button"
          className={gridStyles.refresh}
          onClick={() => setNonce((n) => n + 1)}
          aria-label="Refresh file tree"
          title="Refresh file tree"
        >
          ↻
        </button>
      </div>
      <div className={gridStyles.filesTree}>
        {!current ? (
          <div className={gridStyles.cardEmpty}>Loading…</div>
        ) : hasTree ? (
          <FileTree entries={current.entries} onOpen={openInLayout} selectedPath={selectedPath} />
        ) : task ? (
          <div className={gridStyles.cardEmpty}>
            No worktree yet — the file tree appears once this task starts working.
          </div>
        ) : (
          <div className={gridStyles.cardEmpty}>No projects found in the configured directory.</div>
        )}
      </div>
    </>
  )

  const content: Record<GridCardId, ReactNode> = {
    pipeline: <PipelineCard tasks={tasks} />,
    concurrency: <ConcurrencyCard tasks={tasks} maxLanes={config?.maxLanes ?? 0} />,
    reviewqueue: <ReviewQueueCard tasks={tasks} repos={repos} onSelect={onSelect} />,
    newtask: (
      <NewTaskForm repos={repos} defaultRepoId={config?.defaultRepoId ?? ''} onCreate={onCreate} />
    ),
    activetask: task ? (
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
    ) : (
      <div className={gridStyles.cardEmpty}>No task selected.</div>
    ),
    workerlog: (
      <WorkerLogPanel
        events={events}
        live={live}
        status={task?.status ?? null}
        onMessage={task ? onMessage : undefined}
      />
    ),
    tasklist: <TaskList tasks={tasks} repos={repos} selectedId={selectedId} onSelect={onSelect} />,
    files: filesBody,
    viewers: (
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
    ),
    chat: <ChatPane id="workspace-chat" />,
    terminal: <Terminal id="workspace-terminal" />,
  }

  return (
    <div className={viewStyles.shell}>
      <WorkspaceGrid grid={grid} onGridChange={onGridChange} content={content} />
      <BottomNav
        grid={grid}
        onGridChange={onGridChange}
        settingsOpen={settingsOpen}
        onSettingsToggle={onSettingsToggle}
        connected={connected}
      />
    </div>
  )
}
