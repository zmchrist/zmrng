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
} from './types'
import { WorkspaceView } from './components/WorkspaceView'
import { AuthBanner } from './components/AuthBanner'
import { Board } from './components/Board'
import { useUiState } from './uiState'

// The former standalone Tasks pane is merged into Workspace; only Workspace and
// Board remain as top-level modes. The legacy `'tasks'` value is still accepted
// from persisted UI state and migrated to `'workspace'` below.
const MODES: ReadonlyArray<{ id: WorkspaceMode; label: string }> = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'board', label: 'Board' },
]

export default function App() {
  const [tasks, setTasks] = useState<Record<string, Task>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [live, setLive] = useState('')
  const [cfg, setCfg] = useState<ServerConfig | null>(null)
  const [repos, setRepos] = useState<RepoTarget[]>([])
  const ui = useUiState()
  const railCollapsed = ui.state.global.railCollapsed ?? false
  // Workspace is the default home; migrate the retired `'tasks'` mode to it.
  const storedMode = ui.state.global.mode ?? 'workspace'
  const mode: WorkspaceMode = storedMode === 'tasks' ? 'workspace' : storedMode
  const setRailCollapsed = useCallback(
    (v: boolean) => ui.patchGlobal({ railCollapsed: v }),
    [ui],
  )
  const setMode = useCallback((m: WorkspaceMode) => ui.patchGlobal({ mode: m }), [ui])
  // Bottom-dock terminal chrome (only open/height persist; shells are ephemeral).
  const dockOpen = ui.state.global.terminalDock?.open ?? false
  const dockHeight = ui.state.global.terminalDock?.height ?? 300
  const setDockOpen = useCallback(
    (v: boolean) => ui.patchGlobal({ terminalDock: { ...ui.state.global.terminalDock, open: v } }),
    [ui],
  )
  const setDockHeight = useCallback(
    (h: number) => ui.patchGlobal({ terminalDock: { ...ui.state.global.terminalDock, height: h } }),
    [ui],
  )
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
    ) => {
      const task = await api.createTask(title, body, opts)
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

  const selected = selectedId ? tasks[selectedId] : undefined

  return (
    <div className={styles.app}>
      <div className={styles.topbar} data-tauri-drag-region>
        <nav className={styles.modeTabs} aria-label="Workspace mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`${styles.modeTab} ${mode === m.id ? styles.modeTabActive : ''}`}
              aria-pressed={mode === m.id}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </nav>
        <span className={styles.topbarRight}>
          <span className={styles.brand}>zmrng</span>
          <span
            className={`${styles.dot} ${connected ? styles.dotOn : ''}`}
            title={connected ? 'connected' : 'disconnected'}
          />
        </span>
      </div>
      <AuthBanner />

      {mode === 'board' && (
        <Board
          tasks={sorted}
          repos={repos}
          onSelectTask={onBoardSelectTask}
          onArchive={onBoardArchive}
        />
      )}

      {mode === 'workspace' && (
        <WorkspaceView
          task={selected}
          events={events}
          live={live}
          perTask={ui.state.perTask}
          onPerTaskChange={ui.patchTask}
          tasks={sorted}
          repos={repos}
          config={cfg}
          selectedId={selectedId}
          railCollapsed={railCollapsed}
          onRailCollapsedChange={setRailCollapsed}
          dockOpen={dockOpen}
          dockHeight={dockHeight}
          onDockOpenChange={setDockOpen}
          onDockHeightChange={setDockHeight}
          onSelect={select}
          onCreate={onCreate}
          onStart={() => (selected ? api.start(selected.id) : Promise.resolve())}
          onMessage={(text) => (selected ? api.message(selected.id, text) : Promise.resolve())}
          onResume={() => (selected ? api.resume(selected.id) : Promise.resolve())}
          onInterrupt={() => (selected ? api.interrupt(selected.id) : Promise.resolve())}
          onDone={() => (selected ? api.done(selected.id) : Promise.resolve())}
          onCancel={() => (selected ? api.cancel(selected.id) : Promise.resolve())}
        />
      )}
    </div>
  )
}
