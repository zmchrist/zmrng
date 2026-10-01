import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { Db } from './db.js'
import { requireUser } from './authRoutes.js'
import { resolvePageTitle, buildPageBody } from './kbFromMessage.js'
import {
  DEFAULT_CHANGELOG_PAGE,
  MAX_CHANGELOG_PAGE,
  PROTECTED_SPACE_NAME,
} from './types.js'
import type {
  KbChangeEntry,
  KbFolder,
  KbPage,
  KbPageRevision,
  KbTreeNode,
  Space,
  WsWorkspaceServerMsg,
} from './types.js'

/** What `registerKbRoutes` needs from its host. */
export interface KbRouteDeps {
  db: Db
  /** Fan a frame to every socket in the 'workspace' room (the tree-convergence broadcast). */
  broadcast: (frame: WsWorkspaceServerMsg) => void
  log: FastifyBaseLogger
}

/**
 * Install the Knowledge Base REST surface onto `app`.
 *
 * Like `registerAuth`, this is a PLAIN FUNCTION and not a `fastify-plugin`
 * plugin, and for the same reason: an encapsulated plugin gets its own
 * child instance, so the parent's `onRequest` auth hook would not run for the
 * routes declared inside it, and the `authUser` decorator the hook sets would
 * not be the one these handlers read. EVERY route here — read and write alike —
 * is gated by that hook (`/api/spaces`, `/api/pages`, `/api/folders` and
 * `/api/page-revisions` are all in `PROTECTED_PREFIXES`), so none of them can be
 * reached without a session. The routes that additionally call
 * `requireUser(req, reply)` are the ones that need the IDENTITY, not merely the
 * gate: every page write, because it attributes the page and its changelog entry
 * to that user. Space and folder operations record no author, so they take the
 * gate and nothing more. Either way the routes must be declared on the SAME
 * instance the gate is installed on.
 *
 * It lives in its own module so the KB surface is INTEGRATION-testable:
 * `index.ts` opens the real database, spawns managers and top-level-`await`s at
 * import time, so a test that imported it would boot a whole server.
 * `registerKbRoutes` can instead be attached to a bare `Fastify()` (alongside
 * `registerAuth`) over a temp-file DB and driven with `app.inject()` — no port,
 * no network, so the repo's hermetic-test rule holds. That is what proves the
 * feature's central claim: a client-supplied `author` is ignored and every KB
 * write is attributed to the authenticated session.
 */
