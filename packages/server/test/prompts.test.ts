import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  PR_BODY_FILE,
  PR_BODY_TEMPLATE,
  executeKickoff,
  planKickoff,
  systemPrompt,
} from '../src/phases.js'
import type { Task } from '../src/types.js'

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

  it('opens the PR with --body-file, never --fill', () => {
    expect(prompt).toContain(`--body-file "${PR_BODY_FILE}"`)
    expect(prompt).not.toContain('gh pr create --fill')
  })

  it('embeds the full PR body template', () => {
    expect(prompt).toContain(PR_BODY_TEMPLATE)
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
