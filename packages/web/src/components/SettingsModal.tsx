import { useEffect, useRef, useState } from 'react'
import styles from './SettingsModal.module.css'
import { usePanelMount } from '../usePanelMount'
import { api } from '../api'
import {
  THEMES,
  buildThemeVars,
  getTheme,
  loadStoredTheme,
  saveStoredTheme,
  applyTheme,
  type ThemeMode,
} from '../themes'
import { loadStoredWorkspaceUrl, saveStoredWorkspaceUrl } from '../teamConfig'
import { applyOpacity, loadStoredOpacity, saveStoredOpacity } from '../opacity'

interface Props {
  open: boolean
  onClose: () => void
  /** WS connection state — used to detect the down→up transition after a
   *  reboot so the page can be reloaded once the server is actually back. */
  connected: boolean
}

/**
 * Focused settings overlay: a blurred backdrop that dims everything behind it
 * and a small centered panel. Content: a theme dropdown selector paired with a
 * live preview swatch plus a sun/moon toggle for dark/light mode (persisted to
 * localStorage), and a reboot
 * control that pulls zmrng's own repo to origin/main, rebuilds, and restarts
 * the dev server so fresh code takes effect. Closes on the × button, a
 * backdrop click, or Escape. Stays mounted a beat past `open` going false so
 * the closing (minimize) animation can play before it actually unmounts.
 */
export function SettingsModal({ open, onClose, connected }: Props) {
  const mounted = usePanelMount(open)
  const [themeId, setThemeId] = useState(() => loadStoredTheme().themeId)
  const [mode, setMode] = useState<ThemeMode>(() => loadStoredTheme().mode)
  // Per-teammate VPS team-workspace URL (localStorage; wins over the server
  // default surfaced via ServerConfig.workspaceUrl). Persisted on every edit.
  const [workspaceUrl, setWorkspaceUrl] = useState(() => loadStoredWorkspaceUrl())
  // Surface (glass panel) opacity, 0–100%. Applied live on drag and persisted to
  // localStorage; affects only the frosted-glass panel backgrounds, not text.
  const [opacity, setOpacity] = useState(() => loadStoredOpacity())

  const onWorkspaceUrlChange = (value: string) => {
    setWorkspaceUrl(value)
    saveStoredWorkspaceUrl(value)
  }

  const onOpacityChange = (value: number) => {
    setOpacity(value)
    applyOpacity(value)
    saveStoredOpacity(value)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Reboot: git pull (ff-only) → npm run build → dev-server restart. The
  // socket drops mid-response when the server actually restarts; useWs
  // auto-reconnects and flips `connected` back, at which point we reload so
  // the page picks up the freshly built assets. Outside `npm run dev` the
  // server has no supervisor to restart, so the pull+build still runs but the
  // socket never drops — that path just clears `rebooting` with a note.
  const [rebooting, setRebooting] = useState(false)
  const [rebootError, setRebootError] = useState<string | null>(null)
  const [rebootNote, setRebootNote] = useState<string | null>(null)
  const sawDropRef = useRef(false)
  const onReboot = async () => {
    sawDropRef.current = false
    setRebootError(null)
    setRebootNote(null)
    setRebooting(true)
    try {
      const res = await api.restart()
      if (!res.restarted) {
        setRebooting(false)
        setRebootNote('pulled + rebuilt — restart not supported outside `npm run dev`; reload manually')
        return
      }
    } catch (err) {
      setRebooting(false)
      setRebootError(err instanceof Error ? err.message : String(err))
      return
    }
    // Fallback clear — the reconnect effect below also clears on socket return.
    setTimeout(() => setRebooting(false), 8000)
  }
  useEffect(() => {
    if (!rebooting) return
    if (!connected) sawDropRef.current = true
    else if (sawDropRef.current) window.location.reload()
  }, [rebooting, connected])

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

  // Live preview swatch — recomputed from the current theme/mode so it tracks
  // both the dropdown and the dark/light toggle.
  const previewVars = buildThemeVars(getTheme(themeId), mode)

  if (!mounted) return null

  return (
    <div
      className={`${styles.backdrop} ${open ? styles.backdropEnter : styles.backdropExit}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`${styles.panel} ${open ? styles.panelEnter : styles.panelExit}`}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
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
            <div className={styles.themeRow}>
              <span
                className={styles.swatchPreview}
                aria-hidden="true"
                style={{ background: previewVars['--bg'] }}
              >
                <span
                  className={styles.swatchAccent}
                  style={{ background: previewVars['--accent-grad'] }}
                />
              </span>
              <select
                className={styles.themeSelect}
                aria-label="Theme"
                value={themeId}
                onChange={(e) => selectTheme(e.target.value)}
              >
                {THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>Window opacity</span>
              <span className={styles.opacityValue}>{opacity}%</span>
            </div>
            <p className={styles.rebootHint}>
              Transparency of the frosted-glass panels only — text, icons, and borders stay fully
              opaque. Lower it to let the desktop show through.
            </p>
            <input
              type="range"
              className={styles.opacitySlider}
              aria-label="Window opacity"
              min={0}
              max={100}
              step={1}
              value={opacity}
              onChange={(e) => onOpacityChange(Number(e.target.value))}
            />
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>Team workspace</span>
            </div>
            <p className={styles.rebootHint}>
              VPS team-workspace server URL for the <strong>Team</strong> tab (e.g.{' '}
              <code>wss://host.tailnet.ts.net:4500</code>). Reachable over Tailscale only.
            </p>
            <input
              type="text"
              className={styles.workspaceInput}
              aria-label="Team workspace VPS URL"
              placeholder="wss://host.tailnet.ts.net:4500"
              value={workspaceUrl}
              onChange={(e) => onWorkspaceUrlChange(e.target.value)}
            />
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>Reboot</span>
            </div>
            <p className={styles.rebootHint}>
              Pull zmrng&apos;s own repo to <code>origin/main</code> (fast-forward only), rebuild,
              and restart so fresh code takes effect.
            </p>
            <button
              type="button"
              className={styles.reboot}
              onClick={() => void onReboot()}
              disabled={rebooting}
              title="git pull (ff-only) + npm run build + restart"
            >
              {rebooting ? 'rebooting…' : 'reboot'}
            </button>
            {rebootError && <p className={styles.rebootError}>{rebootError}</p>}
            {rebootNote && <p className={styles.rebootNote}>{rebootNote}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
