import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { config } from '../src/config.js'
import { ChatManager, chatSystemPrompt, parseChatClientMsg } from '../src/chatAgent.js'
import type { RunnerCallbacks, RunnerFactory, RunnerLike, SpawnOptions } from '../src/runner.js'

// Drives the REAL ChatManager with an INJECTED FAKE RunnerFactory, so no test
// spawns a real `claude`. `create()` reads config.projectsDir from the module
// singleton; we override it in beforeEach and restore in afterEach — the same
// save/restore-the-singleton pattern terminal.test.ts / taskManager.test.ts use.

/** A test double for a Runner: records the spawn opts + callbacks, tallies control calls. */
class FakeRunner implements RunnerLike {
  sends: string[] = []
  interruptCount = 0
  killCount = 0
  constructor(
    readonly opts: SpawnOptions,
    readonly cb: RunnerCallbacks,
  ) {}
  send(text: string): void {
    this.sends.push(text)
  }
  interrupt(): void {
    this.interruptCount++
  }
  kill(): void {
    this.killCount++
  }
}

let created: FakeRunner[]
let factory: RunnerFactory

let savedProjectsDir: string
let savedRepos: typeof config.repos

beforeEach(() => {
  created = []
  factory = (opts, cb) => {
    const r = new FakeRunner(opts, cb)
    created.push(r)
    return r
  }
  savedProjectsDir = config.projectsDir
  config.projectsDir = '/tmp/zmrng-test-projects'
  savedRepos = config.repos
  config.repos = [{ id: 'repo-a', label: 'Repo A', path: '/tmp/repo-a', defaultBranch: 'main' }]
})

afterEach(() => {
  config.projectsDir = savedProjectsDir
  config.repos = savedRepos
})

/** Minimal no-op callbacks; individual tests override the ones they assert on. */
function noopCallbacks(over: Partial<RunnerCallbacks> = {}): RunnerCallbacks {
  return {
    onSession: () => {},
    onAssistantText: () => {},
    onPartial: () => {},
    onResult: () => {},
    onToolUse: () => {},
    onSubagentResult: () => {},
    onExit: () => {},
    onSpawnError: () => {},
    ...over,
  }
}

describe('parseChatClientMsg', () => {
  it('parses a well-formed start frame', () => {
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium', style: 'caveman-full' }),
      ),
    ).toEqual({ type: 'start', model: 'sonnet', effort: 'medium', style: 'caveman-full' })
  })

  it('parses a well-formed start frame carrying a repoId', () => {
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium', style: 'caveman-full', repoId: 'repo-a' }),
      ),
    ).toEqual({ type: 'start', model: 'sonnet', effort: 'medium', style: 'caveman-full', repoId: 'repo-a' })
  })

  it('parses a well-formed input frame', () => {
    expect(parseChatClientMsg(JSON.stringify({ type: 'input', text: 'hi' }))).toEqual({
      type: 'input',
      text: 'hi',
    })
  })

  it('parses a well-formed interrupt frame', () => {
    expect(parseChatClientMsg(JSON.stringify({ type: 'interrupt' }))).toEqual({ type: 'interrupt' })
  })

  it('parses an input frame carrying valid attachments', () => {
    const att = { kind: 'image', mediaType: 'image/png', dataBase64: 'YQ==' }
    expect(
      parseChatClientMsg(JSON.stringify({ type: 'input', text: 'see this', attachments: [att] })),
    ).toEqual({
      type: 'input',
      text: 'see this',
      attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'YQ==' }],
    })
  })

  it('drops a malformed attachments field without throwing (tolerant parse)', () => {
    expect(parseChatClientMsg(JSON.stringify({ type: 'input', text: 'hi', attachments: 'oops' }))).toEqual(
      { type: 'input', text: 'hi' },
    )
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'input', text: 'hi', attachments: [{ mediaType: 'text/plain', dataBase64: 'YQ==' }] }),
      ),
    ).toEqual({ type: 'input', text: 'hi' })
  })

  it('returns undefined for near-miss cases and never throws', () => {
    expect(parseChatClientMsg('{not json')).toBeUndefined()
    expect(parseChatClientMsg(JSON.stringify({ type: 'nope' }))).toBeUndefined()
    expect(parseChatClientMsg(JSON.stringify({ type: 'input', text: 123 }))).toBeUndefined()
    expect(parseChatClientMsg(JSON.stringify({ type: 'input' }))).toBeUndefined()
    expect(
      parseChatClientMsg(JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium' })),
    ).toBeUndefined()
    expect(
      parseChatClientMsg(JSON.stringify({ type: 'start', model: 42, effort: 'medium', style: 'normal' })),
    ).toBeUndefined()
    expect(parseChatClientMsg('')).toBeUndefined()
    expect(parseChatClientMsg(JSON.stringify(['start']))).toBeUndefined()
    expect(parseChatClientMsg(JSON.stringify('start'))).toBeUndefined()
  })
})

