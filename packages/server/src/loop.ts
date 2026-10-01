// The gauntlet Loop engine. `LoopManager` owns every Loop run's state machine:
// a per-run integration branch, a map of GitHub-issue tickets, a GLOBAL lane pool
// (LOOP_MAX_LANES across all runs, separate from the task execute-lane cap), a
// fresh `claude` child per ticket step (builder → critic → validate → finish →
// fold), a serial fold mutex per run, the final security scan + PR, and one
// persistent orchestrator session per run that the operator chats with.
//
// Every child is spawned through the injected `RunnerFactory` seam (the same one
// the task pipeline and the chat agent use), so the API-key strip holds by
// construction and the engine is hermetic under test. All decision logic lives in
// the pure `loopMap.ts` / `loopPrompts.ts` modules; this file is the IO + state
// glue. Technique credit: robonuggets/gauntlet-loop (CC-BY-4.0), after Matt
// Shumer's "Claude of Duty".

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { config, mergeSecurityPolicy, repoById } from './config.js'
import type { Db, LoopRunPatch, LoopTicketPatch } from './db.js'
import type { GhTicket, LoopGitHub, LoopMapFetch } from './loopGithub.js'
import type { LoadProbe } from './loopLoad.js'
import {
  barless,
  deriveStates,
  frontier,
  nextAfterLoss,
  parseBar,
  pickNext,
  randomLabel,
  stripFencedCode,
  verdictOutcome,
} from './loopMap.js'
import {
  builderPrompt,
  criticPrompt,
  finalPrKickoff,
  finishPrompt,
  foldPrompt,
  loopOrchestratorPrompt,
  orchestratorKickoff,
  orchestratorRecap,
  parseStepResult,
  STEP_PROFILES,
  validatePrompt,
  type LoopStepCtx,
  type OrchestratorCtx,
  type StepPrompt,
} from './loopPrompts.js'
import { PR_RE } from './phases.js'
import type { ResultUsage, RunnerCallbacks, RunnerFactory, RunnerLike } from './runner.js'
import {
  ScannerUnavailableError,
  wellFormedScanOutput,
  type RawScanOutput,
  type ScanRunnerFactory,
} from './scanRunner.js'
import {
  evaluateThreshold,
  formatFindingsForAgent,
  normalizeFindings,
  parseOsv,
  parseSemgrep,
} from './securityScan.js'
import {
  DEFAULT_STYLE,
  LOOP_MAX_LANES,
  LOOP_MAX_ROUNDS,
  type CaveStyle,
  type EffortLevel,
  type LoopEvent,
  type LoopEventKind,
  type LoopEventPayload,
  type LoopGhState,
  type LoopLane,
  type LoopLoad,
  type LoopLoadResponse,
  type LoopRun,
  type LoopRunStatus,
  type LoopRunView,
  type LoopStep,
  type LoopTicket,
  type LoopTicketState,
  type RepoTarget,
  type SecurityPolicy,
  type WsEvent,
} from './types.js'
import { createWorktree, gitIn, removeWorktree, repoSlug, seedHarness } from './worktree.js'

// ---- public surface ---------------------------------------------------------

/**
 * A typed failure the routes map straight onto an HTTP status: 400 bad input,
 * 404 unknown run/ticket, 409 an action that the current state forbids, 502 a
 * GitHub fetch that failed upstream.
 */
export class LoopError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message)
    this.name = 'LoopError'
  }
}

export interface LoopDeps {
  runnerFactory: RunnerFactory
  github: LoopGitHub
  load: LoadProbe
  scanFactory: ScanRunnerFactory
  /** The server's own loopback origin, e.g. http://127.0.0.1:4500 — never hard-coded. */
  apiBase: string
  /** Pump re-check cadence; defaults to `config.loopPumpIntervalMs`. 0 disables the timer. */
  pumpIntervalMs?: number
  /** Per-run `loop` frame coalescing window (default 150ms); 0 broadcasts synchronously. */
  coalesceMs?: number
  clock?: () => Date
  /** Feeds `randomLabel` for the critic's blind A/B. */
  random?: () => number
  repoLookup?: (id: string) => RepoTarget | undefined
  slugOf?: (repoPath: string) => Promise<string | null>
  seed?: (worktree: string, repoPath: string) => Promise<string[]>
  securityPolicy?: (repo: RepoTarget) => SecurityPolicy
  style?: CaveStyle
  /** Structured logger for failed background jobs (index.ts passes Pino's `app.log`). */
  log?: LoopLog
}

/** The slice of a Pino logger LoopManager uses. */
export interface LoopLog {
  error(obj: Record<string, unknown>, msg: string): void
}

// ---- internals --------------------------------------------------------------

/** The blind A/B label the server randomizes for the critic. */
type BlindLabel = ReturnType<typeof randomLabel>

/** One live ticket step (a fresh `claude` child). Keyed `${runId}:${n}`. */
interface StepEntry {
  runner: RunnerLike
  /** Spawn generation; a callback from an older generation is inert. */
  gen: number
  step: LoopStep
  /** Assistant text accumulated over the current turn. */
  turnText: string
  /** The one nudge a step gets before it parks `needs-human`. */
  nudged: boolean
  /** True while the step is parked on a question to the orchestrator. */
  awaitingAnswer: boolean
  /** Which blind label (A/B) is ours — critic only. */
  oursLabel?: BlindLabel
  /** HEAD of the step's cwd when it was spawned (machine assertions). */
  headBefore: string
  model: string
  effort: EffortLevel
  activity: string
  startedAt: string
  /** True while an async machine assertion for this step is in progress. */
  processing: boolean
  /** Set when the child exits while a turn is being processed. */
  exitedDuring: string | null
}

/** The run's persistent orchestrator session. */
interface OrchEntry {
  runner: RunnerLike
  gen: number
  /** Mid-turn: never send into a busy orchestrator. */
  busy: boolean
  turnText: string
}

/** The final integ → default-branch PR agent. Keyed `${runId}:final`. */
interface FinalEntry {
  runner: RunnerLike
  gen: number
  turnText: string
  nudged: boolean
}

const STEP_STATE: Record<LoopStep, LoopTicketState> = {
  builder: 'executing',
  critic: 'reviewing',
  validate: 'validating',
  finish: 'finishing',
  fold: 'folding',
}

const STATE_STEP: Partial<Record<LoopTicketState, LoopStep>> = {
  executing: 'builder',
  reviewing: 'critic',
  validating: 'validate',
  finishing: 'finish',
  folding: 'fold',
}

/** The control line each step must end its turn with (quoted in the nudge). */
const EXPECTED_TOKEN: Record<LoopStep, string> = {
  builder: 'GAUNTLET_STATUS=BUILT',
  critic: 'GAUNTLET_VERDICT: A or B, then GAUNTLET_GAP: <the single biggest gap>',
  validate: 'GAUNTLET_STATUS=GREEN or GAUNTLET_STATUS=RED <reason>',
  finish: 'GAUNTLET_STATUS=GREEN or GAUNTLET_STATUS=RED <reason>',
  fold: 'GAUNTLET_STATUS=GREEN or GAUNTLET_STATUS=RED <reason>',
}

/** Persisted ticket states that `resume` re-runs fresh (folding re-enqueues). */
const RERUN_STATES = new Set<LoopTicketState>([
  'executing',
  'reviewing',
  'validating',
  'finishing',
  'waiting',
])

/** Run statuses a reboot cannot have kept alive. */
const LIVE_RUN_STATUSES = new Set<LoopRunStatus>(['running', 'paused', 'finalizing'])

/** How many chat lines the respawn recap carries. */
const RECAP_CHAT_LINES = 20

const DEFAULT_COALESCE_MS = 150

const ZERO_USAGE = { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function clip(s: string, max = 160): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** The last non-empty line of an assistant message, clipped for the lane card. */
function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return clip(lines[lines.length - 1] ?? '')
}

function laneKey(runId: string, n: number): string {
  return `${runId}:${n}`
}

function run8(runId: string): string {
  return runId.slice(0, 8)
}

/** Global twin of PR_RE: a final-PR turn may quote several PR URLs. */
const PR_RE_G = new RegExp(PR_RE.source, 'g')

export class LoopManager {
  private stepRunners = new Map<string, StepEntry>()
  private orchestrators = new Map<string, OrchEntry>()
  private finalRunners = new Map<string, FinalEntry>()
  /** In-flight orchestrator spawns (a spawn awaits the repo slug). */
  private orchSpawning = new Map<string, Promise<void>>()
  /** Orchestrator outbox: loop notifications, flushed as one message on idle. */
  private pendingNotes = new Map<string, string[]>()
  /** Orchestrator outbox: operator chat texts queued while it was busy. */
  private pendingOps = new Map<string, string[]>()
  /** The ticket currently folding, per run (the serial fold mutex). */
  private foldInFlight = new Map<string, number>()
  /** Tickets waiting on the fold mutex, FIFO, per run. */
  private foldQueue = new Map<string, number[]>()
  /** Global lane pool: `${runId}:${n}` holders, capped at LOOP_MAX_LANES. */
  private pool = new Set<string>()
  /**
   * Lane tokens: a fresh token per acquire. An async continuation (a pick's git
   * work, a step's setup) captures it and aborts if the lane was released (or
   * re-acquired) meanwhile.
   */
  private laneTokens = new Map<string, number>()
  private lastLoad: LoopLoad | null = null
  /** Runs whose orchestrator was told about the current load-deferral episode. */
  private loadDeferred = new Set<string>()
  /** Runs whose orchestrator was told the run went idle on needs-human tickets. */
  private idleNotified = new Set<string>()
  /** owner/name per run id (resolved once, cached). */
  private slugs = new Map<string, string>()
  private seq = 0
  private tracked = new Set<Promise<void>>()
  private pumping = false
  private pumpAgain = false
  private pumpTimer: ReturnType<typeof setInterval> | undefined
  private bcastTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private readonly coalesceMs: number
  private readonly repoLookup: (id: string) => RepoTarget | undefined
  private readonly slugOf: (repoPath: string) => Promise<string | null>
  private readonly seed: (worktree: string, repoPath: string) => Promise<string[]>
  private readonly policyFor: (repo: RepoTarget) => SecurityPolicy
  private readonly style: CaveStyle

