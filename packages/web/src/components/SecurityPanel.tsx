import styles from './SecurityPanel.module.css'
import type { SecurityFinding, SecurityScan, SecurityStatus } from '../types'

interface Props {
  /** The task's current security-gate state (last verdict / opt-out). */
  securityStatus?: SecurityStatus
  /** Persisted scan rounds, oldest-first (from GET /api/tasks/:id/security-scans). */
  scans: SecurityScan[]
}

/** Human label + a status token for the security-gate state pill. */
const STATUS_META: Record<SecurityStatus, { label: string; token: string }> = {
  pending: { label: 'Pending', token: 'var(--status-validating)' },
  pass: { label: 'Pass', token: 'var(--status-done)' },
  fail: { label: 'Fail', token: 'var(--status-blocked)' },
  skipped: { label: 'Skipped', token: 'var(--text-faint)' },
}

/**
 * The D1 default block rule, mirrored here for READ-ONLY display of which
 * persisted findings actually blocked: a semgrep ERROR + HIGH confidence, or an
 * osv vuln with a fix available. Everything else is recorded but non-blocking.
 * (The authoritative verdict is asserted server-side by `evaluateThreshold`;
 * this only decides what to surface in the panel.)
 */
function isBlocking(f: SecurityFinding): boolean {
  if (f.tool === 'semgrep') return f.severity === 'ERROR' && f.confidence === 'HIGH'
  return f.fixAvailable === true
}

/** One-line location: `path:line` for SAST, `package (CVE)` for SCA. */
function location(f: SecurityFinding): string {
  if (f.tool === 'semgrep') {
    if (!f.path) return '(unknown location)'
    return f.line ? `${f.path}:${f.line}` : f.path
  }
  const pkg = f.package ?? '(unknown package)'
  return f.cve ? `${pkg} (${f.cve})` : pkg
}

/**
 * Read-only Security section for the worker/task panel: the current gate status,
 * the round count, and the latest round's blocking findings. Fed by the persisted
 * scan rows (and live-refreshed by the `security` ws event). No board column, no
 * status pill, no `--status-scanning` token — the scan folds into `validating` (D6).
 */
export function SecurityPanel({ securityStatus, scans }: Props) {
  const latest = scans.length > 0 ? scans[scans.length - 1] : null
  const meta = securityStatus ? STATUS_META[securityStatus] : null
  const blocking = latest ? latest.findings.filter(isBlocking) : []

  return (
    <section className={styles.panel} aria-label="Security">
      <div className={styles.head}>
        <span className={styles.title}>Security</span>
        {meta && (
          <span className={styles.pill} style={{ ['--pill' as string]: meta.token }}>
            {meta.label}
          </span>
        )}
        {latest && (
          <span className={styles.rounds}>
            round {latest.round} of {scans.length}
          </span>
        )}
      </div>

      {securityStatus === 'skipped' && (
        <div className={styles.note}>Security gate disabled for this repo — no security scan was run.</div>
      )}

      {!latest && securityStatus !== 'skipped' && (
        <div className={styles.note}>No security scan yet for this task.</div>
      )}

      {latest && blocking.length === 0 && latest.verdict === 'pass' && (
        <div className={styles.note}>No blocking security findings.</div>
      )}

      {blocking.length > 0 && (
        <ul className={styles.findings}>
          {blocking.map((f, i) => (
            <li key={`${f.tool}-${f.ruleId}-${i}`} className={styles.finding}>
              <span className={styles.tool} data-tool={f.tool}>
                {f.tool}
              </span>
              <span className={styles.sev}>{f.severity}</span>
              <span className={styles.rule}>{f.ruleId}</span>
              <span className={styles.loc}>{location(f)}</span>
              <span className={styles.desc}>{f.title}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
