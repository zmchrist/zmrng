import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { Db } from '../src/db.js'
import { resolvePageTitle, buildPageBody } from '../src/kbFromMessage.js'

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
  it('creates the spaces/folders/pages/page_revisions tables on construction', () => {
    const db = new Db(dbPath)
    const t = tables(dbPath)
    for (const name of ['spaces', 'folders', 'pages', 'page_revisions']) {
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

  it('pages has body/author/updated_by columns; page_revisions has page_id/body/author', () => {
    const db = new Db(dbPath)
    const p = columns(dbPath, 'pages')
    for (const col of ['space_id', 'folder_id', 'title', 'body', 'author', 'updated_by', 'created_at', 'updated_at']) {
      expect(p.has(col)).toBe(true)
    }
    const r = columns(dbPath, 'page_revisions')
    for (const col of ['page_id', 'body', 'author', 'created_at']) {
      expect(r.has(col)).toBe(true)
    }
    db.close()
  })
})

describe('KB seed (spaces)', () => {
  it('seeds exactly {general, zmrng, example-app}, with general carrying a null repo_url', () => {
    const db = new Db(dbPath)
    const spaces = db.listSpaces()
    expect(spaces.map((s) => s.name)).toEqual(['general', 'zmrng', 'example-app'])
    const general = spaces.find((s) => s.name === 'general')!
    expect(general.repoUrl).toBeNull()
    expect(spaces.find((s) => s.name === 'zmrng')!.repoUrl).toBe(
      'https://github.com/zmchrist/zmrng',
    )
    expect(spaces.find((s) => s.name === 'example-app')!.repoUrl).toBe(
      'https://github.com/example/example-app',
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
    expect(after.map((s) => s.name)).toEqual(['general', 'zmrng', 'example-app'])
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

  it('deleteFolder cascades to nested folders/pages/revisions but leaves siblings intact', () => {
    const db = new Db(dbPath)
    const space = db.listSpaces()[0]

    // Target subtree: A → B, with a page (+revision) in each.
    const a = db.createFolder(space.id, null, 'A', NOW)
    const b = db.createFolder(space.id, a.id, 'B', NOW)
    const pageA = db.createPage(space.id, a.id, 'Page A', 'Ada', NOW, 'a')
    const pageB = db.createPage(space.id, b.id, 'Page B', 'Ada', NOW, 'b')
    // updatePageBody records a revision of the prior state on each page.
    db.updatePageBody(pageA.id, 'a2', 'Ada', '2026-09-10T01:00:00.000Z')
    db.updatePageBody(pageB.id, 'b2', 'Ada', '2026-09-10T01:00:00.000Z')
    expect(db.listPageRevisions(pageA.id)).toHaveLength(1)
    expect(db.listPageRevisions(pageB.id)).toHaveLength(1)

    // Sibling subtree in the SAME space, NOT under A — must survive the cascade.
    const other = db.createFolder(space.id, null, 'Other', NOW)
    const otherPage = db.createPage(space.id, other.id, 'Other page', 'Ada', NOW, 'keep')
    db.updatePageBody(otherPage.id, 'keep2', 'Ada', '2026-09-10T01:00:00.000Z')

    db.deleteFolder(a.id)

    // Whole A subtree is gone: folders, pages, revisions.
    expect(db.getFolder(a.id)).toBeUndefined()
    expect(db.getFolder(b.id)).toBeUndefined()
    expect(db.getPage(pageA.id)).toBeUndefined()
    expect(db.getPage(pageB.id)).toBeUndefined()
    expect(db.listPageRevisions(pageA.id)).toHaveLength(0)
    expect(db.listPageRevisions(pageB.id)).toHaveLength(0)

    // Sibling subtree is untouched (cascade is scoped, not a space-wide wipe).
    expect(db.getFolder(other.id)?.name).toBe('Other')
    expect(db.getPage(otherPage.id)?.body).toBe('keep2')
    expect(db.listPageRevisions(otherPage.id)).toHaveLength(1)
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

describe('KB pages (single-field body + throttled revision-on-save)', () => {
  const seedPage = (db: Db): number => {
    const space = db.listSpaces()[0]
    return db.createPage(space.id, null, 'Page', 'Ada', NOW).id
  }

  it('creates a page with an empty body by default — ready to type into immediately', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    expect(db.getPage(pageId)?.body).toBe('')
    expect(db.getPage(pageId)?.updatedBy).toBe('Ada') // author seeds updatedBy
    db.close()
  })

  it('createPage accepts an initial body (used by the "Send to KB" promotion)', () => {
    const db = new Db(dbPath)
    const space = db.listSpaces()[0]
    const page = db.createPage(space.id, null, 'Page', 'Ada', NOW, 'hello world')
    expect(page.body).toBe('hello world')
    db.close()
  })

  it('updatePageBody replaces the body and updates updated_by/updated_at', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    const updated = db.updatePageBody(pageId, 'edited', 'Grace', '2026-09-10T01:00:00.000Z')
    expect(updated?.body).toBe('edited')
    expect(updated?.updatedBy).toBe('Grace')
    expect(updated?.updatedAt).toBe('2026-09-10T01:00:00.000Z')
    db.close()
  })

  it('the FIRST save after creation always snapshots a revision of the prior (empty) body', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    expect(db.listPageRevisions(pageId)).toHaveLength(0)
    db.updatePageBody(pageId, 'v1', 'Ada', '2026-09-10T00:00:01.000Z')
    const revs = db.listPageRevisions(pageId)
    expect(revs).toHaveLength(1)
    expect(revs[0].body).toBe('') // the PRIOR (empty) body
    expect(revs[0].author).toBe('Ada') // updated_by seeded at creation
    db.close()
  })

  it('throttles subsequent snapshots — a save within the throttle window records no new revision', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    db.updatePageBody(pageId, 'v1', 'Ada', '2026-09-10T00:00:00.000Z')
    expect(db.listPageRevisions(pageId)).toHaveLength(1)
    // 5s later — well inside the throttle window — no new snapshot.
    db.updatePageBody(pageId, 'v2', 'Ada', '2026-09-10T00:00:05.000Z')
    expect(db.listPageRevisions(pageId)).toHaveLength(1)
    expect(db.getPage(pageId)?.body).toBe('v2') // the body itself still updates every save
    db.close()
  })

  it('snapshots again once the throttle window has elapsed since the last revision', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    db.updatePageBody(pageId, 'v1', 'Ada', '2026-09-10T00:00:00.000Z')
    expect(db.listPageRevisions(pageId)).toHaveLength(1)
    // 31s later — past the 30s throttle window — snapshots the PRIOR body ('v1').
    db.updatePageBody(pageId, 'v2', 'Ada', '2026-09-10T00:00:31.000Z')
    const revs = db.listPageRevisions(pageId)
    expect(revs).toHaveLength(2)
    expect(revs[1].body).toBe('v1')
    db.close()
  })

  it('restorePageRevision applies a revision back onto the page and itself records a revision', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    db.updatePageBody(pageId, 'v1', 'Ada', '2026-09-10T00:00:00.000Z')
    db.updatePageBody(pageId, 'v2', 'Ada', '2026-09-10T01:00:00.000Z') // past throttle → new revision of v1
    const revs = db.listPageRevisions(pageId)
    expect(revs).toHaveLength(2)
    const v1Revision = revs.find((r) => r.body === 'v1')!

    const restored = db.restorePageRevision(v1Revision.id, 'Grace', '2026-09-10T02:00:00.000Z')
    expect(restored?.body).toBe('v1')
    expect(restored?.updatedBy).toBe('Grace')

    // Restore itself ALWAYS records a revision (of the v2 state it replaced),
    // regardless of the throttle window — an explicit action gets its own undo point.
    const after = db.listPageRevisions(pageId)
    expect(after).toHaveLength(3)
    expect(after[2].body).toBe('v2')
    db.close()
  })

  it('restorePageRevision returns undefined for an unknown revision id', () => {
    const db = new Db(dbPath)
    expect(db.restorePageRevision(99999, 'Grace', NOW)).toBeUndefined()
    db.close()
  })

  it('updatePageBody returns undefined for an unknown page id', () => {
    const db = new Db(dbPath)
    expect(db.updatePageBody(99999, 'x', 'Ada', NOW)).toBeUndefined()
    db.close()
  })

  it('deletePage removes the page and its revisions', () => {
    const db = new Db(dbPath)
    const pageId = seedPage(db)
    db.updatePageBody(pageId, 'x', 'Ada', NOW)
    expect(db.listPageRevisions(pageId)).toHaveLength(1)
    db.deletePage(pageId)
    expect(db.getPage(pageId)).toBeUndefined()
    expect(db.listPageRevisions(pageId)).toHaveLength(0)
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

describe('KB cross-space parent integrity (#141)', () => {
  // The REST boundary rejects a parentId/folderId owned by another space with a
  // 400 by comparing the parent folder's spaceId to the target space. These tests
  // exercise that same invariant at the Db layer: getFolder(parent).spaceId is the
  // signal the route guard keys off, and a mismatch is what triggers the rejection.
  it('exposes each folder/page spaceId so a cross-space parent is detectable', () => {
    const db = new Db(dbPath)
    const [spaceA, spaceB] = db.listSpaces()
    const parentInB = db.createFolder(spaceB.id, null, 'B-Docs', NOW)

    // A parent folder created in space B carries B's spaceId, not A's.
    const parent = db.getFolder(parentInB.id)!
    expect(parent.spaceId).toBe(spaceB.id)
    expect(parent.spaceId).not.toBe(spaceA.id)
    db.close()
  })

  it('createFolder into space A pointed at a space-B parent yields a spaceId mismatch', () => {
    const db = new Db(dbPath)
    const [spaceA, spaceB] = db.listSpaces()
    const parentInB = db.createFolder(spaceB.id, null, 'B-Docs', NOW)

    // The route guard runs `db.getFolder(parentId).spaceId !== spaceId` before
    // creating — here that comparison is true, so the create would be a 400.
    const targetSpaceId = spaceA.id
    expect(db.getFolder(parentInB.id)?.spaceId).not.toBe(targetSpaceId)

    // A same-space parent passes the invariant.
    const parentInA = db.createFolder(spaceA.id, null, 'A-Docs', NOW)
    expect(db.getFolder(parentInA.id)?.spaceId).toBe(targetSpaceId)
    db.close()
  })

  it('moveFolder to a parent in another space is a detectable spaceId mismatch', () => {
    const db = new Db(dbPath)
    const [spaceA, spaceB] = db.listSpaces()
    const child = db.createFolder(spaceA.id, null, 'A-Child', NOW)
    const parentInB = db.createFolder(spaceB.id, null, 'B-Parent', NOW)

    // The PATCH /api/folders/:id move guard compares the new parent's spaceId to
    // the moved folder's own spaceId.
    expect(db.getFolder(parentInB.id)?.spaceId).not.toBe(db.getFolder(child.id)?.spaceId)

    const parentInA = db.createFolder(spaceA.id, null, 'A-Parent', NOW)
    expect(db.getFolder(parentInA.id)?.spaceId).toBe(db.getFolder(child.id)?.spaceId)
    db.close()
  })

  it('createPage/movePage into a folder owned by another space is a detectable mismatch', () => {
    const db = new Db(dbPath)
    const [spaceA, spaceB] = db.listSpaces()
    const folderInB = db.createFolder(spaceB.id, null, 'B-Folder', NOW)

    // POST /api/spaces/:id/pages compares db.getFolder(folderId).spaceId to spaceId.
    expect(db.getFolder(folderInB.id)?.spaceId).not.toBe(spaceA.id)

    // PATCH /api/pages/:id move compares to db.getPage(id).spaceId.
    const page = db.createPage(spaceA.id, null, 'A-Page', 'Ada', NOW)
    expect(db.getFolder(folderInB.id)?.spaceId).not.toBe(db.getPage(page.id)?.spaceId)

    const folderInA = db.createFolder(spaceA.id, null, 'A-Folder', NOW)
    expect(db.getFolder(folderInA.id)?.spaceId).toBe(db.getPage(page.id)?.spaceId)
    db.close()
  })
})

describe('KB additive-migration idempotency', () => {
  it('reopening a db with KB data adds no tables/columns and preserves rows', () => {
    const db1 = new Db(dbPath)
    const space = db1.listSpaces()[1] // zmrng
    const folder = db1.createFolder(space.id, null, 'Docs', NOW)
    const page = db1.createPage(space.id, folder.id, 'Guide', 'Ada', NOW, 'hello')
    const tablesBefore = tables(dbPath)
    db1.close()

    const db2 = new Db(dbPath)
    // No table set change across reopen.
    expect([...tables(dbPath)].sort()).toEqual([...tablesBefore].sort())
    // Rows survive untouched.
    expect(db2.getSpace(space.id)?.name).toBe('zmrng')
    expect(db2.getFolder(folder.id)?.name).toBe('Docs')
    expect(db2.getPage(page.id)?.title).toBe('Guide')
    expect(db2.getPage(page.id)?.body).toBe('hello')
    db2.close()
  })
})

describe('KB "Send to KB" composition (T4, #154)', () => {
  // Round-trips the exact db composition the POST /api/spaces/:id/pages/from-message
  // route performs (the repo has no HTTP-inject harness, #91): look up the source
  // message + its channel, derive a title, build the SERVER-SIDE provenance body,
  // then createPage with that body. The result must be an ordinary KB page.
  it('promotes a channel message into a normal page whose body carries the message + server provenance', () => {
    const db = new Db(dbPath)
    const channel = db.createChannel('zmrng-dev', 'zmrng', NOW)
    const message = db.addMessage(channel.id, 'Ada', 'Investigate the retry bug\nmore detail', 'human', NOW)
    const space = db.listSpaces()[1] // zmrng space

    // The route's composition, using the real db reads it relies on.
    const src = db.getMessage(message.id)!
    const srcChannel = db.getChannel(src.channelId)!
    const title = resolvePageTitle(undefined, src.body)
    const page = db.createPage(
      space.id,
      null,
      title,
      src.author,
      NOW,
      buildPageBody(src.body, srcChannel.name, src.id),
    )

    // Title derived from the message's first line.
    expect(page.title).toBe('Investigate the retry bug')
    expect(page.spaceId).toBe(space.id)
    expect(page.folderId).toBeNull()

    // The page body carries the message body + canonical provenance.
    expect(page.body).toBe(
      'Investigate the retry bug\nmore detail\n\n---\nFrom team channel #zmrng-dev (message #' +
        message.id +
        ')',
    )

    // It is a NORMAL page: it appears in the space's page list and its body reads back.
    expect(db.listPages(space.id).some((p) => p.id === page.id)).toBe(true)
    expect(db.getPage(page.id)?.body).toBe(page.body)
    db.close()
  })

  it('places the page in a given folder of the space', () => {
    const db = new Db(dbPath)
    const channel = db.createChannel('design', null, NOW)
    const message = db.addMessage(channel.id, 'Bo', 'Design notes', 'human', NOW)
    const space = db.listSpaces()[0]
    const folder = db.createFolder(space.id, null, 'Notes', NOW)

    const src = db.getMessage(message.id)!
    const page = db.createPage(space.id, folder.id, resolvePageTitle('Custom', src.body), src.author, NOW)
    expect(page.folderId).toBe(folder.id)
    expect(page.title).toBe('Custom') // explicit client title honored
    db.close()
  })
})
