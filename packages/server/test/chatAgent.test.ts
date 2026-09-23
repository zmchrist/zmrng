import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { config } from '../src/config.js'
import {
  ChatManager,
  chatSystemPrompt,
  parseChatClientMsg,
  voiceSystemPrompt,
  workflowDirective,
} from '../src/chatAgent.js'
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

  it('parses a well-formed start frame carrying the voice flag', () => {
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium', style: 'normal', voice: true }),
      ),
    ).toEqual({ type: 'start', model: 'sonnet', effort: 'medium', style: 'normal', voice: true })
  })

  it('ignores a non-true voice value (only literal true opts in)', () => {
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium', style: 'normal', voice: 'yes' }),
      ),
    ).toEqual({ type: 'start', model: 'sonnet', effort: 'medium', style: 'normal' })
  })

  it('parses a well-formed start frame carrying a workflow preset', () => {
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium', style: 'caveman-full', workflow: 'grill' }),
      ),
    ).toEqual({ type: 'start', model: 'sonnet', effort: 'medium', style: 'caveman-full', workflow: 'grill' })
  })

  it('defaults workflow to none by omitting it when the field is absent', () => {
    // A pre-workflow frame (no `workflow`) round-trips byte-identical — the
    // field is simply absent, and the server treats absence as `'none'`.
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium', style: 'caveman-full' }),
      ),
    ).toEqual({ type: 'start', model: 'sonnet', effort: 'medium', style: 'caveman-full' })
  })

  it('omits an explicit workflow=none so a default frame stays byte-identical', () => {
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium', style: 'normal', workflow: 'none' }),
      ),
    ).toEqual({ type: 'start', model: 'sonnet', effort: 'medium', style: 'normal' })
  })

  it('drops an ill-typed workflow value without throwing (tolerant parse)', () => {
    expect(
      parseChatClientMsg(
        JSON.stringify({ type: 'start', model: 'sonnet', effort: 'medium', style: 'normal', workflow: 42 }),
      ),
    ).toEqual({ type: 'start', model: 'sonnet', effort: 'medium', style: 'normal' })
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

  it('spawns with the spoken voice prompt (ignoring style) when voice is set', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'caveman-full', voice: true }, noopCallbacks())
    const prompt = created[0].opts.systemPrompt ?? ''
    // Voice prompt markers present; caveman skill directive absent despite the style.
    expect(prompt).toContain('spoken')
    expect(prompt).not.toContain('/caveman')
  })

  it('threads the workflow preset into the spawned system prompt', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal', workflow: 'grill' }, noopCallbacks())
    const prompt = created[0].opts.systemPrompt ?? ''
    expect(prompt).toContain('WORKING MODE:')
    expect(prompt).toContain('GRILL mode')
  })

  it('appends no working-mode block when workflow is omitted (defaults to none)', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'caveman-full' }, noopCallbacks())
    expect(created[0].opts.systemPrompt ?? '').not.toContain('WORKING MODE:')
  })

  it('leaves the voice surface unaffected by a workflow preset', () => {
    const mgr = new ChatManager(factory)
    mgr.create(
      { model: 'sonnet', effort: 'medium', style: 'normal', workflow: 'grill', voice: true },
      noopCallbacks(),
    )
    const prompt = created[0].opts.systemPrompt ?? ''
    // Voice uses voiceSystemPrompt, which never carries a working-mode block.
    expect(prompt).toContain('spoken')
    expect(prompt).not.toContain('WORKING MODE:')
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

  it('appends the inline caveman register for a non-normal style (no skill round-trip)', () => {
    // D3: the shared styleDirective now inlines the register text directly rather
    // than telling the session to invoke the `caveman` skill — chat inherits that.
    const prompt = chatSystemPrompt('caveman-full', '/tmp/projects')
    expect(prompt).toContain('COMMUNICATION STYLE:')
    expect(prompt).toContain('Drop articles (a/an/the) and filler')
    expect(prompt).not.toMatch(/Skill tool/)
    expect(prompt.toLowerCase()).not.toContain('invoke')
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

  it('appends the grill working-mode block when the grill workflow is selected', () => {
    const prompt = chatSystemPrompt('normal', '/tmp/projects', 'grill')
    expect(prompt).toContain('WORKING MODE:')
    expect(prompt).toContain('GRILL mode')
    expect(prompt).toContain('shared')
  })

  it('appends the teach-me working-mode block when the teach-me workflow is selected', () => {
    const prompt = chatSystemPrompt('normal', '/tmp/projects', 'teach-me')
    expect(prompt).toContain('WORKING MODE:')
    expect(prompt).toContain('TEACH-ME mode')
  })

  it('omits any working-mode block for the none workflow (and the default arg)', () => {
    expect(chatSystemPrompt('normal', '/tmp/projects', 'none')).not.toContain('WORKING MODE:')
    // Byte-identity: omitting the workflow arg equals passing 'none'.
    expect(chatSystemPrompt('caveman-full', '/tmp/projects')).toBe(
      chatSystemPrompt('caveman-full', '/tmp/projects', 'none'),
    )
  })

  it('composes the workflow block WITH the style block (both append)', () => {
    // caveman + grill together: the caveman register AND the grill mode coexist.
    const prompt = chatSystemPrompt('caveman-full', '/tmp/projects', 'grill')
    expect(prompt).toContain('COMMUNICATION STYLE:')
    expect(prompt).toContain('WORKING MODE:')
    expect(prompt).toContain('GRILL mode')
  })
})

describe('workflowDirective', () => {
  it('returns an empty string for none (appends nothing)', () => {
    expect(workflowDirective('none')).toBe('')
  })

  it('returns an empty string for code-review (reserved for #159)', () => {
    expect(workflowDirective('code-review')).toBe('')
  })

  it('emits a grill working-mode block encoding the grill contract', () => {
    const block = workflowDirective('grill')
    expect(block).toContain('WORKING MODE:')
    expect(block).toContain('GRILL mode')
    // Batch independent / serialize dependent questions.
    expect(block.toLowerCase()).toContain('batch')
    // Recommend an answer for every question.
    expect(block.toLowerCase()).toContain('recommend')
    // Look facts up, do not ask.
    expect(block.toLowerCase()).toContain('look')
    // Do not enact until shared understanding.
    expect(block.toLowerCase()).toContain('shared')
  })

  it('emits a teach-me working-mode block encoding a teaching register', () => {
    const block = workflowDirective('teach-me')
    expect(block).toContain('WORKING MODE:')
    expect(block).toContain('TEACH-ME mode')
    expect(block.toLowerCase()).toContain('explain')
  })
})

describe('voiceSystemPrompt', () => {
  it('scopes to the projects dir and frames a spoken assistant', () => {
    const prompt = voiceSystemPrompt('/tmp/projects')
    expect(prompt).toContain('/tmp/projects')
    expect(prompt).toContain('spoken')
  })

  it('bans markdown/lists and never uses caveman (it is a fixed natural register)', () => {
    const prompt = voiceSystemPrompt('/tmp/projects')
    expect(prompt.toLowerCase()).toContain('markdown')
    expect(prompt).not.toContain('/caveman')
    expect(prompt).toMatch(/not caveman/i)
  })

  it('is conversational — no worker control tokens or branch/PR protocol', () => {
    const prompt = voiceSystemPrompt('/tmp/projects')
    expect(prompt).not.toMatch(/ZMRNG_/)
    expect(prompt).not.toMatch(/pull request/i)
  })
})

// A deterministic id seam for the session rows (mirrors TerminalManager's).
let chatSeq: number
const chatIds = (): (() => string) => {
  chatSeq = 0
  return () => `chat-${++chatSeq}`
}

/** One usage delta, shaped like the `ResultUsage` a `result` line carries. */
const usage = (n: number): import('../src/types.js').TaskUsage => ({
  tokensIn: n,
  tokensOut: n * 2,
  tokensCache: n * 3,
  costUsd: n / 100,
  turns: 1,
})

describe('ChatManager.snapshot (lane viewer rows)', () => {
  it('reports one row per live session with its id/model/effort/style/repoId/voice', () => {
    const mgr = new ChatManager(factory, chatIds())
    mgr.create({ model: 'opus', effort: 'high', style: 'caveman-full', repoId: 'repo-a' }, noopCallbacks())
    mgr.create({ model: 'sonnet', effort: 'low', style: 'normal', voice: true }, noopCallbacks())
    const rows = mgr.snapshot()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'chat-1',
      model: 'opus',
      effort: 'high',
      style: 'caveman-full',
      repoId: 'repo-a',
      voice: false,
    })
    expect(rows[1]).toMatchObject({ id: 'chat-2', model: 'sonnet', repoId: null, voice: true })
    expect(new Date(rows[0].startedAt).toISOString()).toBe(rows[0].startedAt)
    expect(rows[0].usage).toEqual({ tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 })
  })

  it('reports repoId null for both an omitted and an unresolvable repo id (Projects root)', () => {
    const mgr = new ChatManager(factory, chatIds())
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal', repoId: 'nope' }, noopCallbacks())
    expect(mgr.snapshot().map((r) => r.repoId)).toEqual([null, null])
  })

  it('accumulates usage across results while passing the callback through unchanged', () => {
    const mgr = new ChatManager(factory, chatIds())
    const seen: Array<[string, boolean, unknown]> = []
    mgr.create(
      { model: 'sonnet', effort: 'medium', style: 'normal' },
      noopCallbacks({ onResult: (t, e, u) => seen.push([t, e, u]) }),
    )
    created[0].cb.onResult('first', false, usage(10))
    created[0].cb.onResult('second', true, usage(5))
    const acc = mgr.snapshot()[0].usage
    expect(acc).toMatchObject({ tokensIn: 15, tokensOut: 30, tokensCache: 45, turns: 2 })
    // Float summation — compare the cost within tolerance, not bit-for-bit.
    expect(acc.costUsd).toBeCloseTo(0.15, 10)
    // Pass-through contract: same args, always called, in order.
    expect(seen).toEqual([
      ['first', false, usage(10)],
      ['second', true, usage(5)],
    ])
  })

  it('tolerates a result with no usage (nothing to fold in)', () => {
    const mgr = new ChatManager(factory, chatIds())
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    created[0].cb.onResult('no usage', false, undefined)
    expect(mgr.snapshot()[0].usage.turns).toBe(0)
  })

  it('drops an exited session row and clears every row on killAll', () => {
    const mgr = new ChatManager(factory, chatIds())
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    created[0].cb.onExit(0, null)
    expect(mgr.snapshot().map((r) => r.id)).toEqual(['chat-2'])
    mgr.killAll()
    expect(mgr.snapshot()).toEqual([])
  })
})

describe('ChatManager onChange (lane emitter notify seam)', () => {
  it('fires on create, on a usage-carrying result, on exit and on killAll', () => {
    let calls = 0
    const mgr = new ChatManager(factory, chatIds(), () => {
      calls++
    })
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    expect(calls).toBe(1)
    created[0].cb.onResult('done', false, usage(1))
    expect(calls).toBe(2)
    created[0].cb.onExit(0, null)
    expect(calls).toBe(3)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    mgr.killAll()
    expect(calls).toBe(5)
  })

  it('defaults both new params so existing one-arg constructions are unchanged', () => {
    const mgr = new ChatManager(factory)
    mgr.create({ model: 'sonnet', effort: 'medium', style: 'normal' }, noopCallbacks())
    expect(mgr.snapshot()).toHaveLength(1)
    expect(mgr.snapshot()[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