  constructor(
    private db: Db,
    private broadcast: (e: WsEvent) => void,
    private deps: LoopDeps,
  ) {
    this.coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS
    this.repoLookup = deps.repoLookup ?? repoById
    this.slugOf = deps.slugOf ?? repoSlug
    this.seed = deps.seed ?? ((wt, repoPath) => seedHarness(wt, repoPath, config.harnessDir))
    this.policyFor = deps.securityPolicy ?? ((repo) => mergeSecurityPolicy(config.security, repo.security))
    this.style = deps.style ?? DEFAULT_STYLE
    const interval = deps.pumpIntervalMs ?? config.loopPumpIntervalMs
    if (interval > 0) {
      this.pumpTimer = setInterval(() => this.track(this.pump()), interval)
      this.pumpTimer.unref?.()
    }
  }

  // ---- public: reads ----------------------------------------------------------

  /** A fresh load sample plus the global pool occupancy (also updates `lastLoad`). */
  async load(): Promise<LoopLoadResponse> {
    const sample = await this.deps.load.sample()
    this.setLoad(sample)
    return { ...sample, pool: { used: this.pool.size, max: LOOP_MAX_LANES } }
  }

  /** Every run, non-archived first (DB order otherwise). */
  listRuns(): LoopRun[] {
    const runs = this.db.listLoopRuns()
    return [
      ...runs.filter((r) => r.status !== 'archived'),
      ...runs.filter((r) => r.status === 'archived'),
    ]
  }

  view(runId: string): LoopRunView {
    const run = this.mustRun(runId)
    const lanes: LoopLane[] = []
    for (const [key, e] of this.stepRunners) {
      const n = this.ticketOfKey(runId, key)
      if (n === undefined) continue
      lanes.push({
        ticket: n,
        step: e.step,
        model: e.model,
        effort: e.effort,
        activity: e.activity,
        startedAt: e.startedAt,
        waiting: e.awaitingAnswer,
      })
    }
    // Every held pool slot is a lane card, even with no live child: a ticket
    // queued on the fold mutex (or mid-pick, before its builder spawns) keeps
    // its lane, so the view must not render that slot as idle.
    const tickets = this.derivedTickets(runId)
    const byNumber = new Map(tickets.map((t) => [t.number, t]))
    for (const key of this.pool) {
      const n = this.ticketOfKey(runId, key)
      if (n === undefined || this.stepRunners.has(key)) continue
      const step = byNumber.get(n)?.step ?? 'builder'
      const queuedFold = this.foldQueue.get(runId)?.includes(n) ?? false
      lanes.push({
        ticket: n,
        step,
        model: STEP_PROFILES[step].model,
        effort: STEP_PROFILES[step].effort,
        activity: queuedFold ? 'queued — waiting for the serial fold' : 'starting…',
        startedAt: byNumber.get(n)?.stepStartedAt ?? this.now(),
        waiting: false,
      })
    }
    lanes.sort((a, b) => a.ticket - b.ticket)
    const orch = this.orchestrators.get(runId)
    return {
      run,
      tickets,
      lanes,
      orchestratorAlive: orch !== undefined,
      orchestratorBusy: orch?.busy ?? false,
      pool: { used: this.pool.size, max: LOOP_MAX_LANES },
      load: this.lastLoad,
    }
  }

  events(runId: string, limit?: number): LoopEvent[] {
    this.mustRun(runId)
    return this.db.listLoopEvents(runId, limit === undefined ? {} : { limit })
  }

  // ---- public: run lifecycle -------------------------------------------------

  async createRun(req: { repoId: string; epic: number; lanes?: number }): Promise<LoopRunView> {
    const repo = this.repoLookup(req.repoId)
    if (!repo) throw new LoopError(400, `unknown repo: ${req.repoId}`)
    if (!Number.isInteger(req.epic) || req.epic <= 0) {
      throw new LoopError(400, 'epic must be a positive issue number')
    }
    const lanes = req.lanes ?? 1
    this.assertLaneCount(lanes)
    const slug = await this.slugOf(repo.path)
    if (!slug) throw new LoopError(400, `repo ${repo.id} has no GitHub origin remote`)

    let map: LoopMapFetch
    try {
      map = await this.deps.github.fetchMap(slug, req.epic)
    } catch (err) {
      throw new LoopError(502, `GitHub fetch failed: ${errMsg(err)}`)
    }

    const id = randomUUID()
    const integBranch = `gauntlet/${run8(id)}/integ`
    // The integration worktree first: if git fails, nothing is persisted.
    const wt = await createWorktree(
      repo.path,
      repo.defaultBranch,
      this.worktreesDir(repo),
      id,
      map.epic.title,
      { branch: integBranch, dir: `loop-${run8(id)}-integ` },
    )
    let seedNotes: string[] = []
    let seedError: string | null = null
    try {
      seedNotes = await this.seed(wt.worktreePath, repo.path)
    } catch (err) {
      seedError = errMsg(err)
    }

    const now = this.now()
    this.db.insertLoopRun({
      id,
      repoId: repo.id,
      epic: req.epic,
      title: map.epic.title,
      status: 'draft',
      prevStatus: null,
      lanes,
      integBranch,
      integWorktree: wt.worktreePath,
      priority: [],
      prUrl: null,
      note: null,
      usage: { ...ZERO_USAGE },
      createdAt: now,
      updatedAt: now,
    })
    this.slugs.set(id, slug)
    const inMap = new Set(map.tickets.map((t) => t.number))
    for (const gt of map.tickets) {
      this.insertTicket(id, gt, this.stripClosedExternal(gt.blockedBy, inMap, map.external), now)
    }
    this.recompute(id)
    this.event(id, null, 'status', {
      from: 'none',
      to: 'draft',
      text: `run created for #${req.epic} (${map.tickets.length} ticket(s))`,
    })
    for (const note of seedNotes) this.event(id, null, 'status', { text: note })
    if (seedError) this.event(id, null, 'error', { text: `harness seeding failed: ${seedError}` })

    await this.ensureOrchestrator(id, false)
    this.scheduleBroadcast(id)
    return this.view(id)
  }

  async start(runId: string): Promise<LoopRunView> {
    const run = this.mustLiveRun(runId)
    if (run.status === 'running') return this.view(runId)
    if (run.status !== 'draft' && run.status !== 'paused' && run.status !== 'blocked') {
      throw new LoopError(409, `cannot start a ${run.status} run`)
    }
    this.setRunStatus(runId, 'running', { note: null })
    this.track(this.pump())
    this.track(this.maybeFinalize(runId), runId)
    return this.view(runId)
  }

  async pause(runId: string): Promise<LoopRunView> {
    const run = this.mustLiveRun(runId)
    if (run.status === 'paused') return this.view(runId)
    if (run.status !== 'running') throw new LoopError(409, `cannot pause a ${run.status} run`)
    this.setRunStatus(runId, 'paused')
    return this.view(runId)
  }

  async setLanes(runId: string, count: number): Promise<LoopRunView> {
    this.mustLiveRun(runId)
    this.assertLaneCount(count)
    this.patchRun(runId, { lanes: count })
    this.event(runId, null, 'status', { text: `lane target set to ${count}` })
    this.track(this.pump())
    return this.view(runId)
  }

  async setPriority(runId: string, order: number[]): Promise<LoopRunView> {
    this.mustLiveRun(runId)
    if (!Array.isArray(order) || !order.every((n) => Number.isInteger(n) && n > 0)) {
      throw new LoopError(400, 'priority must be an array of positive issue numbers')
    }
    this.patchRun(runId, { priority: [...new Set(order)] })
    this.track(this.pump())
    return this.view(runId)
  }

  async refresh(runId: string): Promise<LoopRunView> {
    const run = this.mustLiveRun(runId)
    const slug = await this.slugFor(run)
    let map: LoopMapFetch
    try {
      map = await this.deps.github.fetchMap(slug, run.epic)
    } catch (err) {
      throw new LoopError(502, `GitHub fetch failed: ${errMsg(err)}`)
    }
    const now = this.now()
    this.patchRun(runId, { title: map.epic.title })
    const existing = new Map(this.db.listLoopTickets(runId).map((t) => [t.number, t]))
    const inMap = new Set([...existing.keys(), ...map.tickets.map((t) => t.number)])
    let added = 0
    for (const gt of map.tickets) {
      const blockedBy = this.stripClosedExternal(gt.blockedBy, inMap, map.external)
      const cur = existing.get(gt.number)
      if (!cur) {
        this.insertTicket(runId, gt, blockedBy, now)
        added++
        continue
      }
      const patch: LoopTicketPatch = {
        title: gt.title,
        body: gt.body,
        url: gt.url,
        ghState: gt.state,
        blockedBy,
        bar: parseBar(gt.body),
      }
      // A closed issue that is not in flight is done (an operator skip stands).
      const idle = !this.inFlight(runId, cur) && cur.state !== 'skipped' && cur.state !== 'done'
      if (gt.state === 'closed' && idle) patch.state = 'done'
      this.db.updateLoopTicket(runId, gt.number, patch, now)
    }
    this.recompute(runId)
    this.reopenIfIncomplete(runId)
    this.event(runId, null, 'status', { text: `map refreshed from GitHub (${added} new ticket(s))` })
    this.scheduleBroadcast(runId)
    this.track(this.pump())
    return this.view(runId)
  }

