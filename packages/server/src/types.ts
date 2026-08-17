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

/**
 * How autonomous a task runs after clarify.
 * - `direct` — clarify → executing. Skip the plan session entirely; the clarify
 *   transcript is the brief. A lean execute chain (inline validation, conditional
 *   TDD/docs, no subagent spawns) keeps menial fixes snappy and cheap.
 * - `plan`   — clarify → planning → executing. Full PIV pipeline: grill + write a
 *   plan file + `code-reviewer` QA, then the heavy TDD/subagent execute chain.
 *   Opt into this for architectural/multi-file work that earns the ceremony.
 */
export type FlowMode = 'direct' | 'plan'

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
/** New tasks jump straight to work; opt into `plan` for the heavy pipeline. */
export const DEFAULT_FLOW: FlowMode = 'direct'

// ---- multi-target repo registry ----

/** A git repo zmrng can drive, one entry per configured target. */
export interface RepoTarget {
  id: string
  label: string
  path: string
  defaultBranch: string
}

// ---- optional agent-chat adapter (U4) ----

/** A configured external chat agent (optional adapter). */
export interface AgentTarget {
  id: string
  label: string
  url: string
  headers?: Record<string, string>
}

/** Client-facing agent view — never leaks `url`/`headers` (which may hold secrets). */
export interface AgentSummary {
  id: string
  label: string
}

/** One persisted chat message for a task/agent conversation. */
export interface ChatMessage {
  id: number
  taskId: string
  agentId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
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
  /** Post-clarify autonomy: `direct` skips the plan phase, `plan` runs the full pipeline. */
  flow: FlowMode
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

/** Top-level workspace shell mode (UI-only; mirrored for type-parity). */
export type WorkspaceMode = 'tasks' | 'board' | 'workspace'

// ---- workspace persistence (U5) ----

/**
 * GLOBAL (not task-scoped) UI chrome: active mode, left-rail collapsed flag,
 * right-rail dock-card open states (keyed by card title), and pane split
 * sizes (keyed by pane id, reserved for future resizable panes). Kept
 * permissive/forward-compatible — the server never validates individual
 * fields, it just round-trips whatever the client sends.
 */
export interface GlobalUiState {
  mode?: WorkspaceMode
  railCollapsed?: boolean
  railCards?: Record<string, boolean>
  splitSizes?: Record<string, number>
  /** Bottom-dock terminal chrome. Only open/height persist — shells are ephemeral. */
  terminalDock?: { open?: boolean; height?: number }
  /**
   * Bottom-nav pane visibility. The Tasks right rail and the Workspace center
   * pane each toggle from the bottom nav bar; both default closed so a fresh
   * load shows only the Files tree. The Files sidebar also toggles from the
   * bottom nav bar and defaults OPEN (preserves the prior locked-left
   * behavior). The Terminal pane's visibility lives in `terminalDock.open`;
   * the Settings modal is an ephemeral overlay that is never persisted.
   */
  panes?: { tasks?: boolean; workspace?: boolean; files?: boolean }
}

// ---- workspace tab-pane layout (Zed-style collapsible tabs) ----

/** Kind of a workspace tab. `file` tabs carry a `path`; the rest are singletons. */
export type WsTabKind = 'file' | 'log' | 'notes' | 'chat'

/**
 * One tab in a workspace pane. `id` is an opaque key: `file:<path>` for files,
 * or the literal singleton kind (`log` / `notes` / `chat`) so a singleton can
 * never be opened twice. `path` is set only when `kind === 'file'`.
 */
export interface WsTab {
  id: string
  kind: WsTabKind
  path?: string
}

/** One pane: an ordered tab strip plus the id of its active tab. */
export interface WsPane {
  tabs: WsTab[]
  activeId: string | null
}

/** Split axis of the tab area: `row` = side-by-side, `column` = stacked,
 *  `null` = a single pane. */
export type WsSplit = 'row' | 'column' | null

/**
 * The Workspace tab-pane layout for one task. Invariants (enforced by the pure
 * reducer in `web/src/workspaceLayout.ts`): `panes.length ∈ {1,2}`,
 * `split === null ⇔ panes.length === 1`, `activePane` indexes an existing pane,
 * and each pane's `activeId` refers to a tab that pane owns.
 */
export interface WorkspaceLayout {
  panes: WsPane[]
  split: WsSplit
  /** 0 | 1 — target pane for newly opened file tabs and re-opened panels. */
  activePane: number
  /** Only meaningful while a `log` tab exists — collapses its pane to a strip. */
  logMinimized?: boolean
}

/** PER-TASK UI state: the Workspace file viewer's open paths + active path, and
 *  the Zed-style tab-pane `layout` (optional, so older docs stay compatible). */
export interface PerTaskUiState {
  openPaths?: string[]
  activePath?: string | null
  layout?: WorkspaceLayout
}

/** Whole-document shape persisted to `~/.zmrng/ui-state.json` (never `zmrng.db`). */
export interface UiState {
  global: GlobalUiState
  perTask: Record<string, PerTaskUiState>
}

// ---- worktree file tree (Workspace file sidebar) ----

export type WorktreeNodeType = 'file' | 'dir'

/** One node in a task worktree's file tree. `path` is relative to the worktree root. */
export interface WorktreeFileNode {
  name: string
  path: string
  type: WorktreeNodeType
  children?: WorktreeFileNode[]
}

/**
 * The file listing of a task's worktree. `root` is the absolute worktree path,
 * or `null` when the task has no worktree yet (or the dir is missing).
 */
export interface WorktreeFileTree {
  root: string | null
  entries: WorktreeFileNode[]
}

/** How the Viewer (U2) should render a file, dispatched by extension. */
export type WorktreeFileFormat = 'markdown' | 'code' | 'image' | 'pdf'

/** Contents of one worktree file, fetched on demand when the Viewer opens it. */
export interface WorktreeFileContent {
  path: string
  format: WorktreeFileFormat
  encoding: 'utf8' | 'base64'
  content: string
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
  /** a task was hard-deleted — the client should drop it from local state */
  | { type: 'task-removed'; taskId: string }

// ---- terminal (bottom-dock PTY) --------------------------------------------

/** client -> server terminal frames (over GET /ws/terminal). */
export type TermClientMsg =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

/** server -> client terminal frames. */
export type TermServerMsg =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null }

// ---- preflight (advisory auth presence probe) ----

/** One advisory presence signal — never a hard gate on Start. */
export interface PreflightSignal {
  ok: boolean
  detail: string
}

/** PATH-only presence probes, distinct from the auth signals above. */
export interface PreflightPath {
  git: PreflightSignal
  gh: PreflightSignal
  claude: PreflightSignal
}

/** `GET /api/preflight` response — fresh probe every call, poll-friendly. */
export interface PreflightResult {
  claude: PreflightSignal
  gh: PreflightSignal
  path: PreflightPath
}

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
