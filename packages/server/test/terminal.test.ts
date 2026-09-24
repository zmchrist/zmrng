import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { config } from '../src/config.js'
import {
  TerminalManager,
  parseClientMsg,
  type PtyCallbacks,
  type PtyFactory,
  type PtySession,
  type PtySpawnOptions,
  type TimerFns,
} from '../src/terminal.js'

// Drives the REAL TerminalManager with an INJECTED FAKE PtyFactory, a FAKE timer
// seam (so grace-window expiry is driven synchronously, never real wall-clock),
// and a deterministic id factory — so no test spawns a real shell / PTY or waits
// on time. `attach()` reads config.projectsDir / config.shell / config.authMode /
// config.terminalGraceMs / config.terminalBufferBytes from the module singleton,
// so we override those in beforeEach and restore them in afterEach — the same
// save/restore-the-singleton pattern taskManager.test.ts uses for config.repos.

/** A test double for a node-pty session: records forwarded calls, drives callbacks. */
class FakePty implements PtySession {
  writes: string[] = []
  resizes: Array<[number, number]> = []
  killCount = 0
  constructor(
    readonly opts: PtySpawnOptions,
    readonly cb: PtyCallbacks,
  ) {}
  write(data: string): void {
    this.writes.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(): void {
    this.killCount++
  }
  /** Simulate the pty emitting output. */
  emitData(data: string): void {
    this.cb.onData(data)
  }
  /** Simulate the pty process exiting. */
  emitExit(code: number | null): void {
    this.cb.onExit(code)
  }
}

/** A controllable timer seam: records scheduled callbacks; `fire()` runs the last
 *  still-pending one so a test drives grace expiry without real time. */
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
  /** Run every still-pending timer callback (simulate the grace window elapsing). */
  fireAll(): void {
    const fns = [...this.pending.values()]
    this.pending.clear()
    for (const fn of fns) fn()
  }
  get pendingCount(): number {
    return this.pending.size
  }
}

let created: FakePty[]
let factory: PtyFactory
let timers: FakeTimers
let seq: number
let idFactory: () => string

/** Build a manager wired to the fake factory/timers/id seam. */
function makeManager(): TerminalManager {
  return new TerminalManager(factory, timers, idFactory)
}

// Saved singleton state to restore after each test (config is a module singleton).
let savedProjectsDir: string
let savedShell: string
let savedAuthMode: typeof config.authMode
let savedGraceMs: number
let savedBufferBytes: number
let savedApiKey: string | undefined

beforeEach(() => {
  created = []
  factory = (opts, cb) => {
    const p = new FakePty(opts, cb)
    created.push(p)
    return p
  }
  timers = new FakeTimers()
  seq = 0
  idFactory = () => `sess-${++seq}`
  savedProjectsDir = config.projectsDir
  savedShell = config.shell
  savedAuthMode = config.authMode
  savedGraceMs = config.terminalGraceMs
  savedBufferBytes = config.terminalBufferBytes
  savedApiKey = process.env.ANTHROPIC_API_KEY
  config.projectsDir = '/tmp/zmrng-test-projects'
  config.shell = '/bin/test-shell'
  config.terminalGraceMs = 600000
  config.terminalBufferBytes = 262144
})

afterEach(() => {
  config.projectsDir = savedProjectsDir
  config.shell = savedShell
  config.authMode = savedAuthMode
  config.terminalGraceMs = savedGraceMs
  config.terminalBufferBytes = savedBufferBytes
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedApiKey
})

