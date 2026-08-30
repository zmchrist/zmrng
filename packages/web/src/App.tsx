import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styles from './App.module.css'
import { api } from './api'
import { useWs } from './useWs'
import type {
  ServerConfig,
  Task,
  TaskEvent,
  WsEvent,
  ModelAlias,
  EffortLevel,
  CaveStyle,
  FlowMode,
  RepoTarget,
  WorkspaceMode,
  Attachment,
} from './types'
import { WorkspaceView } from './components/WorkspaceView'
import { AuthBanner } from './components/AuthBanner'
import { Board } from './components/Board'
import { TeamView } from './components/TeamView'
import { UpdateBanner } from './components/UpdateBanner'
import { SettingsModal } from './components/SettingsModal'
import { updateAvailable } from './updateGate'
import { useUiState } from './uiState'
import { nextRailState } from './railState'
import { hydrateChatTabs, hydrateTerminalTabs, type ChatTabState, type TabsState, type TerminalTabState } from './windowTabs'
import type { HandoffPrefill } from './teamHandoff'
import { isTauriRuntime } from './runtime'

/** Activity-rail nav — persistent across every mode; ⚙ opens Settings. */
const RAIL: ReadonlyArray<{ id: WorkspaceMode; glyph: string; label: string }> = [
  { id: 'workspace', glyph: '≣', label: 'Workspace' },
  { id: 'board', glyph: '⑃', label: 'Board' },
  { id: 'team', glyph: '▤', label: 'Team' },
]

// Read once — the runtime never changes mid-session.
const isNativeApp = isTauriRuntime()

