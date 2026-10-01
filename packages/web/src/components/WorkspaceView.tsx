import { useCallback, useEffect, useState } from 'react'
import { NavIcon } from './NavIcon'
import styles from './WorkspaceView.module.css'
import type {
  Attachment,
  CaveStyle,
  EffortLevel,
  FlowMode,
  LaneSnapshot,
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
import { LanesPanel } from './LanesPanel'
import { removeChatThread } from '../chatPersistence'
import {
  closeTab,
  focusChatLane,
  focusTerminalSession,
  type ChatTabState,
  type TabsState,
  type TerminalTabState,
} from '../windowTabs'
import type { LaneTarget } from '../laneRows'
import type { HandoffPrefill } from '../teamHandoff'
import type { SecurityScan } from '../types'
import type { MobileWorkspaceView } from '../mobileNav'
import { TASKS_PANEL_KEY } from '../mobileTaskPanel'
import { usePanelSplit } from '../usePanelSplit'
import { PanelHandle } from './PanelHandle'

/** Worker-pane tabs — the fixed Cosmos IDE tab set (replaces the draggable grid). */
type PaneTab = 'worker' | 'files' | 'terminal' | 'chat' | 'lanes'
const PANE_TABS: ReadonlyArray<{ id: PaneTab; label: string }> = [
  { id: 'worker', label: 'Worker' },
  { id: 'files', label: 'Files' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'chat', label: 'Chat' },
  { id: 'lanes', label: 'Lanes' },
]

interface Props {
  task: Task | undefined
  events: TaskEvent[]
  /** Persisted security-scan rounds for the selected task (Security panel). */
  securityScans: SecurityScan[]
  live: string
  tasks: Task[]
  /** Live snapshot of everything zmrng is running (Lanes tab); `null` until the
   *  first `lanes` frame / boot fetch lands. */
  lanes: LaneSnapshot | null
  repos: RepoTarget[]
  config: ServerConfig | null
  selectedId: string | null
  /** Whether the Tasks side panel is collapsed (ephemeral, driven by re-clicking
   *  the Workspace activity-rail button). */
  tasksCollapsed: boolean
  /** Phone shell: which single view to fill the screen with. `undefined` on
   *  desktop, where the task panel + tab strip layout is used unchanged. */
  mobileView?: MobileWorkspaceView
  /** Phone shell: switch the single full-screen view (a Lanes row click jumps
   *  to the worker/chat/terminal view it points at). */
  onMobileViewChange?: (view: MobileWorkspaceView) => void
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
  lanes,
  repos,
  config,
  selectedId,
  tasksCollapsed,
  mobileView,
  onMobileViewChange,
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
  const [loaded, setLoaded] = useState<WorktreeFileTree | null>(null)
  const [nonce, setNonce] = useState(0)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [seenPrefill, setSeenPrefill] = useState<HandoffPrefill | null>(null)
  // Phone shell only: the task list / worker split (full list, half, full
  // worker), driven by the swipe handle and remembered across reloads.
  const [panel, movePanel] = usePanelSplit(TASKS_PANEL_KEY)

  // The Files tab always browses the configured Projects dir — it deliberately
  // does NOT follow task selection, so a task's worktree is never listed here.
  useEffect(() => {
    let cancelled = false
    api
      .getProjectFiles()
      .then((tree) => {
        if (!cancelled) setLoaded(tree)
      })
      .catch(() => {
        if (!cancelled) setLoaded({ root: null, entries: [] })
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  const current = loaded
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

  // A Lanes row click jumps to what the row is: a task (worker, queued or
  // subagent row) opens that task's Worker view; a chat / terminal row focuses
  // the exact tab owning that live session. On the phone shell the single
  // full-screen view switches too ('tasks' is where the worker log lives).
  const openLane = useCallback(
    (target: LaneTarget) => {
      let next: PaneTab
      if (target.kind === 'task') {
        onSelect(target.taskId)
        next = 'worker'
      } else if (target.kind === 'chat') {
        onChatTabsChange(focusChatLane(chatTabs, target.laneId))
        next = 'chat'
      } else {
        onTerminalTabsChange(focusTerminalSession(terminalTabs, target.sessionId))
        next = 'terminal'
      }
      setTab(next)
      if (mobileView !== undefined) onMobileViewChange?.(next === 'worker' ? 'tasks' : next)
    },
    [onSelect, chatTabs, onChatTabsChange, terminalTabs, onTerminalTabsChange, mobileView, onMobileViewChange],
  )

  // A confirmed Lanes "Close": kill the process server-side, then drop the
  // owning chat/terminal tab. Task rows just park in `blocked` (the WS pushes it).
  const closeLane = useCallback(
    async (target: LaneTarget) => {
      try {
        if (target.kind === 'task') {
          await api.closeTaskLane(target.taskId)
        } else if (target.kind === 'chat') {
          await api.closeChatLane(target.laneId)
          const tab = chatTabs.tabs.find((t) => t.laneId === target.laneId)
          if (tab) {
            removeChatThread(tab.id)
            onChatTabsChange(closeTab(chatTabs, tab.id))
          }
        } else {
          await api.closeTerminalLane(target.sessionId)
          const tab = terminalTabs.tabs.find((t) => t.sessionId === target.sessionId)
          if (tab) onTerminalTabsChange(closeTab(terminalTabs, tab.id))
        }
      } catch {
        // Row stays; the next lanes frame reflects reality.
      }
    },
    [chatTabs, onChatTabsChange, terminalTabs, onTerminalTabsChange],
  )

  const status = task?.status ?? null

  // Phone shell: one view fills the screen, driven by the hamburger drawer
  // instead of the tab strip. 'tasks' stacks the task list above the worker log.
  const isMobile = mobileView !== undefined
  const activeTab: PaneTab = isMobile ? (mobileView === 'tasks' ? 'worker' : mobileView) : tab
  const showTasksView = isMobile ? mobileView === 'tasks' : !tasksCollapsed
  const showTasks = showTasksView && !(isMobile && panel.position === 'detail')
  const hidePane = isMobile && showTasksView && panel.position === 'list'

  return (
    <div
      className={styles.center}
      data-mobile={isMobile || undefined}
      data-panel={isMobile && showTasksView ? panel.position : undefined}
    >
      <aside
        className={`${styles.tasksPanel} ${showTasks ? '' : styles.tasksPanelCollapsed}`}
        aria-hidden={!showTasks || undefined}
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

      {/* Phone shell: swipe up on the handle to step toward a full-screen
          worker, swipe down toward a full-screen task list, tap to cycle. */}
      {isMobile && showTasksView && (
        <PanelHandle label="Task list" position={panel.position} onMove={movePanel} />
      )}

      <section className={styles.pane} aria-hidden={hidePane || undefined}>
        {!isMobile && (
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
        )}

        <div className={styles.paneBody}>
          {/* Worker */}
          <div
            className={styles.tabPanel}
            style={{ display: activeTab === 'worker' ? 'flex' : 'none' }}
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
            style={{ display: activeTab === 'files' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <div className={styles.filesSplit}>
              <div className={styles.fileTreeCol}>
                <div className={styles.filesToolbar}>
                  <span className={styles.filesLabel}>Files</span>
                  <button
                    type="button"
                    className={styles.refresh}
                    onClick={() => setNonce((n) => n + 1)}
                    aria-label="Refresh file tree"
                    title="Refresh file tree"
                  >
                    <NavIcon name="refresh" />
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
                  ) : (
                    <div className={styles.paneEmpty}>
                      No projects found in the configured directory.
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.viewerCol}>
                <Viewer path={selectedPath} />
              </div>
            </div>
          </div>

          {/* Terminal — multi-tab card; every PTY tab stays mounted so sessions
              survive both card-tab and pane-tab switches. */}
          <div
            className={styles.tabPanel}
            style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <TerminalCard tabs={terminalTabs} onTabsChange={onTerminalTabsChange} />
          </div>

          {/* Chat — multi-tab card (per-tab repo picker); every /ws/chat tab stays
              mounted so sessions survive tab switches. */}
          <div
            className={styles.tabPanel}
            style={{ display: activeTab === 'chat' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <ChatCard tabs={chatTabs} onTabsChange={onChatTabsChange} repos={repos} />
          </div>

          {/* Lanes — read-only view of every live worker/chat/PTY. Kept mounted
              like its neighbours, but told when it is hidden so its 1s elapsed
              tick stops costing anything. */}
          <div
            className={styles.tabPanel}
            style={{ display: activeTab === 'lanes' ? 'flex' : 'none' }}
            role="tabpanel"
          >
            <LanesPanel
              snapshot={lanes}
              tasks={tasks}
              repos={repos}
              active={activeTab === 'lanes'}
              onOpen={openLane}
              onClose={closeLane}
            />
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
                <NavIcon name="close" />
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
