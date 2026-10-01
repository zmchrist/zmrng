import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavIcon } from './NavIcon'
import styles from './TeamView.module.css'
import type { Channel, Message, PublicUser, RepoTarget, WorkspaceMember, Space } from '../types'
import { MAX_DISPLAY_NAME_LEN, MAX_MESSAGE_BODY_LEN } from '../types'
import {
  mentionCandidates,
  activeMention,
  filterCandidates,
  applyMention,
  parseMentions,
  type MentionCandidate,
} from '../mentions'
import {
  encodeHello,
  encodePing,
  encodeSubscribe,
  encodeUnsubscribe,
  encodeMessage,
  encodeReact,
  parseWorkspaceServerMsg,
} from '../workspaceProtocol'
import { emptyRoster, applyWorkspaceMsg } from '../roster'
import { emptyThread, appendMessage, loadScrollback, applyReaction } from '../channelThread'
import { REACTION_EMOJI } from '../emojiSet'
import { useAutoScroll } from '../useAutoScroll'
import { api, isAuthError } from '../api'
import { clearSession, loadSession } from '../auth'
import { buildHandoffPrefill, type HandoffPrefill } from '../teamHandoff'
import { resolveDefaultSpace, deriveKbTitle } from '../kbFromMessage'
import { collectFolders, type KbFolderOption } from '../kbTree'
import { WORKSPACE_URL, workspaceSocketUrl, workspaceHttpOrigin } from '../teamConfig'
import {
  loadOpenChannelId,
  saveOpenChannelId,
  initialPane,
  resolveOpenChannelId,
  type RailTab,
  type TeamPane,
} from '../teamNav'
import { useIsMobile } from '../useIsMobile'
import { ThinkingDots } from './ThinkingDots'
import { formatMessageTime } from '../teamTime'

interface Props {
  /** The authenticated user for the TEAM origin (the VPS). Their `displayName`
   *  IS the identity here — the roster entry, the "connected as" label, the
   *  "is this reaction mine" check. It can no longer be asserted over the wire:
   *  the server stamps every post/reaction from the socket's own session. */
  user: PublicUser
  /** The session for the Team origin is gone — logged out, a 401, or an
   *  `unauthorized` frame. App re-reads the stored session and shows the login
   *  pane in place of this view. */
  onLogout: () => void
  /** The shared team-agent bot handle (default `@agent`), surfaced via
   *  GET /api/config so the `@`-mention autocomplete + highlighter know the
   *  agent's name. Visual only — the server reply trigger is unchanged. */
  botHandle: string
  /** The teammate's OWN local repo registry (GET /api/repos), used to populate
   *  the create-channel repo select — a channel repo id is a free-text tag. */
  repos: RepoTarget[]
  /** Lift a "Send to my zmrng" handoff up to App: switch to Workspace and seed
   *  the local new-task box with this brief (T3, decision D6). */
  onSendToZmrng: (prefill: HandoffPrefill) => void
  /** After promoting a message into a KB page (T4, #154), switch to the KB tab
   *  and open the freshly created page. Optional — the promotion still succeeds
   *  server-side without navigating. */
  onOpenKbPage?: (spaceId: number, pageId: number) => void
  /** Bubble a `new-version` frame's sha up to App (WS-B / D3). TeamView owns the
   *  socket but NOT the update banner — the phase-gate needs App's `tasks`. */
  onNewVersion?: (sha: string) => void
  /** Report the newest message id the operator has now READ in a channel —
   *  fired when a channel is open on the active Team tab, and again as live
   *  messages land while they watch it. Clears that channel's unread orb in
   *  App. Per channel by design: switching to the Team tab alone clears
   *  nothing. */
  onChannelRead?: (channelId: number, messageId: number) => void
  /** Whether the Team tab is the ACTIVE mode. The view is always mounted (App
   *  keeps it in the DOM via `display:none`), so the workspace socket is gated
   *  on this flag: an idle client on another mode opens ZERO sockets, entering
   *  the Team tab opens exactly one, and leaving tears it down (the socket
   *  effect's cleanup closes the ws + clears timers). Prevents the always-
   *  mounted view from holding a permanent /ws/workspace socket + duplicate
   *  presence membership (#149). */
  active: boolean
}

