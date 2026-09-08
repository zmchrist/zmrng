import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { Db } from '../src/db.js'
import type { TaskUsage } from '../src/types.js'

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
    expect(db.getSetting('workspace_url')).toBeUndefined()
    db.close()
  })

  it('round-trips a value, trimming whitespace', () => {
    const db = new Db(dbPath)
    db.setSetting('workspace_url', '  wss://vps.example  ', '2026-09-07T00:00:00.000Z')
    expect(db.getSetting('workspace_url')).toBe('wss://vps.example')
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
    db.setSetting('workspace_url', 'wss://vps.example', '2026-09-07T00:00:00.000Z')
    db.setSetting('workspace_url', '   ', '2026-09-07T00:00:01.000Z')
    expect(db.getSetting('workspace_url')).toBeUndefined()
    db.close()
  })

  it('survives a reopen of the same DB file (persistent, like the sidecar data dir)', () => {
    const db = new Db(dbPath)
    db.setSetting('workspace_url', 'wss://vps.example', '2026-09-07T00:00:00.000Z')
    db.close()
    const reopened = new Db(dbPath)
    expect(reopened.getSetting('workspace_url')).toBe('wss://vps.example')
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
