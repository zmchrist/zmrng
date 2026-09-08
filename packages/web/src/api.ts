import type {
  Task,
  TaskEvent,
  ServerConfig,
  RepoTarget,
  ModelAlias,
  EffortLevel,
  CaveStyle,
  FlowMode,
  WorktreeFileTree,
  WorktreeFileContent,
  PreflightResult,
  AgentSummary,
  ChatMessage,
  Channel,
  Message,
  UiState,
  Attachment,
} from './types'

/** Pull a text delta out of one parsed SSE `data:` payload (OpenAI-compatible + plain shapes). */
function extractDelta(obj: unknown): string {
  if (typeof obj === 'string') return obj
  if (!obj || typeof obj !== 'object') return ''
  const o = obj as Record<string, unknown>
  const choices = o.choices
  if (Array.isArray(choices) && choices.length) {
    const c = choices[0] as Record<string, unknown>
    const delta = c.delta as Record<string, unknown> | undefined
    if (delta && typeof delta.content === 'string') return delta.content
    const message = c.message as Record<string, unknown> | undefined
    if (message && typeof message.content === 'string') return message.content
    if (typeof c.text === 'string') return c.text
  }
  if (typeof o.content === 'string') return o.content
  if (typeof o.text === 'string') return o.text
  if (typeof o.delta === 'string') return o.delta
  return ''
}

/** Clean text carried by one SSE `data:` payload string ('' for `[DONE]`/empty).
 *  Per the SSE spec a single leading space after the colon is stripped. */
function textFromDataPayload(payload: string): string {
  const body = payload.startsWith(' ') ? payload.slice(1) : payload
  const trimmed = body.trim()
  if (!trimmed || trimmed === '[DONE]') return ''
  try {
    return extractDelta(JSON.parse(trimmed))
  } catch {
    return body
  }
}

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
  getPreflight: () => req<PreflightResult>('/api/preflight'),
  listTasks: () => req<Task[]>('/api/tasks'),
  getEvents: (id: string) => req<TaskEvent[]>(`/api/tasks/${id}/events`),
  getFiles: (id: string) => req<WorktreeFileTree>(`/api/tasks/${id}/files`),
  readFile: (id: string, path: string) =>
    req<WorktreeFileContent>(`/api/tasks/${id}/file?path=${encodeURIComponent(path)}`),
  /** Projects-dir file tree, shown when no task is selected. */
  getProjectFiles: () => req<WorktreeFileTree>('/api/projects/files'),
  /** Read one file under the Projects dir (read-only; no-task viewing). */
  readProjectFile: (path: string) =>
    req<WorktreeFileContent>(`/api/projects/file?path=${encodeURIComponent(path)}`),
  writeFile: (id: string, path: string, content: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  listNotes: (id: string) => req<string[]>(`/api/tasks/${id}/notes`),
  listAgents: () => req<AgentSummary[]>('/api/agents'),
  getChat: (id: string, agentId: string) =>
    req<ChatMessage[]>(`/api/tasks/${id}/chat?agentId=${encodeURIComponent(agentId)}`),
  /**
   * POST a chat message and stream the assistant reply. Parses SSE `data:`
   * frames when present (calling `onToken` per clean delta), else appends raw
   * chunk text. Returns the fully assembled assistant text.
   */
  sendChat: async (
    id: string,
    agentId: string,
    content: string,
    onToken: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<string> => {
    const res = await fetch(`/api/tasks/${id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, content }),
      signal,
    })
    if (!res.ok || !res.body) {
      let detail = res.statusText
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) detail = body.error
      } catch {
        // non-JSON error body
      }
      throw new Error(detail)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let assembled = ''
    let sawData = false
    const emit = (delta: string) => {
      if (!delta) return
      assembled += delta
      onToken(delta)
    }
    // Flush complete lines from the buffer; SSE `data:` frames stream token deltas,
    // an `event: error` frame surfaces an upstream failure, other lines are raw text.
    const flush = (final: boolean) => {
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) {
          sawData = true
          emit(textFromDataPayload(line.slice(5)))
        } else if (line.startsWith('event:') || line === '') {
          // control/framing line — ignore
        } else if (!sawData) {
          emit(line + '\n')
        }
        nl = buffer.indexOf('\n')
      }
      if (final && buffer && !sawData) {
        emit(buffer)
        buffer = ''
      }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      flush(false)
    }
    flush(true)
    return assembled
  },
  createTask: (
    title: string,
    body: string,
    opts?: {
      model?: ModelAlias
      effort?: EffortLevel
      style?: CaveStyle
      flow?: FlowMode
      repoId?: string
    },
    attachments?: Attachment[],
  ) =>
    req<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, body, ...opts, attachments }),
    }),
  start: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/start`, { method: 'POST' }),
  message: (id: string, text: string, attachments?: Attachment[]) =>
    req<{ ok: true }>(`/api/tasks/${id}/message`, {
      method: 'POST',
      body: JSON.stringify({ text, attachments }),
    }),
  resume: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/resume`, { method: 'POST' }),
  /** Restart an orphaned task's worker: a fresh agent in the same worktree. */
  restartAgent: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/restart`, { method: 'POST' }),
  interrupt: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/interrupt`, { method: 'POST' }),
  done: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/done`, { method: 'POST' }),
  cancel: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  archive: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}/archive`, { method: 'POST' }),
  deleteTask: (id: string) =>
    req<{ ok: true }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  restart: () => req<{ ok: true; restarted: boolean }>('/api/restart', { method: 'POST' }),
  /**
   * Team-workspace channel list (box 2). Channel data lives on the VPS server,
   * so `origin` (the VPS http origin from `workspaceHttpOrigin`) MUST be passed
   * to target it — a blank origin falls back to the local server (wrong for the
   * team feature, kept only for back-compat/tests).
   */
  listChannels: (origin = '') => req<Channel[]>(`${origin}/api/channels`),
  /**
   * Create a channel (T3). Pass a `repoId` to repo-scope it (a free-text
   * suggestion tag for the "Send to my zmrng" handoff); omit/null for an
   * untied channel like #general. The server broadcasts the refreshed list to
   * every connected teammate over the workspace socket. `origin` targets the
   * VPS (see listChannels).
   */
  createChannel: (name: string, repoId?: string | null, origin = '') =>
    req<Channel>(`${origin}/api/channels`, {
      method: 'POST',
      body: JSON.stringify({ name, repoId: repoId ?? null }),
    }),
  /**
   * Paginated scrollback for one channel (box 4). Pass the oldest loaded
   * message id as `before` to page backwards; the socket delivers newer live
   * messages separately (no history replay over the socket). `origin` targets
   * the VPS (see listChannels).
   */
  getChannelMessages: (
    channelId: number,
    opts?: { before?: number; limit?: number },
    origin = '',
  ) => {
    const params = new URLSearchParams()
    if (opts?.before !== undefined) params.set('before', String(opts.before))
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    const qs = params.toString()
    return req<Message[]>(`${origin}/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`)
  },
  getUiState: () => req<UiState>('/api/ui-state'),
  putUiState: (state: UiState) =>
    req<{ ok: true }>('/api/ui-state', {
      method: 'PUT',
      body: JSON.stringify(state),
    }),
}
