// Mirror of packages/server/src/types.ts (kept in sync manually — no shared pkg in v1).

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
 * Named working mode a standalone Chat-card session can adopt. Mechanically a
 * prompt preset: the selected value maps to a `workflowDirective` block appended
 * to the chat system prompt (see `chatAgent.ts`), orthogonal to and composing
 * with `CaveStyle`. `'none'` (the default) appends nothing, so the session is
 * byte-identical to the pre-workflow behavior. `'code-review'` is reserved for a
 * later ticket (#159) and currently produces an empty directive. (ADR-0002.) */
export type WorkflowPreset = 'none' | 'grill' | 'teach-me' | 'code-review'

/** Post-clarify autonomy: `direct` skips the plan phase, `plan` runs the full pipeline. */
export type FlowMode = 'direct' | 'plan'

// ---- multimodal attachments (operator image/PDF drop/paste) ----

/** An attachment is either an image (vision) or a document (PDF). */
export type AttachmentKind = 'image' | 'document'

/** One transient operator-supplied attachment carried to a live agent. */
export interface Attachment {
  kind: AttachmentKind
  /** e.g. 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf'. */
  mediaType: string
  /** Raw base64 payload — NO 'data:...;base64,' prefix. */
  dataBase64: string
  /** Original filename, for the operator log / thumbnail alt text. */
  name?: string
}

/** Media types accepted as attachments (mirrors the server). */
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

export interface TaskUsage {
  tokensIn: number
  tokensOut: number
  tokensCache: number
  costUsd: number
  turns: number
}

export const DEFAULT_MODEL: ModelAlias = 'opus'
export const DEFAULT_EFFORT: EffortLevel = 'high'
export const DEFAULT_STYLE: CaveStyle = 'caveman-full'
/** New tasks jump straight to work; opt into `plan` for the heavy pipeline. */
export const DEFAULT_FLOW: FlowMode = 'direct'

// ---- multi-target repo registry ----

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
  model: string | null
  effort: EffortLevel | null
  style: CaveStyle | null
  flow: FlowMode
  repoId: string
  usage: TaskUsage
  queued: boolean
  /**
   * True when the task is in a live phase but its worker session was lost (the
   * app was restarted). Set only at boot reconciliation and cleared when a fresh
   * agent is (re)spawned. Optional so older rows/fixtures read `false`. Mirror of
   * the server's `Task.stale`.
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
export type WorkspaceMode = 'tasks' | 'board' | 'workspace' | 'team' | 'kb'

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
 *  config and whether Launch has been pressed yet. `repoId` picks which
 *  registered repo the session's cwd is rooted at; `''` means "Projects
 *  root" (the default). Seeds the launched pane's own Repo select — a live
 *  tab can still change it there, same as model/effort/style, which respawns
 *  the session. */
export interface ChatTabMeta {
  id: string
  label: string
  model: ModelAlias
  effort: EffortLevel
  style: CaveStyle
  repoId: string
  /** Optional named working mode seeded into the launched pane; defaults to
   *  `'none'`. A persisted tab lacking the field hydrates as `'none'`. */
  workflow?: WorkflowPreset
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
  from?: TaskStatus
  to?: TaskStatus
  note?: string
  sessionId?: string
  model?: string
  isError?: boolean
  tool?: string
  actor?: string
  // security scan (kind === 'security', sub === 'security') — the round's
  // verdict + budget + a count of blocking findings; `text` carries the summary.
  verdict?: SecurityVerdict
  round?: number
  maxRounds?: number
  blockingCount?: number
  subagentType?: string
  summary?: string
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
 * one on the socket); `input` sends an operator turn; `interrupt` cuts the
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
       * Optional named working mode for this session (`grill`, `teach-me`, …).
       * Its `workflowDirective` block is appended to the chat system prompt,
       * composing with `style`. Omitted/`'none'` appends nothing, keeping the
       * frame byte-identical to the pre-workflow one. Voice sessions ignore it.
       */
      workflow?: WorkflowPreset
      /**
       * When true, the session uses the server's dedicated spoken
       * `voiceSystemPrompt` (warm natural-speech register for TTS) instead of
       * the text `chatSystemPrompt`; `style` is then ignored. Set only by the
       * Local Voice Chat surface — the text Chat card leaves it unset.
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
  /**
   * The authenticated `users.id` this member row belongs to, or `null` for a
   * legacy handle-only row created before login existed (`upsertMember`).
   * `memberForUser` keys on this column and deliberately never claims a legacy
   * null row — an unverified handle must not hand its history to a real user.
   */
  userId: number | null
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
 * (reserved for #76/T4). Mirror of `packages/server/src/types.ts`.
 */
export type MessageKind = 'human' | 'agent'

/**
 * One team-workspace channel. Channels are FLAT and OPEN — every workspace member
 * can read/post in any channel; there are no per-channel membership or ACL rows.
 * `repoId` optionally ties a channel to a target repo; the fixed `#general`
 * channel carries a null `repoId`. Mirror of `packages/server/src/types.ts`.
 */
export interface Channel {
  id: number
  name: string
  repoId: string | null
  createdAt: string
}

/**
 * An aggregated emoji reaction on one message: the emoji plus the reactor
 * handles (in reaction order). `handles.length` is the count pill; a handle is
 * "mine" when it equals my own team handle. Mirror of
 * `packages/server/src/types.ts`.
 */
export interface ReactionSummary {
  emoji: string
  handles: string[]
}

/**
 * One persisted channel message. `author` is a self-asserted, free-text member
 * handle; `kind` distinguishes human vs agent posts. `reactions` is the
 * aggregated emoji reaction set (omitted for a freshly-posted message with
 * none). Mirror of `packages/server/src/types.ts`.
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
 * `unsubscribe` register interest in a channel's live fan-out as the client
 * opens/closes it; `message` posts to a channel. A client `message` frame
 * carries NO `kind` — a socket post is always persisted as `human`; the `agent`
 * kind is server-controlled (a future T4 agent posts server-side), so a human
 * client can never forge an agent-authored message. The socket is multiplexed by
 * design — frames are channel-tagged by `type`, never one socket per resource.
 */
export type WsWorkspaceClientMsg =
  // `hello` no longer carries a display name: identity is the socket's
  // AUTHENTICATED session, never a self-asserted string. Same-origin sockets
  // ride the `zmrng_session` handshake cookie; a cross-origin socket (the
  // desktop's Team connection to the VPS) passes its bearer `token` here
  // instead, because no cookie can make that trip without TLS (D2).
  | { type: 'hello'; token?: string }
  | { type: 'ping' }
  | { type: 'subscribe'; channelId: number }
  | { type: 'unsubscribe'; channelId: number }
  // Neither `message` nor `react` carries an author/handle any more — the server
  // derives both from the socket's authenticated session. A frame that still
  // asserts one is REJECTED outright rather than silently ignored, so an
  // outdated client fails loudly instead of posting under the wrong name.
  | { type: 'message'; channelId: number; body: string }
  | { type: 'react'; channelId: number; messageId: number; emoji: string }
  // ---- KB real-time sync (T2, #144) — mirror of server types ----
  | { type: 'page.subscribe'; pageId: number }
  | { type: 'page.unsubscribe'; pageId: number }
  | {
      type: 'page.edit'
      pageId: number
      body: string
    }

/**
 * server -> client frames over the workspace socket. `roster` is a full
 * presence-roster snapshot; `pong` answers a client `ping`; `message` delivers
 * ONE newly-posted channel message live to subscribed sockets (never history —
 * scrollback comes over REST); `channels` is an optional full channel-list
 * snapshot; `new-version` advertises the latest-known origin/main sha (WS-B / D3)
 * so the client can offer a one-click self-update. Mirror of
 * `packages/server/src/types.ts`.
 */
export type WsWorkspaceServerMsg =
  | { type: 'roster'; members: WorkspaceMember[] }
  | { type: 'pong' }
  // Sent to a socket that presented no usable session (or whose session has
  // expired) immediately before the server closes it. The client clears that
  // origin's stored session and re-shows the login pane.
  | { type: 'unauthorized' }
  | { type: 'message'; message: Message }
  | { type: 'channels'; channels: Channel[] }
  | { type: 'reaction'; channelId: number; messageId: number; reactions: ReactionSummary[] }
  | { type: 'new-version'; sha: string }
  // ---- KB real-time sync (T2, #144) — mirror of server types ----
  | { type: 'page.update'; pageId: number; page: KbPage }
  | { type: 'page.presence'; pageId: number; viewers: WorkspaceMember[] }
  // `space.tree` (folder/page drag-and-drop re-parenting) — mirror of server
  // types. The tree-structure convergence frame: after a folder/page move
  // (`PATCH /api/folders/:id` or `PATCH /api/pages/:id`) the server fans this to
  // every workspace socket so a client viewing that space refetches its tree
  // without a reload. Carries only `spaceId`; moves stay REST calls.
  | { type: 'space.tree'; spaceId: number }

/**
 * Max length of a display name, measured after trimming.
 *
 * It used to bound the self-asserted handle the client clamped before sending
 * `hello`. `hello` no longer carries a name — identity is the authenticated
 * session — so the bound now lives where a display name actually enters the
 * system: the `create-user` CLI rejects an over-long `--display-name`. Here it
 * survives only as an input `maxLength` for name fields.
 * Mirror of `packages/server/src/types.ts`.
 */
export const MAX_DISPLAY_NAME_LEN = 64

/**
 * Max length of a channel message body, measured after trimming. The client
 * clamps before sending; the server rejects any over-cap frame. Mirror of
 * `packages/server/src/types.ts`.
 */
export const MAX_MESSAGE_BODY_LEN = 4000

/**
 * Max length of a reaction emoji string (UTF-16 code units). The client clamps
 * before sending `react`; the server rejects any over-cap frame. Mirror of
 * `packages/server/src/types.ts`.
 */
export const MAX_EMOJI_LEN = 64

/**
 * Default page size for the paginated scrollback route and its hard upper bound.
 * Mirror of `packages/server/src/types.ts`.
 */
export const DEFAULT_MESSAGE_PAGE = 50
export const MAX_MESSAGE_PAGE = 200

/** Name of the fixed channel seeded by default in every workspace. */
export const GENERAL_CHANNEL_NAME = 'general'

export type AuthMode = 'oauth' | 'apikey'

export interface ServerConfig {
  model: string
  maxLanes: number
  targetRepo: string
  defaultRepoId: string
  /** The shared team-agent bot handle (default `@agent`), from
   *  ZMRNG_WORKSPACE_BOT_HANDLE. Used by the Team chat's mention autocomplete +
   *  highlighter — visual only; the server-side reply trigger is unchanged. */
  botHandle: string
  /** Human-readable display string (back-compat with the existing badge). */
  authMode: string
  /** Machine-readable form of the same setting. */
  authModeKind: AuthMode
  /** This instance's current HEAD sha (from `git rev-parse HEAD` at boot), or ''
   *  when it could not be resolved. The client compares a `new-version` frame's
   *  sha against this to decide whether a self-update is actually available. */
  headSha: string
  /** True under `npm run dev` (tsx watch) — the Settings reboot button is
   *  always shown, but the server-side restart step (after git pull + build)
   *  only fires when this is true; a built deploy has no supervisor to restart. */
  dev: boolean
}

// ---- Knowledge Base (KB) — spaces / folders / pages / blocks / revisions ----
//
// MANUAL MIRROR of `packages/server/src/types.ts` (the KB data foundation, T1
// #140). Server is the source of truth; every type change touches BOTH files —
// `npm run typecheck` over both workspaces catches mirror drift.

/**
 * One KB space: the top-level container that groups a knowledge tree. `repoUrl`
 * optionally ties a space to a GitHub repo (null for the general space).
 */
export interface Space {
  id: number
  name: string
  repoUrl: string | null
  createdAt: string
  updatedAt: string
}

/**
 * The one KB space that can NEVER be deleted, regardless of how many other
 * spaces exist — a hardcoded protection on the seeded `zmrng` space (not a
 * "last space remaining" rule). The KB switcher hides its delete affordance and
 * the server rejects `DELETE /api/spaces/:id` for it with a 403. Mirror of
 * `packages/server/src/types.ts`.
 */
export const PROTECTED_SPACE_NAME = 'zmrng'

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
 * sits at the space root. `body` is the page's ENTIRE content — one continuous
 * plaintext/markdown field (no per-block model), rendered Obsidian-style (live
 * markdown, interactive checklists). `author` is the original creator;
 * `updatedBy` is the self-asserted handle of whoever last saved the body
 * (concurrency is last-write-wins).
 */
export interface KbPage {
  id: number
  spaceId: number
  folderId: number | null
  title: string
  body: string
  author: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

/**
 * A prior-body snapshot of a page, captured (throttled — not on every
 * keystroke) before an autosave overwrites it, and again before a restore.
 * Backs the page's undo/history affordance.
 */
export interface KbPageRevision {
  id: number
  pageId: number
  body: string
  author: string
  createdAt: string
}

/**
 * One node in a space's KB tree (assembled server-side). Structurally
 * assignable to `WorktreeFileNode` so the existing `FileTree` consumes it with
 * ZERO changes (`type: 'dir'` = folder, `'file'` = page), plus KB-native `id` +
 * `kind`. `path` encodes the id as `folder/<id>` or `page/<id>`.
 */
export interface KbTreeNode {
  id: number
  name: string
  path: string
  type: WorktreeNodeType
  kind: 'folder' | 'page'
  children?: KbTreeNode[]
}

/**
 * `POST /api/spaces/:id/pages/from-message` request body (KB "Send to KB", T4
 * #154): promote a team-channel message into a durable KB page in space `:id`.
 * `messageId` is the source message the server looks up (its body + channel are
 * read canonically — provenance is built server-side, never trusted from here).
 * `folderId` optionally places the page in a folder (null/omitted = space root).
 * `title` is an optional editable label; when blank the server derives it from
 * the message body. The response is a normal `KbPage`. MANUAL MIRROR of the
 * server's `packages/server/src/types.ts`.
 */
export interface KbPageFromMessageInput {
  messageId: number
  folderId?: number | null
  title?: string
}

/**
 * Durable, server-side per-user preferences persisted in `zmrng.db` (the
 * `settings` kv table), read/written over `GET`/`PUT /api/settings`. These were
 * previously browser `localStorage` only, which proved unreliable across
 * refresh/app-reopen/rebuild in the desktop shell — the DB lives in the
 * persistent per-user data dir, so it survives all of those. Empty strings mean
 * "unset". MANUAL MIRROR of `packages/server/src/types.ts`.
 */
export interface WorkspaceSettings {
  /** The teammate's self-asserted display-name handle for the Team roster.
   *  The Team workspace URL is deliberately NOT here — it is fixed in this
   *  client (`teamConfig.WORKSPACE_URL`) because the whole team shares one
   *  Tailscale-reachable VPS, so there is nothing per-user to persist. */
  teamHandle: string
}

// ---- auth (username/password login gating the KB + Team surfaces) ----

/**
 * A provisioned application user. Accounts are created out-of-band by the
 * `create-user` CLI (`src/cli/createUser.ts`) — there is deliberately no
 * self-serve signup and no password-reset flow. `passwordHash` is the versioned
 * `scrypt$N$r$p$salt$key` string produced by `password.ts`; it NEVER leaves the
 * server, so every client-facing payload carries `PublicUser` instead.
 */
export interface User {
  id: number
  username: string
  displayName: string
  passwordHash: string
  createdAt: string
  updatedAt: string
}

/** The client-visible projection of a `User` — never carries the password hash. */
export interface PublicUser {
  id: number
  username: string
  displayName: string
}

/**
 * One server-side session row. Sessions are server-side by decision (not JWTs):
 * logout and expiry are then a row delete rather than a revocation list. Only
 * the sha256 `tokenHash` is stored, so a leaked database yields no usable bearer
 * token.
 */
export interface Session {
  id: number
  userId: number
  tokenHash: string
  createdAt: string
  expiresAt: string
}

/** `POST /api/auth/login` request body. */
export interface LoginRequest {
  username: string
  password: string
}

/**
 * `POST /api/auth/login` response. The same token is ALSO set as the
 * `zmrng_session` httpOnly cookie; it is returned in the body because the
 * desktop app's CROSS-ORIGIN Team connection to the VPS cannot carry a
 * `SameSite=Strict` cookie and must fall back to an `Authorization: Bearer`
 * header (D2 of `.agents/plans/zmrng-login-auth.md`).
 */
export interface LoginResponse {
  user: PublicUser
  token: string
  expiresAt: string
}

/** `GET /api/auth/me` — who the caller is on THIS origin. */
export interface AuthState {
  user: PublicUser
}

/**
 * What one KB changelog entry records. `page_revisions` only ever sees body
 * saves, so the changelog is a dedicated additive table covering the whole
 * lifecycle — create, rename, move, body-save and delete (D4).
 */
export type KbChangeAction =
  | 'page.create'
  | 'page.rename'
  | 'page.move'
  | 'page.edit'
  | 'page.delete'

/**
 * One entry in a space's per-edit changelog. `userId` is nullable so an entry
 * survives the user row being removed; `username` is denormalized for the same
 * reason (the feed still reads correctly). `pageId` is nullable because a
 * deleted page's row is gone while its changelog entry remains.
 */
export interface KbChangeEntry {
  id: number
  spaceId: number
  pageId: number | null
  userId: number | null
  username: string
  action: KbChangeAction
  /** Human-readable context for the action (page title, rename/move detail). */
  detail: string
  createdAt: string
}

/**
 * Name of the session cookie set by `POST /api/auth/login`. `HttpOnly` +
 * `SameSite=Strict` + `Path=/`; `Secure` only over HTTPS or with
 * `ZMRNG_SECURE_COOKIES=1` (the VPS is plain http on the tailnet, and browsers
 * silently DROP a `Secure` cookie there).
 */
export const SESSION_COOKIE_NAME = 'zmrng_session'

/**
 * Minimum length of a provisioned password, enforced by the `create-user` CLI
 * at provisioning time (never at login — the login path must not leak policy).
 * The one floor worth having: it stops a one-character password without
 * composition rules that push people toward worse passwords.
 */
export const MIN_PASSWORD_LEN = 8

/** Max length of a username / password accepted by the CLI and the login route. */
export const MAX_USERNAME_LEN = 64
export const MAX_PASSWORD_LEN = 1024

/** Default page size for `GET /api/spaces/:id/changelog` and its hard cap. */
export const DEFAULT_CHANGELOG_PAGE = 50
export const MAX_CHANGELOG_PAGE = 200

// ---- preflight (advisory auth presence probe) ----

export interface PreflightSignal {
  ok: boolean
  detail: string
}

export interface PreflightPath {
  git: PreflightSignal
  gh: PreflightSignal
  claude: PreflightSignal
}

export interface PreflightResult {
  claude: PreflightSignal
  gh: PreflightSignal
  path: PreflightPath
}
