import type { ReactNode } from 'react'
import styles from './ActivityRail.module.css'
import type { WorkspaceMode } from '../types'

/**
 * A simple outline messenger bubble — a rounded speech bubble with a tail and
 * nothing inside. Drawn as an inline SVG rather than a Unicode glyph because no
 * glyph renders as a consistent outline bubble across systems; `currentColor` +
 * a 1-unit stroke keep it in step with the rail's text glyphs.
 */
function MessengerIcon(): ReactNode {
  return (
    <svg
      className={styles.arailSvg}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8.1 19.6A8.7 8.7 0 1 0 4.4 15.9L2.6 21.4Z" />
    </svg>
  )
}

/** Activity-rail nav — persistent across every mode; ⚙ opens Settings. */
const RAIL: ReadonlyArray<{ id: WorkspaceMode; icon: ReactNode; label: string }> = [
  { id: 'workspace', icon: '≣', label: 'Workspace' },
  { id: 'team', icon: <MessengerIcon />, label: 'Team' },
  { id: 'kb', icon: '❏', label: 'KB' },
]

interface Props {
  /** The active mode — drives the pressed/active button styling. */
  mode: WorkspaceMode
  /** Whether to glow the Team icon's unread orb. App only sets this while the
   *  operator is OFF the Team tab: the orb is a "you have missed something"
   *  signal, never an in-tab badge. */
  teamUnread: boolean
  onSelect: (mode: WorkspaceMode) => void
  onSettings: () => void
}

/**
 * The persistent left activity rail: one button per mode plus Settings. Purely
 * presentational — mode/collapse decisions live in App's `nextRailState`.
 */
export function ActivityRail({ mode, teamUnread, onSelect, onSettings }: Props) {
  return (
    <nav className={styles.arail} aria-label="Navigation">
      {RAIL.map((r) => {
        const orb = r.id === 'team' && teamUnread
        return (
          <button
            key={r.id}
            type="button"
            className={`${styles.arailBtn} ${mode === r.id ? styles.arailActive : ''}`}
            aria-pressed={mode === r.id}
            aria-label={orb ? `${r.label} — new messages` : r.label}
            title={orb ? `${r.label} — new messages` : r.label}
            onClick={() => onSelect(r.id)}
          >
            <span className={styles.arailIcon}>
              {r.icon}
              {orb && <span className={styles.arailOrb} data-testid="team-unread-orb" />}
            </span>
          </button>
        )
      })}
      <button
        type="button"
        className={`${styles.arailBtn} ${styles.arailBottom}`}
        aria-label="Settings"
        title="Settings"
        onClick={onSettings}
      >
        <span className={styles.arailIcon}>⚙</span>
      </button>
    </nav>
  )
}
