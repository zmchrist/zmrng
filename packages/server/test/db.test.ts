import { mkdtempSync, rmSync } from 'node:fs'
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
