import { describe, it, expect } from 'vitest'
import {
  applyProcess,
  elapsedMs,
  endTurn,
  formatElapsed,
  MAX_ROWS,
  rowLabel,
  SLOW_TOOL_MS,
  visibleRows,
  withTaskRows,
  type ProcRow,
} from '../src/processStrip'
import type { ProcessKind } from '../src/types'

const start = (id: string, kind: ProcessKind = 'tool', name = 'Bash') =>
  ({ phase: 'start', id, kind, name, summary: `${name} ${id}` }) as const

describe('applyProcess', () => {
  it('adds a running row stamped with the receipt time', () => {
    const rows = applyProcess([], start('a', 'subagent', 'zmrng-qa'), 1000)
    expect(rows).toEqual([
      { id: 'a', kind: 'subagent', name: 'zmrng-qa', summary: 'zmrng-qa a', status: 'running', startedAt: 1000 },
    ])
  })

  it('marks a row done or failed on end, and ignores unknown or already-ended ids', () => {
    let rows = applyProcess([], start('a'), 0)
    rows = applyProcess(rows, start('b'), 0)
    rows = applyProcess(rows, { phase: 'end', id: 'a', isError: false }, 500)
    rows = applyProcess(rows, { phase: 'end', id: 'b', isError: true }, 700)
    expect(rows.map((r) => [r.status, r.endedAt])).toEqual([
      ['done', 500],
      ['failed', 700],
    ])
    expect(applyProcess(rows, { phase: 'end', id: 'zz', isError: false }, 9)).toBe(rows)
    expect(applyProcess(rows, { phase: 'end', id: 'a', isError: true }, 9)).toBe(rows)
  })

  it('reset drops every row', () => {
    const rows = applyProcess([], start('a', 'background'), 0)
    expect(applyProcess(rows, { phase: 'reset' }, 1)).toEqual([])
  })

  it('caps the row list, dropping the oldest', () => {
    let rows: ProcRow[] = []
    for (let i = 0; i < MAX_ROWS + 5; i++) rows = applyProcess(rows, start(`r${i}`), i)
    expect(rows).toHaveLength(MAX_ROWS)
    expect(rows[0].id).toBe('r5')
  })
})

describe('endTurn', () => {
  it('keeps only background processes that are still running', () => {
    let rows = applyProcess([], start('tool'), 0)
    rows = applyProcess(rows, start('sa', 'subagent'), 0)
    rows = applyProcess(rows, start('bg', 'background'), 0)
    rows = applyProcess(rows, start('bgDone', 'background'), 0)
    rows = applyProcess(rows, { phase: 'end', id: 'bgDone', isError: false }, 1)
    expect(endTurn(rows).map((r) => r.id)).toEqual(['bg'])
  })

  it('returns the same array when nothing clears', () => {
    const rows = applyProcess([], start('bg', 'background'), 0)
    expect(endTurn(rows)).toBe(rows)
  })
})

describe('visibleRows', () => {
  it('always shows subagents and background shells', () => {
    let rows = applyProcess([], start('sa', 'subagent'), 0)
    rows = applyProcess(rows, start('bg', 'background'), 0)
    expect(visibleRows(rows, 1)).toHaveLength(2)
  })

  it('shows a foreground tool only once it has run past the slow threshold', () => {
    const rows = applyProcess([], start('t'), 0)
    expect(visibleRows(rows, SLOW_TOOL_MS - 1)).toEqual([])
    expect(visibleRows(rows, SLOW_TOOL_MS)).toHaveLength(1)
  })

  it('keeps a finished slow tool visible but never reveals a finished fast one', () => {
    let rows = applyProcess([], start('slow'), 0)
    rows = applyProcess(rows, start('fast'), 0)
    rows = applyProcess(rows, { phase: 'end', id: 'fast', isError: false }, 50)
    rows = applyProcess(rows, { phase: 'end', id: 'slow', isError: false }, SLOW_TOOL_MS + 10)
    expect(visibleRows(rows, 60_000).map((r) => r.id)).toEqual(['slow'])
  })
})

describe('formatting', () => {
  it('formats elapsed time compactly', () => {
    expect(formatElapsed(4_900)).toBe('4s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
    expect(formatElapsed(3_780_000)).toBe('1h 03m')
  })

  it('freezes elapsed at the end time and never goes negative', () => {
    const [row] = applyProcess([], start('a'), 1000)
    expect(elapsedMs(row, 500)).toBe(0)
    expect(elapsedMs({ ...row, endedAt: 4000 }, 99_000)).toBe(3000)
  })

  it('flags background shells in the label', () => {
    const [bg] = applyProcess([], start('a', 'background', 'Bash'), 0)
    const [sa] = applyProcess([], start('b', 'subagent', 'zmrng-qa'), 0)
    expect(rowLabel(bg)).toBe('Bash (background)')
    expect(rowLabel(sa)).toBe('zmrng-qa')
  })
})

describe('withTaskRows', () => {
  it('updates one task, drops emptied keys, and preserves identity on no-op', () => {
    const a = withTaskRows({}, 't1', (r) => applyProcess(r, start('x', 'subagent'), 0))
    expect(Object.keys(a)).toEqual(['t1'])
    expect(withTaskRows(a, 't2', endTurn)).toBe(a)
    expect(withTaskRows(a, 't1', (r) => r)).toBe(a)
    expect(withTaskRows(a, 't1', endTurn)).toEqual({})
  })
})
