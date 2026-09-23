import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styles from './KbView.module.css'
import type {
  KbChangeAction,
  KbChangeEntry,
  KbPage,
  KbPageRevision,
  KbTreeNode,
  PublicUser,
  Space,
  WorkspaceMember,
} from '../types'
import { MAX_DISPLAY_NAME_LEN, PROTECTED_SPACE_NAME } from '../types'
import { FileTree } from './FileTree'
import { api, isAuthError } from '../api'
import { clearSession } from '../auth'
import { renderPageMarkdown, toggleChecklistLine } from '../kbMarkdown'
import { filterKbTree, pageBreadcrumb, parseKbNodePath } from '../kbTree'
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
   * The authenticated user for the Knowledge Base origin. The KB is served by
   * THIS server (same-origin), so App gates this view on the local session and
   * only mounts it once one exists — which is why there is no unauthenticated
   * branch left in here. `displayName` is the identity for page presence and
   * for the optimistic `updatedBy` on a save; the server is what actually
   * attributes every write, from the socket's own session.
   */
  user: PublicUser
  /**
   * The session for this origin is gone — the operator logged out, the server
   * answered 401, or the socket reported `unauthorized`. App re-reads the
   * stored session and re-shows the login pane in place of this view.
   */
  onLogout: () => void
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
/** Debounce window for continuous autosave — long enough that a burst of
 *  keystrokes coalesces into one `page.edit`, short enough to feel instant. */
const AUTOSAVE_DEBOUNCE_MS = 600

/**
 * The Knowledge Base is served by this app's OWN server, so its session is the
 * same-origin one (`''` — the httpOnly `zmrng_session` cookie). Team Chat is
 * the surface that may live on another origin; see `TeamView.tsx`.
 */
const KB_ORIGIN = ''

