import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  parseSemgrep,
  parseOsv,
  normalizeFindings,
  evaluateThreshold,
  formatFindingsForAgent,
} from '../src/securityScan.js'
import type { SecurityFinding, SecurityPolicy } from '../src/types.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const semgrepRaw = readFileSync(path.join(FIXTURES, 'semgrep.json'), 'utf8')
const osvRaw = readFileSync(path.join(FIXTURES, 'osv.json'), 'utf8')

/** The locked-default policy (mirrors resolveSecurityPolicy defaults). */
const policy: SecurityPolicy = {
  enabled: true,
  maxRounds: 2,
  semgrepConfig: 'security/semgrep-rules,p/secrets',
  minSeverity: 'ERROR',
}

describe('parseSemgrep — tolerant', () => {
  it('returns [] on empty / whitespace input', () => {
    expect(parseSemgrep('')).toEqual([])
    expect(parseSemgrep('   ')).toEqual([])
  })

  it('returns [] on malformed JSON without throwing', () => {
    expect(() => parseSemgrep('{not json')).not.toThrow()
    expect(parseSemgrep('{not json')).toEqual([])
  })

  it('returns [] on unknown / mis-shaped JSON (no results array)', () => {
    expect(parseSemgrep('{"foo": 1}')).toEqual([])
    expect(parseSemgrep('[]')).toEqual([])
    expect(parseSemgrep('null')).toEqual([])
    expect(parseSemgrep('"string"')).toEqual([])
    expect(parseSemgrep('{"results": "nope"}')).toEqual([])
  })

  it('drops individual malformed result entries but keeps the good ones', () => {
    const raw = JSON.stringify({
      results: [
        null,
        42,
        { path: 'x.py' }, // no check_id → dropped
        {
          check_id: 'r1',
          path: 'a.py',
          start: { line: 3 },
          extra: { severity: 'ERROR', message: 'm', metadata: { confidence: 'HIGH' } },
        },
      ],
    })
    const out = parseSemgrep(raw)
    expect(out).toHaveLength(1)
    expect(out[0].checkId).toBe('r1')
  })

  it('parses the fixture into normalized severity + confidence + location', () => {
    const out = parseSemgrep(semgrepRaw)
    expect(out).toHaveLength(3)
    const first = out[0]
    expect(first.checkId).toBe('python.lang.security.audit.subprocess-shell-true')
    expect(first.severity).toBe('ERROR')
    expect(first.confidence).toBe('HIGH')
    expect(first.path).toBe('src/app.py')
    expect(first.line).toBe(42)
    expect(out[1].confidence).toBe('LOW')
    expect(out[2].severity).toBe('WARNING')
  })
})

describe('parseOsv — tolerant', () => {
  it('returns [] on empty / malformed / unknown input', () => {
    expect(parseOsv('')).toEqual([])
    expect(parseOsv('{bad')).toEqual([])
    expect(parseOsv('{"foo": 1}')).toEqual([])
    expect(parseOsv('{"results": {}}')).toEqual([])
    expect(parseOsv('null')).toEqual([])
  })

  it('walks results → packages → vulnerabilities incl. transitive deps', () => {
    const out = parseOsv(osvRaw)
    expect(out).toHaveLength(3)
    const ids = out.map((v) => v.id)
    expect(ids).toContain('GHSA-jf85-cpcp-j695')
    // the transitive minimist dep must be captured
    const transitive = out.find((v) => v.package === 'minimist')
    expect(transitive).toBeDefined()
    expect(transitive?.cve).toBe('CVE-2020-7598')
  })

  it('captures whether a fixed version exists (fixAvailable)', () => {
    const out = parseOsv(osvRaw)
    expect(out.find((v) => v.package === 'lodash')?.fixAvailable).toBe(true)
    expect(out.find((v) => v.package === 'minimist')?.fixAvailable).toBe(true)
    expect(out.find((v) => v.package === 'abandoned-lib')?.fixAvailable).toBe(false)
  })
})

