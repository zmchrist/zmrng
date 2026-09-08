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
  FlowMode,
  TaskUsage,
  TaskComment,
  ChatMessage,
  Member,
  Channel,
  Message,
  MessageKind,
} from './types.js'
import { GENERAL_CHANNEL_NAME } from './types.js'

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
  flow TEXT,
  repo_id TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  blocked_kind TEXT,
  blocked_reason TEXT,
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
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_task ON chat_messages(task_id, agent_id, id);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  repo_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
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
  flow: string | null
  repo_id: string | null
  tokens_in: number
  tokens_out: number
  tokens_cache: number
  cost_usd: number
  turns: number
  queued: number
  stale: number
  blocked_kind: string | null
  blocked_reason: string | null
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

interface TaskCommentRow {
  id: number
  task_id: string
  author: string
  body: string
  created_at: string
}

interface ChatMessageRow {
  id: number
  task_id: string
  agent_id: string
  role: string
  content: string
  created_at: string
}

interface MemberRow {
  id: number
  display_name: string
  created_at: string
}

interface ChannelRow {
  id: number
  name: string
  repo_id: string | null
  created_at: string
}

interface MessageRow {
  id: number
  channel_id: number
  author: string
  body: string
  kind: string
  created_at: string
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
    // Legacy rows predate the flow column; they ran the full pipeline, so
    // default a null read to `plan` (new rows always write an explicit value).
    flow: (r.flow as FlowMode | null) ?? 'plan',
    repoId: r.repo_id ?? config.defaultRepoId,
    usage: {
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      tokensCache: r.tokens_cache,
      costUsd: r.cost_usd,
      turns: r.turns,
    },
    queued: r.queued === 1,
    stale: r.stale === 1,
    blockedKind: r.blocked_kind,
    blockedReason: r.blocked_reason,
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

function rowToComment(r: TaskCommentRow): TaskComment {
  return {
    id: r.id,
    taskId: r.task_id,
    author: r.author,
    body: r.body,
    createdAt: r.created_at,
  }
}

function rowToChatMessage(r: ChatMessageRow): ChatMessage {
  return {
    id: r.id,
    taskId: r.task_id,
    agentId: r.agent_id,
    role: r.role as ChatMessage['role'],
    content: r.content,
    createdAt: r.created_at,
  }
}

function rowToMember(r: MemberRow): Member {
  return {
    id: r.id,
    displayName: r.display_name,
    createdAt: r.created_at,
  }
}

function rowToChannel(r: ChannelRow): Channel {
  return {
    id: r.id,
    name: r.name,
    repoId: r.repo_id,
    createdAt: r.created_at,
  }
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    channelId: r.channel_id,
    author: r.author,
    body: r.body,
    kind: r.kind as MessageKind,
    createdAt: r.created_at,
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
    | 'stale'
    | 'blockedKind'
    | 'blockedReason'
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
  stale: 'stale',
  blockedKind: 'blocked_kind',
  blockedReason: 'blocked_reason',
}

export class Db {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    // Bound WAL growth during long runs: checkpoint into the durable .db file
    // every ~1000 pages instead of letting the -wal sidecar grow unbounded.
    // Defense-in-depth against a stale main file if the process dies uncleanly.
    this.db.pragma('wal_autocheckpoint = 1000')
    this.db.exec(SCHEMA)
    this.ensureColumns()
    this.seedGeneralChannel()
  }

  /**
   * Idempotently seed the fixed `#general` channel (null repo_id). `INSERT OR
   * IGNORE` on the UNIQUE `name` column makes reopening a populated `zmrng.db`
   * a no-op — the channel is created exactly once and never duplicated.
   */
  private seedGeneralChannel(): void {
    this.db
      .prepare('INSERT OR IGNORE INTO channels (name, repo_id, created_at) VALUES (?, NULL, ?)')
      .run(GENERAL_CHANNEL_NAME, new Date().toISOString())
  }

  /**
   * Force a full WAL checkpoint into the durable `.db` file, then close the
   * handle. Called from the graceful shutdown path so tasks are never left
   * living only in the `-wal` sidecar — otherwise a dropped/reset WAL reverts
   * the durable file to its last checkpoint and recent tasks "vanish".
   */
  close(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.close()
  }

