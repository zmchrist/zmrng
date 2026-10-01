import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import type { FastifyInstance, HTTPMethods } from 'fastify'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { Db } from '../src/db.js'
import { AuthService } from '../src/auth.js'
import { registerAuth } from '../src/authRoutes.js'
import { registerKbRoutes } from '../src/kbRoutes.js'
import { hashPassword } from '../src/password.js'
import {
  DEFAULT_CHANGELOG_PAGE,
  MAX_CHANGELOG_PAGE,
  PROTECTED_SPACE_NAME,
} from '../src/types.js'
import type {
  KbChangeEntry,
  KbPage,
  LoginResponse,
  Space,
  WsWorkspaceServerMsg,
} from '../src/types.js'
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

describe('KB spaces (create / delete)', () => {
  it('createSpace inserts a name-only space (null repo_url) and lists it after the seeds', () => {
    const db = new Db(dbPath)
    const space = db.createSpace('Team Notes', NOW)
    expect(space.name).toBe('Team Notes')
    expect(space.repoUrl).toBeNull()
    expect(space.createdAt).toBe(NOW)
    // Appears in the list after the three seeded spaces.
    expect(db.listSpaces().map((s) => s.name)).toEqual([
      'general',
      'zmrng',
      'example-app',
      'Team Notes',
    ])
    // Round-trips back through getSpace.
    expect(db.getSpace(space.id)?.name).toBe('Team Notes')
    db.close()
  })

  it('deleteSpace cascade-removes the space and ALL its folders/pages/revisions', () => {
    const db = new Db(dbPath)
    const space = db.createSpace('Doomed', NOW)
    const folder = db.createFolder(space.id, null, 'Docs', NOW)
    const rootPage = db.createPage(space.id, null, 'Root', 'Ada', NOW, 'r')
    const nested = db.createPage(space.id, folder.id, 'Nested', 'Ada', NOW, 'n')
    // Record a revision on each page so we can prove revisions are cascaded too.
    db.updatePageBody(rootPage.id, 'r2', 'Ada', '2026-09-10T01:00:00.000Z')
    db.updatePageBody(nested.id, 'n2', 'Ada', '2026-09-10T01:00:00.000Z')
    expect(db.listPageRevisions(rootPage.id)).toHaveLength(1)

    db.deleteSpace(space.id)

    expect(db.getSpace(space.id)).toBeUndefined()
    expect(db.getFolder(folder.id)).toBeUndefined()
    expect(db.getPage(rootPage.id)).toBeUndefined()
    expect(db.getPage(nested.id)).toBeUndefined()
    expect(db.listPageRevisions(rootPage.id)).toHaveLength(0)
    expect(db.listPageRevisions(nested.id)).toHaveLength(0)
    db.close()
  })

  it('deleteSpace is scoped — a sibling space and its contents survive', () => {
    const db = new Db(dbPath)
    const doomed = db.createSpace('Doomed', NOW)
    const keep = db.createSpace('Keep', NOW)
    db.createPage(doomed.id, null, 'Gone', 'Ada', NOW)
    const keptPage = db.createPage(keep.id, null, 'Kept', 'Ada', NOW, 'keep')

    db.deleteSpace(doomed.id)

    expect(db.getSpace(doomed.id)).toBeUndefined()
    expect(db.getSpace(keep.id)?.name).toBe('Keep')
    expect(db.getPage(keptPage.id)?.body).toBe('keep')
    db.close()
  })

  it('the zmrng space is the detectable protected space (name === PROTECTED_SPACE_NAME)', () => {
    // The DELETE /api/spaces/:id route guard keys off the space name: it rejects
    // the deletion when `getSpace(id).name === PROTECTED_SPACE_NAME` with a 403.
    // This exercises that same signal at the Db layer (the repo has no HTTP-inject
    // harness, #91), matching the cross-space-integrity test convention above.
    const db = new Db(dbPath)
    const zmrng = db.listSpaces().find((s) => s.name === PROTECTED_SPACE_NAME)!
    expect(zmrng).toBeDefined()
    expect(zmrng.name).toBe(PROTECTED_SPACE_NAME)
    // A user-created space is NOT protected, so its name differs from the guard value.
    const other = db.createSpace('Team Notes', NOW)
    expect(other.name).not.toBe(PROTECTED_SPACE_NAME)
    // deleteSpace itself is unguarded (the route owns the guard): given a
    // non-protected id it removes the row.
    db.deleteSpace(other.id)
    expect(db.getSpace(other.id)).toBeUndefined()
    db.close()
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

// ===================================================================
// The KB REST surface, end to end over `app.inject()` (no port, no network).
//
// `index.ts` opens the real DB, spawns managers and top-level-`await`s at import
// time, so a test that imported it would boot a whole server — which is why the
// KB routes live in `kbRoutes.ts` as a plain function (the same seam, and for
// the same reason, as `registerAuth`). Registered onto a bare Fastify over the
// temp-file Db above, they can be driven exactly as a client would, which is
// what makes the feature's central security claim PROVABLE rather than merely
// readable: a client-supplied `author` is ignored, and every KB write is
// attributed to the authenticated session.
// ===================================================================
describe('KB REST routes (authenticated, driven with app.inject())', () => {
  const PASSWORD = 'correct horse battery'
  const DISPLAY_NAME = 'Zed Codeman'
  const USERNAME = 'zc'

  let db: Db
  let app: FastifyInstance
  /** Every `space.tree` convergence frame the routes fanned to the workspace room. */
  let frames: WsWorkspaceServerMsg[]
  let token: string

  beforeEach(async () => {
    db = new Db(dbPath)
    db.createUser(USERNAME, DISPLAY_NAME, hashPassword(PASSWORD), NOW)
    frames = []

    app = Fastify()
    registerAuth(app, { auth: new AuthService(db), secureCookies: false })
    registerKbRoutes(app, {
      db,
      broadcast: (frame) => {
        frames.push(frame)
      },
      log: app.log,
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    })
    token = (res.json() as LoginResponse).token
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  /** The session credential, as the cross-origin bearer transport sends it. */
  function as(): { authorization: string } {
    return { authorization: `Bearer ${token}` }
  }

  /** The `general` seed space — the scratch space for most of these tests. */
  function generalSpace(): Space {
    return db.listSpaces()[0]
  }

  /** Create a page through the REST route (as the operator's client does). */
  async function createPage(spaceId: number, title: string): Promise<KbPage> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/pages`,
      headers: as(),
      payload: { title },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as KbPage
  }

  /** A space's changelog as the feed endpoint serves it (newest first). */
  async function changelog(spaceId: number, query = ''): Promise<KbChangeEntry[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/spaces/${spaceId}/changelog${query}`,
      headers: as(),
    })
    expect(res.statusCode).toBe(200)
    return res.json() as KbChangeEntry[]
  }

  // -----------------------------------------------------------------
  // THE CENTRAL CLAIM of the whole login feature: identity is taken from the
  // session, never from the request body. A client that asserts an `author` is
  // simply ignored — which is the spoofing hole the self-asserted handle left
  // open, and the reason these routes are worth an integration test at all.
  // -----------------------------------------------------------------
  describe('attribution comes from the session, never from the client', () => {
    it('ignores a client-supplied `author` on page create', async () => {
      const space = generalSpace()
      const res = await app.inject({
        method: 'POST',
        url: `/api/spaces/${space.id}/pages`,
        headers: as(),
        payload: { title: 'Runbook', author: 'somebody else', updatedBy: 'somebody else' },
      })
      expect(res.statusCode).toBe(200)
      const page = res.json() as KbPage

      // The authenticated user's display name — NOT the body's `author`.
      expect(page.author).toBe(DISPLAY_NAME)
      expect(page.updatedBy).toBe(DISPLAY_NAME)
      expect(page.author).not.toBe('somebody else')

      // And that is what was persisted, not merely what was echoed back.
      const stored = db.getPage(page.id)
      expect(stored?.author).toBe(DISPLAY_NAME)
      expect(stored?.updatedBy).toBe(DISPLAY_NAME)

      // The changelog names the session user too, by username.
      const entries = await changelog(space.id)
      expect(entries[0].username).toBe(USERNAME)
      expect(entries[0].userId).toBe(db.getUserByUsername(USERNAME)?.id)
    })

    it('ignores a client-supplied `author` on revision restore', async () => {
      const space = generalSpace()
      const page = await createPage(space.id, 'Runbook')
      // Two saves so a restorable revision of the FIRST body exists.
      db.updatePageBody(page.id, 'v1', DISPLAY_NAME, NOW)
      const revision = db.listPageRevisions(page.id)[0]

      const res = await app.inject({
        method: 'POST',
        url: `/api/page-revisions/${revision.id}/restore`,
        headers: as(),
        payload: { author: 'somebody else' },
      })
      expect(res.statusCode).toBe(200)
      const restored = res.json() as KbPage

      // The restorer is the session user; the body's `author` is ignored.
      expect(restored.updatedBy).toBe(DISPLAY_NAME)
      expect(restored.updatedBy).not.toBe('somebody else')
      expect(db.getPage(page.id)?.updatedBy).toBe(DISPLAY_NAME)

      const entry = (await changelog(space.id))[0]
      expect(entry.action).toBe('page.edit')
      expect(entry.username).toBe(USERNAME)
      expect(entry.detail).toContain(`restored revision #${revision.id}`)
    })

    it('ignores a client-supplied `author` on rename, move and delete', async () => {
      const space = generalSpace()
      const page = await createPage(space.id, 'Runbook')
      const folder = db.createFolder(space.id, null, 'Ops', NOW)

      await app.inject({
        method: 'PATCH',
        url: `/api/pages/${page.id}`,
        headers: as(),
        payload: { title: 'Runbook v2', author: 'somebody else' },
      })
      await app.inject({
        method: 'PATCH',
        url: `/api/pages/${page.id}`,
        headers: as(),
        payload: { folderId: folder.id, author: 'somebody else' },
      })
      await app.inject({
        method: 'DELETE',
        url: `/api/pages/${page.id}`,
        headers: as(),
        payload: { author: 'somebody else' },
      })

      // Every entry the three writes produced names the session user.
      const entries = await changelog(space.id)
      expect(entries.length).toBeGreaterThanOrEqual(4)
      for (const entry of entries) {
        expect(entry.username).toBe(USERNAME)
        expect(entry.username).not.toBe('somebody else')
      }
    })

    it('does not require an `author` field at all, and 400s a blank title', async () => {
      const space = generalSpace()
      // No `author` anywhere in the body — the pre-auth shape is gone for good.
      const ok = await app.inject({
        method: 'POST',
        url: `/api/spaces/${space.id}/pages`,
        headers: as(),
        payload: { title: 'Authorless' },
      })
      expect(ok.statusCode).toBe(200)
      expect((ok.json() as KbPage).author).toBe(DISPLAY_NAME)

      for (const payload of [{}, { title: '   ' }, { title: 42 }, { title: '', author: 'x' }]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/spaces/${space.id}/pages`,
          headers: as(),
          payload,
        })
        expect(res.statusCode, JSON.stringify(payload)).toBe(400)
        expect((res.json() as { error: string }).error).toBe('title is required')
      }
    })
  })

  // -----------------------------------------------------------------
  // One changelog entry per lifecycle action — the gap `page_revisions` left
  // (it only ever sees body saves, and dies with its page).
  // -----------------------------------------------------------------
  describe('every action writes its changelog entry', () => {
    it('records page.create with the page title', async () => {
      const space = generalSpace()
      const page = await createPage(space.id, 'Runbook')
      const entries = await changelog(space.id)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        spaceId: space.id,
        pageId: page.id,
        action: 'page.create',
        detail: 'Runbook',
        username: USERNAME,
      })
    })

    it('records page.rename naming BOTH the old and the new title', async () => {
      const space = generalSpace()
      // Deliberately NON-overlapping titles: with `Runbook` → `Runbook v2` a
      // detail that dropped the old title would still satisfy `toContain`.
      const page = await createPage(space.id, 'Runbook')
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${page.id}`,
        headers: as(),
        payload: { title: 'Operations manual' },
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as KbPage).title).toBe('Operations manual')

      const entry = (await changelog(space.id))[0]
      expect(entry.action).toBe('page.rename')
      expect(entry.pageId).toBe(page.id)
      expect(entry.detail).toContain('Runbook')
      expect(entry.detail).toContain('Operations manual')
      // Old first, new second — the direction of the change is readable.
      expect(entry.detail.indexOf('Runbook')).toBeLessThan(
        entry.detail.indexOf('Operations manual'),
      )
    })

    it('records page.move and fans the space.tree convergence frame', async () => {
      const space = generalSpace()
      const page = await createPage(space.id, 'Runbook')
      const folder = db.createFolder(space.id, null, 'Ops', NOW)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${page.id}`,
        headers: as(),
        payload: { folderId: folder.id },
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as KbPage).folderId).toBe(folder.id)

      const entry = (await changelog(space.id))[0]
      expect(entry.action).toBe('page.move')
      expect(entry.detail).toContain('Ops')

      // The move still converges every client viewing the space (the broadcast
      // the extraction replaced with the injected `broadcast` dep).
      expect(frames).toContainEqual({ type: 'space.tree', spaceId: space.id })
    })

    it("records page.delete, and the entry OUTLIVES the page it describes", async () => {
      const space = generalSpace()
      const page = await createPage(space.id, 'Doomed')

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${page.id}`,
        headers: as(),
      })
      expect(res.statusCode).toBe(204)
      expect(db.getPage(page.id)).toBeUndefined()
      // Its revisions went with it — which is exactly why `page_revisions`
      // could never have served as the changelog.
      expect(db.listPageRevisions(page.id)).toHaveLength(0)

      const entries = await changelog(space.id)
      const deletion = entries[0]
      expect(deletion.action).toBe('page.delete')
      expect(deletion.detail).toBe('Doomed')
      // `pageId` is null precisely so the row can survive its page.
      expect(deletion.pageId).toBeNull()
      expect(deletion.username).toBe(USERNAME)
      // The create entry survives too, still pointing at the now-gone page.
      expect(entries.some((e) => e.action === 'page.create' && e.pageId === page.id)).toBe(true)
    })

    it('records page.create for a page promoted from a channel message', async () => {
      const space = generalSpace()
      const channel = db.createChannel('zmrng-dev', 'zmrng', NOW)
      const message = db.addMessage(channel.id, 'Ada', 'Investigate the retry bug', 'human', NOW)

      const res = await app.inject({
        method: 'POST',
        url: `/api/spaces/${space.id}/pages/from-message`,
        headers: as(),
        payload: { messageId: message.id },
      })
      expect(res.statusCode).toBe(200)
      const page = res.json() as KbPage
      // Deliberate carve-out: a promoted page keeps the MESSAGE author as its
      // provenance — but who performed the promotion is the session user, and
      // that is recorded in the changelog so nothing is lost.
      expect(page.author).toBe('Ada')
      const entry = (await changelog(space.id))[0]
      expect(entry.action).toBe('page.create')
      expect(entry.username).toBe(USERNAME)
      expect(entry.detail).toContain(`#${channel.name}`)
    })
  })

  // -----------------------------------------------------------------
  // The feed endpoint itself.
  // -----------------------------------------------------------------
  describe('GET /api/spaces/:id/changelog', () => {
    it('returns entries NEWEST FIRST', async () => {
      const space = generalSpace()
      const page = await createPage(space.id, 'Runbook')
      await app.inject({
        method: 'PATCH',
        url: `/api/pages/${page.id}`,
        headers: as(),
        payload: { title: 'Runbook v2' },
      })
      await app.inject({ method: 'DELETE', url: `/api/pages/${page.id}`, headers: as() })

      const entries = await changelog(space.id)
      expect(entries.map((e) => e.action)).toEqual(['page.delete', 'page.rename', 'page.create'])
      // Newest first = strictly descending id.
      expect(entries.map((e) => e.id)).toEqual([...entries.map((e) => e.id)].sort((a, b) => b - a))
    })

    it("is scoped to its space — another space's entries never leak in", async () => {
      const first = generalSpace()
      const second = db.listSpaces()[2] // example-app
      await createPage(first.id, 'First page')
      await createPage(second.id, 'Second page')

      const firstEntries = await changelog(first.id)
      expect(firstEntries).toHaveLength(1)
      expect(firstEntries[0].detail).toBe('First page')
      expect(firstEntries.every((e) => e.spaceId === first.id)).toBe(true)

      const secondEntries = await changelog(second.id)
      expect(secondEntries).toHaveLength(1)
      expect(secondEntries[0].detail).toBe('Second page')
    })

    it('clamps ?limit= to the hard cap and falls back to the default on junk', async () => {
      const space = generalSpace()
      for (let i = 0; i < MAX_CHANGELOG_PAGE + 5; i++) {
        db.addChangelogEntry({
          spaceId: space.id,
          pageId: null,
          userId: null,
          username: USERNAME,
          action: 'page.edit',
          detail: `entry ${i}`,
          now: NOW,
        })
      }
      expect(await changelog(space.id, '?limit=1')).toHaveLength(1)
      expect(await changelog(space.id, '?limit=100000')).toHaveLength(MAX_CHANGELOG_PAGE)
      for (const junk of ['?limit=abc', '?limit=-1', '?limit=0', '?limit=1.5', '']) {
        expect(await changelog(space.id, junk), junk).toHaveLength(DEFAULT_CHANGELOG_PAGE)
      }
    })

    it('404s an unknown space', async () => {
      for (const id of ['9999', '0', '-1', 'abc']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/spaces/${id}/changelog`,
          headers: as(),
        })
        expect(res.statusCode, id).toBe(404)
        expect((res.json() as { error: string }).error).toBe('space not found')
      }
    })
  })

  // -----------------------------------------------------------------
  // The whole surface sits behind the login gate — reads as well as writes.
  // -----------------------------------------------------------------
  describe('the login gate covers the whole KB surface', () => {
    /** One request per KB route, against real resources. */
    function kbRequests(): { method: HTTPMethods; url: string; payload?: unknown }[] {
      const space = generalSpace()
      const scratchSpace = db.createSpace(`scratch-${Date.now()}`, NOW)
      const folder = db.createFolder(space.id, null, `Folder-${Date.now()}`, NOW)
      const doomedFolder = db.createFolder(space.id, null, `Doomed-${Date.now()}`, NOW)
      const page = db.createPage(space.id, null, 'Page', DISPLAY_NAME, NOW)
      const doomedPage = db.createPage(space.id, null, 'Doomed', DISPLAY_NAME, NOW)
      db.updatePageBody(page.id, 'v1', DISPLAY_NAME, NOW)
      const revision = db.listPageRevisions(page.id)[0]
      const channel = db.createChannel(`chan-${Date.now()}`, null, NOW)
      const message = db.addMessage(channel.id, 'Ada', 'Promote me', 'human', NOW)

      return [
        { method: 'GET', url: '/api/spaces' },
        { method: 'POST', url: '/api/spaces', payload: { name: `Made-${Date.now()}` } },
        { method: 'DELETE', url: `/api/spaces/${scratchSpace.id}` },
        { method: 'GET', url: `/api/spaces/${space.id}/tree` },
        { method: 'GET', url: `/api/spaces/${space.id}/changelog` },
        { method: 'GET', url: `/api/pages/${page.id}` },
        { method: 'POST', url: `/api/spaces/${space.id}/folders`, payload: { name: 'New folder' } },
        { method: 'PATCH', url: `/api/folders/${folder.id}`, payload: { name: 'Renamed' } },
        { method: 'DELETE', url: `/api/folders/${doomedFolder.id}` },
        { method: 'POST', url: `/api/spaces/${space.id}/pages`, payload: { title: 'New page' } },
        {
          method: 'POST',
          url: `/api/spaces/${space.id}/pages/from-message`,
          payload: { messageId: message.id },
        },
        { method: 'PATCH', url: `/api/pages/${page.id}`, payload: { title: 'Renamed page' } },
        { method: 'DELETE', url: `/api/pages/${doomedPage.id}` },
        { method: 'GET', url: `/api/pages/${page.id}/revisions` },
        { method: 'POST', url: `/api/page-revisions/${revision.id}/restore`, payload: {} },
      ]
    }

    it('401s every KB route — read and write — with no credential', async () => {
      for (const r of kbRequests()) {
        const res = await app.inject({ method: r.method, url: r.url, payload: r.payload })
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401)
        expect((res.json() as { error: string }).error).toBe('authentication required')
      }
      // Nothing was created or destroyed behind the 401s.
      expect(db.listPages(generalSpace().id).some((p) => p.title === 'New page')).toBe(false)
      expect(db.listChangelog(generalSpace().id, 10)).toHaveLength(0)
    })

    it('answers every KB route 2xx with the session', async () => {
      for (const r of kbRequests()) {
        const res = await app.inject({
          method: r.method,
          url: r.url,
          headers: as(),
          payload: r.payload,
        })
        expect([200, 204], `${r.method} ${r.url} -> ${res.statusCode} ${res.body}`).toContain(
          res.statusCode,
        )
      }
    })

    it('401s a garbage or revoked token on a KB read', async () => {
      const space = generalSpace()
      for (const header of ['Bearer nonsense', `Bearer ${token}x`, 'Basic zc:hunter2']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/spaces/${space.id}/tree`,
          headers: { authorization: header },
        })
        expect(res.statusCode, header).toBe(401)
      }
      await app.inject({ method: 'POST', url: '/api/auth/logout', headers: as() })
      const after = await app.inject({
        method: 'GET',
        url: `/api/spaces/${space.id}/tree`,
        headers: as(),
      })
      expect(after.statusCode).toBe(401)
    })
  })
})
