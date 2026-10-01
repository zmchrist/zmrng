import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loopApi } from '../src/loopProtocol'

type Call = { url: string; method: string; body: unknown; contentType: string | null }

let calls: Call[] = []
let reply: { status: number; body: unknown } = { status: 200, body: {} }

beforeEach(() => {
  calls = []
  reply = { status: 200, body: { ok: true } }
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? undefined),
        contentType: headers.get('content-type'),
      })
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const last = (): Call => calls[calls.length - 1]

describe('loopApi reads', () => {
  it('GET /api/loop/load', async () => {
    reply.body = { cores: 8, pool: { used: 1, max: 3 } }
    await expect(loopApi.load()).resolves.toEqual({ cores: 8, pool: { used: 1, max: 3 } })
    expect(last()).toMatchObject({ url: '/api/loop/load', method: 'GET', body: undefined })
  })

  it('GET /api/loop/runs', async () => {
    reply.body = [{ id: 'r1' }]
    await expect(loopApi.listRuns()).resolves.toEqual([{ id: 'r1' }])
    expect(last()).toMatchObject({ url: '/api/loop/runs', method: 'GET' })
  })

  it('GET /api/loop/runs/:id (id url-encoded)', async () => {
    await loopApi.getRun('a/b')
    expect(last()).toMatchObject({ url: '/api/loop/runs/a%2Fb', method: 'GET' })
  })

  it('GET /api/loop/runs/:id/events with the default and an explicit limit', async () => {
    reply.body = []
    await loopApi.events('r1')
    expect(last().url).toBe('/api/loop/runs/r1/events?limit=200')
    await loopApi.events('r1', 50)
    expect(last().url).toBe('/api/loop/runs/r1/events?limit=50')
  })
})

describe('loopApi writes', () => {
  it('POST /api/loop/runs with {repoId, epic}', async () => {
    reply.body = { run: { id: 'r9' } }
    await expect(loopApi.createRun({ repoId: 'zmrng', epic: 12 })).resolves.toEqual({ run: { id: 'r9' } })
    expect(last()).toMatchObject({
      url: '/api/loop/runs',
      method: 'POST',
      body: { repoId: 'zmrng', epic: 12 },
      contentType: 'application/json',
    })
  })

  it.each([
    ['start', '/api/loop/runs/r1/start'],
    ['pause', '/api/loop/runs/r1/pause'],
    ['resume', '/api/loop/runs/r1/resume'],
    ['refresh', '/api/loop/runs/r1/refresh'],
    ['archive', '/api/loop/runs/r1/archive'],
  ] as const)('%s is a bodyless POST with NO content-type', async (method, url) => {
    await loopApi[method]('r1')
    expect(last()).toEqual({ url, method: 'POST', body: undefined, contentType: null })
  })

  it('POST …/lanes {count}', async () => {
    await loopApi.setLanes('r1', 2)
    expect(last()).toMatchObject({ url: '/api/loop/runs/r1/lanes', method: 'POST', body: { count: 2 } })
  })

  it('POST …/priority {order}', async () => {
    await loopApi.setPriority('r1', [5, 3, 9])
    expect(last()).toMatchObject({
      url: '/api/loop/runs/r1/priority',
      method: 'POST',
      body: { order: [5, 3, 9] },
    })
  })

  it('POST …/tickets {number} adds a ticket', async () => {
    await loopApi.addTicket('r1', 44)
    expect(last()).toMatchObject({ url: '/api/loop/runs/r1/tickets', method: 'POST', body: { number: 44 } })
  })

  it('DELETE …/tickets/:n skips a ticket', async () => {
    await loopApi.skipTicket('r1', 44)
    expect(last()).toEqual({
      url: '/api/loop/runs/r1/tickets/44',
      method: 'DELETE',
      body: undefined,
      contentType: null,
    })
  })

  it.each([
    ['stopTicket', '/api/loop/runs/r1/tickets/7/stop'],
    ['retryTicket', '/api/loop/runs/r1/tickets/7/retry'],
  ] as const)('%s is a bodyless POST', async (method, url) => {
    await loopApi[method]('r1', 7)
    expect(last()).toEqual({ url, method: 'POST', body: undefined, contentType: null })
  })

  it('POST …/tickets/:n/answer {text}', async () => {
    await loopApi.answer('r1', 7, 'use the v2 bar')
    expect(last()).toMatchObject({
      url: '/api/loop/runs/r1/tickets/7/answer',
      method: 'POST',
      body: { text: 'use the v2 bar' },
    })
  })

  it('POST …/chat {text}', async () => {
    await expect(loopApi.chat('r1', 'go')).resolves.toEqual({ ok: true })
    expect(last()).toMatchObject({ url: '/api/loop/runs/r1/chat', method: 'POST', body: { text: 'go' } })
  })
})

describe('loopApi errors', () => {
  it('surfaces the server’s {error} message on a 4xx', async () => {
    reply = { status: 400, body: { error: 'lanes must be 0..3' } }
    await expect(loopApi.setLanes('r1', 9)).rejects.toThrow('lanes must be 0..3')
  })
})
