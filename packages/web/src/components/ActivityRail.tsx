import styles from './ActivityRail.module.css'
import type { WorkspaceMode } from '../types'
import { NavIcon, type NavIconName } from './NavIcon'

/** Activity-rail nav — persistent across every mode; ⚙ opens Settings. */
const RAIL: ReadonlyArray<{ id: WorkspaceMode; icon: NavIconName; label: string }> = [
  { id: 'workspace', icon: 'workspace', label: 'Workspace' },
  { id: 'team', icon: 'team', label: 'Team' },
  { id: 'kb', icon: 'kb', label: 'KB' },
  // Desktop only: the phone shell has no Loop view (App coerces it to Workspace).
  { id: 'loop', icon: 'loop', label: 'Loop' },
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
              <NavIcon name={r.icon} className={styles.arailSvg} />
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
        <span className={styles.arailIcon}>
          <NavIcon name="settings" className={styles.arailSvg} />
        </span>
      </button>
    </nav>
  )
}
