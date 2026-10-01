import { describe, it, expect } from 'vitest'
import {
  GAUNTLET_GAP_RE,
  GAUNTLET_QUESTION_RE,
  GAUNTLET_STATUS_RE,
  GAUNTLET_VERDICT_RE,
  STEP_PROFILES,
  builderPrompt,
  criticPrompt,
  finalPrKickoff,
  finishPrompt,
  foldPrompt,
  loopOrchestratorPrompt,
  orchestratorKickoff,
  orchestratorRecap,
  parseStepResult,
  validatePrompt,
  type FinalPrCtx,
  type LoopStepCtx,
  type LoopTicketCtx,
  type OrchestratorCtx,
  type StepPrompt,
} from '../src/loopPrompts.js'
import { PR_BODY_FILE, PR_BODY_TEMPLATE, styleDirective } from '../src/phases.js'
import { LOOP_MAX_LANES, type CaveStyle, type LoopRun, type LoopTicket } from '../src/types.js'

// The gauntlet prompts ARE the loop's harness, the same way prompts.test.ts pins
// phases.ts: the builder/critic split, the blind A/B, read-only critics, branch-only
// and worktree-hygiene rules, serial folding, and the --body-file final PR exist
// only as text in these strings. A silent edit that drops a rule degrades every
// future run with no other signal, so each rule is pinned here.

const ticketCtx: LoopTicketCtx = {
  number: 42,
  title: 'Command palette',
  body: 'Add a command palette to the editor so every action is reachable from the keyboard.',
  url: 'https://github.com/acme/app/issues/42',
  bar: 'Linear command palette (cmd+K): fuzzy search, recent actions, keyboard-only.',
  round: 1,
  lastGap: null,
}

function stepCtx(over: Partial<LoopStepCtx> = {}, ticket: Partial<LoopTicketCtx> = {}): LoopStepCtx {
  return {
    repoSlug: 'acme/app',
    defaultBranch: 'develop',
    integBranch: 'gauntlet/ab12cd34/integ',
    ticketBranch: 'gauntlet/ab12cd34/t42',
    ticket: { ...ticketCtx, ...ticket },
    style: 'normal',
    ...over,
  }
}

const finalCtx: FinalPrCtx = {
  repoSlug: 'acme/app',
  defaultBranch: 'develop',
  integBranch: 'gauntlet/ab12cd34/integ',
  epic: 7,
  epicTitle: 'Keyboard-first editor',
  done: [
    { number: 3, title: 'Shortcut registry' },
    { number: 5, title: 'Command palette' },
  ],
  style: 'normal',
}

const orchCtx: OrchestratorCtx = {
  runId: 'run-0001',
  repoId: 'acme-app',
  repoSlug: 'acme/app',
  defaultBranch: 'develop',
  epic: 7,
  epicTitle: 'Keyboard-first editor',
  integBranch: 'gauntlet/ab12cd34/integ',
  apiBase: 'http://127.0.0.1:4500',
  style: 'normal',
}

const full = (p: StepPrompt): string => `${p.system}\n${p.kickoff}`

/** Every fresh-agent step, built for one style, with the branch it runs on. */
function allSteps(style: CaveStyle): { name: string; prompt: StepPrompt; branch: string }[] {
  const ctx = stepCtx({ style })
  return [
    { name: 'builder', prompt: builderPrompt(ctx), branch: ctx.ticketBranch },
    { name: 'critic', prompt: criticPrompt(ctx, 'A', 'abc1234'), branch: ctx.ticketBranch },
    { name: 'validate', prompt: validatePrompt(ctx), branch: ctx.ticketBranch },
    { name: 'finish', prompt: finishPrompt(ctx), branch: ctx.ticketBranch },
    { name: 'fold', prompt: foldPrompt(ctx, '/repos/app/worktrees/loop-ab12cd34-integ'), branch: ctx.integBranch },
    { name: 'final', prompt: finalPrKickoff({ ...finalCtx, style }), branch: ctx.integBranch },
  ]
}

// ---------------------------------------------------------------------------
// control tokens
// ---------------------------------------------------------------------------

