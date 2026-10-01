// Pure, React-free model behind the running-process strip that sits above the
// chat composers (ChatPane, WorkerLogPanel/ClarifyChat). Folds the server's
// `ProcessEvent`s into rows, decides which rows are worth showing, and clears
// finished rows when the turn ends. Timing is stamped here on receipt.

import type { ProcessEvent, ProcessKind } from './types'

/** A foreground tool call only earns a row once it has run this long. */
export const SLOW_TOOL_MS = 2000
/** Hard cap on tracked rows, so a runaway session can never grow the list. */
export const MAX_ROWS = 50

export interface ProcRow {
  id: string
  kind: ProcessKind
  name: string
  summary: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
}

/** Fold one server event into the row list (returns a new array). */
export function applyProcess(rows: ProcRow[], e: ProcessEvent, now: number): ProcRow[] {
  switch (e.phase) {
    case 'reset':
      return rows.length ? [] : rows
    case 'start': {
      const row: ProcRow = {
        id: e.id,
        kind: e.kind,
        name: e.name,
        summary: e.summary,
        status: 'running',
        startedAt: now,
      }
      const next = [...rows.filter((r) => r.id !== e.id), row]
      return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next
    }
    case 'end':
      if (!rows.some((r) => r.id === e.id && r.status === 'running')) return rows
      return rows.map((r) =>
        r.id === e.id && r.status === 'running'
          ? { ...r, status: e.isError ? 'failed' : 'done', endedAt: now }
          : r,
      )
  }
}

/** The turn ended: only background processes that are still alive survive. */
export function endTurn(rows: ProcRow[]): ProcRow[] {
  const next = rows.filter((r) => r.kind === 'background' && r.status === 'running')
  return next.length === rows.length ? rows : next
}

/** Milliseconds a row has been (or was) running. */
export function elapsedMs(row: ProcRow, now: number): number {
  return Math.max(0, (row.endedAt ?? now) - row.startedAt)
}

/** Rows worth showing: subagents and background shells always, other tool
 *  calls only once they have proved slow — so fast Read/Edit/Grep never flicker. */
export function visibleRows(rows: ProcRow[], now: number): ProcRow[] {
  return rows.filter((r) => r.kind !== 'tool' || elapsedMs(r, now) >= SLOW_TOOL_MS)
}

/** Compact elapsed label: `4s`, `2m 05s`, `1h 03m`. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Row label: subagents by type, background shells flagged as such. */
export function rowLabel(row: ProcRow): string {
  return row.kind === 'background' ? `${row.name} (background)` : row.name
}

/** Update one task's rows inside a per-task map, dropping the key once empty
 *  and returning the same map when nothing changed (no needless re-render). */
export function withTaskRows(
  map: Record<string, ProcRow[]>,
  taskId: string,
  fn: (rows: ProcRow[]) => ProcRow[],
): Record<string, ProcRow[]> {
  const cur = map[taskId] ?? []
  const next = fn(cur)
  if (next === cur || (next.length === 0 && !(taskId in map))) return map
  const out = { ...map }
  if (next.length === 0) delete out[taskId]
  else out[taskId] = next
  return out
}
