import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { TaskManager } from '../src/phases.js'
import { Db } from '../src/db.js'
import { config } from '../src/config.js'
import type { RunnerCallbacks, RunnerFactory, RunnerLike, SpawnOptions } from '../src/runner.js'
import { ScannerUnavailableError } from '../src/scanRunner.js'
import type { RawScanOutput, ScanRequest, ScanRunnerFactory } from '../src/scanRunner.js'
import type { Attachment, WsEvent } from '../src/types.js'

// The state-machine test. It drives the REAL TaskManager over a REAL temp git
// repo (createWorktree/removeWorktree run for real, ~50ms) but injects a FAKE
// runner through the one constructor seam, so no `claude` process is spawned, no
// `gh pr create` runs, and nothing touches the network. We script stream-json
// assistant/result lines and assert every status transition that has a control
// token, plus the blocked path, the lane cap + queue, and interrupt suppression.

/** A test double for `Runner`: records turns and lets the test drive callbacks. */
class FakeRunner implements RunnerLike {
  sent: string[] = []
  /** Attachments carried by each `send`, index-aligned with `sent`. */
  sentAttachments: (Attachment[] | undefined)[] = []
  killed = false
  interrupted = false
  constructor(
    readonly opts: SpawnOptions,
    readonly cb: RunnerCallbacks,
  ) {}
  send(text: string, attachments?: Attachment[]): void {
    this.sent.push(text)
    this.sentAttachments.push(attachments)
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
  /** Simulate the worker delegating to a subagent (a `Task` tool use). */
  subagent(type: string, summary = 'working'): void {
    this.cb.onToolUse('Task', summary, true, type)
  }
  /** Simulate a subagent's terminal result line (the event carries no id). */
  subagentResult(type: string, summary = 'finished', isError = false): void {
    this.cb.onSubagentResult(type, summary, isError)
  }
}

/**
 * A test double for the injected `ScanRunnerFactory`: records every request and
 * returns SCRIPTED fixture JSON, so the gate state machine never spawns real
 * semgrep/osv-scanner, hits the network, or needs the binaries installed.
 */
class FakeScanRunner {
  requests: ScanRequest[] = []
  private queue: Array<{ ok: boolean; out?: RawScanOutput; err?: unknown }> = []
  factory: ScanRunnerFactory = (req: ScanRequest): Promise<RawScanOutput> => {
    this.requests.push(req)
    const next = this.queue.shift()
    if (!next) return Promise.reject(new Error('FakeScanRunner: no scripted result'))
    return next.ok ? Promise.resolve(next.out as RawScanOutput) : Promise.reject(next.err)
  }
  /** Script a GREEN scan (no findings). */
  green(): this {
    this.queue.push({ ok: true, out: GREEN_SCAN })
    return this
  }
  /** Script a RED scan (one blocking osv finding with a fix available). */
  red(): this {
    this.queue.push({ ok: true, out: RED_SCAN })
    return this
  }
  /** Script an arbitrary raw output (e.g. garbage → fail-closed). */
  raw(out: RawScanOutput): this {
    this.queue.push({ ok: true, out })
    return this
  }
  /** Script a rejection (scanner crash → fail-closed, or ScannerUnavailable → blocked). */
  fail(err: unknown): this {
    this.queue.push({ ok: false, err })
    return this
  }
}

const TOOL_VERSIONS = { semgrep: '1.0.0-fake', 'osv-scanner': '1.0.0-fake', mode: 'test' }
const GREEN_SCAN: RawScanOutput = {
  semgrep: '{"results":[]}',
  osv: '{"results":[]}',
  toolVersions: TOOL_VERSIONS,
}
// One osv vuln with a `fixed` event → fixAvailable:true → blocks (D1).
const RED_SCAN: RawScanOutput = {
  semgrep: '{"results":[]}',
  osv: JSON.stringify({
    results: [
      {
        packages: [
          {
            package: { name: 'lodash' },
            vulnerabilities: [
              {
                id: 'GHSA-jf85-cpcp-j695',
                summary: 'Prototype pollution in lodash',
                aliases: ['CVE-2019-10744'],
                affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
              },
            ],
          },
        ],
      },
    ],
  }),
  toolVersions: TOOL_VERSIONS,
}

/**
 * Let onScanReady's async continuation (post-await) run to completion. Awaits
 * several event-loop turns rather than a single tick: real git spawns + stream
 * parsing can chain across more than one macrotask under CPU contention, so a
 * one-tick flush was occasionally insufficient (a load-induced flake in the
 * combined validation gate). Extra ticks are harmless when the work has already
 * settled.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

let repoDir: string
let dbDir: string
let db: Db
let created: FakeRunner[]
let factory: RunnerFactory
let events: WsEvent[]
let mgr: TaskManager
let scan: FakeScanRunner

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
  scan = new FakeScanRunner()
  mgr = new TaskManager(db, (e) => events.push(e), factory, scan.factory)

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
async function startTask(
  title = 'Add a feature',
  flow: 'plan' | 'direct' = 'plan',
): Promise<string> {
  const task = mgr.createTask(title, 'do the thing', undefined, undefined, 'normal', 'sandbox', flow)
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

  it('direct flow skips the plan phase: ZMRNG_READY jumps straight to executing', async () => {
    const id = await startTask('Resolve a merge conflict', 'direct')
    expect(status(id)).toBe('clarify')
    const clarifyRunner = latest()

    // clarify → executing directly (NO planning session ever spawned)
    clarifyRunner.say('scope clear\nZMRNG_READY\nresolve the conflict in x')
    expect(status(id)).toBe('executing')
    const execRunner = latest()
    expect(execRunner).not.toBe(clarifyRunner)
    expect(clarifyRunner.killed).toBe(true)
    // The execute child got the lean direct kickoff, not the heavy plan/exec one.
    expect(execRunner.sent.some((m) => /DIRECT EXECUTE PHASE/.test(m))).toBe(true)
    expect(execRunner.sent.some((m) => /PLAN PHASE/.test(m))).toBe(false)

    // executing → review straight off a PR URL (no ZMRNG_VALIDATING hop required)
    execRunner.say('opened https://github.com/zmchrist/zmrng/pull/42')
    expect(status(id)).toBe('review')
    expect(db.getTask(id)!.prUrl).toBe('https://github.com/zmchrist/zmrng/pull/42')

    // Prove no planning child was ever created: clarify + execute only.
    expect(created.length).toBe(2)
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

  it('closeLane() kills a live worker, parks it blocked, frees the lane for the queue, and restartAgent restores the phase', async () => {
    config.maxLanes = 1
    const a = await startTask('task A')
    latest().say('ZMRNG_READY')
    const raPlan = latest()
    const b = await startTask('task B')
    latest().say('ZMRNG_READY') // B queued
    expect(db.getTask(b)!.queued).toBe(true)
    const before = created.length

    mgr.closeLane(a)
    expect(raPlan.killed).toBe(true)
    expect(status(a)).toBe('blocked')
    expect(mgr.laneSnapshot().workers.some((w) => w.taskId === a)).toBe(false)
    // A's lane was freed: B left the queue and a plan child spawned.
    expect(db.getTask(b)!.queued).toBe(false)
    expect(created.length).toBe(before + 1)

    // A is resumable: restartAgent restores `planning` (queued behind B's lane).
    await mgr.restartAgent(a)
    expect(status(a)).toBe('planning')
  })

  it('closeLane() on a queued task dequeues it and parks it blocked', async () => {
    config.maxLanes = 1
    await startTask('task A')
    latest().say('ZMRNG_READY')
    const b = await startTask('task B')
    latest().say('ZMRNG_READY')
    expect(db.getTask(b)!.queued).toBe(true)

    mgr.closeLane(b)
    expect(status(b)).toBe('blocked')
    expect(db.getTask(b)!.queued).toBe(false)
    expect(mgr.laneSnapshot().execute.queued).not.toContain(b)
  })

  it('closeLane() rejects a task with no lane to close', async () => {
    const id = await startTask()
    mgr.cancel(id)
    await flush()
    expect(() => mgr.closeLane(id)).toThrow()
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

describe('restart after orphan (agent-task-persistence)', () => {
  /** A second manager on the SAME db with empty runners — simulates an app restart. */
  function restartedManager(): { mgr: TaskManager; created: FakeRunner[]; events: WsEvent[] } {
    const created2: FakeRunner[] = []
    const events2: WsEvent[] = []
    const factory2: RunnerFactory = (opts, cb) => {
      const r = new FakeRunner(opts, cb)
      created2.push(r)
      return r
    }
    return { mgr: new TaskManager(db, (e) => events2.push(e), factory2), created: created2, events: events2 }
  }

