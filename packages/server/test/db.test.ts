import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { Db } from '../src/db.js'
import type { KbChangeAction, LoopRun, LoopTicket, TaskUsage } from '../src/types.js'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zmrng-db-'))
  dbPath = path.join(dir, 'zmrng.db')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function columns(p: string): Set<string> {
  const raw = new Database(p)
  const cols = new Set(
    (raw.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name),
  )
  raw.close()
  return cols
}

const ADDED = [
  'effort',
  'style',
  'repo_id',
  'plan_path',
  'tokens_in',
  'tokens_out',
  'tokens_cache',
  'cost_usd',
  'turns',
]

const ADDED_BOARD = ['blocked_kind', 'blocked_reason']

const ADDED_FLOW = ['flow']

describe('ensureColumns migration', () => {
  it('backfills columns missing from a pre-existing (old-schema) tasks table', () => {
    // Simulate a DB created before the added columns existed.
    const raw = new Database(dbPath)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      session_id TEXT, branch TEXT, worktree TEXT, pr_url TEXT, model TEXT,
      queued INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`)
    raw.close()
    for (const c of ADDED) expect(columns(dbPath).has(c)).toBe(false)

    new Db(dbPath) // constructor runs ensureColumns()
    for (const c of ADDED) expect(columns(dbPath).has(c)).toBe(true)
  })

  it('backfills the board columns (blocked_kind, blocked_reason) on an old-schema table', () => {
    const raw = new Database(dbPath)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      session_id TEXT, branch TEXT, worktree TEXT, pr_url TEXT, model TEXT,
      queued INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`)
    raw.close()
    for (const c of ADDED_BOARD) expect(columns(dbPath).has(c)).toBe(false)

    new Db(dbPath)
    for (const c of ADDED_BOARD) expect(columns(dbPath).has(c)).toBe(true)
  })

  it('backfills the flow column on an old-schema table', () => {
    const raw = new Database(dbPath)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      session_id TEXT, branch TEXT, worktree TEXT, pr_url TEXT, model TEXT,
      queued INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`)
    raw.close()
    for (const c of ADDED_FLOW) expect(columns(dbPath).has(c)).toBe(false)

    new Db(dbPath)
    for (const c of ADDED_FLOW) expect(columns(dbPath).has(c)).toBe(true)
  })

  it('is idempotent across two runs (second open adds nothing and does not throw)', () => {
    new Db(dbPath)
    const after1 = columns(dbPath)
    expect(() => new Db(dbPath)).not.toThrow()
    const after2 = columns(dbPath)
    expect([...after2].sort()).toEqual([...after1].sort())
  })

  it('survives a re-open on a populated db: existing task + comment rows are untouched', () => {
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'x',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-07-27T00:00:00.000Z',
    })
    db.addComment('t1', 'operator', 'hello', '2026-07-27T00:00:01.000Z')
    const colsBefore = columns(dbPath)

    const db2 = new Db(dbPath) // re-open runs ensureColumns() again
    expect(db2.getTask('t1')?.title).toBe('x')
    expect(db2.listComments('t1')).toHaveLength(1)
    expect(db2.listComments('t1')[0]?.body).toBe('hello')
    expect([...columns(dbPath)].sort()).toEqual([...colsBefore].sort())
  })

  it('creates the task_comments table', () => {
    new Db(dbPath)
    const raw = new Database(dbPath)
    const tables = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((t) => t.name),
    )
    raw.close()
    expect(tables.has('task_comments')).toBe(true)
  })

  it('backfills the security_status column on an old-schema table', () => {
    const raw = new Database(dbPath)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      session_id TEXT, branch TEXT, worktree TEXT, pr_url TEXT, model TEXT,
      queued INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`)
    raw.close()
    expect(columns(dbPath).has('security_status')).toBe(false)

    new Db(dbPath)
    expect(columns(dbPath).has('security_status')).toBe(true)
  })

  it('creates the security_scans table', () => {
    new Db(dbPath)
    const raw = new Database(dbPath)
    const tables = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((t) => t.name),
    )
    raw.close()
    expect(tables.has('security_scans')).toBe(true)
  })
})

describe('security_scans', () => {
  const mk = (): Db => {
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'x',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-09-10T00:00:00.000Z',
    })
    return db
  }

  it('insertSecurityScan + listSecurityScansForTask round-trip (findings + tool versions)', () => {
    const db = mk()
    const findings = [
      {
        tool: 'semgrep' as const,
        ruleId: 'r1',
        severity: 'ERROR' as const,
        title: 'shell injection',
        path: 'src/app.py',
        line: 42,
        confidence: 'HIGH' as const,
      },
    ]
    const s1 = db.insertSecurityScan({
      taskId: 't1',
      round: 1,
      verdict: 'fail',
      findings,
      toolVersions: { semgrep: '1.80.0', 'osv-scanner': '1.9.0' },
      now: '2026-09-10T00:00:01.000Z',
    })
    const s2 = db.insertSecurityScan({
      taskId: 't1',
      round: 2,
      verdict: 'pass',
      findings: [],
      toolVersions: { semgrep: '1.80.0', 'osv-scanner': '1.9.0' },
      now: '2026-09-10T00:00:02.000Z',
    })
    expect(s1.id).not.toBe(s2.id)

    const listed = db.listSecurityScansForTask('t1')
    expect(listed).toHaveLength(2)
    expect(listed[0]).toEqual(s1)
    expect(listed[1]).toEqual(s2)
    expect(listed[0].verdict).toBe('fail')
    expect(listed[0].findings).toEqual(findings)
    expect(listed[0].toolVersions).toEqual({ semgrep: '1.80.0', 'osv-scanner': '1.9.0' })
    expect(listed[1].findings).toEqual([])
  })

  it('persists across reopen (survives reload)', () => {
    const db1 = mk()
    db1.insertSecurityScan({
      taskId: 't1',
      round: 1,
      verdict: 'pass',
      findings: [],
      toolVersions: { semgrep: '1.80.0' },
      now: '2026-09-10T00:00:01.000Z',
    })
    const db2 = new Db(dbPath)
    const listed = db2.listSecurityScansForTask('t1')
    expect(listed).toHaveLength(1)
    expect(listed[0].verdict).toBe('pass')
  })

  it('returns an empty list for an unknown task', () => {
    const db = new Db(dbPath)
    expect(db.listSecurityScansForTask('nope')).toEqual([])
  })
})

describe('securityStatus column', () => {
  it('updateTask can set and read back securityStatus through rowToTask', () => {
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'x',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-09-10T00:00:00.000Z',
    })
    // A freshly-created task has no security verdict yet.
    expect(db.getTask('t1')?.securityStatus).toBeUndefined()

    const updated = db.updateTask('t1', { securityStatus: 'pass' }, '2026-09-10T00:00:01.000Z')
    expect(updated?.securityStatus).toBe('pass')
    expect(db.getTask('t1')?.securityStatus).toBe('pass')

    db.updateTask('t1', { securityStatus: 'fail' }, '2026-09-10T00:00:02.000Z')
    expect(db.getTask('t1')?.securityStatus).toBe('fail')
  })
})

describe('task_comments', () => {
  const mk = (): Db => {
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'x',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-07-27T00:00:00.000Z',
    })
    return db
  }

  it('addComment + listComments round-trip', () => {
    const db = mk()
    const c1 = db.addComment('t1', 'operator', 'first comment', '2026-07-27T00:00:01.000Z')
    const c2 = db.addComment('t1', 'qa', 'second comment', '2026-07-27T00:00:02.000Z')
    expect(c1.id).not.toBe(c2.id)

    const listed = db.listComments('t1')
    expect(listed).toHaveLength(2)
    expect(listed[0]).toEqual(c1)
    expect(listed[1]).toEqual(c2)
  })
})

describe('chat messages (U4)', () => {
  it('addChatMessage + listChatMessages round-trip, keyed by task + agent', () => {
    const db = new Db(dbPath)
    const u = db.addChatMessage('t1', 'a1', 'user', 'hi', '2026-08-15T00:00:01.000Z')
    const r = db.addChatMessage('t1', 'a1', 'assistant', 'hello', '2026-08-15T00:00:02.000Z')
    // A different agent's history must not leak into a1's conversation.
    db.addChatMessage('t1', 'a2', 'user', 'other agent', '2026-08-15T00:00:03.000Z')
    // A different task's history must not leak either.
    db.addChatMessage('t2', 'a1', 'user', 'other task', '2026-08-15T00:00:04.000Z')

    const listed = db.listChatMessages('t1', 'a1')
    expect(listed).toHaveLength(2)
    expect(listed[0]).toEqual(u)
    expect(listed[1]).toEqual(r)
    expect(listed.map((m) => m.content)).toEqual(['hi', 'hello'])
  })

  it('persists across reopen (survives reload)', () => {
    const db1 = new Db(dbPath)
    db1.addChatMessage('t1', 'a1', 'user', 'persisted', '2026-08-15T00:00:01.000Z')
    const db2 = new Db(dbPath)
    expect(db2.listChatMessages('t1', 'a1')).toHaveLength(1)
    expect(db2.listChatMessages('t1', 'a1')[0]?.content).toBe('persisted')
  })

  it('returns an empty list for an unknown task/agent', () => {
    const db = new Db(dbPath)
    expect(db.listChatMessages('nope', 'a1')).toEqual([])
  })
})