describe('TerminalManager.attach (spawn a new session)', () => {
  it('spawns at config.projectsDir with config.shell and returns a fresh id + empty replay', () => {
    const mgr = makeManager()
    const { sessionId, replay } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    expect(created).toHaveLength(1)
    expect(created[0].opts.cwd).toBe('/tmp/zmrng-test-projects')
    expect(created[0].opts.shell).toBe('/bin/test-shell')
    expect(sessionId).toBe('sess-1')
    expect(replay).toBe('')
  })

  it('spawns a fresh session when the requested id is unknown/expired', () => {
    const mgr = makeManager()
    const { sessionId, replay } = mgr.attach('long-gone', { onData: () => {}, onExit: () => {} })
    expect(created).toHaveLength(1)
    expect(sessionId).toBe('sess-1')
    expect(replay).toBe('')
  })

  it('strips ANTHROPIC_API_KEY from the env under oauth mode', () => {
    config.authMode = 'oauth'
    process.env.ANTHROPIC_API_KEY = 'sk-throwaway-test-value'
    const mgr = makeManager()
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    expect(created[0].opts.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('preserves ANTHROPIC_API_KEY under apikey mode', () => {
    config.authMode = 'apikey'
    process.env.ANTHROPIC_API_KEY = 'sk-throwaway-test-value'
    const mgr = makeManager()
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    expect(created[0].opts.env.ANTHROPIC_API_KEY).toBe('sk-throwaway-test-value')
  })

  it('forwards pty onData verbatim to the attached onData callback', () => {
    const mgr = makeManager()
    const seen: string[] = []
    mgr.attach(undefined, { onData: (d) => seen.push(d), onExit: () => {} })
    created[0].emitData('hello\r\n')
    created[0].emitData('[31mred[0m')
    expect(seen).toEqual(['hello\r\n', '[31mred[0m'])
  })

  it('fires the onExit callback when the pty exits', () => {
    const mgr = makeManager()
    const codes: Array<number | null> = []
    mgr.attach(undefined, { onData: () => {}, onExit: (c) => codes.push(c) })
    created[0].emitExit(0)
    expect(codes).toEqual([0])
  })
})

describe('TerminalManager.write / resize', () => {
  it('routes input to the session pty and resizes it', () => {
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.write(sessionId, 'ls -la\n')
    mgr.resize(sessionId, 120, 40)
    expect(created[0].writes).toEqual(['ls -la\n'])
    expect(created[0].resizes).toEqual([[120, 40]])
  })

  it('write/resize are no-ops for an unknown session id', () => {
    const mgr = makeManager()
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    expect(() => {
      mgr.write('nope', 'x')
      mgr.resize('nope', 80, 24)
    }).not.toThrow()
    expect(created[0].writes).toEqual([])
    expect(created[0].resizes).toEqual([])
  })
})

describe('TerminalManager detach + reattach (survives a socket drop)', () => {
  it('reattach returns the buffered output and routes new output to the new callback', () => {
    const mgr = makeManager()
    const first: string[] = []
    const { sessionId } = mgr.attach(undefined, { onData: (d) => first.push(d), onExit: () => {} })
    created[0].emitData('build running...\n')
    created[0].emitData('step 2\n')

    mgr.detach(sessionId)
    // Output while detached keeps recording into the buffer, not the old callback.
    created[0].emitData('step 3 (while detached)\n')

    const second: string[] = []
    const { sessionId: sameId, replay } = mgr.attach(sessionId, {
      onData: (d) => second.push(d),
      onExit: () => {},
    })
    expect(sameId).toBe(sessionId)
    expect(replay).toBe('build running...\nstep 2\nstep 3 (while detached)\n')
    expect(created).toHaveLength(1) // no new pty spawned — same shell

    created[0].emitData('after reattach\n')
    expect(second).toEqual(['after reattach\n'])
    expect(first).toEqual(['build running...\n', 'step 2\n']) // old cb stops receiving
  })

  it('the grace timer kills the pty when nothing reattaches in time', () => {
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.detach(sessionId)
    expect(timers.lastDelay).toBe(600000)
    expect(created[0].killCount).toBe(0) // still alive during the grace window
    timers.fireAll()
    expect(created[0].killCount).toBe(1)
    // The id is gone — a later attach with it spawns a fresh session.
    mgr.attach(sessionId, { onData: () => {}, onExit: () => {} })
    expect(created).toHaveLength(2)
  })

  it('reattaching before expiry cancels the grace timer (pty stays alive)', () => {
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.detach(sessionId)
    mgr.attach(sessionId, { onData: () => {}, onExit: () => {} })
    expect(timers.pendingCount).toBe(0) // cancelled
    timers.fireAll() // nothing to fire
    expect(created[0].killCount).toBe(0)
  })

  it('detach is a no-op for an unknown session id', () => {
    const mgr = makeManager()
    expect(() => mgr.detach('nope')).not.toThrow()
    expect(timers.pendingCount).toBe(0)
  })
})

describe('TerminalManager takeover (second attach to a still-attached session)', () => {
  it('the old callback stops receiving and the new one replays', () => {
    const mgr = makeManager()
    const first: string[] = []
    const { sessionId } = mgr.attach(undefined, { onData: (d) => first.push(d), onExit: () => {} })
    created[0].emitData('history\n')

    const second: string[] = []
    const { replay } = mgr.attach(sessionId, { onData: (d) => second.push(d), onExit: () => {} })
    expect(replay).toBe('history\n')

    created[0].emitData('new output\n')
    expect(second).toEqual(['new output\n'])
    expect(first).toEqual(['history\n']) // old attach no longer receives
  })
})

describe('TerminalManager ring buffer cap', () => {
  it('drops oldest bytes so the replay never exceeds the byte cap', () => {
    config.terminalBufferBytes = 10
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    // Push 12 single-byte chunks; cap is 10.
    for (let i = 0; i < 12; i++) created[0].emitData(String(i % 10))
    const { replay } = mgr.attach(sessionId, { onData: () => {}, onExit: () => {} })
    expect(Buffer.byteLength(replay)).toBeLessThanOrEqual(10)
    // The newest bytes are retained.
    expect(replay.endsWith('1')).toBe(true)
  })

  it('trims a single oversized chunk down to its tail', () => {
    config.terminalBufferBytes = 5
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    created[0].emitData('abcdefghij') // one 10-byte chunk, cap 5
    const { replay } = mgr.attach(sessionId, { onData: () => {}, onExit: () => {} })
    expect(replay).toBe('fghij')
  })
})

describe('TerminalManager.killAll and self-removal on exit', () => {
  it('kills every tracked session', () => {
    const mgr = makeManager()
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.killAll()
    expect(created.map((p) => p.killCount)).toEqual([1, 1])
  })

  it('a session removes itself on exit (killAll does not double-kill it)', () => {
    const mgr = makeManager()
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    created[0].emitExit(0) // first exits: drops out of the map
    mgr.killAll()
    expect(created[0].killCount).toBe(0) // already exited — never killed
    expect(created[1].killCount).toBe(1) // still live — killed once
  })

  it('clears a pending grace timer on shutdown', () => {
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.detach(sessionId)
    expect(timers.pendingCount).toBe(1)
    mgr.killAll()
    expect(timers.pendingCount).toBe(0)
    expect(created[0].killCount).toBe(1)
  })
})

describe('parseClientMsg', () => {
  it('parses a well-formed attach frame with a session id', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'attach', sessionId: 's-1', cols: 80, rows: 24 }))).toEqual({
      type: 'attach',
      sessionId: 's-1',
      cols: 80,
      rows: 24,
    })
  })

  it('parses an attach frame without a session id (fresh tab)', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'attach', cols: 100, rows: 30 }))).toEqual({
      type: 'attach',
      cols: 100,
      rows: 30,
    })
  })

  it('parses a well-formed input frame', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'input', data: 'x' }))).toEqual({
      type: 'input',
      data: 'x',
    })
  })

  it('parses a well-formed resize frame', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }))).toEqual({
      type: 'resize',
      cols: 80,
      rows: 24,
    })
  })

  it('returns undefined for near-miss cases and never throws', () => {
    expect(parseClientMsg('{not json')).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'nope' }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'attach', cols: 80 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'attach', cols: '80', rows: 24 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'attach', sessionId: 42, cols: 80, rows: 24 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'resize', cols: '80', rows: 24 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'resize', cols: 80 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'input', data: 123 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'input' }))).toBeUndefined()
    expect(parseClientMsg('')).toBeUndefined()
    expect(parseClientMsg(JSON.stringify(['input', 'x']))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify('input'))).toBeUndefined()
  })
})