  /** Drive a fresh task all the way to `executing` on `mgr`. */
  async function toExecuting(title = 'orphan me'): Promise<string> {
    const id = await startTask(title)
    latest().say('ZMRNG_READY')
    latest().say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    expect(status(id)).toBe('executing')
    return id
  }

  it('reconcileOrphans marks an orphaned live-phase task stale and notes the ended session', async () => {
    const id = await toExecuting()

    const r = restartedManager()
    r.mgr.reconcileOrphans()

    expect(db.getTask(id)!.stale).toBe(true)
    expect(status(id)).toBe('executing') // status preserved, not clobbered
    expect(db.getTask(id)!.queued).toBe(false)
    expect(
      r.events.some(
        (e) =>
          e.type === 'event' &&
          e.event.kind === 'status' &&
          /session ended|restart/i.test(e.event.payload.note ?? ''),
      ),
    ).toBe(true)
  })

  it('message() on an orphaned task rejects with the restart-agent guidance', async () => {
    const id = await toExecuting()
    const r = restartedManager()
    r.mgr.reconcileOrphans()

    expect(() => r.mgr.message(id, 'you there?')).toThrow(/worker session has ended[\s\S]*Restart agent/)
  })

  it('restartAgent respawns an executing orphan with a RESUME+EXECUTE kickoff, clears stale, and completes to review', async () => {
    const id = await toExecuting()
    const r = restartedManager()
    r.mgr.reconcileOrphans()
    expect(db.getTask(id)!.stale).toBe(true)

    await r.mgr.restartAgent(id)
    expect(db.getTask(id)!.stale).toBe(false)
    expect(status(id)).toBe('executing')

    const resumed = r.created[r.created.length - 1]
    expect(resumed.sent.some((m) => /RESUME/.test(m))).toBe(true)
    expect(resumed.sent.some((m) => /EXECUTE PHASE/.test(m))).toBe(true)

    // The restarted agent drives to a PR — proving it can finish the task.
    resumed.say('opened https://github.com/anyone/anything/pull/5')
    expect(status(id)).toBe('review')
    expect(db.getTask(id)!.prUrl).toBe('https://github.com/anyone/anything/pull/5')
  })

