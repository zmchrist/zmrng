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

describe('WsHub lanes frame (guards the new WsEvent variant)', () => {
  it('round-trips a lanes snapshot through broadcast and send', () => {
    const frame: WsEvent = {
      type: 'lanes',
      snapshot: {
        at: '2026-09-23T10:05:00.000Z',
        execute: { cap: 4, holders: ['task-1'], queued: ['task-2'] },
        workers: [
          {
            taskId: 'task-1',
            model: 'opus',
            effort: 'high',
            style: 'normal',
            startedAt: '2026-09-23T10:00:00.000Z',
            holdsLane: true,
            subagents: [
              {
                id: 'sa-1',
                type: 'zmrng-qa',
                status: 'running',
                description: 'run the suite',
                startedAt: '2026-09-23T10:01:00.000Z',
              },
            ],
          },
        ],
        chats: [
          {
            id: 'chat-1',
            model: 'sonnet',
            effort: 'medium',
            style: 'caveman-full',
            repoId: null,
            voice: false,
            startedAt: '2026-09-23T10:02:00.000Z',
            usage: { tokensIn: 1, tokensOut: 2, tokensCache: 3, costUsd: 0.04, turns: 1 },
          },
        ],
        terminals: [
          {
            id: 'term-1',
            shell: '/bin/zsh',
            cwd: '/tmp/projects',
            startedAt: '2026-09-23T10:03:00.000Z',
            attached: true,
          },
        ],
      },
    }
    const hub = new WsHub()
    const a = new FakeSocket()
    const b = new FakeSocket()
    hub.add(asWs(a))
    hub.broadcast(frame)
    hub.send(asWs(b), frame)
    expect(JSON.parse(a.sent[0])).toEqual(frame)
    expect(JSON.parse(b.sent[0])).toEqual(frame)
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
