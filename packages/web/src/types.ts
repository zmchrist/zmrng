// Mirror of packages/server/src/types.ts (kept in sync manually — no shared pkg in v1).

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
  queued: boolean
  createdAt: string
  updatedAt: string
}

export type EventKind = 'claude' | 'status' | 'operator' | 'error'

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
  from?: TaskStatus
  to?: TaskStatus
  note?: string
  sessionId?: string
  model?: string
  isError?: boolean
}

export interface TaskEvent {
  id: number
  taskId: string
  ts: string
  kind: EventKind
  payload: EventPayload
}

export type WsEvent =
  | { type: 'snapshot'; tasks: Task[] }
  | { type: 'task'; task: Task }
  | { type: 'event'; taskId: string; event: TaskEvent }
  | { type: 'partial'; taskId: string; text: string }

export interface ServerConfig {
  model: string
  maxLanes: number
  targetRepo: string
  authMode: string
}
