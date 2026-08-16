import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { config } from '../src/config.js'
import {
  TerminalManager,
  parseClientMsg,
  type PtyCallbacks,
  type PtyFactory,
  type PtySession,
  type PtySpawnOptions,
} from '../src/terminal.js'

// Drives the REAL TerminalManager with an INJECTED FAKE PtyFactory, so no test
// spawns a real shell / PTY. `create()` reads config.projectsDir / config.shell
// / config.authMode from the module singleton, so we override those fields in
// beforeEach and restore them in afterEach — the same save/restore-the-singleton
// pattern taskManager.test.ts uses for config.repos.

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

let created: FakePty[]
let factory: PtyFactory

// Saved singleton state to restore after each test (config is a module singleton).
let savedProjectsDir: string
let savedShell: string
let savedAuthMode: typeof config.authMode
let savedApiKey: string | undefined

beforeEach(() => {
  created = []
  factory = (opts, cb) => {
    const p = new FakePty(opts, cb)
    created.push(p)
    return p
  }
  savedProjectsDir = config.projectsDir
  savedShell = config.shell
  savedAuthMode = config.authMode
  savedApiKey = process.env.ANTHROPIC_API_KEY
  config.projectsDir = '/tmp/zmrng-test-projects'
  config.shell = '/bin/test-shell'
})

afterEach(() => {
  config.projectsDir = savedProjectsDir
  config.shell = savedShell
  config.authMode = savedAuthMode
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedApiKey
})

describe('TerminalManager.create (fake pty factory)', () => {
  it('spawns at config.projectsDir with config.shell', () => {
    const mgr = new TerminalManager(factory)
    mgr.create({ onData: () => {}, onExit: () => {} })
    expect(created).toHaveLength(1)
    expect(created[0].opts.cwd).toBe('/tmp/zmrng-test-projects')
    expect(created[0].opts.shell).toBe('/bin/test-shell')
  })

  it('strips ANTHROPIC_API_KEY from the env under oauth mode', () => {
    config.authMode = 'oauth'
    process.env.ANTHROPIC_API_KEY = 'sk-throwaway-test-value'
    const mgr = new TerminalManager(factory)
    mgr.create({ onData: () => {}, onExit: () => {} })
    expect(created[0].opts.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('preserves ANTHROPIC_API_KEY under apikey mode', () => {
    config.authMode = 'apikey'
    process.env.ANTHROPIC_API_KEY = 'sk-throwaway-test-value'
    const mgr = new TerminalManager(factory)
    mgr.create({ onData: () => {}, onExit: () => {} })
    expect(created[0].opts.env.ANTHROPIC_API_KEY).toBe('sk-throwaway-test-value')
  })

  it('forwards pty onData verbatim to the onData callback', () => {
    const mgr = new TerminalManager(factory)
    const seen: string[] = []
    mgr.create({ onData: (d) => seen.push(d), onExit: () => {} })
    created[0].emitData('hello\r\n')
    created[0].emitData('[31mred[0m')
    expect(seen).toEqual(['hello\r\n', '[31mred[0m'])
  })

  it('fires the onExit callback when the pty exits', () => {
    const mgr = new TerminalManager(factory)
    const codes: Array<number | null> = []
    mgr.create({ onData: () => {}, onExit: (c) => codes.push(c) })
    created[0].emitExit(0)
    expect(codes).toEqual([0])
  })
})

describe('TerminalManager frame routing (via a returned session)', () => {
  it('an input frame → session.write with the exact data; a resize frame → session.resize', () => {
    const mgr = new TerminalManager(factory)
    const session = mgr.create({ onData: () => {}, onExit: () => {} })

    const input = parseClientMsg(JSON.stringify({ type: 'input', data: 'ls -la\n' }))
    if (input?.type === 'input') session.write(input.data)
    const resize = parseClientMsg(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    if (resize?.type === 'resize') session.resize(resize.cols, resize.rows)

    expect(created[0].writes).toEqual(['ls -la\n'])
    expect(created[0].resizes).toEqual([[120, 40]])
  })
})

describe('TerminalManager.killAll and self-removal on exit', () => {
  it('kills every tracked session', () => {
    const mgr = new TerminalManager(factory)
    mgr.create({ onData: () => {}, onExit: () => {} })
    mgr.create({ onData: () => {}, onExit: () => {} })
    mgr.killAll()
    expect(created.map((p) => p.killCount)).toEqual([1, 1])
  })

  it('a session removes itself from the tracked set on exit (killAll does not double-kill it)', () => {
    const mgr = new TerminalManager(factory)
    mgr.create({ onData: () => {}, onExit: () => {} })
    mgr.create({ onData: () => {}, onExit: () => {} })
    // First session exits: it should drop out of the tracked set.
    created[0].emitExit(0)
    mgr.killAll()
    expect(created[0].killCount).toBe(0) // already exited — never killed
    expect(created[1].killCount).toBe(1) // still live — killed once
  })
})

describe('parseClientMsg', () => {
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
    expect(parseClientMsg(JSON.stringify({ type: 'resize', cols: '80', rows: 24 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'resize', cols: 80 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'input', data: 123 }))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify({ type: 'input' }))).toBeUndefined()
    expect(parseClientMsg('')).toBeUndefined()
    expect(parseClientMsg(JSON.stringify(['input', 'x']))).toBeUndefined()
    expect(parseClientMsg(JSON.stringify('input'))).toBeUndefined()
  })
})
