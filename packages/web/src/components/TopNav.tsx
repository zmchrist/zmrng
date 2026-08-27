import styles from './TopNav.module.css'
import type { WorkspaceMode } from '../types'

const MODES: ReadonlyArray<{ id: WorkspaceMode; label: string }> = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'board', label: 'Board' },
  { id: 'team', label: 'Team' },
]

interface Props {
  mode: WorkspaceMode
  onModeChange: (m: WorkspaceMode) => void
  connected: boolean
  /** Optional right-aligned status (e.g. the Team handle) replacing the dot. */
  rightSlot?: React.ReactNode
}

/** The Board / Team top nav bar — brand wordmark, mode tabs, connection state.
 *  (The Workspace mode uses its own IDE title bar + activity rail instead.) */
export function TopNav({ mode, onModeChange, connected, rightSlot }: Props) {
  return (
    <div className={styles.bar} data-tauri-drag-region>
      <span className={styles.brand}>zmrng</span>
      <nav className={styles.tabs} aria-label="Workspace mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`${styles.tab} ${mode === m.id ? styles.tabActive : ''}`}
            aria-pressed={mode === m.id}
            onClick={() => onModeChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </nav>
      {rightSlot ?? (
        <span className={`${styles.conn} ${connected ? '' : styles.connDown}`}>
          <span className={styles.connDot} />
          {connected ? 'connected' : 'offline'}
        </span>
      )}
    </div>
  )
}
