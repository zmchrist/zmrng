import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/db.js'
import { LoopError, LoopManager, type LoopDeps } from '../src/loop.js'
import type { GhIssue, GhTicket, LoopGitHub, LoopMapFetch } from '../src/loopGithub.js'
import type { LoadProbe } from '../src/loopLoad.js'
import { randomLabel } from '../src/loopMap.js'
import {
  builderPrompt,
  criticPrompt,
  finalPrKickoff,
  foldPrompt,
  orchestratorKickoff,
  STEP_PROFILES,
  validatePrompt,
  type LoopStepCtx,
  type OrchestratorCtx,
} from '../src/loopPrompts.js'
import type { ResultUsage, RunnerCallbacks, RunnerFactory, RunnerLike, SpawnOptions } from '../src/runner.js'
import { ScannerUnavailableError } from '../src/scanRunner.js'
import type { RawScanOutput, ScanRequest, ScanRunnerFactory } from '../src/scanRunner.js'
import type {
  LoopEvent,
  LoopGhState,
  LoopLoad,
  LoopRunView,
  RepoTarget,
  SecurityPolicy,
  WsEvent,
} from '../src/types.js'

// The Loop engine test. It drives the REAL LoopManager over a REAL temp git repo
// with a BARE origin (so the server's integ push really lands somewhere), but
// injects every external edge: a fake RunnerFactory (scripted turns, some of which
// run real git commits/merges in the step's cwd), a fake GitHub, a fake load
// probe and a fake scanner. No `claude`, no `gh`, no network. All async work is
// awaited through `whenIdle()` — never a sleep.

// ---- fakes -------------------------------------------------------------------

/** A test double for `Runner`: records spawn options + sends; the test drives callbacks. */
class FakeRunner implements RunnerLike {
  sent: string[] = []
  killed = false
  /** Set when the test simulates the child exiting on its own. */
  exited = false
  constructor(
    readonly opts: SpawnOptions,
    readonly cb: RunnerCallbacks,
  ) {}
  send(text: string): void {
    this.sent.push(text)
  }
  interrupt(): void {}
  kill(): void {
    this.killed = true
  }
  say(text: string): void {
    this.cb.onAssistantText(text)
  }
  result(text = '', isError = false, usage?: ResultUsage): void {
    this.cb.onResult(text, isError, usage)
  }
  /** One full turn: an assistant message, then the terminal result line. */
  turn(text: string): void {
    this.say(text)
    this.result('')
  }
  toolUse(name: string, summary: string): void {
    this.cb.onToolUse(name, summary, false)
  }
  exit(code: number | null = 1): void {
    this.exited = true
    this.cb.onExit(code, null)
  }
  get alive(): boolean {
    return !this.killed && !this.exited
  }
}

/** A fake GitHub seam: the map and single issues come from in-memory fixtures. */
class FakeGitHub implements LoopGitHub {
  epic: GhIssue = {
    number: 1,
    title: 'Ship the landing page',
    body: '- [ ] #2\n- [ ] #3',
    url: 'https://github.com/owner/repo/issues/1',
    state: 'open',
  }
  tickets: GhTicket[] = []
  external: Record<number, LoopGhState> = {}
  /** Issues fetchIssue can see beyond `tickets` (e.g. out-of-map blockers). */
  extra: GhTicket[] = []
  fail = false
  calls: string[] = []
  async fetchMap(slug: string, epic: number): Promise<LoopMapFetch> {
    this.calls.push(`map ${slug} #${epic}`)
    if (this.fail) throw new Error('gh: HTTP 500')
    return {
      epic: { ...this.epic, number: epic },
      tickets: this.tickets.map((t) => ({ ...t, blockedBy: [...t.blockedBy] })),
      external: { ...this.external },
    }
  }
  async fetchIssue(slug: string, n: number): Promise<GhTicket> {
    this.calls.push(`issue ${slug} #${n}`)
    if (this.fail) throw new Error('gh: HTTP 500')
    const t = [...this.tickets, ...this.extra].find((x) => x.number === n)
    if (!t) throw new Error(`gh: issue #${n} not found`)
    return { ...t, blockedBy: [...t.blockedBy] }
  }
}

/** A fake load probe: each test sets the next sample. */
class FakeLoad implements LoadProbe {
  next: LoopLoad = sample()
  samples = 0
  async sample(): Promise<LoopLoad> {
    this.samples++
    return { ...this.next }
  }
}

/** A fake scanner returning scripted fixture JSON (the taskManager.test.ts shapes). */
class FakeScanRunner {
  requests: ScanRequest[] = []
  private queue: Array<{
    ok: boolean
    out?: RawScanOutput
    err?: unknown
    run?: (req: ScanRequest) => Promise<RawScanOutput>
  }> = []
  factory: ScanRunnerFactory = (req: ScanRequest): Promise<RawScanOutput> => {
    this.requests.push(req)
    const next = this.queue.shift()
    if (!next) return Promise.reject(new Error('FakeScanRunner: no scripted result'))
    if (next.run) return next.run(req)
    return next.ok ? Promise.resolve(next.out as RawScanOutput) : Promise.reject(next.err)
  }
  /** Script a scan that runs test code while it is "in progress" (no sleeps needed). */
  run(fn: (req: ScanRequest) => Promise<RawScanOutput>): this {
    this.queue.push({ ok: true, run: fn })
    return this
  }
  green(): this {
    this.queue.push({ ok: true, out: GREEN_SCAN })
    return this
  }
  red(): this {
    this.queue.push({ ok: true, out: RED_SCAN })
    return this
  }
  raw(out: RawScanOutput): this {
    this.queue.push({ ok: true, out })
    return this
  }
  fail(err: unknown): this {
    this.queue.push({ ok: false, err })
    return this
  }
}

const TOOL_VERSIONS = { semgrep: '1.0.0-fake', 'osv-scanner': '1.0.0-fake', mode: 'test' }
const GREEN_SCAN: RawScanOutput = { semgrep: '{"results":[]}', osv: '{"results":[]}', toolVersions: TOOL_VERSIONS }
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

// ---- fixtures ----------------------------------------------------------------

const API_BASE = 'http://127.0.0.1:4599'
const SLUG = 'owner/repo'
const EPIC_TITLE = 'Ship the landing page'
/** Fixed randomness → a known blind label for "ours". */
const RANDOM = (): number => 0.25
const OURS = randomLabel(RANDOM)
const THEIRS = OURS === 'A' ? 'B' : 'A'
const POLICY: SecurityPolicy = { enabled: true, maxRounds: 2, semgrepConfig: 'p/test', minSeverity: 'ERROR' }

