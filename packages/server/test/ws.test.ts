import { describe, it, expect } from 'vitest'
import type { WebSocket } from 'ws'
import { WsHub } from '../src/ws.js'
import type { WsEvent } from '../src/types.js'

/**
 * A minimal WebSocket test double: records sent frames and captured lifecycle
 * handlers so a test can simulate a close/error. Cast to `WebSocket` at the
 * call site — the hub only ever calls `send` / `on('close'|'error')`.
 */
class FakeSocket {
  sent: string[] = []
  private handlers = new Map<string, () => void>()
  send(data: string): void {
    this.sent.push(data)
  }
  on(event: string, cb: () => void): this {
    this.handlers.set(event, cb)
    return this
  }
  /** Simulate the underlying socket closing. */
  emitClose(): void {
    this.handlers.get('close')?.()
  }
  emitError(): void {
    this.handlers.get('error')?.()
  }
}

const asWs = (s: FakeSocket): WebSocket => s as unknown as WebSocket

const snapshot: WsEvent = { type: 'snapshot', tasks: [] }

describe('WsHub broadcast (existing flat fan-out — unchanged)', () => {
  it('broadcasts to every added socket', () => {
    const hub = new WsHub()
    const a = new FakeSocket()
    const b = new FakeSocket()
    hub.add(asWs(a))
    hub.add(asWs(b))
    hub.broadcast(snapshot)
    const data = JSON.stringify(snapshot)
    expect(a.sent).toEqual([data])
    expect(b.sent).toEqual([data])
  })

  it('drops a socket from the broadcast set on close', () => {
    const hub = new WsHub()
    const a = new FakeSocket()
    hub.add(asWs(a))
    a.emitClose()
    hub.broadcast(snapshot)
    expect(a.sent).toEqual([])
  })
})

describe('WsHub room routing (team workspace T1)', () => {
  it('broadcastRoom reaches only sockets joined to that room', () => {
    const hub = new WsHub()
    const a = new FakeSocket()
    const b = new FakeSocket()
    const c = new FakeSocket()
    hub.join('workspace', asWs(a))
    hub.join('workspace', asWs(b))
    hub.join('other', asWs(c))

    hub.broadcastRoom('workspace', 'hi')
    expect(a.sent).toEqual(['hi'])
    expect(b.sent).toEqual(['hi'])
    expect(c.sent).toEqual([])
  })

  it('a socket joined to a room stops receiving after it closes', () => {
    const hub = new WsHub()
    const a = new FakeSocket()
    const b = new FakeSocket()
    hub.join('workspace', asWs(a))
    hub.join('workspace', asWs(b))
    a.emitClose()

    hub.broadcastRoom('workspace', 'hi')
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual(['hi'])
  })

  it('leaveAll removes a socket from every room it joined', () => {
    const hub = new WsHub()
    const a = new FakeSocket()
    hub.join('workspace', asWs(a))
    hub.join('other', asWs(a))
    hub.leaveAll(asWs(a))

    hub.broadcastRoom('workspace', 'x')
    hub.broadcastRoom('other', 'y')
    expect(a.sent).toEqual([])
  })

  it('broadcastRoom on an unknown room is a no-op (never throws)', () => {
    const hub = new WsHub()
    expect(() => hub.broadcastRoom('nope', 'x')).not.toThrow()
  })
})