describe('blockedKind / blockedReason', () => {
  it('updateTask can set and read back blockedKind/blockedReason', () => {
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'x',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-07-27T00:00:00.000Z',
    })
    expect(db.getTask('t1')?.blockedKind).toBeNull()
    expect(db.getTask('t1')?.blockedReason).toBeNull()

    db.updateTask(
      't1',
      { blockedKind: 'toolchain', blockedReason: 'missing subagent' },
      '2026-07-27T00:00:01.000Z',
    )
    const after = db.getTask('t1')
    expect(after?.blockedKind).toBe('toolchain')
    expect(after?.blockedReason).toBe('missing subagent')
  })
})

describe('close() — WAL checkpoint durability', () => {
  const seed = (db: Db): void => {
    db.createTask({
      id: 't1',
      title: 'persist me',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-08-16T00:00:00.000Z',
    })
  }

  it('checkpoints the WAL into the durable .db file (row survives losing the -wal sidecar)', () => {
    const db = new Db(dbPath)
    seed(db)
    // Before close, the write lives in the WAL sidecar, not yet the main file.
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    db.close()

    // Simulate the sidecar being dropped/reset (crash, cleanup, external tool).
    // If close() truly checkpointed into the durable file, the task survives.
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })

    const reopened = new Db(dbPath)
    expect(reopened.getTask('t1')?.title).toBe('persist me')
    expect(reopened.taskCount()).toBe(1)
    reopened.close()
  })

  it('truncates the -wal sidecar to empty on close', () => {
    const db = new Db(dbPath)
    seed(db)
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)
    db.close()
    // TRUNCATE checkpoint zeroes the sidecar (0 bytes, or removed entirely).
    const walSize = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0
    expect(walSize).toBe(0)
  })

  it('taskCount reflects persisted rows', () => {
    const db = new Db(dbPath)
    expect(db.taskCount()).toBe(0)
    seed(db)
    expect(db.taskCount()).toBe(1)
    db.close()
  })
})

describe('deleteTask', () => {
  it('removes the task row and its events/comments/chat messages, leaving other tasks untouched', () => {
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'delete me',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'direct',
      repoId: 'zmrng',
      now: '2026-08-16T00:00:00.000Z',
    })
    db.createTask({
      id: 't2',
      title: 'keep me',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'direct',
      repoId: 'zmrng',
      now: '2026-08-16T00:00:00.000Z',
    })
    db.insertEvent('t1', 'status', { sub: 'status' }, '2026-08-16T00:00:01.000Z')
    db.addComment('t1', 'operator', 'hi', '2026-08-16T00:00:02.000Z')
    db.addChatMessage('t1', 'a1', 'user', 'hi', '2026-08-16T00:00:03.000Z')

    db.deleteTask('t1')

    expect(db.getTask('t1')).toBeUndefined()
    expect(db.getEvents('t1')).toEqual([])
    expect(db.listComments('t1')).toEqual([])
    expect(db.listChatMessages('t1', 'a1')).toEqual([])
    expect(db.getTask('t2')?.title).toBe('keep me')
  })
})

describe('members (team workspace T1)', () => {
  it('creates the members table', () => {
    new Db(dbPath)
    const raw = new Database(dbPath)
    const tables = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((t) => t.name),
    )
    raw.close()
    expect(tables.has('members')).toBe(true)
  })

  it('upsertMember inserts a new member and returns it', () => {
    const db = new Db(dbPath)
    const m = db.upsertMember('Ada', '2026-08-24T00:00:00.000Z')
    expect(m.displayName).toBe('Ada')
    expect(m.createdAt).toBe('2026-08-24T00:00:00.000Z')
    expect(typeof m.id).toBe('number')
    expect(db.listMembers()).toHaveLength(1)
  })

  it('upsertMember is idempotent by display name (re-join reuses the same row)', () => {
    const db = new Db(dbPath)
    const first = db.upsertMember('Ada', '2026-08-24T00:00:00.000Z')
    const again = db.upsertMember('Ada', '2026-08-24T00:05:00.000Z')
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt) // original creation time preserved
    expect(db.listMembers()).toHaveLength(1)
  })

  it('listMembers returns every distinct member in insertion order', () => {
    const db = new Db(dbPath)
    db.upsertMember('Ada', '2026-08-24T00:00:00.000Z')
    db.upsertMember('Bo', '2026-08-24T00:00:01.000Z')
    db.upsertMember('Ada', '2026-08-24T00:00:02.000Z')
    const listed = db.listMembers()
    expect(listed.map((m) => m.displayName)).toEqual(['Ada', 'Bo'])
  })

  it('persists members across reopen', () => {
    const db1 = new Db(dbPath)
    db1.upsertMember('Ada', '2026-08-24T00:00:00.000Z')
    const db2 = new Db(dbPath)
    expect(db2.listMembers().map((m) => m.displayName)).toEqual(['Ada'])
  })
})

describe('channels + messages (team workspace T2)', () => {
  const tables = (p: string): Set<string> => {
    const raw = new Database(p)
    const names = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((t) => t.name),
    )
    raw.close()
    return names
  }

  it('creates the channels and messages tables', () => {
    new Db(dbPath)
    const t = tables(dbPath)
    expect(t.has('channels')).toBe(true)
    expect(t.has('messages')).toBe(true)
  })

  it('seeds a fixed #general channel by default (with a null repo_id)', () => {
    const db = new Db(dbPath)
    const channels = db.listChannels()
    expect(channels).toHaveLength(1)
    expect(channels[0].name).toBe('general')
    expect(channels[0].repoId).toBeNull()
    expect(typeof channels[0].id).toBe('number')
  })

  it('seeds #general idempotently — a reopen does not add a second row', () => {
    new Db(dbPath)
    const db2 = new Db(dbPath)
    expect(db2.listChannels().filter((c) => c.name === 'general')).toHaveLength(1)
  })

  it('createChannel inserts a repo-tied channel and returns it', () => {
    const db = new Db(dbPath)
    const c = db.createChannel('zmrng-dev', 'zmrng', '2026-08-25T00:00:00.000Z')
    expect(c.name).toBe('zmrng-dev')
    expect(c.repoId).toBe('zmrng')
    expect(db.getChannel(c.id)?.name).toBe('zmrng-dev')
  })

  it('createChannel is idempotent by name (unique) — reuses the existing row', () => {
    const db = new Db(dbPath)
    const first = db.createChannel('dupe', null, '2026-08-25T00:00:00.000Z')
    const again = db.createChannel('dupe', 'zmrng', '2026-08-25T00:05:00.000Z')
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    expect(db.listChannels().filter((c) => c.name === 'dupe')).toHaveLength(1)
  })

  it('getChannel returns undefined for an unknown id', () => {
    const db = new Db(dbPath)
    expect(db.getChannel(99999)).toBeUndefined()
  })

  it('addMessage persists a message and round-trips its fields', () => {
    const db = new Db(dbPath)
    const chan = db.listChannels()[0]
    const m = db.addMessage(chan.id, 'Ada', 'hello team', 'human', '2026-08-25T00:00:00.000Z')
    expect(m.channelId).toBe(chan.id)
    expect(m.author).toBe('Ada')
    expect(m.body).toBe('hello team')
    expect(m.kind).toBe('human')
    expect(m.createdAt).toBe('2026-08-25T00:00:00.000Z')
    expect(typeof m.id).toBe('number')
  })

  it('addMessage preserves the agent kind for later agent use', () => {
    const db = new Db(dbPath)
    const chan = db.listChannels()[0]
    const m = db.addMessage(chan.id, 'planner', 'on it', 'agent', '2026-08-25T00:00:01.000Z')
    expect(m.kind).toBe('agent')
    expect(db.listMessages(chan.id, null, 10)[0].kind).toBe('agent')
  })

  it('listMessages returns messages for a channel in ascending id order', () => {
    const db = new Db(dbPath)
    const chan = db.listChannels()[0]
    db.addMessage(chan.id, 'Ada', 'one', 'human', '2026-08-25T00:00:00.000Z')
    db.addMessage(chan.id, 'Bo', 'two', 'human', '2026-08-25T00:00:01.000Z')
    db.addMessage(chan.id, 'Ada', 'three', 'human', '2026-08-25T00:00:02.000Z')
    expect(db.listMessages(chan.id, null, 50).map((m) => m.body)).toEqual(['one', 'two', 'three'])
  })

  it('listMessages scopes to the requested channel only', () => {
    const db = new Db(dbPath)
    const general = db.listChannels()[0]
    const other = db.createChannel('other', null, '2026-08-25T00:00:00.000Z')
    db.addMessage(general.id, 'Ada', 'in general', 'human', '2026-08-25T00:00:00.000Z')
    db.addMessage(other.id, 'Bo', 'in other', 'human', '2026-08-25T00:00:01.000Z')
    expect(db.listMessages(general.id, null, 50).map((m) => m.body)).toEqual(['in general'])
    expect(db.listMessages(other.id, null, 50).map((m) => m.body)).toEqual(['in other'])
  })

  it('listMessages returns the MOST RECENT page (ascending) when over the limit', () => {
    const db = new Db(dbPath)
    const chan = db.listChannels()[0]
    for (let i = 0; i < 5; i++) {
      db.addMessage(chan.id, 'Ada', `m${i}`, 'human', `2026-08-25T00:00:0${i}.000Z`)
    }
    // limit 2 → the two newest, still oldest-first for rendering
    expect(db.listMessages(chan.id, null, 2).map((m) => m.body)).toEqual(['m3', 'm4'])
  })

  it('listMessages pages backwards via the `before` cursor (scrollback)', () => {
    const db = new Db(dbPath)
    const chan = db.listChannels()[0]
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(db.addMessage(chan.id, 'Ada', `m${i}`, 'human', `2026-08-25T00:00:0${i}.000Z`).id)
    }
    const newest = db.listMessages(chan.id, null, 2) // m3, m4
    expect(newest.map((m) => m.body)).toEqual(['m3', 'm4'])
    const older = db.listMessages(chan.id, newest[0].id, 2) // before m3 → m1, m2
    expect(older.map((m) => m.body)).toEqual(['m1', 'm2'])
    const oldest = db.listMessages(chan.id, older[0].id, 2) // before m1 → m0
    expect(oldest.map((m) => m.body)).toEqual(['m0'])
    expect(ids).toHaveLength(5)
  })

  it('persists channels and messages across reopen', () => {
    const db1 = new Db(dbPath)
    const chan = db1.listChannels()[0]
    db1.addMessage(chan.id, 'Ada', 'durable', 'human', '2026-08-25T00:00:00.000Z')
    const db2 = new Db(dbPath)
    expect(db2.listMessages(chan.id, null, 50).map((m) => m.body)).toEqual(['durable'])
  })
})

