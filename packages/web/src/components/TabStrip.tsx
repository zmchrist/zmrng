import { NavIcon } from './NavIcon'
import styles from './WindowTabs.module.css'

interface TabStripProps {
  tabs: { id: string; label: string }[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onAdd: () => void
  addLabel: string
}

/** Presentational tab strip shared by `ChatCard`/`TerminalCard`: a row of
 *  labeled tabs (click to focus, `×` to close) plus a trailing `+` to add
 *  a new one. Purely presentational — state lives in the caller. */
export function TabStrip({ tabs, activeId, onActivate, onClose, onAdd, addLabel }: TabStripProps) {
  return (
    <div className={styles.tabStrip}>
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`${styles.tab} ${t.id === activeId ? styles.tabActive : ''}`}
          onClick={() => onActivate(t.id)}
        >
          <span className={styles.tabLabel}>{t.label}</span>
          <button
            type="button"
            className={styles.tabClose}
            aria-label={`Close ${t.label}`}
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.id)
            }}
          >
            <NavIcon name="close" />
          </button>
        </div>
      ))}
      <button type="button" className={styles.tabAdd} aria-label={addLabel} title={addLabel} onClick={onAdd}>
        +
      </button>
    </div>
  )
}
