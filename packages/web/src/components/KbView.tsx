import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './KbView.module.css'
import type {
  KbBlock,
  KbBlockKind,
  KbPageDetail,
  KbRevision,
  KbTreeNode,
  Space,
  WorkspaceMember,
} from '../types'
import { KB_BLOCK_KINDS } from '../types'
import { FileTree } from './FileTree'
import { api } from '../api'
import { renderMarkdown } from '../kbMarkdown'
import { filterKbTree, collectFolders, pageBreadcrumb, parseKbNodePath } from '../kbTree'
import { isBlockConflict, mergeBlock, removeBlock as removeBlockFromList } from '../kbConflict'
import {
  encodeHello,
  encodePing,
  encodePageSubscribe,
  encodePageUnsubscribe,
  encodePageEdit,
  parseWorkspaceServerMsg,
} from '../workspaceProtocol'

interface Props {
  /**
   * The teammate's self-asserted display-name handle (server-side settings).
   * Used both for the workspace `hello` (the page-presence identity) and as the
   * author of block edits. Falls back to `anon` when unset — the KB surface has
   * no join gate of its own (unlike Team), it just needs an identity to attach.
   */
  teamHandle: string
  /**
   * One-shot navigation target from the Team tab's "Send to KB" promotion (T4,
   * #154): the space + page to select/open when the KB tab is entered. Seeded
   * via the in-render "adjust state on a prop change" pattern (NOT an effect —
   * that would trip `react-hooks/set-state-in-effect`). The parent passes a
   * FRESH object per promotion so the seed fires once each time.
   */
  openTarget?: { spaceId: number; pageId: number } | null
  /**
   * Whether the KB tab is the ACTIVE mode. The view is always mounted (App
   * keeps it in the DOM via `display:none`), so the workspace socket is gated
   * on this flag: an idle client on another mode opens ZERO sockets, entering
   * the KB tab opens exactly one, and leaving tears it down (the socket
   * effect's cleanup closes the ws + clears timers). Prevents the always-
   * mounted view from holding a permanent /ws/workspace socket + duplicate
   * page-presence membership (#149).
   */
  active: boolean
}

const PING_MS = 25000
const RECONNECT_MS = 2000

/** Human label for a block kind, shown in the per-block kind selector. */
const KIND_LABELS: Record<KbBlockKind, string> = {
  text: 'Text',
  heading: 'Heading',
  code: 'Code',
  checklist: 'Checklist',
  list: 'List',
}

/** Two-letter avatar initials for a viewer's presence chip. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * The KB mode surface (Variant A: list + detail). A curated team-space switcher
 * + the selected space's folder/page tree + a title search sit in the left
 * sidebar; the detail pane renders the open page's blocks as markdown, editable
 * per block, with live presence and block-LWW conflict UX. It owns ONE
 * multiplexed workspace socket (GET /ws/workspace, same-origin) for page
 * subscribe/edit/presence — REST covers spaces/tree/page + structural CRUD.
 */
