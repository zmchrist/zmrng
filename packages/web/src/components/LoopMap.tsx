import { useId, useMemo } from 'react'
import styles from './LoopMap.module.css'
import type { LoopTicket } from '../types'
import {
  edgeLine,
  layoutMap,
  mapEdges,
  mapHeader,
  mapSize,
  nodeBox,
  percentComplete,
  stepLabel,
  ticketGlyph,
  type Box,
  type TicketGlyph,
} from '../loopMap'
import { openExternal } from '../openExternal'

interface Props {
  tickets: LoopTicket[]
}

/** The mark drawn inside a node's checkbox — stroke-only, `currentColor`. */
function GlyphMark({ glyph }: { glyph: TicketGlyph }) {
  if (glyph === 'unchecked') return null
  return (
    <svg
      className={styles.mark}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph === 'checked' && <path d="m3.5 8.5 3 3 6-7" />}
      {glyph === 'active' && <circle cx="8" cy="8" r="2.5" fill="currentColor" />}
      {glyph === 'warn' && <path d="M8 4v5M8 12h.01" />}
      {glyph === 'skipped' && <path d="M4.5 8h7" />}
    </svg>
  )
}

/**
 * One ticket node. The checkbox is a read-only STATUS display (`role=checkbox`,
 * `aria-checked` = done, `aria-readonly`) — the map mirrors the server and is
 * never operator-toggleable — so it carries no handler and no tab stop; the
 * keyboard path is the title button, which opens the issue on GitHub.
 */
function MapNode({ ticket, box }: { ticket: LoopTicket; box: Box }) {
  const titleId = useId()
  const glyph = ticketGlyph(ticket.state)
  const note = ticket.state === 'needs-human' ? ticket.note : null
  return (
    <div
      className={styles.node}
      data-state={ticket.state}
      // Layout coordinates from layoutMap — the sanctioned dynamic inline-style case.
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <span
        role="checkbox"
        aria-checked={ticket.state === 'done'}
        aria-readonly="true"
        aria-labelledby={titleId}
        className={styles.glyph}
        data-glyph={glyph}
      >
        <GlyphMark glyph={glyph} />
      </span>
      <div className={styles.nodeBody}>
        <button
          type="button"
          id={titleId}
          className={styles.nodeTitle}
          title={ticket.title}
          onClick={() => void openExternal(ticket.url)}
        >
          #{ticket.number} {ticket.title}
        </button>
        <div className={styles.nodeMeta}>
          <span className={styles.nodeState}>{stepLabel(ticket.state)}</span>
          {note && (
            <span className={styles.nodeNote} title={note}>
              {note}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The run's ticket map: a layered dependency DAG (column = longest blocker
 * chain, see `layoutMap`) with straight blocker → ticket connectors and a
 * done/total progress header. Purely presentational over the pure `loopMap.ts`
 * helpers; the canvas scrolls inside the region when the map outgrows it.
 */
export function LoopMap({ tickets }: Props) {
  const positions = useMemo(() => layoutMap(tickets), [tickets])
  const edges = useMemo(() => mapEdges(tickets), [tickets])
  const byNumber = new Map(tickets.map((t) => [t.number, t]))
  const posOf = new Map(positions.map((p) => [p.number, p]))
  const size = mapSize(positions)
  const pct = percentComplete(tickets)

  return (
    <section className={styles.map} aria-label="Ticket map">
      <div className={styles.head}>
        <span className={styles.title}>Ticket map</span>
        <span className={styles.count}>{mapHeader(tickets)}</span>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="Tickets done"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={styles.barFill} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className={styles.scroll}>
        {tickets.length === 0 ? (
          <div className={styles.empty}>No tickets in this run’s map yet.</div>
        ) : (
          <div className={styles.canvas} style={{ width: size.width, height: size.height }}>
            <svg className={styles.edges} width={size.width} height={size.height} aria-hidden="true">
              {edges.map((e) => {
                const from = posOf.get(e.from)
                const to = posOf.get(e.to)
                if (!from || !to) return null
                return (
                  <line
                    key={`${e.from}-${e.to}`}
                    {...edgeLine(from, to)}
                    data-done={byNumber.get(e.from)?.state === 'done' || undefined}
                  />
                )
              })}
            </svg>
            {positions.map((p) => {
              const t = byNumber.get(p.number)
              return t ? <MapNode key={p.number} ticket={t} box={nodeBox(p)} /> : null
            })}
          </div>
        )}
      </div>
    </section>
  )
}