describe('ChatManager.create (fake runner factory)', () => {
  it('spawns exactly one session at config.projectsDir with the requested model/effort', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'caveman-full' }, noopCallbacks())
    expect(created).toHaveLength(1)
    expect(created[0].opts.cwd).toBe('/tmp/zmrng-test-projects')
    expect(created[0].opts.model).toBe('sonnet')
    expect(created[0].opts.effort).toBe('medium')
    expect(created[0].opts.systemPrompt).toContain('/tmp/zmrng-test-projects')
  })

  it('spawns at the chosen repo path when repoId resolves', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'caveman-full', repoId: 'repo-a' }, noopCallbacks())
    expect(created[0].opts.cwd).toBe('/tmp/repo-a')
    expect(created[0].opts.systemPrompt).toContain('/tmp/repo-a')
  })

  it('falls back to config.projectsDir when repoId is missing or unresolvable', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'caveman-full', repoId: 'nope' }, noopCallbacks())
    expect(created[0].opts.cwd).toBe('/tmp/zmrng-test-projects')
  })

  it('routes send/interrupt/kill to the returned session', () => {
    const mgr = new ChatManager(factory)
    const session = mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    session.send('hello agent')
    session.interrupt()
    session.kill()
    expect(created[0].sends).toEqual(['hello agent'])
    expect(created[0].interruptCount).toBe(1)
    expect(created[0].killCount).toBe(1)
  })

  it('forwards the runner callbacks the route depends on', () => {
    const mgr = new ChatManager(factory)
    const partials: string[] = []
    const tools: string[] = []
    mgr.create(
      { model: 'sonnet', effort: 'medium', style: 'normal' },
      noopCallbacks({
        onPartial: (t) => partials.push(t),
        onToolUse: (name) => tools.push(name),
      }),
    )
    created[0].cb.onPartial('tok')
    created[0].cb.onToolUse('Read', 'file.ts', false)
    expect(partials).toEqual(['tok'])
    expect(tools).toEqual(['Read'])
  })

  it('a session removes itself from the tracked set on exit (killAll does not double-kill)', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    created[0].cb.onExit(0, null)
    mgr.killAll()
    expect(created[0].killCount).toBe(0)
    expect(created[1].killCount).toBe(1)
  })

  it('killAll kills every tracked session', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    mgr.killAll()
    expect(created.map((r) => r.killCount)).toEqual([1, 1])
  })
})

describe('chatSystemPrompt', () => {
  it('frames a conversational assistant scoped to the projects dir', () => {
    const prompt = chatSystemPrompt('normal', '/tmp/projects')
    expect(prompt).toContain('/tmp/projects')
  })

  it('appends the caveman skill directive for a non-normal style', () => {
    const prompt = chatSystemPrompt('caveman-full', '/tmp/projects')
    expect(prompt).toContain('caveman')
    expect(prompt.toLowerCase()).toContain('skill')
  })

  it('omits the caveman directive for the normal style', () => {
    const prompt = chatSystemPrompt('normal', '/tmp/projects')
    expect(prompt).not.toContain('/caveman')
  })

  it('is conversational — no worker control tokens or branch/PR protocol', () => {
    const prompt = chatSystemPrompt('caveman-full', '/tmp/projects')
    expect(prompt).not.toMatch(/ZMRNG_/)
    expect(prompt).not.toMatch(/pull request/i)
    expect(prompt).not.toMatch(/\bbranch\b/i)
  })
})
