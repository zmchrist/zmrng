import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { TaskManager } from '../src/phases.js'
import { Db } from '../src/db.js'
import { config } from '../src/config.js'
import type { RunnerCallbacks, RunnerFactory, RunnerLike, SpawnOptions } from '../src/runner.js'
import type { WsEvent } from '../src/types.js'

// The state-machine test. It drives the REAL TaskManager over a REAL temp git
// repo (createWorktree/removeWorktree run for real, ~50ms) but injects a FAKE
// runner through the one constructor seam, so no `claude` process is spawned, no
// `gh pr create` runs, and nothing touches the network. We script stream-json
// assistant/result lines and assert every status transition that has a control
// token, plus the blocked path, the lane cap + queue, and interrupt suppression.

/** A test double for `Runner`: records turns and lets the test drive callbacks. */
class FakeRunner implements RunnerLike {
  sent: string[] = []
  killed = false
  interrupted = false
  constructor(
    readonly opts: SpawnOptions,
    readonly cb: RunnerCallbacks,
  ) {}
  send(text: string): void {
    this.sent.push(text)
  }
  interrupt(): void {
    this.interrupted = true
  }
  kill(): void {
    this.killed = true
  }
  /** Simulate a worker assistant turn carrying (optionally) a control token. */
  say(text: string): void {
    this.cb.onAssistantText(text)
  }
  /** Simulate the terminal `result` line of a turn. */
  result(text: string, isError = false): void {
    this.cb.onResult(text, isError, undefined)
  }
}

let repoDir: string
let dbDir: string
let db: Db
let created: FakeRunner[]
let factory: RunnerFactory
let events: WsEvent[]
let mgr: TaskManager

// Saved singleton state to restore after each test (config is a module singleton).
let savedRepos: typeof config.repos
let savedDefault: string
let savedLanes: number

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

function initRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-sm-repo-')))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'zmrng test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(dir, 'README.md'), '# temp target repo\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

const latest = (): FakeRunner => created[created.length - 1]
const status = (id: string): string => db.getTask(id)!.status

beforeEach(() => {
  repoDir = initRepo()
  dbDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-sm-db-')))
  db = new Db(path.join(dbDir, 'test.db'))
  created = []
  events = []
  factory = (opts, cb) => {
    const r = new FakeRunner(opts, cb)
    created.push(r)
    return r
  }
  mgr = new TaskManager(db, (e) => events.push(e), factory)

  // Register the temp repo in the config singleton as the sole/default target.
  savedRepos = config.repos
  savedDefault = config.defaultRepoId
  savedLanes = config.maxLanes
  config.repos = [{ id: 'sandbox', label: 'sandbox', path: repoDir, defaultBranch: 'main' }]
  config.defaultRepoId = 'sandbox'
})

