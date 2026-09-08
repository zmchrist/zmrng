import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  PR_BODY_FILE,
  PR_BODY_TEMPLATE,
  clarifyKickoff,
  directKickoff,
  executeKickoff,
  planKickoff,
  resumeKickoff,
  systemPrompt,
} from '../src/phases.js'
import type { Task, TaskStatus } from '../src/types.js'

// The kickoff/system prompts ARE the harness: the lifecycle (Plan → TDD →
// Review → Validate → Sync Docs), branch-only enforcement, and the guaranteed
// PR checklist exist only as text in these strings. A silent edit that drops a
// rule degrades every future worker run with no other signal, so the rules are
// pinned here as a contract.

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const task: Task = {
  id: 't1',
  title: 'Add a widget',
  body: 'Widgets should render.',
  status: 'planning',
  repoId: 'example',
  model: 'opus',
  effort: 'high',
  style: 'normal',
  flow: 'plan',
  branch: 'feat/zmrng/add-a-widget-t1',
  worktree: '/tmp/wt',
  planPath: null,
  sessionId: null,
  prUrl: null,
  queued: false,
  usage: { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('systemPrompt', () => {
  const prompt = systemPrompt('feat/zmrng/x-1', '/repos/example', 'main', 'normal')

  it('states the branch-only rule against the default branch', () => {
    expect(prompt).toMatch(/NEVER switch to, commit on, merge into, or push to/)
    expect(prompt).toContain('`main`')
  })

  it('forbids force-push and history rewriting', () => {
    expect(prompt).toMatch(/NEVER force-push, rebase onto, or rewrite published history/)
  })

  it('forbids the worker from removing its own worktree or branch', () => {
    expect(prompt).toMatch(/git worktree remove\|prune/)
    expect(prompt).toMatch(/never delete your branch/)
  })

  it('names the five-step lifecycle', () => {
    expect(prompt).toContain('Plan → Implement (TDD) → Code Review → Validate → Sync Docs')
  })

  it('defines ZMRNG_BLOCKED as exactly three true-environment-gap reasons', () => {
    expect(prompt).toMatch(/toolchain\/binary/)
    expect(prompt).toMatch(/authentication is broken/)
    expect(prompt).toMatch(/target repository itself declares/i)
  })

  it('states the seeded zmrng-* QA agents are guaranteed present', () => {
    expect(prompt).toMatch(/zmrng-qa/)
    expect(prompt).toMatch(/zmrng-code-reviewer/)
    expect(prompt).toMatch(/zmrng-doc-updater/)
    expect(prompt).toMatch(/guaranteed present/i)
  })
})

describe('clarifyKickoff', () => {
  const prompt = clarifyKickoff(task)

  it('carries the task title and body as the interview subject', () => {
    expect(prompt).toContain(task.title)
    expect(prompt).toContain(task.body)
  })

  it('still names the clarify phase and forbids writing code/plan yet', () => {
    expect(prompt).toMatch(/CLARIFY PHASE/)
    expect(prompt).toMatch(/Do NOT write code or a plan yet/)
  })

  it('is skeptical by default — refuses ZMRNG_READY until scope is concrete', () => {
    // The worker must keep probing thin/vague answers, not self-certify a
    // premature READY on a layman's under-scoped reply (D3 skeptical-by-default).
    expect(prompt).toMatch(/skeptical/i)
    expect(prompt).toMatch(/vague|thin|underspecified|under-scoped/i)
    // The refusal must be explicit: do NOT emit READY while scope is unclear.
    expect(prompt).toMatch(/do NOT (emit|output).*ZMRNG_READY/i)
    expect(prompt).toMatch(/concrete/i)
  })

  it('restates its understanding and waits for explicit confirmation before READY', () => {
    // Before emitting READY the worker echoes back what it understood and waits
    // for the operator to confirm (D3 restate-and-confirm).
    expect(prompt).toMatch(/restate|echo|here is what I understand/i)
    expect(prompt).toMatch(/confirm/i)
    // The confirm must GATE the token emission, in this order within the
    // directive: restate → explicit-confirmation gate → emit ZMRNG_READY.
    // Anchor on the specific emission instruction and the confirmation gate
    // (not a bare ZMRNG_READY, which also appears in the skeptical refusal
    // line "Do NOT emit ZMRNG_READY while…"), so a reordering that emits the
    // token before requiring confirmation trips this test.
    const restateIdx = prompt.search(/restate|here is what I understand/i)
    const confirmGateIdx = prompt.search(/AFTER .*explicit confirmation/i)
    const emitIdx = prompt.indexOf('output the exact token ZMRNG_READY')
    expect(restateIdx).toBeGreaterThan(-1)
    expect(confirmGateIdx).toBeGreaterThan(-1)
    expect(emitIdx).toBeGreaterThan(-1)
    // restate BEFORE the confirmation gate BEFORE the token emission.
    expect(restateIdx).toBeLessThan(confirmGateIdx)
    expect(confirmGateIdx).toBeLessThan(emitIdx)
  })
})

describe('planKickoff', () => {
  const prompt = planKickoff(task, 'OPERATOR: do it')

  it('requires grilling the approach before the plan is written', () => {
    expect(prompt).toMatch(/GRILL THE APPROACH FIRST/)
    expect(prompt).toMatch(/alternative you rejected/)
  })

  it('requires the plan to name a test strategy', () => {
    expect(prompt).toContain('"Test strategy"')
    expect(prompt).toMatch(/never omit the section/)
  })

  it('does not instruct blocking on a bare qa/code-reviewer/doc-updater name', () => {
    expect(prompt).not.toMatch(/ZMRNG_BLOCKED: <agent name> not available/)
    expect(prompt).toMatch(/zmrng-code-reviewer/)
  })
})

describe('executeKickoff', () => {
  const prompt = executeKickoff('feat/zmrng/x-1', 'main', '.agents/plans/x.md')

  it('mandates RED → GREEN → REFACTOR before implementation', () => {
    expect(prompt).toMatch(/RED —/)
    expect(prompt).toMatch(/GREEN —/)
    expect(prompt).toMatch(/REFACTOR —/)
    // RED must be described before GREEN in the prompt, not as an afterthought.
    expect(prompt.indexOf('RED —')).toBeLessThan(prompt.indexOf('GREEN —'))
  })

  it('requires tests in the same commit as the source', () => {
    expect(prompt).toMatch(/SAME commit as the source/)
  })

  it('is tolerant of repos with no test runner but demands it be said in the PR body', () => {
    expect(prompt).toMatch(/TOLERANCE \(do not silently skip\)/)
    expect(prompt).toMatch(/no test runner/)
  })

  it('stages the plan file, so the checklist link is not dead', () => {
    expect(prompt).toMatch(/Stage the plan file itself \(`\.agents\/plans\/x\.md`\)/)
  })

  it('still names the plan generically when the planning phase reported no path', () => {
    expect(executeKickoff('feat/zmrng/x-1', 'main', null)).toMatch(
      /Stage the plan file itself \(`the plan you wrote under \.agents\/plans\/`\)/,
    )
  })

  it('opens the PR with --body-file, never --fill', () => {
    expect(prompt).toContain(`--body-file "${PR_BODY_FILE}"`)
    expect(prompt).not.toContain('gh pr create --fill')
  })

  it('embeds the full PR body template', () => {
    expect(prompt).toContain(PR_BODY_TEMPLATE)
  })

  it('does not instruct blocking on a bare qa/code-reviewer/doc-updater name', () => {
    expect(prompt).not.toMatch(/ZMRNG_BLOCKED: <agent name> not available/)
  })

  it('references the seeded zmrng-* QA agents as guaranteed present', () => {
    expect(prompt).toMatch(/zmrng-qa/)
    expect(prompt).toMatch(/zmrng-code-reviewer/)
    expect(prompt).toMatch(/zmrng-doc-updater/)
    expect(prompt).toMatch(/guaranteed present/i)
  })

  it('does not instruct any end-of-workflow screenshot capture or upload', () => {
    // The screenshot step was removed entirely — never re-add it silently.
    expect(prompt).not.toMatch(/screenshot/i)
    expect(prompt).not.toContain('.github/pr-screenshots/')
    expect(prompt).not.toMatch(/gh pr comment/)
    expect(prompt).not.toMatch(/gh release/)
    expect(prompt).not.toMatch(/Playwright/)
  })
})

describe('directKickoff', () => {
  const prompt = directKickoff('feat/zmrng/x-1', 'main', task, 'OPERATOR: fix the conflict')

  it('names itself the direct execute phase and carries the clarify transcript as the brief', () => {
    expect(prompt).toMatch(/DIRECT EXECUTE PHASE/)
    expect(prompt).toContain('OPERATOR: fix the conflict')
    expect(prompt).toMatch(/there is no plan file/)
  })

  it('forbids the zmrng-* subagent chain (inline validation instead)', () => {
    expect(prompt).toMatch(/Do NOT spawn the `zmrng-qa`, `zmrng-code-reviewer`, or `zmrng-doc-updater`/)
    expect(prompt).toMatch(/validation INLINE yourself/)
  })

  it('makes TDD and doc-sync conditional, not mandatory', () => {
    expect(prompt).toMatch(/TESTS \(conditional\)/)
    expect(prompt).toMatch(/DOCS \(conditional\)/)
    // The heavy execute phase's mandatory RED/GREEN wording must NOT be present.
    expect(prompt).not.toMatch(/RED —/)
  })

  it('keeps the hard gates: green validation and a PR via --body-file', () => {
    expect(prompt).toMatch(/green run is the hard gate/)
    expect(prompt).toContain(`--body-file "${PR_BODY_FILE}"`)
    expect(prompt).not.toContain('gh pr create --fill')
    expect(prompt).toContain(PR_BODY_TEMPLATE)
  })

  it('does not write or reference a plan file', () => {
    expect(prompt).not.toMatch(/\.agents\/plans\//)
  })
})

describe('resumeKickoff', () => {
  const branch = 'feat/zmrng/x-1'
  const transcript = 'OPERATOR: do the thing\n\nWORKER: on it'
  const withStatus = (status: TaskStatus): Task => ({ ...task, status })

  it('all phases: carry the RESUME preamble ordering inspect-before-continue + title/body', () => {
    for (const status of ['clarify', 'planning', 'executing', 'validating'] as TaskStatus[]) {
      const prompt = resumeKickoff(withStatus(status), branch, 'main', transcript)
      expect(prompt).toMatch(/RESUME/)
      expect(prompt).toMatch(/inspect/i)
      expect(prompt).toMatch(/do NOT redo/)
      expect(prompt).toContain(task.title)
      expect(prompt).toContain(task.body)
    }
  })

  it('clarify: delegates verbatim to clarifyKickoff (CLARIFY PHASE)', () => {
    const t = withStatus('clarify')
    const prompt = resumeKickoff(t, branch, 'main', transcript)
    expect(prompt).toMatch(/CLARIFY PHASE/)
    expect(prompt).toContain(clarifyKickoff(t))
  })

  it('planning: delegates verbatim to planKickoff, with the transcript exactly once', () => {
    const t = withStatus('planning')
    const prompt = resumeKickoff(t, branch, 'main', transcript)
    expect(prompt).toMatch(/PLAN PHASE/)
    expect(prompt).toMatch(/GRILL THE APPROACH FIRST/)
    expect(prompt).toContain(planKickoff(t, transcript))
    // The preamble must NOT double-inject what planKickoff already carries.
    const occurrences = prompt.split('OPERATOR: do the thing').length - 1
    expect(occurrences).toBe(1)
  })

  it('executing: delegates verbatim to executeKickoff (EXECUTE PHASE + RED) with the transcript', () => {
    const t = withStatus('executing')
    const prompt = resumeKickoff(t, branch, 'main', transcript)
    expect(prompt).toMatch(/EXECUTE PHASE/)
    expect(prompt).toMatch(/RED —/)
    expect(prompt).toContain('OPERATOR: do the thing')
    expect(prompt).toContain(executeKickoff(branch, 'main', t.planPath))
  })

  it('validating: reuses the same execute resume body', () => {
    const t = withStatus('validating')
    const prompt = resumeKickoff(t, branch, 'main', transcript)
    expect(prompt).toMatch(/EXECUTE PHASE/)
    expect(prompt).toContain(executeKickoff(branch, 'main', t.planPath))
  })
})

describe('PR_BODY_TEMPLATE', () => {
  it('carries all five lifecycle checklist items', () => {
    for (const item of ['**Plan**', '**Spec/Tickets**', '**TDD**', '**Review**', '**Validate**']) {
      expect(PR_BODY_TEMPLATE).toContain(item)
    }
  })

  it('keeps the coding-gate markers used by the repo PR template', () => {
    expect(PR_BODY_TEMPLATE).toContain('<!-- coding-gate:checklist:start -->')
    expect(PR_BODY_TEMPLATE).toContain('<!-- coding-gate:checklist:end -->')
  })

  it('stays in sync with .github/PULL_REQUEST_TEMPLATE.md checklist items', () => {
    const repoTemplate = readFileSync(
      path.join(repoRoot, '.github/PULL_REQUEST_TEMPLATE.md'),
      'utf8',
    )
    const bold = (s: string) => [...s.matchAll(/- \[ \] \*\*([^*]+)\*\*/g)].map((m) => m[1])
    expect(bold(PR_BODY_TEMPLATE)).toEqual(bold(repoTemplate))
  })

  it('writes the body inside the git dir so it is never committed', () => {
    expect(PR_BODY_FILE).toContain('git rev-parse --git-dir')
  })
})
