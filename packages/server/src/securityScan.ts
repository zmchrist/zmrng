// Pure, IO-free, React-free security-scan module. Mirrors the tolerant-parser /
// pure-reducer seams (e.g. terminalProtocol / workspaceLayout): the parsers NEVER
// throw — malformed / empty / unknown JSON yields []. This module is the whole of
// the deterministic gate LOGIC; the scanner IO (spawning semgrep/osv-scanner) is a
// separate injected runner (Slice 2). Unit-tested against committed fixture JSON.

import type {
  SecurityFinding,
  SecurityPolicy,
  SecuritySeverity,
  SecurityConfidence,
  SecurityVerdict,
} from './types.js'

/** One raw Semgrep result, normalized to the fields the gate cares about. */
export interface SemgrepFinding {
  checkId: string
  severity: SecuritySeverity
  confidence: SecurityConfidence
  message: string
  path?: string
  line?: number
}

/** One raw osv-scanner vulnerability, normalized (incl. transitive deps). */
export interface OsvFinding {
  id: string
  package: string
  summary: string
  cve?: string
  /** True when at least one affected range declares a `fixed` version. */
  fixAvailable: boolean
}

/** Parse JSON, returning `undefined` (never throwing) on any malformed input. */
function tryParse(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Coerce an arbitrary semgrep severity string onto the SecuritySeverity scale. */
function toSeverity(v: unknown): SecuritySeverity {
  const s = typeof v === 'string' ? v.toUpperCase() : ''
  if (s === 'ERROR') return 'ERROR'
  if (s === 'WARNING') return 'WARNING'
  return 'INFO'
}

/** Coerce an arbitrary confidence string onto the SecurityConfidence scale. */
function toConfidence(v: unknown): SecurityConfidence {
  const s = typeof v === 'string' ? v.toUpperCase() : ''
  if (s === 'HIGH') return 'HIGH'
  if (s === 'LOW') return 'LOW'
  return 'MEDIUM'
}

/**
 * Tolerant Semgrep parser. Walks `results[]`, dropping any entry that lacks a
 * usable `check_id`. Reads `extra.severity`, `extra.metadata.confidence`,
 * `path`, and `start.line`. Unknown shape → [].
 */
export function parseSemgrep(raw: string): SemgrepFinding[] {
  const root = tryParse(raw)
  if (!isRecord(root)) return []
  const results = root.results
  if (!Array.isArray(results)) return []
  const out: SemgrepFinding[] = []
  for (const r of results) {
    if (!isRecord(r)) continue
    const checkId = typeof r.check_id === 'string' ? r.check_id : undefined
    if (!checkId) continue
    const extra = isRecord(r.extra) ? r.extra : {}
    const metadata = isRecord(extra.metadata) ? extra.metadata : {}
    const start = isRecord(r.start) ? r.start : {}
    const line = typeof start.line === 'number' ? start.line : undefined
    out.push({
      checkId,
      severity: toSeverity(extra.severity),
      confidence: toConfidence(metadata.confidence),
      message: typeof extra.message === 'string' ? extra.message : checkId,
      path: typeof r.path === 'string' ? r.path : undefined,
      line,
    })
  }
  return out
}

/** First CVE-style alias from an osv `aliases` array, if any. */
function firstCve(aliases: unknown): string | undefined {
  if (!Array.isArray(aliases)) return undefined
  for (const a of aliases) {
    if (typeof a === 'string' && a.startsWith('CVE-')) return a
  }
  return undefined
}

/** True if any affected range declares a `fixed` event → a fix version exists. */
function hasFix(affected: unknown): boolean {
  if (!Array.isArray(affected)) return false
  for (const a of affected) {
    if (!isRecord(a)) continue
    const ranges = a.ranges
    if (!Array.isArray(ranges)) continue
    for (const range of ranges) {
      if (!isRecord(range)) continue
      const events = range.events
      if (!Array.isArray(events)) continue
      for (const e of events) {
        if (isRecord(e) && typeof e.fixed === 'string' && e.fixed) return true
      }
    }
  }
  return false
}

/**
 * Tolerant osv-scanner parser. Walks `results[] → packages[] → vulnerabilities[]`,
 * capturing transitive dependencies (every package in the graph is walked). For
 * each vuln records the package name, id, first CVE alias, and whether a fixed
 * version exists. Unknown shape → [].
 */
export function parseOsv(raw: string): OsvFinding[] {
  const root = tryParse(raw)
  if (!isRecord(root)) return []
  const results = root.results
  if (!Array.isArray(results)) return []
  const out: OsvFinding[] = []
  for (const result of results) {
    if (!isRecord(result)) continue
    const packages = result.packages
    if (!Array.isArray(packages)) continue
    for (const pkg of packages) {
      if (!isRecord(pkg)) continue
      const pkgInfo = isRecord(pkg.package) ? pkg.package : {}
      const pkgName = typeof pkgInfo.name === 'string' ? pkgInfo.name : ''
      const vulns = pkg.vulnerabilities
      if (!Array.isArray(vulns)) continue
      for (const v of vulns) {
        if (!isRecord(v)) continue
        const id = typeof v.id === 'string' ? v.id : undefined
        if (!id) continue
        out.push({
          id,
          package: pkgName,
          summary: typeof v.summary === 'string' ? v.summary : id,
          cve: firstCve(v.aliases),
          fixAvailable: hasFix(v.affected),
        })
      }
    }
  }
  return out
}

/**
 * Merge the two scanner outputs into the unified `SecurityFinding[]` shape.
 * Semgrep hits carry `path`/`line`/`confidence`; osv hits carry
 * `package`/`cve`/`fixAvailable`. osv findings are normalized to `ERROR`
 * severity (the block rule for osv is fix-availability, not severity).
 */
export function normalizeFindings(
  semgrep: SemgrepFinding[],
  osv: OsvFinding[],
): SecurityFinding[] {
  const out: SecurityFinding[] = []
  for (const s of semgrep) {
    out.push({
      tool: 'semgrep',
      ruleId: s.checkId,
      severity: s.severity,
      title: s.message,
      path: s.path,
      line: s.line,
      confidence: s.confidence,
    })
  }
  for (const v of osv) {
    out.push({
      tool: 'osv',
      ruleId: v.id,
      severity: 'ERROR',
      title: v.summary,
      package: v.package,
      cve: v.cve,
      fixAvailable: v.fixAvailable,
    })
  }
  return out
}

/** Numeric rank so a severity floor comparison is a simple `>=`. */
const SEVERITY_RANK: Record<SecuritySeverity, number> = { INFO: 0, WARNING: 1, ERROR: 2 }

/**
 * The deterministic gate (D1). A finding is BLOCKING iff:
 *  - semgrep: severity is at/above the policy floor AND confidence is HIGH, or
 *  - osv: a fixed version is available.
 * Everything else is recorded but never blocks. Verdict is `fail` iff any
 * finding blocks. Same input → same verdict, always.
 */
export function evaluateThreshold(
  findings: SecurityFinding[],
  policy: SecurityPolicy,
): { verdict: SecurityVerdict; blocking: SecurityFinding[] } {
  const floor = SEVERITY_RANK[policy.minSeverity]
  const blocking = findings.filter((f) => {
    if (f.tool === 'semgrep') {
      return SEVERITY_RANK[f.severity] >= floor && f.confidence === 'HIGH'
    }
    // osv (SCA): block only when a fix is available
    return f.fixAvailable === true
  })
  return { verdict: blocking.length > 0 ? 'fail' : 'pass', blocking }
}

/** Stable sort key for deterministic report ordering. */
function findingKey(f: SecurityFinding): string {
  return [f.tool, f.ruleId, f.package ?? '', f.path ?? '', f.line ?? 0].join('\u0000')
}

/**
 * Render the blocking findings into a stable, deterministic report string fed
 * to the fix-round kickoff (Slice 2). Sorted by a fixed key so identical input
 * always produces an identical string (contract-pinned later).
 */
export function formatFindingsForAgent(blocking: SecurityFinding[]): string {
  if (blocking.length === 0) return 'No blocking security findings.'
  const sorted = [...blocking].sort((a, b) => {
    // Byte-stable code-unit comparison (NOT locale-aware localeCompare, whose
    // ordering depends on the host OS/locale) so an identical finding set always
    // produces a byte-identical report — the determinism contract prompts.test.ts pins.
    const ka = findingKey(a)
    const kb = findingKey(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  const lines = sorted.map((f) => {
    if (f.tool === 'semgrep') {
      const loc = f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : '(unknown location)'
      return `- [semgrep ${f.severity}/${f.confidence ?? 'UNKNOWN'}] ${f.ruleId} at ${loc} — ${f.title}`
    }
    const pkg = f.package ?? '(unknown package)'
    const cve = f.cve ? ` (${f.cve})` : ''
    return `- [osv] ${f.ruleId}${cve} in ${pkg} — ${f.title} (fix available)`
  })
  return `${blocking.length} blocking security finding(s):\n${lines.join('\n')}`
}
