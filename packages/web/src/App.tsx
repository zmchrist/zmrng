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

export default function App() {
  const [tasks, setTasks] = useState<Record<string, Task>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [live, setLive] = useState('')
  const [cfg, setCfg] = useState<ServerConfig | null>(null)
  const [repos, setRepos] = useState<RepoTarget[]>([])
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
    <div className={styles.app}>
      <aside className={styles.rail}>
        <div className={styles.brandbar}>
          <span className={styles.brand}>zmrng</span>
          <span
            className={`${styles.dot} ${connected ? styles.dotOn : ''}`}
            title={connected ? 'connected' : 'disconnected'}
          />
        </div>
        <NewTaskForm
          repos={repos}
          defaultRepoId={cfg?.defaultRepoId ?? ''}
          onCreate={onCreate}
        />
        <TaskList tasks={sorted} repos={repos} selectedId={selectedId} onSelect={select} />
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
