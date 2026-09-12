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
  ReactionSummary,
  SecurityScan,
  SecurityFinding,
  SecurityStatus,
  SecurityVerdict,
  Space,
  KbFolder,
  KbPage,
  KbPageRevision,
  KbTreeNode,
} from './types.js'
import { GENERAL_CHANNEL_NAME, KB_SEED_SPACES } from './types.js'

/**
 * Minimum gap between throttled `page_revisions` snapshots for one page (30s).
 * Continuous per-keystroke autosave would otherwise record a revision on every
 * save; this caps history capture to roughly "once per burst of edits" while
 * still preserving undo history (see `Db.updatePageBody`).
 */
const PAGE_REVISION_THROTTLE_MS = 30_000

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
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  handle TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, handle, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS security_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  tool_versions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_scans_task ON security_scans(task_id, id);
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  repo_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL,
  parent_id INTEGER,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_space ON folders(space_id, parent_id);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL,
  folder_id INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(space_id, folder_id);
CREATE TABLE IF NOT EXISTS page_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id, id);
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
  security_status: string | null
  blocked_kind: string | null
  blocked_reason: string | null
  created_at: string
  updated_at: string
}

interface SecurityScanRow {
  id: number
  task_id: string
  round: number
  verdict: string
  findings_json: string
  tool_versions_json: string
  created_at: string
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

interface ReactionRow {
  message_id: number
  handle: string
  emoji: string
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
    // Optional so legacy rows (pre-column) read `undefined`, mirroring `stale`.
    securityStatus: (r.security_status as SecurityStatus | null) ?? undefined,
    blockedKind: r.blocked_kind,
    blockedReason: r.blocked_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToSecurityScan(r: SecurityScanRow): SecurityScan {
  return {
    id: r.id,
    taskId: r.task_id,
    round: r.round,
    verdict: r.verdict as SecurityVerdict,
    findings: JSON.parse(r.findings_json) as SecurityFinding[],
    toolVersions: JSON.parse(r.tool_versions_json) as Record<string, string>,
    createdAt: r.created_at,
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

function rowToMessage(r: MessageRow, reactions: ReactionSummary[] = []): Message {
  return {
    id: r.id,
    channelId: r.channel_id,
    author: r.author,
    body: r.body,
    kind: r.kind as MessageKind,
    reactions,
    createdAt: r.created_at,
  }
}

/**
 * Fold ordered `(emoji, handle)` reaction rows into `ReactionSummary[]`: one
 * entry per distinct emoji (in first-seen order), each carrying its reactor
 * handles in insertion order. Shared by the single-message and batch readers.
 */
function foldReactions(rows: ReactionRow[]): ReactionSummary[] {
  const byEmoji = new Map<string, string[]>()
  for (const r of rows) {
    let handles = byEmoji.get(r.emoji)
    if (!handles) {
      handles = []
      byEmoji.set(r.emoji, handles)
    }
    handles.push(r.handle)
  }
  return [...byEmoji.entries()].map(([emoji, handles]) => ({ emoji, handles }))
}

// ---- KB row interfaces + mappers (snake_case columns → camelCase types) ----

interface SpaceRow {
  id: number
  name: string
  repo_url: string | null
  created_at: string
  updated_at: string
}

interface FolderRow {
  id: number
  space_id: number
  parent_id: number | null
  name: string
  created_at: string
}

interface PageRow {
  id: number
  space_id: number
  folder_id: number | null
  title: string
  body: string
  author: string
  updated_by: string
  created_at: string
  updated_at: string
}

interface PageRevisionRow {
  id: number
  page_id: number
  body: string
  author: string
  created_at: string
}

function rowToSpace(r: SpaceRow): Space {
  return {
    id: r.id,
    name: r.name,
    repoUrl: r.repo_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToFolder(r: FolderRow): KbFolder {
  return {
    id: r.id,
    spaceId: r.space_id,
    parentId: r.parent_id,
    name: r.name,
    createdAt: r.created_at,
  }
}

function rowToPage(r: PageRow): KbPage {
  return {
    id: r.id,
    spaceId: r.space_id,
    folderId: r.folder_id,
    title: r.title,
    body: r.body,
    author: r.author,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToPageRevision(r: PageRevisionRow): KbPageRevision {
  return {
    id: r.id,
    pageId: r.page_id,
    body: r.body,
    author: r.author,
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
    | 'securityStatus'
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
  securityStatus: 'security_status',
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
    this.ensurePageColumns()
    this.seedGeneralChannel()
    this.seedKbSpaces()
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
   * Idempotently seed the three fixed POC KB spaces (general, zmrng, pheme).
   * Mirrors `seedGeneralChannel`: `INSERT OR IGNORE` on the UNIQUE `name` column
   * makes reopening a populated `zmrng.db` a no-op — each space is created
   * exactly once and never duplicated, and existing rows (including any pages a
   * team wrote under them) are left untouched. `general` carries a null
   * repo_url; the repo-scoped spaces carry their GitHub URL.
   */
  private seedKbSpaces(): void {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO spaces (name, repo_url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    )
    for (const s of KB_SEED_SPACES) stmt.run(s.name, s.repoUrl, now, now)
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
      ['security_status', 'TEXT'],
      ['blocked_kind', 'TEXT'],
      ['blocked_reason', 'TEXT'],
    ]
    for (const [name, decl] of add) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${decl}`)
    }
  }

  /**
   * Idempotently add the `pages.body` / `pages.updated_by` columns for a
   * pre-single-field-KB `zmrng.db` (the block-model era stored a page's
   * content in a separate `blocks` table). Additive only, same policy as
   * `ensureColumns()` — a fresh `SCHEMA` already declares both columns, so
   * this is a no-op there.
   */
  private ensurePageColumns(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(pages)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    )
    if (!cols.has('body')) this.db.exec(`ALTER TABLE pages ADD COLUMN body TEXT NOT NULL DEFAULT ''`)
    if (!cols.has('updated_by')) {
      this.db.exec(`ALTER TABLE pages ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''`)
    }
  }

  createTask(input: {
    id: string
    title: string
    body: string
    model: string | null
    effort: EffortLevel | null
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

  /**
   * Persist one security-scan round for a task. `findings` and `toolVersions`
   * are JSON-serialized into TEXT columns (mirrors the `task_comments` insert
   * pattern). Additive — never rewrites a prior round.
   */
  insertSecurityScan(input: {
    taskId: string
    round: number
    verdict: SecurityVerdict
    findings: SecurityFinding[]
    toolVersions: Record<string, string>
    now: string
  }): SecurityScan {
    const findingsJson = JSON.stringify(input.findings)
    const toolVersionsJson = JSON.stringify(input.toolVersions)
    const info = this.db
      .prepare(
        `INSERT INTO security_scans (task_id, round, verdict, findings_json, tool_versions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.taskId, input.round, input.verdict, findingsJson, toolVersionsJson, input.now)
    return {
      id: Number(info.lastInsertRowid),
      taskId: input.taskId,
      round: input.round,
      verdict: input.verdict,
      findings: input.findings,
      toolVersions: input.toolVersions,
      createdAt: input.now,
    }
  }

  /** Every persisted security-scan round for a task, oldest-first (round order). */
  listSecurityScansForTask(taskId: string): SecurityScan[] {
    const rows = this.db
      .prepare('SELECT * FROM security_scans WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as SecurityScanRow[]
    return rows.map(rowToSecurityScan)
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
    const ordered = rows.reverse()
    const reactions = this.reactionsForMessages(ordered.map((r) => r.id))
    return ordered.map((r) => rowToMessage(r, reactions.get(r.id) ?? []))
  }

  /**
   * The channel a message belongs to, or `undefined` if the id is unknown.
   * Used to validate a `react` frame's `messageId` against its claimed
   * `channelId` before persisting a reaction (never trust the wire).
   */
  getMessageChannelId(messageId: number): number | undefined {
    const row = this.db
      .prepare('SELECT channel_id FROM messages WHERE id = ?')
      .get(messageId) as { channel_id: number } | undefined
    return row?.channel_id
  }

  /**
   * One full message row by id, or `undefined` if it does not exist. Mirrors
   * `getChannel(id)`. Backs the KB "Send to KB" route (T4, #154), which needs
   * the message BODY + its channel to build a durable page with canonical,
   * server-side provenance. Reactions are not attached (the promotion cares
   * only about the authored text).
   */
  getMessage(id: number): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return row ? rowToMessage(row) : undefined
  }

  /** Aggregated emoji reactions for ONE message, in reactor order. */
  listReactions(messageId: number): ReactionSummary[] {
    const rows = this.db
      .prepare('SELECT message_id, handle, emoji FROM reactions WHERE message_id = ? ORDER BY id ASC')
      .all(messageId) as ReactionRow[]
    return foldReactions(rows)
  }

  /**
   * Batch-load aggregated reactions for many messages in one query (scrollback
   * pages), keyed by message id. Messages with no reactions are simply absent
   * from the map (the caller defaults to `[]`).
   */
  reactionsForMessages(messageIds: number[]): Map<number, ReactionSummary[]> {
    const byMessage = new Map<number, ReactionSummary[]>()
    if (messageIds.length === 0) return byMessage
    const placeholders = messageIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT message_id, handle, emoji FROM reactions WHERE message_id IN (${placeholders}) ORDER BY id ASC`,
      )
      .all(...messageIds) as ReactionRow[]
    const perMessage = new Map<number, ReactionRow[]>()
    for (const r of rows) {
      let list = perMessage.get(r.message_id)
      if (!list) {
        list = []
        perMessage.set(r.message_id, list)
      }
      list.push(r)
    }
    for (const [id, list] of perMessage) byMessage.set(id, foldReactions(list))
    return byMessage
  }

  /**
   * Toggle one member's emoji reaction on a message: if the exact
   * `(message_id, handle, emoji)` row exists it is removed, otherwise it is
   * inserted. Returns the message's full aggregated reaction set AFTER the
   * change, ready to broadcast. Additive-only: reactions are their own table,
   * never a rewrite of an existing row.
   */
  toggleReaction(
    messageId: number,
    handle: string,
    emoji: string,
    now: string,
  ): ReactionSummary[] {
    const existing = this.db
      .prepare('SELECT id FROM reactions WHERE message_id = ? AND handle = ? AND emoji = ?')
      .get(messageId, handle, emoji) as { id: number } | undefined
    if (existing) {
      this.db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id)
    } else {
      this.db
        .prepare('INSERT INTO reactions (message_id, handle, emoji, created_at) VALUES (?, ?, ?, ?)')
        .run(messageId, handle, emoji, now)
    }
    return this.listReactions(messageId)
  }

  /**
   * Read one persisted app setting by key, or `undefined` when unset. Used for
   * durable server-side prefs (e.g. the Team workspace URL + display-name
   * handle) that must survive a client-side localStorage wipe, an app
   * close/reopen, a `desktop:build`, and a reboot — the sidecar `zmrng.db` lives
   * in the persistent per-user data dir.
   */
  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  /**
   * Upsert one app setting. A blank (whitespace-only) value deletes the row so
   * "cleared" and "never set" read back identically as `undefined`. Additive:
   * the `settings` table is only ever inserted into / updated in place, never
   * dropped or rewritten wholesale (migration policy above).
   */
  setSetting(key: string, value: string, now: string): void {
    const trimmed = value.trim()
    if (!trimmed) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
      return
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, trimmed, now)
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

  // ===================================================================
  // Knowledge Base (KB) — spaces / folders / pages / blocks / revisions
  // Siblings of channels/messages; mirror the listChannels/createChannel/
  // addMessage/listMessages patterns with rowTo* mappers + *Row interfaces.
  // ===================================================================

  /** Every KB space, in insertion order (general is first). */
  listSpaces(): Space[] {
    const rows = this.db.prepare('SELECT * FROM spaces ORDER BY id ASC').all() as SpaceRow[]
    return rows.map(rowToSpace)
  }

  /** One space by id, or `undefined` if it does not exist. */
  getSpace(id: number): Space | undefined {
    const row = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as
      | SpaceRow
      | undefined
    return row ? rowToSpace(row) : undefined
  }

  /** Every folder in a space, in insertion order. */
  listFolders(spaceId: number): KbFolder[] {
    const rows = this.db
      .prepare('SELECT * FROM folders WHERE space_id = ? ORDER BY id ASC')
      .all(spaceId) as FolderRow[]
    return rows.map(rowToFolder)
  }

  /** One folder by id, or `undefined` if it does not exist. */
  getFolder(id: number): KbFolder | undefined {
    const row = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as
      | FolderRow
      | undefined
    return row ? rowToFolder(row) : undefined
  }

  /**
   * Create a folder. `parentId` null = space root; a non-null `parentId`
   * self-references `folders` for nesting.
   */
  createFolder(
    spaceId: number,
    parentId: number | null,
    name: string,
    now: string,
  ): KbFolder {
    const info = this.db
      .prepare(
        'INSERT INTO folders (space_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(spaceId, parentId, name, now)
    return { id: Number(info.lastInsertRowid), spaceId, parentId, name, createdAt: now }
  }

  /** Rename a folder in place. Returns the updated folder, or `undefined`. */
  renameFolder(id: number, name: string): KbFolder | undefined {
    this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id)
    return this.getFolder(id)
  }

  /**
   * Move a folder under a new parent (null = space root). Rejects a move that
   * would create a cycle — a folder cannot become its own parent, nor a
   * descendant of itself. A cycle would detach the whole sub-loop from every
   * root in `spaceTree` (iterative assembly never re-attaches it), silently
   * vanishing those folders/pages from the tree, so guard it at the seam.
   * Returns the folder unchanged when the move is rejected (no-op).
   */
  moveFolder(id: number, parentId: number | null): KbFolder | undefined {
    const folder = this.getFolder(id)
    if (!folder) return undefined
    if (parentId !== null) {
      if (parentId === id) return folder
      // Walk up from the proposed parent; if we reach `id`, the move is a cycle.
      let cursor: number | null = parentId
      const seen = new Set<number>()
      while (cursor !== null) {
        if (cursor === id) return folder
        if (seen.has(cursor)) break // pre-existing loop upstream — don't spin
        seen.add(cursor)
        const row = this.db
          .prepare('SELECT parent_id FROM folders WHERE id = ?')
          .get(cursor) as { parent_id: number | null } | undefined
        if (!row) break
        cursor = row.parent_id
      }
    }
    this.db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(parentId, id)
    return this.getFolder(id)
  }

  /**
   * Delete a folder and everything it contains, recursively, in one transaction.
   *
   * Cascade semantics (matches `deletePage`, which cascades page→revisions):
   * the target folder, all of its descendant subfolders (at any depth), every page
   * in any of those folders, and each page's revisions are removed. This
   * leaves no orphan rows pointing at a deleted parent_id/folder_id and matches the
   * user expectation that deleting a folder removes its contents. The delete order is
   * revisions → pages → folders, and the whole thing runs inside a single
   * better-sqlite3 transaction so any failure rolls back cleanly.
   */
  deleteFolder(id: number): void {
    const run = this.db.transaction((rootId: number) => {
      // Collect the target plus all descendant folder ids (BFS over parent_id).
      const folderIds: number[] = [rootId]
      let frontier: number[] = [rootId]
      while (frontier.length > 0) {
        const placeholders = frontier.map(() => '?').join(', ')
        const children = this.db
          .prepare(`SELECT id FROM folders WHERE parent_id IN (${placeholders})`)
          .all(...frontier) as { id: number }[]
        frontier = children.map((c) => c.id)
        folderIds.push(...frontier)
      }
      // For every folder in the set, cascade its pages → revisions.
      for (const fid of folderIds) {
        const pageIds = (
          this.db.prepare('SELECT id FROM pages WHERE folder_id = ?').all(fid) as {
            id: number
          }[]
        ).map((p) => p.id)
        for (const pid of pageIds) {
          this.db.prepare('DELETE FROM page_revisions WHERE page_id = ?').run(pid)
          this.db.prepare('DELETE FROM pages WHERE id = ?').run(pid)
        }
      }
      // Finally remove the folder rows themselves (order is irrelevant once collected).
      for (const fid of folderIds) {
        this.db.prepare('DELETE FROM folders WHERE id = ?').run(fid)
      }
    })
    run(id)
  }

  /** Every page in a space, in insertion order. */
  listPages(spaceId: number): KbPage[] {
    const rows = this.db
      .prepare('SELECT * FROM pages WHERE space_id = ? ORDER BY id ASC')
      .all(spaceId) as PageRow[]
    return rows.map(rowToPage)
  }

  /** One page by id, or `undefined` if it does not exist. */
  getPage(id: number): KbPage | undefined {
    const row = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as
      | PageRow
      | undefined
    return row ? rowToPage(row) : undefined
  }

  /** Create a page. `folderId` null = space root. `body` defaults to empty
   *  (a fresh notepad-style page starts blank, ready to type into). */
  createPage(
    spaceId: number,
    folderId: number | null,
    title: string,
    author: string,
    now: string,
    body = '',
  ): KbPage {
    const info = this.db
      .prepare(
        `INSERT INTO pages (space_id, folder_id, title, body, author, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(spaceId, folderId, title, body, author, author, now, now)
    return {
      id: Number(info.lastInsertRowid),
      spaceId,
      folderId,
      title,
      body,
      author,
      updatedBy: author,
      createdAt: now,
      updatedAt: now,
    }
  }

  /** Rename a page (updates `updated_at`). Returns the updated page. */
  updatePage(id: number, title: string, now: string): KbPage | undefined {
    this.db
      .prepare('UPDATE pages SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, now, id)
    return this.getPage(id)
  }

  /** Move a page into a folder (null = space root). Updates `updated_at`. */
  movePage(id: number, folderId: number | null, now: string): KbPage | undefined {
    this.db
      .prepare('UPDATE pages SET folder_id = ?, updated_at = ? WHERE id = ?')
      .run(folderId, now, id)
    return this.getPage(id)
  }

  /** Delete a page and its revisions (owned children). */
  deletePage(id: number): void {
    const run = this.db.transaction((pageId: number) => {
      this.db.prepare('DELETE FROM page_revisions WHERE page_id = ?').run(pageId)
      this.db.prepare('DELETE FROM pages WHERE id = ?').run(pageId)
    })
    run(id)
  }

  /**
   * Autosave a page's whole body (the single-field editor's write path).
   * BEFORE overwriting, throttles a prior-body snapshot into `page_revisions`:
   * a snapshot is captured only when none exists yet, or the last one is older
   * than `PAGE_REVISION_THROTTLE_MS` — so continuous per-keystroke autosave
   * does not spam a revision on every save, while undo history still survives.
   * Returns the updated page, or `undefined` if it does not exist.
   */
  updatePageBody(id: number, body: string, author: string, now: string): KbPage | undefined {
    const run = this.db.transaction((): KbPage | undefined => {
      const existing = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as
        | PageRow
        | undefined
      if (!existing) return undefined
      const last = this.db
        .prepare('SELECT created_at FROM page_revisions WHERE page_id = ? ORDER BY id DESC LIMIT 1')
        .get(id) as { created_at: string } | undefined
      const sinceMs = new Date(last?.created_at ?? existing.updated_at).getTime()
      const dueForSnapshot = !last || new Date(now).getTime() - sinceMs >= PAGE_REVISION_THROTTLE_MS
      if (dueForSnapshot) this.insertPageRevision(existing, now)
      this.db
        .prepare('UPDATE pages SET body = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(body, now, author, id)
      return this.getPage(id)
    })
    return run()
  }

  /** Every revision of a page, oldest first (id ASC). Backs the History panel. */
  listPageRevisions(pageId: number): KbPageRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM page_revisions WHERE page_id = ? ORDER BY id ASC')
      .all(pageId) as PageRevisionRow[]
    return rows.map(rowToPageRevision)
  }

  /**
   * Restore a revision's body back onto its page. Itself UNCONDITIONALLY
   * records a revision of the state it replaces first (an explicit operator
   * action, not a throttled keystroke autosave, so it always gets its own undo
   * point). `restoredBy` becomes the page's new `updated_by`. Returns the
   * restored page, or `undefined` if the revision/page is gone.
   */
  restorePageRevision(revisionId: number, restoredBy: string, now: string): KbPage | undefined {
    const run = this.db.transaction((): KbPage | undefined => {
      const rev = this.db.prepare('SELECT * FROM page_revisions WHERE id = ?').get(revisionId) as
        | PageRevisionRow
        | undefined
      if (!rev) return undefined
      const page = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(rev.page_id) as
        | PageRow
        | undefined
      if (!page) return undefined
      this.insertPageRevision(page, now)
      this.db
        .prepare('UPDATE pages SET body = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(rev.body, now, restoredBy, page.id)
      return this.getPage(page.id)
    })
    return run()
  }

  /** Snapshot the given page's CURRENT body into `page_revisions` (prior-state capture). */
  private insertPageRevision(page: PageRow, now: string): void {
    this.db
      .prepare(
        `INSERT INTO page_revisions (page_id, body, author, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(page.id, page.body, page.updated_by, now)
  }

  /**
   * Assemble a space's folders + pages into a `FileTree`-shaped node tree
   * (server-side assembly). Folders become `type: 'dir'` nodes, pages become
   * `type: 'file'` leaves; nesting follows `parent_id` / `folder_id`, with root
   * (null parent/folder) items at the top. Orphan rows (dangling parent) fall
   * back to the root so nothing is silently dropped.
   */
  spaceTree(spaceId: number): KbTreeNode[] {
    const folders = this.listFolders(spaceId)
    const pages = this.listPages(spaceId)
    const folderNodes = new Map<number, KbTreeNode>()
    for (const f of folders) {
      folderNodes.set(f.id, {
        id: f.id,
        name: f.name,
        path: `folder/${f.id}`,
        type: 'dir',
        kind: 'folder',
        children: [],
      })
    }
    const roots: KbTreeNode[] = []
    for (const f of folders) {
      const node = folderNodes.get(f.id)!
      const parent = f.parentId !== null ? folderNodes.get(f.parentId) : undefined
      if (parent) parent.children!.push(node)
      else roots.push(node)
    }
    for (const p of pages) {
      const node: KbTreeNode = {
        id: p.id,
        name: p.title,
        path: `page/${p.id}`,
        type: 'file',
        kind: 'page',
      }
      const parent = p.folderId !== null ? folderNodes.get(p.folderId) : undefined
      if (parent) parent.children!.push(node)
      else roots.push(node)
    }
    return roots
  }
}
