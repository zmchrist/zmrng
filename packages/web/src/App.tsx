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
  RepoTarget,
} from './types'
import { TaskList } from './components/TaskList'
import { NewTaskForm } from './components/NewTaskForm'
import { TaskDetail } from './components/TaskDetail'
import { STATUS_LABEL, statusColor } from './status'

export default function App() {
  const [tasks, setTasks] = useState<Record<string, Task>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [live, setLive] = useState('')
  const [cfg, setCfg] = useState<ServerConfig | null>(null)
  const [repos, setRepos] = useState<RepoTarget[]>([])
  const [railCollapsed, setRailCollapsed] = useState(false)
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

  const selected = selectedId ? tasks[selectedId] : undefined

  return (
    <div className={`${styles.app} ${railCollapsed ? styles.appCollapsed : ''}`}>
      <div className={styles.dragbar} data-tauri-drag-region />
      <aside className={styles.rail}>
        {railCollapsed ? (
          <div className={styles.mini}>
            <button
              type="button"
              className={styles.collapseBtn}
              aria-expanded={false}
              aria-label="Expand task pane"
              title="Expand task pane"
              onClick={() => setRailCollapsed(false)}
            >
              ›
            </button>
            <div className={styles.miniDots}>
              {sorted.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.miniDot} ${t.id === selectedId ? styles.miniDotActive : ''}`}
                  style={{ background: statusColor(t.status) }}
                  aria-label={`${t.title} — ${STATUS_LABEL[t.status]}`}
                  aria-current={t.id === selectedId ? 'true' : undefined}
                  title={`${t.title} — ${STATUS_LABEL[t.status]}`}
                  onClick={() => select(t.id)}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className={styles.brandbar} data-tauri-drag-region>
              <span className={styles.brand}>zmrng</span>
              <span className={styles.brandbarRight}>
                <span
                  className={`${styles.dot} ${connected ? styles.dotOn : ''}`}
                  title={connected ? 'connected' : 'disconnected'}
                />
                <button
                  type="button"
                  className={styles.collapseBtn}
                  aria-expanded={true}
                  aria-label="Collapse task pane"
                  title="Collapse task pane"
                  onClick={() => setRailCollapsed(true)}
                >
                  ‹
                </button>
              </span>
            </div>
            <NewTaskForm
              repos={repos}
              defaultRepoId={cfg?.defaultRepoId ?? ''}
              onCreate={onCreate}
            />
            <TaskList tasks={sorted} repos={repos} selectedId={selectedId} onSelect={select} />
          </>
        )}
      </aside>
      <main className={styles.detail}>
        {selected ? (
          <TaskDetail
            task={selected}
            events={events}
            live={live}
            config={cfg}
            repos={repos}
            onStart={() => api.start(selected.id)}
            onMessage={(text) => api.message(selected.id, text)}
            onResume={() => api.resume(selected.id)}
            onDone={() => api.done(selected.id)}
            onCancel={() => api.cancel(selected.id)}
          />
        ) : (
          <div className={styles.empty}>Select a task, or create one to begin.</div>
        )}
      </main>
    </div>
  )
}