/** Human labels for the changelog's action codes. */
const CHANGE_LABEL: Record<KbChangeAction, string> = {
  'page.create': 'created',
  'page.rename': 'renamed',
  'page.move': 'moved',
  'page.edit': 'edited',
  'page.delete': 'deleted',
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
 * sidebar; the detail pane renders the open page as ONE continuous, Obsidian-
 * style markdown field — click it and start typing right away, like a notepad.
 * There is no per-block model: a page's `body` IS the whole page, autosaved
 * continuously as the operator types (last-write-wins), with a throttled
 * revision history reachable from the "History" page action and a per-space
 * lifecycle feed behind "Changelog". It owns ONE multiplexed workspace socket
 * (GET /ws/workspace, same-origin) for page subscribe/edit/presence — REST
 * covers spaces/tree/page + structural CRUD.
 *
 * Everything here is an authenticated surface: App only mounts it once the
 * local origin holds a session, so every write affordance is simply available.
 */
function KbViewComponent({ user, onLogout, openTarget = null, active }: Props) {
  // The authenticated identity: page presence and the optimistic `updatedBy`.
  // The server attributes the persisted write from the socket's own session —
  // this is display only, and can no longer be asserted over the wire.
  const author = user.displayName

  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState<number | null>(null)
  const [tree, setTree] = useState<KbTreeNode[]>([])
  // Bumped to force a tree refetch when a `space.tree` frame lands (another
  // client re-parented a folder/page in this space via drag-and-drop).
  const [treeNonce, setTreeNonce] = useState(0)
  const [search, setSearch] = useState('')
  const [openPageId, setOpenPageId] = useState<number | null>(null)
  const [detail, setDetail] = useState<KbPage | null>(null)
  const [viewers, setViewers] = useState<WorkspaceMember[]>([])
  const [connected, setConnected] = useState(false)

  // The single-field editor: `editing` toggles between the rendered (click-to-
  // edit) view and the raw textarea; `bodyDraft` is the textarea's live value
  // while editing (null when not editing).
  const [editing, setEditing] = useState(false)
  const [bodyDraft, setBodyDraft] = useState<string | null>(null)
  // The page-history panel (throttled revision snapshots — #6 "keep, throttled").
  const [historyOpen, setHistoryOpen] = useState(false)
  const [revisions, setRevisions] = useState<KbPageRevision[]>([])
  // The space changelog panel — who changed what, newest first.
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelog, setChangelog] = useState<KbChangeEntry[]>([])
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

  // Keep the latest `onLogout` readable inside the stable socket closure and
  // the passive load effects without re-running either on a new prop identity.
  const onLogoutRef = useRef(onLogout)
  useEffect(() => {
    onLogoutRef.current = onLogout
  }, [onLogout])

  /**
   * Forget this origin's session and hand the surface back to the login pane.
   * The store is what App gates on, so dropping it is what actually re-gates:
   * an `unauthorized` socket frame arrives while the stored session still looks
   * live by its clock, and telling App to re-read without clearing would just
   * re-render this same view behind a dead socket.
   *
   * Stable for the component's lifetime (it reads the CURRENT `onLogout`
   * through its ref), so the socket + load effects depend on it without ever
   * tearing down on a new prop identity.
   */
  const gateAgain = useCallback((): void => {
    clearSession(KB_ORIGIN)
    onLogoutRef.current()
  }, [])

  /**
   * One REST failure handler. An expired/absent session is NOT an error to
   * render at the operator — it re-shows the login pane; anything else surfaces
   * inline under the tree.
   */
  const onApiError =
    (message: string) =>
    (err: unknown): void => {
      if (isAuthError(err)) {
        gateAgain()
        return
      }
      setError(message)
    }

  // Readable inside the stable socket closure: an incoming page.update is
  // dropped while the local user is actively editing, so another viewer's save
  // never clobbers a live typing session (last-write-wins only matters at
  // SAVE time, not while just rendering).
  const editingRef = useRef(false)

  // The selected space, readable inside the stable socket closure so an incoming
  // `space.tree` frame can tell whether it targets the space we're viewing.
  const spaceIdRef = useRef<number | null>(null)
  useEffect(() => {
    spaceIdRef.current = spaceId
  }, [spaceId])
  useEffect(() => {
    editingRef.current = editing
  }, [editing])

  // Continuous autosave: the debounce timer + the page/body it will flush.
  // Refs (not state) so the textarea's onChange can schedule/cancel a save
  // without re-running effects.
  const pendingRef = useRef<{ pageId: number; body: string } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  /** Send a pre-encoded frame if the socket is live (dropped otherwise). */
  const sendFrame = (data: string): void => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(data)
  }

  /** Send any pending debounced save immediately and apply it optimistically. */
  const flushPending = (): void => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    sendFrame(encodePageEdit(pending.pageId, pending.body))
    setDetail((prev) =>
      prev && prev.id === pending.pageId ? { ...prev, body: pending.body, updatedBy: author } : prev,
    )
  }

  /** Debounce a whole-body autosave (continuous autosave, no explicit save step). */
  const scheduleSave = (pageId: number, body: string): void => {
    pendingRef.current = { pageId, body }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(flushPending, AUTOSAVE_DEBOUNCE_MS)
  }

  /** Revoke the session server-side, then re-gate the surface. */
  const signOut = (): void => {
    void api
      .logout(KB_ORIGIN)
      // A dead session 401s and an unreachable server throws; either way this
      // client logs out locally — a logout button must always log you out.
      .catch(() => undefined)
      .then(() => gateAgain())
  }

  // ---- socket lifecycle (page presence + live body deltas) ----
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
        // No identity on the wire: this socket is same-origin, so the handshake
        // carries the httpOnly session cookie and the server derives the user.
        ws?.send(encodeHello())
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
          // Don't clobber a live typing session on THIS tab — our own saves
          // are already applied optimistically by `flushPending`.
          if (editingRef.current) return
          setDetail(msg.page)
        } else if (msg.type === 'page.presence') {
          if (msg.pageId === openPageIdRef.current) setViewers(msg.viewers)
        } else if (msg.type === 'space.tree') {
          // A folder/page was re-parented (drag-and-drop) elsewhere — refetch the
          // tree if the change targets the space we're currently viewing.
          if (msg.spaceId === spaceIdRef.current) setTreeNonce((n) => n + 1)
        } else if (msg.type === 'unauthorized') {
          // The handshake presented no valid session (it expired, or another tab
          // logged out). The server closes the socket; stop reconnecting and
          // hand the surface back to the login pane instead of looping.
          closed = true
          gateAgain()
          ws?.close()
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
  }, [active, gateAgain])

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
      .catch((err: unknown) => {
        if (cancelled) return
        if (isAuthError(err)) {
          gateAgain()
          return
        }
        setError('Failed to load spaces')
      })
    return () => {
      cancelled = true
    }
  }, [gateAgain])

  // ---- load the selected space's tree ----
  useEffect(() => {
    if (spaceId === null) return
    let cancelled = false
    api
      .getSpaceTree(spaceId)
      .then((nodes) => {
        if (!cancelled) setTree(nodes)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (isAuthError(err)) {
          gateAgain()
          return
        }
        setTree([])
      })
    return () => {
      cancelled = true
    }
  }, [spaceId, treeNonce, gateAgain])

  // ---- open a page: REST fetch + subscribe to its live fan-out ----
  // A blank page (freshly created, or emptied out) opens straight into the
  // editor with the cursor ready — no button to press first, like a notepad.
  useEffect(() => {
    if (openPageId === null) return
    let cancelled = false
    api
      .getPage(openPageId)
      .then((page) => {
        if (cancelled) return
        setDetail(page)
        if (page.body === '') {
          setBodyDraft('')
          setEditing(true)
        } else {
          setBodyDraft(null)
          setEditing(false)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (isAuthError(err)) {
          gateAgain()
          return
        }
        setDetail(null)
      })
    sendFrame(encodePageSubscribe(openPageId))
    return () => {
      cancelled = true
      sendFrame(encodePageUnsubscribe(openPageId))
    }
  }, [openPageId, gateAgain])

  /** Reset the per-space view state (open page, editor, panels, search). */
  const clearSpaceState = (): void => {
    setOpenPageId(null)
    setDetail(null)
    setViewers([])
    setEditing(false)
    setBodyDraft(null)
    setHistoryOpen(false)
    setChangelogOpen(false)
    setSearch('')
  }

  /** Switch the selected space, clearing the open page + its state. */
  const selectSpace = (id: number): void => {
    if (id === spaceId) return
    setSpaceId(id)
    clearSpaceState()
  }

  /**
   * Create a new space (name only). Prompts for the name (matching the existing
   * rename affordance), appends the created space to the switcher, and selects
   * it.
   */
  const createSpace = async (): Promise<void> => {
    if (busy) return
    const name = window.prompt('New space name')?.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const space = await api.createSpace(name)
      setSpaces((prev) => [...prev, space])
      setSpaceId(space.id)
      clearSpaceState()
    } catch (err) {
      onApiError('Failed to create space')(err)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Delete a space and everything inside it, after an explicit confirmation that
   * spells out the permanence. The protected `zmrng` space can never be deleted
   * (guarded here and server-side). After deletion the switcher falls back to
   * the first remaining space.
   */
  const deleteSpace = async (space: Space): Promise<void> => {
    if (busy || space.name === PROTECTED_SPACE_NAME) return
    const ok = window.confirm(
      `Delete the "${space.name}" space?\n\n` +
        'This permanently deletes the space and EVERYTHING inside it — all folders, ' +
        'all pages, and their full edit history. This cannot be undone.',
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteSpace(space.id)
      const remaining = spaces.filter((s) => s.id !== space.id)
      setSpaces(remaining)
      if (space.id === spaceId) {
        setSpaceId(remaining[0]?.id ?? null)
        clearSpaceState()
      }
    } catch (err) {
      onApiError('Failed to delete space')(err)
    } finally {
      setBusy(false)
    }
  }

  /** Open a page from the tree (files only; folders just expand in FileTree). */
  const onOpenNode = (path: string): void => {
    const ref = parseKbNodePath(path)
    if (!ref || ref.kind !== 'page') return
    if (ref.id === openPageId) return
    setOpenPageId(ref.id)
    setDetail(null)
    setViewers([])
    setEditing(false)
    setBodyDraft(null)
    setHistoryOpen(false)
    setChangelogOpen(false)
  }

  const refreshTree = (): void => {
    if (spaceId === null) return
    api
      .getSpaceTree(spaceId)
      .then(setTree)
      .catch((err: unknown) => {
        if (isAuthError(err)) gateAgain()
      })
  }

  // ---- single-field body editing ----

  /** Enter edit mode: seed the draft from the last-known-saved body. */
  const enterEdit = (): void => {
    if (!detail) return
    setBodyDraft(detail.body)
    setEditing(true)
  }

  /**
   * Re-parent a folder or page via drag-and-drop. `sourcePath` is the dragged
   * node's tree path; `targetFolderPath` is the destination folder path (`null` =
   * space root). Reuses the existing move endpoints (`PATCH /api/folders/:id`
   * `parentId` / `PATCH /api/pages/:id` `folderId`); the server rejects a cycle
   * and fans a `space.tree` frame so other viewers converge. We refetch locally.
   */
  const moveNode = (sourcePath: string, targetFolderPath: string | null): void => {
    const source = parseKbNodePath(sourcePath)
    if (!source) return
    // A non-root target must be a folder; ignore a drop onto anything else.
    let targetFolderId: number | null = null
    if (targetFolderPath !== null) {
      const target = parseKbNodePath(targetFolderPath)
      if (!target || target.kind !== 'folder') return
      targetFolderId = target.id
    }
    const move =
      source.kind === 'folder'
        ? api.updateFolder(source.id, { parentId: targetFolderId })
        : api.updatePage(source.id, { folderId: targetFolderId })
    move.then(() => refreshTree()).catch(onApiError('Failed to move item'))
  }

  /** Live textarea change: update the draft and debounce an autosave. */
  const onBodyChange = (value: string): void => {
    setBodyDraft(value)
    if (openPageId !== null) scheduleSave(openPageId, value)
  }

  /** Leave edit mode, discarding any NOT-YET-SENT (still-debouncing) keystrokes. */
  const cancelEdit = (): void => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    pendingRef.current = null
    setBodyDraft(null)
    setEditing(false)
  }

  /**
   * Wrap the textarea's current selection with markdown markers (⌘B/⌘I/⌘K),
   * updating the draft and restoring the caret/selection after React re-renders.
   */
  const wrapSelection = (before: string, after: string): void => {
    const el = textareaRef.current
    if (!el || openPageId === null) return
    const { selectionStart: s, selectionEnd: e, value } = el
    const next = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e)
    onBodyChange(next)
    requestAnimationFrame(() => {
      el.selectionStart = s + before.length
      el.selectionEnd = e + before.length
      el.focus()
    })
  }

  /** Obsidian-style editor shortcuts: ⌘B/⌘I emphasis, ⌘K link, ⌘↵/blur save, Esc cancel. */
  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault()
      wrapSelection('**', '**')
    } else if (mod && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault()
      wrapSelection('*', '*')
    } else if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      wrapSelection('[', '](url)')
    } else if (mod && e.key === 'Enter') {
      e.preventDefault()
      flushPending()
      setEditing(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  /**
   * Click inside the rendered (non-editing) body: a click on an interactive
   * checklist checkbox toggles just that line (and autosaves immediately,
   * skipping the debounce — a deliberate action, not a keystroke); a click
   * anywhere else enters edit mode.
   */
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      e.preventDefault()
      e.stopPropagation()
      if (!detail || openPageId === null || target.dataset.line === undefined) return
      const nextBody = toggleChecklistLine(detail.body, Number(target.dataset.line))
      setDetail((prev) => (prev ? { ...prev, body: nextBody, updatedBy: author } : prev))
      sendFrame(encodePageEdit(openPageId, nextBody))
      return
    }
    enterEdit()
  }

  // ---- history panel (throttled revisions) ----
  const openHistory = (): void => {
    if (!detail) return
    setChangelogOpen(false)
    api
      .getPageRevisions(detail.id)
      .then((revs) => {
        setRevisions(revs)
        setHistoryOpen(true)
      })
      .catch(onApiError('Failed to load history'))
  }

  /** Restore a revision onto the open page, then close the panel. */
  const restore = (revisionId: number): void => {
    if (openPageId === null) return
    api
      .restorePageRevision(revisionId)
      .then((page) => {
        setDetail(page)
        setBodyDraft(null)
        setEditing(false)
        // Re-broadcast so other viewers converge on the restored version.
        sendFrame(encodePageEdit(openPageId, page.body))
        setHistoryOpen(false)
      })
      .catch(onApiError('Failed to restore revision'))
  }

  // ---- changelog panel (per-space page lifecycle) ----
  // Distinct from History: revisions are THIS page's restorable body snapshots
  // and die with it, while the changelog covers every page in the space and
  // every kind of change — create, rename, move, body-save, delete.
  const openChangelog = (): void => {
    if (spaceId === null) return
    setHistoryOpen(false)
    api
      .getChangelog(spaceId)
      .then((entries) => {
        setChangelog(entries)
        setChangelogOpen(true)
      })
      .catch(onApiError('Failed to load the changelog'))
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
    if (!name || spaceId === null || busy || !creating) return
    setBusy(true)
    setError(null)
    try {
      if (creating === 'folder') {
        await api.createFolder(spaceId, name, null)
        refreshTree()
      } else {
        const page = await api.createPage(spaceId, name, null)
        refreshTree()
        onOpenNode(`page/${page.id}`)
      }
      setCreating(null)
      setCreateDraft('')
    } catch (err) {
      onApiError(creating === 'folder' ? 'Failed to create folder' : 'Failed to create page')(err)
    } finally {
      setBusy(false)
    }
  }

  const renamePage = (): void => {
    if (!detail) return
    const next = window.prompt('Rename page', detail.title)?.trim()
    if (!next || next === detail.title) return
    api
      .updatePage(detail.id, { title: next })
      .then((page) => {
        setDetail(page)
        refreshTree()
      })
      .catch(onApiError('Failed to rename page'))
  }

  const deletePage = (): void => {
    if (!detail) return
    if (!window.confirm(`Delete page "${detail.title}"?`)) return
    const id = detail.id
    api
      .deletePage(id)
      .then(() => {
        setOpenPageId(null)
        setDetail(null)
        setViewers([])
        refreshTree()
      })
      .catch(onApiError('Failed to delete page'))
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
          <span className={styles.headRight}>
            <button
              type="button"
              className={styles.spaceAddBtn}
              onClick={createSpace}
              title="New space"
              aria-label="New space"
              disabled={busy}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
            <span className={styles.conn}>
              <span className={`${styles.dot} ${connected ? styles.dotOn : styles.dotOff}`} aria-hidden />
              {connected ? 'live' : 'offline'}
            </span>
          </span>
        </div>
        <ul className={styles.spaces}>
          {spaces.length === 0 && <li className={styles.empty}>No spaces.</li>}
          {spaces.map((s) => {
            const active = s.id === spaceId
            const deletable = active && s.name !== PROTECTED_SPACE_NAME
            return (
              <li key={s.id} className={styles.spaceItem}>
                <button
                  type="button"
                  className={`${styles.space} ${active ? styles.spaceActive : ''}`}
                  onClick={() => selectSpace(s.id)}
                >
                  {s.name}
                </button>
                {deletable && (
                  <button
                    type="button"
                    className={styles.spaceDeleteBtn}
                    onClick={() => deleteSpace(s)}
                    title={`Delete the ${s.name} space`}
                    aria-label={`Delete the ${s.name} space`}
                    disabled={busy}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </li>
            )
          })}
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
            <FileTree
              entries={filteredTree}
              onOpen={onOpenNode}
              selectedPath={openPageId !== null ? `page/${openPageId}` : null}
              onMove={moveNode}
            />
          )}
        </div>

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
        {error && <p className={styles.error}>{error}</p>}

        {/* Who you are on this server, and the way out. */}
        <div className={styles.account}>
          <span className={styles.accountName} title={`Signed in as ${user.username}`}>
            {author}
          </span>
          <button type="button" className={styles.logoutBtn} onClick={signOut}>
            Log out
          </button>
        </div>
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
                <h1 className={styles.pageTitle}>{detail.title}</h1>
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
                <button type="button" className={styles.pageAction} onClick={openHistory}>
                  History
                </button>
                <button type="button" className={styles.pageAction} onClick={openChangelog}>
                  Changelog
                </button>
                <button type="button" className={styles.pageAction} onClick={renamePage}>
                  Rename
                </button>
                <button type="button" className={styles.pageAction} onClick={deletePage}>
                  Delete
                </button>
              </div>
            </header>

            <div className={styles.bodyWrap}>
              {editing ? (
                <div className={styles.bodyEditor}>
                  <textarea
                    ref={textareaRef}
                    className={styles.bodyTextarea}
                    value={bodyDraft ?? ''}
                    onChange={(e) => onBodyChange(e.target.value)}
                    onKeyDown={onEditorKeyDown}
                    onBlur={() => {
                      flushPending()
                      setEditing(false)
                    }}
                    placeholder="Start typing…"
                    aria-label="Page body"
                    autoFocus
                  />
                  <div className={styles.editorHint}>
                    # heading · - list · - [ ] checklist · ``` code · ⌘B bold · ⌘I italic · ⌘K link · esc done
                  </div>
                </div>
              ) : (
                <div
                  className={styles.bodyRendered}
                  onClick={onBodyClick}
                  dangerouslySetInnerHTML={{
                    __html:
                      renderPageMarkdown(detail.body) ||
                      `<p class="${styles.placeholder}">Click to start typing…</p>`,
                  }}
                />
              )}
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

        {historyOpen && (
          <div className={styles.historyPanel} role="dialog" aria-label="Page history">
            <div className={styles.historyHead}>
              <strong>History</strong> — restore an earlier saved version:
            </div>
            <ul className={styles.revisions}>
              {revisions.length === 0 && <li className={styles.empty}>No earlier revisions available.</li>}
              {revisions
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
            <button type="button" className={styles.historyClose} onClick={() => setHistoryOpen(false)}>
              Close
            </button>
          </div>
        )}

        {changelogOpen && (
          <div className={styles.historyPanel} role="dialog" aria-label="Space changelog">
            <div className={styles.historyHead}>
              <strong>Changelog</strong> — every change in {spaceName || 'this space'}, newest first:
            </div>
            <ul className={styles.revisions}>
              {changelog.length === 0 && <li className={styles.empty}>No changes recorded yet.</li>}
              {changelog.map((c) => (
                <li key={c.id} className={styles.changeEntry}>
                  <span className={styles.revMeta}>
                    {c.username} · {CHANGE_LABEL[c.action]} · {new Date(c.createdAt).toLocaleString()}
                  </span>
                  <span className={styles.revSnippet}>{c.detail || '(no detail)'}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={styles.historyClose}
              onClick={() => setChangelogOpen(false)}
            >
              Close
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

export const KbView = memo(KbViewComponent)