// Both derived once from the fixed code constant (teamConfig.WORKSPACE_URL) —
// the whole team shares one VPS, so there is nothing to configure and nothing
// that can go missing across a rebuild or reboot. `HTTP_ORIGIN` is the VPS REST
// surface for channel list/create/scrollback: that data lives on the VPS, not
// the teammate's local server, so those calls MUST be origin-prefixed —
// otherwise a channel is created in the local SQLite and no teammate sees it.
const SOCKET_URL = workspaceSocketUrl(WORKSPACE_URL)
const HTTP_ORIGIN = workspaceHttpOrigin(WORKSPACE_URL)

const PING_MS = 25000
const RECONNECT_MS = 2000
const SCROLLBACK_LIMIT = 50

/** Render a channel's name with the conventional leading `#`. */
function channelLabel(name: string): string {
  return `#${name}`
}

/**
 * The Team mode surface: connects to the configured VPS team-workspace server
 * over ONE multiplexed WebSocket as the AUTHENTICATED user, lists channels,
 * opens one, renders its messages (scrollback via REST + live NEW messages via
 * the socket), and posts to it via a composer. Human and agent messages render
 * distinguishably (box 6). Local task execution is untouched.
 *
 * App only mounts this once the Team origin holds a session, so there is no
 * unauthenticated branch in here — and no self-asserted handle anywhere: the
 * server attributes every post, reaction and presence entry from the session
 * behind the socket.
 *
 * This is connection glue (like WorkspaceGrid) — the wire protocol, roster +
 * channel-thread reducers, and config resolution it composes are each
 * unit-tested in isolation.
 */
