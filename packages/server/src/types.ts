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

// ---- multimodal attachments (operator image/PDF drop/paste) ----

/** An attachment is either an image (vision) or a document (PDF). */
export type AttachmentKind = 'image' | 'document'

/**
 * One transient operator-supplied attachment carried to a live agent as real
 * multimodal content. Never persisted to disk or the DB — held only long enough
 * to build the outbound stream-json `user` message.
 */
export interface Attachment {
  kind: AttachmentKind
  /** e.g. 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf'. */
  mediaType: string
  /** Raw base64 payload — NO 'data:...;base64,' prefix. */
  dataBase64: string
  /** Original filename, for the operator log / thumbnail alt text. */
  name?: string
}

/** Media types accepted as attachments (shared by server routes + web validation). */
export const ALLOWED_MEDIA_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]
/** Hard cap on the number of attachments carried in one turn. */
export const MAX_ATTACHMENTS = 10
/** Per-attachment cap on the DECODED byte size (8 MB). */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

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
  /**
   * Optional per-repo security-gate override, merged OVER the env-tunable global
   * default (field-by-field). A repo that omits this inherits the global policy;
   * `security.enabled === false` is the honest opt-out. Mirrored in web/src/types.ts.
   */
  security?: Partial<SecurityPolicy>
}

// ---- security-scan gate (deterministic SAST + SCA) -------------------------

/**
 * Semgrep severities. osv (SCA) findings are normalized onto this same scale
 * (a known vuln maps to `ERROR`); the block rule for osv is fix-availability,
 * not this severity (see `evaluateThreshold`).
 */
export type SecuritySeverity = 'ERROR' | 'WARNING' | 'INFO'

/** Semgrep confidence bucket (from `extra.metadata.confidence`). */
export type SecurityConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

/** Which scanner produced a finding. */
export type SecurityTool = 'semgrep' | 'osv'

/** The deterministic gate's pass/fail verdict for one scan round. */
export type SecurityVerdict = 'pass' | 'fail'

/**
 * A task's security-gate state, persisted on the `securityStatus` column.
 * `pending` = not yet scanned; `pass`/`fail` = the last verdict; `skipped` =
 * the repo opted out (`security.enabled === false`).
 */
export type SecurityStatus = 'pending' | 'pass' | 'fail' | 'skipped'

/**
 * One normalized finding from either scanner. `tool` discriminates the source:
 * `path`/`line`/`confidence` are set for SAST (semgrep) hits, `package`/`cve`/
 * `fixAvailable` for SCA (osv) hits. `confidence` is part of the D1 block rule
 * for semgrep and is undefined for osv.
 */
export interface SecurityFinding {
  tool: SecurityTool
  ruleId: string
  severity: SecuritySeverity
  title: string
  path?: string
  line?: number
  package?: string
  cve?: string
  fixAvailable?: boolean
  confidence?: SecurityConfidence
}

/**
 * The per-repo (or global-default) policy that parametrizes the gate. The
 * global default is env-tunable via `resolveSecurityPolicy`; a per-repo
 * `RepoTarget.security` override is merged over it field-by-field.
 */
export interface SecurityPolicy {
  /** Master switch; `false` is the honest opt-out (verdict recorded as `skipped`). */
  enabled: boolean
  /** Bounded fix-round budget before parking `blocked` (D7 default 2). */
  maxRounds: number
  /** Semgrep `--config` value: a vendored high-signal dir + `p/secrets` (D1/D4). */
  semgrepConfig: string
  /** Semgrep severity floor at/above which a high-confidence hit blocks (D1, default `ERROR`). */
  minSeverity: SecuritySeverity
}