  /** Count of persisted tasks — logged at startup to confirm the loaded DB. */
  taskCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    return row.n
  }

  /**
   * Idempotently add columns introduced after the original schema. `CREATE TABLE
   * IF NOT EXISTS` won't alter an existing `zmrng.db`, so migrate explicitly.
   *
   * MIGRATION POLICY — ADDITIVE ONLY (D2a of
   * .agents/plans/instance-update-distribution-grill.md). Only ever `ALTER … ADD
   * COLUMN` / `CREATE … IF NOT EXISTS` here. NEVER drop or rename a column/table
   * and NEVER rewrite existing rows in a migration. The VPS team-workspace
   * instance redeploys in place (scripts/autoupdate-workspace.sh reopens the same
   * populated `zmrng.db`), so a destructive/rewriting migration is the ONE thing
   * that could lose live channels/messages/members across a redeploy. A genuine
   * column drop/rename needs an explicit, reviewed migration path — not this
   * best-effort reopen.
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
      ['flow', 'TEXT'],
      ['repo_id', 'TEXT'],
      ['plan_path', 'TEXT'],
      ['tokens_in', 'INTEGER NOT NULL DEFAULT 0'],
      ['tokens_out', 'INTEGER NOT NULL DEFAULT 0'],
      ['tokens_cache', 'INTEGER NOT NULL DEFAULT 0'],
      ['cost_usd', 'REAL NOT NULL DEFAULT 0'],
      ['turns', 'INTEGER NOT NULL DEFAULT 0'],
      ['stale', 'INTEGER NOT NULL DEFAULT 0'],
      ['blocked_kind', 'TEXT'],
      ['blocked_reason', 'TEXT'],
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
    flow: FlowMode
    repoId: string
    now: string
  }): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, body, status, model, effort, style, flow, repo_id, queued, created_at, updated_at)
         VALUES (@id, @title, @body, 'backlog', @model, @effort, @style, @flow, @repoId, 0, @now, @now)`,
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

  addComment(taskId: string, author: string, body: string, now: string): TaskComment {
    const info = this.db
      .prepare('INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)')
      .run(taskId, author, body, now)
    return {
      id: Number(info.lastInsertRowid),
      taskId,
      author,
      body,
      createdAt: now,
    }
  }

  listComments(taskId: string): TaskComment[] {
    const rows = this.db
      .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as TaskCommentRow[]
    return rows.map(rowToComment)
  }

  addChatMessage(
    taskId: string,
    agentId: string,
    role: ChatMessage['role'],
    content: string,
    now: string,
  ): ChatMessage {
    const info = this.db
      .prepare(
        'INSERT INTO chat_messages (task_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, agentId, role, content, now)
    return {
      id: Number(info.lastInsertRowid),
      taskId,
      agentId,
      role,
      content,
      createdAt: now,
    }
  }

  listChatMessages(taskId: string, agentId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM chat_messages WHERE task_id = ? AND agent_id = ? ORDER BY id ASC',
      )
      .all(taskId, agentId) as ChatMessageRow[]
    return rows.map(rowToChatMessage)
  }

  /**
   * Insert a workspace member by self-asserted display name, or return the
   * existing row if that name is already taken. Identity is the free-text
   * display name (no verification) — a re-join with the same name reuses the
   * original row and its `created_at`, so the members table never grows on
   * reconnect. Follows the `task_comments` prepared-statement pattern.
   */
  upsertMember(displayName: string, now: string): Member {
    const existing = this.db
      .prepare('SELECT * FROM members WHERE display_name = ? ORDER BY id ASC LIMIT 1')
      .get(displayName) as MemberRow | undefined
    if (existing) return rowToMember(existing)
    const info = this.db
      .prepare('INSERT INTO members (display_name, created_at) VALUES (?, ?)')
      .run(displayName, now)
    return {
      id: Number(info.lastInsertRowid),
      displayName,
      createdAt: now,
    }
  }

  /** Every distinct member, in insertion order (stable roster ordering). */
  listMembers(): Member[] {
    const rows = this.db
      .prepare('SELECT * FROM members ORDER BY id ASC')
      .all() as MemberRow[]
    return rows.map(rowToMember)
  }

  /** Every channel, in insertion order (stable list ordering; #general is first). */
  listChannels(): Channel[] {
    const rows = this.db
      .prepare('SELECT * FROM channels ORDER BY id ASC')
      .all() as ChannelRow[]
    return rows.map(rowToChannel)
  }

  /** One channel by id, or `undefined` if it does not exist. */
  getChannel(id: number): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as
      | ChannelRow
      | undefined
    return row ? rowToChannel(row) : undefined
  }

  /**
   * Create a channel by unique name, or return the existing row if that name is
   * already taken (idempotent, mirroring `upsertMember`). A re-create with the
   * same name reuses the original row and its `created_at`.
   */
  createChannel(name: string, repoId: string | null, now: string): Channel {
    const existing = this.db.prepare('SELECT * FROM channels WHERE name = ?').get(name) as
      | ChannelRow
      | undefined
    if (existing) return rowToChannel(existing)
    const info = this.db
      .prepare('INSERT INTO channels (name, repo_id, created_at) VALUES (?, ?, ?)')
      .run(name, repoId, now)
    return { id: Number(info.lastInsertRowid), name, repoId, createdAt: now }
  }

  /** Persist one channel message. Follows the `task_comments` insert pattern. */
  addMessage(
    channelId: number,
    author: string,
    body: string,
    kind: MessageKind,
    now: string,
  ): Message {
    const info = this.db
      .prepare(
        'INSERT INTO messages (channel_id, author, body, kind, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(channelId, author, body, kind, now)
    return {
      id: Number(info.lastInsertRowid),
      channelId,
      author,
      body,
      kind,
      createdAt: now,
    }
  }

  /**
   * Recent messages for a channel, paginated for scrollback. Selects the newest
   * `limit` rows (optionally strictly older than the `before` message id) in
   * DESC order, then reverses to ASC so the caller renders oldest-first. Passing
   * the oldest returned id back as `before` walks backwards through history.
   */
  listMessages(channelId: number, before: number | null, limit: number): Message[] {
    const rows = (
      before === null
        ? this.db
            .prepare(
              'SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?',
            )
            .all(channelId, limit)
        : this.db
            .prepare(
              'SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
            )
            .all(channelId, before, limit)
    ) as MessageRow[]
    return rows.reverse().map(rowToMessage)
  }

  /** Hard-delete a task and all its rows (events, comments, chat messages). */
  deleteTask(id: string): void {
    const run = this.db.transaction((taskId: string) => {
      this.db.prepare('DELETE FROM events WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM task_comments WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM chat_messages WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    })
    run(id)
  }
}
