import { randomUUID } from 'node:crypto'
import { config, repoById } from './config.js'
import type { Db, TaskPatch } from './db.js'
import { Runner, type ResultUsage } from './runner.js'
import { createWorktree, removeWorktree } from './worktree.js'
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
const PR_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/

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

/** Per-level caveman register rules, applied to narration only. `normal` injects nothing. */
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

/** Caveman directive block appended to the system prompt for non-`normal` styles. */
function styleDirective(style: CaveStyle): string {
  if (style === 'normal') return ''
  return [
    '',
    'COMMUNICATION STYLE — apply to ALL your narration, status updates, clarify questions,',
    'and streamed log. EXCEPTION: write code, commit messages, PR titles/bodies, and plan',
    'files in normal, clear, professional English (never caveman).',
    CAVEMAN_RULES[style],
  ].join('\n')
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
    'CLARIFY PHASE: ask the operator the questions you need to scope this task, in small batches. Do NOT write code yet. When you have enough to plan and implement fully autonomously, output the exact token ZMRNG_READY on its own line, followed by a one-paragraph scope summary.',
    'After ZMRNG_READY you will receive a single build instruction and must run to completion with no further questions.',
    styleDirective(style),
  ].join('\n')
}

function clarifyKickoff(task: Task): string {
  return [
    `Task title: ${task.title}`,
    `Task details: ${task.body}`,
    'Begin the clarify phase as described in your system prompt.',
  ].join('\n')
}

function buildKickoff(branch: string, defaultBranch: string): string {
  return [
    `Proceed fully autonomously now. You are on branch \`${branch}\` in this worktree.`,
    '1. Write a short plan to .agents/plans/.',
    '2. Implement the task.',
    '3. Run: npm run typecheck && npm run lint && npm run build — fix every failure until all three pass.',
    '4. Commit with a descriptive Conventional Commit message.',
    `5. Push the branch: git push -u origin ${branch}`,
    `6. Open a PR: gh pr create --fill --base ${defaultBranch} --head ${branch}`,
    'Finally, output the PR URL on its own line.',
  ].join('\n')
}

export class TaskManager {
  private runners = new Map<string, Runner>()
  private buildingLanes = new Set<string>()
  private buildQueue: string[] = []

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
    this.freeLane(taskId)
    this.transition(taskId, 'failed', note)
  }

  /** Release a build lane (idempotent) and promote the next queued task. */
  private freeLane(taskId: string): void {
    if (!this.buildingLanes.delete(taskId)) return
    const next = this.buildQueue.shift()
    if (!next) return
    const task = this.db.getTask(next)
    if (task && task.status === 'building') this.beginBuild(task)
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
    const task = this.db.getTask(taskId)
    if (!task) return
    if (task.status === 'clarify' && READY_RE.test(text)) {
      this.onReady(task)
      return
    }
    const pr = extractPrUrl(text)
    if (pr && task.status === 'building' && !task.prUrl) this.onPr(task, pr)
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
    const task = this.db.getTask(taskId)
    if (!task) return
    if (task.status === 'clarify' && READY_RE.test(text)) {
      this.onReady(task)
      return
    }
    const pr = extractPrUrl(text)
    if (pr && task.status === 'building' && !task.prUrl) {
      this.onPr(task, pr)
      return
    }
    // A building turn that ended in error without producing a PR has failed.
    if (task.status === 'building' && isError && !task.prUrl) {
      this.fail(taskId, 'build turn ended with an error before a PR was opened')
    }
  }

  private onReady(task: Task): void {
    this.emitEvent(task.id, 'status', { sub: 'status', note: 'ZMRNG_READY detected' })
    this.transition(task.id, 'building')
    if (this.buildingLanes.size < config.maxLanes) {
      const fresh = this.db.getTask(task.id)
      if (fresh) this.beginBuild(fresh)
    } else {
      this.patch(task.id, { queued: true })
      this.buildQueue.push(task.id)
      this.emitEvent(task.id, 'status', {
        sub: 'status',
        note: `queued — ${this.buildingLanes.size}/${config.maxLanes} build lanes busy`,
      })
    }
  }

  private beginBuild(task: Task): void {
    const runner = this.runners.get(task.id)
    if (!runner) {
      this.fail(task.id, 'no live session to begin build')
      return
    }
    this.buildingLanes.add(task.id)
    this.patch(task.id, { queued: false })
    this.emitEvent(task.id, 'status', {
      sub: 'status',
      note: 'build lane acquired — running autonomously to PR',
    })
    const defaultBranch = repoById(task.repoId)?.defaultBranch ?? 'main'
    runner.send(buildKickoff(task.branch ?? 'unknown-branch', defaultBranch))
  }

  private onPr(task: Task, prUrl: string): void {
    this.patch(task.id, { prUrl })
    this.transition(task.id, 'review', 'PR opened')
    this.freeLane(task.id)
    // Autonomous work is done; stop the process but keep the worktree for review.
    this.runners.get(task.id)?.kill()
    this.runners.delete(task.id)
  }

  private onExit(taskId: string, code: number | null): void {
    this.runners.delete(taskId)
    const task = this.db.getTask(taskId)
    if (!task) return
    this.freeLane(taskId)
    if (task.status === 'clarify' || task.status === 'building') {
      this.transition(taskId, 'failed', `claude exited (code ${code}) before completion`)
    }
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
        config.worktreesDir,
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
    this.runners.get(taskId)?.send(clarifyKickoff(task))
  }

  message(taskId: string, text: string): void {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    if (task.status !== 'clarify') {
      throw new Error('operator messages are only accepted during the clarify phase')
    }
    const runner = this.runners.get(taskId)
    if (!runner) throw new Error('no live session for this task')
    this.emitEvent(taskId, 'operator', { sub: 'operator', text })
    runner.send(text)
  }

  async done(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    this.runners.get(taskId)?.kill()
    this.runners.delete(taskId)
    this.freeLane(taskId)
    if (task.worktree) {
      const repoPath = repoById(task.repoId)?.path ?? config.targetRepo
      await removeWorktree(repoPath, task.worktree)
      this.patch(taskId, { worktree: null })
    }
    this.transition(taskId, 'done')
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    this.runners.get(taskId)?.kill()
    this.runners.delete(taskId)
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