describe('TerminalManager.snapshot (lane viewer rows)', () => {
  it('lists every live session with its shell, cwd and startedAt', () => {
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    const rows = mgr.snapshot()
    expect(rows.map((r) => r.id)).toEqual([sessionId, 'sess-2'])
    expect(rows[0].shell).toBe('/bin/test-shell')
    expect(rows[0].cwd).toBe('/tmp/zmrng-test-projects')
    // An ISO instant, not a Date — the frame is JSON.
    expect(new Date(rows[0].startedAt).toISOString()).toBe(rows[0].startedAt)
  })

  it('reports attached true while a socket is on it, false once detached, true again on reattach', () => {
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    expect(mgr.snapshot()[0].attached).toBe(true)
    // Detached but still ALIVE inside the grace window — the row stays, the flag flips.
    mgr.detach(sessionId)
    expect(mgr.snapshot()).toHaveLength(1)
    expect(mgr.snapshot()[0].attached).toBe(false)
    mgr.attach(sessionId, { onData: () => {}, onExit: () => {} })
    expect(mgr.snapshot()[0].attached).toBe(true)
  })

  it('drops a session that exits', () => {
    const mgr = makeManager()
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    created[0].emitExit(0)
    expect(mgr.snapshot().map((r) => r.id)).toEqual(['sess-2'])
  })

  it('drops a session reaped by the grace timer', () => {
    const mgr = makeManager()
    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.detach(sessionId)
    expect(mgr.snapshot()).toHaveLength(1)
    timers.fireAll()
    expect(mgr.snapshot()).toEqual([])
  })

  it('killAll empties the snapshot', () => {
    const mgr = makeManager()
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.killAll()
    expect(mgr.snapshot()).toEqual([])
  })
})

describe('TerminalManager onChange (lane emitter notify seam)', () => {
  it('fires on spawn, detach, reattach, grace reap, exit and killAll', () => {
    let calls = 0
    const mgr = new TerminalManager(factory, timers, idFactory, () => {
      calls++
    })

    const { sessionId } = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    expect(calls).toBe(1) // spawn
    mgr.detach(sessionId)
    expect(calls).toBe(2) // detach (attached flipped)
    mgr.attach(sessionId, { onData: () => {}, onExit: () => {} })
    expect(calls).toBe(3) // reattach
    mgr.detach(sessionId)
    timers.fireAll()
    expect(calls).toBe(5) // detach + grace reap

    const second = mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    expect(second.sessionId).toBe('sess-2')
    created[1].emitExit(0)
    expect(calls).toBe(7) // spawn + exit

    mgr.attach(undefined, { onData: () => {}, onExit: () => {} })
    mgr.killAll()
    expect(calls).toBe(9) // spawn + killAll
  })

  it('defaults to a no-op so existing three-arg constructions are unchanged', () => {
    const mgr = new TerminalManager(factory, timers, idFactory)
    expect(() => mgr.attach(undefined, { onData: () => {}, onExit: () => {} })).not.toThrow()
  })
})
