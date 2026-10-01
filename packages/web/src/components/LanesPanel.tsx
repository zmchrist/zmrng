import { useEffect, useState } from 'react'
import styles from './LanesPanel.module.css'
import type { LaneSnapshot, RepoTarget, Task, TaskUsage } from '../types'
import {
  formatElapsed,
  formatTokens,
  laneRows,
  type ChatRow,
  type LaneTarget,
  type WorkerRow,
} from '../laneRows'
import { actorColor, statusColor } from '../status'

/** How often the elapsed/uptime columns are refreshed while the tab is visible. */
const TICK_MS = 1000

interface Props {
  /** The latest server-assembled lane snapshot; `null` before the first frame. */
  snapshot: LaneSnapshot | null
  tasks: Task[]
  repos: RepoTarget[]
  /** True while this tab is the visible one. A hidden panel must cost nothing,
   *  so the 1s elapsed-time tick only runs while it is. */
  active: boolean
  /** A row was clicked (or activated from the keyboard): jump to what it is. */
  onOpen?: (target: LaneTarget) => void
}

/** What a row reports as "tokens": the billed in+out totals, cache excluded. */
function tokens(usage: TaskUsage): string {
  return formatTokens(usage.tokensIn + usage.tokensOut)
}

type Open = (target: LaneTarget) => void
const noop: Open = () => {}

/** One task worker plus its subagent child rows, indented beneath it. */
function Worker({ row, now, onOpen }: { row: WorkerRow; now: number; onOpen: Open }) {
  const open = (): void => onOpen({ kind: 'task', taskId: row.taskId })
  return (
    <li className={styles.row}>
      <button type="button" className={styles.rowMain} onClick={open}>
        <span className={styles.title}>{row.title}</span>
        <span className={styles.pill} style={{ color: statusColor(row.status) }}>
          {row.statusLabel}
        </span>
        <span className={styles.meta}>
          {row.model} · {row.effort} · {row.style}
        </span>
        <span className={styles.repo}>{row.repoLabel}</span>
        <span className={styles.tokens}>{tokens(row.usage)} tok</span>
        <span className={styles.elapsed}>{formatElapsed(row.startedAt, now)}</span>
      </button>
      {row.subagents.length > 0 && (
        <ul className={styles.subagents}>
          {row.subagents.map((s) => (
            <li key={s.id}>
              <button type="button" className={styles.subRow} onClick={open}>
                <span className={styles.subType} style={{ color: actorColor(s.type) }}>
                  {s.type}
                </span>
                <span className={styles.subStatus} data-state={s.status}>
                  {s.status}
                </span>
                <span className={styles.subDesc}>{s.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** One standalone chat session. Labeled `chat` — it belongs to no task, so there
 *  is deliberately no title column to fill. */
function Chat({ row, now, onOpen }: { row: ChatRow; now: number; onOpen: Open }) {
  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.rowMain}
        onClick={() => onOpen({ kind: 'chat', laneId: row.id })}
      >
        <span className={styles.kind}>chat</span>
        <span className={styles.meta}>
          {row.model} · {row.effort} · {row.style}
        </span>
        <span className={styles.repo}>{row.repoLabel}</span>
        {row.voice && <span className={styles.note}>voice</span>}
        <span className={styles.tokens}>{tokens(row.usage)} tok</span>
        <span className={styles.elapsed}>{formatElapsed(row.startedAt, now)}</span>
      </button>
    </li>
  )
}

/**
 * Lanes panel: everything zmrng is running on this machine right now
 * — the single capped execute pool with its holders and ordered queue, the
 * uncapped clarify workers, the live chat sessions and the live PTYs. Purely
 * presentational: the snapshot arrives over the `/ws` hub and every row is
 * derived by the pure `laneRows()` join, so this component owns nothing but the
 * elapsed-time tick. Every row is a button reporting a `LaneTarget` through
 * `onOpen`; the caller decides where that lands.
 */
export function LanesPanel({ snapshot, tasks, repos, active, onOpen = noop }: Props) {
  const [now, setNow] = useState(() => Date.now())

  // Only a visible panel pays for the tick; going inactive clears it, as does
  // unmounting. `now` is a clock read, not state derived from props — and it is
  // read here rather than during render because `Date.now()` is impure and a
  // component body must be idempotent. The immediate first tick catches the
  // clock up on the way back from hidden, where it stopped: without it the
  // panel would show an however-stale elapsed until the next interval fired.
  useEffect(() => {
    if (!active) return
    const tick = (): void => setNow(Date.now())
    tick()
    const id = window.setInterval(tick, TICK_MS)
    return () => window.clearInterval(id)
  }, [active])

  const rows = laneRows(snapshot, tasks, repos)
  const empty =
    rows.lanes.length === 0 &&
    rows.clarify.length === 0 &&
    rows.chats.length === 0 &&
    rows.terminals.length === 0 &&
    rows.execute.queued.length === 0

  return (
    <section className={styles.panel} aria-label="Lanes">
      <div className={styles.group}>
        <div className={styles.groupHead}>
          <span className={styles.groupTitle}>Execute lanes</span>
          <span className={styles.count}>
            {rows.execute.used}/{rows.execute.cap}
          </span>
        </div>
        {rows.lanes.length > 0 && (
          <ul className={styles.rows}>
            {rows.lanes.map((row) => (
              <Worker key={row.taskId} row={row} now={now} onOpen={onOpen} />
            ))}
          </ul>
        )}
        {rows.execute.queued.length > 0 && (
          <>
            <div className={styles.subHead}>Queued ({rows.execute.queued.length})</div>
            <ul className={styles.rows}>
              {rows.execute.queued.map((q, i) => (
                <li key={q.taskId} className={styles.row}>
                  <button
                    type="button"
                    className={styles.rowMain}
                    onClick={() => onOpen({ kind: 'task', taskId: q.taskId })}
                  >
                    <span className={styles.queuePos}>{i + 1}</span>
                    <span className={styles.title}>{q.title}</span>
                    <span className={styles.repo}>{q.repoLabel}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {rows.clarify.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupHead}>
            <span className={styles.groupTitle}>Clarify</span>
            <span className={styles.note}>uncapped · {rows.clarify.length} running</span>
          </div>
          <ul className={styles.rows}>
            {rows.clarify.map((row) => (
              <Worker key={row.taskId} row={row} now={now} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      )}

      {rows.chats.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupHead}>
            <span className={styles.groupTitle}>Chat sessions</span>
            <span className={styles.count}>{rows.chats.length}</span>
          </div>
          <ul className={styles.rows}>
            {rows.chats.map((row) => (
              <Chat key={row.id} row={row} now={now} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      )}

      {rows.terminals.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupHead}>
            <span className={styles.groupTitle}>Terminals</span>
            <span className={styles.count}>{rows.terminals.length}</span>
          </div>
          <ul className={styles.rows}>
            {rows.terminals.map((row) => (
              <li key={row.id} className={styles.row}>
                <button
                  type="button"
                  className={styles.rowMain}
                  onClick={() => onOpen({ kind: 'terminal', sessionId: row.id })}
                >
                  <span className={styles.kind}>term</span>
                  <span className={styles.mono}>{row.shell}</span>
                  <span className={styles.cwd}>{row.cwd}</span>
                  {!row.attached && <span className={styles.note}>detached</span>}
                  <span className={styles.elapsed}>{formatElapsed(row.startedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {empty && <div className={styles.empty}>Nothing running right now.</div>}
    </section>
  )
}