describe('reactions (team workspace — emoji reactions)', () => {
  const seedMessage = (db: Db): { channelId: number; messageId: number } => {
    const chan = db.listChannels()[0]
    const m = db.addMessage(chan.id, 'Ada', 'hi', 'human', '2026-08-25T00:00:00.000Z')
    return { channelId: chan.id, messageId: m.id }
  }

  it('creates the reactions table', () => {
    new Db(dbPath)
    const raw = new Database(dbPath)
    const row = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reactions'")
      .get() as { name: string } | undefined
    raw.close()
    expect(row).toBeDefined()
  })

  it('toggleReaction adds then removes the same (message, handle, emoji)', () => {
    const db = new Db(dbPath)
    const { messageId } = seedMessage(db)
    const after1 = db.toggleReaction(messageId, 'Ada', '👍', '2026-08-25T00:00:01.000Z')
    expect(after1).toEqual([{ emoji: '👍', handles: ['Ada'] }])
    const after2 = db.toggleReaction(messageId, 'Ada', '👍', '2026-08-25T00:00:02.000Z')
    expect(after2).toEqual([])
    expect(db.listReactions(messageId)).toEqual([])
  })

  it('aggregates multiple handles per emoji in reaction order', () => {
    const db = new Db(dbPath)
    const { messageId } = seedMessage(db)
    db.toggleReaction(messageId, 'Ada', '👍', '2026-08-25T00:00:01.000Z')
    db.toggleReaction(messageId, 'Bo', '👍', '2026-08-25T00:00:02.000Z')
    db.toggleReaction(messageId, 'Cy', '❤️', '2026-08-25T00:00:03.000Z')
    expect(db.listReactions(messageId)).toEqual([
      { emoji: '👍', handles: ['Ada', 'Bo'] },
      { emoji: '❤️', handles: ['Cy'] },
    ])
  })

  it('a handle can hold different emoji on the same message simultaneously', () => {
    const db = new Db(dbPath)
    const { messageId } = seedMessage(db)
    db.toggleReaction(messageId, 'Ada', '👍', '2026-08-25T00:00:01.000Z')
    db.toggleReaction(messageId, 'Ada', '🎉', '2026-08-25T00:00:02.000Z')
    expect(db.listReactions(messageId)).toEqual([
      { emoji: '👍', handles: ['Ada'] },
      { emoji: '🎉', handles: ['Ada'] },
    ])
  })

  it('listMessages attaches each message its aggregated reactions', () => {
    const db = new Db(dbPath)
    const { channelId, messageId } = seedMessage(db)
    const second = db.addMessage(channelId, 'Bo', 'yo', 'human', '2026-08-25T00:00:01.000Z')
    db.toggleReaction(messageId, 'Ada', '👍', '2026-08-25T00:00:02.000Z')
    db.toggleReaction(messageId, 'Bo', '👍', '2026-08-25T00:00:03.000Z')
    const page = db.listMessages(channelId, null, 50)
    const first = page.find((m) => m.id === messageId)
    const other = page.find((m) => m.id === second.id)
    expect(first?.reactions).toEqual([{ emoji: '👍', handles: ['Ada', 'Bo'] }])
    // A message with no reactions gets an empty array, not undefined.
    expect(other?.reactions).toEqual([])
  })

  it('getMessageChannelId returns the owning channel or undefined', () => {
    const db = new Db(dbPath)
    const { channelId, messageId } = seedMessage(db)
    expect(db.getMessageChannelId(messageId)).toBe(channelId)
    expect(db.getMessageChannelId(999999)).toBeUndefined()
  })

  it('getMessage round-trips the full message row, or undefined for an unknown id', () => {
    const db = new Db(dbPath)
    const chan = db.createChannel('kb-src', null, '2026-08-25T00:00:00.000Z')
    const posted = db.addMessage(chan.id, 'Ada', 'promote me', 'human', '2026-08-25T00:00:01.000Z')
    const got = db.getMessage(posted.id)
    expect(got?.id).toBe(posted.id)
    expect(got?.channelId).toBe(chan.id)
    expect(got?.author).toBe('Ada')
    expect(got?.body).toBe('promote me')
    expect(got?.kind).toBe('human')
    expect(got?.createdAt).toBe('2026-08-25T00:00:01.000Z')
    expect(db.getMessage(999999)).toBeUndefined()
  })

  it('reactionsForMessages batches, and is empty for an empty id list', () => {
    const db = new Db(dbPath)
    const { channelId, messageId } = seedMessage(db)
    const second = db.addMessage(channelId, 'Bo', 'yo', 'human', '2026-08-25T00:00:01.000Z')
    db.toggleReaction(messageId, 'Ada', '👍', '2026-08-25T00:00:02.000Z')
    const map = db.reactionsForMessages([messageId, second.id])
    expect(map.get(messageId)).toEqual([{ emoji: '👍', handles: ['Ada'] }])
    expect(map.has(second.id)).toBe(false)
    expect(db.reactionsForMessages([]).size).toBe(0)
  })

  it('persists reactions across reopen (survives redeploy)', () => {
    const db1 = new Db(dbPath)
    const { messageId } = seedMessage(db1)
    db1.toggleReaction(messageId, 'Ada', '🎉', '2026-08-25T00:00:01.000Z')
    const db2 = new Db(dbPath)
    expect(db2.listReactions(messageId)).toEqual([{ emoji: '🎉', handles: ['Ada'] }])
  })
})

describe('stale column (agent-task-persistence)', () => {
  it('backfills the stale column on an old-schema table', () => {
    const raw = new Database(dbPath)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      session_id TEXT, branch TEXT, worktree TEXT, pr_url TEXT, model TEXT,
      queued INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`)
    raw.close()
    expect(columns(dbPath).has('stale')).toBe(false)

    new Db(dbPath) // constructor runs ensureColumns()
    expect(columns(dbPath).has('stale')).toBe(true)
  })

  it('defaults stale to false and round-trips updateTask({ stale: true })', () => {
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'x',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-09-07T00:00:00.000Z',
    })
    expect(db.getTask('t1')?.stale).toBe(false)

    db.updateTask('t1', { stale: true }, '2026-09-07T00:00:01.000Z')
    expect(db.getTask('t1')?.stale).toBe(true)

    // ...and can be cleared back to false.
    db.updateTask('t1', { stale: false }, '2026-09-07T00:00:02.000Z')
    expect(db.getTask('t1')?.stale).toBe(false)
  })

  it('is preserved as false across a reopen for a legacy (pre-stale) row', () => {
    // Old-schema table with a row, then reopen through Db (adds stale DEFAULT 0).
    const raw = new Database(dbPath)
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      session_id TEXT, branch TEXT, worktree TEXT, pr_url TEXT, model TEXT,
      queued INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`)
    raw
      .prepare(
        `INSERT INTO tasks (id, title, body, status, queued, created_at, updated_at)
         VALUES ('legacy', 't', 'b', 'executing', 0, '2026-01-01', '2026-01-01')`,
      )
      .run()
    raw.close()

    const db = new Db(dbPath)
    expect(db.getTask('legacy')?.stale).toBe(false)
  })
})

describe('settings (durable per-user prefs)', () => {
  it('returns undefined for an unset key', () => {
    const db = new Db(dbPath)
    expect(db.getSetting('some_pref')).toBeUndefined()
    db.close()
  })

  it('round-trips a value, trimming whitespace', () => {
    const db = new Db(dbPath)
    db.setSetting('some_pref', '  wss://vps.example  ', '2026-09-07T00:00:00.000Z')
    expect(db.getSetting('some_pref')).toBe('wss://vps.example')
    db.close()
  })

  it('upserts (last write wins) rather than duplicating the key', () => {
    const db = new Db(dbPath)
    db.setSetting('team_handle', 'Ada', '2026-09-07T00:00:00.000Z')
    db.setSetting('team_handle', 'Grace', '2026-09-07T00:00:01.000Z')
    expect(db.getSetting('team_handle')).toBe('Grace')
    db.close()
  })

  it('a blank/whitespace value clears the key (reads back as undefined)', () => {
    const db = new Db(dbPath)
    db.setSetting('some_pref', 'wss://vps.example', '2026-09-07T00:00:00.000Z')
    db.setSetting('some_pref', '   ', '2026-09-07T00:00:01.000Z')
    expect(db.getSetting('some_pref')).toBeUndefined()
    db.close()
  })

  it('survives a reopen of the same DB file (persistent, like the sidecar data dir)', () => {
    const db = new Db(dbPath)
    db.setSetting('some_pref', 'wss://vps.example', '2026-09-07T00:00:00.000Z')
    db.close()
    const reopened = new Db(dbPath)
    expect(reopened.getSetting('some_pref')).toBe('wss://vps.example')
    reopened.close()
  })
})

