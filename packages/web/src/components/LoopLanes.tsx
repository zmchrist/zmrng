import { useEffect, useState } from 'react'
import styles from './LoopLanes.module.css'
import type { LoopRunView } from '../types'
import { laneCards, phaseColor, poolSummary, stepLabel, type LaneCard } from '../loopMap'
import { formatElapsed, formatTokens } from '../laneRows'
import { openExternal } from '../openExternal'

/** How often the elapsed column refreshes while the Loop tab is visible. */
const TICK_MS = 1000

interface Props {
  view: LoopRunView
  /** True while the Loop tab is the visible mode: the 1s tick runs only then. */
  active: boolean
  /** The operator confirmed stopping a ticket's lane. */
  onStop: (ticket: number) => void
}

/** Stop with an inline "Stop? Yes / No" step: one stray click must not kill a step. */
function StopButton({ n, onStop }: { n: number; onStop: (n: number) => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button
        type="button"
        className={styles.stopBtn}
        aria-label={`Stop #${n}`}
        onClick={() => setConfirming(true)}
      >
        Stop
      </button>
    )
  }
  return (
    <span className={styles.confirm} role="group" aria-label={`Stop #${n}?`}>
      <span className={styles.confirmText}>Stop?</span>
      <button
        type="button"
        className={styles.stopBtn}
        aria-label={`Confirm stop #${n}`}
        onClick={() => {
          setConfirming(false)
          onStop(n)
        }}
      >
        Yes
      </button>
      <button
        type="button"
        className={styles.stopBtn}
        aria-label="Cancel stop"
        onClick={() => setConfirming(false)}
      >
        No
      </button>
    </span>
  )
}

function LaneWindow({
  card,
  now,
  onStop,
}: {
  card: Extract<LaneCard, { kind: 'lane' }>
  now: number
  onStop: (n: number) => void
}) {
  const { lane, ticket } = card
  const label = ticket ? `#${lane.ticket} ${ticket.title}` : `#${lane.ticket}`
  return (
    <li className={styles.card} data-phase={card.phase}>
      <div className={styles.cardHead}>
        {ticket ? (
          <button
            type="button"
            className={styles.ticketLink}
            title={ticket.url}
            onClick={() => void openExternal(ticket.url)}
          >
            {label}
          </button>
        ) : (
          <span className={styles.ticketLink}>{label}</span>
        )}
        {/* Step color is genuinely dynamic — the sanctioned inline-style case. */}
        <span className={styles.pill} style={{ color: phaseColor(card.phase) }}>
          {stepLabel(card.phase)}
        </span>
      </div>
      <div className={styles.meta}>
        <span>{card.round}</span>
        <span>{formatTokens(card.tokens)} tok</span>
        <span className={styles.elapsed}>{formatElapsed(lane.startedAt, now)}</span>
        <span>
          {lane.model} · {lane.effort}
        </span>
      </div>
      {lane.activity && (
        <div className={styles.activity} title={lane.activity}>
          {lane.activity}
        </div>
      )}
      {card.phase === 'waiting' && (
        <div className={styles.question}>
          <span className={styles.questionLabel}>Question</span>
          <span>{ticket?.question ?? 'waiting on the orchestrator'}</span>
        </div>
      )}
      <div className={styles.actions}>
        <StopButton n={lane.ticket} onStop={onStop} />
      </div>
    </li>
  )
}

/**
 * The Loop run's lane windows (top-right of the Loop tab): a header with the
 * global pool / machine-load summary and a "picks paused" chip while the
 * server's load gate refuses new picks, then one card per live lane padded with
 * idle slots up to the run's lane target. Presentational over `loopMap.ts`; it
 * owns only the elapsed-time tick, which runs only while the tab is visible.
 */
export function LoopLanes({ view, active, onStop }: Props) {
  const [now, setNow] = useState(() => Date.now())

  // Same tick policy as the Lanes tab: a hidden tab costs nothing, and the
  // immediate first tick catches the clock up on the way back from hidden.
  useEffect(() => {
    if (!active) return
    const tick = (): void => setNow(Date.now())
    tick()
    const id = window.setInterval(tick, TICK_MS)
    return () => window.clearInterval(id)
  }, [active])

  const cards = laneCards(view)
  const pool = poolSummary(view)

  return (
    <section className={styles.lanes} aria-label="Lanes">
      <div className={styles.head}>
        <span className={styles.title}>Lanes</span>
        <span className={styles.pool}>{pool.text}</span>
        {pool.gateClosed && (
          <span className={styles.chip} title={pool.reason ?? undefined}>
            picks paused: high load
          </span>
        )}
      </div>
      {cards.length === 0 ? (
        <div className={styles.empty}>No lanes — the lane target is 0.</div>
      ) : (
        <ul className={styles.cards}>
          {cards.map((card) =>
            card.kind === 'idle' ? (
              <li key={`idle-${card.slot}`} className={`${styles.card} ${styles.idle}`}>
                idle lane
              </li>
            ) : (
              <LaneWindow key={card.lane.ticket} card={card} now={now} onStop={onStop} />
            ),
          )}
        </ul>
      )}
    </section>
  )
}