/** One persisted security-scan round for a task (the `security_scans` table). */
export interface SecurityScan {
  id: number
  taskId: string
  round: number
  verdict: SecurityVerdict
  findings: SecurityFinding[]
  toolVersions: Record<string, string>
  createdAt: string
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
  /**
   * True when the task is in a live phase but its worker session was lost (the
   * app was restarted). Set only at boot reconciliation and cleared when a fresh
   * agent is (re)spawned; normal live operation never sets it. Optional so older
   * DB rows and test fixtures read `false`. Mirrored in web/src/types.ts.
   */
  stale?: boolean
  /**
   * The task's security-gate state (last verdict / opt-out). Optional so older
   * DB rows and test fixtures read `undefined`, mirroring the `stale?` precedent.
   * Mirrored in web/src/types.ts.
   */
  securityStatus?: SecurityStatus
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
export type WorkspaceMode = 'tasks' | 'board' | 'workspace' | 'team'

// ---- workspace dashboard grid (customizable card grid) ---------------------

/** The stable id of every card in the Workspace dashboard grid roster. */
export type GridCardId =
  | 'pipeline'
  | 'concurrency'
  | 'reviewqueue'
  | 'newtask'
  | 'tasklist'
  | 'files'
  | 'viewers'
  | 'chat'
  | 'terminal'

/** Row-height / gap density of the grid. */
export type GridDensity = 'comfortable' | 'compact' | 'spacious'
/** Card chrome variant (maps to a token-based CSS class). */
export type GridCardStyle = 'accent' | 'flat' | 'outline' | 'elevated'
/** Drag/resize collision behavior: push aside, swap positions, or free overlap. */
export type GridInteraction = 'reflow' | 'swap' | 'free'

/**
 * One card's geometry in the 12-column grid. `x/y/w/h` are in CELL units (never
 * pixels) so the layout is screen-width-independent and persists cleanly.
 * `minW/minH` clamp resize. `hidden` cards are not rendered (their geometry is
 * kept so re-showing restores position); `minimized` cards render header-only.
 */
export interface GridCardGeo {
  id: GridCardId
  x: number
  y: number
  w: number
  h: number
  minW: number
  minH: number
  hidden?: boolean
  minimized?: boolean
}

/** The whole dashboard-grid state (persisted in `GlobalUiState.grid`). The
 *  server only round-trips this — it never validates individual fields. */
export interface GridState {
  cards: GridCardGeo[]
  density: GridDensity
  cardStyle: GridCardStyle
  interaction: GridInteraction
}

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
  /** Pane split ratios (keyed by pane-pair id). `filesNotesSplit` is the Files
   *  pane's share (0..1) of the left column's height when Files + Notes are
   *  both open; the rest is reserved for future resizable panes. */
  splitSizes?: Record<string, number>
  /** Bottom-dock terminal chrome. Only open/height persist — shells are ephemeral. */
  terminalDock?: { open?: boolean; height?: number }
  /**
   * Bottom-nav pane visibility. The Tasks right rail and the Workspace center
   * pane each toggle from the bottom nav bar; both default closed so a fresh
   * load shows only the Files tree. The Files sidebar also toggles from the
   * bottom nav bar and defaults OPEN (preserves the prior locked-left
   * behavior). The Notes panel also toggles from the bottom nav bar and
   * defaults CLOSED; when both Files and Notes are open they share the left
   * column, split vertically (Files on top). The Terminal pane's visibility
   * lives in `terminalDock.open`; the Settings modal is an ephemeral overlay
   * that is never persisted.
   */
  panes?: { tasks?: boolean; workspace?: boolean; files?: boolean; notes?: boolean }
  /**
   * The task/worktree the Notes panel is currently showing. Independent of
   * the app's selected task — the panel auto-syncs to the selected task (if
   * it has a worktree) but a manual pick in the panel's own dropdown wins
   * until the selected task changes again.
   */
  notesTaskId?: string | null
  /**
   * The Workspace dashboard-grid state: every card's cell geometry, visibility,
   * and minimized flag, plus the density / card-style / interaction options.
   * GLOBAL (describes the shell, not a task). Absent on older docs — the client
   * hydrates a default layout in that case.
   */
  grid?: GridState
  /**
   * Per-card tab-strip metadata for the Chat and Terminal cards (tab id,
   * label, and for chat the picked model/effort/style). GLOBAL, like `grid`.
   * The live session itself is never persisted — PTYs and chat WS sessions
   * are ephemeral by hard rule — so on reload terminal tabs respawn fresh
   * and chat tabs reappear needing another Launch press. Absent on older
   * docs — the client hydrates one default tab per card in that case.
   */
  chatTabs?: { tabs: ChatTabMeta[]; activeId: string | null }
  terminalTabs?: { tabs: TerminalTabMeta[]; activeId: string | null }
}

