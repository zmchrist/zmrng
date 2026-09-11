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
  openPrKickoff,
  planKickoff,
  resumeKickoff,
  securityFixKickoff,
  styleDirective,
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

describe('styleDirective (D3 — inline caveman register, no skill round-trip)', () => {
  it('normal style yields no communication-style block', () => {
    expect(styleDirective('normal')).toBe('')
  })

  it('inlines the mapped register directly and does NOT tell the worker to invoke the caveman skill', () => {
    const directive = styleDirective('caveman-full')
    expect(directive).toMatch(/COMMUNICATION STYLE:/)
    // The inline register text is present verbatim (mapped CAVEMAN_RULES entry).
    expect(directive).toMatch(/Drop articles \(a\/an\/the\) and filler/)
    // The per-session skill-invoke directive is GONE — zero tool round-trips.
    expect(directive).not.toMatch(/invoke/i)
    expect(directive).not.toMatch(/caveman` skill/)
    expect(directive).not.toMatch(/Skill tool/)
    expect(directive).not.toMatch(/\/caveman/)
    expect(directive).not.toMatch(/VERY FIRST action/)
    expect(directive).not.toMatch(/Fallback if the caveman skill/)
    // The English carve-out for code/commits/PR/plan files stays.
    expect(directive).toMatch(/EXCEPTION: write code, commit messages/)
  })

  it('maps wenyan-full to its inline register like the others (no special skill path)', () => {
    const directive = styleDirective('wenyan-full')
    expect(directive).toMatch(/Classical Chinese/)
    expect(directive).not.toMatch(/invoke/i)
    expect(directive).not.toMatch(/Skill tool/)
  })

  it('systemPrompt embeds the inline register for a non-normal style and none for normal', () => {
    const caveman = systemPrompt('feat/zmrng/x-1', '/repos/example', 'main', 'caveman-ultra')
    expect(caveman).toMatch(/COMMUNICATION STYLE:/)
    expect(caveman).toMatch(/Abbreviate \(DB\/auth\/config\/fn\/impl\)/)
    expect(caveman).not.toMatch(/Skill tool/)
    const normal = systemPrompt('feat/zmrng/x-1', '/repos/example', 'main', 'normal')
    expect(normal).not.toMatch(/COMMUNICATION STYLE:/)
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

  // The push/PR ceremony moved OUT of the execute tail (D-gate): the worker now
  // commits, prints ZMRNG_SCAN_READY, and STOPS — the orchestrator runs the
  // security scan and only then sends openPrKickoff. A silent regression that
  // re-adds the push/PR here (or drops the commit-and-wait rule) would let a
  // worker open a PR that never passed the gate, degrading every future run.
  it('ends with commit → ZMRNG_SCAN_READY → STOP, and does NOT push or open the PR itself', () => {
    expect(prompt).toContain('ZMRNG_SCAN_READY')
    expect(prompt).toMatch(/commit/i)
    // must NOT actually push or open a PR from the execute tail anymore (the
    // do-NOT-push prohibition wording is allowed; the executable command is not)
    expect(prompt).not.toMatch(/git push -u origin/)
    expect(prompt).not.toMatch(/gh pr create --base/)
    expect(prompt).not.toContain(PR_BODY_TEMPLATE)
    // explicit wait-for-orchestrator + do-not-push/PR instruction
    expect(prompt).toMatch(/do NOT push/i)
    expect(prompt).toMatch(/do NOT open the PR/i)
    expect(prompt).toMatch(/wait for the orchestrator/i)
    // the commit instruction precedes the token, which precedes the STOP.
    expect(prompt.search(/commit/i)).toBeLessThan(prompt.indexOf('ZMRNG_SCAN_READY'))
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

  it('keeps the green-validation hard gate but hands the PR back via the scan token', () => {
    expect(prompt).toMatch(/green run is the hard gate/)
    // The PR ceremony moved to openPrKickoff; the direct tail now commits and
    // waits for the orchestrator's scan, same as the plan flow.
    expect(prompt).toContain('ZMRNG_SCAN_READY')
    expect(prompt).not.toMatch(/git push -u origin/)
    expect(prompt).not.toMatch(/gh pr create --base/)
    expect(prompt).not.toContain(PR_BODY_TEMPLATE)
    expect(prompt).toMatch(/do NOT push/i)
    expect(prompt).toMatch(/wait for the orchestrator/i)
  })

  it('does not write or reference a plan file', () => {
    expect(prompt).not.toMatch(/\.agents\/plans\//)
  })
})

describe('openPrKickoff', () => {
  const prompt = openPrKickoff('feat/zmrng/x-1', 'main', '.agents/plans/x.md')

  it('is the extracted push → PR-body → gh pr create → print-URL ceremony', () => {
    expect(prompt).toMatch(/git push -u origin feat\/zmrng\/x-1/)
    expect(prompt).toContain(`--body-file "${PR_BODY_FILE}"`)
    expect(prompt).not.toContain('gh pr create --fill')
    expect(prompt).toMatch(/gh pr create --base main --head feat\/zmrng\/x-1/)
    expect(prompt).toMatch(/output the PR URL/i)
  })

  it('reuses PR_BODY_TEMPLATE verbatim (pins it)', () => {
    expect(prompt).toContain(PR_BODY_TEMPLATE)
  })

  it('states the security scan passed (why the worker is now allowed to open the PR)', () => {
    expect(prompt).toMatch(/security scan (is )?green|passed the security scan|scan.*passed/i)
  })

  it('stages the named plan file, and falls back to a generic mention when null', () => {
    expect(prompt).toMatch(/`\.agents\/plans\/x\.md`/)
    const noPlan = openPrKickoff('feat/zmrng/x-1', 'main')
    expect(noPlan).toMatch(/git push -u origin/)
    expect(noPlan).toContain(PR_BODY_TEMPLATE)
  })
})

describe('securityFixKickoff', () => {
  const findings = '2 blocking security finding(s):\n- [osv] GHSA-x in lodash — proto pollution (fix available)'
  const prompt = securityFixKickoff(findings, 1, 2)

  it('embeds the deterministic findings report verbatim', () => {
    expect(prompt).toContain(findings)
  })

  it('orders the worker to FIX every blocking finding, not merely note it in the PR body', () => {
    expect(prompt).toMatch(/fix (every|all)/i)
    expect(prompt).toMatch(/pin or replace|replace the vulnerable|update the vulnerable/i)
    expect(prompt).toMatch(/do NOT (merely |just )?note it in the PR body/i)
  })

  it('asks for a regression test where meaningful and a re-commit in place', () => {
    expect(prompt).toMatch(/regression test/i)
    expect(prompt).toMatch(/re-commit|commit in place|commit again/i)
  })

  it('re-emits ZMRNG_SCAN_READY and states the round budget (machine re-assertion)', () => {
    expect(prompt).toContain('ZMRNG_SCAN_READY')
    expect(prompt).toMatch(/round 1 of 2|round 1\/2/i)
  })

  it('the plan-flow framing covers BOTH SAST (code) and SCA (dependency) fixes', () => {
    // default scaOnly=false → full framing, mentions code-level vulns too
    expect(prompt).toMatch(/code|SAST|semgrep/i)
  })

  it('the direct-flow framing is SCA-only (D2): dependency vulns, no SAST fix wording', () => {
    const scaOnly = securityFixKickoff(findings, 1, 2, true)
    expect(scaOnly).toMatch(/dependency|dependencies|SCA|osv/i)
    expect(scaOnly).toMatch(/SCA-only|dependency-only|only the dependency/i)
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