  it('restartAgent respawns a clarify orphan with a CLARIFY resume', async () => {
    const id = await startTask() // → clarify
    expect(status(id)).toBe('clarify')

    const r = restartedManager()
    r.mgr.reconcileOrphans()
    expect(db.getTask(id)!.stale).toBe(true)

    await r.mgr.restartAgent(id)
    expect(db.getTask(id)!.stale).toBe(false)
    expect(status(id)).toBe('clarify')
    const resumed = r.created[r.created.length - 1]
    expect(resumed.sent.some((m) => /RESUME/.test(m))).toBe(true)
    expect(resumed.sent.some((m) => /CLARIFY PHASE/.test(m))).toBe(true)
  })

  it('restartAgent rejects when a live runner already exists and when the status is not resumable', async () => {
    const id = await toExecuting()
    // `mgr` still holds the live runner → nothing to restart.
    await expect(mgr.restartAgent(id)).rejects.toThrow(/already|nothing to restart/i)

    // Drive it to review (not a resumable status).
    latest().say('opened https://github.com/anyone/anything/pull/8')
    expect(status(id)).toBe('review')
    await expect(mgr.restartAgent(id)).rejects.toThrow(/cannot restart/i)
  })

  it('queues a second executing-orphan restart under a 1-lane cap and promotes it via a RESUME kickoff', async () => {
    // Two tasks both reach `executing` while 2 lanes are available...
    config.maxLanes = 2
    const a = await toExecuting('task A')
    const b = await toExecuting('task B')

    // ...then the app restarts with only ONE lane.
    config.maxLanes = 1
    const r = restartedManager()
    r.mgr.reconcileOrphans()
    expect(db.getTask(a)!.stale).toBe(true)
    expect(db.getTask(b)!.stale).toBe(true)

    await r.mgr.restartAgent(a) // takes the only lane
    await r.mgr.restartAgent(b) // no lane free → queued
    expect(db.getTask(a)!.queued).toBe(false)
    expect(db.getTask(b)!.queued).toBe(true)
    expect(status(b)).toBe('executing')

    const resumedA = r.created[0]
    expect(resumedA.sent.some((m) => /RESUME/.test(m))).toBe(true)

    // Driving A to a PR frees its lane and promotes B — via a RESUME kickoff,
    // NOT a fresh PLAN/DIRECT one, so the resumed context is preserved.
    resumedA.say('opened https://github.com/anyone/anything/pull/1')
    expect(status(a)).toBe('review')
    expect(db.getTask(b)!.queued).toBe(false)

    const resumedB = r.created[r.created.length - 1]
    expect(resumedB).not.toBe(resumedA)
    expect(resumedB.sent.some((m) => /RESUME/.test(m))).toBe(true)
    expect(resumedB.sent.some((m) => /EXECUTE PHASE/.test(m))).toBe(true)
    expect(resumedB.sent.some((m) => /PLAN PHASE/.test(m))).toBe(false)
  })
})

