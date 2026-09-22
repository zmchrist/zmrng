import { MOBILE_VIEWS, mobileViewLabel, type MobileView } from '../mobileNav'
import { NavIcon } from './NavIcon'
import styles from './MobileNav.module.css'

interface Props {
  view: MobileView
  drawerOpen: boolean
  connected: boolean
  onToggleDrawer: () => void
  onSelect: (view: MobileView) => void
  onCloseDrawer: () => void
  onSettings: () => void
}

/**
 * The phone shell's pinned top bar: hamburger → a full-width drawer listing one
 * entry per view (Tasks/Worker · Files · Terminal · Chat · Team chat · KB), the
 * current view's name, the connection dot, and a Settings gear. It replaces the
 * desktop title bar + activity rail below the phone breakpoint; the desktop
 * chrome is untouched.
 */
export function MobileNav({
  view,
  drawerOpen,
  connected,
  onToggleDrawer,
  onSelect,
  onCloseDrawer,
  onSettings,
}: Props) {
  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Menu"
          aria-expanded={drawerOpen}
          onClick={onToggleDrawer}
        >
          ☰
        </button>
        <span className={styles.brand}>zmrng</span>
        <span className={styles.crumb}>{mobileViewLabel(view)}</span>
        <span
          className={`${styles.conn} ${connected ? '' : styles.connDown}`}
          aria-label={connected ? 'connected' : 'offline'}
          title={connected ? 'connected' : 'offline'}
        />
        <button type="button" className={styles.iconBtn} aria-label="Settings" onClick={onSettings}>
          <NavIcon name="settings" className={styles.barIcon} />
        </button>
      </div>

      {drawerOpen && (
        <>
          <button
            type="button"
            className={styles.scrim}
            aria-label="Close menu"
            onClick={onCloseDrawer}
          />
          <nav className={styles.drawer} aria-label="Views">
            {MOBILE_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`${styles.item} ${view === v.id ? styles.itemActive : ''}`}
                aria-current={view === v.id ? 'page' : undefined}
                onClick={() => onSelect(v.id)}
              >
                <span className={styles.itemGlyph}>
                  <NavIcon name={v.icon} className={styles.itemSvg} />
                </span>
                {v.label}
              </button>
            ))}
          </nav>
        </>
      )}
    </div>
  )
}