function sample(over: Partial<LoopLoad> = {}): LoopLoad {
  return {
    cores: 8,
    loadAvg1: 2,
    loadPerCore: 0.25,
    memTotalMb: 16384,
    memAvailableMb: 8192,
    maxLoadPerCore: 1,
    minFreeMemMb: 2048,
    allowsNewLane: true,
    reason: null,
    sampledAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}
const OK_LOAD = sample()
const HIGH_LOAD = sample({ loadAvg1: 12, loadPerCore: 1.5, allowsNewLane: false, reason: 'load 1.50/core > 1.00' })
const LOW_MEM = sample({ memAvailableMb: 1024, allowsNewLane: false, reason: 'available memory 1024 MB < 2048 MB' })

/** A GitHub ticket fixture. A bar is present unless `bar: null`. */
function issue(
  n: number,
  opts: { bar?: string | null; blockedBy?: number[]; state?: LoopGhState; title?: string } = {},
): GhTicket {
  const bar = opts.bar === undefined ? `the hero on https://example.com/ref-${n}` : opts.bar
  return {
    number: n,
    title: opts.title ?? `Ticket ${n}`,
    body: bar ? `Build ticket ${n}.\n\nBar: ${bar}\n` : `Build ticket ${n}.\n`,
    url: `https://github.com/${SLUG}/issues/${n}`,
    state: opts.state ?? 'open',
    blockedBy: opts.blockedBy ?? [],
  }
}

// ---- harness -----------------------------------------------------------------

let root: string
let repoDir: string
let originDir: string
let dbDir: string
let db: Db
let runners: FakeRunner[]
let frames: WsEvent[]
let gh: FakeGitHub
let probe: FakeLoad
let scan: FakeScanRunner
let repo: RepoTarget
let loop: LoopManager
let managers: LoopManager[]
let tick: number
let fileSeq: number

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A working repo whose `origin` is a bare repo in the same temp root. */
function initRepos(): void {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-loop-')))
  originDir = path.join(root, 'origin.git')
  repoDir = path.join(root, 'repo')
  git(root, ['init', '-q', '--bare', '-b', 'main', originDir])
  git(root, ['init', '-q', '-b', 'main', repoDir])
  git(repoDir, ['config', 'user.email', 'test@example.com'])
  git(repoDir, ['config', 'user.name', 'zmrng test'])
  git(repoDir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(repoDir, 'README.md'), '# loop target\n')
  writeFileSync(path.join(repoDir, '.gitignore'), 'worktrees/\n')
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-q', '-m', 'init'])
  git(repoDir, ['remote', 'add', 'origin', originDir])
  git(repoDir, ['push', '-q', 'origin', 'main'])
  git(repoDir, ['fetch', '-q', 'origin'])
}

const factory: RunnerFactory = (opts, cb) => {
  const r = new FakeRunner(opts, cb)
  runners.push(r)
  return r
}

function makeLoop(over: Partial<LoopDeps> = {}): LoopManager {
  const m = new LoopManager(db, (e) => frames.push(e), {
    runnerFactory: factory,
    github: gh,
    load: probe,
    scanFactory: scan.factory,
    apiBase: API_BASE,
    pumpIntervalMs: 0,
    coalesceMs: 0,
    // Monotonic: run creation order is unambiguous (oldest-first pool fill).
    clock: () => new Date(Date.UTC(2026, 9, 1) + tick++ * 1000),
    random: RANDOM,
    repoLookup: (id) => (id === repo.id ? repo : undefined),
    slugOf: async () => SLUG,
    seed: async () => [],
    securityPolicy: () => POLICY,
    style: 'normal',
    ...over,
  })
  managers.push(m)
  return m
}

beforeEach(() => {
  initRepos()
  dbDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-loop-db-')))
  db = new Db(path.join(dbDir, 'loop.db'))
  runners = []
  frames = []
  gh = new FakeGitHub()
  gh.tickets = [issue(2), issue(3, { blockedBy: [2] })]
  probe = new FakeLoad()
  scan = new FakeScanRunner()
  repo = { id: 'sandbox', label: 'sandbox', path: repoDir, defaultBranch: 'main' }
  managers = []
  tick = 0
  fileSeq = 0
  loop = makeLoop()
})

afterEach(async () => {
  for (const m of managers) {
    await m.whenIdle()
    m.shutdown()
  }
  db.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

// ---- lookups -----------------------------------------------------------------

const run8 = (id: string): string => id.slice(0, 8)
const integDir = (id: string): string => path.join(repoDir, 'worktrees', `loop-${run8(id)}-integ`)
const ticketDir = (id: string, n: number): string => path.join(repoDir, 'worktrees', `loop-${run8(id)}-t${n}`)
const integBranch = (id: string): string => `gauntlet/${run8(id)}/integ`
const ticketBranch = (id: string, n: number): string => `gauntlet/${run8(id)}/t${n}`
const tk = (id: string, n: number) => db.getLoopTicket(id, n)!
const runOf = (id: string) => db.getLoopRun(id)!
const head = (dir: string): string => git(dir, ['rev-parse', 'HEAD'])

/** The orchestrator prompt carries the loopback curl cheat sheet; step prompts never do. */
const isOrch = (r: FakeRunner): boolean => r.opts.systemPrompt.includes(API_BASE)
const orchsOf = (id: string): FakeRunner[] => runners.filter((r) => isOrch(r) && r.opts.systemPrompt.includes(id))
const liveOrch = (id: string): FakeRunner | undefined => orchsOf(id).filter((r) => r.alive).at(-1)
const steps = (): FakeRunner[] => runners.filter((r) => !isOrch(r))
const liveSteps = (): FakeRunner[] => steps().filter((r) => r.alive)
/** Every non-orchestrator child spawned in the integ worktree (fold + final PR agents). */
const integRunners = (id: string): FakeRunner[] => steps().filter((r) => r.opts.cwd === integDir(id))
const foldRunners = (id: string): FakeRunner[] =>
  integRunners(id).filter((r) => r.opts.model === STEP_PROFILES.fold.model && r.opts.effort === STEP_PROFILES.fold.effort)

/** The single live step child of a ticket (builder/critic/validate/finish). */
function stepOf(id: string, n: number): FakeRunner {
  const live = liveSteps().filter((r) => r.opts.cwd === ticketDir(id, n))
  if (live.length !== 1) throw new Error(`expected one live step for #${n}, found ${live.length}`)
  return live[0]
}

/** The live fold child of a run. */
function liveFold(id: string): FakeRunner {
  const live = foldRunners(id).filter((r) => r.alive)
  if (live.length !== 1) throw new Error(`expected one live fold, found ${live.length}`)
  return live[0]
}

const chatEvents = (id: string): LoopEvent[] => db.listLoopEvents(id, { kind: 'chat' })
const chatTexts = (id: string): string[] => chatEvents(id).map((e) => e.payload.text ?? '')
const loopFrames = (id: string): LoopRunView[] =>
  frames.flatMap((f) => (f.type === 'loop' && f.run.run.id === id ? [f.run] : []))

/** The exact ctx the manager must hand every step prompt. */
function stepCtx(id: string, n: number): LoopStepCtx {
  const t = tk(id, n)
  return {
    repoSlug: SLUG,
    defaultBranch: 'main',
    integBranch: integBranch(id),
    ticketBranch: ticketBranch(id, n),
    ticket: { number: n, title: t.title, body: t.body, url: t.url, bar: t.bar ?? '', round: t.round, lastGap: t.lastGap },
    style: 'normal',
  }
}

function orchCtx(id: string): OrchestratorCtx {
  return {
    runId: id,
    repoId: 'sandbox',
    repoSlug: SLUG,
    defaultBranch: 'main',
    epic: 1,
    epicTitle: EPIC_TITLE,
    integBranch: integBranch(id),
    apiBase: API_BASE,
    style: 'normal',
  }
}

// ---- drivers -----------------------------------------------------------------

async function create(lanes = 1, mgr: LoopManager = loop): Promise<string> {
  const view = await mgr.createRun({ repoId: 'sandbox', epic: 1, lanes })
  await mgr.whenIdle()
  return view.run.id
}

async function started(lanes = 1): Promise<string> {
  const id = await create(lanes)
  await loop.start(id)
  await loop.whenIdle()
  return id
}

function commitFile(dir: string, name = `f${++fileSeq}.txt`): void {
  writeFileSync(path.join(dir, name), `content ${name}\n`)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', `add ${name}`])
}

/** Builder turn: a real commit in the ticket worktree, then BUILT. */
async function build(id: string, n: number): Promise<void> {
  const r = stepOf(id, n)
  commitFile(r.opts.cwd)
  r.turn('Built it.\nGAUNTLET_STATUS=BUILT')
  await loop.whenIdle()
}

/** Critic turn: pick our label (WIN) or theirs (LOSE) and name a gap. */
async function judge(id: string, n: number, win: boolean, gap = 'the hero contrast is weaker than the bar'): Promise<void> {
  stepOf(id, n).turn(`Compared both.\nGAUNTLET_VERDICT: ${win ? OURS : THEIRS}\nGAUNTLET_GAP: ${gap}`)
  await loop.whenIdle()
}

async function stepSays(id: string, n: number, line: string): Promise<void> {
  stepOf(id, n).turn(`Checked.\n${line}`)
  await loop.whenIdle()
}

/** builder → WIN → validate GREEN → finish GREEN: the ticket is now folding (or queued). */
async function toFold(id: string, n: number): Promise<void> {
  await build(id, n)
  await judge(id, n, true)
  await stepSays(id, n, 'GAUNTLET_STATUS=GREEN')
  await stepSays(id, n, 'GAUNTLET_STATUS=GREEN')
}

/** Fold turn: a REAL `git merge --no-ff` of the ticket branch into integ, then GREEN. */
async function fold(id: string, n: number): Promise<void> {
  const r = liveFold(id)
  git(r.opts.cwd, ['merge', '--no-ff', '-q', '-m', `Fold #${n}`, ticketBranch(id, n)])
  r.turn('Merged and the gate is green.\nGAUNTLET_STATUS=GREEN')
  await loop.whenIdle()
}

async function toDone(id: string, n: number): Promise<void> {
  await toFold(id, n)
  await fold(id, n)
}

/** Restart: the old manager's process "dies"; a fresh one opens the same DB. */
async function restart(): Promise<void> {
  await loop.whenIdle()
  loop.shutdown()
  loop = makeLoop()
  loop.reconcileOrphans()
}

// ---- scenarios ---------------------------------------------------------------

describe('LoopManager — creation (scenario 1)', () => {
  it('fetches the map, cuts the integ branch + worktree, spawns the orchestrator, and leaves the run in draft', async () => {
    gh.tickets = [
      issue(2),
      issue(3, { blockedBy: [2] }),
      issue(4, { state: 'closed' }),
      issue(5, { blockedBy: [90] }),
      issue(6, { blockedBy: [91] }),
    ]
    gh.external = { 90: 'closed', 91: 'open' }
    const view = await loop.createRun({ repoId: 'sandbox', epic: 1 })
    await loop.whenIdle()
    const id = view.run.id

    expect(view.run).toMatchObject({
      status: 'draft',
      lanes: 1,
      epic: 1,
      title: EPIC_TITLE,
      integBranch: integBranch(id),
      integWorktree: integDir(id),
    })
    // The integration branch is a real worktree cut from origin/main.
    expect(existsSync(integDir(id))).toBe(true)
    expect(git(integDir(id), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(integBranch(id))
    expect(head(integDir(id))).toBe(git(repoDir, ['rev-parse', 'origin/main']))

    // Closed → done; open blocker → blocked; closed external blocker stripped;
    // open external blocker kept (and therefore blocking).
    const states = Object.fromEntries(view.tickets.map((t) => [t.number, t.state]))
    expect(states).toEqual({ 2: 'todo', 3: 'blocked', 4: 'done', 5: 'todo', 6: 'blocked' })
    expect(tk(id, 5).blockedBy).toEqual([])
    expect(tk(id, 6).blockedBy).toEqual([91])
    expect(tk(id, 2).bar).toContain('https://example.com/ref-2')

    // One orchestrator, in the integ worktree, with the plain (no-recap) kickoff.
    const orchs = orchsOf(id)
    expect(orchs).toHaveLength(1)
    expect(orchs[0].opts).toMatchObject({
      cwd: integDir(id),
      model: STEP_PROFILES.orchestrator.model,
      effort: STEP_PROFILES.orchestrator.effort,
    })
    expect(orchs[0].sent).toEqual([orchestratorKickoff(orchCtx(id))])
    expect(view.orchestratorAlive).toBe(true)
    expect(view.orchestratorBusy).toBe(true)
    // Draft: nothing is picked.
    expect(steps()).toHaveLength(0)
    expect(view.pool).toEqual({ used: 0, max: 3 })
    expect(db.listLoopEvents(id, { kind: 'status' }).length).toBeGreaterThan(0)
    expect(loopFrames(id).length).toBeGreaterThan(0)
    expect(gh.calls).toEqual([`map ${SLUG} #1`])
  })

  it('rejects a repo without a GitHub slug (400), an unknown repo (400) and a failed fetch (502), persisting nothing', async () => {
    const noSlug = makeLoop({ slugOf: async () => null })
    const err = await noSlug.createRun({ repoId: 'sandbox', epic: 1 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LoopError)
    expect(err).toMatchObject({ status: 400 })
    await expect(loop.createRun({ repoId: 'nope', epic: 1 })).rejects.toMatchObject({ status: 400 })
    await expect(loop.createRun({ repoId: 'sandbox', epic: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(loop.createRun({ repoId: 'sandbox', epic: 1, lanes: 4 })).rejects.toMatchObject({ status: 400 })
    gh.fail = true
    await expect(loop.createRun({ repoId: 'sandbox', epic: 1 })).rejects.toMatchObject({ status: 502 })
    expect(db.listLoopRuns()).toHaveLength(0)
    expect(runners).toHaveLength(0)
    expect(() => loop.view('missing')).toThrow(LoopError)
  })
})

describe('LoopManager — picking and the builder (scenarios 2-3)', () => {
  it('start picks a frontier ticket off the integ TIP and spawns an opus builder there; a blocked ticket is not picked', async () => {
    const id = await create(3)
    // Advance integ past origin/main, as an earlier fold would.
    commitFile(integDir(id), 'earlier-fold.txt')
    const integTip = head(integDir(id))

    await loop.start(id)
    await loop.whenIdle()

    expect(tk(id, 2)).toMatchObject({
      state: 'executing',
      step: 'builder',
      round: 1,
      branch: ticketBranch(id, 2),
      worktree: ticketDir(id, 2),
    })
    expect(tk(id, 2).startedAt).not.toBeNull()
    expect(tk(id, 3).state).toBe('blocked')
    expect(head(ticketDir(id, 2))).toBe(integTip)

    const b = stepOf(id, 2)
    expect(STEP_PROFILES.builder).toEqual({ model: 'opus', effort: 'high' })
    expect(b.opts).toMatchObject({ cwd: ticketDir(id, 2), model: 'opus', effort: 'high' })
    expect(b.opts.systemPrompt).toBe(builderPrompt(stepCtx(id, 2)).system)
    expect(b.sent).toEqual([builderPrompt(stepCtx(id, 2)).kickoff])
    expect(steps()).toHaveLength(1)

    const view = loop.view(id)
    expect(view.pool).toEqual({ used: 1, max: 3 })
    expect(view.lanes).toEqual([
      expect.objectContaining({ ticket: 2, step: 'builder', model: 'opus', effort: 'high', waiting: false }),
    ])
  })

  it('BUILT on a clean, advanced tree hands off to a FRESH critic; a dirty tree gets a nudge instead', async () => {
    const id = await started()
    const b = stepOf(id, 2)

    writeFileSync(path.join(b.opts.cwd, 'wip.txt'), 'uncommitted\n')
    b.turn('Done.\nGAUNTLET_STATUS=BUILT')
    await loop.whenIdle()
    expect(b.killed).toBe(false)
    expect(b.sent).toHaveLength(2)
    expect(b.sent[1]).toMatch(/commit all your work/i)
    expect(tk(id, 2).state).toBe('executing')
    expect(liveSteps()).toEqual([b])

    git(b.opts.cwd, ['add', '-A'])
    git(b.opts.cwd, ['commit', '-q', '-m', 'wip'])
    b.turn('Committed.\nGAUNTLET_STATUS=BUILT')
    await loop.whenIdle()

    expect(b.killed).toBe(true)
    const c = stepOf(id, 2)
    expect(c).not.toBe(b)
    expect(tk(id, 2)).toMatchObject({ state: 'reviewing', step: 'critic' })
    expect(c.opts).toMatchObject({ model: STEP_PROFILES.critic.model, effort: STEP_PROFILES.critic.effort })
    const baseSha = git(c.opts.cwd, ['merge-base', 'HEAD', integBranch(id)])
    expect(c.sent).toEqual([criticPrompt(stepCtx(id, 2), OURS, baseSha).kickoff])

    // A late callback from the accepted (killed) builder is inert.
    b.exit(1)
    b.turn('GAUNTLET_STATUS=BUILT')
    await loop.whenIdle()
    expect(tk(id, 2).state).toBe('reviewing')
    expect(stepOf(id, 2)).toBe(c)
  })

  it('BUILT with no new commit is nudged too (HEAD must advance)', async () => {
    const id = await started()
    const b = stepOf(id, 2)
    b.turn('GAUNTLET_STATUS=BUILT')
    await loop.whenIdle()
    expect(b.killed).toBe(false)
    expect(b.sent[1]).toMatch(/commit all your work/i)
    expect(tk(id, 2).state).toBe('executing')
  })

  it('tool calls become lane activity events and usage accumulates', async () => {
    const id = await started()
    const b = stepOf(id, 2)
    b.toolUse('Bash', 'npm test')
    expect(loop.view(id).lanes[0].activity).toBe('npm test')
    expect(db.listLoopEvents(id, { kind: 'activity' })).toEqual([
      expect.objectContaining({ ticket: 2, payload: { tool: 'Bash', summary: 'npm test', step: 'builder' } }),
    ])
    expect(frames.some((f) => f.type === 'loop-event' && f.event.kind === 'activity')).toBe(true)
    b.say('Polishing the hero spacing now.')
    expect(loop.view(id).lanes[0].activity).toBe('Polishing the hero spacing now.')

    b.result('', false, { tokensIn: 100, tokensOut: 40, tokensCache: 7, costUsd: 0.5, turns: 2 })
    await loop.whenIdle()
    expect(tk(id, 2).usage).toMatchObject({ tokensIn: 100, tokensOut: 40 })
    expect(runOf(id).usage).toMatchObject({ tokensIn: 100, tokensOut: 40 })
  })
})

describe('LoopManager — the gauntlet (scenario 4)', () => {
  it('a LOSE feeds the gap into the next builder (round 2); a WIN runs validate → finish → fold', async () => {
    const id = await started()
    await build(id, 2)
    await judge(id, 2, false, 'the hero copy is vaguer than the bar')

    const b2 = stepOf(id, 2)
    expect(tk(id, 2)).toMatchObject({
      state: 'executing',
      step: 'builder',
      round: 2,
      lastGap: 'the hero copy is vaguer than the bar',
    })
    expect(b2.sent).toEqual([builderPrompt(stepCtx(id, 2)).kickoff])
    expect(b2.sent[0]).toContain('the hero copy is vaguer than the bar')
    expect(chatTexts(id)).toContain('[#2] LOSE round 1: the hero copy is vaguer than the bar')

    await build(id, 2)
    await judge(id, 2, true)
    expect(chatTexts(id)).toContain('[#2] WIN round 2')
    const v = stepOf(id, 2)
    expect(tk(id, 2)).toMatchObject({ state: 'validating', step: 'validate' })
    expect(v.opts).toMatchObject({ model: STEP_PROFILES.validate.model, effort: STEP_PROFILES.validate.effort })
    expect(v.sent).toEqual([validatePrompt(stepCtx(id, 2)).kickoff])

    await stepSays(id, 2, 'GAUNTLET_STATUS=GREEN')
    expect(tk(id, 2)).toMatchObject({ state: 'finishing', step: 'finish' })
    await stepSays(id, 2, 'GAUNTLET_STATUS=GREEN')

    expect(tk(id, 2)).toMatchObject({ state: 'folding', step: 'fold' })
    const f = liveFold(id)
    expect(f.opts).toMatchObject({
      cwd: integDir(id),
      model: STEP_PROFILES.fold.model,
      effort: STEP_PROFILES.fold.effort,
    })
    expect(f.sent).toEqual([foldPrompt(stepCtx(id, 2), integDir(id)).kickoff])
    // The ticket's lane is held all the way through the fold.
    expect(loop.view(id).pool.used).toBe(1)
  })

  it('a validation RED and a docs-sync RED are losses carrying the reason as the gap', async () => {
    const id = await started()
    await build(id, 2)
    await judge(id, 2, true)
    await stepSays(id, 2, 'GAUNTLET_STATUS=RED typecheck fails in hero.tsx')
    expect(tk(id, 2)).toMatchObject({
      state: 'executing',
      round: 2,
      lastGap: 'validation failed: typecheck fails in hero.tsx',
    })

    await build(id, 2)
    await judge(id, 2, true)
    await stepSays(id, 2, 'GAUNTLET_STATUS=GREEN')
    await stepSays(id, 2, 'GAUNTLET_STATUS=RED the README still documents the old hero')
    expect(tk(id, 2)).toMatchObject({
      state: 'executing',
      round: 3,
      lastGap: 'docs sync failed: the README still documents the old hero',
    })
  })
})

describe('LoopManager — folding (scenario 5)', () => {
  it('a real merge passes the ancestor check, integ is pushed to origin, the ticket is done, its worktree removed, and the dependent is picked', async () => {
    const id = await started()
    await toFold(id, 2)
    const f = liveFold(id)
    await fold(id, 2)

    const integHead = head(integDir(id))
    expect(tk(id, 2)).toMatchObject({ state: 'done', foldSha: integHead, worktree: null })
    expect(existsSync(ticketDir(id, 2))).toBe(false)
    expect(f.killed).toBe(true)
    // The ticket branch is kept; integ landed on the bare origin at the fold sha.
    expect(git(repoDir, ['rev-parse', '--verify', '--quiet', ticketBranch(id, 2)])).not.toBe('')
    expect(git(root, ['--git-dir', originDir, 'rev-parse', integBranch(id)])).toBe(integHead)
    expect(chatTexts(id)).toContain(`[#2] done (folded at ${integHead.slice(0, 7)})`)

    // The dependent (#3, blocked by #2) is now picked, off the new integ tip.
    expect(tk(id, 3)).toMatchObject({ state: 'executing', step: 'builder' })
    expect(head(ticketDir(id, 3))).toBe(integHead)
    expect(loop.view(id).pool.used).toBe(1)
  })

  it('a fold that claims GREEN without merging is nudged once, then parks needs-human', async () => {
    const id = await started()
    await toFold(id, 2)
    const f = liveFold(id)
    f.turn('GAUNTLET_STATUS=GREEN')
    await loop.whenIdle()
    expect(f.killed).toBe(false)
    expect(f.sent).toHaveLength(2)
    expect(tk(id, 2).state).toBe('folding')

    f.turn('GAUNTLET_STATUS=GREEN')
    await loop.whenIdle()
    expect(f.killed).toBe(true)
    expect(tk(id, 2).state).toBe('needs-human')
    expect(tk(id, 2).note).toMatch(/fold not verified/)
    expect(loop.view(id).pool.used).toBe(0)
  })

  it('a fold RED aborts the merge and parks needs-human; the next queued fold may then start', async () => {
    gh.tickets = [issue(2), issue(5)]
    const id = await started(2)
    await toFold(id, 2)
    await toFold(id, 5)
    const f = liveFold(id)
    f.turn('GAUNTLET_STATUS=RED merge conflict in hero.tsx')
    await loop.whenIdle()
    expect(tk(id, 2)).toMatchObject({ state: 'needs-human', note: 'fold failed: merge conflict in hero.tsx' })
    // The mutex passed to #5.
    const next = liveFold(id)
    expect(next).not.toBe(f)
    expect(next.sent).toEqual([foldPrompt(stepCtx(id, 5), integDir(id)).kickoff])
  })

  it('a failed integ push is recorded (note + error event + orchestrator) but the ticket still completes', async () => {
    const id = await started()
    git(repoDir, ['remote', 'set-url', 'origin', path.join(root, 'missing.git')])
    await toDone(id, 2)
    expect(tk(id, 2).state).toBe('done')
    expect(runOf(id).note).toMatch(/^integ push failed/)
    expect(db.listLoopEvents(id, { kind: 'error' }).some((e) => /integ push failed/.test(e.payload.text ?? ''))).toBe(true)
    expect(chatTexts(id).some((t) => t.startsWith('integ push failed'))).toBe(true)
  })
})

describe('LoopManager — the fold mutex (scenario 6)', () => {
  it('folds serially; stopping a queued ticket dequeues it; a duplicate settle starts nothing', async () => {
    gh.tickets = [issue(2), issue(3), issue(5)]
    const id = await started(3)
    await toFold(id, 2)
    await toFold(id, 3)
    await toFold(id, 5)

    // Only #2 folds; #3 and #5 wait on the mutex, still holding their lanes.
    expect(foldRunners(id)).toHaveLength(1)
    expect(liveFold(id).sent).toEqual([foldPrompt(stepCtx(id, 2), integDir(id)).kickoff])
    expect(tk(id, 3).state).toBe('folding')
    expect(tk(id, 5).state).toBe('folding')
    expect(loop.view(id).pool.used).toBe(3)

    // Stopping the queued #3 removes it from the queue without touching #2's fold.
    await loop.stopTicket(id, 3)
    await loop.whenIdle()
    expect(tk(id, 3).state).toBe('todo')
    expect(foldRunners(id)).toHaveLength(1)
    expect(liveFold(id).killed).toBe(false)
    expect(loop.view(id).pool.used).toBe(2)

    // #2's fold completes → the NEXT queued (#5) folds, not the stopped #3.
    await fold(id, 2)
    expect(tk(id, 2).state).toBe('done')
    expect(foldRunners(id)).toHaveLength(2)
    expect(liveFold(id).sent).toEqual([foldPrompt(stepCtx(id, 5), integDir(id)).kickoff])

    // A duplicate settle for the already-finished #2 fold is inert.
    const internals = loop as unknown as { onFoldSettled(runId: string, n: number): void }
    internals.onFoldSettled(id, 2)
    await loop.whenIdle()
    expect(foldRunners(id)).toHaveLength(2)
    expect(tk(id, 5).state).toBe('folding')
  })

  it('a ticket queued on the fold mutex still shows as a lane (every held slot is a lane card)', async () => {
    gh.tickets = [issue(2), issue(3)]
    const id = await started(2)
    await toFold(id, 2)
    await toFold(id, 3)

    const view = loop.view(id)
    expect(view.pool.used).toBe(2)
    expect(view.lanes.map((l) => l.ticket)).toEqual([2, 3])
    const queued = view.lanes.find((l) => l.ticket === 3)
    expect(queued?.step).toBe('fold')
    expect(queued?.waiting).toBe(false)
    expect(queued?.activity).toMatch(/queued/i)
    // The live fold keeps its own activity, not the queued placeholder.
    expect(view.lanes.find((l) => l.ticket === 2)?.activity).not.toMatch(/queued/i)
  })
})

describe('LoopManager — the round fuse (scenario 7)', () => {
  it('six losses park the ticket needs-human, release the lane, and notify the orchestrator', async () => {
    const id = await started()
    for (let r = 1; r <= 6; r++) {
      expect(tk(id, 2).round).toBe(r)
      await build(id, 2)
      await judge(id, 2, false, `gap ${r}`)
    }
    expect(tk(id, 2)).toMatchObject({
      state: 'needs-human',
      round: 6,
      lastGap: 'gap 6',
      note: 'lost 6 rounds; last gap: gap 6',
    })
    expect(liveSteps()).toHaveLength(0)
    expect(loop.view(id).pool.used).toBe(0)
    expect(chatTexts(id)).toContain('[#2] needs-human: lost 6 rounds; last gap: gap 6')

    // retry: back to todo with the rounds reset, and picked again.
    await loop.retryTicket(id, 2)
    await loop.whenIdle()
    expect(tk(id, 2)).toMatchObject({ state: 'executing', round: 1, lastGap: null, note: null })
    await expect(loop.retryTicket(id, 2)).rejects.toMatchObject({ status: 409 })
  })
})

describe('LoopManager — questions (scenario 8)', () => {
  it('a question parks the lane waiting, queues for the busy orchestrator, flushes on idle, and the answer goes into the same runner', async () => {
    const id = await started()
    const orch = liveOrch(id)!
    expect(orch.sent).toHaveLength(1) // the kickoff; still mid-turn (busy)
    const b = stepOf(id, 2)

    b.turn('GAUNTLET_QUESTION: Which brand font should the hero use?')
    await loop.whenIdle()
    expect(tk(id, 2)).toMatchObject({ state: 'waiting', question: 'Which brand font should the hero use?' })
    expect(b.killed).toBe(false)
    expect(loop.view(id).lanes).toEqual([expect.objectContaining({ ticket: 2, waiting: true })])
    expect(loop.view(id).pool.used).toBe(1)
    expect(orch.sent).toHaveLength(1) // never sent into a busy orchestrator

    orch.result('Hello — reading the map.')
    await loop.whenIdle()
    expect(orch.sent).toHaveLength(2)
    expect(orch.sent[1]).toBe('[loop event]\n- [#2] question: Which brand font should the hero use?')

    await loop.answer(id, 2, 'Use Inter.')
    expect(stepOf(id, 2)).toBe(b)
    expect(b.sent[b.sent.length - 1]).toBe('Use Inter.')
    expect(tk(id, 2)).toMatchObject({ state: 'executing', question: null })
    expect(loop.view(id).lanes[0].waiting).toBe(false)
    await expect(loop.answer(id, 2, 'again')).rejects.toMatchObject({ status: 409 })

    // The same runner carries on to BUILT.
    await build(id, 2)
    expect(tk(id, 2).state).toBe('reviewing')
  })
})

describe('LoopManager — step failures (scenario 9)', () => {
  it('a critic that dirties the tree parks needs-human (read-only)', async () => {
    const id = await started()
    await build(id, 2)
    const c = stepOf(id, 2)
    writeFileSync(path.join(c.opts.cwd, 'scratch.txt'), 'critic notes\n')
    c.turn(`GAUNTLET_VERDICT: ${OURS}\nGAUNTLET_GAP: none`)
    await loop.whenIdle()
    expect(tk(id, 2)).toMatchObject({
      state: 'needs-human',
      note: 'critic modified the worktree (read-only violation)',
    })
    expect(c.killed).toBe(true)
  })

  it('a step that misses its token twice parks needs-human after exactly one nudge', async () => {
    const id = await started()
    const b = stepOf(id, 2)
    b.turn('I think I am done here.')
    await loop.whenIdle()
    expect(b.sent).toHaveLength(2)
    expect(b.sent[1]).toContain('GAUNTLET_STATUS=BUILT')
    expect(tk(id, 2).state).toBe('executing')

    b.turn('Still done.')
    await loop.whenIdle()
    expect(b.killed).toBe(true)
    expect(tk(id, 2)).toMatchObject({ state: 'needs-human', note: 'no GAUNTLET status after a nudge' })
    expect(loop.view(id).pool.used).toBe(0)
    expect(chatTexts(id)).toContain('[#2] needs-human: no GAUNTLET status after a nudge')
  })

  it('an error result counts as a miss; an unexpected exit parks needs-human', async () => {
    const id = await started()
    const b = stepOf(id, 2)
    b.result('rate limited', true)
    await loop.whenIdle()
    expect(b.sent).toHaveLength(2)
    b.exit(137)
    await loop.whenIdle()
    expect(tk(id, 2)).toMatchObject({ state: 'needs-human', note: 'step exited unexpectedly (code 137)' })
    expect(loop.view(id).pool.used).toBe(0)
  })
})

describe('LoopManager — the global lane pool (scenario 10)', () => {
  it('holds at most 3 lanes across runs, fills the older run first, re-picks on release, and lanes 0 picks nothing new', async () => {
    gh.tickets = [issue(11), issue(12), issue(13), issue(14)]
    const a = await create(3)
    gh.tickets = [issue(21), issue(22), issue(23)]
    const b = await create(3)

    // Start the NEWER run first, with the gate closed, so neither picks yet.
    probe.next = HIGH_LOAD
    await loop.start(b)
    await loop.start(a)
    await loop.whenIdle()
    expect(loop.view(a).pool.used).toBe(0)

    // One pump with the gate open: the OLDER run fills the whole pool.
    probe.next = OK_LOAD
    await loop.pump()
    await loop.whenIdle()
    const held = (id: string, ns: number[]): number[] => ns.filter((n) => tk(id, n).state === 'executing')
    expect(held(a, [11, 12, 13, 14])).toEqual([11, 12, 13])
    expect(held(b, [21, 22, 23])).toEqual([])
    expect(loop.view(a).pool).toEqual({ used: 3, max: 3 })

    // Lanes 0: in-flight steps keep running, but A picks nothing new.
    await loop.setLanes(a, 0)
    await loop.whenIdle()
    const a12 = stepOf(a, 12)
    const a13 = stepOf(a, 13)
    expect(loop.view(a).pool.used).toBe(3)

    // Releasing one of A's lanes → the pump hands it to B (A is at lanes 0).
    await loop.skipTicket(a, 11)
    await loop.whenIdle()
    expect(tk(a, 11).state).toBe('skipped')
    expect(tk(a, 14).state).toBe('todo')
    expect(held(b, [21, 22, 23])).toEqual([21])
    expect(a12.killed).toBe(false)
    expect(a13.killed).toBe(false)
    expect(loop.view(b).pool).toEqual({ used: 3, max: 3 })

    // The cap was never exceeded in any broadcast view.
    const seen = frames.flatMap((f) => (f.type === 'loop' ? [f.run.pool.used] : []))
    expect(Math.max(...seen)).toBeLessThanOrEqual(3)
  })

  it('never constructs a TaskManager: the Loop pool does not consult the task lane pool', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    expect(self).not.toMatch(/new\s+TaskManager\b/)
    const loopSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/loop.ts'), 'utf8')
    expect(loopSrc).not.toMatch(/\bTaskManager\b/)
    expect(loopSrc).not.toMatch(/config\.maxLanes/)
  })
})

describe('LoopManager — stop and pause (scenario 11)', () => {
  it('stopTicket kills the step, releases the lane with no immediate re-pick, and the re-pick reuses the worktree', async () => {
    gh.tickets = [issue(2), issue(5)]
    const id = await started()
    const b = stepOf(id, 2)
    commitFile(b.opts.cwd, 'partial.txt')
    const partial = head(b.opts.cwd)

    await loop.stopTicket(id, 2)
    await loop.whenIdle()
    expect(b.killed).toBe(true)
    expect(tk(id, 2)).toMatchObject({ state: 'todo', round: 1, worktree: ticketDir(id, 2) })
    expect(existsSync(ticketDir(id, 2))).toBe(true)
    expect(loop.view(id).pool.used).toBe(0)
    expect(liveSteps()).toHaveLength(0)

    await loop.pump()
    await loop.whenIdle()
    expect(tk(id, 2)).toMatchObject({ state: 'executing', round: 1 })
    expect(head(ticketDir(id, 2))).toBe(partial)
    expect(stepOf(id, 2)).not.toBe(b)
    await expect(loop.stopTicket(id, 5)).rejects.toMatchObject({ status: 409 })
    await expect(loop.stopTicket(id, 99)).rejects.toMatchObject({ status: 404 })
  })

  it('pause lets in-flight steps finish but picks nothing new until start', async () => {
    gh.tickets = [issue(2), issue(5), issue(6)]
    const id = await started(2)
    expect(tk(id, 2).state).toBe('executing')
    expect(tk(id, 5).state).toBe('executing')

    await loop.pause(id)
    expect(runOf(id).status).toBe('paused')
    await build(id, 2) // in-flight work carries on
    expect(tk(id, 2).state).toBe('reviewing')

    await loop.stopTicket(id, 5)
    await loop.pump()
    await loop.whenIdle()
    expect(tk(id, 5).state).toBe('todo')
    expect(tk(id, 6).state).toBe('todo')
    expect(loop.view(id).pool.used).toBe(1)

    await loop.start(id)
    await loop.whenIdle()
    expect(runOf(id).status).toBe('running')
    expect(tk(id, 5).state).toBe('executing')
    expect(loop.view(id).pool.used).toBe(2)
  })
})

describe('LoopManager — finalize (scenario 12)', () => {
  it('all done → green scan → final PR agent → our PR url → complete; the orchestrator is killed', async () => {
    gh.tickets = [issue(2)]
    scan.green()
    const id = await started()
    const orch = liveOrch(id)!
    await toDone(id, 2)

    expect(scan.requests).toEqual([{ worktree: integDir(id), baseRef: 'main', policy: POLICY, sast: true }])
    expect(runOf(id).status).toBe('finalizing')
    const fin = integRunners(id).filter((r) => !r.killed)
    expect(fin).toHaveLength(1)
    const expected = finalPrKickoff({
      repoSlug: SLUG,
      defaultBranch: 'main',
      integBranch: integBranch(id),
      epic: 1,
      epicTitle: EPIC_TITLE,
      done: [{ number: 2, title: 'Ticket 2' }],
      style: 'normal',
    })
    expect(fin[0].opts).toMatchObject({
      cwd: integDir(id),
      model: STEP_PROFILES.final.model,
      effort: STEP_PROFILES.final.effort,
      systemPrompt: expected.system,
    })
    expect(fin[0].sent).toEqual([expected.kickoff])

    // Another repo's PR url is not ours.
    fin[0].turn('See https://github.com/someone/else/pull/3 for prior art.')
    await loop.whenIdle()
    expect(runOf(id).status).toBe('finalizing')
    fin[0].turn('Opened https://github.com/owner/repo/pull/42')
    await loop.whenIdle()

    expect(runOf(id)).toMatchObject({ status: 'complete', prUrl: 'https://github.com/owner/repo/pull/42' })
    expect(fin[0].killed).toBe(true)
    expect(orch.killed).toBe(true)
    expect(loop.view(id).orchestratorAlive).toBe(false)
  })

  it('a red scan blocks the run fail-closed and relays the findings; start re-scans', async () => {
    gh.tickets = [issue(2)]
    scan.red()
    const id = await started()
    await toDone(id, 2)
    expect(runOf(id).status).toBe('blocked')
    expect(runOf(id).note).toMatch(/security scan red — 1 blocking finding/)
    expect(integRunners(id)).toHaveLength(1) // the fold only — no final PR agent
    expect(chatTexts(id).some((t) => t.includes('GHSA-jf85-cpcp-j695'))).toBe(true)

    scan.green()
    await loop.start(id)
    await loop.whenIdle()
    expect(runOf(id).status).toBe('finalizing')
    expect(scan.requests).toHaveLength(2)
    expect(integRunners(id).filter((r) => !r.killed)).toHaveLength(1)
  })

  it.each([
    ['a scanner crash', (s: FakeScanRunner) => s.fail(new Error('semgrep segfault')), /fail-closed/],
    ['unparseable output', (s: FakeScanRunner) => s.raw({ semgrep: 'not json', osv: '', toolVersions: {} }), /unparseable/],
    ['missing scanners', (s: FakeScanRunner) => s.fail(new ScannerUnavailableError('install semgrep')), /cannot run/],
  ])('%s blocks the run (never a pass)', async (_label, script, note) => {
    gh.tickets = [issue(2)]
    script(scan)
    const id = await started()
    await toDone(id, 2)
    expect(runOf(id).status).toBe('blocked')
    expect(runOf(id).note).toMatch(note)
    expect(integRunners(id)).toHaveLength(1)
  })

  it('a repo that opts out of the gate goes straight to the final PR', async () => {
    gh.tickets = [issue(2)]
    loop = makeLoop({ securityPolicy: () => ({ ...POLICY, enabled: false }) })
    const id = await started()
    await toDone(id, 2)
    expect(scan.requests).toHaveLength(0)
    expect(runOf(id).status).toBe('finalizing')
    expect(integRunners(id).filter((r) => !r.killed)).toHaveLength(1)
  })

  it('a ticket added while the final scan runs reopens the run: the scan result is ignored, no PR agent spawns', async () => {
    gh.tickets = [issue(2)]
    gh.extra = [issue(9)]
    const id = await started()
    scan.run(async () => {
      expect(runOf(id).status).toBe('finalizing')
      await loop.addTicket(id, 9)
      return GREEN_SCAN
    })
    await toDone(id, 2)

    expect(scan.requests).toHaveLength(1)
    expect(runOf(id).status).toBe('running')
    expect(runOf(id).note).toMatch(/finalize cancelled/)
    expect(integRunners(id).filter((r) => r.alive)).toHaveLength(0)
    expect(tk(id, 9).state).toBe('executing')
  })

  it('skipping the last open ticket returns at once; the final scan runs in the background', async () => {
    gh.tickets = [issue(2), issue(5)]
    const id = await started(2)
    await toDone(id, 2)
    expect(runOf(id).status).toBe('running')

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    scan.run(async () => {
      await gate
      return GREEN_SCAN
    })
    const view = await loop.skipTicket(id, 5) // must not wait out the scan
    expect(view.run.status).toBe('finalizing')
    expect(scan.requests).toHaveLength(1)
    release()
    await loop.whenIdle()
    expect(integRunners(id).filter((r) => r.alive)).toHaveLength(1)
  })

  it('a final PR agent that prints no PR url is nudged once, then blocks the run', async () => {
    gh.tickets = [issue(2)]
    scan.green()
    const id = await started()
    await toDone(id, 2)
    const fin = integRunners(id).filter((r) => !r.killed)[0]
    fin.turn('All set.')
    await loop.whenIdle()
    expect(fin.sent).toHaveLength(2)
    expect(runOf(id).status).toBe('finalizing')
    fin.turn('Done.')
    await loop.whenIdle()
    expect(runOf(id).status).toBe('blocked')
    expect(fin.killed).toBe(true)
  })
})

describe('LoopManager — restart (scenario 13)', () => {
  it('reconcileOrphans marks the run stale; resume respawns the orchestrator with a recap and re-runs the step FRESH', async () => {
    const id = await started()
    await build(id, 2)
    const oldCritic = stepOf(id, 2)
    const built = head(ticketDir(id, 2))
    await restart()
    expect(runOf(id)).toMatchObject({ status: 'stale', prevStatus: 'running' })
    await expect(loop.start(id)).rejects.toMatchObject({ status: 409 })

    // The worktree dir vanished while the app was down: resume recreates it.
    rmSync(ticketDir(id, 2), { recursive: true, force: true })

    await loop.resume(id)
    await loop.whenIdle()
    expect(runOf(id)).toMatchObject({ status: 'running', prevStatus: null })

    const orch = liveOrch(id)!
    expect(orch).toBeDefined()
    expect(orch.sent[0]).not.toBe(orchestratorKickoff(orchCtx(id)))
    expect(orch.sent[0]).toContain(integBranch(id))

    const critic = stepOf(id, 2)
    expect(critic).not.toBe(oldCritic)
    expect(critic.opts).toMatchObject({ cwd: ticketDir(id, 2), model: STEP_PROFILES.critic.model })
    expect(tk(id, 2)).toMatchObject({ state: 'reviewing', step: 'critic' })
    expect(head(ticketDir(id, 2))).toBe(built)
    expect(loop.view(id).pool.used).toBe(1)
    await expect(loop.resume(id)).rejects.toMatchObject({ status: 409 })
  })

  it('a full pool sends resumed in-flight tickets back to todo (never over the cap)', async () => {
    gh.tickets = [issue(2), issue(5)]
    const a = await started(2)
    await restart()

    gh.tickets = [issue(31), issue(32), issue(33)]
    const b = await create(3)
    await loop.start(b)
    await loop.whenIdle()
    expect(loop.view(b).pool.used).toBe(3)

    await loop.resume(a)
    await loop.whenIdle()
    expect(tk(a, 2).state).toBe('todo')
    expect(tk(a, 5).state).toBe('todo')
    expect(loop.view(a).pool.used).toBe(3)
    expect(liveSteps().filter((r) => r.opts.cwd.includes(`loop-${run8(a)}-`))).toHaveLength(0)
  })

  it('two tickets persisted in folding re-fold serially after resume', async () => {
    gh.tickets = [issue(2), issue(5)]
    const id = await started(2)
    await toFold(id, 2)
    await toFold(id, 5)
    await restart()
    await loop.resume(id)
    await loop.whenIdle()

    const live = foldRunners(id).filter((r) => !r.killed)
    expect(live).toHaveLength(1)
    expect(live[0].sent).toEqual([foldPrompt(stepCtx(id, 2), integDir(id)).kickoff])
    expect(tk(id, 5).state).toBe('folding')
    expect(loop.view(id).pool.used).toBe(2)

    await fold(id, 2)
    expect(liveFold(id).sent).toEqual([foldPrompt(stepCtx(id, 5), integDir(id)).kickoff])
    await fold(id, 5)
    expect(tk(id, 2).state).toBe('done')
    expect(tk(id, 5).state).toBe('done')
  })
})

describe('LoopManager — archive (scenario 14)', () => {
  it('kills every runner, releases every lane, removes the worktrees, and broadcasts loop-removed', async () => {
    gh.tickets = [issue(2), issue(5)]
    const id = await started(2)
    const live = liveSteps()
    const orch = liveOrch(id)!
    expect(live).toHaveLength(2)

    await loop.archive(id)
    await loop.whenIdle()
    expect(live.every((r) => r.killed)).toBe(true)
    expect(orch.killed).toBe(true)
    expect(loop.view(id).pool.used).toBe(0)
    expect(existsSync(ticketDir(id, 2))).toBe(false)
    expect(existsSync(ticketDir(id, 5))).toBe(false)
    expect(existsSync(integDir(id))).toBe(false)
    expect(runOf(id)).toMatchObject({ status: 'archived', integWorktree: null })
    expect([tk(id, 2).state, tk(id, 5).state]).toEqual(['todo', 'todo'])
    expect(frames).toContainEqual({ type: 'loop-removed', runId: id })
    // Branches are never deleted.
    expect(git(repoDir, ['rev-parse', '--verify', '--quiet', integBranch(id)])).not.toBe('')
    await expect(loop.start(id)).rejects.toMatchObject({ status: 409 })
    await expect(loop.chat(id, 'hello?')).rejects.toMatchObject({ status: 409 })
    expect(loop.listRuns().map((r) => r.id)).toEqual([id])
  })
})

describe('LoopManager — the orchestrator (scenarios 15, 16, 19)', () => {
  it('coalesces loop events while busy into ONE [loop event] message; an idle event is sent at once', async () => {
    gh.tickets = [issue(2), issue(5, { bar: null }), issue(6, { bar: null }), issue(7, { bar: null })]
    const id = await create()
    const orch = liveOrch(id)!
    await loop.start(id)
    await loop.whenIdle()

    // Three barless tickets parked while the orchestrator was mid-turn: zero sends.
    expect(['5', '6', '7'].map((n) => tk(id, Number(n)).state)).toEqual(['needs-human', 'needs-human', 'needs-human'])
    expect(orch.sent).toHaveLength(1)

    orch.result('Hello operator.')
    await loop.whenIdle()
    expect(orch.sent).toHaveLength(2)
    expect(orch.sent[1]).toBe(
      [
        '[loop event]',
        '- [#5] needs-human: ticket has no bar',
        '- [#6] needs-human: ticket has no bar',
        '- [#7] needs-human: ticket has no bar',
      ].join('\n'),
    )

    // Idle now: the next event goes out immediately.
    orch.result('Noted.')
    await loop.whenIdle()
    stepOf(id, 2).turn('GAUNTLET_QUESTION: Dark or light hero?')
    await loop.whenIdle()
    expect(orch.sent).toHaveLength(3)
    expect(orch.sent[2]).toBe('[loop event]\n- [#2] question: Dark or light hero?')

    // Busy again: an operator message and a loop event queue, then flush as one
    // message with the operator text first.
    await loop.chat(id, 'Tell #2 to go dark.')
    stepOf(id, 2).exit(1)
    await loop.whenIdle()
    expect(orch.sent).toHaveLength(3)
    orch.result('On it.')
    await loop.whenIdle()
    expect(orch.sent).toHaveLength(4)
    // (#2 parking also left the run idle with every ticket needing a human.)
    expect(orch.sent[3]).toBe(
      [
        'Tell #2 to go dark.',
        '',
        '[loop event]',
        '- [#2] needs-human: step exited unexpectedly (code 1)',
        '- run idle: 4 ticket(s) need a human',
      ].join('\n'),
    )
    const roles = chatEvents(id).map((e) => e.payload.role)
    expect(roles).toContain('operator')
    expect(roles).toContain('orchestrator')
    expect(roles).toContain('loop')
  })

  it('persists the orchestrator tool calls as chat lines and streams its partials', async () => {
    const id = await create()
    const orch = liveOrch(id)!
    orch.cb.onToolUse('Bash', `curl -s ${API_BASE}/api/loop/load`, false)
    orch.cb.onPartial('Reading')
    expect(chatEvents(id).at(-1)?.payload).toMatchObject({ role: 'tool', tool: 'Bash' })
    expect(frames).toContainEqual({ type: 'loop-partial', runId: id, text: 'Reading' })
    orch.result('', false, { tokensIn: 9, tokensOut: 3, tokensCache: 0, costUsd: 0, turns: 1 })
    expect(runOf(id).usage.tokensIn).toBe(9)
  })

  it('a crashed orchestrator is respawned lazily (with a recap) by the next loop event, which it then receives', async () => {
    const id = await started()
    const o1 = liveOrch(id)!
    o1.exit(1)
    await loop.whenIdle()
    expect(loop.view(id).orchestratorAlive).toBe(false)
    expect(db.listLoopEvents(id, { kind: 'error' }).map((e) => e.payload.text)).toContain('orchestrator exited (code 1)')

    stepOf(id, 2).turn('GAUNTLET_QUESTION: Serif or sans?')
    await loop.whenIdle()
    const o2 = liveOrch(id)!
    expect(o2).not.toBe(o1)
    expect(o2.sent).toHaveLength(1) // the recap kickoff; the spawn starts busy
    expect(o2.sent[0]).toContain('Serif or sans?')
    o2.result('Back online.')
    await loop.whenIdle()
    expect(o2.sent[1]).toBe('[loop event]\n- [#2] question: Serif or sans?')
  })

  it('buildRecap carries the run facts, every ticket state and round, and ONLY the last 20 chat lines', async () => {
    const id = await started()
    const pad = (i: number): string => String(i).padStart(2, '0')
    for (let i = 1; i <= 25; i++) {
      db.insertLoopEvent(id, null, 'chat', { role: 'operator', text: `chat-line-${pad(i)}` }, new Date().toISOString())
    }
    await restart()
    await loop.resume(id)
    await loop.whenIdle()

    const kickoff = liveOrch(id)!.sent[0]
    expect(kickoff).toContain(API_BASE)
    expect(kickoff).toContain(integBranch(id))
    expect(kickoff).toContain(SLUG)
    expect(kickoff).toMatch(/#2\b/)
    expect(kickoff).toMatch(/#3\b/)
    expect(kickoff).toContain('executing')
    expect(kickoff).toContain('blocked')
    for (let i = 6; i <= 25; i++) expect(kickoff).toContain(`chat-line-${pad(i)}`)
    for (let i = 1; i <= 5; i++) expect(kickoff).not.toContain(`chat-line-${pad(i)}`)
  })

  it('a complete run holds no orchestrator; a chat to it respawns one with the recap, then delivers the message', async () => {
    gh.tickets = [issue(2)]
    scan.green()
    const id = await started()
    await toDone(id, 2)
    integRunners(id).filter((r) => !r.killed)[0].turn('https://github.com/owner/repo/pull/7')
    await loop.whenIdle()
    expect(runOf(id).status).toBe('complete')
    expect(liveOrch(id)).toBeUndefined()

    await loop.chat(id, 'What did we ship?')
    await loop.whenIdle()
    const o2 = liveOrch(id)!
    expect(o2).toBeDefined()
    expect(orchsOf(id)).toHaveLength(2)
    expect(o2.sent).toHaveLength(1)
    expect(o2.sent[0]).toContain('complete')
    expect(o2.sent[0]).not.toContain('What did we ship?')
    o2.result('Recap read.')
    await loop.whenIdle()
    expect(o2.sent[1]).toBe('What did we ship?')
    expect(loop.view(id).orchestratorAlive).toBe(true)
  })
})

describe('LoopManager — critic read-only violation (scenario 17)', () => {
  it('a critic commit fails the HEAD-unchanged assertion: needs-human, lane released, orchestrator told, no fold ever enqueued', async () => {
    const id = await started()
    await build(id, 2)
    const c = stepOf(id, 2)
    commitFile(c.opts.cwd, 'critic-was-here.txt')
    c.turn(`GAUNTLET_VERDICT: ${OURS}\nGAUNTLET_GAP: none`) // even a WIN does not count
    await loop.whenIdle()

    expect(tk(id, 2)).toMatchObject({
      state: 'needs-human',
      note: 'critic modified the worktree (read-only violation)',
    })
    expect(c.killed).toBe(true)
    expect(loop.view(id).pool.used).toBe(0)
    expect(chatTexts(id)).toContain('[#2] needs-human: critic modified the worktree (read-only violation)')
    expect(integRunners(id)).toHaveLength(0)
    const to = db.listLoopEvents(id, { kind: 'status' }).map((e) => e.payload.to)
    expect(to).not.toContain('validating')
    expect(to).not.toContain('folding')
  })
})

describe('LoopManager — the load gate (scenario 18)', () => {
  const deferNotices = (id: string): string[] => chatTexts(id).filter((t) => t.startsWith('picks deferred'))

  it('defers picks once per episode, never touches in-flight work, and a later deferral notifies again', async () => {
    gh.tickets = [issue(2), issue(5), issue(6)]
    const id = await started()
    const b = stepOf(id, 2)

    probe.next = HIGH_LOAD
    await loop.setLanes(id, 2)
    await loop.whenIdle()
    expect(tk(id, 5).state).toBe('todo')
    expect(runOf(id).note).toBe(`picks deferred: ${HIGH_LOAD.reason}`)
    for (let i = 0; i < 3; i++) {
      await loop.pump()
      await loop.whenIdle()
    }
    expect(deferNotices(id)).toEqual([`picks deferred: ${HIGH_LOAD.reason}`])
    expect(b.killed).toBe(false)
    expect(tk(id, 2).state).toBe('executing')
    expect(runOf(id).lanes).toBe(2)

    probe.next = OK_LOAD
    await loop.pump()
    await loop.whenIdle()
    expect(tk(id, 5).state).toBe('executing')
    expect(runOf(id).note).toBeNull()

    // The memory floor is a separate trip, and a NEW episode notifies again.
    probe.next = LOW_MEM
    await loop.setLanes(id, 3)
    await loop.whenIdle()
    await loop.pump()
    await loop.whenIdle()
    expect(tk(id, 6).state).toBe('todo')
    expect(deferNotices(id)).toEqual([`picks deferred: ${HIGH_LOAD.reason}`, `picks deferred: ${LOW_MEM.reason}`])

    probe.next = OK_LOAD
    await loop.pump()
    await loop.whenIdle()
    expect(tk(id, 6).state).toBe('executing')
  })

  it('a rejecting probe fails closed (picks deferred) and is logged', async () => {
    const errors: Array<{ obj: Record<string, unknown>; msg: string }> = []
    loop = makeLoop({ log: { error: (obj, msg) => errors.push({ obj, msg }) } })
    const id = await create()
    probe.sample = async () => {
      throw new Error('probe down')
    }
    await loop.start(id)
    await loop.whenIdle()
    expect(tk(id, 2).state).not.toBe('executing')
    expect(loop.view(id).run.note).toMatch(/load probe failed/)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.msg).toMatch(/load probe failed/)
    expect(String(errors[0]?.obj.err)).toContain('probe down')
  })

  it('logs every failed background job, and records it on the run when it has one', async () => {
    const errors: Array<{ obj: Record<string, unknown>; msg: string }> = []
    loop = makeLoop({ log: { error: (obj, msg) => errors.push({ obj, msg }) } })
    const id = await create()
    const internals = loop as unknown as { track(p: Promise<unknown>, runId?: string): void }
    internals.track(Promise.reject(new Error('no run')))
    internals.track(Promise.reject(new Error('with run')), id)
    await loop.whenIdle()
    expect(errors.map((e) => e.msg)).toEqual([
      'loop background job failed',
      'loop background job failed',
    ])
    expect(errors.map((e) => String(e.obj.err))).toEqual(['Error: no run', 'Error: with run'])
    const runErrors = db.listLoopEvents(id, { kind: 'error' }).map((e) => e.payload.text)
    expect(runErrors).toContain('internal error: with run')
  })

  it('samples the probe only when a pick is possible', async () => {
    const id = await create()
    expect(probe.samples).toBe(0)
    await loop.start(id)
    await loop.whenIdle()
    const after = probe.samples
    expect(after).toBe(1)
    await loop.pump() // lane full, nothing to pick
    await loop.whenIdle()
    expect(probe.samples).toBe(after)
  })
})

describe('LoopManager — load() and the view (scenario 20)', () => {
  it('load() returns the probe sample plus the pool, and the broadcast view carries the same pool + load', async () => {
    const id = await started()
    probe.next = sample({ loadPerCore: 0.62, memAvailableMb: 5222 })
    const res = await loop.load()
    expect(res).toEqual({ ...probe.next, pool: { used: 1, max: 3 } })
    const last = loopFrames(id).at(-1)!
    expect(last.pool).toEqual({ used: 1, max: 3 })
    expect(last.load).toEqual(probe.next)
    expect(loop.view(id).load).toEqual(probe.next)
  })
})

describe('LoopManager — broadcast coalescing', () => {
  it('coalesces a run\'s loop frames into one per trailing window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      loop = makeLoop({ coalesceMs: 150 })
      const id = await create()
      expect(loopFrames(id)).toHaveLength(0)
      vi.advanceTimersByTime(150)
      expect(loopFrames(id)).toHaveLength(1)

      await loop.setLanes(id, 2)
      await loop.setLanes(id, 3)
      await loop.setPriority(id, [3])
      await loop.whenIdle()
      expect(loopFrames(id)).toHaveLength(1)
      vi.advanceTimersByTime(150)
      expect(loopFrames(id)).toHaveLength(2)
      expect(loopFrames(id)[1].run).toMatchObject({ lanes: 3, priority: [3] })
      // Persisted events are never coalesced.
      expect(frames.filter((f) => f.type === 'loop-event').length).toBeGreaterThan(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('LoopManager — map maintenance', () => {
  it('refresh updates known tickets, inserts new ones, marks a closed idle ticket done, and 502s on a failed fetch', async () => {
    gh.tickets = [issue(2), issue(3, { blockedBy: [2] })]
    const id = await create()
    gh.tickets = [issue(2, { title: 'Hero v2' }), issue(3, { state: 'closed' }), issue(8)]
    await loop.refresh(id)
    expect(tk(id, 2).title).toBe('Hero v2')
    expect(tk(id, 3).state).toBe('done')
    expect(tk(id, 8).state).toBe('todo')
    gh.fail = true
    await expect(loop.refresh(id)).rejects.toMatchObject({ status: 502 })
  })

  it('addTicket brings a skipped ticket back as todo, strips a closed outside blocker, and reopens a blocked run', async () => {
    gh.tickets = [issue(2)]
    scan.red()
    const id = await started()
    await toDone(id, 2)
    expect(runOf(id).status).toBe('blocked')

    gh.extra = [issue(9, { blockedBy: [70] }), issue(70, { state: 'closed' })]
    await loop.addTicket(id, 9)
    await loop.whenIdle()
    expect(runOf(id).status).toBe('running')
    expect(tk(id, 9).blockedBy).toEqual([])
    expect(tk(id, 9).state).toBe('executing')

    await loop.skipTicket(id, 9)
    await loop.whenIdle()
    expect(tk(id, 9).state).toBe('skipped')
    expect(runOf(id).status).toBe('blocked') // re-finalized; the unscripted scan fails closed
    gh.extra = [issue(9)]
    await loop.addTicket(id, 9)
    await loop.whenIdle()
    expect(runOf(id).status).toBe('running')
    expect(tk(id, 9).state).toBe('executing')
  })

  it('setPriority reorders picks among unblocked tickets and validates its input', async () => {
    gh.tickets = [issue(2), issue(5), issue(6)]
    const id = await create()
    await loop.setPriority(id, [6, 5])
    await loop.start(id)
    await loop.whenIdle()
    expect(tk(id, 6).state).toBe('executing')
    expect(tk(id, 2).state).toBe('todo')
    await expect(loop.setPriority(id, [0])).rejects.toMatchObject({ status: 400 })
    await expect(loop.setLanes(id, 4)).rejects.toMatchObject({ status: 400 })
    await expect(loop.retryTicket(id, 99)).rejects.toMatchObject({ status: 404 })
  })
})
