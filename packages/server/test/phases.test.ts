import { describe, it, expect } from 'vitest'
import {
  READY_RE,
  PLAN_READY_RE,
  VALIDATING_RE,
  BLOCKED_RE,
  PR_RE,
  parsePlanDecision,
  condenseTranscript,
  splitScopeSummary,
  CLARIFY_TRANSCRIPT_MAX_BYTES,
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
  it('matches a PR URL for ANY repo — repo-scoping is the state machine, not the regex', () => {
    // The regex deliberately matches any owner/repo; TaskManager then filters
    // to the task's own target repo (see the "ignores a PR URL belonging to a
    // different repo" case in taskManager.test.ts). Keeping the regex broad is
    // what lets a local-only target still detect a PR at all.
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

// D1 — the clarify transcript is bounded before injection into plan/execute/
// resume kickoffs. The confirmed-scope summary (emitted after ZMRNG_READY) is
// always retained verbatim; the remaining turn history is tail-truncated to a
// byte budget, oldest turns first. No LLM round-trip.

describe('splitScopeSummary', () => {
  it('returns undefined when the turn carries no ZMRNG_READY line', () => {
    expect(splitScopeSummary('just a normal answer\nwith two lines')).toBeUndefined()
  })
  it('splits preamble (before) from the scope summary (after ZMRNG_READY)', () => {
    const split = splitScopeSummary('scope is clear\nZMRNG_READY\nWe will add a widget to the header.')
    expect(split).toEqual({
      preamble: 'scope is clear',
      summary: 'We will add a widget to the header.',
    })
  })
  it('does NOT split on a token quoted inline (must be on its own line)', () => {
    expect(splitScopeSummary('I will print `ZMRNG_READY` when done.')).toBeUndefined()
  })
})

describe('condenseTranscript (D1 byte cap)', () => {
  it('passes an under-budget transcript through unchanged, with the summary appended last', () => {
    const turns = ['OPERATOR: do the thing', 'WORKER: on it']
    expect(condenseTranscript(turns, 'confirmed: build X')).toBe(
      'OPERATOR: do the thing\n\nWORKER: on it\n\nconfirmed: build X',
    )
  })

  it('with no scope summary, joins the turns unchanged when under budget', () => {
    const turns = ['OPERATOR: a', 'WORKER: b']
    expect(condenseTranscript(turns, null)).toBe('OPERATOR: a\n\nWORKER: b')
  })

  it('tail-truncates to the byte budget, dropping the OLDEST turns first', () => {
    // Each turn ~100 bytes; budget 250 → only the newest 2 fit (2*100 + sep).
    const turns = [
      `OPERATOR: ${'a'.repeat(90)}`,
      `WORKER: ${'b'.repeat(92)}`,
      `OPERATOR: ${'c'.repeat(90)}`,
    ]
    const out = condenseTranscript(turns, null, 250)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(250)
    // Oldest dropped, newest kept.
    expect(out).not.toContain('a'.repeat(90))
    expect(out).toContain('b'.repeat(92))
    expect(out).toContain('c'.repeat(90))
  })

  it('NEVER drops the scope summary; the whole (over-budget) turn history falls away first', () => {
    // Each turn far exceeds the budget, so none survive the tail-truncation;
    // the scope summary is exempt and retained verbatim even though it too is
    // larger than the budget.
    const turns = [`OPERATOR: ${'x'.repeat(300)}`, `WORKER: ${'y'.repeat(300)}`]
    const bigSummary = 'SCOPE: ' + 'z'.repeat(500)
    const out = condenseTranscript(turns, bigSummary, 100)
    expect(out).toContain(bigSummary)
    // Only the (budget-exempt) summary remains — the over-budget turns are gone.
    expect(out).toBe(bigSummary)
    expect(out).not.toContain('x'.repeat(300))
  })

  it('exposes a sane default budget (~8 KB) so normal transcripts are unbounded in practice', () => {
    expect(CLARIFY_TRANSCRIPT_MAX_BYTES).toBe(8 * 1024)
    const turns = ['OPERATOR: short', 'WORKER: also short']
    // Default budget dwarfs a short chat → unchanged.
    expect(condenseTranscript(turns, null)).toBe('OPERATOR: short\n\nWORKER: also short')
  })
})
