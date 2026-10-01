// Typed REST helpers for the Loop tab's `/api/loop/*` surface (ungated,
// same-origin, JSON). Every call rides `api.ts`'s one auth-aware `send()` path
// via `req`, so a bodyless POST sends NO content-type (Fastify would 400 an
// empty JSON body — FST_ERR_CTP_EMPTY_JSON_BODY) and a 4xx surfaces the
// server's `{ error }` text. Live updates arrive separately as `loop*` frames
// on the `/ws` hub; these calls only read a snapshot or trigger an action.

import { req } from './api'
import type { LoopCreateRequest, LoopEvent, LoopLoadResponse, LoopRun, LoopRunView } from './types'

/** Default page size for a run's event backlog (the server's own default). */
export const LOOP_EVENTS_LIMIT = 200

const runPath = (id: string): string => `/api/loop/runs/${encodeURIComponent(id)}`
const ticketPath = (id: string, n: number): string => `${runPath(id)}/tickets/${n}`

/** POST with a JSON body. */
function postJson<T>(path: string, body: unknown): Promise<T> {
  return req<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

/** POST with NO body — and therefore no content-type header. */
function postBare<T>(path: string): Promise<T> {
  return req<T>(path, { method: 'POST' })
}

export const loopApi = {
  /** A fresh machine-load sample plus the global lane-pool occupancy. */
  load: () => req<LoopLoadResponse>('/api/loop/load'),
  /** Every run, non-archived first. */
  listRuns: () => req<LoopRun[]>('/api/loop/runs'),
  getRun: (id: string) => req<LoopRunView>(runPath(id)),
  /** The most recent `limit` events, oldest → newest. */
  events: (id: string, limit = LOOP_EVENTS_LIMIT) =>
    req<LoopEvent[]>(`${runPath(id)}/events?limit=${limit}`),

  createRun: (body: LoopCreateRequest) => postJson<LoopRunView>('/api/loop/runs', body),
  start: (id: string) => postBare<LoopRunView>(`${runPath(id)}/start`),
  pause: (id: string) => postBare<LoopRunView>(`${runPath(id)}/pause`),
  /** `stale` → the previous status (respawns the orchestrator). */
  resume: (id: string) => postBare<LoopRunView>(`${runPath(id)}/resume`),
  /** Re-fetch the ticket map from GitHub. */
  refresh: (id: string) => postBare<LoopRunView>(`${runPath(id)}/refresh`),
  /** The run's target lane count, 0..LOOP_MAX_LANES (0 = stop picking). */
  setLanes: (id: string, count: number) => postJson<LoopRunView>(`${runPath(id)}/lanes`, { count }),
  /** Pick priority among unblocked tickets (issue numbers, highest first). */
  setPriority: (id: string, order: number[]) =>
    postJson<LoopRunView>(`${runPath(id)}/priority`, { order }),
  addTicket: (id: string, number: number) => postJson<LoopRunView>(`${runPath(id)}/tickets`, { number }),
  /** Remove a ticket from the run (it is marked skipped). */
  skipTicket: (id: string, n: number) => req<LoopRunView>(ticketPath(id, n), { method: 'DELETE' }),
  /** Kill the ticket's step, release its lane, ticket → todo. */
  stopTicket: (id: string, n: number) => postBare<LoopRunView>(`${ticketPath(id, n)}/stop`),
  /** needs-human → todo, rounds reset. */
  retryTicket: (id: string, n: number) => postBare<LoopRunView>(`${ticketPath(id, n)}/retry`),
  /** Answer a `waiting` ticket's question. */
  answer: (id: string, n: number, text: string) =>
    postJson<LoopRunView>(`${ticketPath(id, n)}/answer`, { text }),
  /** Operator message to the run's orchestrator. */
  chat: (id: string, text: string) => postJson<{ ok: true }>(`${runPath(id)}/chat`, { text }),
  /** Kill every runner, release lanes, remove worktrees. */
  archive: (id: string) => postBare<{ ok: true }>(`${runPath(id)}/archive`),
}

export type LoopApi = typeof loopApi