describe('GAUNTLET_* token regexes (line-anchored)', () => {
  it('GAUNTLET_STATUS matches BUILT/GREEN/RED on their own line, with an optional reason', () => {
    expect(GAUNTLET_STATUS_RE.exec('GAUNTLET_STATUS=BUILT')?.[1]).toBe('BUILT')
    expect(GAUNTLET_STATUS_RE.exec('  GAUNTLET_STATUS=GREEN  ')?.[1]).toBe('GREEN')
    const red = GAUNTLET_STATUS_RE.exec('done\nGAUNTLET_STATUS=RED lint fails in a.ts\n')
    expect(red?.[1]).toBe('RED')
    expect(red?.[2]).toBe('lint fails in a.ts')
  })

  it('GAUNTLET_STATUS does not match a longer word, a lower-case status, or mid-sentence', () => {
    expect(GAUNTLET_STATUS_RE.test('GAUNTLET_STATUS=GREENISH')).toBe(false)
    expect(GAUNTLET_STATUS_RE.test('GAUNTLET_STATUS=green')).toBe(false)
    expect(GAUNTLET_STATUS_RE.test('I will print GAUNTLET_STATUS=BUILT when done.')).toBe(false)
  })

  it('GAUNTLET_VERDICT captures exactly one token and never reads the next line', () => {
    expect(GAUNTLET_VERDICT_RE.exec('GAUNTLET_VERDICT: B')?.[1]).toBe('B')
    expect(GAUNTLET_VERDICT_RE.exec('GAUNTLET_VERDICT:a')?.[1]).toBe('a')
    expect(GAUNTLET_VERDICT_RE.test('GAUNTLET_VERDICT: A or B')).toBe(false)
    expect(GAUNTLET_VERDICT_RE.test('GAUNTLET_VERDICT:\nA')).toBe(false)
    expect(GAUNTLET_VERDICT_RE.test('so GAUNTLET_VERDICT: A')).toBe(false)
  })

  it('GAUNTLET_GAP and GAUNTLET_QUESTION capture the rest of their own line only', () => {
    expect(GAUNTLET_GAP_RE.exec('GAUNTLET_GAP: no fuzzy matching  ')?.[1]).toBe('no fuzzy matching')
    expect(GAUNTLET_GAP_RE.test('GAUNTLET_GAP:\nnext line')).toBe(false)
    expect(GAUNTLET_QUESTION_RE.exec('GAUNTLET_QUESTION: which key opens it?')?.[1]).toBe(
      'which key opens it?',
    )
    expect(GAUNTLET_QUESTION_RE.test('then GAUNTLET_QUESTION: x')).toBe(false)
  })
})

