import styles from './LavaLamp.module.css'

interface LavaLampProps {
  connected: boolean
}

/** Replaces the old static connection dot: an outlined, morphing blob trio
 * that flows continuously while connected, and freezes/dims while not.
 * Stroke color tracks `var(--accent)`, so it follows the selected theme. */
export function LavaLamp({ connected }: LavaLampProps) {
  return (
    <span
      className={`${styles.lamp} ${connected ? styles.lampOn : styles.lampOff}`}
      title={connected ? 'connected' : 'disconnected'}
    >
      <svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true" focusable="false">
        <circle className={styles.blob1} cx="14" cy="10" r="6" />
        <circle className={styles.blob2} cx="14" cy="18" r="5" />
        <circle className={styles.blob3} cx="10" cy="14" r="4" />
      </svg>
    </span>
  )
}