/** Persisted metadata for one Terminal-card tab. */
export interface TerminalTabMeta {
  id: string
  label: string
  /**
   * Server-assigned id of the live PTY this tab last attached to. Lets a full
   * page reload reattach to the same shell (within the grace window) instead of
   * spawning a fresh one. Absent on older docs / a never-attached tab — the
   * client then attaches without an id and the server spawns a new session.
   */
  sessionId?: string
}

/** Persisted metadata for one Chat-card tab: id/label plus the picked
 *  config and whether Launch has been pressed yet. */
export interface ChatTabMeta {
  id: string
  label: string
  model: ModelAlias
  effort: EffortLevel
  style: CaveStyle
  launched: boolean
}

// ---- workspace tab-pane layout (Zed-style collapsible tabs) ----

/** Kind of a workspace tab. `file` tabs carry a `path`; `log`/`chat` are singletons. */
export type WsTabKind = 'file' | 'log' | 'chat'

/**
 * One tab in a workspace pane. `id` is an opaque key: `file:<path>` for files,
 * or the literal singleton kind (`log` / `chat`) so a singleton can
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

export type EventKind = 'claude' | 'status' | 'operator' | 'error' | 'security'

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
  | 'security'

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
  // security scan (kind === 'security', sub === 'security') — the round's
  // verdict + budget + a count of blocking findings; `text` carries the summary.
  verdict?: SecurityVerdict
  round?: number
  maxRounds?: number
  blockingCount?: number
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
  | { type: 'attach'; sessionId?: string; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

/** server -> client terminal frames. */
export type TermServerMsg =
  | { type: 'session'; sessionId: string }
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null }

// ---- standalone chat agent (bottom-dock, GET /ws/chat) ---------------------

/**
 * client -> server chat frames (over GET /ws/chat). `start` spawns a fresh
 * conversational `claude` session with the chosen controls (killing any prior
 * one on the socket); `repoId` picks which registered repo the session's cwd
 * is rooted at (a missing/unresolvable id falls back to `config.projectsDir`,
 * i.e. "Projects root"). `input` sends an operator turn; `interrupt` cuts the
 * in-flight turn without killing the session.
 */
export type ChatClientMsg =
  | {
      type: 'start'
      model: string
      effort: EffortLevel
      style: CaveStyle
      repoId?: string
      /**
       * When true, the session uses the dedicated spoken `voiceSystemPrompt`
       * (a fixed warm, natural-speech register tuned for TTS) instead of the
       * text `chatSystemPrompt`; `style` is then ignored. Set only by the Local
       * Voice Chat surface — the text Chat card leaves it unset.
       */
      voice?: boolean
    }
  | { type: 'input'; text: string; attachments?: Attachment[] }
  | { type: 'interrupt' }

/** server -> client chat frames — one per meaningful Runner callback. */
export type ChatServerMsg =
  | { type: 'ready'; sessionId: string }
  | { type: 'partial'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; summary: string; actor: string; isSubagent: boolean }
  | { type: 'result'; isError: boolean }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; text: string }

// ---- team workspace (multiplexed presence socket, GET /ws/workspace) -------

/**
 * One persisted workspace member. Identity is a self-asserted, free-text
 * display name (no password, no verification — Tailscale is the perimeter).
 */
export interface Member {
  id: number
  displayName: string
  createdAt: string
}

/** A member's presence view in the workspace-wide roster. */
export interface WorkspaceMember {
  id: number
  displayName: string
  /** True while the member holds at least one live workspace socket. */
  online: boolean
}

/**
 * A message's origin, so the UI can render human and agent posts distinguishably
 * (box 6 of #74). `human` = a teammate typed it; `agent` = an agent posted it
 * (reserved for #76/T4 — T2 only ever persists `human` from the composer, but the
 * column + type exist now so agent posting plugs in without a migration).
 */