describe('parseStepResult', () => {
  it('reads each status, the RED reason, and trailing text after any status', () => {
    expect(parseStepResult('work done\nGAUNTLET_STATUS=BUILT')).toEqual({ status: 'BUILT' })
    expect(parseStepResult('GAUNTLET_STATUS=GREEN')).toEqual({ status: 'GREEN' })
    expect(parseStepResult('GAUNTLET_STATUS=RED tests fail in foo.test.ts')).toEqual({
      status: 'RED',
      reason: 'tests fail in foo.test.ts',
    })
    expect(parseStepResult('GAUNTLET_STATUS=GREEN all checks pass').reason).toBe('all checks pass')
  })

  it('reads the critic verdict (upper-cased) and gap', () => {
    const r = parseStepResult('Both inspected.\nGAUNTLET_VERDICT: b\nGAUNTLET_GAP: no keyboard navigation')
    expect(r).toEqual({ verdict: 'B', gap: 'no keyboard navigation' })
  })

  it('reads a question and a PR url', () => {
    expect(parseStepResult('GAUNTLET_QUESTION: should Esc close it?').question).toBe('should Esc close it?')
    expect(parseStepResult('Opened:\nhttps://github.com/acme/app/pull/88').prUrl).toBe(
      'https://github.com/acme/app/pull/88',
    )
  })

  it('returns {} for text with no tokens', () => {
    expect(parseStepResult('')).toEqual({})
    expect(parseStepResult('Still working on it.')).toEqual({})
  })

  it('ignores a token quoted mid-sentence', () => {
    expect(parseStepResult('When finished I will print GAUNTLET_STATUS=BUILT on its own line.')).toEqual({})
    expect(parseStepResult('The answer format is GAUNTLET_VERDICT: A then a gap.')).toEqual({})
  })

  it('ignores GAUNTLET_STATUS=GREENISH and an inline-code token', () => {
    expect(parseStepResult('GAUNTLET_STATUS=GREENISH')).toEqual({})
    expect(parseStepResult('`GAUNTLET_STATUS=GREEN`')).toEqual({})
  })

  it('ignores tokens inside ``` and ~~~ fences, including an unclosed one', () => {
    expect(parseStepResult('Example:\n```\nGAUNTLET_STATUS=GREEN\n```')).toEqual({})
    expect(parseStepResult('```text\nGAUNTLET_STATUS=RED x\n```')).toEqual({})
    expect(parseStepResult('~~~\nGAUNTLET_VERDICT: A\nGAUNTLET_GAP: g\n~~~')).toEqual({})
    expect(parseStepResult('```\nGAUNTLET_STATUS=BUILT')).toEqual({})
    expect(parseStepResult('```\nhttps://github.com/acme/app/pull/1\n```')).toEqual({})
  })

  it('honours a real token outside a fence even when a fenced one disagrees', () => {
    expect(parseStepResult('```\nGAUNTLET_VERDICT: A\n```\nGAUNTLET_VERDICT: B').verdict).toBe('B')
  })

  it('takes the LAST occurrence of each token (the agent\'s final word)', () => {
    const r = parseStepResult(
      'GAUNTLET_STATUS=RED flaky\nretrying\nGAUNTLET_STATUS=GREEN\nGAUNTLET_GAP: first\nGAUNTLET_GAP: second',
    )
    expect(r.status).toBe('GREEN')
    expect(r.reason).toBeUndefined()
    expect(r.gap).toBe('second')
    expect(parseStepResult('GAUNTLET_VERDICT: A\nGAUNTLET_VERDICT: B').verdict).toBe('B')
    expect(
      parseStepResult('https://github.com/acme/app/pull/1\nhttps://github.com/acme/app/pull/2').prUrl,
    ).toBe('https://github.com/acme/app/pull/2')
  })

  it('tolerates CRLF line endings', () => {
    expect(parseStepResult('GAUNTLET_STATUS=RED broken build\r\n')).toEqual({
      status: 'RED',
      reason: 'broken build',
    })
  })
})

// ---------------------------------------------------------------------------
// shared step rules
// ---------------------------------------------------------------------------

describe('every step system prompt carries the shared rules', () => {
  for (const { name, prompt, branch } of allSteps('normal')) {
    describe(name, () => {
      it('names the branch it runs on', () => {
        expect(prompt.system).toContain(`\`${branch}\``)
      })

      it('is branch-only: never commit on, merge into, or push to the default branch / main / master', () => {
        expect(prompt.system).toMatch(/NEVER commit on, merge into, or push to/)
        expect(prompt.system).toContain('`develop`')
        expect(prompt.system).toContain('`main`')
        expect(prompt.system).toContain('`master`')
      })

      it('forbids force-push, rebasing/rewriting history, and switching branches', () => {
        expect(prompt.system).toMatch(/NEVER force-push/)
        expect(prompt.system).toMatch(/rebase/)
        expect(prompt.system).toMatch(/rewrite published history/)
        expect(prompt.system).toMatch(/NEVER `git checkout`\/`git switch`/)
      })

      it('carries worktree hygiene: no worktree remove/prune, no deleting dirs or branches, clean tree, no stash', () => {
        expect(prompt.system).toMatch(/git worktree remove\|prune/)
        expect(prompt.system).toMatch(/never delete the worktree directory/)
        expect(prompt.system).toMatch(/never delete a branch/)
        expect(prompt.system).toMatch(/Leave the tree clean/)
        expect(prompt.system).toMatch(/no `git stash`/)
      })

      it('carries the GAUNTLET_QUESTION protocol', () => {
        expect(prompt.system).toContain('GAUNTLET_QUESTION: <question>')
        expect(prompt.system).toMatch(/truly blocked on a decision only a human or the orchestrator can make/)
        expect(prompt.system).toMatch(/answer arrives as your next message/)
      })

      it('says the GAUNTLET line goes on its own line, never inside a code block or sentence', () => {
        expect(prompt.system).toMatch(/on its own line, never inside a code block or sentence/)
      })

      it('has no narration-style block for the normal style', () => {
        expect(prompt.system).not.toMatch(/COMMUNICATION STYLE:/)
      })
    })
  }

  it('every step embeds styleDirective(style) verbatim for a caveman style', () => {
    for (const { name, prompt } of allSteps('caveman-full')) {
      expect(prompt.system, name).toContain(styleDirective('caveman-full'))
    }
  })

  it('no step but the final PR pushes; the final PR pushes only the integration branch', () => {
    for (const { name, prompt } of allSteps('normal')) {
      if (name === 'final') continue
      expect(full(prompt), name).toMatch(/Do NOT push/)
      expect(full(prompt), name).not.toMatch(/git push -u origin/)
    }
  })
})

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

