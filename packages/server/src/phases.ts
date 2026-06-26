import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { config, repoById } from './config.js'
import type { Db, TaskPatch } from './db.js'
import { Runner, type ResultUsage } from './runner.js'
import { createWorktree, removeWorktree, syncLocalAfterMerge } from './worktree.js'
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_STYLE,
  type Task,
  type TaskStatus,
  type EventKind,
  type EventPayload,
  type WsEvent,
  type EffortLevel,
  type CaveStyle,
} from './types.js'

// ---- detection ----
const READY_RE = /^\s*ZMRNG_READY\s*$/m
const PLAN_READY_RE = /^\s*ZMRNG_PLAN_READY\b(.*)$/m
const VALIDATING_RE = /^\s*ZMRNG_VALIDATING\s*$/m
const BLOCKED_RE = /^\s*ZMRNG_BLOCKED\s*:?\s*(.*)$/m
const PR_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/

const MODELS: readonly string[] = ['opus', 'sonnet']
const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Decision emitted by the planning child via the `ZMRNG_PLAN_READY` token. */
interface PlanDecision {
  model: string
  effort: EffortLevel
  planPath: string | null
}

/** Parse the trailing `key=value` params of a `ZMRNG_PLAN_READY` line. */
function parsePlanDecision(text: string): PlanDecision | undefined {
  const m = text.match(PLAN_READY_RE)
  if (!m) return undefined
  const params = m[1] ?? ''
  const model = /\bmodel=(\S+)/.exec(params)?.[1]
  const effort = /\beffort=(\S+)/.exec(params)?.[1]
  const planPath = /\bplan=(\S+)/.exec(params)?.[1]
  return {
    model: model && MODELS.includes(model) ? model : 'opus',
    effort: effort && EFFORTS.includes(effort as EffortLevel) ? (effort as EffortLevel) : 'high',
    planPath: planPath ?? null,
  }
}

