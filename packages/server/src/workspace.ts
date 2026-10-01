import { MAX_MESSAGE_BODY_LEN, MAX_EMOJI_LEN } from './types.js'
import type { Db } from './db.js'
import type {
  KbPage,
  Member,
  Message,
  MessageKind,
  PublicUser,
  ReactionSummary,
  WorkspaceMember,
  WsWorkspaceClientMsg,
  WsWorkspaceServerMsg,
} from './types.js'

/**
 * Max length of a `hello` frame's bearer token. A session token is 32 random
 * bytes base64url (43 chars), so this is generous — its job is simply to stop an
 * unbounded wire field riding straight into a session lookup. It lives here
 * rather than in `types.ts` because it bounds a server-side parse, not a shape
 * the web client has to mirror.
 */
export const MAX_HELLO_TOKEN_LEN = 512

/** A finite integer that could index a channel row (positive whole number). */
function isChannelId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/** A finite positive integer that could index a KB page row. */
function isPageId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

// ---- tolerant client-frame parsing -----------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/**
 * Parse one client->server frame from the multiplexed workspace socket. Tolerant:
 * malformed JSON, an unknown `type`, or a missing/ill-typed/blank field all yield
 * `undefined` rather than throwing (mirrors `terminal.ts` / `chatAgent.ts`).
 *
 * NO frame carries identity any more. A socket is named by its AUTHENTICATED
 * session — the handshake cookie, or the bearer `token` a cross-origin client
 * puts on its `hello` — never by a free-text field on the wire. `message`,
 * `react` and `page.edit` therefore REJECT a frame that still asserts an
 * `author`/`handle`: an outdated client fails loudly instead of having its post
 * silently attributed to a server-chosen name. (`hello`'s legacy `displayName`
 * is merely dropped, not a rejection — it named nothing that gets persisted, and
 * refusing it would lock an otherwise-authenticated socket out entirely.)
 */
export function parseWorkspaceClientMsg(raw: string): WsWorkspaceClientMsg | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const obj = asRecord(parsed)
  if (!obj) return undefined
  if (obj.type === 'hello') {
    // Absent token: a same-origin socket whose identity rides the session cookie
    // sent on the HTTP handshake.
    if (obj.token === undefined) return { type: 'hello' }
    if (typeof obj.token !== 'string' || obj.token.length > MAX_HELLO_TOKEN_LEN) return undefined
    // An empty token is NO token: `resolveSocketIdentity` prefers the hello
    // token over the cookie, so letting `''` through would blank out an
    // otherwise-authenticated socket.
    return obj.token.length === 0 ? { type: 'hello' } : { type: 'hello', token: obj.token }
  }
  if (obj.type === 'ping') {
    return { type: 'ping' }
  }
  if (obj.type === 'subscribe' || obj.type === 'unsubscribe') {
    return isChannelId(obj.channelId)
      ? { type: obj.type, channelId: obj.channelId }
      : undefined
  }
  if (obj.type === 'message') {
    if (assertsIdentity(obj)) return undefined
    if (!isChannelId(obj.channelId)) return undefined
    if (typeof obj.body !== 'string') return undefined
    const body = obj.body.trim()
    if (body.length === 0 || body.length > MAX_MESSAGE_BODY_LEN) return undefined
    // A client `message` frame carries neither an author nor a `kind`: an
    // inbound socket post is always `human`, authored by the socket's
    // authenticated user. Any client-supplied `kind` is ignored here so a human
    // cannot forge an `agent`-authored message (the `agent` kind is set
    // server-side by the T4 agent path, never over this socket).
    return {
      type: 'message',
      channelId: obj.channelId,
      body,
    }
  }
  if (obj.type === 'react') {
    if (assertsIdentity(obj)) return undefined
    if (!isChannelId(obj.channelId) || !isChannelId(obj.messageId)) return undefined
    if (typeof obj.emoji !== 'string') return undefined
    const emoji = obj.emoji.trim()
    if (emoji.length === 0 || emoji.length > MAX_EMOJI_LEN) return undefined
    // The reactor is the socket's authenticated user, exactly like a `message`
    // frame's author — the wire says only WHAT was reacted, never by whom.
    return { type: 'react', channelId: obj.channelId, messageId: obj.messageId, emoji }
  }
  // ---- KB real-time sync frames (T2, #144) ----
  if (obj.type === 'page.subscribe' || obj.type === 'page.unsubscribe') {
    return isPageId(obj.pageId) ? { type: obj.type, pageId: obj.pageId } : undefined
  }
  if (obj.type === 'page.edit') {
    if (assertsIdentity(obj)) return undefined
    if (!isPageId(obj.pageId)) return undefined
    // The page `body` may be empty (a fresh page starts blank), but is capped.
    // It is NOT trimmed: leading/trailing whitespace is meaningful markdown, so
    // we preserve it verbatim and only bound its length.
    if (typeof obj.body !== 'string' || obj.body.length > MAX_MESSAGE_BODY_LEN) return undefined
    // A socket `page.edit` is ALWAYS a human edit, attributed to the socket's
    // authenticated user — mirrors the channel `message` "always human" posture.
    return {
      type: 'page.edit',
      pageId: obj.pageId,
      body: obj.body,
    }
  }
  return undefined
}

