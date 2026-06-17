// Shared domain types for the zmrng server. Mirrored into web/src/types.ts.

export type TaskStatus =
  | 'backlog'
  | 'clarify'
  | 'building'
  | 'review'
  | 'done'
  | 'failed'

export interface Task {
  id: string
  title: string
  body: string
  status: TaskStatus
  sessionId: string | null
  branch: string | null
  worktree: string | null
  prUrl: string | null
  model: string | null
  /** Set while a task that reached READY is waiting for a free build lane. */
  queued: boolean
  createdAt: string
  updatedAt: string
}

export type EventKind = 'claude' | 'status' | 'operator' | 'error'

/** Discriminator carried inside an event payload so the UI can render it. */
export type EventSub =
  | 'init'
  | 'assistant'
  | 'partial'
  | 'result'
  | 'status'
  | 'operator'
  | 'error'

export interface EventPayload {
  sub: EventSub
  text?: string
  // status transitions
  from?: TaskStatus
  to?: TaskStatus
  note?: string
  // init
  sessionId?: string
  model?: string
  // result
  isError?: boolean
}

export interface TaskEvent {
  id: number
  taskId: string
  ts: string
  kind: EventKind
  payload: EventPayload
}

/** server -> client WebSocket messages */
export type WsEvent =
  | { type: 'snapshot'; tasks: Task[] }
  | { type: 'task'; task: Task }
  | { type: 'event'; taskId: string; event: TaskEvent }
  /** ephemeral token-delta stream, not persisted to the events table */
  | { type: 'partial'; taskId: string; text: string }

/** Minimal shape of a parsed line from `claude --output-format stream-json`. */
export interface ClaudeStreamLine {
  type: string
  subtype?: string
  session_id?: string
  message?: {
    role?: string
    content?: Array<{ type: string; text?: string }> | string
  }
  delta?: { type?: string; text?: string }
  result?: string
  is_error?: boolean
  [k: string]: unknown
}
