import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SecurityPanel } from '../src/components/SecurityPanel'
import type { SecurityScan } from '../src/types'

/** Two scan rounds: round 1 red with a blocking osv finding, round 2 still red. */
const scans: SecurityScan[] = [
  {
    id: 1,
    taskId: 't1',
    round: 1,
    verdict: 'fail',
    findings: [
      {
        tool: 'osv',
        ruleId: 'GHSA-jf85-cpcp-j695',
        severity: 'ERROR',
        title: 'Prototype pollution in lodash',
        package: 'lodash',
        cve: 'CVE-2019-10744',
        fixAvailable: true,
      },
      // a non-blocking finding (no fix) that must NOT be shown as blocking
      {
        tool: 'osv',
        ruleId: 'GHSA-nofix',
        severity: 'ERROR',
        title: 'No fix available',
        package: 'abandoned-lib',
        fixAvailable: false,
      },
    ],
    toolVersions: { 'osv-scanner': '1.0.0' },
    createdAt: '2026-09-10T00:00:00.000Z',
  },
  {
    id: 2,
    taskId: 't1',
    round: 2,
    verdict: 'fail',
    findings: [
      {
        tool: 'semgrep',
        ruleId: 'python.lang.security.audit.subprocess-shell-true',
        severity: 'ERROR',
        title: 'Shell injection risk',
        path: 'src/app.py',
        line: 42,
        confidence: 'HIGH',
      },
    ],
    toolVersions: { semgrep: '1.0.0' },
    createdAt: '2026-09-10T00:01:00.000Z',
  },
]

describe('<SecurityPanel>', () => {
  it('renders the latest round blocking findings and the round count', () => {
    render(<SecurityPanel securityStatus="fail" scans={scans} />)
    // status
    expect(screen.getByText(/fail/i)).toBeInTheDocument()
    // round count: 2 rounds run
    expect(screen.getByText(/round 2/i)).toBeInTheDocument()
    // the latest (round 2) blocking finding is rendered with tool + rule + location
    expect(screen.getByText(/subprocess-shell-true/)).toBeInTheDocument()
    expect(screen.getByText(/src\/app\.py:42/)).toBeInTheDocument()
    expect(screen.getByText(/semgrep/i)).toBeInTheDocument()
  })

  it('renders osv package + CVE for a dependency finding and hides non-blocking ones', () => {
    render(<SecurityPanel securityStatus="fail" scans={[scans[0]]} />)
    // package name appears (in the location and/or the title)
    expect(screen.getAllByText(/lodash/).length).toBeGreaterThan(0)
    expect(screen.getByText(/lodash \(CVE-2019-10744\)/)).toBeInTheDocument()
    // the no-fix finding is NOT blocking → not shown in the blocking list
    expect(screen.queryByText(/abandoned-lib/)).toBeNull()
  })

  it('shows a skipped state and no findings when the repo opted out', () => {
    render(<SecurityPanel securityStatus="skipped" scans={[]} />)
    expect(screen.getByText(/skipped/i)).toBeInTheDocument()
    expect(screen.getByText(/no security scan/i)).toBeInTheDocument()
  })

  it('renders nothing meaningful (no crash) when there is no security state yet', () => {
    render(<SecurityPanel securityStatus={undefined} scans={[]} />)
    // the section is present (via its aria-label) even with no state
    expect(screen.getByLabelText('Security')).toBeInTheDocument()
  })
})
