import { useEffect, useRef, useState } from 'react'
import styles from './UpdateBanner.module.css'
import { api } from '../api'
import type { Task } from '../types'
import { liveTaskCount } from '../updateGate'

interface Props {
  /** Local tasks (App's map or list), fed to the D3a live-task phase-gate. */
  tasks: Task[] | Record<string, Task>
  /** Live socket state — used to detect the mid-restart drop-then-reconnect. */
  connected: boolean
  /** Dismiss the banner (App clears the pending sha). */
  onDismiss: () => void
}

/**
 * Global "Update available — zc shipped an update" banner (WS-B / D3). The
 * one-click Update reuses the EXISTING self-update path — it calls
 * `api.restart()` (POST /api/restart: ff-only git pull → build → dev restart)
 * and, exactly like SettingsModal's reboot, waits for the socket to drop and
 * reconnect, then reloads so the freshly built assets take effect. Outside
 * `npm run dev` the server has no supervisor, so the pull+build still runs but
 * the socket never drops — that path just shows a manual-reload note.
 *
 * D3a: if any local task is live (planning/executing/validating), the first
 * click only WARNS; a second explicit "Update anyway" click proceeds.
 *
 * The pure gate (`liveTaskCount`) is unit-tested in `updateGate.ts`; this
 * component is thin restart-trigger glue (like SettingsModal's onReboot).
 */
export function UpdateBanner({ tasks, connected, onDismiss }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const sawDropRef = useRef(false)

  const live = liveTaskCount(tasks)

  const runUpdate = async () => {
    // D3a: block-with-confirm while a local task is live. First click on a
    // live workspace arms the confirm; only the second click proceeds.
    if (live > 0 && !confirming) {
      setConfirming(true)
      return
    }
    sawDropRef.current = false
    setError(null)
    setNote(null)
    setBusy(true)
    try {
      const res = await api.restart()
      if (!res.restarted) {
        setBusy(false)
        setNote('pulled + rebuilt — restart not supported outside `npm run dev`; reload manually')
        return
      }
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    // Fallback clear — the reconnect effect below also clears on socket return.
    setTimeout(() => setBusy(false), 8000)
  }

  // On the mid-restart socket drop-then-reconnect, reload so the page picks up
  // the freshly built assets (same mechanism as SettingsModal's onReboot).
  useEffect(() => {
    if (!busy) return
    if (!connected) sawDropRef.current = true
    else if (sawDropRef.current) window.location.reload()
  }, [busy, connected])

  return (
    <div className={styles.banner} role="status">
      <span className={styles.dot} />
      <span className={styles.text}>
        Update available — zc shipped an update
        {confirming && live > 0 && (
          <span className={styles.warn}>
            {' '}
            · {live} task{live === 1 ? '' : 's'} running — updating will interrupt them
          </span>
        )}
        {error && <span className={styles.warn}> · {error}</span>}
        {note && <span className={styles.hint}> · {note}</span>}
      </span>
      <button
        type="button"
        className={styles.action}
        onClick={() => void runUpdate()}
        disabled={busy}
      >
        {busy ? 'Updating…' : confirming ? 'Update anyway' : 'Update'}
      </button>
      <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
