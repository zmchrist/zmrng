import { describe, it, expect } from 'vitest'
import {
  READY_RE,
  PLAN_READY_RE,
  VALIDATING_RE,
  BLOCKED_RE,
  PR_RE,
  parsePlanDecision,
} from '../src/phases.js'

// The control tokens are the contract between a worker's output stream and the
// state machine. A false positive advances a task on a token quoted in prose; a
// false negative strands it. Both the match and near-miss no-match cases matter.

describe('READY_RE', () => {
  it('matches ZMRNG_READY on its own line', () => {
    expect(READY_RE.test('scope looks good\nZMRNG_READY\nhere is the summary')).toBe(true)
  })
  it('matches with leading/trailing whitespace on the line', () => {
    expect(READY_RE.test('   ZMRNG_READY   ')).toBe(true)
  })
  it('does NOT match when quoted inline in prose', () => {
    expect(READY_RE.test('I will print `ZMRNG_READY` when the clarify phase is done.')).toBe(false)
  })
  it('does NOT match a token with trailing words on the same line', () => {
    expect(READY_RE.test('ZMRNG_READY now please')).toBe(false)
  })
})

describe('PLAN_READY_RE', () => {
  it('matches with trailing params', () => {
    expect(
      PLAN_READY_RE.test('ZMRNG_PLAN_READY model=opus effort=high plan=.agents/plans/x.md'),
    ).toBe(true)
  })
  it('does NOT match when embedded mid-sentence', () => {
    expect(PLAN_READY_RE.test('output ZMRNG_PLAN_READYwhendone')).toBe(false)
  })
})

describe('VALIDATING_RE', () => {
  it('matches on its own line', () => {
    expect(VALIDATING_RE.test('done implementing\nZMRNG_VALIDATING\n')).toBe(true)
  })
  it('does NOT match when quoted in prose', () => {
    expect(VALIDATING_RE.test('then I print ZMRNG_VALIDATING before the QA chain')).toBe(false)
  })
})

describe('BLOCKED_RE', () => {
  it('captures the reason after the colon', () => {
    const m = 'ZMRNG_BLOCKED: qa agent not available'.match(BLOCKED_RE)
    expect(m?.[1]?.trim()).toBe('qa agent not available')
  })
  it('matches with leading whitespace', () => {
    expect(BLOCKED_RE.test('  ZMRNG_BLOCKED: missing subagent')).toBe(true)
  })
})

describe('PR_RE', () => {
  it('extracts a valid GitHub PR URL', () => {
    const text = 'opened https://github.com/zmchrist/zmrng/pull/42 for review'
    expect(text.match(PR_RE)?.[0]).toBe('https://github.com/zmchrist/zmrng/pull/42')
  })
  it('matches a PR URL for ANY repo (detector is repo-agnostic by design)', () => {
    // The state machine gates PR acceptance on task status, not on repo slug,
    // so the regex itself matches any owner/repo — this documents that.
    expect(PR_RE.test('https://github.com/other-owner/other-repo/pull/7')).toBe(true)
  })
  it('does NOT match a GitHub issue URL', () => {
    expect(PR_RE.test('https://github.com/zmchrist/zmrng/issues/42')).toBe(false)
  })
  it('does NOT match a bare repo URL with no /pull/<n>', () => {
    expect(PR_RE.test('https://github.com/zmchrist/zmrng')).toBe(false)
  })
})

describe('parsePlanDecision', () => {
  it('parses valid params', () => {
    const d = parsePlanDecision('ZMRNG_PLAN_READY model=sonnet effort=medium plan=.agents/plans/y.md')
    expect(d).toEqual({ model: 'sonnet', effort: 'medium', planPath: '.agents/plans/y.md' })
  })
  it('falls back to opus/high for invalid model/effort values', () => {
    const d = parsePlanDecision('ZMRNG_PLAN_READY model=gpt5 effort=turbo plan=p.md')
    expect(d).toEqual({ model: 'opus', effort: 'high', planPath: 'p.md' })
  })
  it('defaults missing params (no model/effort/plan) to opus/high/null', () => {
    const d = parsePlanDecision('ZMRNG_PLAN_READY')
    expect(d).toEqual({ model: 'opus', effort: 'high', planPath: null })
  })
  it('returns undefined when the token is absent', () => {
    expect(parsePlanDecision('no token here')).toBeUndefined()
  })
})
