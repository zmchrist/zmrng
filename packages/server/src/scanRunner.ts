// Injected security-scan RUNNER seam. Mirrors the RunnerFactory / PtyFactory
// factory-injection pattern (runner.ts): the orchestrator (phases.ts) depends
// on the `ScanRunnerFactory` type, and tests inject a `FakeScanRunner` returning
// fixture JSON so the state machine never spawns real scanners, hits the network,
// or needs the binaries installed. The pure gate LOGIC lives in securityScan.ts;
// this module is only the IO edge (spawning semgrep / osv-scanner).

import { execFileSync } from 'node:child_process'
import type { SecurityPolicy } from './types.js'

/**
 * One deterministic scan request. `worktree` is the checkout to scan; `baseRef`
 * is the repo's default branch (the merge-base target for a baseline-diff);
 * `policy` carries the effective (merged) per-task policy. `sast` gates the
 * Semgrep SAST pass: the `plan` flow runs full SAST+SCA, the `direct` flow runs
 * SCA-only (D2) — so `sast === false` means "osv/SCA only, skip Semgrep".
 */
export interface ScanRequest {
  worktree: string
  baseRef: string
  policy: SecurityPolicy
  /** true → run Semgrep SAST + osv SCA (plan flow); false → osv SCA only (direct, D2). */
  sast: boolean
}

/**
 * The raw scanner stdout, kept as strings so the tolerant pure parsers in
 * securityScan.ts own all shape-handling. `semgrep` is '' when SAST is skipped
 * (SCA-only direct flow). `toolVersions` records the pinned versions for the
 * persisted scan row.
 */
export interface RawScanOutput {
  semgrep: string
  osv: string
  toolVersions: Record<string, string>
}

/** Builds/returns a deterministic scan for a request. Swappable for tests/adapters. */
export type ScanRunnerFactory = (req: ScanRequest) => Promise<RawScanOutput>

/**
 * Thrown by a scan runner when the scanners are ABSENT and cannot be
 * provisioned (D5). The orchestrator treats this DISTINCTLY from a scan
 * failure: a `ScannerUnavailableError` parks the task `blocked` with an install
 * message, whereas any OTHER rejection / garbage output is fail-closed to a RED
 * verdict (never a pass). Keeping the two apart is why this is its own class.
 */
export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScannerUnavailableError'
  }
}

/**
 * Fail-closed guard the orchestrator applies to each raw scanner output before
 * parsing: empty/whitespace is a clean scan with no findings (well-formed);
 * a non-empty string that is not a JSON OBJECT (the shape both scanners emit)
 * is garbage and must be treated as RED-BLOCKED, never silently parsed to `[]`
 * (which the tolerant parsers would do → a false pass). Never throws.
 */
export function wellFormedScanOutput(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return true
  try {
    const v: unknown = JSON.parse(trimmed)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    return false
  }
}

const PROBE_TIMEOUT_MS = 1500

/** Best-effort presence check for a binary on PATH (mirrors preflight.checkOnPath). */
function onPath(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

/**
 * The default factory: run semgrep (SAST, when `req.sast`) + osv-scanner (SCA)
 * from the worktree, VENDORED/OFFLINE (D4), baseline-diffed against the
 * merge-base (D-baseline). Auto-provision the binaries on first use (D5); if
 * provisioning is impossible, throw `ScannerUnavailableError`.
 *
 * DEFERRED HAND-VERIFICATION: semgrep and osv-scanner are ABSENT on the dev Mac,
 * so this default path is NOT exercised by the test suite — every state-machine
 * test injects a FakeScanRunner. The "real tools emit exactly these JSON shapes"
 * check is an orchestrator/user-owned hand-verification (post-merge, on a repo
 * with a planted vuln). Do NOT install the real binaries or hit the network here.
 */
export const defaultScanRunnerFactory: ScanRunnerFactory = async (
  req: ScanRequest,
): Promise<RawScanOutput> => {
  // Preflight: both binaries must be reachable. Auto-provisioning (pinned
  // uvx/venv semgrep + pinned static osv-scanner binary) is an operator-owned
  // step; when absent AND unprovisionable we surface a ScannerUnavailableError
  // so the orchestrator parks `blocked` with an actionable install message
  // rather than a false pass.
  const needSemgrep = req.sast
  const missing: string[] = []
  if (needSemgrep && !onPath('semgrep')) missing.push('semgrep')
  if (!onPath('osv-scanner')) missing.push('osv-scanner')
  if (missing.length > 0) {
    throw new ScannerUnavailableError(
      `${missing.join(' and ')} not found on PATH and could not be auto-provisioned — install ${missing.join(
        ' / ',
      )} (or set the repo's security.enabled=false to opt out)`,
    )
  }

  // Baseline-diff target: only findings the branch introduced vs the merge-base.
  let mergeBase = ''
  try {
    mergeBase = execFileSync('git', ['merge-base', req.baseRef, 'HEAD'], {
      cwd: req.worktree,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    }).trim()
  } catch {
    // A shallow/detached worktree with no merge-base falls back to a full scan
    // (mergeBase stays '').
  }

  const toolVersions: Record<string, string> = {}
  let semgrep = ''
  if (needSemgrep) {
    const args = ['--config', req.policy.semgrepConfig, '--json']
    if (mergeBase) args.push('--baseline-commit', mergeBase)
    semgrep = runCapture('semgrep', args, req.worktree)
    toolVersions.semgrep = safeVersion('semgrep', ['--version'])
  }
  // osv-scanner: offline vuln DB (D4), recursive over the worktree.
  const osv = runCapture(
    'osv-scanner',
    ['--format', 'json', '--offline', '--recursive', '.'],
    req.worktree,
  )
  toolVersions['osv-scanner'] = safeVersion('osv-scanner', ['--version'])
  toolVersions.mode = needSemgrep ? 'sast+sca' : 'sca'

  return { semgrep, osv, toolVersions }
}

/**
 * Run a scanner and return stdout, tolerating a NON-ZERO exit (both semgrep and
 * osv-scanner exit non-zero when they FIND issues — that is a normal "findings
 * present" signal, not a crash). The stdout JSON is still valid in that case, so
 * we capture it from the thrown error. A genuine spawn failure yields '' and the
 * orchestrator's `wellFormedScanOutput` guard fails it closed.
 */
function runCapture(bin: string, args: string[], cwd: string): string {
  try {
    return execFileSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    const out = (err as { stdout?: string | Buffer }).stdout
    if (typeof out === 'string') return out
    if (out) return out.toString('utf8')
    return ''
  }
}

/** Best-effort version string for the persisted scan row; never throws. */
function safeVersion(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}