function TeamViewComponent({
  user,
  onLogout,
  botHandle,
  repos,
  onSendToZmrng,
  onOpenKbPage,
  onNewVersion,
  onChannelRead,
  active,
}: Props) {
  // The roster identity is the AUTHENTICATED user's display name — no local
  // copy and nothing to type. The server derives the same name from the
  // socket's session, so this is what the thread will show us as.
  const handle = user.displayName
  const [roster, setRoster] = useState<WorkspaceMember[]>(emptyRoster)
  const [connected, setConnected] = useState(false)
  const [channels, setChannels] = useState<Channel[]>([])
  // The open channel is restored from localStorage so the Team tab reopens
  // where it was left (both shells), and on the phone that also decides which
  // pane we land on.
  const [openId, setOpenId] = useState<number | null>(loadOpenChannelId)
  // Which rail list is showing. Channels and roster are tabs now, not a stack.
  const [railTab, setRailTab] = useState<RailTab>('channels')
  // The phone shell's current full-screen pane. Ignored on desktop, where the
  // rail and the thread sit side by side.
  const [pane, setPane] = useState<TeamPane>(() => initialPane(loadOpenChannelId()))
  const [thread, setThread] = useState<Message[]>(emptyThread)
  const [composer, setComposer] = useState('')
  // Reaction UI: `pickerFor` is the message id whose emoji picker is open (null =
  // none); `whoFor` is the message+emoji whose "who reacted" popup is open. Only
  // one of each is open at a time — opening one closes the other.
  const [pickerFor, setPickerFor] = useState<number | null>(null)
  const [whoFor, setWhoFor] = useState<{ messageId: number; emoji: string } | null>(null)
  // True after the operator posts a message that mentions the agent, until the
  // agent's reply message lands — the team `@agent` reply is a whole message
  // (no token streaming), so the dots fill the entire wait. Cleared on channel
  // switch/leave so a stale wait never bleeds into another channel.
  const [awaitingAgent, setAwaitingAgent] = useState(false)
  // `@`-mention autocomplete state for the channel composer. `mentionStart` is
  // the index of the active `@`; `mentionMatches` is the live-filtered candidate
  // list (empty ⇒ dropdown closed); `mentionIndex` is the highlighted row.
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionMatches, setMentionMatches] = useState<MentionCandidate[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const composerRef = useRef<HTMLInputElement | null>(null)
  // Create-channel affordance state (T3). The list itself refreshes via the
  // server's `channels` broadcast over the shared socket.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRepo, setNewRepo] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // "Send to KB" picker state (T4, #154). `kbFor` is the {channel, message}
  // being promoted (null = picker closed). Space/folder/title are the editable
  // target; the server rebuilds the canonical provenance regardless.
  const [kbFor, setKbFor] = useState<{ channel: Channel; message: Message } | null>(null)
  const [kbSpaces, setKbSpaces] = useState<Space[]>([])
  const [kbSpaceId, setKbSpaceId] = useState<number | null>(null)
  const [kbFolders, setKbFolders] = useState<KbFolderOption[]>([])
  const [kbFolderId, setKbFolderId] = useState('') // '' = space root
  const [kbTitle, setKbTitle] = useState('')
  const [kbBusy, setKbBusy] = useState(false)
  const [kbError, setKbError] = useState<string | null>(null)
  const isMobile = useIsMobile()
  const wsRef = useRef<WebSocket | null>(null)
  // Latest open-channel id, readable inside the stable socket onmessage closure.
  const openIdRef = useRef<number | null>(null)
  useEffect(() => {
    openIdRef.current = openId
    saveOpenChannelId(openId)
  }, [openId])
  // Keep the latest `onNewVersion` readable inside the stable socket closure
  // (the socket effect only re-runs when the tab activates), like openIdRef.
  const onNewVersionRef = useRef(onNewVersion)
  useEffect(() => {
    onNewVersionRef.current = onNewVersion
  }, [onNewVersion])
  // Thread auto-scroll: jumps to the bottom on new content only if the user
  // was already at/near the bottom (never yanks them away from scrollback);
  // `scrollToBottom` force-scrolls regardless, used for our own posts and on
  // channel switch.
  const {
    ref: threadRef,
    onScroll: onThreadScroll,
    scrollToBottom,
    notifyContentChanged: notifyThreadChanged,
  } = useAutoScroll<HTMLUListElement>()
  useEffect(() => {
    notifyThreadChanged()
  }, [thread, notifyThreadChanged])

  // Reading the open channel clears its unread orb. Reported through a ref-held
  // callback so a new prop identity never re-runs the report on its own.
  const onChannelReadRef = useRef(onChannelRead)
  useEffect(() => {
    onChannelReadRef.current = onChannelRead
  }, [onChannelRead])
  useEffect(() => {
    if (!active || openId === null || thread.length === 0) return
    const newest = thread.reduce((max, m) => (m.id > max ? m.id : max), 0)
    if (newest > 0) onChannelReadRef.current?.(openId, newest)
  }, [active, openId, thread])

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
    clearSession(HTTP_ORIGIN)
    onLogoutRef.current()
  }, [])

  /**
   * One REST failure handler for this surface: an expired/absent session hands
   * the view back to the login pane rather than rendering a raw error, and
   * returns true so the caller skips its own error text.
   */
  const handledAuthError = useCallback(
    (err: unknown): boolean => {
      if (!isAuthError(err)) return false
      gateAgain()
      return true
    },
    [gateAgain],
  )

  /** Revoke the session server-side, then re-gate the surface. */
  const signOut = (): void => {
    void api
      .logout(HTTP_ORIGIN)
      // A dead session 401s and an unreachable server throws; either way this
      // client logs out locally — a logout button must always log you out.
      .catch(() => undefined)
      .then(() => gateAgain())
  }

  /** Send a pre-encoded frame if the socket is live (dropped otherwise). */
  const sendFrame = (data: string): void => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(data)
  }

  // ---- socket lifecycle (presence + live message delivery) ----
  // Gated on `active` (#149): only the active Team mode holds a workspace
  // socket. When `active` flips false the effect cleanup below runs (closes the
  // ws, clears timers, nulls wsRef, setConnected(false)) — so leaving the tab
  // tears the socket down; returning re-runs the effect and connects fresh.
  useEffect(() => {
    if (!active) return
    let closed = false
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      try {
        ws = new WebSocket(SOCKET_URL)
      } catch {
        reconnect = setTimeout(connect, RECONNECT_MS)
        return
      }
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        // Identity has left the wire: the server derives it from the session.
        // A cross-origin socket has no cookie it can send (D2), so the stored
        // bearer token rides the `hello` frame; same-origin it is absent and
        // the handshake cookie is what authenticates.
        ws?.send(encodeHello(loadSession(HTTP_ORIGIN)?.token))
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(encodePing())
        }, PING_MS)
      }
      ws.onmessage = (ev) => {
        const msg = parseWorkspaceServerMsg(String(ev.data))
        if (!msg) return
        if (msg.type === 'message') {
          // Only the currently-open channel's live messages hit the thread.
          if (msg.message.channelId === openIdRef.current) {
            setThread((prev) => appendMessage(prev, msg.message))
            // The agent's reply landed — stop the thinking dots.
            if (msg.message.kind === 'agent') setAwaitingAgent(false)
          }
        } else if (msg.type === 'reaction') {
          // A live reaction change for the open channel: swap that message's set.
          if (msg.channelId === openIdRef.current) {
            setThread((prev) => applyReaction(prev, msg.messageId, msg.reactions))
          }
        } else if (msg.type === 'channels') {
          setChannels(msg.channels)
        } else if (msg.type === 'unauthorized') {
          // The handshake presented no valid session (it expired, or another
          // tab logged out). The server closes the socket; stop reconnecting
          // and hand the surface back to the login pane instead of looping.
          closed = true
          gateAgain()
          ws?.close()
        } else if (msg.type === 'new-version') {
          // Bubble UP to App — it owns `tasks` (for the D3a phase-gate) and the
          // global update banner. TeamView just relays the signal.
          onNewVersionRef.current?.(msg.sha)
        } else {
          setRoster((prev) => applyWorkspaceMsg(prev, msg))
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
      setRoster(emptyRoster())
    }
  }, [active, gateAgain])

  // ---- load the channel list once connected; default to the first channel ----
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    api
      .listChannels(HTTP_ORIGIN)
      .then((list) => {
        if (cancelled) return
        setChannels(list)
        setOpenId((cur) => resolveOpenChannelId(cur, list))
      })
      .catch((err: unknown) => {
        // A dead session re-gates the surface; anything else is transient — the
        // socket stays live and a reconnect retries this.
        if (!cancelled) handledAuthError(err)
      })
    return () => {
      cancelled = true
    }
  }, [connected, handledAuthError])

  // ---- open a channel: REST scrollback + subscribe to live fan-out ----
  // The thread is reset in the channel-switch handlers (not here) to keep this
  // effect free of synchronous setState; on a plain reconnect the scrollback
  // page merges (deduped) into whatever live messages already arrived.
  useEffect(() => {
    if (!connected || openId === null) return
    let cancelled = false
    api
      .getChannelMessages(openId, { limit: SCROLLBACK_LIMIT }, HTTP_ORIGIN)
      .then((page) => {
        if (!cancelled) setThread((prev) => loadScrollback(prev, page))
      })
      .catch((err: unknown) => {
        // scrollback failed — live messages still flow once subscribed, unless
        // the session itself is gone, which re-gates the surface.
        if (!cancelled) handledAuthError(err)
      })
    sendFrame(encodeSubscribe(openId))
    return () => {
      cancelled = true
      sendFrame(encodeUnsubscribe(openId))
    }
  }, [connected, openId, handledAuthError])

  /** Switch the open channel, clearing the previous channel's thread. On the
   *  phone this also navigates from the list pane into the thread pane. */
  const openChannelId = (id: number): void => {
    setPane('thread')
    if (id === openId) return
    scrollToBottom()
    setThread(emptyThread())
    setPickerFor(null)
    setWhoFor(null)
    setAwaitingAgent(false)
    setOpenId(id)
  }

  // ---- `@`-mention autocomplete (visual only; the agent trigger is server-side) ----
  // Candidates = roster displayNames + the agent (bot handle minus a leading @);
  // `mentionNames` drives the in-thread pill highlighter.
  const candidates = useMemo(() => mentionCandidates(roster, botHandle), [roster, botHandle])
  const mentionNames = useMemo(() => candidates.map((c) => c.name), [candidates])
  // The agent's mention name (bot handle minus a leading `@`), used to tell
  // whether an outgoing message will trigger an `@agent` reply worth waiting on.
  const agentName = useMemo(() => botHandle.replace(/^@/, ''), [botHandle])

  /** Recompute the dropdown from the composer's current value + caret. */
  const refreshMention = (value: string, caret: number): void => {
    const active = activeMention(value, caret)
    if (!active) {
      setMentionStart(null)
      setMentionMatches([])
      return
    }
    const matches = filterCandidates(candidates, active.query)
    setMentionStart(matches.length ? active.start : null)
    setMentionMatches(matches)
    setMentionIndex(0)
  }

  const closeMention = (): void => {
    setMentionStart(null)
    setMentionMatches([])
  }

  const onComposerChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const el = e.currentTarget
    setComposer(el.value)
    refreshMention(el.value, el.selectionStart ?? el.value.length)
  }

  /** Track caret moves (click, arrow keys while closed) so `@` context stays fresh. */
  const onComposerSelect = (e: React.SyntheticEvent<HTMLInputElement>): void => {
    const el = e.currentTarget
    refreshMention(el.value, el.selectionStart ?? el.value.length)
  }

  /** Insert the chosen candidate, replacing the active `@query`, and restore caret. */
  const chooseMention = (cand: MentionCandidate): void => {
    if (mentionStart === null) return
    const el = composerRef.current
    const caret = el?.selectionStart ?? composer.length
    const { text, caret: nextCaret } = applyMention(composer, mentionStart, caret, cand.name)
    setComposer(text)
    closeMention()
    requestAnimationFrame(() => {
      const node = composerRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (mentionMatches.length === 0) return // closed → let Enter submit as usual
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionMatches.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
        break
      case 'Enter':
      case 'Tab':
        e.preventDefault()
        chooseMention(mentionMatches[mentionIndex] ?? mentionMatches[0])
        break
      case 'Escape':
        e.preventDefault()
        closeMention()
        break
    }
  }

  const onSend = (e: React.FormEvent) => {
    e.preventDefault()
    const body = composer.trim()
    if (!body || openId === null) return
    // Posted human message returns via the channel fan-out (we are subscribed),
    // so it appears in the thread through the live socket — no optimistic append.
    scrollToBottom()
    sendFrame(encodeMessage(openId, body))
    // If the message mentions the agent, expect a reply — show the dots until it
    // lands. Word-boundary match mirrors the server's @agent reply trigger.
    if (
      agentName &&
      parseMentions(body, [agentName]).some((seg) => seg.type === 'mention')
    ) {
      setAwaitingAgent(true)
    }
    setComposer('')
    closeMention()
  }

  /**
   * Toggle my emoji reaction on a message. The updated set returns via the live
   * `reaction` fan-out (we are subscribed), so there is no optimistic update —
   * the pill re-renders when the server broadcasts back. Closes the picker.
   */
  const toggleReaction = (messageId: number, emoji: string): void => {
    if (openId === null || !connected) return
    sendFrame(encodeReact(openId, messageId, emoji))
    setPickerFor(null)
  }

  /** Open the emoji picker for one message (closing any who-popup / other picker). */
  const openPicker = (messageId: number): void => {
    setWhoFor(null)
    setPickerFor((cur) => (cur === messageId ? null : messageId))
  }

  /** Toggle the "who reacted" popup for one message+emoji (closing the picker). */
  const toggleWho = (messageId: number, emoji: string): void => {
    setPickerFor(null)
    setWhoFor((cur) =>
      cur && cur.messageId === messageId && cur.emoji === emoji
        ? null
        : { messageId, emoji },
    )
  }

  // Create a channel over REST (T3). The server broadcasts the refreshed list to
  // the workspace room, so every connected teammate's rail (including this one)
  // updates via the `channels` socket frame — no manual setChannels needed here.
  const onCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name || createBusy) return
    setCreateBusy(true)
    setCreateError(null)
    try {
      const created = await api.createChannel(name, newRepo || null, HTTP_ORIGIN)
      setNewName('')
      setNewRepo('')
      setCreating(false)
      // Open the freshly created channel (the broadcast populates the rail).
      setChannels((prev) =>
        prev.some((c) => c.id === created.id) ? prev : [...prev, created],
      )
      openChannelId(created.id)
    } catch (err) {
      if (!handledAuthError(err)) {
        setCreateError(err instanceof Error ? err.message : 'Failed to create channel')
      }
    } finally {
      setCreateBusy(false)
    }
  }

  /** Hand a channel message off to the local zmrng new-task box (T3). */
  const sendMessageToZmrng = (channel: Channel, message: Message): void => {
    onSendToZmrng(buildHandoffPrefill(channel, message))
  }

  /** Load a space's folders (flattened) into the KB picker's folder select. */
  const loadKbFolders = async (spaceId: number): Promise<void> => {
    try {
      const tree = await api.getSpaceTree(spaceId)
      setKbFolders(collectFolders(tree))
    } catch (err) {
      if (!handledAuthError(err)) setKbFolders([])
    }
  }

  /** Open the "Send to KB" picker for a message (T4). Loads the KB spaces, best-
   *  effort defaults the target space by channel-name match (→ general), and
   *  seeds an editable title derived from the message body. */
  const openKbPicker = async (channel: Channel, message: Message): Promise<void> => {
    setKbFor({ channel, message })
    setKbTitle(deriveKbTitle(message.body))
    setKbFolderId('')
    setKbFolders([])
    setKbError(null)
    try {
      const spaces = await api.getSpaces()
      setKbSpaces(spaces)
      const target = resolveDefaultSpace(channel.name, spaces)
      const sid = target?.id ?? null
      setKbSpaceId(sid)
      if (sid !== null) await loadKbFolders(sid)
    } catch (err) {
      if (!handledAuthError(err)) {
        setKbError(err instanceof Error ? err.message : 'Failed to load KB spaces')
      }
    }
  }

  /** Switch the picker's target space and refresh its folder list. */
  const onKbSpaceChange = (value: string): void => {
    const sid = value ? Number(value) : null
    setKbSpaceId(sid)
    setKbFolderId('')
    if (sid !== null) void loadKbFolders(sid)
    else setKbFolders([])
  }

  /** Promote the selected message into a durable KB page (T4). The server builds
   *  the page body + provenance canonically; on success, navigate to the page. */
  const submitKb = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!kbFor || kbSpaceId === null || kbBusy) return
    setKbBusy(true)
    setKbError(null)
    try {
      const page = await api.createPageFromMessage(kbSpaceId, {
        messageId: kbFor.message.id,
        folderId: kbFolderId ? Number(kbFolderId) : null,
        title: kbTitle.trim() || undefined,
      })
      setKbFor(null)
      onOpenKbPage?.(page.spaceId, page.id)
    } catch (err) {
      if (!handledAuthError(err)) {
        setKbError(err instanceof Error ? err.message : 'Failed to create page')
      }
    } finally {
      setKbBusy(false)
    }
  }

  /** Close the KB picker without promoting. */
  const closeKbPicker = (): void => setKbFor(null)

  const onlineCount = roster.filter((m) => m.online).length
  const openChannel = channels.find((c) => c.id === openId) ?? null
  // Phone shell: exactly ONE of the rail / thread panes is on screen at a time
  // (a channel must be open for the thread pane to mean anything). Desktop is
  // untouched — both are always rendered side by side.
  const effectivePane: TeamPane = openChannel ? pane : 'list'
  const showRail = !isMobile || effectivePane === 'list'
  const showThread = !isMobile || effectivePane === 'thread'

  return (
    <div className={styles.team}>
      <div className={styles.teamHead}>
        <span className={styles.you}>
          <span
            className={`${styles.dot} ${connected ? styles.dotOn : styles.dotOff}`}
            aria-hidden="true"
          />
          {connected ? 'connected' : 'connecting…'} as <strong>{handle}</strong>
          <button
            type="button"
            className={styles.logoutBtn}
            onClick={signOut}
            title="Log out of the team workspace"
          >
            log out
          </button>
        </span>
      </div>

      <div className={styles.body}>
        {showRail && (
        <div className={styles.rail}>
          <div className={styles.railTabs} role="tablist" aria-label="Channels and roster">
            <button
              type="button"
              role="tab"
              aria-selected={railTab === 'channels'}
              className={`${styles.railTab} ${railTab === 'channels' ? styles.railTabActive : ''}`}
              onClick={() => setRailTab('channels')}
            >
              Channels
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={railTab === 'roster'}
              className={`${styles.railTab} ${railTab === 'roster' ? styles.railTabActive : ''}`}
              onClick={() => setRailTab('roster')}
            >
              Roster
              <span className={styles.railTabCount}>{onlineCount}</span>
            </button>
          </div>
          {railTab === 'channels' && (
          <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Channels</span>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => {
                setCreating((v) => !v)
                setCreateError(null)
              }}
              title={creating ? 'Cancel' : 'New channel'}
            >
              {creating ? <NavIcon name="close" /> : <><NavIcon name="plus" /> new</>}
            </button>
          </div>
          {creating && (
            <form className={styles.createForm} onSubmit={onCreateChannel}>
              <input
                className={styles.input}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="channel-name"
                maxLength={MAX_DISPLAY_NAME_LEN}
                autoFocus
              />
              <select
                className={styles.select}
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
              >
                <option value="">No repo (like #general)</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              {createError && <span className={styles.createError}>{createError}</span>}
              <button
                type="submit"
                className={styles.primaryBtn}
                disabled={!newName.trim() || createBusy}
              >
                {createBusy ? 'Creating…' : 'Create channel'}
              </button>
            </form>
          )}
          <ul className={styles.channels}>
            {channels.length === 0 && <li className={styles.railEmpty}>No channels yet.</li>}
            {channels.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`${styles.channel} ${c.id === openId ? styles.channelActive : ''}`}
                  onClick={() => openChannelId(c.id)}
                >
                  {channelLabel(c.name)}
                  {c.repoId && <span className={styles.channelRepoDot} title={c.repoId} />}
                </button>
              </li>
            ))}
          </ul>
          </>
          )}

          {railTab === 'roster' && (
          <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Roster</span>
            <span className={styles.rosterCount}>
              {onlineCount} online · {roster.length} total
            </span>
          </div>
          <ul className={styles.roster}>
            {roster.length === 0 && <li className={styles.railEmpty}>No members yet.</li>}
            {roster.map((m) => (
              <li key={m.id} className={styles.member}>
                <span
                  className={`${styles.dot} ${m.online ? styles.dotOn : styles.dotOff}`}
                  aria-hidden="true"
                />
                <span className={styles.memberName}>{m.displayName}</span>
              </li>
            ))}
          </ul>
          </>
          )}
        </div>
        )}

        {showThread && (
        <div className={styles.channelPane}>
          {openChannel ? (
            <>
              <div className={styles.channelHead}>
                {isMobile && (
                  <button
                    type="button"
                    className={styles.backBtn}
                    onClick={() => setPane('list')}
                    aria-label="Back to channels"
                    title="Back to channels"
                  >
                    ‹
                  </button>
                )}
                <span className={styles.channelName}>{channelLabel(openChannel.name)}</span>
                {openChannel.repoId && (
                  <span className={styles.channelRepo}>{openChannel.repoId}</span>
                )}
              </div>
              <ul className={styles.thread} ref={threadRef} onScroll={onThreadScroll}>

                {thread.length === 0 && <li className={styles.threadEmpty}>No messages yet.</li>}
                {thread.map((m) => (
                  <li
                    key={m.id}
                    className={`${styles.message} ${
                      m.kind === 'agent' ? styles.messageAgent : styles.messageHuman
                    }`}
                  >
                    <span className={styles.messageAuthor}>
                      {m.author}
                      {m.kind === 'agent' && <span className={styles.agentTag}>agent</span>}
                      <button
                        type="button"
                        className={styles.sendZmrng}
                        onClick={() => sendMessageToZmrng(openChannel, m)}
                        title="Create a local zmrng task from this message"
                      >
                        Send to my zmrng
                      </button>
                      <button
                        type="button"
                        className={styles.sendKb}
                        onClick={() => void openKbPicker(openChannel, m)}
                        title="Promote this message into a durable KB page"
                      >
                        Send to KB
                      </button>
                      <time className={styles.messageTime} dateTime={m.createdAt}>
                        {formatMessageTime(m.createdAt)}
                      </time>
                    </span>
                    <span className={styles.messageBody}>
                      {parseMentions(m.body, mentionNames).map((seg, idx) =>
                        seg.type === 'mention' ? (
                          <span key={idx} className={styles.mention}>
                            {seg.text}
                          </span>
                        ) : (
                          <span key={idx}>{seg.text}</span>
                        ),
                      )}
                    </span>
                    <div className={styles.reactions}>
                      {(m.reactions ?? []).map((r) => {
                        const mine = r.handles.includes(handle)
                        const whoOpen =
                          whoFor?.messageId === m.id && whoFor.emoji === r.emoji
                        return (
                          <span className={styles.reactionPill} key={r.emoji}>
                            <button
                              type="button"
                              className={`${styles.reactBtn} ${mine ? styles.reactBtnMine : ''}`}
                              onClick={() => toggleReaction(m.id, r.emoji)}
                              disabled={!connected}
                              aria-pressed={mine}
                              title={mine ? 'Remove your reaction' : `React ${r.emoji}`}
                            >
                              <span className={styles.reactEmoji}>{r.emoji}</span>
                            </button>
                            <button
                              type="button"
                              className={styles.reactCount}
                              onClick={() => toggleWho(m.id, r.emoji)}
                              title="Who reacted"
                              aria-label={`${r.handles.length} reacted with ${r.emoji} — show who`}
                            >
                              {r.handles.length}
                            </button>
                            {whoOpen && (
                              <div className={styles.whoPopup} role="dialog">
                                <span className={styles.whoHead}>
                                  {r.emoji} reacted
                                </span>
                                <ul className={styles.whoList}>
                                  {r.handles.map((h, i) => (
                                    <li key={`${h}:${i}`} className={styles.whoName}>
                                      {h}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </span>
                        )
                      })}
                      <span className={styles.reactionPill}>
                        <button
                          type="button"
                          className={styles.addReactBtn}
                          onClick={() => openPicker(m.id)}
                          disabled={!connected}
                          title="Add reaction"
                          aria-label="Add reaction"
                        >
                          <NavIcon name="smile" />
                        </button>
                        {pickerFor === m.id && (
                          <div
                            className={styles.picker}
                            role="dialog"
                            aria-label="Pick an emoji"
                          >
                            {REACTION_EMOJI.map((e) => (
                              <button
                                type="button"
                                key={e}
                                className={styles.pickerEmoji}
                                onClick={() => toggleReaction(m.id, e)}
                                title={e}
                              >
                                {e}
                              </button>
                            ))}
                          </div>
                        )}
                      </span>
                    </div>
                  </li>
                ))}
                {awaitingAgent && (
                  <li className={`${styles.message} ${styles.messageAgent}`}>
                    <span className={styles.messageAuthor}>
                      {agentName || 'agent'}
                      <span className={styles.agentTag}>agent</span>
                    </span>
                    <span className={styles.messageBody}>
                      <ThinkingDots />
                    </span>
                  </li>
                )}
              </ul>
              <form className={styles.composer} onSubmit={onSend}>
                <div className={styles.composerWrap}>
                  {mentionMatches.length > 0 && (
                    <ul className={styles.mentionMenu}>
                      {mentionMatches.map((cand, idx) => (
                        <li key={`${cand.kind}:${cand.name}`}>
                          <button
                            type="button"
                            className={`${styles.mentionItem} ${
                              idx === mentionIndex ? styles.mentionItemActive : ''
                            }`}
                            // Keep composer focus (avoid the input's blur closing the menu first).
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => chooseMention(cand)}
                          >
                            <span>{cand.name}</span>
                            {cand.kind === 'agent' && (
                              <span className={styles.mentionTag}>agent</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <input
                    ref={composerRef}
                    className={styles.input}
                    type="text"
                    value={composer}
                    onChange={onComposerChange}
                    onKeyDown={onComposerKeyDown}
                    onSelect={onComposerSelect}
                    onBlur={closeMention}
                    placeholder={`Message ${channelLabel(openChannel.name)}`}
                    maxLength={MAX_MESSAGE_BODY_LEN}
                    disabled={!connected}
                  />
                </div>
                <button
                  type="submit"
                  className={styles.primaryBtn}
                  disabled={!composer.trim() || !connected}
                >
                  Send
                </button>
              </form>
            </>
          ) : (
            <div className={styles.threadEmpty}>Select a channel to start chatting.</div>
          )}
        </div>
        )}
      </div>

      {kbFor && (
        <div
          className={styles.kbOverlay}
          role="dialog"
          aria-label="Send to KB"
          onClick={closeKbPicker}
        >
          <form
            className={styles.kbCard}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void submitKb(e)}
          >
            <span className={styles.kbHead}>Send to KB</span>
            <span className={styles.kbSub}>
              Promote this message from {channelLabel(kbFor.channel.name)} into a durable KB page.
            </span>
            <label className={styles.kbLabel}>
              Space
              <select
                className={styles.kbSelect}
                value={kbSpaceId ?? ''}
                onChange={(e) => onKbSpaceChange(e.target.value)}
              >
                {kbSpaces.length === 0 && <option value="">No spaces</option>}
                {kbSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.kbLabel}>
              Folder
              <select
                className={styles.kbSelect}
                value={kbFolderId}
                onChange={(e) => setKbFolderId(e.target.value)}
              >
                <option value="">(space root)</option>
                {kbFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.kbLabel}>
              Title
              <input
                className={styles.kbInput}
                type="text"
                value={kbTitle}
                onChange={(e) => setKbTitle(e.target.value)}
                placeholder="Page title"
              />
            </label>
            {kbError && <span className={styles.kbError}>{kbError}</span>}
            <div className={styles.kbActions}>
              <button type="button" className={styles.kbCancel} onClick={closeKbPicker}>
                Cancel
              </button>
              <button
                type="submit"
                className={styles.kbSubmit}
                disabled={kbSpaceId === null || kbBusy}
              >
                {kbBusy ? 'Creating…' : 'Create page'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

export const TeamView = memo(TeamViewComponent)
