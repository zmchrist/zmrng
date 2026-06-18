import type {
  Task,
  TaskEvent,
  ServerConfig,
  RepoTarget,
  ModelAlias,
  EffortLevel,
  CaveStyle,
} from './types'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when we actually send a body. Fastify
  // rejects an empty body when content-type is application/json
  // (FST_ERR_CTP_EMPTY_JSON_BODY) — which 400s the bodyless POSTs
  // (start/done/cancel).
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...init?.headers },
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch {
      // non-JSON error body
    }
    throw new Error(detail)
  }
  return (await res.json()) as T
}

export const api = {
  getConfig: () => req<ServerConfig>('/api/config'),
  listRepos: () => req<RepoTarget[]>('/api/repos'),
  listTasks: () => req<Task[]>('/api/tasks'),
  getEvents: (id: string) => req<TaskEvent[]>(`/api/tasks/${id}/events`),
  createTask: (
    title: string,
    body: string,
    opts?: {
      model?: ModelAlias
      effort?: EffortLevel
      style?: CaveStyle
      repoId?: string
    },
  ) =>
    req<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, body, ...opts }),
    }),
  start: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/start`, { method: 'POST' }),
  message: (id: string, text: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/message`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  done: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/done`, { method: 'POST' }),
  cancel: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
}
