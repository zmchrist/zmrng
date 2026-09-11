import { describe, it, expect } from 'vitest'
import {
  ScannerUnavailableError,
  defaultScanRunnerFactory,
  wellFormedScanOutput,
} from '../src/scanRunner.js'
import type { ScanRequest, RawScanOutput, ScanRunnerFactory } from '../src/scanRunner.js'

// The default factory (execFile semgrep + osv-scanner) is DEFERRED
// hand-verification: the real binaries are absent on the dev Mac, so it is
// never exercised here. These tests pin the injectable seam shape + the pure
// fail-closed helper that the orchestrator uses to reject garbage scanner output.

describe('scanRunner seam', () => {
  it('exposes defaultScanRunnerFactory as an injectable factory function', () => {
    expect(typeof defaultScanRunnerFactory).toBe('function')
    // Structurally a ScanRunnerFactory — a fake with the same shape substitutes.
    const fake: ScanRunnerFactory = async (req: ScanRequest): Promise<RawScanOutput> => ({
      semgrep: '{"results":[]}',
      osv: '{"results":[]}',
      toolVersions: { semgrep: 'fake', 'osv-scanner': 'fake', mode: req.sast ? 'sast+sca' : 'sca' },
    })
    expect(typeof fake).toBe('function')
  })

  it('ScannerUnavailableError is a distinct Error subclass (drives the blocked path)', () => {
    const e = new ScannerUnavailableError('semgrep could not be provisioned')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(ScannerUnavailableError)
    expect(e.name).toBe('ScannerUnavailableError')
    expect(e.message).toMatch(/semgrep/)
  })
})

describe('wellFormedScanOutput — fail-closed guard', () => {
  it('treats empty / whitespace as well-formed (a clean scan with no findings)', () => {
    expect(wellFormedScanOutput('')).toBe(true)
    expect(wellFormedScanOutput('   \n ')).toBe(true)
  })

  it('accepts a JSON object (the shape both scanners emit)', () => {
    expect(wellFormedScanOutput('{"results":[]}')).toBe(true)
    expect(wellFormedScanOutput('{"results":[{"check_id":"x"}]}')).toBe(true)
  })

  it('rejects non-empty, non-JSON-object garbage (→ red-blocked, never a false pass)', () => {
    expect(wellFormedScanOutput('not json at all')).toBe(false)
    expect(wellFormedScanOutput('{bad')).toBe(false)
    // A bare array / primitive is not the object shape either scanner emits.
    expect(wellFormedScanOutput('[]')).toBe(false)
    expect(wellFormedScanOutput('null')).toBe(false)
    expect(wellFormedScanOutput('42')).toBe(false)
  })
})