/**
 * Does this frame still try to name its own author? Identity left the wire with
 * login: the server takes it from the socket's session. A frame that asserts one
 * is refused outright rather than having the field quietly ignored — silently
 * dropping it would persist the post under a different name than the sender saw.
 */
function assertsIdentity(obj: Record<string, unknown>): boolean {
  return 'author' in obj || 'handle' in obj
}

// ---- presence tracker ------------------------------------------------------

/**
 * Connection-based presence: tracks which live sockets belong to which member.
 * A member is online while they hold at least one live socket (multi-tab safe).
 * Generic over the socket type so it is unit-testable with plain object doubles
 * — the route injects real `ws` WebSockets, tests inject `{}`.
 */
export class PresenceTracker<S = object> {
  private socketMember = new Map<S, number>()
  private memberSockets = new Map<number, Set<S>>()

  /** Associate a socket with a member (marking that member online). */
  join(socket: S, memberId: number): void {
    // If this socket was already mapped to another member, move it cleanly.
    this.leave(socket)
    this.socketMember.set(socket, memberId)
    let set = this.memberSockets.get(memberId)
    if (!set) {
      set = new Set<S>()
      this.memberSockets.set(memberId, set)
    }
    set.add(socket)
  }

  /** Drop a socket. The member goes offline only when their last socket leaves. */
  leave(socket: S): void {
    const memberId = this.socketMember.get(socket)
    if (memberId === undefined) return
    this.socketMember.delete(socket)
    const set = this.memberSockets.get(memberId)
    if (set) {
      set.delete(socket)
      if (set.size === 0) this.memberSockets.delete(memberId)
    }
  }

  /** The set of member ids currently holding at least one live socket. */
  onlineIds(): Set<number> {
    return new Set(this.memberSockets.keys())
  }

  /** Merge live presence over the full member list into a roster snapshot. */
  roster(members: Member[]): WorkspaceMember[] {
    const online = this.onlineIds()
    return members.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      online: online.has(m.id),
    }))
  }
}

// ---- workspace manager -----------------------------------------------------

/** The members-table surface the manager needs (kept narrow for testability). */
type MemberStore = Pick<Db, 'memberForUser' | 'listMembers'>

/**
 * Owns the workspace-wide presence roster: ties the `members` table to a live
 * `PresenceTracker` and a broadcast sink. Every join/leave re-broadcasts the
 * full roster snapshot (no history replay). Mirrors `TaskManager`'s
 * `(event) => hub.broadcast(event)` injection seam — tests inject a frame
 * collector, the route injects `(frame) => hub.broadcastRoom('workspace', …)`.
 *
 * A member is an AUTHENTICATED user, never a free-text handle: the roster is
 * keyed on `members.user_id`, so the same login always resolves to the same row
 * across reconnects, tabs and display-name changes.
 */
export class WorkspaceManager {
  private presence = new PresenceTracker<object>()

  constructor(
    private db: MemberStore,
    private broadcast: (frame: WsWorkspaceServerMsg) => void,
  ) {}

  /**
   * An AUTHENTICATED socket joins: resolve the user's member row (created on
   * first use, keyed on `user_id`), mark them online, and re-broadcast the
   * roster to every subscriber. The identity comes from the socket's session —
   * there is no self-asserted name to trust.
   */
  join(socket: object, user: PublicUser, now: string = new Date().toISOString()): Member {
    const member = this.db.memberForUser(user, now)
    this.presence.join(socket, member.id)
    this.broadcastRoster()
    return member
  }

  /** A socket dropped (close/error/heartbeat timeout): recompute + re-broadcast. */
  leave(socket: object): void {
    this.presence.leave(socket)
    this.broadcastRoster()
  }

  /** Current roster snapshot: every member with a live online flag. */
  roster(): WorkspaceMember[] {
    return this.presence.roster(this.db.listMembers())
  }

  private broadcastRoster(): void {
    this.broadcast({ type: 'roster', members: this.roster() })
  }
}

// ---- channel manager -------------------------------------------------------

/** The channel/message-table surface the manager needs (kept narrow for testability). */
type ChannelStore = Pick<
  Db,
  | 'listChannels'
  | 'getChannel'
  | 'addMessage'
  | 'listMessages'
  | 'getMessageChannelId'
  | 'toggleReaction'
>