  async addTicket(runId: string, n: number): Promise<LoopRunView> {
    const run = this.mustLiveRun(runId)
    this.assertIssueNumber(n)
    const slug = await this.slugFor(run)
    let gt: GhTicket
    try {
      gt = await this.deps.github.fetchIssue(slug, n)
    } catch (err) {
      throw new LoopError(502, `GitHub fetch failed: ${errMsg(err)}`)
    }
    const inMap = new Set(this.db.listLoopTickets(runId).map((t) => t.number))
    inMap.add(n)
    // Blockers outside the run: learn their state so a closed one is satisfied.
    const external: Record<number, LoopGhState> = {}
    for (const b of gt.blockedBy) {
      if (inMap.has(b)) continue
      try {
        external[b] = (await this.deps.github.fetchIssue(slug, b)).state
      } catch {
        // unknown → stays blocking (fail-safe)
      }
    }
    const blockedBy = this.stripClosedExternal(gt.blockedBy, inMap, external)
    const cur = this.db.getLoopTicket(runId, n)
    const now = this.now()
    if (!cur) {
      this.insertTicket(runId, gt, blockedBy, now)
    } else {
      const patch: LoopTicketPatch = {
        title: gt.title,
        body: gt.body,
        url: gt.url,
        ghState: gt.state,
        blockedBy,
        bar: parseBar(gt.body),
      }
      if (!this.inFlight(runId, cur)) {
        if (gt.state === 'closed') patch.state = 'done'
        else if (cur.state === 'skipped') patch.state = 'todo'
      }
      this.db.updateLoopTicket(runId, n, patch, now)
    }
    if (run.status === 'blocked') this.setRunStatus(runId, 'running', { note: null })
    this.recompute(runId)
    this.reopenIfIncomplete(runId)
    this.event(runId, n, 'status', { text: `ticket #${n} added to the run` })
    this.scheduleBroadcast(runId)
    this.track(this.pump())
    return this.view(runId)
  }

  async skipTicket(runId: string, n: number): Promise<LoopRunView> {
    this.mustLiveRun(runId)
    const t = this.mustTicket(runId, n)
    if (t.state === 'done') throw new LoopError(409, `ticket #${n} is already done`)
    if (t.state === 'skipped') return this.view(runId)
    if (this.inFlight(runId, t)) await this.haltTicket(runId, n)
    const from = this.mustTicket(runId, n).state
    this.db.updateLoopTicket(runId, n, { state: 'skipped', question: null }, this.now())
    this.event(runId, n, 'status', { from, to: 'skipped' })
    this.recompute(runId)
    this.scheduleBroadcast(runId)
    // Tracked, never awaited: the request must not wait out a security scan
    // (the status flips to `finalizing` synchronously inside maybeFinalize).
    this.track(this.maybeFinalize(runId), runId)
    this.track(this.pump())
    return this.view(runId)
  }

  async stopTicket(runId: string, n: number): Promise<LoopRunView> {
    this.mustLiveRun(runId)
    const t = this.mustTicket(runId, n)
    if (!this.inFlight(runId, t)) throw new LoopError(409, `ticket #${n} is not in flight`)
    await this.haltTicket(runId, n)
    return this.view(runId)
  }

  async retryTicket(runId: string, n: number): Promise<LoopRunView> {
    this.mustLiveRun(runId)
    const t = this.mustTicket(runId, n)
    if (t.state !== 'needs-human') throw new LoopError(409, `ticket #${n} is ${t.state}, not needs-human`)
    this.db.updateLoopTicket(
      runId,
      n,
      { state: 'todo', round: 0, lastGap: null, question: null, note: null },
      this.now(),
    )
    this.event(runId, n, 'status', { from: 'needs-human', to: 'todo' })
    this.recompute(runId)
    this.scheduleBroadcast(runId)
    this.track(this.pump())
    return this.view(runId)
  }

  async answer(runId: string, n: number, text: string): Promise<LoopRunView> {
    this.mustLiveRun(runId)
    const t = this.mustTicket(runId, n)
    const e = this.stepRunners.get(laneKey(runId, n))
    if (t.state !== 'waiting' || !e || !e.awaitingAnswer) {
      throw new LoopError(409, `ticket #${n} is not waiting on a question`)
    }
    const to = STEP_STATE[e.step]
    this.db.updateLoopTicket(runId, n, { state: to, question: null }, this.now())
    this.event(runId, n, 'status', { from: 'waiting', to, step: e.step })
    e.awaitingAnswer = false
    e.runner.send(text)
    this.chatLine(runId, { role: 'loop', text: `[#${n}] answer sent: ${text}` })
    this.scheduleBroadcast(runId)
    return this.view(runId)
  }

  async chat(runId: string, text: string): Promise<void> {
    this.mustLiveRun(runId)
    // Spawn (with a recap) BEFORE logging the line, so the recap does not also
    // carry this message — it is delivered once, as its own turn.
    await this.ensureOrchestrator(runId, true)
    this.chatLine(runId, { role: 'operator', text })
    this.queueFor(this.pendingOps, runId).push(text)
    this.flushOutbox(runId)
  }

  async resume(runId: string): Promise<LoopRunView> {
    const run = this.mustLiveRun(runId)
    if (run.status !== 'stale') throw new LoopError(409, `cannot resume a ${run.status} run`)
    const prev = run.prevStatus ?? 'paused'
    const wasFinalizing = prev === 'finalizing'
    const to: LoopRunStatus = wasFinalizing ? 'running' : prev
    this.setRunStatus(runId, to, { prevStatus: null })

    // Re-admit in-flight tickets SYNCHRONOUSLY (before any await), so a pump
    // cannot hand their slots to new picks meanwhile. The load gate is not
    // consulted: these tickets were already admitted before the restart.
    const repo = this.repoLookup(run.repoId)
    const tickets = this.db.listLoopTickets(runId).sort((a, b) => a.number - b.number)
    const reruns: Array<{ n: number; step: LoopStep }> = []
    const refolds: number[] = []
    for (const t of tickets) {
      if (!RERUN_STATES.has(t.state) && t.state !== 'folding') continue
      if (!repo || !this.acquire(runId, t.number)) {
        // The pool is full (another run took the slots) — never exceed the cap.
        this.db.updateLoopTicket(runId, t.number, { state: 'todo', question: null }, this.now())
        this.event(runId, t.number, 'status', { from: t.state, to: 'todo', text: 'resume: no free lane' })
        continue
      }
      if (t.state === 'folding') refolds.push(t.number)
      else reruns.push({ n: t.number, step: t.step ?? STATE_STEP[t.state] ?? 'builder' })
    }
    this.recompute(runId)

    await this.ensureOrchestrator(runId, true)
    for (const { n, step } of reruns) this.track(this.rerunStep(runId, n, step), runId)
    if (refolds.length) this.track(this.refoldAfterResume(runId, refolds), runId)
    this.scheduleBroadcast(runId)
    this.track(this.pump())
    if (wasFinalizing) this.track(this.maybeFinalize(runId), runId)
    return this.view(runId)
  }

  async archive(runId: string): Promise<void> {
    const run = this.mustLiveRun(runId)
    const repo = this.repoLookup(run.repoId)
    // Kill every process of the run first so nothing holds a worktree open.
    for (const [key, e] of [...this.stepRunners]) {
      if (this.ticketOfKey(runId, key) === undefined) continue
      this.stepRunners.delete(key)
      e.runner.kill()
    }
    this.killFinal(runId)
    this.killOrchestrator(runId)
    for (const key of [...this.pool]) {
      if (this.ticketOfKey(runId, key) === undefined) continue
      this.pool.delete(key)
      this.laneTokens.delete(key)
    }
    this.foldInFlight.delete(runId)
    this.foldQueue.delete(runId)
    this.pendingNotes.delete(runId)
    this.pendingOps.delete(runId)
    this.loadDeferred.delete(runId)
    this.idleNotified.delete(runId)
    const timer = this.bcastTimers.get(runId)
    if (timer) clearTimeout(timer)
    this.bcastTimers.delete(runId)
    this.setRunStatus(runId, 'archived', { broadcast: false })
    // Nothing runs for an archived run any more: in-flight tickets read `todo`.
    for (const t of this.db.listLoopTickets(runId)) {
      if (!RERUN_STATES.has(t.state) && t.state !== 'folding') continue
      this.db.updateLoopTicket(runId, t.number, { state: 'todo', question: null }, this.now())
    }

    if (repo) {
      for (const t of this.db.listLoopTickets(runId)) {
        if (!t.worktree) continue
        await removeWorktree(repo.path, t.worktree)
        this.db.updateLoopTicket(runId, t.number, { worktree: null }, this.now())
      }
      if (run.integWorktree) await removeWorktree(repo.path, run.integWorktree)
    }
    this.patchRun(runId, { integWorktree: null }, false)
    this.broadcast({ type: 'loop-removed', runId })
    this.track(this.pump())
  }

  /** Boot: nothing is alive after a restart — every live run becomes `stale`. */
  reconcileOrphans(): void {
    for (const run of this.db.listLoopRuns()) {
      if (!LIVE_RUN_STATUSES.has(run.status)) continue
      this.setRunStatus(run.id, 'stale', { prevStatus: run.status })
    }
  }