export function KbView({ teamHandle, openTarget = null, active }: Props) {
  const handle = teamHandle.trim() || 'anon'

  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState<number | null>(null)
  const [tree, setTree] = useState<KbTreeNode[]>([])
  const [search, setSearch] = useState('')
  const [openPageId, setOpenPageId] = useState<number | null>(null)
  const [detail, setDetail] = useState<KbPageDetail | null>(null)
  const [viewers, setViewers] = useState<WorkspaceMember[]>([])
  const [connected, setConnected] = useState(false)

  // blockId → unsaved draft body. A block is "dirty" while it has a draft that
  // differs from its saved body; the dirty set drives block-LWW conflict detection.
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [editingId, setEditingId] = useState<number | null>(null)
  // The conflict toast: an incoming update replaced a block we were editing.
  const [conflict, setConflict] = useState<{ block: KbBlock; revisions: KbRevision[] } | null>(null)
  // Create affordances (folder + page) in the sidebar.
  const [newFolder, setNewFolder] = useState('')
  const [newFolderParent, setNewFolderParent] = useState('')
  const [newPage, setNewPage] = useState('')
  const [newPageFolder, setNewPageFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // One-shot "Send to KB" navigation (T4, #154): when the Team tab promotes a
  // message and hands up a fresh {spaceId, pageId}, select that space + open that
  // page. In-render prop-change seeding (not an effect) — the fresh object
  // identity per promotion makes the guard fire exactly once each time.
  const [targetSeededFrom, setTargetSeededFrom] = useState<Props['openTarget']>(null)
  if (openTarget && openTarget !== targetSeededFrom) {
    setTargetSeededFrom(openTarget)
    setSpaceId(openTarget.spaceId)
    setOpenPageId(openTarget.pageId)
  }

  const wsRef = useRef<WebSocket | null>(null)
  const openPageIdRef = useRef<number | null>(null)
  useEffect(() => {
    openPageIdRef.current = openPageId
  }, [openPageId])

  // The saved blocks of the open page (for conflict + draft diffing) readable
  // inside the stable socket closure.
  const blocksRef = useRef<KbBlock[]>([])
  useEffect(() => {
    blocksRef.current = detail?.blocks ?? []
  }, [detail])

  // The set of locally-dirty block ids, readable inside the socket closure.
  const dirtyIdsRef = useRef<Set<number>>(new Set())
  const dirtyIds = useMemo(() => {
    const saved = new Map((detail?.blocks ?? []).map((b) => [b.id, b.body]))
    const set = new Set<number>()
    for (const [id, body] of Object.entries(drafts)) {
      const bid = Number(id)
      if (saved.get(bid) !== body) set.add(bid)
    }
    return set
  }, [drafts, detail])
  useEffect(() => {
    dirtyIdsRef.current = dirtyIds
  }, [dirtyIds])

  /** Send a pre-encoded frame if the socket is live (dropped otherwise). */
  const sendFrame = (data: string): void => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(data)
  }

  // ---- socket lifecycle (page presence + live block deltas) ----
  // Gated on `active` (#149): only the active KB mode holds a workspace socket.
  // When `active` flips false the effect cleanup below runs (closes the ws,
  // clears timers, nulls wsRef, setConnected(false)) — so leaving the tab tears
  // the socket down; returning re-runs the effect and connects fresh.
  useEffect(() => {
    if (!active) return
    const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/workspace`
    let closed = false
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      try {
        ws = new WebSocket(socketUrl)
      } catch {
        reconnect = setTimeout(connect, RECONNECT_MS)
        return
      }
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        ws?.send(encodeHello(handle))
        // Re-subscribe to the open page after a reconnect.
        const pid = openPageIdRef.current
        if (pid !== null) ws?.send(encodePageSubscribe(pid))
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(encodePing())
        }, PING_MS)
      }
      ws.onmessage = (ev) => {
        const msg = parseWorkspaceServerMsg(String(ev.data))
        if (!msg) return
        if (msg.type === 'page.update') {
          if (msg.pageId !== openPageIdRef.current) return
          const block = msg.block
          const conflicted = isBlockConflict(block, dirtyIdsRef.current, handle)
          // Block-LWW: the server already accepted the last write, so merge the
          // incoming block regardless. On a conflict, drop our stale draft +
          // surface the restore toast rather than silently clobbering the editor.
          setDetail((prev) => (prev ? { ...prev, blocks: mergeBlock(prev.blocks, block) } : prev))
          if (conflicted) {
            setDrafts((prev) => {
              const next = { ...prev }
              delete next[block.id]
              return next
            })
            setEditingId((cur) => (cur === block.id ? null : cur))
            api
              .getRevisions(block.id)
              .then((revisions) => {
                if (!closed) setConflict({ block, revisions })
              })
              .catch(() => {
                if (!closed) setConflict({ block, revisions: [] })
              })
          }
        } else if (msg.type === 'page.presence') {
          if (msg.pageId === openPageIdRef.current) setViewers(msg.viewers)
        } else if (msg.type === 'page.delete') {
          // A block was deleted elsewhere — converge by dropping it from the open
          // page and cleaning up any local draft / open editor for that block.
          if (msg.pageId !== openPageIdRef.current) return
          const { blockId } = msg
          setDetail((prev) =>
            prev ? { ...prev, blocks: removeBlockFromList(prev.blocks, blockId) } : prev,
          )
          setDrafts((prev) => {
            if (!(blockId in prev)) return prev
            const next = { ...prev }
            delete next[blockId]
            return next
          })
          setEditingId((cur) => (cur === blockId ? null : cur))
        }
      }
      ws.onclose = () => {
        setConnected(false)
        if (ping) clearInterval(ping)
        if (!closed) reconnect = setTimeout(connect, RECONNECT_MS)
      }
      ws.onerror = () => ws?.close()
    }
    connect()

    return () => {
      closed = true
      if (ping) clearInterval(ping)
      if (reconnect) clearTimeout(reconnect)
      ws?.close()
      wsRef.current = null
      setConnected(false)
    }
  }, [handle, active])

  // ---- load spaces once; default to the first space ----
  useEffect(() => {
    let cancelled = false
    api
      .getSpaces()
      .then((list) => {
        if (cancelled) return
        setSpaces(list)
        setSpaceId((cur) => (cur !== null ? cur : (list[0]?.id ?? null)))
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load spaces')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ---- load the selected space's tree ----
  useEffect(() => {
    if (spaceId === null) return
    let cancelled = false
    api
      .getSpaceTree(spaceId)
      .then((nodes) => {
        if (!cancelled) setTree(nodes)
      })
      .catch(() => {
        if (!cancelled) setTree([])
      })
    return () => {
      cancelled = true
    }
  }, [spaceId])

  // ---- open a page: REST detail + subscribe to its live fan-out ----
  useEffect(() => {
    if (openPageId === null) return
    let cancelled = false
    api
      .getPage(openPageId)
      .then((page) => {
        if (!cancelled) setDetail(page)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
    sendFrame(encodePageSubscribe(openPageId))
    return () => {
      cancelled = true
      sendFrame(encodePageUnsubscribe(openPageId))
    }
  }, [openPageId])

  /** Switch the selected space, clearing the open page + its state. */
  const selectSpace = (id: number): void => {
    if (id === spaceId) return
    setSpaceId(id)
    setOpenPageId(null)
    setDetail(null)
    setViewers([])
    setDrafts({})
    setEditingId(null)
    setConflict(null)
    setSearch('')
  }

  /** Open a page from the tree (files only; folders just expand in FileTree). */
  const onOpenNode = (path: string): void => {
    const ref = parseKbNodePath(path)
    if (!ref || ref.kind !== 'page') return
    if (ref.id === openPageId) return
    setOpenPageId(ref.id)
    setDetail(null)
    setViewers([])
    setDrafts({})
    setEditingId(null)
    setConflict(null)
  }

  const refreshTree = (): void => {
    if (spaceId === null) return
    api
      .getSpaceTree(spaceId)
      .then(setTree)
      .catch(() => undefined)
  }

  // ---- block editing ----
  const setDraft = (blockId: number, body: string): void => {
    setDrafts((prev) => ({ ...prev, [blockId]: body }))
  }

  /** Save one block via the live `page.edit` fan-out, then close its editor. */
  const saveBlock = (block: KbBlock): void => {
    const body = drafts[block.id]
    if (body === undefined) {
      setEditingId(null)
      return
    }
    sendFrame(encodePageEdit(openPageId!, block.id, block.kind, body, block.meta, handle))
    // Optimistically apply locally; the server echo re-merges with a fresh ts.
    setDetail((prev) =>
      prev
        ? { ...prev, blocks: prev.blocks.map((b) => (b.id === block.id ? { ...b, body } : b)) }
        : prev,
    )
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[block.id]
      return next
    })
    setEditingId(null)
  }

  /** Change a block's kind (persists immediately via the live fan-out). */
  const changeKind = (block: KbBlock, kind: KbBlockKind): void => {
    const body = drafts[block.id] ?? block.body
    sendFrame(encodePageEdit(openPageId!, block.id, kind, body, block.meta, handle))
    setDetail((prev) =>
      prev
        ? { ...prev, blocks: prev.blocks.map((b) => (b.id === block.id ? { ...b, kind } : b)) }
        : prev,
    )
  }

  /** Append a fresh block of the given kind to the open page (live create). */
  const addBlock = (kind: KbBlockKind): void => {
    if (openPageId === null) return
    sendFrame(encodePageEdit(openPageId, null, kind, '', null, handle))
  }

  /** Delete a block over REST, then drop it from the open page locally. */
  const removeBlock = (block: KbBlock): void => {
    api
      .deleteBlock(block.id)
      .then(() => {
        setDetail((prev) =>
          prev ? { ...prev, blocks: prev.blocks.filter((b) => b.id !== block.id) } : prev,
        )
      })
      .catch(() => setError('Failed to delete block'))
  }

  /** Restore a revision onto the conflicted block, then close the toast. */
  const restore = (revisionId: number): void => {
    api
      .restoreRevision(revisionId, handle)
      .then((block) => {
        setDetail((prev) => (prev ? { ...prev, blocks: mergeBlock(prev.blocks, block) } : prev))
        // Re-broadcast so other viewers converge on the restored version.
        sendFrame(encodePageEdit(block.pageId, block.id, block.kind, block.body, block.meta, handle))
        setConflict(null)
      })
      .catch(() => setError('Failed to restore revision'))
  }

  // ---- structural create (folder + page) ----
  const folderOptions = useMemo(() => collectFolders(tree), [tree])

  const createFolder = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const name = newFolder.trim()
    if (!name || spaceId === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const parentId = newFolderParent ? Number(newFolderParent) : null
      await api.createFolder(spaceId, name, parentId)
      setNewFolder('')
      setNewFolderParent('')
      refreshTree()
    } catch {
      setError('Failed to create folder')
    } finally {
      setBusy(false)
    }
  }

  const createPage = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const title = newPage.trim()
    if (!title || spaceId === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const folderId = newPageFolder ? Number(newPageFolder) : null
      const page = await api.createPage(spaceId, title, handle, folderId)
      setNewPage('')
      setNewPageFolder('')
      refreshTree()
      onOpenNode(`page/${page.id}`)
    } catch {
      setError('Failed to create page')
    } finally {
      setBusy(false)
    }
  }

  const renamePage = (): void => {
    if (!detail) return
    const next = window.prompt('Rename page', detail.page.title)?.trim()
    if (!next || next === detail.page.title) return
    api
      .updatePage(detail.page.id, { title: next })
      .then((page) => {
        setDetail((prev) => (prev ? { ...prev, page } : prev))
        refreshTree()
      })
      .catch(() => setError('Failed to rename page'))
  }

  const deletePage = (): void => {
    if (!detail) return
    if (!window.confirm(`Delete page "${detail.page.title}"?`)) return
    const id = detail.page.id
    api
      .deletePage(id)
      .then(() => {
        setOpenPageId(null)
        setDetail(null)
        setViewers([])
        refreshTree()
      })
      .catch(() => setError('Failed to delete page'))
  }

  const filteredTree = useMemo(() => filterKbTree(tree, search), [tree, search])
  const crumb = useMemo(
    () => (openPageId !== null ? pageBreadcrumb(tree, openPageId) : []),
    [tree, openPageId],
  )
  const spaceName = spaces.find((s) => s.id === spaceId)?.name ?? ''

  return (
    <div className={styles.kb}>
      <aside className={styles.sidebar}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Spaces</span>
          <span className={styles.conn}>
            <span className={`${styles.dot} ${connected ? styles.dotOn : styles.dotOff}`} aria-hidden />
            {connected ? 'live' : 'offline'}
          </span>
        </div>
        <ul className={styles.spaces}>
          {spaces.length === 0 && <li className={styles.empty}>No spaces.</li>}
          {spaces.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`${styles.space} ${s.id === spaceId ? styles.spaceActive : ''}`}
                onClick={() => selectSpace(s.id)}
              >
                {s.name}
              </button>
            </li>
          ))}
        </ul>

        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Pages</span>
        </div>
        <input
          className={styles.search}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search titles…"
          aria-label="Search page titles"
        />
        <div className={styles.treeWrap}>
          {filteredTree.length === 0 ? (
            <p className={styles.empty}>{search ? 'No matches.' : 'No pages yet.'}</p>
          ) : (
            <FileTree entries={filteredTree} onOpen={onOpenNode} selectedPath={openPageId !== null ? `page/${openPageId}` : null} />
          )}
        </div>

        <form className={styles.createForm} onSubmit={createPage}>
          <input
            className={styles.search}
            type="text"
            value={newPage}
            onChange={(e) => setNewPage(e.target.value)}
            placeholder="New page title…"
            aria-label="New page title"
          />
          <select
            className={styles.select}
            value={newPageFolder}
            onChange={(e) => setNewPageFolder(e.target.value)}
            aria-label="Page folder"
          >
            <option value="">Space root</option>
            {folderOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
          <button type="submit" className={styles.createBtn} disabled={!newPage.trim() || busy}>
            + Page
          </button>
        </form>

        <form className={styles.createForm} onSubmit={createFolder}>
          <input
            className={styles.search}
            type="text"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="New folder name…"
            aria-label="New folder name"
          />
          <select
            className={styles.select}
            value={newFolderParent}
            onChange={(e) => setNewFolderParent(e.target.value)}
            aria-label="Parent folder"
          >
            <option value="">Space root</option>
            {folderOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
          <button type="submit" className={styles.createBtn} disabled={!newFolder.trim() || busy}>
            + Folder
          </button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
      </aside>

      <section className={styles.detail}>
        {detail ? (
          <>
            <header className={styles.detailHead}>
              <div className={styles.crumbs}>
                <span className={styles.crumb}>{spaceName}</span>
                {crumb.map((c, i) => (
                  <span key={`${c}:${i}`} className={styles.crumb}>
                    <span className={styles.crumbSep}>/</span>
                    {c}
                  </span>
                ))}
              </div>
              <div className={styles.titleRow}>
                <h1 className={styles.pageTitle}>{detail.page.title}</h1>
                <div className={styles.presence} aria-label={`${viewers.length} viewing`}>
                  {viewers.map((v) => (
                    <span key={v.id} className={styles.avatar} title={v.displayName}>
                      {initials(v.displayName)}
                    </span>
                  ))}
                  <span className={styles.presenceCount}>{viewers.length} here</span>
                </div>
              </div>
              <div className={styles.pageActions}>
                <button type="button" className={styles.pageAction} onClick={renamePage}>
                  Rename
                </button>
                <button type="button" className={styles.pageAction} onClick={deletePage}>
                  Delete
                </button>
              </div>
            </header>

            <div className={styles.blocks}>
              {detail.blocks.length === 0 && (
                <p className={styles.empty}>This page has no blocks yet — add one below.</p>
              )}
              {detail.blocks.map((block) => {
                const editing = editingId === block.id
                const draft = drafts[block.id]
                const dirty = dirtyIds.has(block.id)
                return (
                  <div key={block.id} className={`${styles.block} ${dirty ? styles.blockDirty : ''}`}>
                    {editing ? (
                      <div className={styles.editor}>
                        <div className={styles.editorBar}>
                          <select
                            className={styles.select}
                            value={block.kind}
                            onChange={(e) => changeKind(block, e.target.value as KbBlockKind)}
                            aria-label="Block kind"
                          >
                            {KB_BLOCK_KINDS.map((k) => (
                              <option key={k} value={k}>
                                {KIND_LABELS[k]}
                              </option>
                            ))}
                          </select>
                          <button type="button" className={styles.saveBtn} onClick={() => saveBlock(block)}>
                            Save
                          </button>
                        </div>
                        <textarea
                          className={styles.textarea}
                          value={draft ?? block.body}
                          onChange={(e) => setDraft(block.id, e.target.value)}
                          onBlur={() => saveBlock(block)}
                          aria-label="Block markdown"
                          autoFocus
                        />
                      </div>
                    ) : (
                      <div className={styles.rendered}>
                        <button
                          type="button"
                          className={styles.editToggle}
                          onClick={() => setEditingId(block.id)}
                          aria-label="Edit block"
                          title="Edit block"
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className={styles.removeToggle}
                          onClick={() => removeBlock(block)}
                          aria-label="Delete block"
                          title="Delete block"
                        >
                          ×
                        </button>
                        <div
                          className={styles.markdown}
                          onClick={() => setEditingId(block.id)}
                          dangerouslySetInnerHTML={{
                            __html:
                              renderMarkdown(block.body, block.kind, block.meta) ||
                              '<p class="' + styles.placeholder + '">Empty block — click to edit</p>',
                          }}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className={styles.addBar}>
              <span className={styles.addLabel}>Add block:</span>
              {KB_BLOCK_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={styles.addBtn}
                  onClick={() => addBlock(k)}
                  disabled={!connected}
                >
                  + {KIND_LABELS[k]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className={styles.detailEmpty}>
            <p className={styles.emptyTitle}>Select a page</p>
            <p className={styles.emptyHint}>
              Pick a space, then open a page from the tree — or create one.
            </p>
          </div>
        )}

        {conflict && (
          <div className={styles.toast} role="alert">
            <div className={styles.toastBody}>
              <strong>Someone else edited this block</strong> — your version was replaced (last
              write wins). Restore one of your earlier versions:
            </div>
            <ul className={styles.revisions}>
              {conflict.revisions.length === 0 && (
                <li className={styles.empty}>No earlier revisions available.</li>
              )}
              {conflict.revisions
                .slice()
                .reverse()
                .map((r) => (
                  <li key={r.id}>
                    <button type="button" className={styles.restoreBtn} onClick={() => restore(r.id)}>
                      <span className={styles.revMeta}>
                        {r.author} · {new Date(r.createdAt).toLocaleString()}
                      </span>
                      <span className={styles.revSnippet}>{r.body.slice(0, 80) || '(empty)'}</span>
                    </button>
                  </li>
                ))}
            </ul>
            <button type="button" className={styles.toastClose} onClick={() => setConflict(null)}>
              Dismiss
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
