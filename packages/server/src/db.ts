import Database from 'better-sqlite3'
import type { Task, TaskStatus, TaskEvent, EventKind, EventPayload } from './types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  branch TEXT,
  worktree TEXT,
  pr_url TEXT,
  model TEXT,
  queued INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
`

interface TaskRow {
  id: string
  title: string
  body: string
  status: string
  session_id: string | null
  branch: string | null
  worktree: string | null
  pr_url: string | null
  model: string | null
  queued: number
  created_at: string
  updated_at: string
}

interface EventRow {
  id: number
  task_id: string
  ts: string
  kind: string
  payload: string
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status as TaskStatus,
    sessionId: r.session_id,
    branch: r.branch,
    worktree: r.worktree,
    prUrl: r.pr_url,
    model: r.model,
    queued: r.queued === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToEvent(r: EventRow): TaskEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    ts: r.ts,
    kind: r.kind as EventKind,
    payload: JSON.parse(r.payload) as EventPayload,
  }
}

/** Fields a caller may patch on a task. */
export type TaskPatch = Partial<
  Pick<
    Task,
    'status' | 'sessionId' | 'branch' | 'worktree' | 'prUrl' | 'model' | 'queued'
  >
>

const COLUMN_BY_FIELD: Record<keyof TaskPatch, string> = {
  status: 'status',
  sessionId: 'session_id',
  branch: 'branch',
  worktree: 'worktree',
  prUrl: 'pr_url',
  model: 'model',
  queued: 'queued',
}

export class Db {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  createTask(input: { id: string; title: string; body: string; model: string; now: string }): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, body, status, model, queued, created_at, updated_at)
         VALUES (@id, @title, @body, 'backlog', @model, 0, @now, @now)`,
      )
      .run(input)
    return this.getTask(input.id)!
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined
    return row ? rowToTask(row) : undefined
  }

  listTasks(): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
      .all() as TaskRow[]
    return rows.map(rowToTask)
  }

  updateTask(id: string, patch: TaskPatch, now: string): Task | undefined {
    const sets: string[] = []
    const params: Record<string, unknown> = { id, updated_at: now }
    for (const [field, value] of Object.entries(patch)) {
      const col = COLUMN_BY_FIELD[field as keyof TaskPatch]
      sets.push(`${col} = @${col}`)
      params[col] = typeof value === 'boolean' ? (value ? 1 : 0) : value
    }
    sets.push('updated_at = @updated_at')
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params)
    return this.getTask(id)
  }

  insertEvent(taskId: string, kind: EventKind, payload: EventPayload, now: string): TaskEvent {
    const info = this.db
      .prepare('INSERT INTO events (task_id, ts, kind, payload) VALUES (?, ?, ?, ?)')
      .run(taskId, now, kind, JSON.stringify(payload))
    return {
      id: Number(info.lastInsertRowid),
      taskId,
      ts: now,
      kind,
      payload,
    }
  }

  getEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as EventRow[]
    return rows.map(rowToEvent)
  }
}