describe('deleteTask', () => {
  it('hard-deletes a backlog task (no worktree) and broadcasts task-removed', async () => {
    const task = mgr.createTask('never started', 'do the thing', undefined, undefined, 'normal', 'sandbox', 'direct')
    await mgr.deleteTask(task.id)
    expect(db.getTask(task.id)).toBeUndefined()
    expect(events.some((e) => e.type === 'task-removed' && e.taskId === task.id)).toBe(true)
  })

  it('rejects deleting a task mid-flight (not in backlog/done/failed)', async () => {
    const id = await startTask() // → clarify
    expect(status(id)).toBe('clarify')
    await expect(mgr.deleteTask(id)).rejects.toThrow(/cannot delete task in status 'clarify'/)
    expect(db.getTask(id)).toBeDefined()
  })

  it('cleans up a leftover worktree/branch when deleting a failed task', async () => {
    const id = await startTask()
    latest().say('ZMRNG_READY')
    latest().say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    expect(status(id)).toBe('executing')
    latest().result('', true) // error result, no PR → fails, worktree left behind
    expect(status(id)).toBe('failed')
    const worktreePath = db.getTask(id)!.worktree!
    expect(existsSync(worktreePath)).toBe(true)

    await mgr.deleteTask(id)

    expect(db.getTask(id)).toBeUndefined()
    expect(existsSync(worktreePath)).toBe(false)
  })

  // ---- multimodal attachments (image/PDF drop/paste) ----

  const attach = (name: string): Attachment => ({
    kind: 'image',
    mediaType: 'image/png',
    dataBase64: 'aGVsbG8=',
    name,
  })

  it('carries new-task-box attachments into the first clarify send', async () => {
    const task = mgr.createTask(
      'with image',
      'do the thing',
      undefined,
      undefined,
      'normal',
      'sandbox',
      'direct',
      [attach('a.png')],
    )
    await mgr.start(task.id)
    const clarify = latest()
    // Exactly one send so far (the clarify kickoff) — it carries the attachment.
    expect(clarify.sentAttachments[0]).toEqual([attach('a.png')])
  })

  it('consumes held attachments once — later turns do not re-inject them', async () => {
    const task = mgr.createTask(
      'with image',
      'do the thing',
      undefined,
      undefined,
      'normal',
      'sandbox',
      'direct',
      [attach('a.png')],
    )
    await mgr.start(task.id)
    const runner = latest()
    // Only the clarify kickoff carried the held attachment...
    expect(runner.sentAttachments[0]).toEqual([attach('a.png')])
    // ...and a subsequent attachment-less operator turn does NOT re-inject it.
    mgr.message(task.id, 'a follow-up')
    expect(runner.sentAttachments.at(-1)).toBeUndefined()
  })

  it('passes steer attachments through message() to the live send', async () => {
    const id = await startTask('steer me', 'direct')
    expect(status(id)).toBe('clarify')
    const runner = latest()
    const sendsBefore = runner.sent.length
    mgr.message(id, 'look at this', [attach('shot.png')])
    expect(runner.sent[sendsBefore]).toBe('look at this')
    expect(runner.sentAttachments[sendsBefore]).toEqual([attach('shot.png')])
    // The logged operator event notes that a file rode along.
    expect(
      events.some(
        (e) => e.type === 'event' && /\[1 attachment\(s\)\]/.test(e.event.payload.text ?? ''),
      ),
    ).toBe(true)
  })
})