function extractPrUrl(text: string): string | undefined {
  return text.match(PR_RE)?.[0]
}
function now(): string {
  return new Date().toISOString()
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---- phase prompts ----

/** Map a CaveStyle to the `caveman` skill's intensity argument (`/caveman <arg>`). */
const CAVEMAN_SKILL_ARG: Record<Exclude<CaveStyle, 'normal'>, string> = {
  'caveman-lite': 'lite',
  'caveman-full': 'full',
  'caveman-ultra': 'ultra',
  'wenyan-full': 'wenyan-full',
}

/** Per-level caveman register rules — used as a fallback if the skill is unavailable. */
const CAVEMAN_RULES: Record<Exclude<CaveStyle, 'normal'>, string> = {
  'caveman-lite':
    'Drop filler and hedging. Keep articles and full sentences. Tight and professional.',
  'caveman-full':
    'Drop articles (a/an/the) and filler. Fragments OK. Short synonyms. Pattern: [thing] [action] [reason]. Keep technical terms exact.',
  'caveman-ultra':
    'Drop articles/filler/conjunctions. Abbreviate (DB/auth/config/fn/impl). Arrows for causality (X → Y). One word when one word enough. Technical terms exact.',
  'wenyan-full':
    'Respond in terse Classical Chinese (文言文) register. ~80% character reduction. Keep all technical terms, code, identifiers, and commands verbatim in their original language.',
}

/**
 * Communication-style block appended to the system prompt for non-`normal` styles.
 * Directs the worker to actually invoke the `caveman` skill (equivalent to the
 * operator running `/caveman <level>`); the register rules remain only as a
 * fallback for environments where that skill is not installed.
 */
function styleDirective(style: CaveStyle): string {
  if (style === 'normal') return ''
  const arg = CAVEMAN_SKILL_ARG[style]
  return [
    '',
    'COMMUNICATION STYLE:',
    `Your VERY FIRST action this session — before clarifying questions or any other output — MUST be to invoke the \`caveman\` skill at "${arg}" intensity (the Skill tool with skill "caveman" and args "${arg}", equivalent to the operator running \`/caveman ${arg}\`).`,
    'Apply that caveman register to ALL narration, status updates, clarify questions, and streamed log for the rest of the session.',
    'EXCEPTION: write code, commit messages, PR titles/bodies, and plan files in normal, clear, professional English (never caveman).',
    `Fallback if the caveman skill is unavailable: ${CAVEMAN_RULES[style]}`,
  ].join('\n')
}

/** One-line summary of the controls applied to a worker, for the operator log. */
function settingsNote(model: string, effort: EffortLevel, style: CaveStyle): string {
  const styleDesc =
    style === 'normal' ? 'normal (no caveman skill)' : `${style} → /caveman ${CAVEMAN_SKILL_ARG[style]}`
  return `settings — model=${model} · effort=${effort} · style=${styleDesc}`
}

function systemPrompt(
  branch: string,
  repoPath: string,
  defaultBranch: string,
  style: CaveStyle,
): string {
  return [
    `You are a zmrng autonomous worker operating on the target repository at \`${repoPath}\`.`,
    `You are running inside a dedicated git worktree ALREADY checked out on the fresh branch \`${branch}\`, cut from the repo's default branch (${defaultBranch}).`,
    `NEVER switch to or commit on \`${defaultBranch}\`/\`main\`/\`master\`. NEVER create or switch to a different branch — use the branch you are already on.`,
    "Obey the target repository's CLAUDE.md and every rule under its .claude/rules/. Follow that repo's own conventions, types, and design tokens. Any repo security hooks remain active (they block .env access, force-push, and recursive deletes) — respect them.",
    '',
    'You run inside a PIV pipeline (clarify → plan → execute), one phase per session, each handed off by an orchestrator. You signal phase completion by printing a CONTROL TOKEN on its own line; the orchestrator watches for it. Only emit the token for your current phase:',
    '- ZMRNG_READY — clarify phase complete.',
    '- ZMRNG_PLAN_READY model=<opus|sonnet> effort=<low|medium|high|xhigh|max> plan=<relative path to the plan file> — plan phase complete.',
    '- ZMRNG_VALIDATING — execute phase has moved from implementation into the QA/review/docs chain.',
    '- ZMRNG_BLOCKED: <reason> — you need a subagent that is missing from this repo; stop and wait for the operator to add it and resume you.',
    styleDirective(style),
  ].join('\n')
}

function clarifyKickoff(task: Task): string {
  return [
    `Task title: ${task.title}`,
    `Task details: ${task.body}`,
    'CLARIFY PHASE: ask the operator the questions you need to scope this task, in small batches. Do NOT write code or a plan yet. When you have enough to plan and implement fully autonomously, output the exact token ZMRNG_READY on its own line, followed by a one-paragraph scope summary.',
  ].join('\n')
}

function planKickoff(task: Task, transcript: string): string {
  return [
    'PLAN PHASE. The clarify phase is complete; this is a fresh session. Do NOT implement anything in this phase.',
    `Task title: ${task.title}`,
    `Task details: ${task.body}`,
    '',
    'Agreed scope from the clarify conversation:',
    transcript || '(no transcript captured — work from the task title/details)',
    '',
    'Steps:',
    '1. Run the `/core_piv_loop:plan-feature` workflow for this task and write the resulting plan to `.agents/plans/<kebab-case-name>.md` within THIS repository.',
    '2. Have a subagent QA the plan: invoke the `code-reviewer` agent (fall back to `qa`) to review the plan for soundness against the task and the repo conventions. If it finds the plan unsound, revise the plan and re-QA. Do AT MOST 2 revise+re-QA rounds, then proceed regardless.',
    '3. Assess complexity and choose the execute-phase model and effort: use `opus` for non-trivial/architectural/multi-file work and `sonnet` only for simple, mechanical changes; effort defaults to `high`, raise to `xhigh`/`max` for genuinely complex work and drop to `medium` only for trivial work.',
    'When the plan is written and QA is complete, output on its own line exactly:',
    'ZMRNG_PLAN_READY model=<opus|sonnet> effort=<low|medium|high|xhigh|max> plan=<relative path to the plan file>',
    'If a required QA subagent is missing from this repo, output `ZMRNG_BLOCKED: <agent name> not available` on its own line and stop.',
  ].join('\n')
}

function executeKickoff(
  branch: string,
  defaultBranch: string,
  planPath: string | null,
): string {
  const planRef = planPath ?? '.agents/plans/ (the plan you just wrote in the planning phase)'
  return [
    'EXECUTE PHASE. This is a fresh session; implement the plan now, fully autonomously, with no further questions.',
    `You are already on branch \`${branch}\` in this worktree — do NOT create or switch branches (ignore any "create a feature branch" step in the execute workflow).`,
    `Run the \`/core_piv_loop:execute ${planRef}\` workflow against that plan.`,
    'Route work to specialists as needed: frontend work (React/CSS/web) → the `frontend-specialist` agent; backend work (Fastify/runner/phases/SQLite/server) → the `backend-specialist` agent.',
    'After implementation, BEFORE committing, print ZMRNG_VALIDATING on its own line, then run this chain in order (best-effort — skip a step only if its agent is genuinely unavailable):',
    '  1. `qa` agent — run validation (typecheck/lint/build) and report PASS/FAIL; fix every failure (route fixes to the right specialist).',
    '  2. `code-reviewer` agent — review the changes against the plan; address its findings.',
    '  3. `doc-updater` agent (or the `sync-docs` skill) — sync the docs to the changes.',
    'If any required agent above is missing from this repo, output `ZMRNG_BLOCKED: <agent name> not available` on its own line and STOP — wait for the operator to add it and resume you; then continue the chain.',
    'Finally:',
    '- Ensure `npm run typecheck && npm run lint && npm run build` all pass — fix every failure.',
    '- MANDATORY before committing: run the `sync-docs` skill (the Skill tool with skill "sync-docs", equivalent to the operator running `/sync-docs`) to bring this repo\'s documentation in sync with your changes, and stage any docs it updates. Do this even if the doc step in the QA chain above already ran. Skip only if the skill is genuinely unavailable in this repo.',
    '- Commit with a descriptive Conventional Commit message.',
    `- Push the branch: git push -u origin ${branch}`,
    `- Open a PR: gh pr create --fill --base ${defaultBranch} --head ${branch}`,
    'Then output the PR URL on its own line.',
  ].join('\n')
}

export class TaskManager {
  private runners = new Map<string, Runner>()
  /** Tasks holding an autonomous lane (held from planning through to the PR). */
  private executeLanes = new Set<string>()
  private executeQueue: string[] = []
  /** Task ids whose child is being intentionally killed for a phase handoff. */
  private replacing = new Set<string>()
  /** Status to restore when a `blocked` task is resumed. */
  private blockedFrom = new Map<string, TaskStatus>()
  /** Tasks whose current turn was hard-interrupted; suppress the result's fail logic. */
  private interrupting = new Set<string>()

  constructor(
    private db: Db,
    private broadcast: (e: WsEvent) => void,
  ) {}

  // ---- helpers ----

  private emitEvent(taskId: string, kind: EventKind, payload: EventPayload): void {
    const event = this.db.insertEvent(taskId, kind, payload, now())
    this.broadcast({ type: 'event', taskId, event })
  }

  private patch(taskId: string, patch: TaskPatch): Task | undefined {
    const task = this.db.updateTask(taskId, patch, now())
    if (task) this.broadcast({ type: 'task', task })
    return task
  }

  private transition(taskId: string, to: TaskStatus, note?: string): void {
    const before = this.db.getTask(taskId)
    if (!before) return
    this.patch(taskId, { status: to })
    this.emitEvent(taskId, 'status', { sub: 'status', from: before.status, to, note })
  }

  private fail(taskId: string, note: string): void {
    this.emitEvent(taskId, 'error', { sub: 'error', text: note })
    this.runners.get(taskId)?.kill()
    this.runners.delete(taskId)
    this.blockedFrom.delete(taskId)
    this.interrupting.delete(taskId)
    this.freeLane(taskId)
    this.transition(taskId, 'failed', note)
  }

  /** Release an autonomous lane (idempotent) and promote the next queued task. */
  private freeLane(taskId: string): void {
    if (!this.executeLanes.delete(taskId)) return
    const next = this.executeQueue.shift()
    if (!next) return
    const task = this.db.getTask(next)
    // A queued task is parked in `planning`; promote it by starting its plan child.
    if (task && task.status === 'planning') {
      this.executeLanes.add(task.id)
      this.beginPlan(task)
    }
  }

  /** Intentionally kill a task's current child for a phase handoff (no crash-fail). */
  private replaceChild(taskId: string): void {
    const runner = this.runners.get(taskId)
    if (!runner) return
    this.replacing.add(taskId)
    runner.kill()
    this.runners.delete(taskId)
  }

  // ---- spawn / event wiring ----

  private spawn(
    task: Task,
    model: string,
    effort: EffortLevel,
    style: CaveStyle,
    cwd: string,
    branch: string,
    repoPath: string,
    defaultBranch: string,
  ): void {
    const runner = new Runner(
      {
        cwd,
        model,
        effort,
        systemPrompt: systemPrompt(branch, repoPath, defaultBranch, style),
      },
      {
        onSession: (sessionId) => {
          this.patch(task.id, { sessionId })
          this.emitEvent(task.id, 'claude', { sub: 'init', sessionId, model })
        },
        onAssistantText: (text) => this.onAssistant(task.id, text),
        onPartial: (text) => this.broadcast({ type: 'partial', taskId: task.id, text }),
        onResult: (text, isError, usage) => this.onResult(task.id, text, isError, usage),
        onToolUse: (name, summary, isSubagent, subagentType) =>
          this.emitEvent(task.id, 'claude', {
            sub: isSubagent ? 'subagent' : 'tool',
            tool: name,
            summary,
            subagentType,
            actor: isSubagent ? (subagentType ?? 'subagent') : 'main',
          }),
        onSubagentResult: (subagentType, summary, isError) =>
          this.emitEvent(task.id, 'claude', {
            sub: 'subagent_result',
            subagentType,
            actor: subagentType,
            summary,
            isError,
          }),
        onExit: (code) => this.onExit(task.id, code),
        onSpawnError: (err) => {
          this.fail(task.id, `failed to spawn claude: ${err.message}`)
        },
      },
    )
    this.runners.set(task.id, runner)
  }

  private onAssistant(taskId: string, text: string): void {
    this.emitEvent(taskId, 'claude', { sub: 'assistant', text })
    this.detect(taskId, text, false, false)
  }

  private onResult(
    taskId: string,
    text: string,
    isError: boolean,
    usage: ResultUsage | undefined,
  ): void {
    this.emitEvent(taskId, 'claude', { sub: 'result', text, isError })
    if (usage) {
      const updated = this.db.addUsage(taskId, usage, now())
      if (updated) this.broadcast({ type: 'task', task: updated })
    }
    this.detect(taskId, text, isError, true)
  }

  /** Inspect a chunk of worker output for control tokens and drive the state machine. */
  private detect(taskId: string, text: string, isError: boolean, isResult: boolean): void {
    const task = this.db.getTask(taskId)
    if (!task) return
    // A hard-interrupted turn ends with a `result` that may carry is_error / no PR;
    // consume the flag and short-circuit so the failure detector can't fail the task.
    // (Assistant chunks while interrupting fall through normally.)
    if (isResult && this.interrupting.has(taskId)) {
      this.interrupting.delete(taskId)
      this.emitEvent(taskId, 'status', { sub: 'status', note: 'turn interrupted — awaiting your direction' })
      return
    }
    const active =
      task.status === 'planning' ||
      task.status === 'executing' ||
      task.status === 'validating'

    // Blocked takes priority: the worker is stopping for a missing subagent.
    if (active && BLOCKED_RE.test(text)) {
      const reason = text.match(BLOCKED_RE)?.[1]?.trim()
      this.onBlocked(task, reason || 'a required subagent is missing')
      return
    }
    if (task.status === 'clarify' && READY_RE.test(text)) {
      this.onReady(task)
      return
    }
    if (task.status === 'planning' && PLAN_READY_RE.test(text)) {
      const decision = parsePlanDecision(text)
      if (decision) this.onPlanReady(task, decision)
      return
    }
    if (task.status === 'executing' && VALIDATING_RE.test(text)) {
      this.transition(taskId, 'validating', 'QA/review/docs chain started')
      return
    }
    const pr = extractPrUrl(text)
    if (pr && (task.status === 'executing' || task.status === 'validating') && !task.prUrl) {
      this.onPr(task, pr)
      return
    }
    // An execute turn that ended in error without producing a PR has failed.
    if (
      (task.status === 'executing' || task.status === 'validating') &&
      isError &&
      !task.prUrl
    ) {
      this.fail(taskId, 'execute turn ended with an error before a PR was opened')
    }
  }

  /** Spawn a fresh child for an autonomous phase (plan/execute) on a worktree. */
  private spawnPhase(task: Task, model: string, effort: EffortLevel): boolean {
    const repo = repoById(task.repoId)
    if (!repo || !task.worktree || !task.branch) {
      this.fail(task.id, 'cannot spawn phase: missing worktree/branch/repo')
      return false
    }
    const style = task.style ?? DEFAULT_STYLE
    this.spawn(task, model, effort, style, task.worktree, task.branch, repo.path, repo.defaultBranch)
    return true
  }

  private onReady(task: Task): void {
    this.emitEvent(task.id, 'status', { sub: 'status', note: 'ZMRNG_READY detected' })
    // Hand off the clarify session for a fresh planning session.
    this.replaceChild(task.id)
    this.transition(task.id, 'planning')
    if (this.executeLanes.size < config.maxLanes) {
      this.executeLanes.add(task.id)
      const fresh = this.db.getTask(task.id)
      if (fresh) this.beginPlan(fresh)
    } else {
      this.patch(task.id, { queued: true })
      this.executeQueue.push(task.id)
      this.emitEvent(task.id, 'status', {
        sub: 'status',
        note: `queued — ${this.executeLanes.size}/${config.maxLanes} lanes busy`,
      })
    }
  }

  /** Start a fresh planning child (always opus/high) seeded with the clarify transcript. */
  private beginPlan(task: Task): void {
    this.patch(task.id, { queued: false })
    if (!this.spawnPhase(task, 'opus', 'high')) return
    this.emitEvent(task.id, 'status', {
      sub: 'status',
      note: 'plan phase — fresh session (opus · high), running /core_piv_loop:plan-feature',
    })
    this.runners.get(task.id)?.send(planKickoff(task, this.clarifyTranscript(task.id)))
  }

  /** Plan written + QA'd; hand off to a fresh execute child on the chosen model/effort. */
  private onPlanReady(task: Task, decision: PlanDecision): void {
    this.emitEvent(task.id, 'status', {
      sub: 'status',
      note: `plan ready — execute on ${decision.model} · ${decision.effort}`,
    })
    this.replaceChild(task.id)
    const updated =
      this.patch(task.id, {
        model: decision.model,
        effort: decision.effort,
        planPath: decision.planPath,
      }) ?? task
    this.transition(task.id, 'executing')
    if (!this.spawnPhase(updated, decision.model, decision.effort)) return
    const defaultBranch = repoById(updated.repoId)?.defaultBranch ?? 'main'
    this.runners
      .get(task.id)
      ?.send(executeKickoff(updated.branch ?? 'unknown-branch', defaultBranch, decision.planPath))
  }

  private onBlocked(task: Task, reason: string): void {
    this.blockedFrom.set(task.id, task.status)
    this.emitEvent(task.id, 'error', { sub: 'error', text: `blocked — ${reason}` })
    this.transition(task.id, 'blocked', reason)
    // Keep the child alive and the lane held; the operator resumes after adding the agent.
  }

  private onPr(task: Task, prUrl: string): void {
    this.patch(task.id, { prUrl })
    this.transition(task.id, 'review', 'PR opened')
    this.interrupting.delete(task.id)
    this.freeLane(task.id)
    // Autonomous work is done; stop the process but keep the worktree for review.
    this.runners.get(task.id)?.kill()
    this.runners.delete(task.id)
  }

  private onExit(taskId: string, code: number | null): void {
    // An intentional handoff kill is not a crash.
    if (this.replacing.delete(taskId)) return
    this.runners.delete(taskId)
    const task = this.db.getTask(taskId)
    if (!task) return
    this.freeLane(taskId)
    if (
      task.status === 'clarify' ||
      task.status === 'planning' ||
      task.status === 'executing' ||
      task.status === 'validating' ||
      task.status === 'blocked'
    ) {
      this.transition(taskId, 'failed', `claude exited (code ${code}) before completion`)
    }
  }

  /** Condense the clarify conversation (operator + worker turns) for the plan child. */
  private clarifyTranscript(taskId: string): string {
    const lines: string[] = []
    for (const ev of this.db.getEvents(taskId)) {
      const { kind, payload } = ev
      const text = payload.text?.trim()
      if (!text) continue
      if (kind === 'operator') lines.push(`OPERATOR: ${text}`)
      else if (kind === 'claude' && payload.sub === 'assistant') lines.push(`WORKER: ${text}`)
    }
    return lines.join('\n\n')
  }

  // ---- public actions (REST surface) ----

  createTask(
    title: string,
    body: string,
    model?: string,
    effort?: EffortLevel,
    style?: CaveStyle,
    repoId?: string,
  ): Task {
    const id = randomUUID()
    const resolvedRepoId = repoId && repoById(repoId) ? repoId : config.defaultRepoId
    const task = this.db.createTask({
      id,
      title,
      body,
      model: model ?? DEFAULT_MODEL,
      effort: effort ?? DEFAULT_EFFORT,
      style: style ?? DEFAULT_STYLE,
      repoId: resolvedRepoId,
      now: now(),
    })
    this.broadcast({ type: 'task', task })
    return task
  }

  async start(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    if (task.status !== 'backlog' && task.status !== 'failed') {
      throw new Error(`cannot start a task in status "${task.status}"`)
    }
    const repo = repoById(task.repoId) ?? repoById(config.defaultRepoId)
    if (!repo) {
      this.fail(taskId, 'no target repo configured in the registry')
      return
    }
    this.emitEvent(taskId, 'status', {
      sub: 'status',
      note: `creating worktree in ${repo.label}…`,
    })
    let wt
    try {
      wt = await createWorktree(
        repo.path,
        repo.defaultBranch,
        path.join(repo.path, 'worktrees'),
        taskId,
        task.title,
      )
    } catch (err) {
      this.fail(taskId, `worktree creation failed: ${errMsg(err)}`)
      return
    }
    const updated = this.patch(taskId, {
      branch: wt.branch,
      worktree: wt.worktreePath,
      prUrl: null,
    })
    this.transition(taskId, 'clarify')
    const model = updated?.model ?? config.defaultModel
    const effort = updated?.effort ?? DEFAULT_EFFORT
    const style = updated?.style ?? DEFAULT_STYLE
    this.spawn(
      { ...task, branch: wt.branch },
      model,
      effort,
      style,
      wt.worktreePath,
      wt.branch,
      repo.path,
      repo.defaultBranch,
    )
    this.emitEvent(taskId, 'status', {
      sub: 'status',
      note: `worktree ${wt.worktreePath} on ${wt.branch}`,
    })
    this.emitEvent(taskId, 'status', { sub: 'status', note: settingsNote(model, effort, style) })
    this.runners.get(taskId)?.send(clarifyKickoff(task))
  }

  message(taskId: string, text: string): void {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    const live =
      task.status === 'clarify' ||
      task.status === 'planning' ||
      task.status === 'executing' ||
      task.status === 'validating'
    const runner = this.runners.get(taskId)
    if (!live || !runner) {
      throw new Error('operator messages are only accepted while the worker is live')
    }
    this.emitEvent(taskId, 'operator', { sub: 'operator', text })
    runner.send(text)
  }

  /**
   * Hard-Stop the current turn (ESC-style stream-json interrupt). The worker idles
   * awaiting the operator's next message, then resumes autonomously (no status change).
   */
  interrupt(taskId: string): void {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    const runner = this.runners.get(taskId)
    if (!runner) throw new Error('no live session for this task')
    this.interrupting.add(taskId)
    runner.interrupt()
    this.emitEvent(taskId, 'status', {
      sub: 'status',
      note: 'Stop — interrupting the worker; it will wait for your next message',
    })
  }

  /** Resume a `blocked` task after the operator has added the missing subagent. */
  resume(taskId: string): void {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    if (task.status !== 'blocked') {
      throw new Error('only a blocked task can be resumed')
    }
    const runner = this.runners.get(taskId)
    if (!runner) throw new Error('no live session for this task — cancel and restart')
    const restore = this.blockedFrom.get(taskId) ?? 'executing'
    this.blockedFrom.delete(taskId)
    this.transition(taskId, restore, 'resumed by operator')
    this.emitEvent(taskId, 'operator', {
      sub: 'operator',
      text: 'The required agent has been added to this repo. Continue the phase from where you stopped.',
    })
    runner.send(
      'The required agent has now been added to this repository. Continue the phase from where you stopped — do not restart.',
    )
  }

  async done(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    this.runners.get(taskId)?.kill()
    this.runners.delete(taskId)
    this.blockedFrom.delete(taskId)
    this.interrupting.delete(taskId)
    this.freeLane(taskId)
    const repo = repoById(task.repoId)
    const repoPath = repo?.path ?? config.targetRepo
    // Remove the worktree first — it holds the feature branch checked out, which
    // would otherwise block the branch deletion in the local sync below.
    if (task.worktree) {
      await removeWorktree(repoPath, task.worktree)
      this.patch(taskId, { worktree: null })
    }
    // Done means "I merged the PR on GitHub" — bring the local checkout in sync:
    // fast-forward the default branch and delete the merged feature branch (safe).
    if (task.branch) {
      const defaultBranch = repo?.defaultBranch ?? 'main'
      try {
        const notes = await syncLocalAfterMerge(repoPath, defaultBranch, task.branch)
        for (const note of notes) {
          this.emitEvent(taskId, 'status', { sub: 'status', note: `local sync — ${note}` })
        }
      } catch (err) {
        // Local sync is best-effort — never block completing the task.
        this.emitEvent(taskId, 'error', { sub: 'error', text: `local sync failed: ${errMsg(err)}` })
      }
    }
    this.transition(taskId, 'done')
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    this.runners.get(taskId)?.kill()
    this.runners.delete(taskId)
    this.blockedFrom.delete(taskId)
    this.interrupting.delete(taskId)
    this.freeLane(taskId)
    if (task.worktree) {
      const repoPath = repoById(task.repoId)?.path ?? config.targetRepo
      await removeWorktree(repoPath, task.worktree)
      this.patch(taskId, { worktree: null })
    }
    this.transition(taskId, 'failed', 'cancelled by operator')
  }

  /** Kill all live processes (graceful shutdown). */
  shutdown(): void {
    for (const runner of this.runners.values()) runner.kill()
    this.runners.clear()
  }
}
