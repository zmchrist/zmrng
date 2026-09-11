import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { Db } from '../src/db.js'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zmrng-kb-'))
  dbPath = path.join(dir, 'zmrng.db')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Read the set of table names from a raw handle on the db file. */
function tables(p: string): Set<string> {
  const raw = new Database(p)
  const names = new Set(
    (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name),
  )
  raw.close()
  return names
}

/** Read the column names of a table from a raw handle on the db file. */
function columns(p: string, table: string): Set<string> {
  const raw = new Database(p)
  const cols = new Set(
    (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  )
  raw.close()
  return cols
}

const NOW = '2026-09-10T00:00:00.000Z'

describe('KB schema', () => {
  it('creates the spaces/folders/pages/blocks/revisions tables on construction', () => {
    const db = new Db(dbPath)
    const t = tables(dbPath)
    for (const name of ['spaces', 'folders', 'pages', 'blocks', 'revisions']) {
      expect(t.has(name)).toBe(true)
    }
    db.close()
  })

  it('spaces has the expected columns (id/name/repo_url/created_at/updated_at)', () => {
    const db = new Db(dbPath)
    const c = columns(dbPath, 'spaces')
    for (const col of ['id', 'name', 'repo_url', 'created_at', 'updated_at']) {
      expect(c.has(col)).toBe(true)
    }
    db.close()
  })

  it('blocks has ord/kind/body/meta/updated_by columns; revisions has block_id/body/kind/meta/author', () => {
    const db = new Db(dbPath)
    const b = columns(dbPath, 'blocks')
    for (const col of ['page_id', 'ord', 'kind', 'body', 'meta', 'updated_at', 'updated_by']) {
      expect(b.has(col)).toBe(true)
    }
    const r = columns(dbPath, 'revisions')
    for (const col of ['block_id', 'body', 'kind', 'meta', 'author', 'created_at']) {
      expect(r.has(col)).toBe(true)
    }
    db.close()
  })
})

describe('KB seed (spaces)', () => {
  it('seeds exactly {general, zmrng, pheme}, with general carrying a null repo_url', () => {
    const db = new Db(dbPath)
    const spaces = db.listSpaces()
    expect(spaces.map((s) => s.name)).toEqual(['general', 'zmrng', 'pheme'])
    const general = spaces.find((s) => s.name === 'general')!
    expect(general.repoUrl).toBeNull()
    expect(spaces.find((s) => s.name === 'zmrng')!.repoUrl).toBe(
      'https://github.com/zmchrist/zmrng',
    )
    expect(spaces.find((s) => s.name === 'pheme')!.repoUrl).toBe(
      'https://github.com/zmchrist/pheme',
    )
    db.close()
  })

  it('reopening a populated db is a no-op — no duplicate spaces, no rewritten rows', () => {
    const db1 = new Db(dbPath)
    const before = db1.listSpaces()
    // Write a page under general so we can prove existing rows are untouched.
    const general = before[0]
    const page = db1.createPage(general.id, null, 'Keep me', 'Ada', NOW)
    db1.close()

    const db2 = new Db(dbPath)
    const after = db2.listSpaces()
    expect(after).toHaveLength(3)
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id))
    expect(after.map((s) => s.name)).toEqual(['general', 'zmrng', 'pheme'])
    // Pre-existing page survives the reopen untouched.
    const reread = db2.getPage(page.id)
    expect(reread?.title).toBe('Keep me')
    db2.close()
  })
})