describe('addUsage', () => {
  const mk = (): Db => {
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'x',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-07-27T00:00:00.000Z',
    })
    return db
  }
  const delta: TaskUsage = {
    tokensIn: 100,
    tokensOut: 20,
    tokensCache: 5,
    costUsd: 0.01,
    turns: 1,
  }

  it('accumulates across successive result events (col = col + delta)', () => {
    const db = mk()
    db.addUsage('t1', delta, '2026-07-27T00:00:01.000Z')
    const after = db.addUsage('t1', delta, '2026-07-27T00:00:02.000Z')
    expect(after?.usage).toEqual({
      tokensIn: 200,
      tokensOut: 40,
      tokensCache: 10,
      costUsd: 0.02,
      turns: 2,
    })
  })

  it('does not lose counts under many rapid increments (accumulator, not overwrite)', () => {
    const db = mk()
    for (let i = 0; i < 50; i++) db.addUsage('t1', delta, '2026-07-27T00:00:03.000Z')
    expect(db.getTask('t1')?.usage.tokensIn).toBe(5000)
    expect(db.getTask('t1')?.usage.turns).toBe(50)
  })
})

// =====================================================================
// auth (username/password login gating KB + Team) — users / sessions /
// kb_changelog, plus the additive user_id columns on members and
// page_revisions. See .agents/plans/zmrng-login-auth.md.
// =====================================================================

