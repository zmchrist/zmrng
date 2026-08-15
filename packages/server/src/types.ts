// Shared domain types for the zmrng server. Mirrored into web/src/types.ts.

export type TaskStatus =
  | 'backlog'
  | 'clarify'
  | 'planning'
  | 'executing'
  | 'validating'
  | 'blocked'
  | 'review'
  | 'done'
  | 'failed'
  /** Legacy single-phase autonomous status; retained for old DB rows/events. */
  | 'building'
  /** Manual terminal state for the board — an operator archives a task out of view. */
  | 'archived'

// ---- per-task controls (model · effort · style) ----

export type ModelAlias = 'opus' | 'sonnet'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CaveStyle =
  | 'normal'
  | 'caveman-lite'
  | 'caveman-full'
  | 'caveman-ultra'
  | 'wenyan-full'

/** Accumulated token/cost usage for a task, summed across all `result` events. */
export interface TaskUsage {
  tokensIn: number // input_tokens (sum)
  tokensOut: number // output_tokens (sum)
  tokensCache: number // cache_read + cache_creation (sum)
  costUsd: number // total_cost_usd (sum) — notional on Max OAuth
  turns: number // num_turns (sum)
}

export const DEFAULT_MODEL: ModelAlias = 'opus'
export const DEFAULT_EFFORT: EffortLevel = 'high'
export const DEFAULT_STYLE: CaveStyle = 'caveman-full'

// ---- multi-target repo registry ----

/** A git repo zmrng can drive, one entry per configured target. */
export interface RepoTarget {
  id: string
  label: string
  path: string
  defaultBranch: string
}

export interface Task {
  id: string
  title: string
  body: string
  status: TaskStatus
  sessionId: string | null
  branch: string | null
  worktree: string | null
  prUrl: string | null
  /** Relative path (within the target repo) of the plan written by the planning phase. */
  planPath: string | null
  /** Stays `string | null` for forward-compat with full model ids; aliases validated at the form layer. */
  model: string | null
  effort: EffortLevel | null
  style: CaveStyle | null
  /** id of the RepoTarget this task drives (from the repo registry). */
  repoId: string
  usage: TaskUsage
  /** Set while a task that reached READY is waiting for a free build lane. */
  queued: boolean
  /** Categorises a block (e.g. 'toolchain' | 'auth' | 'subagent') — free string for forward-compat. */
  blockedKind: string | null
  /** Human-readable reason captured when a task enters `blocked`. */
  blockedReason: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskComment {
  id: number
  taskId: string
  author: string // 'operator' | a subagent/actor label
  body: string
  createdAt: string
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
  | 'tool'
  | 'subagent'
  | 'subagent_result'

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
  // activity (tool calls / subagents) — Q3/Q4/Q5
  tool?: string // tool name (e.g. Bash, Edit, Task)
  actor?: string // 'main' or a subagent_type — drives color
  subagentType?: string // for subagent / subagent_result events
  summary?: string // compact one-line activity summary
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
  /** transient token-delta stream, not persisted to the events table */
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