describe('normalizeFindings', () => {
  it('merges semgrep + osv into the unified shape', () => {
    const findings = normalizeFindings(parseSemgrep(semgrepRaw), parseOsv(osvRaw))
    expect(findings).toHaveLength(6)
    const semgrep = findings.filter((f) => f.tool === 'semgrep')
    const osv = findings.filter((f) => f.tool === 'osv')
    expect(semgrep).toHaveLength(3)
    expect(osv).toHaveLength(3)
    const shellInj = semgrep.find((f) => f.ruleId.includes('subprocess'))!
    expect(shellInj.severity).toBe('ERROR')
    expect(shellInj.confidence).toBe('HIGH')
    expect(shellInj.path).toBe('src/app.py')
    expect(shellInj.line).toBe(42)
    const lodash = osv.find((f) => f.package === 'lodash')!
    expect(lodash.cve).toBe('CVE-2019-10744')
    expect(lodash.fixAvailable).toBe(true)
  })
})

describe('evaluateThreshold — D1 deterministic gate', () => {
  it('blocks only on (semgrep ERROR + HIGH confidence) OR (osv fix-available)', () => {
    const findings = normalizeFindings(parseSemgrep(semgrepRaw), parseOsv(osvRaw))
    const { verdict, blocking } = evaluateThreshold(findings, policy)
    expect(verdict).toBe('fail')
    // 1 semgrep (ERROR+HIGH) + 2 osv (lodash, minimist fix-available) = 3
    expect(blocking).toHaveLength(3)
    const blockingRules = blocking.map((f) => f.ruleId)
    expect(blockingRules).toContain('python.lang.security.audit.subprocess-shell-true')
    expect(blockingRules).toContain('GHSA-jf85-cpcp-j695')
    expect(blockingRules).toContain('GHSA-vh95-rmgr-6w4m')
    // ERROR + LOW confidence does NOT block
    expect(blockingRules).not.toContain('generic.secrets.security.detected-generic-api-key')
    // WARNING + HIGH does NOT block
    expect(blockingRules).not.toContain('javascript.lang.best-practice.eqeqeq-eq')
    // osv without a fix does NOT block
    expect(blockingRules).not.toContain('GHSA-0000-nofix-0000')
  })

  it('passes with an empty findings list', () => {
    const { verdict, blocking } = evaluateThreshold([], policy)
    expect(verdict).toBe('pass')
    expect(blocking).toEqual([])
  })

  it('passes when nothing meets the block rule', () => {
    const findings: SecurityFinding[] = [
      { tool: 'semgrep', ruleId: 'w', severity: 'WARNING', title: 'w', confidence: 'HIGH' },
      { tool: 'semgrep', ruleId: 'e-low', severity: 'ERROR', title: 'e', confidence: 'LOW' },
      { tool: 'osv', ruleId: 'v', severity: 'ERROR', title: 'v', package: 'p', fixAvailable: false },
    ]
    expect(evaluateThreshold(findings, policy).verdict).toBe('pass')
  })

  it('honors a lowered severity floor (WARNING blocks ERROR and WARNING)', () => {
    const findings: SecurityFinding[] = [
      { tool: 'semgrep', ruleId: 'w', severity: 'WARNING', title: 'w', confidence: 'HIGH' },
    ]
    const relaxed: SecurityPolicy = { ...policy, minSeverity: 'WARNING' }
    expect(evaluateThreshold(findings, relaxed).blocking).toHaveLength(1)
    // but the default ERROR floor lets that same WARNING pass
    expect(evaluateThreshold(findings, policy).blocking).toHaveLength(0)
  })
})

describe('formatFindingsForAgent — deterministic ordering', () => {
  it('produces identical output for identical input, regardless of input order', () => {
    const findings = normalizeFindings(parseSemgrep(semgrepRaw), parseOsv(osvRaw))
    const { blocking } = evaluateThreshold(findings, policy)
    const shuffled = [...blocking].reverse()
    const a = formatFindingsForAgent(blocking)
    const b = formatFindingsForAgent(shuffled)
    expect(a).toBe(b)
    expect(a).toContain('subprocess')
    expect(a.length).toBeGreaterThan(0)
  })

  it('returns a stable string for an empty list', () => {
    expect(formatFindingsForAgent([])).toBe(formatFindingsForAgent([]))
  })
})