/** Table names present in the DB file at `p`. */
function tableNames(p: string): Set<string> {
  const raw = new Database(p)
  const names = new Set(
    (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((t) => t.name),
  )
  raw.close()
  return names
}

/** Column names of one table in the DB file at `p`. */
function tableColumns(p: string, table: string): Set<string> {
  const raw = new Database(p)
  const cols = new Set(
    (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  )
  raw.close()
  return cols
}

/**
 * Every row of one table, serialized to JSON in rowid order. Used as a
 * before/after snapshot for the data-loss guard: the additive migration must
 * leave pre-existing rows byte-identical.
 */
function snapshotRows(p: string, table: string): string {
  const raw = new Database(p)
  const rows = raw.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all()
  raw.close()
  return JSON.stringify(rows)
}

/**
 * Hand-build a PRE-AUTH `zmrng.db` — the shape a live VPS/desktop instance has
 * before this feature lands: the old tasks/members/pages/page_revisions/messages
 * tables, populated, with NO users/sessions/kb_changelog and NO user_id columns.
 * `channels`/`spaces` are deliberately left for `SCHEMA` to create so the
 * constructor's idempotent seeds behave exactly as they do in production.
 */
function buildPreAuthDb(p: string): void {
  const raw = new Database(p)
  raw.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      session_id TEXT, branch TEXT, worktree TEXT, pr_url TEXT, model TEXT,
      queued INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE pages (
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
    CREATE TABLE page_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  raw
    .prepare(
      `INSERT INTO tasks (id, title, body, status, queued, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run('legacy-1', 'old task', 'old body', 'done', 't0', 't1')
  raw
    .prepare('INSERT INTO members (display_name, created_at) VALUES (?, ?)')
    .run('Ada', 't0')
  raw
    .prepare(
      'INSERT INTO messages (channel_id, author, body, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(1, 'Ada', 'hello team', 'human', 't0')
  raw
    .prepare(
      `INSERT INTO pages (space_id, folder_id, title, body, author, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, null, 'Old page', 'old contents', 'Ada', 'Ada', 't0', 't1')
  raw
    .prepare(
      'INSERT INTO page_revisions (page_id, body, author, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(1, 'older contents', 'Ada', 't0')
  raw.close()
}

describe('ensureAuthSchema migration (pre-auth zmrng.db)', () => {
  it('adds users/sessions/kb_changelog and the members.user_id column', () => {
    buildPreAuthDb(dbPath)
    const before = tableNames(dbPath)
    expect(before.has('users')).toBe(false)
    expect(before.has('sessions')).toBe(false)
    expect(before.has('kb_changelog')).toBe(false)
    expect(tableColumns(dbPath, 'members').has('user_id')).toBe(false)

    new Db(dbPath).close() // constructor runs ensureAuthSchema()

    const after = tableNames(dbPath)
    expect(after.has('users')).toBe(true)
    expect(after.has('sessions')).toBe(true)
    expect(after.has('kb_changelog')).toBe(true)
    expect(tableColumns(dbPath, 'members').has('user_id')).toBe(true)
    // Deliberately NOT on page_revisions: a revision snapshots the page's PRIOR
    // body, whose author is the free-text `pages.updated_by` string with no user
    // id behind it, so the column could only ever be null — and the
    // additive-only rule means a column added today can never be removed.
    expect(tableColumns(dbPath, 'page_revisions').has('user_id')).toBe(false)
  })

  it('is idempotent: re-opening the migrated DB does not throw or duplicate anything', () => {
    buildPreAuthDb(dbPath)
    new Db(dbPath).close()
    const tablesAfter1 = [...tableNames(dbPath)].sort()
    const memberCols1 = [...tableColumns(dbPath, 'members')].sort()
    const revCols1 = [...tableColumns(dbPath, 'page_revisions')].sort()

    expect(() => new Db(dbPath).close()).not.toThrow()

    expect([...tableNames(dbPath)].sort()).toEqual(tablesAfter1)
    expect([...tableColumns(dbPath, 'members')].sort()).toEqual(memberCols1)
    expect([...tableColumns(dbPath, 'page_revisions')].sort()).toEqual(revCols1)
  })

  it('DATA-LOSS GUARD: pre-existing task/page/member/message rows are byte-identical afterwards', () => {
    // CLAUDE.md's ADDITIVE-ONLY rule: the VPS team workspace redeploys in place
    // over the same populated zmrng.db, so a migration that rewrote (or dropped)
    // a row is the ONE thing that could lose live data. Snapshot every
    // pre-existing row set as JSON, migrate, and demand an exact match.
    buildPreAuthDb(dbPath)
    const watched = ['tasks', 'members', 'messages', 'pages', 'page_revisions']
    const before = new Map(watched.map((t) => [t, snapshotRows(dbPath, t)]))

    new Db(dbPath).close()
    new Db(dbPath).close() // and again — a redeploy re-opens repeatedly

    for (const t of watched) {
      // The new nullable user_id column widens the row shape for members and
      // page_revisions, so compare only the pre-existing columns' values.
      const after = JSON.parse(snapshotRows(dbPath, t)) as Record<string, unknown>[]
      const original = JSON.parse(before.get(t)!) as Record<string, unknown>[]
      expect(after).toHaveLength(original.length)
      original.forEach((row, i) => {
        expect(after[i]).toMatchObject(row)
      })
    }
  })
})

describe('users (auth)', () => {
  const NOW = '2026-09-23T00:00:00.000Z'

  it('createUser round-trips through getUserByUsername and getUserById', () => {
    const db = new Db(dbPath)
    const created = db.createUser('zc', 'zc', 'scrypt$32768$8$1$salt$key', NOW)
    expect(created.id).toBeTypeOf('number')
    expect(created).toMatchObject({
      username: 'zc',
      displayName: 'zc',
      passwordHash: 'scrypt$32768$8$1$salt$key',
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(db.getUserByUsername('zc')).toEqual(created)
    expect(db.getUserById(created.id)).toEqual(created)
    db.close()
  })

  it('lookups miss cleanly for an unknown username or id (exact match on the stored string)', () => {
    const db = new Db(dbPath)
    db.createUser('zc', 'zc', 'hash', NOW)
    expect(db.getUserByUsername('nobody')).toBeUndefined()
    expect(db.getUserByUsername('ZC')).toBeUndefined() // exact match, not case-folded
    expect(db.getUserById(99999)).toBeUndefined()
    db.close()
  })

  it('rejects a duplicate username (UNIQUE constraint surfaces to the caller)', () => {
    const db = new Db(dbPath)
    db.createUser('zc', 'zc', 'hash', NOW)
    expect(() => db.createUser('zc', 'someone else', 'other-hash', NOW)).toThrow()
    db.close()
  })

  it('setUserPassword replaces the hash and bumps updatedAt, leaving createdAt/username alone', () => {
    const db = new Db(dbPath)
    const created = db.createUser('zc', 'zc', 'old-hash', NOW)
    const later = '2026-09-24T00:00:00.000Z'
    const updated = db.setUserPassword(created.id, 'new-hash', later)
    expect(updated?.passwordHash).toBe('new-hash')
    expect(updated?.updatedAt).toBe(later)
    expect(updated?.createdAt).toBe(NOW)
    expect(updated?.username).toBe('zc')
    expect(updated?.displayName).toBe('zc')
    expect(db.getUserByUsername('zc')?.passwordHash).toBe('new-hash')
    db.close()
  })

  it('setUserPassword returns undefined for an unknown user id', () => {
    const db = new Db(dbPath)
    expect(db.setUserPassword(99999, 'new-hash', NOW)).toBeUndefined()
    db.close()
  })

  it('persists users across a reopen', () => {
    const db = new Db(dbPath)
    db.createUser('zc', 'zc', 'hash', NOW)
    db.close()
    const reopened = new Db(dbPath)
    expect(reopened.getUserByUsername('zc')?.displayName).toBe('zc')
    reopened.close()
  })
})

describe('sessions (auth)', () => {
  const NOW = '2026-09-23T00:00:00.000Z'
  const EXPIRES = '2026-09-30T00:00:00.000Z'

  const mkUser = (db: Db): number => db.createUser('zc', 'zc', 'hash', NOW).id

  it('createSession round-trips through getSession(tokenHash)', () => {
    const db = new Db(dbPath)
    const userId = mkUser(db)
    const session = db.createSession(userId, 'token-hash-a', NOW, EXPIRES)
    expect(session.id).toBeTypeOf('number')
    expect(session).toMatchObject({
      userId,
      tokenHash: 'token-hash-a',
      createdAt: NOW,
      expiresAt: EXPIRES,
    })
    expect(db.getSession('token-hash-a')).toEqual(session)
    expect(db.getSession('unknown-hash')).toBeUndefined()
    db.close()
  })

  it('touchSession extends expiresAt in place (sliding renewal)', () => {
    const db = new Db(dbPath)
    const userId = mkUser(db)
    const session = db.createSession(userId, 'token-hash-a', NOW, EXPIRES)
    const extended = '2026-10-07T00:00:00.000Z'
    db.touchSession(session.id, extended)
    const after = db.getSession('token-hash-a')
    expect(after?.expiresAt).toBe(extended)
    expect(after?.id).toBe(session.id)
    expect(after?.createdAt).toBe(NOW) // creation time untouched
    db.close()
  })

  it('deleteSession makes the token unresolvable (logout)', () => {
    const db = new Db(dbPath)
    const userId = mkUser(db)
    db.createSession(userId, 'token-hash-a', NOW, EXPIRES)
    db.deleteSession('token-hash-a')
    expect(db.getSession('token-hash-a')).toBeUndefined()
    db.close()
  })

  it('deleteSession on an unknown token hash is a silent no-op', () => {
    const db = new Db(dbPath)
    const userId = mkUser(db)
    db.createSession(userId, 'live', NOW, EXPIRES)
    expect(() => db.deleteSession('never-existed')).not.toThrow()
    expect(db.getSession('live')).toBeDefined()
    db.close()
  })

  it('deleteExpiredSessions removes only rows at/behind `now` and returns the count', () => {
    const db = new Db(dbPath)
    const userId = mkUser(db)
    db.createSession(userId, 'stale-1', NOW, '2026-09-22T00:00:00.000Z') // behind
    db.createSession(userId, 'stale-2', NOW, '2026-09-23T00:00:00.000Z') // exactly at now
    db.createSession(userId, 'live', NOW, '2026-09-24T00:00:00.000Z') // ahead

    const removed = db.deleteExpiredSessions('2026-09-23T00:00:00.000Z')
    expect(removed).toBe(2)
    expect(db.getSession('stale-1')).toBeUndefined()
    expect(db.getSession('stale-2')).toBeUndefined()
    expect(db.getSession('live')).toBeDefined()
    expect(db.deleteExpiredSessions('2026-09-23T00:00:00.000Z')).toBe(0) // nothing left to sweep
    db.close()
  })

  it('rejects a duplicate token hash (UNIQUE) and persists sessions across a reopen', () => {
    const db = new Db(dbPath)
    const userId = mkUser(db)
    db.createSession(userId, 'token-hash-a', NOW, EXPIRES)
    expect(() => db.createSession(userId, 'token-hash-a', NOW, EXPIRES)).toThrow()
    db.close()
    const reopened = new Db(dbPath)
    expect(reopened.getSession('token-hash-a')?.userId).toBe(userId)
    reopened.close()
  })
})

describe('memberForUser (authenticated members)', () => {
  const NOW = '2026-09-23T00:00:00.000Z'

  it('returns the SAME member row on a second call for the same user (stable across reconnects)', () => {
    const db = new Db(dbPath)
    const user = db.createUser('zc', 'zc', 'hash', NOW)
    const first = db.memberForUser({ id: user.id, displayName: user.displayName }, NOW)
    const again = db.memberForUser(
      { id: user.id, displayName: user.displayName },
      '2026-09-23T01:00:00.000Z',
    )
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt) // original creation time preserved
    expect(again.userId).toBe(user.id)
    expect(db.listMembers()).toHaveLength(1)
    db.close()
  })

  it('creates distinct member rows for distinct users, even with the same display name', () => {
    const db = new Db(dbPath)
    const a = db.createUser('ada', 'Ada', 'hash', NOW)
    const b = db.createUser('ada2', 'Ada', 'hash', NOW)
    const ma = db.memberForUser({ id: a.id, displayName: a.displayName }, NOW)
    const mb = db.memberForUser({ id: b.id, displayName: b.displayName }, NOW)
    expect(mb.id).not.toBe(ma.id)
    expect(ma.userId).toBe(a.id)
    expect(mb.userId).toBe(b.id)
    expect(db.listMembers()).toHaveLength(2)
    db.close()
  })

  it('does NOT adopt a legacy handle-only member row with the same display name', () => {
    // PINNED BEHAVIOUR: legacy rows (user_id IS NULL) were self-asserted handles
    // with no verification — claiming one would hand an authenticated user
    // someone else's history. A new row is created instead.
    const db = new Db(dbPath)
    const legacy = db.upsertMember('Ada', '2026-09-01T00:00:00.000Z')
    expect(legacy.userId).toBeNull()
    const user = db.createUser('ada', 'Ada', 'hash', NOW)

    const linked = db.memberForUser({ id: user.id, displayName: user.displayName }, NOW)
    expect(linked.id).not.toBe(legacy.id)
    expect(linked.userId).toBe(user.id)
    expect(db.listMembers()).toHaveLength(2)
    expect(db.listMembers().find((m) => m.id === legacy.id)?.userId).toBeNull()
    db.close()
  })

  it('persists the member↔user link across a reopen', () => {
    const db = new Db(dbPath)
    const user = db.createUser('zc', 'zc', 'hash', NOW)
    const member = db.memberForUser({ id: user.id, displayName: user.displayName }, NOW)
    db.close()
    const reopened = new Db(dbPath)
    const again = reopened.memberForUser({ id: user.id, displayName: user.displayName }, NOW)
    expect(again.id).toBe(member.id)
    reopened.close()
  })
})

describe('kb_changelog (auth: per-edit changelog)', () => {
  const NOW = '2026-09-23T00:00:00.000Z'
  const ACTIONS: KbChangeAction[] = [
    'page.create',
    'page.rename',
    'page.move',
    'page.edit',
    'page.delete',
  ]

  it('addChangelogEntry round-trips every action', () => {
    const db = new Db(dbPath)
    ACTIONS.forEach((action, i) => {
      const entry = db.addChangelogEntry({
        spaceId: 1,
        pageId: 7,
        userId: 3,
        username: 'zc',
        action,
        detail: `detail ${i}`,
        now: NOW,
      })
      expect(entry.id).toBeTypeOf('number')
      expect(entry).toMatchObject({
        spaceId: 1,
        pageId: 7,
        userId: 3,
        username: 'zc',
        action,
        detail: `detail ${i}`,
        createdAt: NOW,
      })
    })
    expect(db.listChangelog(1, 50).map((e) => e.action).sort()).toEqual([...ACTIONS].sort())
    db.close()
  })

  it('keeps a null pageId/userId (a deleted page or a removed user leaves the entry readable)', () => {
    const db = new Db(dbPath)
    const entry = db.addChangelogEntry({
      spaceId: 1,
      pageId: null,
      userId: null,
      username: 'zc',
      action: 'page.delete',
      detail: 'Gone page',
      now: NOW,
    })
    expect(entry.pageId).toBeNull()
    expect(entry.userId).toBeNull()
    expect(db.listChangelog(1, 10)[0]).toEqual(entry)
    db.close()
  })

  it('listChangelog returns NEWEST FIRST and respects the limit', () => {
    const db = new Db(dbPath)
    for (let i = 0; i < 5; i++) {
      db.addChangelogEntry({
        spaceId: 1,
        pageId: i,
        userId: 1,
        username: 'zc',
        action: 'page.edit',
        detail: `entry-${i}`,
        now: `2026-09-23T00:0${i}:00.000Z`,
      })
    }
    expect(db.listChangelog(1, 50).map((e) => e.detail)).toEqual([
      'entry-4',
      'entry-3',
      'entry-2',
      'entry-1',
      'entry-0',
    ])
    expect(db.listChangelog(1, 2).map((e) => e.detail)).toEqual(['entry-4', 'entry-3'])
    db.close()
  })

  it('is scoped to one space — another space never leaks in', () => {
    const db = new Db(dbPath)
    db.addChangelogEntry({
      spaceId: 1,
      pageId: 1,
      userId: 1,
      username: 'zc',
      action: 'page.create',
      detail: 'in space 1',
      now: NOW,
    })
    db.addChangelogEntry({
      spaceId: 2,
      pageId: 2,
      userId: 1,
      username: 'zc',
      action: 'page.create',
      detail: 'in space 2',
      now: NOW,
    })
    expect(db.listChangelog(1, 50).map((e) => e.detail)).toEqual(['in space 1'])
    expect(db.listChangelog(2, 50).map((e) => e.detail)).toEqual(['in space 2'])
    expect(db.listChangelog(3, 50)).toEqual([])
    db.close()
  })

  it('persists entries across a reopen', () => {
    const db = new Db(dbPath)
    db.addChangelogEntry({
      spaceId: 1,
      pageId: 1,
      userId: 1,
      username: 'zc',
      action: 'page.create',
      detail: 'Page',
      now: NOW,
    })
    db.close()
    const reopened = new Db(dbPath)
    expect(reopened.listChangelog(1, 10)).toHaveLength(1)
    reopened.close()
  })
})

describe('updatePageBody changelog attribution (throttled page.edit)', () => {
  const mkPage = (db: Db): { pageId: number; spaceId: number } => {
    const space = db.listSpaces()[0]
    const page = db.createPage(space.id, null, 'Notes', 'zc', '2026-09-23T00:00:00.000Z')
    return { pageId: page.id, spaceId: space.id }
  }
  const actor = { userId: 4, username: 'zc' }

  it('writes exactly ONE page.edit entry for a burst of rapid saves (throttled)', () => {
    const db = new Db(dbPath)
    const { pageId, spaceId } = mkPage(db)
    db.updatePageBody(pageId, 'v1', 'zc', '2026-09-23T00:01:00.000Z', actor)
    db.updatePageBody(pageId, 'v2', 'zc', '2026-09-23T00:01:05.000Z', actor)
    db.updatePageBody(pageId, 'v3', 'zc', '2026-09-23T00:01:20.000Z', actor)
    const entries = db.listChangelog(spaceId, 50)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      spaceId,
      pageId,
      userId: 4,
      username: 'zc',
      action: 'page.edit',
      detail: 'Notes', // the page's title
      createdAt: '2026-09-23T00:01:00.000Z',
    })
    expect(db.getPage(pageId)?.body).toBe('v3') // every save still lands
    db.close()
  })

  it('writes another entry once the throttle window has passed', () => {
    const db = new Db(dbPath)
    const { pageId, spaceId } = mkPage(db)
    db.updatePageBody(pageId, 'v1', 'zc', '2026-09-23T00:01:00.000Z', actor)
    db.updatePageBody(pageId, 'v2', 'zc', '2026-09-23T00:01:29.000Z', actor) // inside 30s
    expect(db.listChangelog(spaceId, 50)).toHaveLength(1)
    db.updatePageBody(pageId, 'v3', 'zc', '2026-09-23T00:01:30.000Z', actor) // exactly 30s on
    expect(db.listChangelog(spaceId, 50)).toHaveLength(2)
    db.close()
  })

  it('throttles per page — a different page gets its own first entry immediately', () => {
    const db = new Db(dbPath)
    const space = db.listSpaces()[0]
    const a = db.createPage(space.id, null, 'A', 'zc', '2026-09-23T00:00:00.000Z')
    const b = db.createPage(space.id, null, 'B', 'zc', '2026-09-23T00:00:00.000Z')
    db.updatePageBody(a.id, 'v1', 'zc', '2026-09-23T00:01:00.000Z', actor)
    db.updatePageBody(b.id, 'v1', 'zc', '2026-09-23T00:01:01.000Z', actor)
    expect(db.listChangelog(space.id, 50).map((e) => e.detail)).toEqual(['B', 'A'])
    db.close()
  })

  it('WITHOUT an actor: no changelog entry, and the 30s revision throttle is unchanged', () => {
    const db = new Db(dbPath)
    const { pageId, spaceId } = mkPage(db)
    db.updatePageBody(pageId, 'v1', 'zc', '2026-09-23T00:01:00.000Z')
    expect(db.listPageRevisions(pageId)).toHaveLength(1) // first save always snapshots
    db.updatePageBody(pageId, 'v2', 'zc', '2026-09-23T00:01:05.000Z') // inside the window
    expect(db.listPageRevisions(pageId)).toHaveLength(1)
    db.updatePageBody(pageId, 'v3', 'zc', '2026-09-23T00:01:31.000Z') // past the window
    expect(db.listPageRevisions(pageId)).toHaveLength(2)
    expect(db.listChangelog(spaceId, 50)).toEqual([]) // no attribution without an actor
    db.close()
  })

  it('with an actor the revision throttle still behaves exactly as before', () => {
    const db = new Db(dbPath)
    const { pageId } = mkPage(db)
    db.updatePageBody(pageId, 'v1', 'zc', '2026-09-23T00:01:00.000Z', actor)
    expect(db.listPageRevisions(pageId)).toHaveLength(1)
    db.updatePageBody(pageId, 'v2', 'zc', '2026-09-23T00:01:05.000Z', actor)
    expect(db.listPageRevisions(pageId)).toHaveLength(1)
    db.updatePageBody(pageId, 'v3', 'zc', '2026-09-23T00:01:31.000Z', actor)
    expect(db.listPageRevisions(pageId)).toHaveLength(2)
    db.close()
  })

  it('an unknown page id logs nothing and still returns undefined', () => {
    const db = new Db(dbPath)
    expect(db.updatePageBody(99999, 'x', 'zc', '2026-09-23T00:01:00.000Z', actor)).toBeUndefined()
    expect(db.listChangelog(1, 50)).toEqual([])
    db.close()
  })
})

// =====================================================================
// gauntlet loop (Loop mode) — loop_runs / loop_tickets / loop_events.
// Additive-only tables (see .agents/plans/gauntlet-loop-tab.md, Persistence).
// =====================================================================

const LOOP_TABLES = ['loop_runs', 'loop_tickets', 'loop_events']

/** Index names present in the DB file at `p`. */
function indexNames(p: string): Set<string> {
  const raw = new Database(p)
  const names = new Set(
    (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string
      }[]
    ).map((t) => t.name),
  )
  raw.close()
  return names
}

const ZERO_USAGE: TaskUsage = { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 }

function mkRun(over: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'run-1',
    repoId: 'zmrng',
    epic: 42,
    title: 'Epic: ship the loop',
    status: 'draft',
    prevStatus: null,
    lanes: 1,
    integBranch: 'gauntlet/run-1/integ',
    integWorktree: '/tmp/repo/worktrees/loop-run-1-integ',
    priority: [],
    prUrl: null,
    note: null,
    usage: { ...ZERO_USAGE },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function mkTicket(over: Partial<LoopTicket> = {}): LoopTicket {
  return {
    runId: 'run-1',
    number: 7,
    title: 'Build the map',
    body: '## Bar\nBeat the reference.',
    url: 'https://github.com/o/r/issues/7',
    ghState: 'open',
    blockedBy: [],
    bar: 'Beat the reference.',
    state: 'todo',
    step: null,
    round: 0,
    lastGap: null,
    branch: null,
    worktree: null,
    foldSha: null,
    question: null,
    note: null,
    usage: { ...ZERO_USAGE },
    startedAt: null,
    stepStartedAt: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

/** Write a raw column value, bypassing the Db layer (to plant malformed JSON). */
function rawExec(p: string, sql: string, ...params: unknown[]): void {
  const raw = new Database(p)
  raw.prepare(sql).run(...params)
  raw.close()
}

describe('ensureLoopSchema migration (pre-loop zmrng.db)', () => {
  it('creates loop_runs/loop_tickets/loop_events + the events index on an OLD-schema DB', () => {
    buildPreAuthDb(dbPath)
    const before = tableNames(dbPath)
    for (const t of LOOP_TABLES) expect(before.has(t)).toBe(false)

    new Db(dbPath).close() // constructor runs ensureLoopSchema()

    const after = tableNames(dbPath)
    for (const t of LOOP_TABLES) expect(after.has(t)).toBe(true)
    expect(indexNames(dbPath).has('loop_events_run')).toBe(true)
    expect([...tableColumns(dbPath, 'loop_tickets')]).toEqual(
      expect.arrayContaining(['run_id', 'number', 'blocked_by', 'fold_sha', 'step_started_at']),
    )
  })

  it('is idempotent: re-opening the migrated DB does not throw or change the schema', () => {
    buildPreAuthDb(dbPath)
    new Db(dbPath).close()
    const tables1 = [...tableNames(dbPath)].sort()
    const cols1 = LOOP_TABLES.map((t) => [...tableColumns(dbPath, t)].sort())

    expect(() => new Db(dbPath).close()).not.toThrow()

    for (const t of LOOP_TABLES) expect(tables1).toContain(t)
    expect([...tableNames(dbPath)].sort()).toEqual(tables1)
    expect(LOOP_TABLES.map((t) => [...tableColumns(dbPath, t)].sort())).toEqual(cols1)
  })

  it('DATA-LOSS GUARD: pre-existing task/member/message/page rows are unchanged on an old-schema DB', () => {
    buildPreAuthDb(dbPath)
    const watched = ['tasks', 'members', 'messages', 'pages', 'page_revisions']
    const before = new Map(watched.map((t) => [t, snapshotRows(dbPath, t)]))

    new Db(dbPath).close()
    new Db(dbPath).close() // a redeploy re-opens repeatedly

    for (const t of watched) {
      const after = JSON.parse(snapshotRows(dbPath, t)) as Record<string, unknown>[]
      const original = JSON.parse(before.get(t)!) as Record<string, unknown>[]
      expect(after).toHaveLength(original.length)
      original.forEach((row, i) => expect(after[i]).toMatchObject(row))
    }
  })

  it('DATA-LOSS GUARD: on a current pre-loop DB every existing table keeps its exact rows AND columns', () => {
    // Build today's schema populated with real rows, then strip the loop tables
    // to simulate the DB a live instance has right before this feature lands.
    const db = new Db(dbPath)
    db.createTask({
      id: 't1',
      title: 'x',
      body: 'y',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      flow: 'plan',
      repoId: 'zmrng',
      now: '2026-09-30T00:00:00.000Z',
    })
    db.addUsage('t1', { tokensIn: 5, tokensOut: 6, tokensCache: 7, costUsd: 0.5, turns: 1 }, 'n1')
    db.insertEvent('t1', 'operator', { sub: 'assistant', text: 'hello' }, '2026-09-30T00:00:01.000Z')
    const general = db.listChannels()[0]!
    db.addMessage(general.id, 'Ada', 'hi team', 'human', '2026-09-30T00:00:02.000Z')
    db.close()
    rawExec(dbPath, 'DROP TABLE IF EXISTS loop_events')
    rawExec(dbPath, 'DROP TABLE IF EXISTS loop_tickets')
    rawExec(dbPath, 'DROP TABLE IF EXISTS loop_runs')

    const existing = [...tableNames(dbPath)].filter((t) => t !== 'sqlite_sequence')
    const rowsBefore = new Map(existing.map((t) => [t, snapshotRows(dbPath, t)]))
    const colsBefore = new Map(existing.map((t) => [t, [...tableColumns(dbPath, t)]]))

    new Db(dbPath).close()
    new Db(dbPath).close()

    for (const t of LOOP_TABLES) expect(tableNames(dbPath).has(t)).toBe(true)
    for (const t of existing) {
      expect(snapshotRows(dbPath, t)).toBe(rowsBefore.get(t))
      expect([...tableColumns(dbPath, t)]).toEqual(colsBefore.get(t))
    }
  })
})

describe('loop runs', () => {
  it('insertLoopRun + getLoopRun round-trips every field, including nulls and JSON columns', () => {
    const db = new Db(dbPath)
    const run = mkRun({
      status: 'stale',
      prevStatus: 'running',
      lanes: 3,
      priority: [12, 3, 9],
      prUrl: null,
      note: 'boot under a live run',
      integWorktree: null,
      usage: { tokensIn: 10, tokensOut: 2, tokensCache: 3, costUsd: 0.25, turns: 4 },
    })
    db.insertLoopRun(run)
    expect(db.getLoopRun('run-1')).toEqual(run)
    db.close()
  })

  it('getLoopRun misses cleanly for an unknown id', () => {
    const db = new Db(dbPath)
    expect(db.getLoopRun('nope')).toBeUndefined()
    db.close()
  })

  it('listLoopRuns puts non-archived runs first, each group newest createdAt first', () => {
    const db = new Db(dbPath)
    db.insertLoopRun(mkRun({ id: 'old', createdAt: '2026-10-01T00:00:01.000Z' }))
    db.insertLoopRun(
      mkRun({ id: 'arch-new', status: 'archived', createdAt: '2026-10-01T00:00:09.000Z' }),
    )
    db.insertLoopRun(mkRun({ id: 'new', status: 'running', createdAt: '2026-10-01T00:00:05.000Z' }))
    db.insertLoopRun(
      mkRun({ id: 'arch-old', status: 'archived', createdAt: '2026-10-01T00:00:00.000Z' }),
    )
    expect(db.listLoopRuns().map((r) => r.id)).toEqual(['new', 'old', 'arch-new', 'arch-old'])
    db.close()
  })

  it('updateLoopRun patches fields, sets updatedAt, and leaves id/createdAt/usage alone', () => {
    const db = new Db(dbPath)
    const usage = { tokensIn: 1, tokensOut: 1, tokensCache: 1, costUsd: 1, turns: 1 }
    db.insertLoopRun(mkRun({ note: 'was set', usage }))
    const updated = db.updateLoopRun(
      'run-1',
      { status: 'running', prevStatus: 'draft', lanes: 2, priority: [5, 4], note: null },
      '2026-10-01T01:00:00.000Z',
    )
    expect(updated).toMatchObject({
      id: 'run-1',
      status: 'running',
      prevStatus: 'draft',
      lanes: 2,
      priority: [5, 4],
      note: null,
      usage,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T01:00:00.000Z',
    })
    expect(db.getLoopRun('run-1')).toEqual(updated)
    db.close()
  })

  it('updateLoopRun treats an undefined field as "no change" and an empty patch as a touch', () => {
    const db = new Db(dbPath)
    db.insertLoopRun(mkRun({ note: 'keep me' }))
    const r = db.updateLoopRun('run-1', { note: undefined }, '2026-10-01T02:00:00.000Z')
    expect(r?.note).toBe('keep me')
    expect(r?.updatedAt).toBe('2026-10-01T02:00:00.000Z')
    expect(db.updateLoopRun('run-1', {}, '2026-10-01T03:00:00.000Z')?.updatedAt).toBe(
      '2026-10-01T03:00:00.000Z',
    )
    db.close()
  })

  it('updateLoopRun returns undefined for an unknown run', () => {
    const db = new Db(dbPath)
    expect(db.updateLoopRun('nope', { status: 'running' }, 'n')).toBeUndefined()
    db.close()
  })

  it('malformed priority/usage JSON reads back as the empty value instead of throwing', () => {
    const db = new Db(dbPath)
    db.insertLoopRun(mkRun({ id: 'a' }))
    db.insertLoopRun(mkRun({ id: 'b' }))
    db.insertLoopRun(mkRun({ id: 'c' }))
    db.close()
    rawExec(dbPath, "UPDATE loop_runs SET priority = 'not json', usage = '{bad' WHERE id = 'a'")
    rawExec(dbPath, `UPDATE loop_runs SET priority = '{"x":1}', usage = '[1,2]' WHERE id = 'b'`)
    rawExec(
      dbPath,
      `UPDATE loop_runs SET priority = '[3,"x",null,2.5,4]', usage = '{"tokensIn":9,"turns":"x"}' WHERE id = 'c'`,
    )

    const db2 = new Db(dbPath)
    expect(db2.getLoopRun('a')).toMatchObject({ priority: [], usage: ZERO_USAGE })
    expect(db2.getLoopRun('b')).toMatchObject({ priority: [], usage: ZERO_USAGE })
    expect(db2.getLoopRun('c')).toMatchObject({
      priority: [3, 4],
      usage: { ...ZERO_USAGE, tokensIn: 9 },
    })
    db2.close()
  })

  it('a run inserted with the column defaults (raw SQL) reads usage {} as zero usage', () => {
    const db = new Db(dbPath)
    db.close()
    rawExec(
      dbPath,
      `INSERT INTO loop_runs (id, repo_id, epic, title, status, integ_branch, created_at, updated_at)
       VALUES ('raw', 'zmrng', 1, 't', 'draft', 'gauntlet/raw/integ', 'c', 'u')`,
    )
    const db2 = new Db(dbPath)
    expect(db2.getLoopRun('raw')).toMatchObject({
      lanes: 1,
      priority: [],
      usage: ZERO_USAGE,
      prevStatus: null,
      integWorktree: null,
      prUrl: null,
      note: null,
    })
    db2.close()
  })

  it('persists runs across a reopen', () => {
    const db = new Db(dbPath)
    db.insertLoopRun(mkRun())
    db.close()
    expect(new Db(dbPath).getLoopRun('run-1')).toEqual(mkRun())
  })
})

describe('loop tickets', () => {
  it('upsertLoopTicket inserts, and getLoopTicket round-trips every field including nulls', () => {
    const db = new Db(dbPath)
    db.insertLoopRun(mkRun())
    const t = mkTicket({
      blockedBy: [3, 5],
      state: 'waiting',
      step: 'critic',
      round: 2,
      lastGap: 'spacing is off',
      branch: 'gauntlet/run-1/t7',
      worktree: '/tmp/repo/worktrees/loop-run-1-t7',
      foldSha: null,
      question: 'which bar?',
      bar: null,
      usage: { tokensIn: 3, tokensOut: 2, tokensCache: 1, costUsd: 0.1, turns: 1 },
      startedAt: '2026-10-01T00:00:01.000Z',
      stepStartedAt: '2026-10-01T00:00:02.000Z',
    })
    db.upsertLoopTicket(t)
    expect(db.getLoopTicket('run-1', 7)).toEqual(t)
    db.close()
  })

  it('upsertLoopTicket on an existing (run, number) updates every non-key column, never duplicating', () => {
    const db = new Db(dbPath)
    db.upsertLoopTicket(mkTicket())
    const next = mkTicket({
      title: 'Renamed',
      body: 'new body',
      ghState: 'closed',
      blockedBy: [1],
      state: 'done',
      step: 'fold',
      round: 3,
      foldSha: 'abc123',
      updatedAt: '2026-10-01T05:00:00.000Z',
    })
    db.upsertLoopTicket(next)
    expect(db.listLoopTickets('run-1')).toEqual([next])
    db.close()
  })

  it('getLoopTicket misses cleanly for an unknown run or number', () => {
    const db = new Db(dbPath)
    db.upsertLoopTicket(mkTicket())
    expect(db.getLoopTicket('run-1', 8)).toBeUndefined()
    expect(db.getLoopTicket('run-2', 7)).toBeUndefined()
    db.close()
  })

  it('listLoopTickets is ordered by number ascending and scoped to one run', () => {
    const db = new Db(dbPath)
    for (const n of [30, 4, 12]) db.upsertLoopTicket(mkTicket({ number: n }))
    db.upsertLoopTicket(mkTicket({ runId: 'other', number: 1 }))
    expect(db.listLoopTickets('run-1').map((t) => t.number)).toEqual([4, 12, 30])
    expect(db.listLoopTickets('other').map((t) => t.number)).toEqual([1])
    expect(db.listLoopTickets('none')).toEqual([])
    db.close()
  })

  it('updateLoopTicket patches fields, sets updatedAt, and leaves the keys and usage alone', () => {
    const db = new Db(dbPath)
    const usage = { tokensIn: 2, tokensOut: 2, tokensCache: 2, costUsd: 2, turns: 2 }
    db.upsertLoopTicket(mkTicket({ question: 'q?', usage }))
    const t = db.updateLoopTicket(
      'run-1',
      7,
      {
        state: 'executing',
        step: 'builder',
        round: 2,
        lastGap: 'contrast',
        blockedBy: [9, 8],
        question: null,
        stepStartedAt: '2026-10-01T00:30:00.000Z',
      },
      '2026-10-01T01:00:00.000Z',
    )
    expect(t).toMatchObject({
      runId: 'run-1',
      number: 7,
      state: 'executing',
      step: 'builder',
      round: 2,
      lastGap: 'contrast',
      blockedBy: [9, 8],
      question: null,
      usage,
      stepStartedAt: '2026-10-01T00:30:00.000Z',
      updatedAt: '2026-10-01T01:00:00.000Z',
    })
    expect(db.getLoopTicket('run-1', 7)).toEqual(t)
    db.close()
  })

  it('updateLoopTicket returns undefined for an unknown ticket', () => {
    const db = new Db(dbPath)
    expect(db.updateLoopTicket('run-1', 99, { state: 'done' }, 'n')).toBeUndefined()
    db.close()
  })

  it('malformed blocked_by/usage JSON reads back as the empty value', () => {
    const db = new Db(dbPath)
    db.upsertLoopTicket(mkTicket())
    db.close()
    rawExec(
      dbPath,
      "UPDATE loop_tickets SET blocked_by = 'nope', usage = 'null' WHERE run_id = 'run-1' AND number = 7",
    )
    const db2 = new Db(dbPath)
    expect(db2.getLoopTicket('run-1', 7)).toMatchObject({ blockedBy: [], usage: ZERO_USAGE })
    db2.close()
  })
})

describe('loop events', () => {
  it('insertLoopEvent returns the persisted event, and listLoopEvents round-trips it', () => {
    const db = new Db(dbPath)
    const e1 = db.insertLoopEvent(
      'run-1',
      null,
      'chat',
      { role: 'operator', text: 'go' },
      '2026-10-01T00:00:01.000Z',
    )
    const e2 = db.insertLoopEvent(
      'run-1',
      7,
      'status',
      { step: 'builder', from: 'todo', to: 'executing' },
      '2026-10-01T00:00:02.000Z',
    )
    expect(e1).toEqual({
      id: e1.id,
      runId: 'run-1',
      ticket: null,
      kind: 'chat',
      payload: { role: 'operator', text: 'go' },
      createdAt: '2026-10-01T00:00:01.000Z',
    })
    expect(e2.id).toBeGreaterThan(e1.id)
    expect(db.listLoopEvents('run-1')).toEqual([e1, e2])
    db.close()
  })

  it('returns the MOST RECENT `limit` events, oldest → newest, scoped to one run', () => {
    const db = new Db(dbPath)
    for (let i = 1; i <= 6; i++) db.insertLoopEvent('run-1', null, 'chat', { text: `m${i}` }, 'n')
    db.insertLoopEvent('run-2', null, 'chat', { text: 'other run' }, 'n')
    expect(db.listLoopEvents('run-1', { limit: 3 }).map((e) => e.payload.text)).toEqual([
      'm4',
      'm5',
      'm6',
    ])
    expect(db.listLoopEvents('run-2').map((e) => e.payload.text)).toEqual(['other run'])
    db.close()
  })

  it('filters by kind before applying the limit', () => {
    const db = new Db(dbPath)
    db.insertLoopEvent('run-1', null, 'chat', { text: 'c1' }, 'n')
    db.insertLoopEvent('run-1', 7, 'activity', { summary: 'a1' }, 'n')
    db.insertLoopEvent('run-1', null, 'chat', { text: 'c2' }, 'n')
    db.insertLoopEvent('run-1', 7, 'activity', { summary: 'a2' }, 'n')
    db.insertLoopEvent('run-1', null, 'chat', { text: 'c3' }, 'n')
    expect(
      db.listLoopEvents('run-1', { kind: 'chat', limit: 2 }).map((e) => e.payload.text),
    ).toEqual(['c2', 'c3'])
    expect(db.listLoopEvents('run-1', { kind: 'activity' }).map((e) => e.ticket)).toEqual([7, 7])
    db.close()
  })

  it('defaults the limit to 200 and clamps it to 1..1000', () => {
    const db = new Db(dbPath)
    const insertMany = (n: number): void => {
      for (let i = 0; i < n; i++) db.insertLoopEvent('run-1', null, 'activity', { summary: `${i}` }, 'n')
    }
    insertMany(1005)
    const dflt = db.listLoopEvents('run-1')
    expect(dflt).toHaveLength(200)
    expect(dflt[dflt.length - 1]?.payload.summary).toBe('1004')
    expect(db.listLoopEvents('run-1', { limit: 5000 })).toHaveLength(1000)
    expect(db.listLoopEvents('run-1', { limit: 0 })).toHaveLength(1)
    expect(db.listLoopEvents('run-1', { limit: -4 })).toHaveLength(1)
    expect(db.listLoopEvents('run-1', { limit: Number.NaN })).toHaveLength(200)
    db.close()
  })

  it('a malformed payload reads back as {} instead of throwing', () => {
    const db = new Db(dbPath)
    db.insertLoopEvent('run-1', null, 'chat', { text: 'x' }, 'n')
    db.insertLoopEvent('run-1', null, 'chat', { text: 'y' }, 'n')
    db.close()
    rawExec(dbPath, "UPDATE loop_events SET payload = '{oops' WHERE id = 1")
    rawExec(dbPath, "UPDATE loop_events SET payload = '[1]' WHERE id = 2")
    const db2 = new Db(dbPath)
    expect(db2.listLoopEvents('run-1').map((e) => e.payload)).toEqual([{}, {}])
    db2.close()
  })
})

describe('addLoopUsage', () => {
  const delta: TaskUsage = { tokensIn: 100, tokensOut: 20, tokensCache: 5, costUsd: 0.01, turns: 1 }

  it('adds to the run AND the ticket, leaving other tickets untouched', () => {
    const db = new Db(dbPath)
    db.insertLoopRun(mkRun())
    db.upsertLoopTicket(mkTicket({ number: 7 }))
    db.upsertLoopTicket(mkTicket({ number: 8 }))
    db.addLoopUsage('run-1', 7, delta, '2026-10-01T01:00:00.000Z')
    db.addLoopUsage('run-1', 7, delta, '2026-10-01T02:00:00.000Z')
    expect(db.getLoopRun('run-1')).toMatchObject({
      usage: { tokensIn: 200, tokensOut: 40, tokensCache: 10, costUsd: 0.02, turns: 2 },
      updatedAt: '2026-10-01T02:00:00.000Z',
    })
    expect(db.getLoopTicket('run-1', 7)).toMatchObject({
      usage: { tokensIn: 200, tokensOut: 40, tokensCache: 10, costUsd: 0.02, turns: 2 },
      updatedAt: '2026-10-01T02:00:00.000Z',
    })
    expect(db.getLoopTicket('run-1', 8)?.usage).toEqual(ZERO_USAGE)
    db.close()
  })

  it('with a null ticket only the run accumulates (orchestrator usage)', () => {
    const db = new Db(dbPath)
    db.insertLoopRun(mkRun())
    db.upsertLoopTicket(mkTicket())
    db.addLoopUsage('run-1', null, delta, 'n')
    expect(db.getLoopRun('run-1')?.usage.tokensIn).toBe(100)
    expect(db.getLoopTicket('run-1', 7)?.usage).toEqual(ZERO_USAGE)
    db.close()
  })

  it('does not lose counts under many rapid increments, and recovers from a malformed stored value', () => {
    const db = new Db(dbPath)
    db.insertLoopRun(mkRun())
    db.upsertLoopTicket(mkTicket())
    db.close()
    rawExec(dbPath, "UPDATE loop_runs SET usage = 'garbage' WHERE id = 'run-1'")
    const db2 = new Db(dbPath)
    for (let i = 0; i < 50; i++) db2.addLoopUsage('run-1', 7, delta, 'n')
    expect(db2.getLoopRun('run-1')?.usage).toMatchObject({ tokensIn: 5000, turns: 50 })
    expect(db2.getLoopTicket('run-1', 7)?.usage).toMatchObject({ tokensIn: 5000, turns: 50 })
    db2.close()
  })

  it('is a silent no-op for an unknown run or ticket', () => {
    const db = new Db(dbPath)
    expect(() => db.addLoopUsage('nope', 3, delta, 'n')).not.toThrow()
    expect(db.getLoopRun('nope')).toBeUndefined()
    db.close()
  })
})
