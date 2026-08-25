import type { WebSocket } from 'ws'
import type { WsEvent } from './types.js'

/**
 * Fan-out hub for browser sockets. Two dimensions:
 *  - the flat `/ws` broadcast set (`add`/`send`/`broadcast`) — task + claude
 *    events to every connected browser, unchanged;
 *  - a room-routing dimension (`join`/`leaveAll`/`broadcastRoom`) for
 *    multiplexed channel sockets like `/ws/workspace`, where a frame fans out
 *    only to sockets subscribed to a given room. The two are independent — a
 *    socket can be in the flat set, one or more rooms, or both.
 */
export class WsHub {
  private sockets = new Set<WebSocket>()
  private rooms = new Map<string, Set<WebSocket>>()

  add(socket: WebSocket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => this.sockets.delete(socket))
  }

  send(socket: WebSocket, event: WsEvent): void {
    try {
      socket.send(JSON.stringify(event))
    } catch {
      // socket closed mid-send
    }
  }

  broadcast(event: WsEvent): void {
    const data = JSON.stringify(event)
    for (const socket of this.sockets) {
      try {
        socket.send(data)
      } catch {
        // drop on failure; close handler will evict it
      }
    }
  }

  /**
   * Subscribe a socket to a room. Self-evicts from the room on close/error so a
   * dead socket never lingers in the fan-out set. A socket may join many rooms.
   */
  join(room: string, socket: WebSocket): void {
    let members = this.rooms.get(room)
    if (!members) {
      members = new Set<WebSocket>()
      this.rooms.set(room, members)
    }
    members.add(socket)
    socket.on('close', () => this.leaveAll(socket))
    socket.on('error', () => this.leaveAll(socket))
  }

  /** Remove a socket from every room it joined (idempotent). */
  leaveAll(socket: WebSocket): void {
    for (const [room, members] of this.rooms) {
      members.delete(socket)
      if (members.size === 0) this.rooms.delete(room)
    }
  }

  /** Fan a pre-serialized frame out to every socket in a room (no-op if empty). */
  broadcastRoom(room: string, data: string): void {
    const members = this.rooms.get(room)
    if (!members) return
    for (const socket of members) {
      try {
        socket.send(data)
      } catch {
        // drop on failure; close handler will evict it
      }
    }
  }
}
