import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './BottomNav.module.css'
import { CARD_TITLES } from '../cardMeta'
import { CARD_IDS, hideCard, showCard } from '../gridLayout'
import type {
  GridCardStyle,
  GridDensity,
  GridInteraction,
  GridState,
} from '../types'

interface Props {
  grid: GridState
  onGridChange: (next: GridState) => void
  settingsOpen: boolean
  onSettingsToggle: () => void
  connected: boolean
}

const DENSITIES: readonly GridDensity[] = ['comfortable', 'compact', 'spacious']
const CARD_STYLES: readonly GridCardStyle[] = ['accent', 'flat', 'outline', 'elevated']
const INTERACTIONS: readonly GridInteraction[] = ['reflow', 'swap', 'free']

/**
 * The static bottom nav bar for the Workspace dashboard grid: a Cards menu
 * (show/hide every card), the three grid-option selects
 * (density / card-style / interaction), a Settings toggle, and the connection
 * dot. Pinned statically at the bottom; all colors are theme tokens.
 */
export function BottomNav({ grid, onGridChange, settingsOpen, onSettingsToggle, connected }: Props) {
  const [cardsOpen, setCardsOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const hiddenCount = grid.cards.filter((c) => c.hidden).length

  const toggleCard = (id: (typeof CARD_IDS)[number], hidden: boolean) =>
    onGridChange(hidden ? showCard(grid, id) : hideCard(grid, id))

  // .bar has backdrop-filter, which makes it the containing block for any
  // position:fixed descendant — a scrim/menu nested inside it would be
  // clipped to the bar's own bounds instead of the viewport, so outside
  // clicks above the bar would never reach the scrim. Portal both to <body>,
  // positioning the menu from the anchor's on-open rect.
  useLayoutEffect(() => {
    if (!cardsOpen) return
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 })
  }, [cardsOpen])

  return (
    <div className={styles.bar}>
      <div className={styles.cluster}>
        <div className={styles.cardsMenu} ref={anchorRef}>
          <button
            type="button"
            className={`${styles.navBtn} ${cardsOpen ? styles.navBtnActive : ''}`}
            aria-expanded={cardsOpen}
            aria-haspopup="true"
            onClick={() => setCardsOpen((v) => !v)}
          >
            Cards{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
          </button>
          {cardsOpen &&
            menuPos &&
            createPortal(
              <>
                <button
                  type="button"
                  className={styles.scrim}
                  aria-label="Close cards menu"
                  onClick={() => setCardsOpen(false)}
                />
                <div
                  className={styles.menu}
                  role="menu"
                  style={{ position: 'fixed', left: menuPos.left, bottom: menuPos.bottom }}
                >
                  {grid.cards.map((c) => (
                    <label key={c.id} className={styles.menuRow}>
                      <input
                        type="checkbox"
                        checked={!c.hidden}
                        onChange={() => toggleCard(c.id, !!c.hidden)}
                      />
                      <span>{CARD_TITLES[c.id]}</span>
                    </label>
                  ))}
                </div>
              </>,
              document.body,
            )}
        </div>
      </div>

      <div className={styles.cluster}>
        <label className={styles.opt}>
          <span className={styles.optLabel}>Density</span>
          <select
            className={styles.select}
            value={grid.density}
            onChange={(e) => onGridChange({ ...grid, density: e.target.value as GridDensity })}
          >
            {DENSITIES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.opt}>
          <span className={styles.optLabel}>Style</span>
          <select
            className={styles.select}
            value={grid.cardStyle}
            onChange={(e) => onGridChange({ ...grid, cardStyle: e.target.value as GridCardStyle })}
          >
            {CARD_STYLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.opt}>
          <span className={styles.optLabel}>Drag</span>
          <select
            className={styles.select}
            value={grid.interaction}
            onChange={(e) => onGridChange({ ...grid, interaction: e.target.value as GridInteraction })}
          >
            {INTERACTIONS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.cluster}>
        <button
          type="button"
          className={`${styles.navBtn} ${settingsOpen ? styles.navBtnActive : ''}`}
          aria-pressed={settingsOpen}
          onClick={onSettingsToggle}
        >
          Settings
        </button>
        <span
          className={`${styles.dot} ${connected ? styles.dotOn : styles.dotOff}`}
          title={connected ? 'Connected' : 'Disconnected'}
          aria-label={connected ? 'Connected' : 'Disconnected'}
        />
      </div>
    </div>
  )
}