export type MessageKind = 'human' | 'agent'

/**
 * One team-workspace channel. Channels are FLAT and OPEN — every workspace member
 * can read/post in any channel; there are no per-channel membership or ACL rows.
 * `repoId` optionally ties a channel to a target repo; the fixed `#general`
 * channel (seeded by default) carries a null `repoId`.
 */
export interface Channel {
  id: number
  name: string
  repoId: string | null
  createdAt: string
}

/**
 * An aggregated emoji reaction on one message: the emoji plus the list of
 * self-asserted handles that reacted with it, in the order they reacted. The
 * UI renders `handles.length` as the count pill and lists `handles` in the
 * "who reacted" popup; a handle is "mine" when it equals my own team handle.
 * Reactions key on the same free-text handle model as message authorship (no
 * login/member-id). Mirrored in `packages/web/src/types.ts`.
 */
export interface ReactionSummary {
  emoji: string
  handles: string[]
}

/**
 * One persisted channel message. `author` is a self-asserted, free-text member
 * handle (the same identity model as T1 presence — no verification). `kind`
 * distinguishes human vs agent posts. `reactions` is the aggregated emoji
 * reaction set (optional/omitted for a freshly-posted message that has none;
 * scrollback attaches the persisted set).
 */
export interface Message {
  id: number
  channelId: number
  author: string
  body: string
  kind: MessageKind
  reactions?: ReactionSummary[]
  createdAt: string
}

/**
 * client -> server frames over the ONE multiplexed workspace socket
 * (GET /ws/workspace). `hello` self-asserts a display name on first connect;
 * `ping` is the client heartbeat (the server answers with `pong`). `subscribe`/
 * `unsubscribe` register interest in a channel's live message fan-out as the
 * client opens/closes it; `message` posts to a channel (persisted, then fanned
 * out only to sockets subscribed to that channel — no history replay). A client
 * `message` frame carries NO `kind` — a socket post is always persisted as
 * `human`; the `agent` kind is server-controlled (a future T4 agent posts
 * server-side), so a human client can never forge an agent-authored message. The
 * socket is multiplexed by design — frames are channel-tagged by `type`, never
 * one socket per resource.
 */
export type WsWorkspaceClientMsg =
  | { type: 'hello'; displayName: string }
  | { type: 'ping' }
  | { type: 'subscribe'; channelId: number }
  | { type: 'unsubscribe'; channelId: number }
  | { type: 'message'; channelId: number; author: string; body: string }
  | { type: 'react'; channelId: number; messageId: number; emoji: string; handle: string }
  // ---- KB real-time sync (T2, #144) ----
  // `page.subscribe`/`page.unsubscribe` register interest in a page's live block
  // fan-out (and drive its lightweight viewer presence), mirroring the channel
  // subscribe frames. `page.edit` is a BLOCK DELTA on save: `blockId: null`
  // creates a new block (server appends — see PageManager.saveBlock), a non-null
  // `blockId` updates that existing block (→ Db.updateBlock, which snapshots the
  // prior state into `revisions`). A socket `page.edit` is ALWAYS a human author
  // (mirrors the channel `message` "always human" posture — the agent block path
  // is out of T2 scope).
  | { type: 'page.subscribe'; pageId: number }
  | { type: 'page.unsubscribe'; pageId: number }
  | {
      type: 'page.edit'
      pageId: number
      blockId: number | null
      kind: KbBlockKind
      body: string
      meta: string | null
      author: string
    }

/**
 * server -> client frames over the workspace socket. `roster` is a full
 * presence-roster snapshot, re-sent on every join/leave; `pong` answers a
 * client `ping`; `message` delivers ONE newly-posted channel message live to
 * subscribed sockets (never history — scrollback comes over REST); `channels`
 * is an optional full channel-list snapshot (the client normally lists channels
 * over REST, but the frame exists so the server can push list changes).
 * `new-version` advertises the latest-known origin/main sha (WS-B / D3): sent as
 * a live broadcast when the version poller sees origin/main move ahead, and once
 * on connect as a boot safety-net seed when a newer sha is already known. The
 * client compares it to its own `headSha` and offers a one-click self-update.
 */
