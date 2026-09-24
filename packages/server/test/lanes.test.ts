import { describe, it, expect } from 'vitest'
import { LaneEmitter, buildLaneSnapshot, type LaneSources } from '../src/lanes.js'
import type { TimerFns } from '../src/terminal.js'
import type { LaneChat, LaneSnapshot, LaneTerminal, LaneWorker } from '../src/types.js'

// Covers the lane-snapshot assembler and its coalescing emitter in isolation:
// `buildLaneSnapshot` is a PURE merge over the three managers' snapshot
// accessors, precisely so the payload `GET /api/lanes` and the `lanes` frame
// carry is testable without booting Fastify. The emitter's timer seam is the
// same injected `TimerFns` `TerminalManager` uses, so every test here is fully
// synchronous — no real timers, no sockets, no processes.

/** A controllable timer seam: `fireAll()` runs every still-pending callback. */
class FakeTimers implements TimerFns {
  private pending = new Map<number, () => void>()
  private next = 1
  lastDelay = 0
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = this.next++
    this.pending.set(handle, fn)
    this.lastDelay = ms
    return handle as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.pending.delete(handle as unknown as number)
  }
  fireAll(): void {
    const fns = [...this.pending.values()]
    this.pending.clear()
    for (const fn of fns) fn()
  }
  get pendingCount(): number {
    return this.pending.size
  }
}

const worker = (taskId: string): LaneWorker => ({
  taskId,
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
})

const chat = (id: string): LaneChat => ({
  id,
  model: 'sonnet',
  effort: 'medium',
  style: 'caveman-full',
  repoId: null,
  voice: false,
  startedAt: '2026-09-23T10:02:00.000Z',
  usage: { tokensIn: 1, tokensOut: 2, tokensCache: 3, costUsd: 0.04, turns: 1 },
})

const terminal = (id: string): LaneTerminal => ({
  id,
  shell: '/bin/zsh',
  cwd: '/tmp/projects',
  startedAt: '2026-09-23T10:03:00.000Z',
  attached: true,
})

/** Sources with everything populated (one busy lane, one queued task). */
function busySources(): LaneSources {
  return {
    tasks: () => ({
      execute: { cap: 4, holders: ['task-1'], queued: ['task-2'] },
      workers: [worker('task-1')],
    }),
    chats: () => [chat('chat-1')],
    terminals: () => [terminal('term-1')],
  }
}

/** Sources for a completely idle instance. */
function idleSources(): LaneSources {
  return {
    tasks: () => ({ execute: { cap: 4, holders: [], queued: [] }, workers: [] }),
    chats: () => [],
    terminals: () => [],
  }
}

describe('buildLaneSnapshot', () => {
  it('merges all three sources into a well-formed snapshot at the given instant', () => {
    const snap = buildLaneSnapshot(busySources(), '2026-09-23T10:05:00.000Z')
    expect(snap).toEqual<LaneSnapshot>({
      at: '2026-09-23T10:05:00.000Z',
      execute: { cap: 4, holders: ['task-1'], queued: ['task-2'] },
      workers: [worker('task-1')],
      chats: [chat('chat-1')],
      terminals: [terminal('term-1')],
    })
  })

  it('yields empty groups with a populated cap for an all-idle instance', () => {
    const snap = buildLaneSnapshot(idleSources(), '2026-09-23T10:05:00.000Z')
    expect(snap.execute).toEqual({ cap: 4, holders: [], queued: [] })
    expect(snap.workers).toEqual([])
    expect(snap.chats).toEqual([])
    expect(snap.terminals).toEqual([])
  })

  it('reads each source exactly once per build', () => {
    let taskCalls = 0
    let chatCalls = 0
    let termCalls = 0
    const sources: LaneSources = {
      tasks: () => {
        taskCalls++
        return { execute: { cap: 1, holders: [], queued: [] }, workers: [] }
      },
      chats: () => {
        chatCalls++
        return []
      },
      terminals: () => {
        termCalls++
        return []
      },
    }
    buildLaneSnapshot(sources, '2026-09-23T10:05:00.000Z')
    expect([taskCalls, chatCalls, termCalls]).toEqual([1, 1, 1])
  })
})

describe('LaneEmitter', () => {
  it('coalesces a burst of notify() calls into a single trailing send', () => {
    const timers = new FakeTimers()
    const sent: LaneSnapshot[] = []
    const emitter = new LaneEmitter(busySources(), (s) => sent.push(s), timers, 150, () => 'T1')

    emitter.notify()
    emitter.notify()
    emitter.notify()
    expect(sent).toEqual([]) // nothing yet — the send is trailing
    expect(timers.pendingCount).toBe(1) // one timer for the whole burst
    expect(timers.lastDelay).toBe(150)

    timers.fireAll()
    expect(sent).toHaveLength(1)
    expect(sent[0].at).toBe('T1')
    expect(sent[0].workers).toHaveLength(1)
  })

  it('sends again for a later burst (the window re-arms after it fires)', () => {
    const timers = new FakeTimers()
    const sent: LaneSnapshot[] = []
    const emitter = new LaneEmitter(busySources(), (s) => sent.push(s), timers, 150, () => 'T1')

    emitter.notify()
    timers.fireAll()
    emitter.notify()
    emitter.notify()
    expect(sent).toHaveLength(1)
    timers.fireAll()
    expect(sent).toHaveLength(2)
  })

  it('never sends when never notified', () => {
    const timers = new FakeTimers()
    const sent: LaneSnapshot[] = []
    new LaneEmitter(idleSources(), (s) => sent.push(s), timers)
    timers.fireAll()
    expect(sent).toEqual([])
    expect(timers.pendingCount).toBe(0)
  })

  it('snapshot() builds immediately without scheduling or sending', () => {
    const timers = new FakeTimers()
    const sent: LaneSnapshot[] = []
    const emitter = new LaneEmitter(busySources(), (s) => sent.push(s), timers, 150, () => 'NOW')
    const snap = emitter.snapshot()
    expect(snap.at).toBe('NOW')
    expect(snap.terminals).toEqual([terminal('term-1')])
    expect(sent).toEqual([]) // the REST path must not broadcast
    expect(timers.pendingCount).toBe(0)
  })
})
