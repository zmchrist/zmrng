import Database from 'better-sqlite3'
import { config } from './config.js'
import type {
  Task,
  TaskStatus,
  TaskEvent,
  EventKind,
  EventPayload,
  EffortLevel,
  CaveStyle,
  TaskUsage,
} from './types.js'

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
  plan_path TEXT,
  model TEXT,
  effort TEXT,
  style TEXT,
  repo_id TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
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
  plan_path: string | null
  model: string | null
  effort: string | null
  style: string | null
  repo_id: string | null
  tokens_in: number
  tokens_out: number
  tokens_cache: number
  cost_usd: number
  turns: number
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
    planPath: r.plan_path,
    model: r.model,
    effort: (r.effort as EffortLevel | null) ?? null,
    style: (r.style as CaveStyle | null) ?? null,
    repoId: r.repo_id ?? config.defaultRepoId,
    usage: {
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      tokensCache: r.tokens_cache,
      costUsd: r.cost_usd,
      turns: r.turns,
    },
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

/** Fields a caller may patch on a task. Usage accumulators are excluded — use `addUsage`. */
export type TaskPatch = Partial<
  Pick<
    Task,
    | 'status'
    | 'sessionId'
    | 'branch'
    | 'worktree'
    | 'prUrl'
    | 'planPath'
    | 'model'
    | 'effort'
    | 'style'
    | 'queued'
  >
>

const COLUMN_BY_FIELD: Record<keyof TaskPatch, string> = {
  status: 'status',
  sessionId: 'session_id',
  branch: 'branch',
  worktree: 'worktree',
  prUrl: 'pr_url',
  planPath: 'plan_path',
  model: 'model',
  effort: 'effort',
  style: 'style',
  queued: 'queued',
}

export class Db {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.ensureColumns()
  }

  /**
   * Idempotently add columns introduced after the original schema. `CREATE TABLE
   * IF NOT EXISTS` won't alter an existing `zmrng.db`, so migrate explicitly.
   */
  private ensureColumns(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    )
    const add: [string, string][] = [
      ['effort', 'TEXT'],
      ['style', 'TEXT'],
      ['repo_id', 'TEXT'],
      ['plan_path', 'TEXT'],
      ['tokens_in', 'INTEGER NOT NULL DEFAULT 0'],
      ['tokens_out', 'INTEGER NOT NULL DEFAULT 0'],
      ['tokens_cache', 'INTEGER NOT NULL DEFAULT 0'],
      ['cost_usd', 'REAL NOT NULL DEFAULT 0'],
      ['turns', 'INTEGER NOT NULL DEFAULT 0'],
    ]
    for (const [name, decl] of add) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${decl}`)
    }
  }

  createTask(input: {
    id: string
    title: string
    body: string
    model: string
    effort: EffortLevel
    style: CaveStyle
    repoId: string
    now: string
  }): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, body, status, model, effort, style, repo_id, queued, created_at, updated_at)
         VALUES (@id, @title, @body, 'backlog', @model, @effort, @style, @repoId, 0, @now, @now)`,
      )
      .run(input)
    return this.getTask(input.id)!
  }

  /**
   * Atomically increment a task's usage accumulators. Uses `SET col = col + delta`
   * so concurrent `result` events never lose counts to a read-modify-write race.
   */
  addUsage(id: string, delta: TaskUsage, now: string): Task | undefined {
    this.db
      .prepare(
        `UPDATE tasks SET
           tokens_in = tokens_in + @din,
           tokens_out = tokens_out + @dout,
           tokens_cache = tokens_cache + @dcache,
           cost_usd = cost_usd + @dcost,
           turns = turns + @dturns,
           updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id,
        din: delta.tokensIn,
        dout: delta.tokensOut,
        dcache: delta.tokensCache,
        dcost: delta.costUsd,
        dturns: delta.turns,
        now,
      })
    return this.getTask(id)
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