/**
 * Owns channel message posting and live fan-out. Keeps the ticket's named
 * `Map<channel_id, Set<socket>>` subscription registry: a socket `subscribe`s
 * to a channel as it opens it and `unsubscribe`s (or, on disconnect,
 * `unsubscribeAll`s) as it closes it. A posted message is persisted, then fanned
 * out ONLY to the sockets currently subscribed to that channel — NO history
 * replay over the socket (scrollback is a REST concern). Generic over the socket
 * type so it is unit-testable with plain object doubles — the route injects real
 * `ws` WebSockets, tests inject `{}`. The per-socket `send` sink mirrors
 * `TaskManager`/`WorkspaceManager`'s broadcast injection.
 */
export class ChannelManager<S = object> {
  private subs = new Map<number, Set<S>>()

  constructor(
    private db: ChannelStore,
    private send: (socket: S, frame: WsWorkspaceServerMsg) => void,
  ) {}

  /** Register a socket's interest in a channel's live fan-out (idempotent). */
  subscribe(socket: S, channelId: number): void {
    let set = this.subs.get(channelId)
    if (!set) {
      set = new Set<S>()
      this.subs.set(channelId, set)
    }
    set.add(socket)
  }

  /** Drop a socket's interest in one channel (idempotent). */
  unsubscribe(socket: S, channelId: number): void {
    const set = this.subs.get(channelId)
    if (!set) return
    set.delete(socket)
    if (set.size === 0) this.subs.delete(channelId)
  }

  /** Drop a socket from every channel it was subscribed to (disconnect cleanup). */
  unsubscribeAll(socket: S): void {
    for (const [channelId, set] of this.subs) {
      set.delete(socket)
      if (set.size === 0) this.subs.delete(channelId)
    }
  }

  /**
   * Persist a message to a channel and fan it out to every subscribed socket.
   * Returns the stored message, or `undefined` if the channel does not exist
   * (in which case nothing is persisted and nothing is delivered).
   *
   * `author` is supplied BY THE CALLER and is the socket's AUTHENTICATED display
   * name (or, for `AgentResponder`, the configured bot handle) — never a field
   * off the wire, which no longer carries one.
   */
  post(
    channelId: number,
    author: string,
    body: string,
    kind: MessageKind,
    now: string = new Date().toISOString(),
  ): Message | undefined {
    if (!this.db.getChannel(channelId)) return undefined
    const message = this.db.addMessage(channelId, author, body, kind, now)
    const set = this.subs.get(channelId)
    if (set) {
      const frame: WsWorkspaceServerMsg = { type: 'message', message }
      for (const socket of set) this.send(socket, frame)
    }
    return message
  }

  /**
   * Toggle a member's emoji reaction on a message and fan the message's updated
   * reaction set out to every socket subscribed to that channel. The
   * `messageId` is validated to actually belong to `channelId` first — a
   * mismatched or unknown message is a no-op (nothing persisted, nothing
   * delivered), returning `undefined`. Returns the message's reaction set after
   * the toggle on success.
   *
   * As with `post`, `handle` is supplied BY THE CALLER from the socket's
   * AUTHENTICATED session — a `react` frame carries no handle to trust.
   */
  react(
    channelId: number,
    messageId: number,
    handle: string,
    emoji: string,
    now: string = new Date().toISOString(),
  ): ReactionSummary[] | undefined {
    if (this.db.getMessageChannelId(messageId) !== channelId) return undefined
    const reactions = this.db.toggleReaction(messageId, handle, emoji, now)
    const set = this.subs.get(channelId)
    if (set) {
      const frame: WsWorkspaceServerMsg = { type: 'reaction', channelId, messageId, reactions }
      for (const socket of set) this.send(socket, frame)
    }
    return reactions
  }
}

// ---- page manager (KB real-time sync, T2, #144) ----------------------------

/** The KB page-table surface the manager needs (kept narrow for testability). */
type PageStore = Pick<Db, 'getPage' | 'updatePageBody'>

/**
 * The KB-page analogue of `ChannelManager`. Owns per-page live whole-body fan-out
 * and lightweight page presence. Keeps the ticket's named `Map<page_id, Set<socket>>`
 * subscription registry: a socket `subscribe`s to a page as it opens it and
 * `unsubscribe`s (or, on disconnect, `unsubscribeAll`s) as it closes it. A saved
 * body is persisted, then fanned out ONLY to the sockets subscribed to
 * that page (a `page.update` frame — no history replay).
 *
 * Page presence is driven entirely by the subscribe set: `subscribe` carries the
 * subscriber's `WorkspaceMember` identity (the SEAM chosen over an injected
 * socket→member resolver — it keeps the manager self-contained and mirrors the
 * `ChannelManager` shape, and the route already has the member in hand from the
 * socket's `hello`). Every subscribe/unsubscribe (and every page left on
 * `unsubscribeAll`) re-broadcasts a `page.presence` viewer set to that page's
 * remaining subscribers. There is NO new heartbeat — the socket's existing
 * ws-level heartbeat + close handler drive eviction (via `unsubscribeAll`).
 *
 * Generic over the socket type so it is unit-testable with plain object doubles;
 * the per-socket `send` sink mirrors `ChannelManager`'s injection.
 */