describe('KB folders + pages (nesting / placement)', () => {
  it('nests folders via parent_id self-reference (null = space root)', () => {
    const db = new Db(dbPath)
    const space = db.listSpaces()[0]
    const root = db.createFolder(space.id, null, 'Docs', NOW)
    const child = db.createFolder(space.id, root.id, 'Design', NOW)
    expect(root.parentId).toBeNull()
    expect(child.parentId).toBe(root.id)
    expect(db.listFolders(space.id).map((f) => f.name)).toEqual(['Docs', 'Design'])
    db.close()
  })

  it('renameFolder and moveFolder update in place', () => {
    const db = new Db(dbPath)
    const space = db.listSpaces()[0]
    const a = db.createFolder(space.id, null, 'A', NOW)
    const b = db.createFolder(space.id, null, 'B', NOW)
    expect(db.renameFolder(a.id, 'A2')?.name).toBe('A2')
    expect(db.moveFolder(a.id, b.id)?.parentId).toBe(b.id)
    db.close()
  })

  it('moveFolder rejects a cycle (self-parent or moving under a descendant) as a no-op', () => {
    const db = new Db(dbPath)
    const space = db.listSpaces()[0]
    const root = db.createFolder(space.id, null, 'Root', NOW)
    const child = db.createFolder(space.id, root.id, 'Child', NOW)
    const grandchild = db.createFolder(space.id, child.id, 'Grandchild', NOW)
    // self-parent rejected
    expect(db.moveFolder(root.id, root.id)?.parentId).toBeNull()
    // moving an ancestor under its own descendant is rejected (would vanish in spaceTree)
    expect(db.moveFolder(root.id, grandchild.id)?.parentId).toBeNull()
    expect(db.getFolder(root.id)?.parentId).toBeNull()
    // a legitimate move still works
    const other = db.createFolder(space.id, null, 'Other', NOW)
    expect(db.moveFolder(other.id, child.id)?.parentId).toBe(child.id)
    db.close()
  })

  it('places pages at the space root (folder_id null) or inside a folder', () => {
    const db = new Db(dbPath)
    const space = db.listSpaces()[0]
    const folder = db.createFolder(space.id, null, 'Docs', NOW)
    const rootPage = db.createPage(space.id, null, 'Root page', 'Ada', NOW)
    const nested = db.createPage(space.id, folder.id, 'Nested page', 'Ada', NOW)
    expect(rootPage.folderId).toBeNull()
    expect(nested.folderId).toBe(folder.id)
    expect(db.movePage(rootPage.id, folder.id, NOW)?.folderId).toBe(folder.id)
    db.close()
  })
})

describe('KB blocks (ordering + revision-on-update)', () => {
  const seedPage = (db: Db): number => {
    const space = db.listSpaces()[0]
    return db.createPage(space.id, null, 'Page', 'Ada', NOW).id
  }

  it('appends blocks in ord order and lists them sorted by ord', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    const b0 = db.createBlock({
      pageId,
      ord: null,
      kind: 'text',
      body: 'first',
      meta: null,
      updatedBy: 'Ada',
      now: NOW,
    })
    const b1 = db.createBlock({
      pageId,
      ord: null,
      kind: 'heading',
      body: 'second',
      meta: '{"level":1}',
      updatedBy: 'Ada',
      now: NOW,
    })
    expect(b0.ord).toBe(0)
    expect(b1.ord).toBe(1)
    expect(db.listBlocks(pageId).map((b) => b.body)).toEqual(['first', 'second'])
    // meta JSON round-trips as an opaque string.
    expect(db.listBlocks(pageId)[1].meta).toBe('{"level":1}')
    db.close()
  })

  it('reorderBlocks rewrites ord to match the given id order', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    const a = db.createBlock({ pageId, ord: null, kind: 'text', body: 'a', meta: null, updatedBy: 'Ada', now: NOW })
    const b = db.createBlock({ pageId, ord: null, kind: 'text', body: 'b', meta: null, updatedBy: 'Ada', now: NOW })
    const c = db.createBlock({ pageId, ord: null, kind: 'text', body: 'c', meta: null, updatedBy: 'Ada', now: NOW })
    const out = db.reorderBlocks(pageId, [c.id, a.id, b.id], NOW)
    expect(out.map((x) => x.body)).toEqual(['c', 'a', 'b'])
    expect(out.map((x) => x.ord)).toEqual([0, 1, 2])
    db.close()
  })

  it('updating a block writes a revision of the PRIOR state, then applies the new state', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    const block = db.createBlock({
      pageId,
      ord: null,
      kind: 'text',
      body: 'original',
      meta: null,
      updatedBy: 'Ada',
      now: NOW,
    })
    expect(db.listRevisions(block.id)).toHaveLength(0)

    const updated = db.updateBlock(block.id, { body: 'edited' }, 'Grace', '2026-09-10T01:00:00.000Z')
    expect(updated?.body).toBe('edited')
    expect(updated?.updatedBy).toBe('Grace')

    const revs = db.listRevisions(block.id)
    expect(revs).toHaveLength(1)
    // The revision captured the PRIOR state (body + its last editor).
    expect(revs[0].body).toBe('original')
    expect(revs[0].author).toBe('Ada')
    db.close()
  })

  it('restoreRevision applies a revision back onto the block and itself records a revision', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    const block = db.createBlock({
      pageId,
      ord: null,
      kind: 'text',
      body: 'v1',
      meta: null,
      updatedBy: 'Ada',
      now: NOW,
    })
    db.updateBlock(block.id, { body: 'v2' }, 'Ada', '2026-09-10T01:00:00.000Z') // rev of v1
    const revs = db.listRevisions(block.id)
    expect(revs).toHaveLength(1)

    const restored = db.restoreRevision(revs[0].id, 'Grace', '2026-09-10T02:00:00.000Z')
    expect(restored?.body).toBe('v1') // the revision's body applied back
    expect(restored?.updatedBy).toBe('Grace')

    // Restore itself recorded a revision (of the v2 state it replaced).
    const after = db.listRevisions(block.id)
    expect(after).toHaveLength(2)
    expect(after[1].body).toBe('v2')
    db.close()
  })

  it('deleteBlock removes the block and its revisions', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    const block = db.createBlock({ pageId, ord: null, kind: 'text', body: 'x', meta: null, updatedBy: 'Ada', now: NOW })
    db.updateBlock(block.id, { body: 'y' }, 'Ada', NOW)
    expect(db.listRevisions(block.id)).toHaveLength(1)
    db.deleteBlock(block.id)
    expect(db.getBlock(block.id)).toBeUndefined()
    expect(db.listRevisions(block.id)).toHaveLength(0)
    db.close()
  })
})