export default function App() {
  const [tasks, setTasks] = useState<Record<string, Task>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [live, setLive] = useState('')
  const [cfg, setCfg] = useState<ServerConfig | null>(null)
  const [repos, setRepos] = useState<RepoTarget[]>([])
  const ui = useUiState()
  // Workspace is the default home; migrate the retired `'tasks'` mode to it.
  const storedMode = ui.state.global.mode ?? 'workspace'
  const mode: WorkspaceMode = storedMode === 'tasks' ? 'workspace' : storedMode
  const setMode = useCallback((m: WorkspaceMode) => ui.patchGlobal({ mode: m }), [ui])
  // Ephemeral: whether the Workspace Tasks side panel is collapsed. Re-clicking
  // the active Workspace rail button toggles it; leaving Workspace re-expands it.
  const [tasksCollapsed, setTasksCollapsed] = useState(false)
  // Activity-rail click: pure reducer decides mode + collapse from current state.
  const onRailClick = useCallback(
    (id: WorkspaceMode) => {
      const next = nextRailState({ mode, tasksCollapsed }, id)
      if (next.mode !== mode) setMode(next.mode)
      setTasksCollapsed(next.tasksCollapsed)
    },
    [mode, tasksCollapsed, setMode],
  )
  // Per-card tab-strip state for the Chat and Terminal panes, hydrated/persisted
  // from GlobalUiState — the live sessions themselves stay ephemeral. Feeds the
  // tabbed ChatCard/TerminalCard inside the Workspace IDE's Chat/Terminal tabs.
  // A unique seed id per app boot for the fresh default chat tab, so a newly
  // seeded "Chat 1" never reuses a closed tab's persisted transcript key.
  const chatSeedId = useMemo(() => `chat-${crypto.randomUUID()}`, [])
  const chatTabs = useMemo(
    () => hydrateChatTabs(ui.state.global.chatTabs, chatSeedId),
    [ui.state.global.chatTabs, chatSeedId],
  )
  const setChatTabs = useCallback((next: TabsState<ChatTabState>) => ui.patchGlobal({ chatTabs: next }), [ui])
  const terminalTabs = useMemo(
    () => hydrateTerminalTabs(ui.state.global.terminalTabs),
    [ui.state.global.terminalTabs],
  )
  const setTerminalTabs = useCallback(
    (next: TabsState<TerminalTabState>) => ui.patchGlobal({ terminalTabs: next }),
    [ui],
  )
  // Settings is an ephemeral modal overlay — never persisted.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // One-shot "Send to my zmrng" pre-fill from the Team tab (T3).
  const [handoffPrefill, setHandoffPrefill] = useState<HandoffPrefill | null>(null)
  // WS-B / D3: the newer origin/main sha the workspace socket advertised, once
  // it differs from this instance's headSha. Drives the global update banner.
  const [updateSha, setUpdateSha] = useState<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)

  const onWs = useCallback((e: WsEvent) => {
    switch (e.type) {
      case 'snapshot': {
        const map: Record<string, Task> = {}
        for (const t of e.tasks) map[t.id] = t
        setTasks(map)
        break
      }
      case 'task':
        setTasks((prev) => ({ ...prev, [e.task.id]: e.task }))
        break
      case 'event':
        if (e.taskId !== selectedIdRef.current) return
        setEvents((prev) => [...prev, e.event])
        if (e.event.kind === 'claude' && e.event.payload.sub === 'assistant') {
          setLive('')
        }
        break
      case 'partial':
        if (e.taskId !== selectedIdRef.current) return
        setLive((prev) => prev + e.text)
        break
      case 'task-removed':
        setTasks((prev) => {
          const next = { ...prev }
          delete next[e.taskId]
          return next
        })
        if (e.taskId === selectedIdRef.current) {
          selectedIdRef.current = null
          setSelectedId(null)
          setLive('')
          setEvents([])
        }
        break
    }
  }, [])

  const { connected } = useWs(onWs)

  useEffect(() => {
    api.getConfig().then(setCfg).catch(() => undefined)
    api.listRepos().then(setRepos).catch(() => undefined)
    api
      .listTasks()
      .then((list) => {
        const map: Record<string, Task> = {}
        for (const t of list) map[t.id] = t
        setTasks(map)
      })
      .catch(() => undefined)
  }, [])

  const select = useCallback(async (id: string) => {
    selectedIdRef.current = id
    setSelectedId(id)
    setLive('')
    setEvents([])
    try {
      setEvents(await api.getEvents(id))
    } catch {
      // events load failed — leave empty
    }
  }, [])

  const onCreate = useCallback(
    async (
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
    ) => {
      const task = await api.createTask(title, body, opts, attachments)
      setTasks((prev) => ({ ...prev, [task.id]: task }))
      void select(task.id)
    },
    [select],
  )

  const sorted = useMemo(
    () =>
      Object.values(tasks).sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      ),
    [tasks],
  )

  const onBoardSelectTask = useCallback(
    (id: string) => {
      setMode('workspace')
      void select(id)
    },
    [select, setMode],
  )

  const onBoardArchive = useCallback((id: string) => {
    void api.archive(id)
  }, [])

  // Team tab handoff: switch to Workspace and seed the local new-task box.
  const onSendToZmrng = useCallback(
    (prefill: HandoffPrefill) => {
      setMode('workspace')
      setHandoffPrefill({ ...prefill })
    },
    [setMode],
  )
  const onPrefillConsumed = useCallback(() => setHandoffPrefill(null), [])

  // A `new-version` frame from the workspace socket (relayed by TeamView). Store
  // the advertised sha unconditionally; whether it is genuinely ahead of ours is
  // decided at render by the pure `updateAvailable` gate. Deferring the compare
  // to render (rather than gating here) closes a race where a frame arrives on
  // the on-connect seed before `cfg` (async `getConfig`) has resolved — the
  // banner then appears the moment `cfg.headSha` loads, instead of being dropped.
  const onNewVersion = useCallback((sha: string) => setUpdateSha(sha), [])

  const selected = selectedId ? tasks[selectedId] : undefined

  // ---- persistent title-bar breadcrumb + status-bar metrics ----
  const breadcrumb =
    mode === 'workspace'
      ? (selected?.title ?? 'No task selected')
      : mode === 'board'
        ? 'Board'
        : 'Team'
  const lanes = cfg?.maxLanes ?? 0
  const running = sorted.filter((t) => t.status === 'executing').length
  const queued = sorted.filter((t) => t.queued).length
  const branch = selected?.branch ?? 'main'
  const modelLabel = selected ? `${selected.model} / ${selected.effort}` : 'idle'

  return (
    <div className={styles.app} data-native={isNativeApp || undefined}>
      <AuthBanner />
      {updateAvailable(cfg?.headSha, updateSha ?? undefined) && (
        <UpdateBanner
          tasks={tasks}
          connected={connected}
          onDismiss={() => setUpdateSha(null)}
        />
      )}

      <div className={styles.frame}>
        {/* title bar (persistent) */}
        <div className={styles.tbar} data-tauri-drag-region>
          <span className={styles.tbBrand}>zmrng</span>
          <span className={styles.tbSep}>›</span>
          <span className={styles.tbCrumb}>{breadcrumb}</span>
          <span className={`${styles.tbConn} ${connected ? '' : styles.tbConnDown}`}>
            <span className={styles.tbConnDot} />
            {connected ? 'connected' : 'offline'}
          </span>
        </div>

        {/* body: persistent activity rail | swappable mode content */}
        <div className={styles.frameBody}>
          <nav className={styles.arail} aria-label="Navigation">
            {RAIL.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`${styles.arailBtn} ${mode === r.id ? styles.arailActive : ''}`}
                aria-pressed={mode === r.id}
                aria-label={r.label}
                title={r.label}
                onClick={() => onRailClick(r.id)}
              >
                {r.glyph}
              </button>
            ))}
            <button
              type="button"
              className={`${styles.arailBtn} ${styles.arailBottom}`}
              aria-label="Settings"
              title="Settings"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              ⚙
            </button>
          </nav>

          <div
            className={styles.modeContent}
            style={{ display: mode === 'workspace' ? 'flex' : 'none' }}
          >
            <WorkspaceView
              task={selected}
              events={events}
              live={live}
              tasks={sorted}
              repos={repos}
              config={cfg}
              selectedId={selectedId}
              tasksCollapsed={tasksCollapsed}
              chatTabs={chatTabs}
              onChatTabsChange={setChatTabs}
              terminalTabs={terminalTabs}
              onTerminalTabsChange={setTerminalTabs}
              onSelect={select}
              onCreate={onCreate}
              prefill={handoffPrefill}
              onPrefillConsumed={onPrefillConsumed}
              onStart={() => (selected ? api.start(selected.id) : Promise.resolve())}
              onMessage={(text, attachments) =>
                selected ? api.message(selected.id, text, attachments) : Promise.resolve()
              }
              onResume={() => (selected ? api.resume(selected.id) : Promise.resolve())}
              onInterrupt={() => (selected ? api.interrupt(selected.id) : Promise.resolve())}
              onDone={() => (selected ? api.done(selected.id) : Promise.resolve())}
              onCancel={() => (selected ? api.cancel(selected.id) : Promise.resolve())}
              onDelete={() => (selected ? api.deleteTask(selected.id) : Promise.resolve())}
            />
          </div>

          <div
            className={styles.modeContent}
            style={{ display: mode === 'board' ? 'flex' : 'none' }}
          >
            <Board
              tasks={sorted}
              repos={repos}
              onSelectTask={onBoardSelectTask}
              onArchive={onBoardArchive}
            />
          </div>

          <div
            className={styles.modeContent}
            style={{ display: mode === 'team' ? 'flex' : 'none' }}
          >
            <TeamView
              workspaceUrl={cfg?.workspaceUrl ?? ''}
              botHandle={cfg?.botHandle ?? '@agent'}
              repos={repos}
              onSendToZmrng={onSendToZmrng}
              onNewVersion={onNewVersion}
            />
          </div>
        </div>

        {/* status bar (persistent) */}
        <div className={styles.sbar}>
          <span className={styles.sbBranch}>{branch}</span>
          <span className={styles.sbItem}>
            · {running}/{lanes} lanes{queued > 0 ? ` · ${queued} queued` : ''}
          </span>
          <span className={styles.sbSpacer} />
          <span className={styles.sbItem}>{modelLabel}</span>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        connected={connected}
      />
    </div>
  )
}