export function registerKbRoutes(app: FastifyInstance, deps: KbRouteDeps): void {
  const { db } = deps

  // ===================================================================
  // Knowledge Base (KB) — spaces / folders / pages (T1 #140, single-field editor)
  // Server-side data foundation. A page is ONE continuous plaintext/markdown
  // field — there is no block model. REST covers spaces/folders/pages CRUD +
  // page history; the live body autosave itself flows over the workspace
  // WebSocket's `page.edit`/`page.update` frames (see `PageManager.savePage`),
  // mirroring how channel messages are REST-scrollback + socket-live. Every
  // path/body param is validated (never trust the wire); an unknown
  // space/folder/page/revision id is a 404. Structured Pino logging only.
  // ===================================================================

  /** Parse a `:id`-style route param to a positive integer, or null if invalid. */
  function kbId(raw: unknown): number | null {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  /** Trimmed non-empty string, or undefined (rejects blanks / non-strings). */
  function kbName(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined
    const t = raw.trim()
    return t.length > 0 ? t : undefined
  }

  /**
   * Read a nullable folder/parent id from a request body. Returns `null` for an
   * explicit null / omitted value (= space root), a positive int when valid, or
   * `undefined` to signal "invalid" so the route can 400.
   */
  function kbNullableId(raw: unknown): number | null | undefined {
    if (raw === null || raw === undefined) return null
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : undefined
  }

  // All KB spaces (the three seeded POC spaces + any created later). Always 200.
  app.get('/api/spaces', (): Space[] => db.listSpaces())

  // Create a KB space (name only — user-created spaces are not repo-scoped).
  // 400 blank name; 409 duplicate name (the `spaces.name` column is UNIQUE, so we
  // reject the duplicate here rather than let the INSERT throw a 500).
  app.post('/api/spaces', (req, reply): Space | undefined => {
    const body = req.body as { name?: unknown } | undefined
    const name = kbName(body?.name)
    if (!name) {
      reply.code(400).send({ error: 'name is required' })
      return undefined
    }
    if (db.listSpaces().some((s) => s.name === name)) {
      reply.code(409).send({ error: 'a space with that name already exists' })
      return undefined
    }
    const space = db.createSpace(name, new Date().toISOString())
    deps.log.info({ spaceId: space.id }, 'kb space created')
    return space
  })

  // Delete a space and EVERYTHING inside it (folders, pages, page revisions).
  // 404 unknown space; 403 the protected `zmrng` space, which can never be deleted.
  app.delete('/api/spaces/:id', (req, reply) => {
    const id = kbId((req.params as { id: string }).id)
    const space = id !== null ? db.getSpace(id) : undefined
    if (!space) {
      return reply.code(404).send({ error: 'space not found' })
    }
    if (space.name === PROTECTED_SPACE_NAME) {
      return reply.code(403).send({ error: `the ${PROTECTED_SPACE_NAME} space cannot be deleted` })
    }
    db.deleteSpace(space.id)
    deps.log.info({ spaceId: space.id }, 'kb space deleted')
    return reply.code(204).send()
  })

  // A space's KB tree (folders + pages), FileTree-shaped. 404 on unknown space.
  app.get('/api/spaces/:id/tree', (req, reply): KbTreeNode[] | undefined => {
    const spaceId = kbId((req.params as { id: string }).id)
    if (spaceId === null || !db.getSpace(spaceId)) {
      reply.code(404).send({ error: 'space not found' })
      return undefined
    }
    return db.spaceTree(spaceId)
  })

  // One page (its whole body is the page — no separate blocks). 404 on unknown page.
  app.get('/api/pages/:id', (req, reply): KbPage | undefined => {
    const pageId = kbId((req.params as { id: string }).id)
    const page = pageId !== null ? db.getPage(pageId) : undefined
    if (!page) {
      reply.code(404).send({ error: 'page not found' })
      return undefined
    }
    return page
  })

  // Create a folder in a space. 404 unknown space; 400 blank name / bad parentId.
  app.post('/api/spaces/:id/folders', (req, reply): KbFolder | undefined => {
    const spaceId = kbId((req.params as { id: string }).id)
    if (spaceId === null || !db.getSpace(spaceId)) {
      reply.code(404).send({ error: 'space not found' })
      return undefined
    }
    const body = req.body as { name?: unknown; parentId?: unknown } | undefined
    const name = kbName(body?.name)
    if (!name) {
      reply.code(400).send({ error: 'name is required' })
      return undefined
    }
    const parentId = kbNullableId(body?.parentId)
    if (parentId === undefined) {
      reply.code(400).send({ error: 'invalid parentId' })
      return undefined
    }
    if (parentId !== null && !db.getFolder(parentId)) {
      reply.code(404).send({ error: 'parent folder not found' })
      return undefined
    }
    if (parentId !== null && db.getFolder(parentId)?.spaceId !== spaceId) {
      reply.code(400).send({ error: 'parent folder belongs to a different space' })
      return undefined
    }
    const folder = db.createFolder(spaceId, parentId, name, new Date().toISOString())
    deps.log.info({ folderId: folder.id, spaceId }, 'kb folder created')
    return folder
  })

  // Rename and/or move a folder. 404 unknown folder; 400 nothing-to-do / bad args.
  app.patch('/api/folders/:id', (req, reply): KbFolder | undefined => {
    const id = kbId((req.params as { id: string }).id)
    if (id === null || !db.getFolder(id)) {
      reply.code(404).send({ error: 'folder not found' })
      return undefined
    }
    const body = req.body as { name?: unknown; parentId?: unknown } | undefined
    let result: KbFolder | undefined = db.getFolder(id)
    if (body?.name !== undefined) {
      const name = kbName(body.name)
      if (!name) {
        reply.code(400).send({ error: 'invalid name' })
        return undefined
      }
      result = db.renameFolder(id, name)
    }
    if (body && 'parentId' in body) {
      const parentId = kbNullableId(body.parentId)
      if (parentId === undefined) {
        reply.code(400).send({ error: 'invalid parentId' })
        return undefined
      }
      if (parentId !== null && !db.getFolder(parentId)) {
        reply.code(404).send({ error: 'parent folder not found' })
        return undefined
      }
      if (parentId !== null && db.getFolder(parentId)?.spaceId !== db.getFolder(id)?.spaceId) {
        reply.code(400).send({ error: 'parent folder belongs to a different space' })
        return undefined
      }
      result = db.moveFolder(id, parentId)
      // Fan a tree-structure convergence frame only when the re-parent actually
      // took effect (moveFolder returns the folder unchanged on a rejected cycle),
      // so every client viewing this space refetches its tree without a reload.
      if (result && result.parentId === parentId) {
        deps.broadcast({ type: 'space.tree', spaceId: result.spaceId })
      }
    }
    deps.log.info({ folderId: id }, 'kb folder updated')
    return result
  })

  // Delete a folder. 404 on unknown folder.
  app.delete('/api/folders/:id', (req, reply) => {
    const id = kbId((req.params as { id: string }).id)
    if (id === null || !db.getFolder(id)) {
      return reply.code(404).send({ error: 'folder not found' })
    }
    db.deleteFolder(id)
    deps.log.info({ folderId: id }, 'kb folder deleted')
    return reply.code(204).send()
  })

  // Create a page in a space. 404 unknown space/folder; 400 blank title.
  // A fresh page starts with an empty body — the notepad-style single field is
  // ready to type into immediately, no separate "add content" step.
  // The author is the AUTHENTICATED user: a client-supplied `author` is ignored.
  app.post('/api/spaces/:id/pages', (req, reply): KbPage | undefined => {
    const user = requireUser(req, reply)
    if (!user) return undefined
    const spaceId = kbId((req.params as { id: string }).id)
    if (spaceId === null || !db.getSpace(spaceId)) {
      reply.code(404).send({ error: 'space not found' })
      return undefined
    }
    const body = req.body as { title?: unknown; folderId?: unknown } | undefined
    const title = kbName(body?.title)
    if (!title) {
      reply.code(400).send({ error: 'title is required' })
      return undefined
    }
    const folderId = kbNullableId(body?.folderId)
    if (folderId === undefined) {
      reply.code(400).send({ error: 'invalid folderId' })
      return undefined
    }
    if (folderId !== null && !db.getFolder(folderId)) {
      reply.code(404).send({ error: 'folder not found' })
      return undefined
    }
    if (folderId !== null && db.getFolder(folderId)?.spaceId !== spaceId) {
      reply.code(400).send({ error: 'folder belongs to a different space' })
      return undefined
    }
    const now = new Date().toISOString()
    const page = db.createPage(spaceId, folderId, title, user.displayName, now)
    db.addChangelogEntry({
      spaceId,
      pageId: page.id,
      userId: user.id,
      username: user.username,
      action: 'page.create',
      detail: title,
      now,
    })
    deps.log.info({ pageId: page.id, spaceId, username: user.username }, 'kb page created')
    return page
  })

  // Promote a team-channel message into a durable KB page (T4, #154). Looks up the
  // message + its channel server-side and creates a NORMAL page in space :id whose
  // body carries the message body + a canonical, SERVER-BUILT provenance line
  // (channel name + message id). Provenance is never trusted from the client.
  // 404 unknown space/message/folder; 400 blank/invalid ids or cross-space folder.
  app.post('/api/spaces/:id/pages/from-message', (req, reply): KbPage | undefined => {
    const user = requireUser(req, reply)
    if (!user) return undefined
    const spaceId = kbId((req.params as { id: string }).id)
    if (spaceId === null || !db.getSpace(spaceId)) {
      reply.code(404).send({ error: 'space not found' })
      return undefined
    }
    const body = req.body as
      | { messageId?: unknown; folderId?: unknown; title?: unknown }
      | undefined
    const messageId = kbId(body?.messageId)
    if (messageId === null) {
      reply.code(400).send({ error: 'messageId is required' })
      return undefined
    }
    const message = db.getMessage(messageId)
    if (!message) {
      reply.code(404).send({ error: 'message not found' })
      return undefined
    }
    const channel = db.getChannel(message.channelId)
    if (!channel) {
      reply.code(404).send({ error: 'channel not found' })
      return undefined
    }
    const folderId = kbNullableId(body?.folderId)
    if (folderId === undefined) {
      reply.code(400).send({ error: 'invalid folderId' })
      return undefined
    }
    if (folderId !== null && !db.getFolder(folderId)) {
      reply.code(404).send({ error: 'folder not found' })
      return undefined
    }
    if (folderId !== null && db.getFolder(folderId)?.spaceId !== spaceId) {
      reply.code(400).send({ error: 'folder belongs to a different space' })
      return undefined
    }
    // Title is an editable label (client value wins, else derived server-side).
    // The page author is the canonical message author.
    const title = resolvePageTitle(kbName(body?.title), message.body)
    const now = new Date().toISOString()
    const page = db.createPage(
      spaceId,
      folderId,
      title,
      message.author,
      now,
      buildPageBody(message.body, channel.name, message.id),
    )
    // Deliberate exception to "the author is the authenticated user": a promoted
    // page's `author` stays the canonical MESSAGE author, because that is the
    // page's provenance and the provenance line itself carries only the channel
    // and message id, not a name. Who performed the promotion is recorded in the
    // changelog instead, so nothing about the action is lost.
    db.addChangelogEntry({
      spaceId,
      pageId: page.id,
      userId: user.id,
      username: user.username,
      action: 'page.create',
      detail: `${title} (promoted from #${channel.name} message #${message.id})`,
      now,
    })
    deps.log.info(
      { pageId: page.id, spaceId, messageId, channelId: channel.id, username: user.username },
      'kb page created from message',
    )
    return page
  })

  // Rename and/or move a page. 404 unknown page; 400 bad args.
  app.patch('/api/pages/:id', (req, reply): KbPage | undefined => {
    const user = requireUser(req, reply)
    if (!user) return undefined
    const id = kbId((req.params as { id: string }).id)
    const before = id !== null ? db.getPage(id) : undefined
    if (id === null || !before) {
      reply.code(404).send({ error: 'page not found' })
      return undefined
    }
    const body = req.body as { title?: unknown; folderId?: unknown } | undefined
    const now = new Date().toISOString()
    let result: KbPage | undefined = before
    if (body?.title !== undefined) {
      const title = kbName(body.title)
      if (!title) {
        reply.code(400).send({ error: 'invalid title' })
        return undefined
      }
      result = db.updatePage(id, title, now)
      db.addChangelogEntry({
        spaceId: before.spaceId,
        pageId: id,
        userId: user.id,
        username: user.username,
        action: 'page.rename',
        detail: `${before.title} → ${title}`,
        now,
      })
    }
    if (body && 'folderId' in body) {
      const folderId = kbNullableId(body.folderId)
      if (folderId === undefined) {
        reply.code(400).send({ error: 'invalid folderId' })
        return undefined
      }
      if (folderId !== null && !db.getFolder(folderId)) {
        reply.code(404).send({ error: 'folder not found' })
        return undefined
      }
      if (folderId !== null && db.getFolder(folderId)?.spaceId !== db.getPage(id)?.spaceId) {
        reply.code(400).send({ error: 'folder belongs to a different space' })
        return undefined
      }
      result = db.movePage(id, folderId, now)
      if (result && result.folderId === folderId) {
        const target = folderId === null ? 'space root' : (db.getFolder(folderId)?.name ?? 'folder')
        db.addChangelogEntry({
          spaceId: before.spaceId,
          pageId: id,
          userId: user.id,
          username: user.username,
          action: 'page.move',
          detail: `${result.title} → ${target}`,
          now,
        })
      }
      // Fan a tree-structure convergence frame so every client viewing this space
      // refetches its tree without a reload (mirrors the folder-move fan-out).
      if (result && result.folderId === folderId) {
        deps.broadcast({ type: 'space.tree', spaceId: result.spaceId })
      }
    }
    deps.log.info({ pageId: id, username: user.username }, 'kb page updated')
    return result
  })

  // Delete a page (and its revisions). 404 on unknown page.
  app.delete('/api/pages/:id', (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return undefined
    const id = kbId((req.params as { id: string }).id)
    // Read the page BEFORE deleting it — the changelog entry outlives the row it
    // describes, which is precisely why `page_revisions` could not serve as the
    // changelog (it is deleted along with its page).
    const page = id !== null ? db.getPage(id) : undefined
    if (id === null || !page) {
      return reply.code(404).send({ error: 'page not found' })
    }
    db.deletePage(id)
    db.addChangelogEntry({
      spaceId: page.spaceId,
      pageId: null,
      userId: user.id,
      username: user.username,
      action: 'page.delete',
      detail: page.title,
      now: new Date().toISOString(),
    })
    deps.log.info({ pageId: id, username: user.username }, 'kb page deleted')
    return reply.code(204).send()
  })

  // Every revision of a page, oldest first — backs the History panel's undo
  // affordance. 404 on unknown page.
  app.get('/api/pages/:id/revisions', (req, reply): KbPageRevision[] | undefined => {
    const id = kbId((req.params as { id: string }).id)
    if (id === null || !db.getPage(id)) {
      reply.code(404).send({ error: 'page not found' })
      return undefined
    }
    return db.listPageRevisions(id)
  })

  // Restore a revision back onto its page (itself recording a revision). 404/400.
  app.post('/api/page-revisions/:id/restore', (req, reply): KbPage | undefined => {
    const user = requireUser(req, reply)
    if (!user) return undefined
    const id = kbId((req.params as { id: string }).id)
    if (id === null) {
      reply.code(404).send({ error: 'revision not found' })
      return undefined
    }
    const now = new Date().toISOString()
    // The restorer is the AUTHENTICATED user — a client-supplied `author` is
    // ignored, exactly as for every other KB write.
    const page = db.restorePageRevision(id, user.displayName, now)
    if (!page) {
      reply.code(404).send({ error: 'revision not found' })
      return undefined
    }
    db.addChangelogEntry({
      spaceId: page.spaceId,
      pageId: page.id,
      userId: user.id,
      username: user.username,
      action: 'page.edit',
      detail: `${page.title} (restored revision #${id})`,
      now,
    })
    deps.log.info({ revisionId: id, pageId: page.id, username: user.username }, 'kb revision restored')
    return page
  })


  // A space's per-edit changelog, newest first. Unlike `page_revisions` (body
  // snapshots, restorable, deleted with their page) this covers the whole page
  // lifecycle — create, rename, move, body-save and delete — and survives the
  // page it describes. `limit` is clamped to a hard cap. 404 on unknown space.
  app.get('/api/spaces/:id/changelog', (req, reply): KbChangeEntry[] | undefined => {
    const spaceId = kbId((req.params as { id: string }).id)
    if (spaceId === null || !db.getSpace(spaceId)) {
      reply.code(404).send({ error: 'space not found' })
      return undefined
    }
    const { limit } = req.query as { limit?: string }
    const requested = limit !== undefined ? Number(limit) : DEFAULT_CHANGELOG_PAGE
    const page =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, MAX_CHANGELOG_PAGE)
        : DEFAULT_CHANGELOG_PAGE
    return db.listChangelog(spaceId, page)
  })
}