export type WsWorkspaceServerMsg =
  | { type: 'roster'; members: WorkspaceMember[] }
  | { type: 'pong' }
  | { type: 'message'; message: Message }
  | { type: 'channels'; channels: Channel[] }
  | { type: 'reaction'; channelId: number; messageId: number; reactions: ReactionSummary[] }
  | { type: 'new-version'; sha: string }
  // ---- KB real-time sync (T2, #144) ----
  // `page.update` fans ONE created/updated block (the delta) out to every socket
  // subscribed to that page — mirrors the channel `message` frame. `page.presence`
  // is the lightweight per-page viewer set driven by the subscribe set (who is
  // currently viewing the page), re-broadcast on every subscribe/unsubscribe. It
  // reuses `WorkspaceMember` (viewers are live sockets, so `online` is always
  // true) rather than introducing a slim viewer shape — no extra mirror surface.
  | { type: 'page.update'; pageId: number; block: KbBlock }
  | { type: 'page.presence'; pageId: number; viewers: WorkspaceMember[] }

/**
 * Max length of a self-asserted display-name handle, measured after trimming.
 * A `hello` frame whose trimmed name exceeds this is rejected server-side so a
 * client can never store an unbounded handle into `members` (which would then
 * ride every roster snapshot). Mirrored in `packages/web/src/types.ts`.
 */
export const MAX_DISPLAY_NAME_LEN = 64

/**
 * Max length of a channel message body, measured after trimming. A `message`
 * frame whose trimmed body exceeds this is rejected server-side (tolerant parse
 * → undefined) so a client can never persist an unbounded message. Mirrored in
 * `packages/web/src/types.ts`.
 */
export const MAX_MESSAGE_BODY_LEN = 4000

/**
 * Max length of a reaction emoji string, measured in UTF-16 code units. A
 * `react` frame whose emoji exceeds this is rejected server-side (tolerant parse
 * → undefined) so a client can never store an unbounded string as an "emoji".
 * Generous enough for multi-codepoint ZWJ sequences and flags. Mirrored in
 * `packages/web/src/types.ts`.
 */
export const MAX_EMOJI_LEN = 64

/**
 * Default page size for the paginated scrollback route
 * (`GET /api/channels/:id/messages`) and its hard upper bound. Mirrored in
 * `packages/web/src/types.ts`.
 */
export const DEFAULT_MESSAGE_PAGE = 50
export const MAX_MESSAGE_PAGE = 200

/** Name of the fixed channel seeded by default in every workspace. */
export const GENERAL_CHANNEL_NAME = 'general'

// ---- Knowledge Base (KB) — spaces / folders / pages / blocks / revisions ----
//
// Server-side data foundation for the real-time team KB (epic T1, #140). New KB
// tables are siblings of channels/messages/members and reuse the same Team
// workspace spine (WAL SQLite, additive-only migrations, INSERT-OR-IGNORE seed).
// Field-naming: camelCase in these TS types, snake_case in the DB columns (see
// the rowTo* mappers in db.ts). MANUAL MIRROR in `packages/web/src/types.ts`.

/**
 * One KB space: the top-level container that groups a knowledge tree. `repoUrl`
 * optionally ties a space to a GitHub repo (null for the general space). Three
 * POC spaces are seeded on construction (see `KB_SEED_SPACES`).
 */
export interface Space {
  id: number
  name: string
  repoUrl: string | null
  createdAt: string
  updatedAt: string
}

/**
 * One folder in a space's tree. `parentId` self-references `folders` for
 * nesting; null means the folder sits at the space root.
 */
export interface KbFolder {
  id: number
  spaceId: number
  parentId: number | null
  name: string
  createdAt: string
}

/**
 * One KB page. `folderId` places the page inside a folder; null means the page
 * sits at the space root. A page owns an ordered list of blocks.
 */
