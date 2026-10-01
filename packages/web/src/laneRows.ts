// Pure, React-free derivation feeding the Lanes panel. The server's
// `LaneSnapshot` deliberately carries only what the client CANNOT know
// (subagents, chat sessions, PTYs, lane occupancy); title/status/usage are
// joined in here from the `Task[]` and `RepoTarget[]` the client already holds
// over the WS hub — same no-duplication pattern as `dashboardData.ts`. No DOM,
// no fetch, so it is unit-tested directly like the other reducers in this repo.

import type {
  CaveStyle,
  EffortLevel,
  LaneSnapshot,
  LaneSubagent,
  LaneTerminal,
  RepoTarget,
  Task,
  TaskStatus,
  TaskUsage,
} from './types'
import { STATUS_LABEL } from './status'

/** Shown for a chat session rooted at no registered repo (the Projects dir). */
export const PROJECTS_ROOT_LABEL = 'Projects root'

/** One live task worker, joined with its `Task`. `model`/`effort`/`style` are
 *  the RESOLVED values the child was spawned with (the task row's own fields
 *  stay null until a phase resolves them), so this is what is really running. */
export interface WorkerRow {
  taskId: string
  title: string
  status: TaskStatus
  /** Human status label, matching the pills elsewhere in the app. */
  statusLabel: string
  model: string
  effort: EffortLevel
  style: CaveStyle
  repoLabel: string
  usage: TaskUsage
  startedAt: string
  holdsLane: boolean
  subagents: LaneSubagent[]
}

/** One task waiting for an execute lane, in promotion order. */
export interface QueuedRow {
  taskId: string
  title: string
  status: TaskStatus
  repoLabel: string
}

/** The single capped execute-lane pool: how many of `cap` slots are held, plus
 *  the ordered queue behind it. */
export interface ExecuteRows {
  used: number
  cap: number
  queued: QueuedRow[]
}

/** One live standalone chat session, with its repo resolved to a label. */
export interface ChatRow {
  id: string
  model: string
  effort: EffortLevel
  style: CaveStyle
  repoLabel: string
  voice: boolean
  startedAt: string
  usage: TaskUsage
}

/** One live PTY session. Carried through unchanged — there is nothing to join. */
export type TerminalRow = LaneTerminal

/** Where a Lanes row click leads: a task's Worker view (worker, queued and
 *  subagent rows alike — a subagent opens its parent's), or the exact chat /
 *  terminal tab that owns a live session, keyed by the row's id. */
export type LaneTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'chat'; laneId: string }
  | { kind: 'terminal'; sessionId: string }

/** Everything the Lanes panel renders, grouped the way it is displayed. */
export interface LaneRows {
  execute: ExecuteRows
  /** Workers holding an execute lane. */
  lanes: WorkerRow[]
  /** Workers running without a lane — `clarify` is uncapped by design. */
  clarify: WorkerRow[]
  chats: ChatRow[]
  terminals: TerminalRow[]
}

/** Display label for a CHAT session's root. A null id means the session is
 *  rooted at the Projects dir; the server also normalises an unresolvable id to
 *  null (it falls back to that same dir), so both read as the Projects root. */
export function repoLabel(repoId: string | null, repos: RepoTarget[]): string {
  if (!repoId) return PROJECTS_ROOT_LABEL
  return repos.find((r) => r.id === repoId)?.label ?? PROJECTS_ROOT_LABEL
}

/** Display label for a TASK's repo. Unlike a chat, a task always targets a
 *  registered repo — so an id missing from the registry falls back to the raw
 *  id (the same convention as `TaskList`), never to the Projects root. */
export function taskRepoLabel(repoId: string, repos: RepoTarget[]): string {
  return repos.find((r) => r.id === repoId)?.label ?? repoId
}

/** Thousands-grouped integer, matching the task list's usage formatting. */
export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * Elapsed time since an ISO timestamp, as `45s` / `2m 05s` / `2h 03m`. Clock
 * skew (a start in the future) clamps to `0s`; an unparseable timestamp reads
 * as an em dash rather than `NaN`.
 */
export function formatElapsed(startedAt: string, now: number): string {
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return '—'
  const total = Math.max(0, Math.floor((now - started) / 1000))
  if (total < 60) return `${total}s`
  const pad = (n: number) => String(n).padStart(2, '0')
  if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`
  return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`
}

/** An all-empty result — also what a null snapshot (nothing received yet) yields. */
function emptyRows(): LaneRows {
  return { execute: { used: 0, cap: 0, queued: [] }, lanes: [], clarify: [], chats: [], terminals: [] }
}

/**
 * Join a lane snapshot against the task list and repo registry. A worker or a
 * queued entry whose task is not in `tasks` is DROPPED: without the task row
 * there is no title/status to show, and a row the client cannot describe is
 * worse than no row.
 */
export function laneRows(
  snapshot: LaneSnapshot | null,
  tasks: Task[],
  repos: RepoTarget[],
): LaneRows {
  if (!snapshot) return emptyRows()

  const byId = new Map(tasks.map((t) => [t.id, t]))
  const lanes: WorkerRow[] = []
  const clarify: WorkerRow[] = []

  for (const w of snapshot.workers) {
    const task = byId.get(w.taskId)
    if (!task) continue
    const row: WorkerRow = {
      taskId: w.taskId,
      title: task.title,
      status: task.status,
      statusLabel: STATUS_LABEL[task.status],
      model: w.model,
      effort: w.effort,
      style: w.style,
      repoLabel: taskRepoLabel(task.repoId, repos),
      usage: task.usage,
      startedAt: w.startedAt,
      holdsLane: w.holdsLane,
      subagents: w.subagents,
    }
    ;(w.holdsLane ? lanes : clarify).push(row)
  }

  const queued: QueuedRow[] = []
  for (const id of snapshot.execute.queued) {
    const task = byId.get(id)
    if (!task) continue
    queued.push({
      taskId: id,
      title: task.title,
      status: task.status,
      repoLabel: taskRepoLabel(task.repoId, repos),
    })
  }

  return {
    execute: { used: snapshot.execute.holders.length, cap: snapshot.execute.cap, queued },
    lanes,
    clarify,
    chats: snapshot.chats.map((c) => ({
      id: c.id,
      model: c.model,
      effort: c.effort,
      style: c.style,
      repoLabel: repoLabel(c.repoId, repos),
      voice: c.voice,
      startedAt: c.startedAt,
      usage: c.usage,
    })),
    terminals: snapshot.terminals.map((t) => ({ ...t })),
  }
}
