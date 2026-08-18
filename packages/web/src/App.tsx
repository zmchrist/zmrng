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
import { SettingsModal } from './components/SettingsModal'
import { LavaLamp } from './components/LavaLamp'
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
  // Bottom-nav pane visibility: Tasks rail + Workspace center pane persist
  // globally (both default closed → a fresh load shows only the Files tree).
  // The Files sidebar defaults OPEN, preserving its prior locked-left behavior.
  const tasksOpen = ui.state.global.panes?.tasks ?? false
  const workspaceOpen = ui.state.global.panes?.workspace ?? false
  const filesOpen = ui.state.global.panes?.files ?? true
  const notesOpen = ui.state.global.panes?.notes ?? false
  const setTasksOpen = useCallback(
    (v: boolean) => ui.patchGlobal({ panes: { ...ui.state.global.panes, tasks: v } }),
    [ui],
  )
  const setWorkspaceOpen = useCallback(
    (v: boolean) => ui.patchGlobal({ panes: { ...ui.state.global.panes, workspace: v } }),
    [ui],
  )
  const setFilesOpen = useCallback(
    (v: boolean) => ui.patchGlobal({ panes: { ...ui.state.global.panes, files: v } }),
    [ui],
  )
  const setNotesOpen = useCallback(
    (v: boolean) => ui.patchGlobal({ panes: { ...ui.state.global.panes, notes: v } }),
    [ui],
  )
  // The Notes panel's own worktree/task choice — independent of `selectedId`.
  const notesTaskId = ui.state.global.notesTaskId ?? null
  const setNotesTaskId = useCallback((id: string) => ui.patchGlobal({ notesTaskId: id }), [ui])
  const filesNotesSplit = ui.state.global.splitSizes?.filesNotesSplit ?? 0.5
  const setFilesNotesSplit = useCallback(
    (ratio: number) =>
      ui.patchGlobal({ splitSizes: { ...ui.state.global.splitSizes, filesNotesSplit: ratio } }),
    [ui],
  )
  // Settings is an ephemeral modal overlay — never persisted.
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  const selected = selectedId ? tasks[selectedId] : undefined

  return (
    <div className={styles.app}>
      <div className={styles.topbar} data-tauri-drag-region>
        <span className={styles.topbarLeft}>
          <LavaLamp connected={connected} />
          <span className={styles.brand}>zmrng</span>
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
        </span>
      </div>
      <AuthBanner />

      <div style={{ display: mode === 'board' ? 'contents' : 'none' }}>
        <Board
          tasks={sorted}
          repos={repos}
          onSelectTask={onBoardSelectTask}
          onArchive={onBoardArchive}
        />
      </div>

      <div style={{ display: mode === 'workspace' ? 'contents' : 'none' }}>
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
          tasksOpen={tasksOpen}
          workspaceOpen={workspaceOpen}
          filesOpen={filesOpen}
          notesOpen={notesOpen}
          onTasksOpenChange={setTasksOpen}
          onWorkspaceOpenChange={setWorkspaceOpen}
          onFilesOpenChange={setFilesOpen}
          onNotesOpenChange={setNotesOpen}
          notesTaskId={notesTaskId}
          onNotesTaskIdChange={setNotesTaskId}
          filesNotesSplit={filesNotesSplit}
          onFilesNotesSplitChange={setFilesNotesSplit}
          settingsOpen={settingsOpen}
          onSettingsToggle={() => setSettingsOpen((v) => !v)}
          onSelect={select}
          onCreate={onCreate}
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

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        connected={connected}
      />
    </div>
  )
}
