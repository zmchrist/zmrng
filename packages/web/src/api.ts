import type { Task, TaskEvent, ServerConfig } from './types'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
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
  listTasks: () => req<Task[]>('/api/tasks'),
  getEvents: (id: string) => req<TaskEvent[]>(`/api/tasks/${id}/events`),
  createTask: (title: string, body: string, model?: string) =>
    req<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, body, model }),
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
