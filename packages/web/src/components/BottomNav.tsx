import { useState } from 'react'
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
  const hiddenCount = grid.cards.filter((c) => c.hidden).length

  const toggleCard = (id: (typeof CARD_IDS)[number], hidden: boolean) =>
    onGridChange(hidden ? showCard(grid, id) : hideCard(grid, id))

  return (
    <div className={styles.bar}>
      <div className={styles.cluster}>
        <div className={styles.cardsMenu}>
          <button
            type="button"
            className={`${styles.navBtn} ${cardsOpen ? styles.navBtnActive : ''}`}
            aria-expanded={cardsOpen}
            aria-haspopup="true"
            onClick={() => setCardsOpen((v) => !v)}
          >
            Cards{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
          </button>
          {cardsOpen && (
            <>
              <button
                type="button"
                className={styles.scrim}
                aria-label="Close cards menu"
                onClick={() => setCardsOpen(false)}
              />
              <div className={styles.menu} role="menu">
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
            </>
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