afterEach(() => {
  mgr.shutdown()
  config.repos = savedRepos
  config.defaultRepoId = savedDefault
  config.maxLanes = savedLanes
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

/** Create a task and run it through `start` (real worktree creation). */
async function startTask(title = 'Add a feature'): Promise<string> {
  const task = mgr.createTask(title, 'do the thing', undefined, undefined, 'normal', 'sandbox')
  await mgr.start(task.id)
  return task.id
}

describe('TaskManager state machine (fake runner, real temp git repo)', () => {
  it('drives the full backlog→clarify→planning→executing→validating→review path', async () => {
    const id = await startTask()
    // backlog → clarify (start creates a real worktree/branch)
    expect(status(id)).toBe('clarify')
    const t = db.getTask(id)!
    expect(t.branch).toMatch(/^feat\/zmrng\//)
    expect(t.worktree).toContain(path.join(repoDir, 'worktrees'))
    const clarifyRunner = latest()

    // clarify → planning via ZMRNG_READY (fresh planning session spawned)
    clarifyRunner.say('scope is clear\nZMRNG_READY\nsummary follows')
    expect(status(id)).toBe('planning')
    const planRunner = latest()
    expect(planRunner).not.toBe(clarifyRunner)
    expect(clarifyRunner.killed).toBe(true)

    // planning → executing via ZMRNG_PLAN_READY (model/effort adopted)
    planRunner.say('ZMRNG_PLAN_READY model=sonnet effort=xhigh plan=.agents/plans/f.md')
    expect(status(id)).toBe('executing')
    expect(db.getTask(id)!.model).toBe('sonnet')
    expect(db.getTask(id)!.effort).toBe('xhigh')
    expect(db.getTask(id)!.planPath).toBe('.agents/plans/f.md')
    const execRunner = latest()

    // executing → validating via ZMRNG_VALIDATING
    execRunner.say('implementation done\nZMRNG_VALIDATING')
    expect(status(id)).toBe('validating')

    // validating → review via a scripted PR URL (gh pr create NEVER runs here)
    execRunner.say('PR is up: https://github.com/zmchrist/zmrng/pull/7')
    const done = db.getTask(id)!
    expect(done.status).toBe('review')
    expect(done.prUrl).toBe('https://github.com/zmchrist/zmrng/pull/7')
    expect(execRunner.killed).toBe(true)

    // Prove the seam held: every worker was a fake; no real process/gh/network.
    expect(created.every((r) => r instanceof FakeRunner)).toBe(true)
  })

  it('parks in blocked on ZMRNG_BLOCKED and restores the prior status on resume', async () => {
    const id = await startTask()
    latest().say('ZMRNG_READY')
    expect(status(id)).toBe('planning')
    const planRunner = latest()

    planRunner.say('ZMRNG_BLOCKED: qa agent not available')
    expect(status(id)).toBe('blocked')

    // The blocked child is kept alive; resume steers it and restores planning.
    mgr.resume(id)
    expect(status(id)).toBe('planning')
    expect(planRunner.sent.some((m) => /Continue the phase/.test(m))).toBe(true)
  })

  it('enforces the execute-lane cap and promotes a queued task when a lane frees', async () => {
    config.maxLanes = 1

    const a = await startTask('task A')
    const ra1 = latest()
    ra1.say('ZMRNG_READY') // A takes the only lane, now planning
    expect(status(a)).toBe('planning')
    expect(db.getTask(a)!.queued).toBe(false)
    const raPlan = latest()

    const b = await startTask('task B')
    const rb1 = latest()
    rb1.say('ZMRNG_READY') // no lane free → B is queued (still parked in planning)
    expect(status(b)).toBe('planning')
    expect(db.getTask(b)!.queued).toBe(true)
    expect(latest()).toBe(rb1) // no new planning runner spawned for B yet

    const countBeforeDrain = created.length

    // Drive A all the way to a PR, which frees its lane.
    raPlan.say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    const raExec = latest()
    raExec.say('ZMRNG_VALIDATING')
    raExec.say('https://github.com/zmchrist/zmrng/pull/1')
    expect(status(a)).toBe('review')

    // Freeing A's lane promotes B: it leaves the queue and a plan child spawns.
    expect(db.getTask(b)!.queued).toBe(false)
    expect(created.length).toBe(countBeforeDrain + 2) // A's exec child + B's plan child
    expect(latest().sent.some((m) => /PLAN PHASE/.test(m))).toBe(true)
  })

  it('interrupt() suppresses the failure path for the interrupted turn', async () => {
    const id = await startTask()
    latest().say('ZMRNG_READY')
    latest().say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    expect(status(id)).toBe('executing')
    const execRunner = latest()

    mgr.interrupt(id)
    expect(execRunner.interrupted).toBe(true)

    // The interrupted turn ends with an error + no PR. Normally that fails the
    // task; interrupt() must suppress exactly that.
    execRunner.result('', true)
    expect(status(id)).toBe('executing') // NOT 'failed'
  })

  it('WITHOUT interrupt, an errored execute turn with no PR fails the task', async () => {
    const id = await startTask()
    latest().say('ZMRNG_READY')
    latest().say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    expect(status(id)).toBe('executing')
    latest().result('', true) // error result, no PR, no prior interrupt
    expect(status(id)).toBe('failed')
  })

  it('ignores a PR URL belonging to a different repo than the task target', async () => {
    // Give the temp target a GitHub origin so the slug is resolvable.
    git(repoDir, ['remote', 'add', 'origin', 'https://github.com/zmchrist/sandbox.git'])

    const id = await startTask()
    latest().say('ZMRNG_READY')
    latest().say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    const execRunner = latest()
    execRunner.say('ZMRNG_VALIDATING')
    expect(status(id)).toBe('validating')

    // A worker quoting somebody else's PR (a linked issue, a dep's changelog)
    // must NOT flip the task to review with the wrong PR attached.
    execRunner.say('see https://github.com/other-owner/other-repo/pull/7 for context')
    expect(status(id)).toBe('validating')
    expect(db.getTask(id)!.prUrl).toBeNull()

    // The task's OWN PR still lands, even alongside a foreign one on the line.
    execRunner.say(
      'refs https://github.com/other-owner/other-repo/pull/7 — opened https://github.com/zmchrist/sandbox/pull/3',
    )
    expect(status(id)).toBe('review')
    expect(db.getTask(id)!.prUrl).toBe('https://github.com/zmchrist/sandbox/pull/3')
  })

  it('falls back to first-PR-wins when the target repo has no GitHub remote', async () => {
    // repoDir has no `origin` — repo-scoping is impossible for a local-only
    // target, so detection must still work rather than stalling forever.
    const id = await startTask()
    latest().say('ZMRNG_READY')
    latest().say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    latest().say('ZMRNG_VALIDATING')
    latest().say('opened https://github.com/anyone/anything/pull/9')
    expect(status(id)).toBe('review')
    expect(db.getTask(id)!.prUrl).toBe('https://github.com/anyone/anything/pull/9')
  })
})
