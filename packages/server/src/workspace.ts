import type { Db } from './db.js'
import type {
  Member,
  WorkspaceMember,
  WsWorkspaceClientMsg,
  WsWorkspaceServerMsg,
} from './types.js'

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
 * `hello` frame's display name is trimmed; an empty/whitespace-only name is
 * rejected so it can never create a blank `members` row.
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
    return displayName.length > 0 ? { type: 'hello', displayName } : undefined
  }
  if (obj.type === 'ping') {
    return { type: 'ping' }
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
