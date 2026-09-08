import styles from './ThinkingDots.module.css'

/**
 * Animated three-dot "agent is thinking" indicator, shown inside an agent-side
 * chat bubble in the gap between the operator's message and the agent's first
 * reply token — so a working agent never looks frozen while you wait.
 *
 * Colors come from theme tokens only; the global `prefers-reduced-motion` clamp
 * in `theme.css` freezes the bounce (dots stay visible, just static) for users
 * who disable motion.
 */
export function ThinkingDots() {
  return (
    <span className={styles.dots} role="status" aria-label="Agent is thinking">
      <span className={styles.dot} />
      <span className={styles.dot} />
      <span className={styles.dot} />
    </span>
  )
}
