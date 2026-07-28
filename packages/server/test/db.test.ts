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

  it('is idempotent across two runs (second open adds nothing and does not throw)', () => {
    new Db(dbPath)
    const after1 = columns(dbPath)
    expect(() => new Db(dbPath)).not.toThrow()
    const after2 = columns(dbPath)
    expect([...after2].sort()).toEqual([...after1].sort())
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