export class PageManager<S = object> {
  private subs = new Map<number, Set<S>>()
  /** Viewer identity per socket, so a page's subscribe set yields a presence roster. */
  private identity = new Map<S, WorkspaceMember>()

  constructor(
    private db: PageStore,
    private send: (socket: S, frame: WsWorkspaceServerMsg) => void,
  ) {}

  /**
   * Register a socket's interest in a page's live fan-out (idempotent) and
   * record its viewer identity, then re-broadcast the page's presence set. The
   * `member` is the subscriber's roster identity (established by the socket's
   * `hello`); presence viewers reuse `WorkspaceMember` (always `online: true`).
   */
  subscribe(socket: S, pageId: number, member: WorkspaceMember): void {
    let set = this.subs.get(pageId)
    if (!set) {
      set = new Set<S>()
      this.subs.set(pageId, set)
    }
    set.add(socket)
    this.identity.set(socket, member)
    this.broadcastPresence(pageId)
  }

  /** Drop a socket's interest in one page (idempotent), then re-broadcast presence. */
  unsubscribe(socket: S, pageId: number): void {
    const set = this.subs.get(pageId)
    if (!set) return
    if (!set.delete(socket)) return
    if (set.size === 0) this.subs.delete(pageId)
    // A socket may still be viewing OTHER pages, so only forget its identity
    // once it holds no page subscriptions at all.
    if (!this.isSubscribedAnywhere(socket)) this.identity.delete(socket)
    this.broadcastPresence(pageId)
  }

  /**
   * Drop a socket from every page it was subscribed to (disconnect cleanup) and
   * re-broadcast presence to each page it left. Forgets its viewer identity.
   */
  unsubscribeAll(socket: S): void {
    const left: number[] = []
    for (const [pageId, set] of this.subs) {
      if (set.delete(socket)) {
        left.push(pageId)
        if (set.size === 0) this.subs.delete(pageId)
      }
    }
    this.identity.delete(socket)
    for (const pageId of left) this.broadcastPresence(pageId)
  }

  /**
   * Autosave a page's whole body and fan the updated page out (as `page.update`)
   * to every socket subscribed to it. The page is one continuous field — no
   * per-block delta — so concurrency is last-write-wins: whichever `page.edit`
   * lands last simply overwrites the body (Db.updatePageBody throttles a
   * prior-body snapshot into `page_revisions` first, so undo history survives
   * without recording every keystroke). Never trusts the wire: the page must
   * exist. Returns the updated page, or `undefined` on an unknown page (a
   * no-op — nothing persisted, nothing delivered).
   *
   * `actor` is the socket's AUTHENTICATED user, supplied by the caller — a
   * `page.edit` frame carries no author. Their display name lands in the page's
   * `updated_by`, and their id + username are recorded in the KB changelog
   * (throttled by `Db.updatePageBody`, so autosave does not spam the feed).
   */
  savePage(
    pageId: number,
    body: string,
    actor: PublicUser,
    now: string = new Date().toISOString(),
  ): KbPage | undefined {
    if (!this.db.getPage(pageId)) return undefined
    const page = this.db.updatePageBody(pageId, body, actor.displayName, now, {
      userId: actor.id,
      username: actor.username,
    })
    if (!page) return undefined
    const set = this.subs.get(pageId)
    if (set) {
      const frame: WsWorkspaceServerMsg = { type: 'page.update', pageId, page }
      for (const socket of set) this.send(socket, frame)
    }
    return page
  }

  /** The current viewer set for a page, deduped by member id (multi-tab safe). */
  viewers(pageId: number): WorkspaceMember[] {
    const set = this.subs.get(pageId)
    if (!set) return []
    const byId = new Map<number, WorkspaceMember>()
    for (const socket of set) {
      const member = this.identity.get(socket)
      if (member) byId.set(member.id, member)
    }
    return [...byId.values()]
  }

  /** Is this socket still subscribed to at least one page? */
  private isSubscribedAnywhere(socket: S): boolean {
    for (const set of this.subs.values()) if (set.has(socket)) return true
    return false
  }

  /** Fan the current viewer set for a page out to its remaining subscribers. */
  private broadcastPresence(pageId: number): void {
    const set = this.subs.get(pageId)
    if (!set) return
    const frame: WsWorkspaceServerMsg = { type: 'page.presence', pageId, viewers: this.viewers(pageId) }
    for (const socket of set) this.send(socket, frame)
  }
}