describe('builderPrompt', () => {
  const round1 = builderPrompt(stepCtx())

  it('carries the ticket goal (title, body, url) and the bar', () => {
    expect(round1.kickoff).toContain('#42')
    expect(round1.kickoff).toContain(ticketCtx.title)
    expect(round1.kickoff).toContain(ticketCtx.body)
    expect(round1.kickoff).toContain(ticketCtx.url)
    expect(round1.kickoff).toContain(ticketCtx.bar)
  })

  it('says to implement on the ticket branch and commit all work', () => {
    expect(round1.kickoff).toContain('`gauntlet/ab12cd34/t42`')
    expect(round1.kickoff).toMatch(/Commit ALL of your work/)
  })

  it('never judges its own work or compares it to the bar — a separate critic does that', () => {
    expect(round1.system).toMatch(/NEVER judge your own work/)
    expect(round1.system).toMatch(/NEVER compare it to the bar/)
    expect(round1.system).toMatch(/separate, fresh critic/)
  })

  it('ends with GAUNTLET_STATUS=BUILT', () => {
    expect(round1.kickoff.trimEnd().endsWith('GAUNTLET_STATUS=BUILT')).toBe(true)
  })

  it('round 1 carries no gap', () => {
    expect(round1.kickoff).not.toMatch(/single biggest gap from last round/i)
  })

  it('a later round carries the last gap verbatim and the round number', () => {
    const gap = 'No fuzzy matching: typing "opn fil" finds nothing.'
    const r3 = builderPrompt(stepCtx({}, { round: 3, lastGap: gap }))
    expect(r3.kickoff).toMatch(/the critic's single biggest gap from last round/i)
    expect(r3.kickoff).toContain(gap)
    expect(r3.kickoff).toMatch(/round 3 of 6/)
  })
})

// ---------------------------------------------------------------------------
// critic
// ---------------------------------------------------------------------------

describe('criticPrompt', () => {
  const asA = criticPrompt(stepCtx(), 'A', 'abc1234')
  const asB = criticPrompt(stepCtx(), 'B', 'abc1234')

  it('is a harsh critic and READ-ONLY (no edits, no commits, no HEAD/tree-changing git)', () => {
    expect(asA.system).toMatch(/harsh critic/)
    expect(asA.system).toMatch(/READ-ONLY/)
    expect(asA.system).toMatch(/NEVER edit, create, or delete files/)
    expect(asA.system).toMatch(/NEVER commit/)
    expect(asA.system).toMatch(/NEVER run a git command that changes HEAD, the index, or the working tree/)
  })

  it('makes the critic fetch and inspect the bar itself', () => {
    expect(asA.kickoff).toContain(ticketCtx.bar)
    expect(asA.kickoff).toMatch(/fetch and inspect it yourself/i)
  })

  it('maps our label to the checkout diff and the other label to the bar', () => {
    expect(asA.kickoff).toMatch(/Candidate A — the change in this checkout: inspect it with `git diff abc1234\.\.HEAD`/)
    expect(asA.kickoff).toMatch(/Candidate B — the bar reference/)
    expect(asB.kickoff).toMatch(/Candidate B — the change in this checkout: inspect it with `git diff abc1234\.\.HEAD`/)
    expect(asB.kickoff).toMatch(/Candidate A — the bar reference/)
  })

  it('lists A before B regardless of which label is ours (order never leaks)', () => {
    for (const p of [asA, asB]) {
      expect(p.kickoff.indexOf('Candidate A')).toBeLessThan(p.kickoff.indexOf('Candidate B'))
    }
  })

  it('strips provenance: never calls either candidate ours, the builder\'s, new, or old', () => {
    for (const p of [asA, asB, criticPrompt(stepCtx({ style: 'caveman-full' }), 'A', 'abc1234')]) {
      expect(full(p)).not.toMatch(/\b(ours|our|yours|builder|builders|builder's|new|newer|old|older|original)\b/i)
    }
  })

  it('asks for a binary letter, never a score out of 10', () => {
    expect(full(asA)).toMatch(/single LETTER/)
    expect(full(asA)).toMatch(/NEVER a score/)
    expect(full(asA)).toMatch(/out of 10/)
  })

  it('ends with GAUNTLET_VERDICT then GAUNTLET_GAP naming the single biggest gap', () => {
    expect(asA.kickoff).toContain('GAUNTLET_VERDICT: <A|B>')
    expect(asA.kickoff).toContain('GAUNTLET_GAP: <the single biggest gap of the losing candidate vs the winner>')
    expect(asA.kickoff.indexOf('GAUNTLET_VERDICT: <A|B>')).toBeLessThan(asA.kickoff.indexOf('GAUNTLET_GAP:'))
    expect(asA.kickoff).toMatch(/Always name one/)
  })
})

// ---------------------------------------------------------------------------
// validate / finish / fold
// ---------------------------------------------------------------------------

describe('validatePrompt', () => {
  const p = validatePrompt(stepCtx())

  it("discovers and runs the repo's own gate (typecheck/lint/test/build)", () => {
    expect(p.kickoff).toMatch(/CLAUDE\.md/)
    expect(p.kickoff).toMatch(/package\.json scripts/)
    expect(p.kickoff).toMatch(/Makefile/)
    for (const check of ['typecheck', 'lint', 'test', 'build']) expect(p.kickoff).toContain(check)
  })

  it('fixes failures without weakening tests, and commits', () => {
    expect(p.kickoff).toMatch(/Fix each failure/)
    expect(p.kickoff).toMatch(/Never delete, skip, or weaken a test/)
    expect(p.kickoff).toMatch(/Commit your fixes/)
  })

  it('ends with GREEN or RED <reason>', () => {
    expect(p.kickoff).toContain('GAUNTLET_STATUS=GREEN')
    expect(p.kickoff).toContain('GAUNTLET_STATUS=RED <reason>')
  })
})

describe('finishPrompt', () => {
  const p = finishPrompt(stepCtx())

  it("syncs the repo's docs, preferring its sync-docs skill", () => {
    expect(p.kickoff).toMatch(/`sync-docs` skill/)
    expect(p.kickoff).toMatch(/zmrng-sync-docs/)
    expect(p.kickoff).toContain('git diff gauntlet/ab12cd34/integ...HEAD')
  })

  it('commits and ends GREEN', () => {
    expect(p.kickoff).toMatch(/Commit the doc updates/)
    expect(p.kickoff.trimEnd().endsWith('GAUNTLET_STATUS=GREEN')).toBe(true)
  })
})

describe('foldPrompt', () => {
  const wt = '/repos/app/worktrees/loop-ab12cd34-integ'
  const p = foldPrompt(stepCtx(), wt)

  it('runs in the integration worktree on the integration branch', () => {
    expect(p.kickoff).toContain(wt)
    expect(p.system).toContain('`gauntlet/ab12cd34/integ`')
  })

  it('serially merges the ticket branch with --no-ff', () => {
    expect(p.system).toMatch(/serial/i)
    expect(p.kickoff).toContain('git merge --no-ff gauntlet/ab12cd34/t42')
  })

  it("keeps integ GREEN by running the repo's gate and commits", () => {
    expect(p.kickoff).toMatch(/Keep the integration branch GREEN/)
    expect(p.kickoff).toMatch(/validation gate/)
    expect(p.kickoff).toMatch(/Commit everything/)
  })

  it('never touches main/the default branch and does not push (the server pushes integ)', () => {
    expect(p.kickoff).toMatch(/Never touch `develop`\/`main`/)
    expect(p.kickoff).toMatch(/Do NOT push — the zmrng server verifies the merge and pushes/)
  })

  it('ends with GREEN or RED <reason>', () => {
    expect(p.kickoff).toContain('GAUNTLET_STATUS=GREEN')
    expect(p.kickoff).toContain('GAUNTLET_STATUS=RED <reason>')
  })
})

// ---------------------------------------------------------------------------
// final PR
// ---------------------------------------------------------------------------

describe('finalPrKickoff', () => {
  const p = finalPrKickoff(finalCtx)

  it('pushes the integration branch without force', () => {
    expect(p.kickoff).toContain('git push -u origin gauntlet/ab12cd34/integ')
    expect(p.kickoff).toMatch(/never force/i)
    expect(full(p)).not.toMatch(/git push[^\n]*--force/)
  })

  it('opens the PR into the default branch with --body-file, never --fill', () => {
    expect(p.kickoff).toMatch(/gh pr create --base develop --head gauntlet\/ab12cd34\/integ/)
    expect(p.kickoff).toContain(`--body-file "${PR_BODY_FILE}"`)
    expect(p.kickoff).not.toContain('gh pr create --fill')
    expect(p.kickoff).toMatch(/NEVER `--fill`/)
  })

  it('reuses PR_BODY_TEMPLATE verbatim', () => {
    expect(p.kickoff).toContain(PR_BODY_TEMPLATE)
  })

  it('adds exactly one Closes #n line per done ticket', () => {
    const closes = p.kickoff.match(/^Closes #\d+$/gm) ?? []
    expect(closes).toEqual(['Closes #3', 'Closes #5'])
    const none = finalPrKickoff({ ...finalCtx, done: [] })
    expect(none.kickoff.match(/^Closes #\d+$/gm)).toBeNull()
  })

  it('never merges and prints the PR URL', () => {
    expect(p.kickoff).toMatch(/NEVER merge the PR/)
    expect(p.kickoff).toMatch(/print the PR URL on its own line/i)
  })
})

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------

describe('loopOrchestratorPrompt', () => {
  const p = loopOrchestratorPrompt(orchCtx)
  const api = `${orchCtx.apiBase}/api/loop`
  const run = `${api}/runs/${orchCtx.runId}`
  const lineWith = (needle: string): string => p.split('\n').find((l) => l.includes(needle)) ?? ''

  it('states its role: guide the run, never edit code, commit, merge, or push main', () => {
    expect(p).toMatch(/ORCHESTRATOR/)
    expect(p).toMatch(/You guide the run/)
    expect(p).toMatch(/NEVER edit code/)
    expect(p).toMatch(/NEVER commit/)
    expect(p).toMatch(/NEVER merge/)
    expect(p).toMatch(/never push `main`/)
  })

  it('carries the run facts', () => {
    for (const fact of [orchCtx.runId, orchCtx.repoId, orchCtx.repoSlug, '#7', orchCtx.epicTitle, orchCtx.integBranch, orchCtx.apiBase]) {
      expect(p).toContain(fact)
    }
  })

  it('lists EVERY loop route in the curl cheat sheet with the API base and run id substituted', () => {
    const routes = [
      `curl -sS ${api}/load`,
      `curl -sS ${api}/runs`,
      `curl -sS ${run}`,
      `curl -sS '${run}/events?limit=50'`,
      `curl -sS -X POST ${run}/start`,
      `curl -sS -X POST ${run}/pause`,
      `-d '{"count":N}' ${run}/lanes`,
      `-d '{"order":[`,
      `${run}/priority`,
      `curl -sS -X POST ${run}/refresh`,
      `-d '{"number":N}' ${run}/tickets`,
      `curl -sS -X DELETE ${run}/tickets/<n>`,
      `curl -sS -X POST ${run}/tickets/<n>/stop`,
      `curl -sS -X POST ${run}/tickets/<n>/retry`,
      `-d '{"text":"…"}' ${run}/tickets/<n>/answer`,
      `curl -sS -X POST ${run}/resume`,
      `curl -sS -X POST ${run}/archive`,
    ]
    for (const r of routes) expect(p, r).toContain(r)
  })

  it('sends bodyless POSTs with no content-type and no -d; JSON-body routes send both', () => {
    const bodyless = ['start', 'pause', 'refresh', 'resume', 'archive', 'tickets/<n>/stop', 'tickets/<n>/retry']
    for (const route of bodyless) {
      const line = lineWith(`curl -sS -X POST ${run}/${route}`)
      expect(line, route).not.toBe('')
      expect(line, route).not.toMatch(/content-type/)
      expect(line, route).not.toMatch(/ -d /)
    }
    for (const withBody of [`${run}/lanes`, `${run}/priority`, `${run}/tickets/<n>/answer`]) {
      const line = lineWith(withBody)
      expect(line, withBody).toContain(`curl -sS -X POST -H 'content-type: application/json' -d '`)
    }
    expect(p).toMatch(/Bodyless POST routes take NO body: send them without a content-type header and without -d/)
  })

  it('lists the gh commands for editing issues and links, then a refresh', () => {
    expect(p).toContain('gh issue edit <n> --repo acme/app --title')
    expect(p).toContain('--body-file')
    expect(p).toContain('gh issue create --repo acme/app')
    expect(p).toContain('repos/acme/app/issues/7/sub_issues')
    expect(p).toContain('repos/acme/app/issues/<n>/dependencies/blocked_by')
    expect(p).toMatch(/## Bar/)
    expect(p).toMatch(/after ANY change, re-sync the map with POST …\/refresh/)
  })

  it('states the lane rules: shared pool of LOOP_MAX_LANES, read /load first, deferred picks, nothing killed', () => {
    expect(p).toContain(`LOOP_MAX_LANES=${LOOP_MAX_LANES}`)
    expect(p).toMatch(/shared by EVERY Loop run/)
    expect(p).toMatch(/GET \/load before raising the lane count/)
    expect(p).toMatch(/defers every NEW pick/)
    expect(p).toMatch(/In-flight work is never killed/)
  })

  it('says a ticket with no bar is never picked and how to fix it', () => {
    expect(p).toMatch(/A ticket with no bar is never picked/)
    expect(p).toMatch(/\/refresh and POST …\/tickets\/<n>\/retry/)
  })

  it('explains [loop event] messages and answering lane questions', () => {
    expect(p).toContain('[loop event]')
    expect(p).toMatch(/…\/tickets\/<n>\/answer/)
  })

  it('narration follows styleDirective(style)', () => {
    expect(p).not.toMatch(/COMMUNICATION STYLE:/)
    expect(loopOrchestratorPrompt({ ...orchCtx, style: 'caveman-ultra' })).toContain(styleDirective('caveman-ultra'))
  })
})

describe('orchestratorKickoff', () => {
  it('fresh run: read the map and /load, set lanes, explain, do not start unless asked', () => {
    const k = orchestratorKickoff(orchCtx)
    expect(k).toContain(`curl -sS ${orchCtx.apiBase}/api/loop/runs/${orchCtx.runId}`)
    expect(k).toContain(`curl -sS ${orchCtx.apiBase}/api/loop/load`)
    expect(k).toContain(`/api/loop/runs/${orchCtx.runId}/lanes`)
    expect(k).toMatch(/Explain your choice to the operator/)
    expect(k).toMatch(/Do NOT start the run yourself/)
    expect(k).toMatch(/unless the operator asks/)
    expect(k).not.toMatch(/You are resuming/)
  })

  it('with a recap: "You are resuming" plus the recap verbatim', () => {
    const recap = 'RUN RECAP\n- status: running\n| #1 | a | done | 2 |'
    const k = orchestratorKickoff(orchCtx, recap)
    expect(k).toMatch(/You are resuming/)
    expect(k).toContain(recap)
  })
})

// ---------------------------------------------------------------------------
// recap
// ---------------------------------------------------------------------------

describe('orchestratorRecap', () => {
  const usage = { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 }
  const run: LoopRun = {
    id: 'run-0001',
    repoId: 'acme-app',
    epic: 7,
    title: 'Keyboard-first editor',
    status: 'running',
    prevStatus: null,
    lanes: 2,
    integBranch: 'gauntlet/ab12cd34/integ',
    integWorktree: '/repos/app/worktrees/loop-ab12cd34-integ',
    priority: [5],
    prUrl: null,
    note: null,
    usage,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const t = (number: number, title: string, state: LoopTicket['state'], round: number): LoopTicket => ({
    runId: run.id,
    number,
    title,
    body: '',
    url: `https://github.com/acme/app/issues/${number}`,
    ghState: 'open',
    blockedBy: [],
    bar: 'x',
    state,
    step: null,
    round,
    lastGap: null,
    branch: null,
    worktree: null,
    foldSha: null,
    question: null,
    note: null,
    usage,
    startedAt: null,
    stepStartedAt: null,
    updatedAt: run.updatedAt,
  })
  const tickets = [t(5, 'Command palette', 'reviewing', 2), t(3, 'Shortcut | registry', 'done', 1), t(9, 'Docs', 'todo', 0)]
  const chat = Array.from({ length: 25 }, (_, i) => `chat-line-${String(i + 1).padStart(2, '0')}`)

  it('carries the run facts', () => {
    const r = orchestratorRecap({ run, tickets, chat })
    for (const fact of ['run-0001', 'acme-app', '#7', 'Keyboard-first editor', 'running', 'gauntlet/ab12cd34/integ']) {
      expect(r).toContain(fact)
    }
    expect(r).toMatch(/lanes: 2/)
  })

  it('includes the API base when given', () => {
    expect(orchestratorRecap({ run, tickets, chat, apiBase: 'http://127.0.0.1:4500' })).toContain(
      'API base: http://127.0.0.1:4500',
    )
    expect(orchestratorRecap({ run, tickets, chat })).not.toMatch(/API base:/)
  })

  it('has a per-ticket row with number, title, state, and round, ascending', () => {
    const r = orchestratorRecap({ run, tickets, chat })
    expect(r).toMatch(/\| #5 \| Command palette \| reviewing \| 2 \|/)
    expect(r).toMatch(/\| #3 \| Shortcut \\\| registry \| done \| 1 \|/)
    expect(r).toMatch(/\| #9 \| Docs \| todo \| 0 \|/)
    expect(r.indexOf('| #3 ')).toBeLessThan(r.indexOf('| #5 '))
    expect(r.indexOf('| #5 ')).toBeLessThan(r.indexOf('| #9 '))
  })

  it('keeps at most the last 20 chat lines', () => {
    const r = orchestratorRecap({ run, tickets, chat })
    for (let i = 1; i <= 5; i++) expect(r).not.toContain(`chat-line-${String(i).padStart(2, '0')}`)
    for (let i = 6; i <= 25; i++) expect(r).toContain(`chat-line-${String(i).padStart(2, '0')}`)
  })

  it('handles an empty chat', () => {
    expect(orchestratorRecap({ run, tickets, chat: [] })).toMatch(/no chat yet/)
  })
})

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

describe('STEP_PROFILES', () => {
  it('builder/critic/fold/orchestrator run opus/high; validate/finish/final run sonnet/medium', () => {
    expect(STEP_PROFILES).toEqual({
      builder: { model: 'opus', effort: 'high' },
      critic: { model: 'opus', effort: 'high' },
      fold: { model: 'opus', effort: 'high' },
      orchestrator: { model: 'opus', effort: 'high' },
      validate: { model: 'sonnet', effort: 'medium' },
      finish: { model: 'sonnet', effort: 'medium' },
      final: { model: 'sonnet', effort: 'medium' },
    })
  })
})
