import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './KbView.module.css'
import type {
  KbBlock,
  KbPageDetail,
  KbRevision,
  KbTreeNode,
  Space,
  WorkspaceMember,
} from '../types'
import { MAX_DISPLAY_NAME_LEN } from '../types'
import { FileTree } from './FileTree'
import { api } from '../api'
import { detectKind, renderKbBlock, toEditableMarkdown } from '../kbMarkdown'
import { filterKbTree, pageBreadcrumb, parseKbNodePath } from '../kbTree'
import { isBlockConflict, mergeBlock, removeBlock as removeBlockFromList } from '../kbConflict'
import { kbHandles } from '../kbHandles'
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
   * The teammate's self-asserted display-name handle (server-side settings —
   * the SAME `settings.teamHandle` the Team surface persists). Presence/viewing
   * falls back to `anon` when unset, but EDITING requires a non-empty handle:
   * no KB block may be authored as `anon` (#150). See `kbHandles`.
   */
  teamHandle: string
  /**
   * Persist a new display handle (mirrors how App wires TeamView's
   * `onHandleChange`). Reused by the inline "set a display name to edit"
   * affordance so a viewer can enable editing without leaving the KB surface —
   * one identity across Team + KB, no second store.
   */
  onHandleChange: (handle: string) => void
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

/**
 * Inline "set a display name" affordance (#150) — NOT a blocking modal. Shown
 * wherever a KB write is gated because no display handle is set; setting a name
 * here reuses the SAME `settings.teamHandle` the Team surface persists (via
 * `onSet` → App's `saveSettings`), so it immediately enables editing across
 * both surfaces. Mirrors the Team join input's styling/tokens.
 */
function HandleGate({ onSet, action }: { onSet: (handle: string) => void; action: string }) {
  const [draft, setDraft] = useState('')
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const name = draft.trim()
    if (!name) return
    onSet(name)
  }
  return (
    <form className={styles.handleGate} onSubmit={submit}>
      <span className={styles.handleGateLabel}>Set a display name to {action}</span>
      <div className={styles.handleGateRow}>
        <input
          className={styles.handleGateInput}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Ada"
          maxLength={MAX_DISPLAY_NAME_LEN}
          aria-label="Display name"
        />
        <button type="submit" className={styles.handleGateBtn} disabled={!draft.trim()}>
          Set name
        </button>
      </div>
    </form>
  )
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
 *
 * The editor is Obsidian-native: block kinds are INFERRED from the markdown a
 * user types (`# ` → heading, `- ` → list, `- [ ] ` → checklist, a ``` fence →
 * code) rather than picked from a dropdown, and ⌘B/⌘I/⌘K/⌘↵ shortcuts drive
 * emphasis/links/save inside the textarea.
 */
export function KbView({ teamHandle, onHandleChange, openTarget = null, active }: Props) {
  // Split identity (#150): `presenceHandle` (may be `anon`) drives the workspace
  // hello + page presence; `editHandle` (EMPTY when no handle is set) authors
  // block edits. `canEdit` gates every write affordance — read-only viewing
  // works with no handle, but nothing is ever authored as `anon`.
  const { presenceHandle, editHandle, canEdit } = kbHandles(teamHandle)

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
  // Create affordance (page + folder) — compact icon buttons at the tree footer
  // that expand into a single inline name input (Obsidian-style). Both create at
  // the space root; reorganize into folders later.
  const [creating, setCreating] = useState<null | 'page' | 'folder'>(null)
  const [createDraft, setCreateDraft] = useState('')
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

  // When the operator clicks "+ Add block" the new block's id is only known once
  // the server echoes it back — this flag makes the incoming page.update open
  // that fresh block for editing immediately (Obsidian-style add-and-type).
  const autoEditNextRef = useRef(false)

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
        ws?.send(encodeHello(presenceHandle))
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
          // A freshly-added block (unknown id) echoed back after "+ Add block":
          // open it for editing straight away so the user just starts typing.
          if (autoEditNextRef.current && !blocksRef.current.some((b) => b.id === block.id)) {
            autoEditNextRef.current = false
            setEditingId(block.id)
          }
          // Edit-author identity feeds the conflict predicate: a dirty block only
          // exists when the local user is editing, which requires `editHandle`
          // to be non-empty — so this correctly distinguishes two real handles.
          const conflicted = isBlockConflict(block, dirtyIdsRef.current, editHandle)
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
  }, [presenceHandle, editHandle, active])

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

  /** Abandon a block's unsaved draft and close its editor (Esc). */
  const cancelEdit = (block: KbBlock): void => {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[block.id]
      return next
    })
    setEditingId(null)
  }

  /**
   * Wrap the textarea's current selection with markdown markers (⌘B/⌘I/⌘K),
   * updating the draft and restoring the caret/selection after React re-renders.
   */
  const wrapSelection = (
    el: HTMLTextAreaElement,
    block: KbBlock,
    before: string,
    after: string,
  ): void => {
    const { selectionStart: s, selectionEnd: e, value } = el
    const next = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e)
    setDraft(block.id, next)
    requestAnimationFrame(() => {
      el.selectionStart = s + before.length
      el.selectionEnd = e + before.length
      el.focus()
    })
  }

  /** Obsidian-style editor shortcuts: ⌘B/⌘I emphasis, ⌘K link, ⌘↵ save, Esc cancel. */
  const onEditorKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    block: KbBlock,
  ): void => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault()
      wrapSelection(e.currentTarget, block, '**', '**')
    } else if (mod && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault()
      wrapSelection(e.currentTarget, block, '*', '*')
    } else if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      wrapSelection(e.currentTarget, block, '[', '](url)')
    } else if (mod && e.key === 'Enter') {
      e.preventDefault()
      saveBlock(block)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit(block)
    }
  }

  /**
   * Save one block via the live `page.edit` fan-out, then close its editor. The
   * block's KIND is INFERRED from the markdown body (Obsidian-style: `# ` → a
   * heading, `- ` → a list, `- [ ] ` → a checklist, a ``` fence → code) so the
   * operator never picks a kind from a dropdown. Plain prose stays `text`.
   */
  const saveBlock = (block: KbBlock): void => {
    if (!canEdit) return
    const body = drafts[block.id]
    if (body === undefined) {
      setEditingId(null)
      return
    }
    const inferred = detectKind(body)
    const kind = inferred?.kind ?? 'text'
    const meta = inferred?.meta ?? null
    sendFrame(encodePageEdit(openPageId!, block.id, kind, body, meta, editHandle))
    // Optimistically apply locally; the server echo re-merges with a fresh ts.
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            blocks: prev.blocks.map((b) => (b.id === block.id ? { ...b, body, kind, meta } : b)),
          }
        : prev,
    )
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[block.id]
      return next
    })
    setEditingId(null)
  }

  /** Append a fresh (empty text) block and open it for editing (live create). */
  const addBlock = (): void => {
    if (!canEdit || openPageId === null) return
    autoEditNextRef.current = true
    sendFrame(encodePageEdit(openPageId, null, 'text', '', null, editHandle))
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
    if (!canEdit) return
    api
      .restoreRevision(revisionId, editHandle)
      .then((block) => {
        setDetail((prev) => (prev ? { ...prev, blocks: mergeBlock(prev.blocks, block) } : prev))
        // Re-broadcast so other viewers converge on the restored version.
        sendFrame(encodePageEdit(block.pageId, block.id, block.kind, block.body, block.meta, editHandle))
        setConflict(null)
      })
      .catch(() => setError('Failed to restore revision'))
  }

  // ---- structural create (page + folder) ----
  const startCreate = (kind: 'page' | 'folder'): void => {
    setCreating(kind)
    setCreateDraft('')
    setError(null)
  }

  const submitCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const name = createDraft.trim()
    if (!canEdit || !name || spaceId === null || busy || !creating) return
    setBusy(true)
    setError(null)
    try {
      if (creating === 'folder') {
        await api.createFolder(spaceId, name, null)
        refreshTree()
      } else {
        const page = await api.createPage(spaceId, name, editHandle, null)
        refreshTree()
        onOpenNode(`page/${page.id}`)
      }
      setCreating(null)
      setCreateDraft('')
    } catch {
      setError(creating === 'folder' ? 'Failed to create folder' : 'Failed to create page')
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

        {canEdit ? (
          <div className={styles.treeFooter}>
            {creating ? (
              <form className={styles.createInline} onSubmit={submitCreate}>
                <input
                  className={styles.createInlineInput}
                  type="text"
                  value={createDraft}
                  onChange={(e) => setCreateDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setCreating(null)
                      setCreateDraft('')
                    }
                  }}
                  onBlur={() => {
                    if (!createDraft.trim()) setCreating(null)
                  }}
                  placeholder={creating === 'page' ? 'Page name…' : 'Folder name…'}
                  aria-label={creating === 'page' ? 'New page name' : 'New folder name'}
                  maxLength={MAX_DISPLAY_NAME_LEN}
                  autoFocus
                />
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => startCreate('page')}
                  title="New page"
                  aria-label="New page"
                  disabled={busy || spaceId === null}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M4 1.5h4.5L13 6v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1Z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                    <path d="M8.25 1.75V6H12.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    <path d="M8 8.5v4M6 10.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => startCreate('folder')}
                  title="New folder"
                  aria-label="New folder"
                  disabled={busy || spaceId === null}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                    <path d="M8 7v3.5M6.25 8.75h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </button>
              </>
            )}
          </div>
        ) : (
          <div className={styles.treeFooter}>
            <HandleGate onSet={onHandleChange} action="create pages" />
          </div>
        )}
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
                        <textarea
                          className={styles.textarea}
                          value={draft ?? toEditableMarkdown(block.body, block.kind, block.meta)}
                          onChange={(e) => setDraft(block.id, e.target.value)}
                          onKeyDown={(e) => onEditorKeyDown(e, block)}
                          onBlur={() => saveBlock(block)}
                          aria-label="Block markdown"
                          autoFocus
                        />
                        <div className={styles.editorBar}>
                          <span className={styles.editorHint}>
                            # heading · - list · ⌘B bold · ⌘I italic · ⌘↵ save · esc cancel
                          </span>
                          <button
                            type="button"
                            className={styles.saveBtn}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => saveBlock(block)}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.rendered}>
                        {canEdit && (
                          <>
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
                          </>
                        )}
                        <div
                          className={styles.markdown}
                          onClick={canEdit ? () => setEditingId(block.id) : undefined}
                          dangerouslySetInnerHTML={{
                            __html:
                              renderKbBlock(block.body, block.kind, block.meta) ||
                              '<p class="' + styles.placeholder + '">Empty block — click to edit</p>',
                          }}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {canEdit ? (
              <div className={styles.addBar}>
                <button
                  type="button"
                  className={styles.addBtn}
                  onClick={() => addBlock()}
                  disabled={!connected}
                >
                  + Add block
                </button>
              </div>
            ) : (
              <div className={styles.addBar}>
                <HandleGate onSet={onHandleChange} action="edit this page" />
              </div>
            )}
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