describe('security-scan gate (fake scan runner)', () => {
  const openedPr = (r: FakeRunner): boolean => r.sent.some((m) => /git push -u origin/.test(m))
  const gotFixKickoff = (r: FakeRunner): string | undefined =>
    r.sent.find((m) => /SECURITY SCAN RED/.test(m))

  /** Drive a plan-flow task to `validating` (execute child in hand). */
  async function toValidating(title = 'gate me'): Promise<{ id: string; exec: FakeRunner }> {
    const id = await startTask(title)
    latest().say('ZMRNG_READY')
    latest().say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    const exec = latest()
    exec.say('ZMRNG_VALIDATING')
    expect(status(id)).toBe('validating')
    return { id, exec }
  }

  it('scenario 1: green scan → openPrKickoff → PR → review; one pass scan row (task stays validating)', async () => {
    scan.green()
    const { id, exec } = await toValidating()

    exec.say('ZMRNG_SCAN_READY')
    await flush()

    // D6: the task STAYS validating through the scan (no new `scanning` status).
    expect(status(id)).toBe('validating')
    expect(db.getTask(id)!.securityStatus).toBe('pass')
    // The scan ran full SAST+SCA (plan flow, D2) on the worktree.
    expect(scan.requests).toHaveLength(1)
    expect(scan.requests[0].sast).toBe(true)
    expect(scan.requests[0].worktree).toContain('worktrees')
    // openPrKickoff went into the SAME live session.
    expect(openedPr(exec)).toBe(true)
    // Exactly one persisted scan row, verdict pass.
    const rows = db.listSecurityScansForTask(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('pass')
    expect(rows[0].round).toBe(1)

    // The existing PR detection then drives the task to review, unchanged.
    exec.say('opened https://github.com/anyone/anything/pull/7')
    expect(status(id)).toBe('review')
    expect(db.getTask(id)!.prUrl).toBe('https://github.com/anyone/anything/pull/7')
  })

  it('scenario 2: red round 1 → securityFixKickoff → green round 2 → PR; two scan rows', async () => {
    scan.red().green()
    const { id, exec } = await toValidating()

    exec.say('ZMRNG_SCAN_READY')
    await flush()

    // Round 1 red: fix kickoff with the findings report + round budget.
    expect(db.getTask(id)!.securityStatus).toBe('fail')
    const fix = gotFixKickoff(exec)
    expect(fix).toBeDefined()
    expect(fix).toMatch(/round 1\/2/)
    expect(fix).toMatch(/lodash/) // the deterministic findings report
    expect(status(id)).toBe('validating') // stays validating, child alive
    expect(exec.killed).toBe(false)

    // Worker fixes, re-commits, re-emits the token → round 2 green.
    exec.say('ZMRNG_SCAN_READY')
    await flush()
    expect(db.getTask(id)!.securityStatus).toBe('pass')
    expect(openedPr(exec)).toBe(true)

    // TWO persisted rows: fail then pass.
    const rows = db.listSecurityScansForTask(id)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.verdict)).toEqual(['fail', 'pass'])
    expect(rows.map((r) => r.round)).toEqual([1, 2])

    exec.say('opened https://github.com/anyone/anything/pull/2')
    expect(status(id)).toBe('review')
  })

  it('scenario 3: rounds exhausted (maxRounds=1) → blocked with findings summary; child alive', async () => {
    config.repos = [
      { id: 'sandbox', label: 'sandbox', path: repoDir, defaultBranch: 'main', security: { maxRounds: 1 } },
    ]
    scan.red()
    const { id, exec } = await toValidating()

    exec.say('ZMRNG_SCAN_READY')
    await flush()

    expect(status(id)).toBe('blocked')
    expect(db.getTask(id)!.securityStatus).toBe('fail')
    // No fix kickoff — the budget was exhausted at round 1.
    expect(gotFixKickoff(exec)).toBeUndefined()
    // Child kept alive (operator inspects/resumes), like the missing-subagent block.
    expect(exec.killed).toBe(false)
    // The blocked reason carries a findings summary.
    expect(
      events.some(
        (e) => e.type === 'event' && e.event.kind === 'error' && /still red after 1 round/.test(e.event.payload.text ?? ''),
      ),
    ).toBe(true)
    const rows = db.listSecurityScansForTask(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('fail')
  })

  it('scenario 4: opt-out (security.enabled=false) → straight to openPrKickoff, skipped, NO scan row', async () => {
    config.repos = [
      { id: 'sandbox', label: 'sandbox', path: repoDir, defaultBranch: 'main', security: { enabled: false } },
    ]
    const { id, exec } = await toValidating()

    exec.say('ZMRNG_SCAN_READY')
    await flush()

    expect(db.getTask(id)!.securityStatus).toBe('skipped')
    expect(openedPr(exec)).toBe(true)
    // The scanner was NEVER invoked and NO scan row was written (the only silent skip).
    expect(scan.requests).toHaveLength(0)
    expect(db.listSecurityScansForTask(id)).toHaveLength(0)
  })

  it('scenario 5: scanners unavailable/unprovisionable → blocked with install message; never a pass', async () => {
    scan.fail(
      new ScannerUnavailableError(
        'semgrep and osv-scanner not found on PATH and could not be auto-provisioned — install semgrep / osv-scanner',
      ),
    )
    const { id, exec } = await toValidating()

    exec.say('ZMRNG_SCAN_READY')
    await flush()

    expect(status(id)).toBe('blocked')
    expect(db.getTask(id)!.securityStatus).not.toBe('pass')
    expect(openedPr(exec)).toBe(false)
    // The block reason surfaces the install guidance.
    expect(
      events.some(
        (e) => e.type === 'event' && e.event.kind === 'error' && /install/i.test(e.event.payload.text ?? ''),
      ),
    ).toBe(true)
    expect(exec.killed).toBe(false)
  })

  it('scenario 6a: scan factory rejects (crash) → fail-closed to RED-BLOCKED, never a pass', async () => {
    scan.fail(new Error('semgrep segfaulted'))
    const { id, exec } = await toValidating()

    exec.say('ZMRNG_SCAN_READY')
    await flush()

    expect(status(id)).toBe('blocked')
    expect(db.getTask(id)!.securityStatus).toBe('fail')
    expect(openedPr(exec)).toBe(false)
    // A fail-closed row is persisted so the operator sees the failed scan.
    const rows = db.listSecurityScansForTask(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('fail')
  })

  it('scenario 6b: garbage (non-empty, non-JSON) output → fail-closed, never parsed to a false pass', async () => {
    scan.raw({ semgrep: 'not json at all', osv: 'also garbage', toolVersions: {} })
    const { id, exec } = await toValidating()

    exec.say('ZMRNG_SCAN_READY')
    await flush()

    expect(status(id)).toBe('blocked')
    expect(db.getTask(id)!.securityStatus).toBe('fail')
    expect(openedPr(exec)).toBe(false)
  })

  it('scenario 7 (D3): the execute lane is FREE during the scan — a queued task takes it', async () => {
    config.maxLanes = 1
    scan.green()

    // Task A takes the only lane and reaches validating.
    const a = await startTask('task A')
    latest().say('ZMRNG_READY')
    const aPlan = latest()
    aPlan.say('ZMRNG_PLAN_READY model=opus effort=high plan=p.md')
    const aExec = latest()
    aExec.say('ZMRNG_VALIDATING')
    expect(status(a)).toBe('validating')

    // Task B reaches READY but no lane is free → queued.
    const b = await startTask('task B')
    latest().say('ZMRNG_READY')
    expect(db.getTask(b)!.queued).toBe(true)
    const createdBeforeScan = created.length

    // A hands off to the deterministic scan. freeLane runs SYNCHRONOUSLY before
    // the scan await, so B is promoted immediately — proving the lane is free
    // (not idled on machine work) while A's scan is in flight (D3).
    aExec.say('ZMRNG_SCAN_READY')
    expect(db.getTask(b)!.queued).toBe(false)
    expect(created.length).toBe(createdBeforeScan + 1) // B's plan child spawned
    expect(latest().sent.some((m) => /PLAN PHASE/.test(m))).toBe(true)

    // A's scan resolves green → openPrKickoff into A's still-alive session; A did
    // NOT need to re-acquire a lane for a green verdict.
    await flush()
    expect(openedPr(aExec)).toBe(true)
    expect(db.getTask(a)!.securityStatus).toBe('pass')
  })

  it('scenario 8 (D2): plan flow scans SAST+SCA; direct flow scans SCA-only', async () => {
    // Plan flow → full gate (sast true).
    scan.green()
    const { exec: pExec } = await toValidating('plan task')
    pExec.say('ZMRNG_SCAN_READY')
    await flush()
    expect(scan.requests.at(-1)!.sast).toBe(true)

    // Direct flow → SCA-only (sast false). The direct worker prints the token
    // straight from `executing`; onScanReady folds it into validating for the scan.
    scan.green()
    const d = await startTask('direct task', 'direct')
    latest().say('ZMRNG_READY')
    expect(status(d)).toBe('executing')
    const dExec = latest()
    dExec.say('ZMRNG_SCAN_READY')
    await flush()
    expect(scan.requests.at(-1)!.sast).toBe(false)
    expect(db.getTask(d)!.securityStatus).toBe('pass')
    expect(openedPr(dExec)).toBe(true)
  })
})

// D2/D4 — the cheap-default pipeline. createTask persists NULL when the operator
// picked nothing, so each phase resolves its own cheap default at spawn time:
// clarify → sonnet (D4), direct execute → sonnet/medium (D2). An explicit
// operator pick is stored verbatim and wins everywhere.
describe('default model/effort resolution (D2/D4)', () => {
  it('createTask persists NULL model/effort when the operator supplied none', () => {
    const t = mgr.createTask('menial', 'do it', undefined, undefined, 'normal', 'sandbox', 'direct')
    const row = db.getTask(t.id)!
    expect(row.model).toBeNull()
    expect(row.effort).toBeNull()
  })

  it('createTask persists the operator’s explicit pick verbatim', () => {
    const t = mgr.createTask('picky', 'do it', 'opus', 'max', 'normal', 'sandbox', 'direct')
    const row = db.getTask(t.id)!
    expect(row.model).toBe('opus')
    expect(row.effort).toBe('max')
  })

  it('clarify phase spawns on sonnet regardless of the task’s persisted model (D4)', async () => {
    // Explicit opus pick — clarify must STILL run sonnet (cheap Q&A phase).
    const t = mgr.createTask('big task', 'do it', 'opus', 'high', 'normal', 'sandbox', 'plan')
    await mgr.start(t.id)
    expect(status(t.id)).toBe('clarify')
    expect(latest().opts.model).toBe('sonnet')
    // The operator log is truthful — it reports the ACTUAL model used (sonnet).
    expect(
      events.some(
        (e) =>
          e.type === 'event' && /settings — model=sonnet/.test(e.event.payload.note ?? ''),
      ),
    ).toBe(true)
  })

  it('direct execute resolves sonnet/medium when the operator picked nothing (D2)', async () => {
    const id = await startTask('menial direct', 'direct') // no model/effort supplied → NULL
    const clarify = latest()
    clarify.say('scope clear\nZMRNG_READY\ndo the menial thing')
    expect(status(id)).toBe('executing')
    const exec = latest()
    expect(exec).not.toBe(clarify)
    expect(exec.opts.model).toBe('sonnet')
    expect(exec.opts.effort).toBe('medium')
  })

  it('direct execute honors an explicit opus/high pick (operator wins)', async () => {
    const t = mgr.createTask('heavy direct', 'do it', 'opus', 'high', 'normal', 'sandbox', 'direct')
    await mgr.start(t.id)
    latest().say('scope clear\nZMRNG_READY\ndo the heavy thing')
    expect(status(t.id)).toBe('executing')
    expect(latest().opts.model).toBe('opus')
    expect(latest().opts.effort).toBe('high')
  })
})

describe('TaskManager.laneSnapshot (lane viewer rows)', () => {
  it('reports the cap from config.maxLanes, the lane holders, and the queue in promotion order', async () => {
    config.maxLanes = 1

    const a = await startTask('task A')
    expect(mgr.laneSnapshot().execute).toEqual({ cap: 1, holders: [], queued: [] })

    latest().say('ZMRNG_READY') // A takes the only lane
    expect(mgr.laneSnapshot().execute).toEqual({ cap: 1, holders: [a], queued: [] })

    const b = await startTask('task B')
    latest().say('ZMRNG_READY') // no lane → queued
    const c = await startTask('task C')
    latest().say('ZMRNG_READY') // no lane → queued behind B
    expect(mgr.laneSnapshot().execute).toEqual({ cap: 1, holders: [a], queued: [b, c] })

    // Freeing A's lane promotes B (FIFO), leaving C still queued.
    const aPlan = created.find((r) => r.sent.some((m) => /PLAN PHASE/.test(m)))!
    aPlan.say('ZMRNG_PLAN_READY model=sonnet effort=medium plan=p.md')
    latest().say('https://github.com/zmchrist/zmrng/pull/1')
    expect(status(a)).toBe('review')
    expect(mgr.laneSnapshot().execute).toEqual({ cap: 1, holders: [b], queued: [c] })
  })

  it('carries the RESOLVED model/effort/style the child was actually spawned with', async () => {
    const id = await startTask()
    // Clarify forces sonnet regardless of the task row (whose model stays NULL).
    expect(db.getTask(id)!.model).toBeNull()
    const clarifyRow = mgr.laneSnapshot().workers[0]
    expect(clarifyRow).toMatchObject({ taskId: id, model: 'sonnet', effort: 'high', style: 'normal' })
    expect(clarifyRow.holdsLane).toBe(false) // clarify is uncapped — it holds no lane
    expect(new Date(clarifyRow.startedAt).toISOString()).toBe(clarifyRow.startedAt)

    // The plan phase always spawns opus/high, and it DOES hold a lane.
    latest().say('ZMRNG_READY')
    const planRow = mgr.laneSnapshot().workers[0]
    expect(planRow).toMatchObject({ taskId: id, model: 'opus', effort: 'high', holdsLane: true })
  })

  it('adds a running subagent child row and flips it to done on the matching result', async () => {
    await startTask()
    const clarify = latest()
    clarify.subagent('zmrng-qa', 'run the suite')
    const running = mgr.laneSnapshot().workers[0].subagents
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({ type: 'zmrng-qa', status: 'running', description: 'run the suite' })
    expect(running[0].id).toBeTruthy()

    clarify.subagentResult('zmrng-qa', 'suite green')
    const done = mgr.laneSnapshot().workers[0].subagents
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ type: 'zmrng-qa', status: 'done', description: 'suite green' })
    expect(done[0].id).toBe(running[0].id) // same row, flipped — not a second one
  })

  it('marks a subagent row error when its result is an error, and matches FIFO by type', async () => {
    await startTask()
    const clarify = latest()
    clarify.subagent('zmrng-qa', 'first')
    clarify.subagent('zmrng-qa', 'second')
    clarify.subagent('code-reviewer', 'review')

    // The events carry no id: the first qa result closes the OLDER qa row.
    clarify.subagentResult('zmrng-qa', 'boom', true)
    const rows = mgr.laneSnapshot().workers[0].subagents
    expect(rows.map((r) => [r.type, r.status, r.description])).toEqual([
      ['zmrng-qa', 'error', 'boom'],
      ['zmrng-qa', 'running', 'second'],
      ['code-reviewer', 'running', 'review'],
    ])
  })

  it('ignores a subagent result with no matching running row (never throws)', async () => {
    await startTask()
    expect(() => latest().subagentResult('zmrng-qa', 'orphan result')).not.toThrow()
    expect(mgr.laneSnapshot().workers[0].subagents).toEqual([])
  })

  it('a phase handoff resets the subagent list (the fresh spawn starts empty)', async () => {
    await startTask()
    const clarify = latest()
    clarify.subagent('zmrng-qa', 'clarify-era subagent')
    expect(mgr.laneSnapshot().workers[0].subagents).toHaveLength(1)

    clarify.say('ZMRNG_READY') // replaceChild → fresh planning spawn
    expect(mgr.laneSnapshot().workers[0].subagents).toEqual([])
  })

  it('bounds the retained rows: every running row survives, oldest COMPLETED dropped first', async () => {
    await startTask()
    const r = latest()
    // One long-lived running row, then far more completed rows than the cap.
    r.subagent('pinned', 'still going')
    for (let i = 0; i < 60; i++) {
      r.subagent('worker', `job ${i}`)
      r.subagentResult('worker', `job ${i} done`)
    }
    const rows = mgr.laneSnapshot().workers[0].subagents
    expect(rows.length).toBeLessThanOrEqual(50)
    // The running row is never evicted...
    expect(rows.some((x) => x.type === 'pinned' && x.status === 'running')).toBe(true)
    // ...and the newest completed rows are what is kept.
    expect(rows[rows.length - 1].description).toBe('job 59 done')
    expect(rows.some((x) => x.description === 'job 0 done')).toBe(false)
  })

  it('drops the worker row once the task reaches review (no live runner, no stale row)', async () => {
    const id = await startTask('to review', 'direct')
    latest().say('ZMRNG_READY')
    expect(mgr.laneSnapshot().workers.map((w) => w.taskId)).toEqual([id])
    latest().say('https://github.com/zmchrist/zmrng/pull/9')
    expect(status(id)).toBe('review')
    expect(mgr.laneSnapshot().workers).toEqual([])
    expect(mgr.laneSnapshot().execute.holders).toEqual([])
  })
})

describe('TaskManager onLanesChange (lane emitter notify seam)', () => {
  it('fires on spawn, on subagent activity, on lane acquire and on exit', async () => {
    let calls = 0
    const m = new TaskManager(db, (e) => events.push(e), factory, scan.factory, () => {
      calls++
    })
    const task = m.createTask('notify me', 'do it', undefined, undefined, 'normal', 'sandbox', 'direct')
    await m.start(task.id)
    const afterStart = calls
    expect(afterStart).toBeGreaterThan(0)

    latest().subagent('zmrng-qa')
    expect(calls).toBeGreaterThan(afterStart)
    const afterSub = calls

    latest().say('ZMRNG_READY') // handoff: lane acquired + fresh spawn
    expect(calls).toBeGreaterThan(afterSub)
    m.shutdown()
  })
})