describe('KB spaceTree assembly', () => {
  it('assembles folders + pages into the correct FileTree-shaped hierarchy', () => {
    const db = new Db(dbPath)
    const space = db.listSpaces()[0]
    const docs = db.createFolder(space.id, null, 'Docs', NOW)
    const design = db.createFolder(space.id, docs.id, 'Design', NOW)
    db.createPage(space.id, null, 'README', 'Ada', NOW) // root page
    db.createPage(space.id, docs.id, 'Guide', 'Ada', NOW) // under Docs
    db.createPage(space.id, design.id, 'Spec', 'Ada', NOW) // under Docs/Design

    const tree = db.spaceTree(space.id)
    // Roots: Docs folder (dir) + README page (file).
    const docsNode = tree.find((n) => n.name === 'Docs')!
    expect(docsNode.type).toBe('dir')
    expect(docsNode.kind).toBe('folder')
    expect(docsNode.path).toBe(`folder/${docs.id}`)
    const readme = tree.find((n) => n.name === 'README')!
    expect(readme.type).toBe('file')
    expect(readme.kind).toBe('page')

    // Docs children: Design folder + Guide page.
    const childNames = (docsNode.children ?? []).map((c) => c.name).sort()
    expect(childNames).toEqual(['Design', 'Guide'])

    // Design contains Spec.
    const designNode = docsNode.children!.find((c) => c.name === 'Design')!
    expect(designNode.children!.map((c) => c.name)).toEqual(['Spec'])
    db.close()
  })
})

describe('KB additive-migration idempotency', () => {
  it('reopening a db with KB data adds no tables/columns and preserves rows', () => {
    const db1 = new Db(dbPath)
    const space = db1.listSpaces()[1] // zmrng
    const folder = db1.createFolder(space.id, null, 'Docs', NOW)
    const page = db1.createPage(space.id, folder.id, 'Guide', 'Ada', NOW)
    const block = db1.createBlock({ pageId: page.id, ord: null, kind: 'text', body: 'hello', meta: null, updatedBy: 'Ada', now: NOW })
    const tablesBefore = tables(dbPath)
    db1.close()

    const db2 = new Db(dbPath)
    // No table set change across reopen.
    expect([...tables(dbPath)].sort()).toEqual([...tablesBefore].sort())
    // Rows survive untouched.
    expect(db2.getSpace(space.id)?.name).toBe('zmrng')
    expect(db2.getFolder(folder.id)?.name).toBe('Docs')
    expect(db2.getPage(page.id)?.title).toBe('Guide')
    expect(db2.getBlock(block.id)?.body).toBe('hello')
    db2.close()
  })
})
