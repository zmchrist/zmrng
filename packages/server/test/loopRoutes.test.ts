import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_LOOP_TEXT_LEN, registerLoopRoutes } from '../src/loopRoutes.js'
import type { LoopRoutesManager } from '../src/loopRoutes.js'
import { LOOP_MAX_LANES } from '../src/types.js'
import type { LoopEvent, LoopLoadResponse, LoopRun, LoopRunView } from '../src/types.js'

// ---- fixtures ---------------------------------------------------------------

const ZERO_USAGE = { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 }

function fakeRun(id: string): LoopRun {
  return {
    id,
    repoId: 'zmrng',
    epic: 7,
    title: 'Epic',
    status: 'draft',
    prevStatus: null,
    lanes: 1,
    integBranch: `gauntlet/${id.slice(0, 8)}/integ`,
    integWorktree: '/tmp/integ',
    priority: [],
    prUrl: null,
    note: null,
    usage: ZERO_USAGE,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
}

function fakeView(id: string): LoopRunView {
  return {
    run: fakeRun(id),
    tickets: [],
    lanes: [],
    orchestratorAlive: true,
    orchestratorBusy: false,
    pool: { used: 0, max: LOOP_MAX_LANES },
    load: null,
  }
}

const LOAD: LoopLoadResponse = {
  cores: 8,
  loadAvg1: 2,
  loadPerCore: 0.25,
  memTotalMb: 16384,
  memAvailableMb: 8192,
  maxLoadPerCore: 1,
  minFreeMemMb: 2048,
  allowsNewLane: true,
  reason: null,
  sampledAt: '2026-10-01T00:00:00.000Z',
  pool: { used: 1, max: LOOP_MAX_LANES },
}

/** An error shaped like `LoopError` (the routes duck-type on `status`). */
class StatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * A stub manager: records every call as `[method, ...args]` and answers with a
 * fixture view. `known` is the only run id that exists; any other id throws a
 * 404-shaped error, the way the real `LoopManager` does.
 */
function stubManager(): { loop: LoopRoutesManager; calls: unknown[][] } {
  const calls: unknown[][] = []
  const known = 'run-1234abcd'
  const check = (id: string): void => {
    if (id !== known) throw new StatusError(404, `loop run ${id} not found`)
  }
  const viewOf = async (method: string, id: string, ...rest: unknown[]): Promise<LoopRunView> => {
    calls.push([method, id, ...rest])
    check(id)
    return fakeView(id)
  }
  const loop: LoopRoutesManager = {
    load: async () => {
      calls.push(['load'])
      return LOAD
    },
    listRuns: () => {
      calls.push(['listRuns'])
      return [fakeRun(known)]
    },
    view: (id) => {
      calls.push(['view', id])
      check(id)
      return fakeView(id)
    },
    events: (id, limit) => {
      calls.push(['events', id, limit])
      check(id)
      const ev: LoopEvent = {
        id: 1,
        runId: id,
        ticket: null,
        kind: 'chat',
        payload: { role: 'operator', text: 'hi' },
        createdAt: '2026-10-01T00:00:00.000Z',
      }
      return [ev]
    },
    createRun: async (req) => {
      calls.push(['createRun', req])
      if (req.repoId === 'no-slug') throw new StatusError(400, 'repo has no GitHub origin')
      return fakeView(known)
    },
    start: (id) => viewOf('start', id),
    pause: (id) => viewOf('pause', id),
    setLanes: (id, count) => viewOf('setLanes', id, count),
    setPriority: (id, order) => viewOf('setPriority', id, order),
    refresh: (id) => viewOf('refresh', id),
    addTicket: (id, n) => viewOf('addTicket', id, n),
    skipTicket: (id, n) => viewOf('skipTicket', id, n),
    stopTicket: (id, n) => viewOf('stopTicket', id, n),
    retryTicket: (id, n) => viewOf('retryTicket', id, n),
    answer: (id, n, text) => viewOf('answer', id, n, text),
    chat: async (id, text) => {
      calls.push(['chat', id, text])
      check(id)
    },
    resume: (id) => viewOf('resume', id),
    archive: async (id) => {
      calls.push(['archive', id])
      check(id)
    },
  }
  return { loop, calls }
}

const RUN = 'run-1234abcd'
const BASE = `/api/loop/runs/${RUN}`

let app: FastifyInstance
let calls: unknown[][]

beforeEach(async () => {
  const stub = stubManager()
  calls = stub.calls
  app = Fastify()
  registerLoopRoutes(app, { loop: stub.loop })
  await app.ready()
})
afterEach(async () => {
  await app.close()
})

/** POST a JSON body (content-type set, as the orchestrator's curl does). */
function postJson(url: string, body: unknown) {
  return app.inject({ method: 'POST', url, payload: body as Record<string, unknown> })
}

// ---- reads ------------------------------------------------------------------

describe('loop routes — reads', () => {
  it('GET /api/loop/load returns the manager sample with the pool', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/loop/load' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(LOAD)
    expect(calls).toEqual([['load']])
  })

  it('GET /api/loop/runs lists runs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/loop/runs' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as LoopRun[])[0]?.id).toBe(RUN)
  })

  it('GET /api/loop/runs/:id returns the view, 404 for an unknown run', async () => {
    const ok = await app.inject({ method: 'GET', url: BASE })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as LoopRunView).run.id).toBe(RUN)
    const missing = await app.inject({ method: 'GET', url: '/api/loop/runs/nope' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: 'loop run nope not found' })
  })

  it('GET …/events passes a validated limit (default undefined)', async () => {
    const plain = await app.inject({ method: 'GET', url: `${BASE}/events` })
    expect(plain.statusCode).toBe(200)
    const limited = await app.inject({ method: 'GET', url: `${BASE}/events?limit=50` })
    expect(limited.statusCode).toBe(200)
    expect(calls).toEqual([
      ['events', RUN, undefined],
      ['events', RUN, 50],
    ])
  })

  it.each(['0', '-3', 'abc', '1.5', '1001'])('GET …/events rejects limit=%s with 400', async (limit) => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/events?limit=${limit}` })
    expect(res.statusCode).toBe(400)
    expect(calls).toEqual([])
  })
})

// ---- run creation -----------------------------------------------------------

describe('loop routes — POST /api/loop/runs', () => {
  it('creates a run with 201 and forwards { repoId, epic, lanes }', async () => {
    const res = await postJson('/api/loop/runs', { repoId: 'zmrng', epic: 7, lanes: 2 })
    expect(res.statusCode).toBe(201)
    expect((res.json() as LoopRunView).run.id).toBe(RUN)
    expect(calls).toEqual([['createRun', { repoId: 'zmrng', epic: 7, lanes: 2 }]])
  })

  it('omits lanes when the body does not carry it', async () => {
    const res = await postJson('/api/loop/runs', { repoId: 'zmrng', epic: 7 })
    expect(res.statusCode).toBe(201)
    expect(calls).toEqual([['createRun', { repoId: 'zmrng', epic: 7 }]])
  })

  it.each([
    ['missing repoId', { epic: 7 }],
    ['blank repoId', { repoId: '  ', epic: 7 }],
    ['non-int epic', { repoId: 'zmrng', epic: 7.5 }],
    ['string epic', { repoId: 'zmrng', epic: '7' }],
    ['zero epic', { repoId: 'zmrng', epic: 0 }],
    ['lanes above the cap', { repoId: 'zmrng', epic: 7, lanes: LOOP_MAX_LANES + 1 }],
    ['negative lanes', { repoId: 'zmrng', epic: 7, lanes: -1 }],
  ])('400 on %s', async (_label, body) => {
    const res = await postJson('/api/loop/runs', body)
    expect(res.statusCode).toBe(400)
    expect(typeof (res.json() as { error: unknown }).error).toBe('string')
    expect(calls).toEqual([])
  })

  it('400 on a bodyless create', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/loop/runs' })
    expect(res.statusCode).toBe(400)
  })

  it("maps the manager's status error (repo without a GitHub slug) to that status", async () => {
    const res = await postJson('/api/loop/runs', { repoId: 'no-slug', epic: 7 })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'repo has no GitHub origin' })
  })
})

// ---- bodyless run actions ---------------------------------------------------

describe('loop routes — bodyless run actions', () => {
  it.each([
    ['start', 'start'],
    ['pause', 'pause'],
    ['resume', 'resume'],
    ['refresh', 'refresh'],
  ])('POST …/%s calls %s with no body and no content-type', async (route, method) => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/${route}` })
    expect(res.statusCode).toBe(200)
    expect((res.json() as LoopRunView).run.id).toBe(RUN)
    expect(calls).toEqual([[method, RUN]])
  })

  it('POST …/archive answers { ok: true }', async () => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/archive` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(calls).toEqual([['archive', RUN]])
  })

  it('404 for an unknown run', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/loop/runs/nope/start' })
    expect(res.statusCode).toBe(404)
  })

  it('a non-status error becomes a 500 with its message', async () => {
    const broken = Fastify()
    const { loop } = stubManager()
    registerLoopRoutes(broken, {
      loop: {
        ...loop,
        start: async () => {
          throw new Error('boom')
        },
      },
    })
    const res = await broken.inject({ method: 'POST', url: `${BASE}/start` })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'boom' })
    await broken.close()
  })
})

// ---- run actions with a body -------------------------------------------------

describe('loop routes — lanes / priority', () => {
  it.each([0, 1, LOOP_MAX_LANES])('POST …/lanes accepts count %i', async (count) => {
    const res = await postJson(`${BASE}/lanes`, { count })
    expect(res.statusCode).toBe(200)
    expect(calls).toEqual([['setLanes', RUN, count]])
  })

  it.each([
    ['above the cap', { count: LOOP_MAX_LANES + 1 }],
    ['negative', { count: -1 }],
    ['fractional', { count: 1.5 }],
    ['a string', { count: '2' }],
    ['missing', {}],
  ])('POST …/lanes rejects a count that is %s', async (_label, body) => {
    const res = await postJson(`${BASE}/lanes`, body)
    expect(res.statusCode).toBe(400)
    expect(calls).toEqual([])
  })

  it('POST …/priority forwards the order', async () => {
    const res = await postJson(`${BASE}/priority`, { order: [12, 4, 9] })
    expect(res.statusCode).toBe(200)
    expect(calls).toEqual([['setPriority', RUN, [12, 4, 9]]])
  })

  it.each([
    ['not an array', { order: '12,4' }],
    ['carrying a non-int', { order: [12, 'x'] }],
    ['carrying zero', { order: [0] }],
    ['missing', {}],
  ])('POST …/priority rejects an order %s', async (_label, body) => {
    const res = await postJson(`${BASE}/priority`, body)
    expect(res.statusCode).toBe(400)
    expect(calls).toEqual([])
  })
})

// ---- tickets ------------------------------------------------------------------

describe('loop routes — tickets', () => {
  it('POST …/tickets adds a ticket by number', async () => {
    const res = await postJson(`${BASE}/tickets`, { number: 42 })
    expect(res.statusCode).toBe(200)
    expect(calls).toEqual([['addTicket', RUN, 42]])
  })

  it.each([{ number: 0 }, { number: -2 }, { number: 'x' }, {}])(
    'POST …/tickets rejects %j',
    async (body) => {
      const res = await postJson(`${BASE}/tickets`, body)
      expect(res.statusCode).toBe(400)
      expect(calls).toEqual([])
    },
  )

  it('DELETE …/tickets/:n skips the ticket', async () => {
    const res = await app.inject({ method: 'DELETE', url: `${BASE}/tickets/42` })
    expect(res.statusCode).toBe(200)
    expect(calls).toEqual([['skipTicket', RUN, 42]])
  })

  it.each([
    ['stop', 'stopTicket'],
    ['retry', 'retryTicket'],
  ])('POST …/tickets/:n/%s calls %s (bodyless)', async (route, method) => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/tickets/42/${route}` })
    expect(res.statusCode).toBe(200)
    expect(calls).toEqual([[method, RUN, 42]])
  })

  it.each(['0', '-1', 'abc', '4.2'])('400 on a ticket number of %s', async (n) => {
    const stop = await app.inject({ method: 'POST', url: `${BASE}/tickets/${n}/stop` })
    expect(stop.statusCode).toBe(400)
    const del = await app.inject({ method: 'DELETE', url: `${BASE}/tickets/${n}` })
    expect(del.statusCode).toBe(400)
    expect(calls).toEqual([])
  })

  it('POST …/tickets/:n/answer forwards trimmed text', async () => {
    const res = await postJson(`${BASE}/tickets/42/answer`, { text: '  use option B  ' })
    expect(res.statusCode).toBe(200)
    expect(calls).toEqual([['answer', RUN, 42, 'use option B']])
  })

  it.each([
    ['empty', { text: '' }],
    ['whitespace', { text: '   ' }],
    ['not a string', { text: 3 }],
    ['missing', {}],
    ['too long', { text: 'x'.repeat(MAX_LOOP_TEXT_LEN + 1) }],
  ])('POST …/answer rejects %s text', async (_label, body) => {
    const res = await postJson(`${BASE}/tickets/42/answer`, body)
    expect(res.statusCode).toBe(400)
    expect(calls).toEqual([])
  })
})

// ---- orchestrator chat ------------------------------------------------------

describe('loop routes — chat', () => {
  it('POST …/chat forwards the operator message and answers { ok: true }', async () => {
    const res = await postJson(`${BASE}/chat`, { text: 'raise lanes to 2' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(calls).toEqual([['chat', RUN, 'raise lanes to 2']])
  })

  it('POST …/chat rejects empty text and an unknown run', async () => {
    const empty = await postJson(`${BASE}/chat`, { text: ' ' })
    expect(empty.statusCode).toBe(400)
    const missing = await postJson('/api/loop/runs/nope/chat', { text: 'hi' })
    expect(missing.statusCode).toBe(404)
  })
})
