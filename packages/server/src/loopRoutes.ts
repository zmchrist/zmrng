import type { FastifyInstance, FastifyReply } from 'fastify'
import { LOOP_MAX_LANES } from './types.js'
import type { LoopEvent, LoopLoadResponse, LoopRun, LoopRunView } from './types.js'

/** Longest operator chat / lane answer accepted, in characters. */
export const MAX_LOOP_TEXT_LEN = 20_000
/** Largest `?limit=` accepted by the events route. */
const MAX_EVENTS_LIMIT = 1000

/**
 * The slice of `LoopManager` the routes drive. Declared here (not imported from
 * loop.ts) so a test can hand `registerLoopRoutes` a stub and drive it with
 * `app.inject()` without spawning a manager, git, or any `claude` child.
 */
export interface LoopRoutesManager {
  load(): Promise<LoopLoadResponse>
  listRuns(): LoopRun[]
  view(runId: string): LoopRunView
  events(runId: string, limit?: number): LoopEvent[]
  createRun(req: { repoId: string; epic: number; lanes?: number }): Promise<LoopRunView>
  start(runId: string): Promise<LoopRunView>
  pause(runId: string): Promise<LoopRunView>
  setLanes(runId: string, count: number): Promise<LoopRunView>
  setPriority(runId: string, order: number[]): Promise<LoopRunView>
  refresh(runId: string): Promise<LoopRunView>
  addTicket(runId: string, n: number): Promise<LoopRunView>
  skipTicket(runId: string, n: number): Promise<LoopRunView>
  stopTicket(runId: string, n: number): Promise<LoopRunView>
  retryTicket(runId: string, n: number): Promise<LoopRunView>
  answer(runId: string, n: number, text: string): Promise<LoopRunView>
  chat(runId: string, text: string): Promise<void>
  resume(runId: string): Promise<LoopRunView>
  archive(runId: string): Promise<void>
}

/** What `registerLoopRoutes` needs from its host. */
export interface LoopRouteDeps {
  loop: LoopRoutesManager
}

/** A request-shape problem, answered with 400 before the manager is touched. */
class BadRequest extends Error {}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function isLaneCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= LOOP_MAX_LANES
}

/** The request body as a record ({} for a bodyless request). */
function bodyOf(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/** A `:n` path param → a positive issue number. */
function ticketParam(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new BadRequest(`invalid ticket number: ${raw}`)
  const n = Number(raw)
  if (!isPositiveInt(n)) throw new BadRequest(`invalid ticket number: ${raw}`)
  return n
}

/** A non-empty, bounded text field, trimmed. */
function textField(body: Record<string, unknown>): string {
  const text = body.text
  if (typeof text !== 'string') throw new BadRequest('text must be a string')
  const trimmed = text.trim()
  if (!trimmed) throw new BadRequest('text must not be empty')
  if (trimmed.length > MAX_LOOP_TEXT_LEN) {
    throw new BadRequest(`text exceeds ${MAX_LOOP_TEXT_LEN} characters`)
  }
  return trimmed
}

/** The `?limit=` query param: absent → undefined, otherwise an int in 1..1000. */
function limitParam(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new BadRequest('invalid limit')
  const n = Number(raw)
  if (n < 1 || n > MAX_EVENTS_LIMIT) throw new BadRequest(`limit must be 1..${MAX_EVENTS_LIMIT}`)
  return n
}

/**
 * Map a thrown error onto a reply. A `BadRequest` is a 400; any error carrying a
 * numeric HTTP `status` (the manager's `LoopError`: 404 unknown run, 409 bad
 * transition, 400 unknown repo, 502 GitHub failure) keeps it; anything else is
 * an unexpected 500. Duck-typed on `status` so this module never imports loop.ts.
 */
function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof BadRequest) return reply.code(400).send({ error: message })
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    return reply.code(status).send({ error: message })
  }
  return reply.code(500).send({ error: message })
}

/**
 * Install the Loop REST surface (`/api/loop/*`) onto `app`.
 *
 * A PLAIN FUNCTION, not a `fastify-plugin` plugin, matching `registerKbRoutes`:
 * it attaches to a bare `Fastify()` in a test and is driven with `app.inject()`.
 * The surface is UNGATED, like the Workspace orchestrator it sits beside: its
 * main caller is the run's own orchestrator `claude` session, which `curl`s it
 * over loopback. Every body is validated here — the orchestrator is an LLM and
 * may send anything — so a malformed request is a 400 that never reaches the
 * manager. Bodyless POSTs work as long as the caller sends no JSON
 * content-type (see `.claude/errors.md`, FST_ERR_CTP_EMPTY_JSON_BODY).
 */
