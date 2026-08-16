import { useEffect } from 'react'
import styles from './SettingsModal.module.css'
import { usePanelMount } from '../usePanelMount'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * Focused settings overlay: a blurred backdrop that dims everything behind it
 * and a small centered panel. Real settings land here later — for now it is a
 * placeholder shell. Closes on the × button, a backdrop click, or Escape.
 * Stays mounted a beat past `open` going false so the closing (minimize)
 * animation can play before it actually unmounts.
 */
export function SettingsModal({ open, onClose }: Props) {
  const mounted = usePanelMount(open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

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
          <p className={styles.placeholder}>Settings live here soon.</p>
        </div>
      </div>
    </div>
  )
}
