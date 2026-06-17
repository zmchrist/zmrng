import type { WebSocket } from 'ws'
import type { WsEvent } from './types.js'

/** Fan-out hub: broadcasts task + claude events to every connected browser. */
export class WsHub {
  private sockets = new Set<WebSocket>()

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
}