export function registerLoopRoutes(app: FastifyInstance, deps: LoopRouteDeps): void {
  const { loop } = deps

  /** Run `fn`, answering its result (with `code`) or the mapped error. */
  const handle = async <T>(reply: FastifyReply, fn: () => T | Promise<T>, code = 200) => {
    try {
      const out = await fn()
      return reply.code(code).send(out)
    } catch (err) {
      return sendError(reply, err)
    }
  }

  type RunParams = { Params: { id: string } }
  type TicketParams = { Params: { id: string; n: string } }

  // ---- reads -----------------------------------------------------------------

  app.get('/api/loop/load', (_req, reply) => handle(reply, () => loop.load()))

  app.get('/api/loop/runs', (_req, reply) => handle(reply, () => loop.listRuns()))

  app.get<RunParams>('/api/loop/runs/:id', (req, reply) =>
    handle(reply, () => loop.view(req.params.id)),
  )

  app.get<RunParams & { Querystring: { limit?: string } }>(
    '/api/loop/runs/:id/events',
    (req, reply) =>
      handle(reply, () => loop.events(req.params.id, limitParam(req.query.limit))),
  )

  // ---- run lifecycle -----------------------------------------------------------

  app.post('/api/loop/runs', (req, reply) =>
    handle(
      reply,
      () => {
        const body = bodyOf(req.body)
        const repoId = typeof body.repoId === 'string' ? body.repoId.trim() : ''
        if (!repoId) throw new BadRequest('repoId is required')
        if (!isPositiveInt(body.epic)) throw new BadRequest('epic must be a positive integer')
        if (body.lanes !== undefined && !isLaneCount(body.lanes)) {
          throw new BadRequest(`lanes must be an integer 0..${LOOP_MAX_LANES}`)
        }
        return loop.createRun(
          body.lanes === undefined
            ? { repoId, epic: body.epic }
            : { repoId, epic: body.epic, lanes: body.lanes },
        )
      },
      201,
    ),
  )

  app.post<RunParams>('/api/loop/runs/:id/start', (req, reply) =>
    handle(reply, () => loop.start(req.params.id)),
  )
  app.post<RunParams>('/api/loop/runs/:id/pause', (req, reply) =>
    handle(reply, () => loop.pause(req.params.id)),
  )
  app.post<RunParams>('/api/loop/runs/:id/resume', (req, reply) =>
    handle(reply, () => loop.resume(req.params.id)),
  )
  app.post<RunParams>('/api/loop/runs/:id/refresh', (req, reply) =>
    handle(reply, () => loop.refresh(req.params.id)),
  )
  app.post<RunParams>('/api/loop/runs/:id/archive', (req, reply) =>
    handle(reply, async () => {
      await loop.archive(req.params.id)
      return { ok: true }
    }),
  )

  app.post<RunParams>('/api/loop/runs/:id/lanes', (req, reply) =>
    handle(reply, () => {
      const { count } = bodyOf(req.body)
      if (!isLaneCount(count)) throw new BadRequest(`count must be an integer 0..${LOOP_MAX_LANES}`)
      return loop.setLanes(req.params.id, count)
    }),
  )

  app.post<RunParams>('/api/loop/runs/:id/priority', (req, reply) =>
    handle(reply, () => {
      const { order } = bodyOf(req.body)
      if (!Array.isArray(order) || !order.every(isPositiveInt)) {
        throw new BadRequest('order must be an array of positive issue numbers')
      }
      return loop.setPriority(req.params.id, order)
    }),
  )

  app.post<RunParams>('/api/loop/runs/:id/chat', (req, reply) =>
    handle(reply, async () => {
      const text = textField(bodyOf(req.body))
      await loop.chat(req.params.id, text)
      return { ok: true }
    }),
  )

  // ---- tickets -------------------------------------------------------------------

  app.post<RunParams>('/api/loop/runs/:id/tickets', (req, reply) =>
    handle(reply, () => {
      const { number } = bodyOf(req.body)
      if (!isPositiveInt(number)) throw new BadRequest('number must be a positive issue number')
      return loop.addTicket(req.params.id, number)
    }),
  )

  app.delete<TicketParams>('/api/loop/runs/:id/tickets/:n', (req, reply) =>
    handle(reply, () => loop.skipTicket(req.params.id, ticketParam(req.params.n))),
  )

  app.post<TicketParams>('/api/loop/runs/:id/tickets/:n/stop', (req, reply) =>
    handle(reply, () => loop.stopTicket(req.params.id, ticketParam(req.params.n))),
  )

  app.post<TicketParams>('/api/loop/runs/:id/tickets/:n/retry', (req, reply) =>
    handle(reply, () => loop.retryTicket(req.params.id, ticketParam(req.params.n))),
  )

  app.post<TicketParams>('/api/loop/runs/:id/tickets/:n/answer', (req, reply) =>
    handle(reply, () => {
      const n = ticketParam(req.params.n)
      const text = textField(bodyOf(req.body))
      return loop.answer(req.params.id, n, text)
    }),
  )
}