export interface KbPage {
  id: number
  spaceId: number
  folderId: number | null
  title: string
  author: string
  createdAt: string
  updatedAt: string
}

/** The block kinds a page body is composed of. */
export type KbBlockKind = 'text' | 'heading' | 'code' | 'checklist' | 'list'

/** Every valid `KbBlockKind`, for wire validation. Mirrored in web types. */
export const KB_BLOCK_KINDS: readonly KbBlockKind[] = [
  'text',
  'heading',
  'code',
  'checklist',
  'list',
]

/**
 * Max length of a block's `meta` JSON string on a `page.edit` frame (T2). `meta`
 * carries small kind-specific extras (`{"level":1}`, `{"checked":true}`), so a
 * generous-but-bounded cap keeps a client from persisting an unbounded string.
 * A block `body` reuses `MAX_MESSAGE_BODY_LEN`. Mirrored in web types.
 */
export const MAX_BLOCK_META_LEN = 2000

/**
 * One block of a page's body. `body` is markdown; `meta` is a nullable JSON
 * string carrying kind-specific extras — `{"level":1}` for a heading level,
 * `{"checked":true}` for a checklist item. `updatedBy` is the last editor's
 * self-asserted handle. Each update snapshots the PRIOR state into `revisions`.
 */
export interface KbBlock {
  id: number
  pageId: number
  ord: number
  kind: KbBlockKind
  body: string
  meta: string | null
  updatedAt: string
  updatedBy: string
}

/**
 * A prior-state snapshot of a block, captured on each block update (and on each
 * restore). Backs the locked-toast + restore-from-revision conflict UX (T2). A
 * revision row captures the block state that a write is about to replace.
 */
export interface KbRevision {
  id: number
  blockId: number
  body: string
  kind: KbBlockKind
  meta: string | null
  author: string
  createdAt: string
}

/**
 * One node in a space's KB tree, assembled server-side by `spaceTree`. Shaped to
 * be consumed by the existing Files-tab `FileTree` (`WorktreeFileNode[]`) with
 * ZERO component changes: it carries the same `name`/`path`/`type`/`children`
 * fields (`type: 'dir'` = folder, `'file'` = page) and is structurally
 * assignable to `WorktreeFileNode`. It ALSO carries KB-native `id` + `kind` so
 * T3 can resolve a clicked node without parsing. `path` encodes the id as
 * `folder/<id>` or `page/<id>` (a stable React key + id carrier).
 */
export interface KbTreeNode {
  id: number
  name: string
  path: string
  type: WorktreeNodeType
  kind: 'folder' | 'page'
  children?: KbTreeNode[]
}

/** `GET /api/pages/:id` response — a page plus its ordered blocks. */
export interface KbPageDetail {
  page: KbPage
  blocks: KbBlock[]
}

/**
 * The three POC spaces seeded on construction (INSERT OR IGNORE on the UNIQUE
 * `name`, so reopening a populated db is a no-op). `general` carries a null
 * repoUrl; the repo-scoped spaces carry their GitHub URL.
 */
export const KB_SEED_SPACES: ReadonlyArray<{ name: string; repoUrl: string | null }> = [
  { name: 'general', repoUrl: null },
  { name: 'zmrng', repoUrl: 'https://github.com/zmchrist/zmrng' },
  { name: 'pheme', repoUrl: 'https://github.com/zmchrist/pheme' },
]

/**
 * Durable, server-side per-user preferences persisted in `zmrng.db` (the
 * `settings` kv table), read/written over `GET`/`PUT /api/settings`. These were
 * previously browser `localStorage` only, which proved unreliable across
 * refresh/app-reopen/rebuild in the desktop shell — the DB lives in the
 * persistent per-user data dir, so it survives all of those. Empty strings mean
 * "unset". Mirrored in `packages/web/src/types.ts`.
 */
export interface WorkspaceSettings {
  /** VPS team-workspace server URL for the Team tab. Wins over the
   *  `ZMRNG_WORKSPACE_URL` env default when non-empty. */
  workspaceUrl: string
  /** The teammate's self-asserted display-name handle for the Team roster. */
  teamHandle: string
}

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