  /**
   * Fill every running run's free slots (oldest run first) from its frontier,
   * gated on one fresh load sample. Serialized: a pump requested while one runs
   * sets a flag and the running pump loops once more.
   */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        await this.pumpOnce()
      } while (this.pumpAgain)
    } finally {
      this.pumping = false
    }
  }

  /** Resolves once every tracked async job has settled (the test seam). */
  async whenIdle(): Promise<void> {
    while (this.tracked.size) {
      await Promise.allSettled([...this.tracked])
    }
  }

  /** Graceful shutdown: stop timers and kill every child (steps, finals, orchestrators). */
  shutdown(): void {
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    this.pumpTimer = undefined
    for (const t of this.bcastTimers.values()) clearTimeout(t)
    this.bcastTimers.clear()
    for (const e of this.stepRunners.values()) e.runner.kill()
    for (const e of this.finalRunners.values()) e.runner.kill()
    for (const e of this.orchestrators.values()) e.runner.kill()
    this.stepRunners.clear()
    this.finalRunners.clear()
    this.orchestrators.clear()
  }

  /** Synchronous process-exit backstop: group-SIGKILL every child tree. */
  hardKillAll(): void {
    for (const e of this.stepRunners.values()) e.runner.killGroupSync?.()
    for (const e of this.finalRunners.values()) e.runner.killGroupSync?.()
    for (const e of this.orchestrators.values()) e.runner.killGroupSync?.()
  }

  // ---- pump internals --------------------------------------------------------

  private async pumpOnce(): Promise<void> {
    const runs = this.runningRuns()
    for (const run of runs) this.parkBarless(run)

    // Only sample the machine when a pick is actually possible.
    const wouldPick = runs.filter((run) => {
      const free = this.freeSlots(run)
      return free > 0 && this.pickable(run.id, run.priority, free).length > 0
    })
    if (wouldPick.length) {
      let load: LoopLoad | null
      try {
        load = await this.deps.load.sample()
        this.setLoad(load)
      } catch (err) {
        // Fail closed: an unreadable machine never admits a new lane.
        this.deps.log?.error({ err }, 'loop load probe failed — picks deferred')
        load = null
      }
      if (!load || !load.allowsNewLane) {
        const reason = load?.reason ?? (load ? 'machine busy' : 'load probe failed')
        for (const run of wouldPick) this.deferPicks(run.id, reason)
      } else {
        // Re-read: the runs may have changed across the sample's await.
        for (const run of this.runningRuns()) {
          const free = this.freeSlots(run)
          if (free <= 0) continue
          const picks = this.pickable(run.id, run.priority, free)
          if (!picks.length) continue
          this.loadDeferred.delete(run.id)
          this.idleNotified.delete(run.id)
          if (run.note?.startsWith('picks deferred')) this.patchRun(run.id, { note: null })
          for (const n of picks) this.pickTicket(run.id, n)
        }
      }
    }

    for (const run of this.runningRuns()) this.checkIdle(run)
  }

  private runningRuns(): LoopRun[] {
    return this.db
      .listLoopRuns()
      .filter((r) => r.status === 'running')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  private freeSlots(run: LoopRun): number {
    return Math.min(run.lanes - this.heldBy(run.id), LOOP_MAX_LANES - this.pool.size)
  }

  private heldBy(runId: string): number {
    let n = 0
    for (const key of this.pool) if (this.ticketOfKey(runId, key) !== undefined) n++
    return n
  }

  private pickable(runId: string, priority: number[], free: number): number[] {
    return pickNext(this.derivedTickets(runId), priority, free)
  }

  /** Park frontier tickets that have no bar (never picked; no lane needed). */
  private parkBarless(run: LoopRun): void {
    const tickets = this.derivedTickets(run.id)
    for (const n of barless(tickets)) {
      const t = tickets.find((x) => x.number === n)
      this.db.updateLoopTicket(run.id, n, { state: 'needs-human', note: 'ticket has no bar' }, this.now())
      this.event(run.id, n, 'status', {
        from: t?.state ?? 'todo',
        to: 'needs-human',
        text: 'ticket has no bar',
      })
      this.notifyOrchestrator(run.id, `[#${n}] needs-human: ticket has no bar`)
      this.scheduleBroadcast(run.id)
    }
  }

  private deferPicks(runId: string, reason: string): void {
    const note = `picks deferred: ${reason}`
    const run = this.db.getLoopRun(runId)
    if (run?.status !== 'running') return
    if (run.note !== note) this.patchRun(runId, { note })
    if (this.loadDeferred.has(runId)) return
    this.loadDeferred.add(runId)
    this.notifyOrchestrator(runId, note)
  }

  /** A running run with no lane, nothing pickable and a needs-human backlog. */
  private checkIdle(run: LoopRun): void {
    if (this.idleNotified.has(run.id) || this.heldBy(run.id) > 0) return
    const tickets = this.derivedTickets(run.id)
    if (frontier(tickets).length) return
    const stuck = tickets.filter((t) => t.state === 'needs-human').length
    if (!stuck) return
    this.idleNotified.add(run.id)
    this.notifyOrchestrator(run.id, `run idle: ${stuck} ticket(s) need a human`)
  }

  private setLoad(sample: LoopLoad): void {
    const prev = this.lastLoad
    this.lastLoad = sample
    const changed =
      !prev ||
      prev.allowsNewLane !== sample.allowsNewLane ||
      prev.loadPerCore.toFixed(2) !== sample.loadPerCore.toFixed(2) ||
      (prev.memAvailableMb / 1024).toFixed(1) !== (sample.memAvailableMb / 1024).toFixed(1)
    if (!changed) return
    for (const run of this.runningRuns()) this.scheduleBroadcast(run.id)
  }

  // ---- lane pool -------------------------------------------------------------

  /** Take a pool slot synchronously. False when the global pool is full. */
  private acquire(runId: string, n: number): boolean {
    const key = laneKey(runId, n)
    if (this.pool.has(key)) return true
    if (this.pool.size >= LOOP_MAX_LANES) return false
    this.pool.add(key)
    this.laneTokens.set(key, ++this.seq)
    return true
  }

  /** The ONE path that ends a ticket's lane. Pumps unless told not to (stop). */
  private releaseLane(runId: string, n: number, pump = true): void {
    const key = laneKey(runId, n)
    this.pool.delete(key)
    this.laneTokens.delete(key)
    this.scheduleBroadcast(runId)
    if (pump) this.track(this.pump())
  }

  private laneToken(runId: string, n: number): number | undefined {
    return this.laneTokens.get(laneKey(runId, n))
  }

  /** Acquire + mark executing synchronously, then do the git work async. */
  private pickTicket(runId: string, n: number): boolean {
    if (!this.acquire(runId, n)) return false
    const t = this.db.getLoopTicket(runId, n)
    if (!t) {
      this.releaseLane(runId, n, false)
      return false
    }
    const now = this.now()
    this.db.updateLoopTicket(
      runId,
      n,
      {
        state: 'executing',
        step: 'builder',
        round: Math.max(t.round, 1),
        startedAt: t.startedAt ?? now,
        stepStartedAt: now,
        note: null,
      },
      now,
    )
    this.event(runId, n, 'status', { from: t.state, to: 'executing', step: 'builder' })
    this.scheduleBroadcast(runId)
    this.track(this.preparePicked(runId, n), runId)
    return true
  }

  private async preparePicked(runId: string, n: number): Promise<void> {
    const token = this.laneToken(runId, n)
    try {
      await this.ensureTicketWorktree(runId, n)
      if (this.laneToken(runId, n) !== token) return
      await this.runStep(runId, n, 'builder', true)
    } catch (err) {
      if (this.laneToken(runId, n) !== token) return
      this.needsHuman(runId, n, `pick failed: ${errMsg(err)}`)
    }
  }

  /** Create (or reattach) the ticket's worktree off the integ tip, and seed it. */
  private async ensureTicketWorktree(runId: string, n: number): Promise<void> {
    const run = this.mustRun(runId)
    const repo = this.mustRepo(run)
    const t = this.mustTicket(runId, n)
    if (t.worktree && existsSync(t.worktree)) return
    if (!run.integWorktree) throw new Error('run has no integration worktree')
    const sha = await gitIn(run.integWorktree, ['rev-parse', 'HEAD'])
    const wt = await createWorktree(repo.path, repo.defaultBranch, this.worktreesDir(repo), runId, t.title, {
      branch: t.branch ?? this.ticketBranch(runId, n),
      base: sha.trim(),
      dir: `loop-${run8(runId)}-t${n}`,
    })
    await this.seed(wt.worktreePath, repo.path)
    this.db.updateLoopTicket(runId, n, { branch: wt.branch, worktree: wt.worktreePath }, this.now())
  }

  // ---- steps -----------------------------------------------------------------

  /**
   * Spawn a FRESH child for one step of a ticket. Persists the step's state and
   * logs a `status` event for every step start (`quiet` only right after a pick,
   * which already logged its own `todo → executing`).
   */
  private async runStep(runId: string, n: number, step: LoopStep, quiet = false): Promise<void> {
    const token = this.laneToken(runId, n)
    if (token === undefined) return
    const run = this.db.getLoopRun(runId)
    const repo = run ? this.repoLookup(run.repoId) : undefined
    const t = this.db.getLoopTicket(runId, n)
    if (!run || !t) return
    if (!repo) {
      this.needsHuman(runId, n, `unknown repo: ${run.repoId}`)
      return
    }
    const cwd = step === 'fold' ? run.integWorktree : t.worktree
    const to = STEP_STATE[step]
    const now = this.now()
    this.db.updateLoopTicket(runId, n, { state: to, step, stepStartedAt: now, question: null }, now)
    if (!quiet) this.event(runId, n, 'status', { from: t.state, to, step })
    this.scheduleBroadcast(runId)
    if (!cwd) {
      this.needsHuman(runId, n, `no worktree for the ${step} step`)
      return
    }

    let headBefore: string
    let baseSha = ''
    let oursLabel: BlindLabel | undefined
    let slug: string
    try {
      slug = await this.slugFor(run)
      headBefore = (await gitIn(cwd, ['rev-parse', 'HEAD'])).trim()
      if (step === 'critic') {
        baseSha = (await gitIn(cwd, ['merge-base', 'HEAD', run.integBranch])).trim()
        oursLabel = randomLabel(this.deps.random)
      }
    } catch (err) {
      if (this.laneToken(runId, n) !== token) return
      this.needsHuman(runId, n, `${step} setup failed: ${errMsg(err)}`)
      return
    }
    // A stop/skip/archive during the awaits above released the lane: abort.
    if (this.laneToken(runId, n) !== token) return

    const fresh = this.mustTicket(runId, n)
    const ctx = this.stepCtx(run, repo, slug, fresh)
    const prompt = this.promptFor(step, ctx, oursLabel ?? 'A', baseSha, run.integWorktree ?? cwd)
    const profile = STEP_PROFILES[step]
    const gen = ++this.seq
    let runner: RunnerLike
    try {
      runner = this.deps.runnerFactory(
        { cwd, model: profile.model, effort: profile.effort, systemPrompt: prompt.system },
        this.stepCallbacks(runId, n, gen),
      )
    } catch (err) {
      this.needsHuman(runId, n, `spawn failed: ${errMsg(err)}`)
      return
    }
    this.stepRunners.set(laneKey(runId, n), {
      runner,
      gen,
      step,
      turnText: '',
      nudged: false,
      awaitingAnswer: false,
      oursLabel,
      headBefore,
      model: profile.model,
      effort: profile.effort,
      activity: `${step} started`,
      startedAt: this.now(),
      processing: false,
      exitedDuring: null,
    })
    this.scheduleBroadcast(runId)
    runner.send(prompt.kickoff)
  }

  private promptFor(
    step: LoopStep,
    ctx: LoopStepCtx,
    oursLabel: BlindLabel,
    baseSha: string,
    integWorktree: string,
  ): StepPrompt {
    switch (step) {
      case 'builder':
        return builderPrompt(ctx)
      case 'critic':
        return criticPrompt(ctx, oursLabel, baseSha)
      case 'validate':
        return validatePrompt(ctx)
      case 'finish':
        return finishPrompt(ctx)
      case 'fold':
        return foldPrompt(ctx, integWorktree)
    }
  }

  private stepCtx(run: LoopRun, repo: RepoTarget, slug: string, t: LoopTicket): LoopStepCtx {
    return {
      repoSlug: slug,
      defaultBranch: repo.defaultBranch,
      integBranch: run.integBranch,
      ticketBranch: t.branch ?? this.ticketBranch(run.id, t.number),
      ticket: {
        number: t.number,
        title: t.title,
        body: t.body,
        url: t.url,
        bar: t.bar ?? '',
        round: t.round,
        lastGap: t.lastGap,
      },
      style: this.style,
    }
  }

  private stepCallbacks(runId: string, n: number, gen: number): RunnerCallbacks {
    const key = laneKey(runId, n)
    const current = (): StepEntry | undefined => {
      const e = this.stepRunners.get(key)
      return e && e.gen === gen ? e : undefined
    }
    return {
      onSession: () => {},
      onPartial: () => {},
      onSubagentResult: () => {},
      onToolUse: (name, summary) => {
        const e = current()
        if (!e) return
        e.activity = clip(summary || name)
        this.event(runId, n, 'activity', { tool: name, summary, step: e.step })
        this.scheduleBroadcast(runId)
      },
      onAssistantText: (text) => {
        const e = current()
        if (!e) return
        e.turnText = e.turnText ? `${e.turnText}\n${text}` : text
        const line = lastLine(text)
        if (line) e.activity = line
        this.scheduleBroadcast(runId)
      },
      onResult: (text, isError, usage) => {
        const e = current()
        if (!e) return
        if (usage) this.addUsage(runId, n, usage)
        const turn = `${e.turnText}\n${text}`
        e.turnText = ''
        this.track(this.onStepTurn(runId, n, gen, turn, isError), runId)
      },
      onExit: (code, signal) => {
        const e = current()
        if (!e) return
        const why = `step exited unexpectedly (code ${code ?? signal ?? 'null'})`
        if (e.processing) {
          e.exitedDuring = why
          return
        }
        this.needsHuman(runId, n, why)
      },
      onSpawnError: (err) => {
        if (!current()) return
        this.needsHuman(runId, n, `spawn failed: ${err.message}`)
      },
    }
  }

  /** Handle the end of one step turn: question, nudge, assert, advance. */
  private async onStepTurn(
    runId: string,
    n: number,
    gen: number,
    text: string,
    isError: boolean,
  ): Promise<void> {
    const key = laneKey(runId, n)
    const e = this.stepRunners.get(key)
    if (!e || e.gen !== gen) return
    const res = parseStepResult(text)

    if (res.question) {
      e.awaitingAnswer = true
      const from = STEP_STATE[e.step]
      this.db.updateLoopTicket(runId, n, { state: 'waiting', question: res.question }, this.now())
      this.event(runId, n, 'status', { from, to: 'waiting', step: e.step, text: res.question })
      this.notifyOrchestrator(runId, `[#${n}] question: ${res.question}`)
      this.scheduleBroadcast(runId)
      return
    }

    const step = e.step
    const hasToken =
      step === 'builder'
        ? res.status === 'BUILT'
        : step === 'critic'
          ? res.verdict !== undefined
          : res.status === 'GREEN' || res.status === 'RED'
    if (isError || !hasToken) {
      this.nudgeOrPark(runId, n, e, undefined, 'no GAUNTLET status after a nudge')
      return
    }

    switch (step) {
      case 'builder': {
        const ok = await this.assertAround(e, () => this.builderAssert(runId, n, e.headBefore))
        if (!this.isCurrent(key, gen)) return
        if (!ok) {
          this.nudgeOrPark(
            runId,
            n,
            e,
            'Commit all your work, leave the tree clean, then print GAUNTLET_STATUS=BUILT on its own line.',
            'builder left uncommitted work or made no commit after a nudge',
          )
          return
        }
        this.accept(key, e)
        await this.runStep(runId, n, 'critic')
        return
      }
      case 'critic': {
        const clean = await this.assertAround(e, () => this.criticAssert(runId, n, e.headBefore))
        if (!this.isCurrent(key, gen)) return
        if (!clean) {
          this.needsHuman(runId, n, 'critic modified the worktree (read-only violation)')
          return
        }
        this.accept(key, e)
        const round = this.mustTicket(runId, n).round
        const won = e.oursLabel !== undefined && verdictOutcome(res.verdict, e.oursLabel) === 'WIN'
        if (won) {
          this.notifyOrchestrator(runId, `[#${n}] WIN round ${round}`)
          await this.runStep(runId, n, 'validate')
          return
        }
        await this.lose(runId, n, res.gap?.trim() || 'critic named no gap')
        return
      }
      case 'validate': {
        this.accept(key, e)
        if (res.status === 'GREEN') await this.runStep(runId, n, 'finish')
        else await this.lose(runId, n, `validation failed: ${res.reason?.trim() || 'no reason given'}`)
        return
      }
      case 'finish': {
        this.accept(key, e)
        if (res.status === 'GREEN') this.enqueueFold(runId, n)
        else await this.lose(runId, n, `docs sync failed: ${res.reason?.trim() || 'no reason given'}`)
        return
      }
      case 'fold': {
        if (res.status === 'RED') {
          this.needsHuman(runId, n, `fold failed: ${res.reason?.trim() || 'no reason given'}`)
          return
        }
        const ok = await this.assertAround(e, () => this.foldAssert(runId, n))
        if (!this.isCurrent(key, gen)) return
        if (!ok) {
          this.nudgeOrPark(
            runId,
            n,
            e,
            [
              'The ticket branch is not merged into the integration branch, or the integration',
              'worktree is not clean. Finish the merge, commit, leave the tree clean, then print',
              'GAUNTLET_STATUS=GREEN on its own line.',
            ].join(' '),
            'fold not verified after a nudge (ticket branch not merged into integ, or integ tree dirty)',
          )
          return
        }
        this.accept(key, e)
        await this.completeFold(runId, n)
        return
      }
    }
  }

  private async assertAround(e: StepEntry, check: () => Promise<boolean>): Promise<boolean> {
    e.processing = true
    try {
      return await check()
    } catch {
      return false
    } finally {
      e.processing = false
    }
  }

  private async treeClean(cwd: string): Promise<boolean> {
    return (await gitIn(cwd, ['status', '--porcelain'])).trim() === ''
  }

  /** Builder: the tree is clean AND HEAD advanced. */
  private async builderAssert(runId: string, n: number, headBefore: string): Promise<boolean> {
    const cwd = this.mustTicket(runId, n).worktree
    if (!cwd) return false
    if (!(await this.treeClean(cwd))) return false
    return (await gitIn(cwd, ['rev-parse', 'HEAD'])).trim() !== headBefore
  }

  /** Critic (read-only): HEAD unchanged AND the tree clean. */
  private async criticAssert(runId: string, n: number, headBefore: string): Promise<boolean> {
    const cwd = this.mustTicket(runId, n).worktree
    if (!cwd) return false
    if ((await gitIn(cwd, ['rev-parse', 'HEAD'])).trim() !== headBefore) return false
    return this.treeClean(cwd)
  }

  /** Fold: the ticket branch tip is an ancestor of integ HEAD AND integ is clean. */
  private async foldAssert(runId: string, n: number): Promise<boolean> {
    const run = this.mustRun(runId)
    const integ = run.integWorktree
    if (!integ) return false
    const branch = this.mustTicket(runId, n).branch ?? this.ticketBranch(runId, n)
    try {
      await gitIn(integ, ['merge-base', '--is-ancestor', branch, 'HEAD'])
    } catch {
      return false
    }
    return this.treeClean(integ)
  }

  private isCurrent(key: string, gen: number): boolean {
    return this.stepRunners.get(key)?.gen === gen
  }

  /** A step result was ACCEPTED: drop the entry first, then kill the child. */
  private accept(key: string, e: StepEntry): void {
    if (this.stepRunners.get(key) === e) this.stepRunners.delete(key)
    e.runner.kill()
  }

  /** One nudge per step; a second miss parks the ticket `needs-human`. */
  private nudgeOrPark(
    runId: string,
    n: number,
    e: StepEntry,
    nudge: string | undefined,
    parkNote: string,
  ): void {
    if (e.nudged || e.exitedDuring) {
      this.needsHuman(runId, n, e.exitedDuring ?? parkNote)
      return
    }
    e.nudged = true
    const text =
      nudge ?? `Finish the step and print your GAUNTLET line on its own line (${EXPECTED_TOKEN[e.step]}).`
    this.event(runId, n, 'status', { step: e.step, text: 'nudged: no valid GAUNTLET line yet' })
    e.runner.send(text)
  }

  /** The loss path: next builder round with the gap, or the fuse parks it. */
  private async lose(runId: string, n: number, gap: string): Promise<void> {
    const t = this.mustTicket(runId, n)
    const next = nextAfterLoss({ round: t.round }, gap)
    if (next.parked) {
      this.db.updateLoopTicket(runId, n, { lastGap: next.lastGap }, this.now())
      this.needsHuman(runId, n, `lost ${LOOP_MAX_ROUNDS} rounds; last gap: ${gap}`)
      return
    }
    this.db.updateLoopTicket(runId, n, { round: next.round, lastGap: next.lastGap }, this.now())
    this.notifyOrchestrator(runId, `[#${n}] LOSE round ${t.round}: ${gap}`)
    await this.runStep(runId, n, 'builder')
  }

  /**
   * Park a ticket `needs-human`: kill its child, drop it from the fold queue,
   * release the lane and tell the orchestrator. A ticket that was the folding one
   * aborts any half-done merge before the next fold may start.
   */
  private needsHuman(runId: string, n: number, note: string): void {
    const key = laneKey(runId, n)
    const e = this.stepRunners.get(key)
    if (e) {
      this.stepRunners.delete(key)
      e.runner.kill()
    }
    this.dequeueFold(runId, n)
    const wasFolding = this.foldInFlight.get(runId) === n
    const t = this.db.getLoopTicket(runId, n)
    if (!t) return
    this.db.updateLoopTicket(runId, n, { state: 'needs-human', note, question: null }, this.now())
    this.event(runId, n, 'status', {
      from: t.state,
      to: 'needs-human',
      step: t.step ?? undefined,
      text: note,
    })
    // Notify BEFORE releasing: the release pumps synchronously and may derive a
    // follow-up notice (e.g. "run idle") that must not precede its cause.
    this.notifyOrchestrator(runId, `[#${n}] needs-human: ${note}`)
    this.releaseLane(runId, n)
    if (wasFolding) this.track(this.settleAfterAbort(runId, n), runId)
  }

  // ---- fold mutex ------------------------------------------------------------

  /** Fold serially: claim the mutex synchronously, or queue (keeping the lane). */
  private enqueueFold(runId: string, n: number): void {
    if (this.foldInFlight.has(runId)) {
      this.queueFor(this.foldQueue, runId).push(n)
      const t = this.db.getLoopTicket(runId, n)
      const now = this.now()
      this.db.updateLoopTicket(runId, n, { state: 'folding', step: 'fold', stepStartedAt: now }, now)
      if (t && t.state !== 'folding') {
        this.event(runId, n, 'status', {
          from: t.state,
          to: 'folding',
          step: 'fold',
          text: 'queued for fold',
        })
      }
      this.scheduleBroadcast(runId)
      return
    }
    this.foldInFlight.set(runId, n)
    this.track(this.runStep(runId, n, 'fold'), runId)
  }

  /** Release the mutex for `n` and start the next queued fold. Stale settles are inert. */
  private onFoldSettled(runId: string, n: number): void {
    if (this.foldInFlight.get(runId) !== n) return
    this.foldInFlight.delete(runId)
    const next = this.foldQueue.get(runId)?.shift()
    if (next !== undefined) this.enqueueFold(runId, next)
  }

  private dequeueFold(runId: string, n: number): boolean {
    const q = this.foldQueue.get(runId)
    if (!q) return false
    const i = q.indexOf(n)
    if (i === -1) return false
    q.splice(i, 1)
    return true
  }

  /** Best-effort `git merge --abort` in integ, then settle the fold mutex. */
  private async settleAfterAbort(runId: string, n: number): Promise<void> {
    const integ = this.db.getLoopRun(runId)?.integWorktree
    if (integ) {
      try {
        await gitIn(integ, ['merge', '--abort'])
      } catch {
        // no merge in progress — nothing to abort
      }
    }
    this.onFoldSettled(runId, n)
  }

  /** The fold verified: push integ, mark done, drop the worktree, move on. */
  private async completeFold(runId: string, n: number): Promise<void> {
    const run = this.mustRun(runId)
    const repo = this.mustRepo(run)
    const integ = run.integWorktree ?? ''
    let sha: string
    try {
      sha = (await gitIn(integ, ['rev-parse', 'HEAD'])).trim()
    } catch (err) {
      this.needsHuman(runId, n, `fold bookkeeping failed: ${errMsg(err)}`)
      return
    }
    try {
      await gitIn(integ, ['push', 'origin', run.integBranch])
    } catch (err) {
      const note = `integ push failed: ${errMsg(err)}`
      this.patchRun(runId, { note })
      this.event(runId, n, 'error', { text: note })
      this.notifyOrchestrator(runId, note)
    }
    const t = this.mustTicket(runId, n)
    this.db.updateLoopTicket(
      runId,
      n,
      { state: 'done', foldSha: sha, question: null, note: null },
      this.now(),
    )
    this.event(runId, n, 'status', { from: t.state, to: 'done', step: 'fold' })
    if (t.worktree) {
      await removeWorktree(repo.path, t.worktree)
      this.db.updateLoopTicket(runId, n, { worktree: null }, this.now())
    }
    this.recompute(runId)
    this.notifyOrchestrator(runId, `[#${n}] done (folded at ${sha.slice(0, 7)})`)
    this.releaseLane(runId, n)
    this.onFoldSettled(runId, n)
    this.track(this.maybeFinalize(runId), runId)
  }

  // ---- stop / resume helpers ---------------------------------------------------

  /** Kill a ticket's step (or dequeue its fold) and return it to todo. No pump. */
  private async haltTicket(runId: string, n: number): Promise<void> {
    const key = laneKey(runId, n)
    const e = this.stepRunners.get(key)
    if (e) {
      this.stepRunners.delete(key)
      e.runner.kill()
    }
    this.dequeueFold(runId, n)
    const wasFolding = this.foldInFlight.get(runId) === n
    const t = this.mustTicket(runId, n)
    this.db.updateLoopTicket(runId, n, { state: 'todo', question: null }, this.now())
    this.event(runId, n, 'status', { from: t.state, to: 'todo', text: 'stopped' })
    this.releaseLane(runId, n, false)
    if (wasFolding) await this.settleAfterAbort(runId, n)
    this.recompute(runId)
    this.scheduleBroadcast(runId)
  }

  /** Re-run a persisted step FRESH in the ticket's existing (or recreated) worktree. */
  private async rerunStep(runId: string, n: number, step: LoopStep): Promise<void> {
    const token = this.laneToken(runId, n)
    try {
      await this.ensureIntegWorktree(runId)
      await this.ensureTicketWorktree(runId, n)
      if (this.laneToken(runId, n) !== token) return
      await this.runStep(runId, n, step)
    } catch (err) {
      if (this.laneToken(runId, n) !== token) return
      this.needsHuman(runId, n, `resume failed: ${errMsg(err)}`)
    }
  }

  private async refoldAfterResume(runId: string, ns: number[]): Promise<void> {
    try {
      await this.ensureIntegWorktree(runId)
      const integ = this.db.getLoopRun(runId)?.integWorktree
      if (integ) {
        try {
          await gitIn(integ, ['merge', '--abort'])
        } catch {
          // no interrupted merge
        }
      }
    } catch (err) {
      for (const n of ns) this.needsHuman(runId, n, `resume failed: ${errMsg(err)}`)
      return
    }
    for (const n of ns) {
      if (this.laneToken(runId, n) === undefined) continue
      this.enqueueFold(runId, n)
    }
  }

  /** Recreate the integration worktree after a restart if its dir is gone. */
  private async ensureIntegWorktree(runId: string): Promise<void> {
    const run = this.mustRun(runId)
    if (run.integWorktree && existsSync(run.integWorktree)) return
    const repo = this.mustRepo(run)
    const wt = await createWorktree(
      repo.path,
      repo.defaultBranch,
      this.worktreesDir(repo),
      runId,
      run.title,
      { branch: run.integBranch, dir: `loop-${run8(runId)}-integ` },
    )
    this.patchRun(runId, { integWorktree: wt.worktreePath })
  }

  // ---- finalize --------------------------------------------------------------

  /** Every non-skipped ticket done → scan the integ worktree → final PR or blocked. */
  private async maybeFinalize(runId: string): Promise<void> {
    const run = this.db.getLoopRun(runId)
    if (!run || (run.status !== 'running' && run.status !== 'paused')) return
    if (!this.allDone(runId)) return
    const repo = this.repoLookup(run.repoId)
    if (!repo) return
    const done = this.db.listLoopTickets(runId).filter((t) => t.state === 'done').length
    this.setRunStatus(runId, 'finalizing', { note: null })
    this.notifyOrchestrator(
      runId,
      `map complete — all ${done} ticket(s) folded; running the final security scan`,
    )

    const policy = this.policyFor(repo)
    if (policy.enabled === false) {
      this.event(runId, null, 'status', { text: 'security gate disabled for this repo — skipping scan' })
      await this.spawnFinal(runId)
      return
    }

    let raw: RawScanOutput
    try {
      raw = await this.deps.scanFactory({
        worktree: run.integWorktree ?? '',
        baseRef: repo.defaultBranch,
        policy,
        sast: true,
      })
    } catch (err) {
      if (!this.stillFinalizing(runId)) return
      if (err instanceof ScannerUnavailableError) {
        this.blockRun(runId, `security scan cannot run — ${err.message}`)
        return
      }
      this.blockRun(
        runId,
        `security scan failed to complete (scanner error) — treating as red (fail-closed): ${errMsg(err)}`,
      )
      return
    }
    if (!this.stillFinalizing(runId)) return
    if (!wellFormedScanOutput(raw.semgrep) || !wellFormedScanOutput(raw.osv)) {
      this.blockRun(runId, 'security scan produced unparseable output — treating as red (fail-closed)')
      return
    }
    const findings = normalizeFindings(parseSemgrep(raw.semgrep), parseOsv(raw.osv))
    const { verdict, blocking } = evaluateThreshold(findings, policy)
    if (verdict === 'fail') {
      this.blockRun(
        runId,
        `security scan red — ${blocking.length} blocking finding(s)`,
        formatFindingsForAgent(blocking),
      )
      return
    }
    this.event(runId, null, 'status', { text: 'security scan passed — no blocking findings' })
    await this.spawnFinal(runId)
  }

  private stillFinalizing(runId: string): boolean {
    return this.db.getLoopRun(runId)?.status === 'finalizing'
  }

  /** At least one ticket is done and every non-skipped ticket is done. */
  private allDone(runId: string): boolean {
    const live = this.db.listLoopTickets(runId).filter((t) => t.state !== 'skipped')
    return live.some((t) => t.state === 'done') && live.every((t) => t.state === 'done')
  }

  /**
   * A `finalizing` run whose map has open work again (a ticket was added during
   * the scan or the final PR) goes back to `running`: the final PR must carry the
   * whole map. A scan that resolves afterwards sees the status change and is
   * ignored; a live final-PR agent is killed.
   */
  private reopenIfIncomplete(runId: string): void {
    if (!this.stillFinalizing(runId) || this.allDone(runId)) return
    this.killFinal(runId)
    this.setRunStatus(runId, 'running', { note: 'finalize cancelled: the map has open tickets again' })
  }

  private blockRun(runId: string, note: string, detail?: string): void {
    this.killFinal(runId)
    this.setRunStatus(runId, 'blocked', { note })
    this.event(runId, null, 'error', { text: note })
    this.notifyOrchestrator(runId, detail ? `run blocked: ${note}\n${detail}` : `run blocked: ${note}`)
  }

  private async spawnFinal(runId: string): Promise<void> {
    const run = this.mustRun(runId)
    const repo = this.repoLookup(run.repoId)
    if (!repo || !run.integWorktree) {
      this.blockRun(runId, 'final PR cannot start: the integration worktree is missing')
      return
    }
    let slug: string
    try {
      slug = await this.slugFor(run)
    } catch (err) {
      this.blockRun(runId, `final PR cannot start: ${errMsg(err)}`)
      return
    }
    if (!this.stillFinalizing(runId)) return
    const done = this.db
      .listLoopTickets(runId)
      .filter((t) => t.state === 'done')
      .sort((a, b) => a.number - b.number)
      .map((t) => ({ number: t.number, title: t.title }))
    const prompt = finalPrKickoff({
      repoSlug: slug,
      defaultBranch: repo.defaultBranch,
      integBranch: run.integBranch,
      epic: run.epic,
      epicTitle: run.title,
      done,
      style: this.style,
    })
    const profile = STEP_PROFILES.final
    const gen = ++this.seq
    const key = `${runId}:final`
    let runner: RunnerLike
    try {
      runner = this.deps.runnerFactory(
        { cwd: run.integWorktree, model: profile.model, effort: profile.effort, systemPrompt: prompt.system },
        this.finalCallbacks(runId, gen, slug),
      )
    } catch (err) {
      this.blockRun(runId, `final PR agent spawn failed: ${errMsg(err)}`)
      return
    }
    this.finalRunners.set(key, { runner, gen, turnText: '', nudged: false })
    this.event(runId, null, 'status', { text: 'final PR agent started' })
    runner.send(prompt.kickoff)
  }

  private finalCallbacks(runId: string, gen: number, slug: string): RunnerCallbacks {
    const key = `${runId}:final`
    const current = (): FinalEntry | undefined => {
      const e = this.finalRunners.get(key)
      return e && e.gen === gen ? e : undefined
    }
    return {
      onSession: () => {},
      onPartial: () => {},
      onSubagentResult: () => {},
      onToolUse: (name, summary) => {
        if (!current()) return
        this.event(runId, null, 'activity', { tool: name, summary })
      },
      onAssistantText: (text) => {
        const e = current()
        if (!e) return
        e.turnText = e.turnText ? `${e.turnText}\n${text}` : text
      },
      onResult: (text, isError, usage) => {
        const e = current()
        if (!e) return
        if (usage) this.addUsage(runId, null, usage)
        const turn = `${e.turnText}\n${text}`
        e.turnText = ''
        const url = isError ? undefined : this.prUrlFor(turn, slug)
        if (url) {
          this.completeRun(runId, url)
          return
        }
        if (!e.nudged) {
          e.nudged = true
          e.runner.send('Finish the step: open the PR as instructed and print the PR URL on its own line.')
          return
        }
        this.blockRun(runId, 'final PR agent printed no PR URL after a nudge')
      },
      onExit: (code, signal) => {
        if (!current()) return
        this.finalRunners.delete(key)
        this.blockRun(runId, `final PR agent exited unexpectedly (code ${code ?? signal ?? 'null'})`)
      },
      onSpawnError: (err) => {
        if (!current()) return
        this.finalRunners.delete(key)
        this.blockRun(runId, `final PR agent spawn failed: ${err.message}`)
      },
    }
  }

  /**
   * The run's PR URL from a final-PR turn. Read like `parseStepResult`'s `prUrl`
   * (fenced code stripped, the LAST URL wins), but only a URL of THIS run's repo
   * counts: the agent may quote another repo's PR (prior art, a dependency), and
   * accepting that would complete the run with somebody else's PR attached.
   */
  private prUrlFor(text: string, slug: string): string | undefined {
    const want = `https://github.com/${slug}/pull/`.toLowerCase()
    const ours = (stripFencedCode(text).match(PR_RE_G) ?? []).filter((u) =>
      u.toLowerCase().startsWith(want),
    )
    return ours[ours.length - 1]
  }

  private completeRun(runId: string, prUrl: string): void {
    this.killFinal(runId)
    this.patchRun(runId, { prUrl })
    this.setRunStatus(runId, 'complete', { note: null })
    this.chatLine(runId, { role: 'loop', text: `run complete: ${prUrl}` })
    // Finished runs hold no process; a later chat respawns the orchestrator.
    this.killOrchestrator(runId)
    this.scheduleBroadcast(runId)
  }

  private killFinal(runId: string): void {
    const key = `${runId}:final`
    const e = this.finalRunners.get(key)
    if (!e) return
    this.finalRunners.delete(key)
    e.runner.kill()
  }

  // ---- orchestrator ----------------------------------------------------------

  /** Spawn the run's orchestrator unless one is alive (or already spawning). */
  private ensureOrchestrator(runId: string, withRecap: boolean): Promise<void> {
    if (this.orchestrators.has(runId)) return Promise.resolve()
    const pending = this.orchSpawning.get(runId)
    if (pending) return pending
    const p = this.spawnOrchestrator(runId, withRecap).finally(() => {
      this.orchSpawning.delete(runId)
    })
    this.orchSpawning.set(runId, p)
    return p
  }

  private async spawnOrchestrator(runId: string, withRecap: boolean): Promise<void> {
    const run = this.db.getLoopRun(runId)
    if (!run || run.status === 'archived') return
    const repo = this.repoLookup(run.repoId)
    if (!repo) {
      this.event(runId, null, 'error', { text: `orchestrator cannot start: unknown repo ${run.repoId}` })
      return
    }
    let slug: string
    try {
      slug = await this.slugFor(run)
    } catch (err) {
      this.event(runId, null, 'error', { text: `orchestrator cannot start: ${errMsg(err)}` })
      return
    }
    if (this.orchestrators.has(runId)) return
    const fresh = this.db.getLoopRun(runId)
    if (!fresh || fresh.status === 'archived') return
    const ctx: OrchestratorCtx = {
      runId,
      repoId: fresh.repoId,
      repoSlug: slug,
      defaultBranch: repo.defaultBranch,
      epic: fresh.epic,
      epicTitle: fresh.title,
      integBranch: fresh.integBranch,
      apiBase: this.deps.apiBase,
      style: this.style,
    }
    // Anything still in the outbox (e.g. the notice that triggered a lazy
    // respawn) is delivered as its own `[loop event]` turn once the kickoff
    // turn ends — the spawn starts busy, and the outbox flushes on `onResult`.
    const kickoff = orchestratorKickoff(ctx, withRecap ? this.buildRecap(runId) : undefined)
    const profile = STEP_PROFILES.orchestrator
    const gen = ++this.seq
    let runner: RunnerLike
    try {
      runner = this.deps.runnerFactory(
        {
          cwd: fresh.integWorktree ?? repo.path,
          model: profile.model,
          effort: profile.effort,
          systemPrompt: loopOrchestratorPrompt(ctx),
        },
        this.orchCallbacks(runId, gen),
      )
    } catch (err) {
      this.event(runId, null, 'error', { text: `orchestrator spawn failed: ${errMsg(err)}` })
      return
    }
    this.orchestrators.set(runId, { runner, gen, busy: true, turnText: '' })
    runner.send(kickoff)
    this.scheduleBroadcast(runId)
  }

  private orchCallbacks(runId: string, gen: number): RunnerCallbacks {
    const current = (): OrchEntry | undefined => {
      const e = this.orchestrators.get(runId)
      return e && e.gen === gen ? e : undefined
    }
    const dead = (why: string): void => {
      if (!current()) return
      this.orchestrators.delete(runId)
      this.event(runId, null, 'error', { text: why })
      this.scheduleBroadcast(runId)
    }
    return {
      onSession: () => {},
      onSubagentResult: () => {},
      onPartial: (text) => {
        if (!current()) return
        this.broadcast({ type: 'loop-partial', runId, text })
      },
      onAssistantText: (text) => {
        const e = current()
        if (!e) return
        e.turnText = e.turnText ? `${e.turnText}\n${text}` : text
      },
      onToolUse: (name, summary) => {
        if (!current()) return
        this.chatLine(runId, { role: 'tool', tool: name, summary })
      },
      onResult: (text, _isError, usage) => {
        const e = current()
        if (!e) return
        const reply = text.trim() || e.turnText.trim()
        e.turnText = ''
        if (reply) this.chatLine(runId, { role: 'orchestrator', text: reply })
        if (usage) this.addUsage(runId, null, usage)
        e.busy = false
        this.flushOutbox(runId)
        this.scheduleBroadcast(runId)
      },
      onExit: (code, signal) => dead(`orchestrator exited (code ${code ?? signal ?? 'null'})`),
      onSpawnError: (err) => dead(`orchestrator spawn failed: ${err.message}`),
    }
  }

  /** Queue a loop event for the orchestrator; flush now if it is idle. */
  private notifyOrchestrator(runId: string, line: string): void {
    const run = this.db.getLoopRun(runId)
    if (!run || run.status === 'archived') return
    this.chatLine(runId, { role: 'loop', text: line })
    this.queueFor(this.pendingNotes, runId).push(line)
    if (this.orchestrators.has(runId)) {
      this.flushOutbox(runId)
      return
    }
    if (run.status === 'complete' || run.status === 'stale') return
    this.track(this.ensureOrchestrator(runId, true), runId)
  }

  /** Idle only: ONE message — operator texts first, then a `[loop event]` block. */
  private flushOutbox(runId: string): void {
    const o = this.orchestrators.get(runId)
    if (!o || o.busy) return
    const ops = this.pendingOps.get(runId) ?? []
    const notes = this.pendingNotes.get(runId) ?? []
    if (!ops.length && !notes.length) return
    this.pendingOps.delete(runId)
    this.pendingNotes.delete(runId)
    const parts = [...ops]
    if (notes.length) parts.push(['[loop event]', ...notes.map((l) => `- ${l}`)].join('\n'))
    o.busy = true
    o.runner.send(parts.join('\n\n'))
    this.scheduleBroadcast(runId)
  }

  private killOrchestrator(runId: string): void {
    const o = this.orchestrators.get(runId)
    this.pendingNotes.delete(runId)
    this.pendingOps.delete(runId)
    if (!o) return
    this.orchestrators.delete(runId)
    o.runner.kill()
  }

  /** The respawn context: run facts, the ticket table and the last chat lines. */
  private buildRecap(runId: string): string {
    const run = this.mustRun(runId)
    const chat = this.db
      .listLoopEvents(runId, { kind: 'chat', limit: RECAP_CHAT_LINES })
      .map((e) => `${e.payload.role ?? 'loop'}: ${e.payload.text ?? e.payload.summary ?? ''}`)
    return orchestratorRecap({ run, tickets: this.derivedTickets(runId), chat, apiBase: this.deps.apiBase })
  }

  // ---- persistence helpers ---------------------------------------------------

  private now(): string {
    return (this.deps.clock?.() ?? new Date()).toISOString()
  }

  /**
   * Track a fire-and-forget job so `whenIdle()` can await it. A rejection is
   * never unhandled: with a run id it is recorded as that run's `error` event.
   */
  private track(p: Promise<unknown>, runId?: string): void {
    const t: Promise<void> = p.then(
      () => undefined,
      (err: unknown) => {
        // Fire-and-forget work has no caller to surface to: always log it, and
        // also record it on the run's event stream when there is a run.
        this.deps.log?.error({ err, runId }, 'loop background job failed')
        if (!runId) return
        try {
          this.event(runId, null, 'error', { text: `internal error: ${errMsg(err)}` })
        } catch {
          // the DB itself is failing — nothing more to record
        }
      },
    )
    this.tracked.add(t)
    void t.finally(() => this.tracked.delete(t))
  }

  private event(
    runId: string,
    ticket: number | null,
    kind: LoopEventKind,
    payload: LoopEventPayload,
  ): LoopEvent {
    const event = this.db.insertLoopEvent(runId, ticket, kind, payload, this.now())
    this.broadcast({ type: 'loop-event', runId, event })
    return event
  }

  private chatLine(runId: string, payload: LoopEventPayload): void {
    this.event(runId, null, 'chat', payload)
  }

  private addUsage(runId: string, ticket: number | null, usage: ResultUsage): void {
    this.db.addLoopUsage(runId, ticket, usage, this.now())
    this.scheduleBroadcast(runId)
  }

  private patchRun(runId: string, patch: LoopRunPatch, broadcast = true): void {
    this.db.updateLoopRun(runId, patch, this.now())
    if (broadcast) this.scheduleBroadcast(runId)
  }

  private setRunStatus(
    runId: string,
    to: LoopRunStatus,
    extra: { note?: string | null; prevStatus?: LoopRunStatus | null; broadcast?: boolean } = {},
  ): void {
    const run = this.db.getLoopRun(runId)
    if (!run) return
    const patch: LoopRunPatch = { status: to }
    if (extra.note !== undefined) patch.note = extra.note
    if (extra.prevStatus !== undefined) patch.prevStatus = extra.prevStatus
    this.patchRun(runId, patch, extra.broadcast ?? true)
    this.event(runId, null, 'status', { from: run.status, to, text: extra.note ?? undefined })
  }

  private insertTicket(runId: string, gt: GhTicket, blockedBy: number[], now: string): void {
    this.db.upsertLoopTicket({
      runId,
      number: gt.number,
      title: gt.title,
      body: gt.body,
      url: gt.url,
      ghState: gt.state,
      blockedBy,
      bar: parseBar(gt.body),
      state: gt.state === 'closed' ? 'done' : 'todo',
      step: null,
      round: 0,
      lastGap: null,
      branch: null,
      worktree: null,
      foldSha: null,
      question: null,
      note: null,
      usage: { ...ZERO_USAGE },
      startedAt: null,
      stepStartedAt: null,
      updatedAt: now,
    })
  }

  /**
   * Drop blockers outside the map whose issue is closed (they are satisfied).
   * Nothing else about out-of-map blockers is persisted: one that survives here
   * is open or of unknown state, and `deriveStates` (given no external map)
   * treats every out-of-map blocker as blocking — exactly that meaning.
   */
  private stripClosedExternal(
    blockedBy: number[],
    inMap: Set<number>,
    external: Record<number, LoopGhState>,
  ): number[] {
    return [...new Set(blockedBy)].filter((b) => inMap.has(b) || external[b] !== 'closed')
  }

  private derivedTickets(runId: string): LoopTicket[] {
    return deriveStates(this.db.listLoopTickets(runId))
  }

  /** Persist derived todo/blocked states. */
  private recompute(runId: string): void {
    const now = this.now()
    const stored = new Map(this.db.listLoopTickets(runId).map((t) => [t.number, t.state]))
    for (const t of this.derivedTickets(runId)) {
      if (stored.get(t.number) !== t.state) this.db.updateLoopTicket(runId, t.number, { state: t.state }, now)
    }
  }

  /** In flight = holds a lane, has a live child, or waits on the fold mutex. */
  private inFlight(runId: string, t: LoopTicket): boolean {
    const key = laneKey(runId, t.number)
    const queued = this.foldQueue.get(runId)?.includes(t.number) ?? false
    return this.pool.has(key) || this.stepRunners.has(key) || queued
  }

  private queueFor<T>(map: Map<string, T[]>, runId: string): T[] {
    let q = map.get(runId)
    if (!q) {
      q = []
      map.set(runId, q)
    }
    return q
  }

  private ticketOfKey(runId: string, key: string): number | undefined {
    const prefix = `${runId}:`
    if (!key.startsWith(prefix)) return undefined
    const n = Number(key.slice(prefix.length))
    return Number.isInteger(n) ? n : undefined
  }

  private ticketBranch(runId: string, n: number): string {
    return `gauntlet/${run8(runId)}/t${n}`
  }

  private worktreesDir(repo: RepoTarget): string {
    return path.join(repo.path, 'worktrees')
  }

  private async slugFor(run: LoopRun): Promise<string> {
    const cached = this.slugs.get(run.id)
    if (cached) return cached
    const repo = this.mustRepo(run)
    const slug = await this.slugOf(repo.path)
    if (!slug) throw new LoopError(400, `repo ${repo.id} has no GitHub origin remote`)
    this.slugs.set(run.id, slug)
    return slug
  }

  private scheduleBroadcast(runId: string): void {
    if (this.coalesceMs <= 0) {
      this.broadcastView(runId)
      return
    }
    if (this.bcastTimers.has(runId)) return
    const timer = setTimeout(() => {
      this.bcastTimers.delete(runId)
      this.broadcastView(runId)
    }, this.coalesceMs)
    timer.unref?.()
    this.bcastTimers.set(runId, timer)
  }

  private broadcastView(runId: string): void {
    const run = this.db.getLoopRun(runId)
    if (!run || run.status === 'archived') return
    this.broadcast({ type: 'loop', run: this.view(runId) })
  }

  // ---- lookups / validation --------------------------------------------------

  private mustRun(runId: string): LoopRun {
    const run = this.db.getLoopRun(runId)
    if (!run) throw new LoopError(404, `unknown loop run: ${runId}`)
    return run
  }

  /** A run that exists and is not archived (archived runs accept no actions). */
  private mustLiveRun(runId: string): LoopRun {
    const run = this.mustRun(runId)
    if (run.status === 'archived') throw new LoopError(409, 'run is archived')
    return run
  }

  private mustTicket(runId: string, n: number): LoopTicket {
    const t = this.db.getLoopTicket(runId, n)
    if (!t) throw new LoopError(404, `unknown ticket #${n} in run ${runId}`)
    return t
  }

  private mustRepo(run: LoopRun): RepoTarget {
    const repo = this.repoLookup(run.repoId)
    if (!repo) throw new LoopError(400, `unknown repo: ${run.repoId}`)
    return repo
  }

  private assertLaneCount(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > LOOP_MAX_LANES) {
      throw new LoopError(400, `lanes must be an integer 0..${LOOP_MAX_LANES}`)
    }
  }

  private assertIssueNumber(n: number): void {
    if (!Number.isInteger(n) || n <= 0) throw new LoopError(400, 'issue number must be a positive integer')
  }
}
