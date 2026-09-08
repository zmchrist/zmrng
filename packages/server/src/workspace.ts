import { MAX_DISPLAY_NAME_LEN, MAX_MESSAGE_BODY_LEN, MAX_EMOJI_LEN } from './types.js'
import type { Db } from './db.js'
import type {
  Member,
  Message,
  MessageKind,
  ReactionSummary,
  WorkspaceMember,
  WsWorkspaceClientMsg,
  WsWorkspaceServerMsg,
} from './types.js'

/** A finite integer that could index a channel row (positive whole number). */
function isChannelId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
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
 * `undefined` rather than throwing (mirrors `terminal.ts` / `chatAgent.ts`). A
 * `hello` frame's display name is trimmed; an empty/whitespace-only name — or
 * one longer than `MAX_DISPLAY_NAME_LEN` after trimming — is rejected so it can
 * never create a blank or unbounded `members` row.
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
    if (typeof obj.displayName !== 'string') return undefined
    const displayName = obj.displayName.trim()
    return displayName.length > 0 && displayName.length <= MAX_DISPLAY_NAME_LEN
      ? { type: 'hello', displayName }
      : undefined
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
    if (!isChannelId(obj.channelId)) return undefined
    if (typeof obj.author !== 'string' || typeof obj.body !== 'string') return undefined
    const author = obj.author.trim()
    const body = obj.body.trim()
    if (author.length === 0 || author.length > MAX_DISPLAY_NAME_LEN) return undefined
    if (body.length === 0 || body.length > MAX_MESSAGE_BODY_LEN) return undefined
    // A client `message` frame carries no `kind`: an inbound socket post is
    // always `human`. Any client-supplied `kind` is ignored here so a human
    // cannot forge an `agent`-authored message (the `agent` kind is set
    // server-side by the future T4 agent path, never over this socket).
    return {
      type: 'message',
      channelId: obj.channelId,
      author,
      body,
    }
  }
  if (obj.type === 'react') {
    if (!isChannelId(obj.channelId) || !isChannelId(obj.messageId)) return undefined
    if (typeof obj.emoji !== 'string' || typeof obj.handle !== 'string') return undefined
    const emoji = obj.emoji.trim()
    const handle = obj.handle.trim()
    if (emoji.length === 0 || emoji.length > MAX_EMOJI_LEN) return undefined
    if (handle.length === 0 || handle.length > MAX_DISPLAY_NAME_LEN) return undefined
    // The reactor handle is self-asserted, exactly like a `message` frame's
    // `author` — the identity model is a free-text handle with no verification.
    return { type: 'react', channelId: obj.channelId, messageId: obj.messageId, emoji, handle }
  }
  return undefined
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
type MemberStore = Pick<Db, 'upsertMember' | 'listMembers'>

/**
 * Owns the workspace-wide presence roster: ties the `members` table to a live
 * `PresenceTracker` and a broadcast sink. Every join/leave re-broadcasts the
 * full roster snapshot (no history replay). Mirrors `TaskManager`'s
 * `(event) => hub.broadcast(event)` injection seam — tests inject a frame
 * collector, the route injects `(frame) => hub.broadcastRoom('workspace', …)`.
 */
export class WorkspaceManager {
  private presence = new PresenceTracker<object>()

  constructor(
    private db: MemberStore,
    private broadcast: (frame: WsWorkspaceServerMsg) => void,
  ) {}

  /**
   * A socket self-asserts a display name: upsert the member row, mark them
   * online, and re-broadcast the roster to every subscriber.
   */
  join(socket: object, displayName: string, now: string = new Date().toISOString()): Member {
    const member = this.db.upsertMember(displayName, now)
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
