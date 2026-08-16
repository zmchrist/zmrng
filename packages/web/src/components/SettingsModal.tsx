import { useEffect, useState } from 'react'
import styles from './SettingsModal.module.css'
import {
  THEMES,
  buildThemeVars,
  getTheme,
  loadStoredTheme,
  saveStoredTheme,
  applyTheme,
  type ThemeMode,
} from '../themes'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * Focused settings overlay: a blurred backdrop that dims everything behind it
 * and a small centered panel. First real content: a theme swatch grid plus a
 * sun/moon toggle for dark/light mode, persisted to localStorage. Closes on
 * the × button, a backdrop click, or Escape.
 */
export function SettingsModal({ open, onClose }: Props) {
  const [themeId, setThemeId] = useState(() => loadStoredTheme().themeId)
  const [mode, setMode] = useState<ThemeMode>(() => loadStoredTheme().mode)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const selectTheme = (id: string) => {
    setThemeId(id)
    applyTheme(id, mode)
    saveStoredTheme({ themeId: id, mode })
  }

  const toggleMode = () => {
    const next: ThemeMode = mode === 'dark' ? 'light' : 'dark'
    setMode(next)
    applyTheme(themeId, next)
    saveStoredTheme({ themeId, mode: next })
  }

  if (!open) return null

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Settings">
        <div className={styles.head}>
          <span className={styles.title}>Settings</span>
          <button
            type="button"
            className={styles.close}
            aria-label="Close settings"
            title="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>Theme</span>
              <button
                type="button"
                className={styles.modeToggle}
                aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-pressed={mode === 'light'}
                title={mode === 'dark' ? 'Light mode' : 'Dark mode'}
                onClick={toggleMode}
              >
                {mode === 'dark' ? '☽' : '☀'}
              </button>
            </div>
            <div className={styles.swatchGrid} role="radiogroup" aria-label="Theme color">
              {THEMES.map((theme) => {
                const vars = buildThemeVars(theme, mode)
                const active = theme.id === themeId
                return (
                  <button
                    key={theme.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={theme.label}
                    title={theme.label}
                    className={active ? `${styles.swatch} ${styles.swatchActive}` : styles.swatch}
                    onClick={() => selectTheme(theme.id)}
                    style={{
                      background: theme.bg,
                    }}
                  >
                    <span
                      className={styles.swatchAccent}
                      style={{ background: vars['--accent-grad'] }}
                    />
                  </button>
                )
              })}
            </div>
            <p className={styles.swatchLabel}>{getTheme(themeId).label}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
