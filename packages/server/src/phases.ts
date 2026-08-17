import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { config, repoById } from './config.js'
import type { Db, TaskPatch } from './db.js'
import {
  defaultRunnerFactory,
  type ResultUsage,
  type RunnerFactory,
  type RunnerLike,
} from './runner.js'
import { createWorktree, removeWorktree, repoSlug, seedHarness, syncLocalAfterMerge } from './worktree.js'
import { pruneTask as pruneUiStateTask } from './uiState.js'
import {
  DEFAULT_EFFORT,
  DEFAULT_FLOW,
  DEFAULT_MODEL,
  DEFAULT_STYLE,
  type Task,
  type TaskStatus,
  type EventKind,
  type EventPayload,
  type WsEvent,
  type EffortLevel,
  type CaveStyle,
  type FlowMode,
  type Attachment,
} from './types.js'

// ---- detection ----
// Exported for the phase-2 control-token unit tests. Each is anchored (`^…$`
// with the `m` flag) so a token only fires when it stands on its own line —
// a token quoted mid-prose must NOT match. Keep in sync with systemPrompt().
export const READY_RE = /^\s*ZMRNG_READY\s*$/m
export const PLAN_READY_RE = /^\s*ZMRNG_PLAN_READY\b(.*)$/m
export const VALIDATING_RE = /^\s*ZMRNG_VALIDATING\s*$/m
export const BLOCKED_RE = /^\s*ZMRNG_BLOCKED\s*:?\s*(.*)$/m
export const PR_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/
/** Global twin of `PR_RE` — a worker line may quote several PR URLs. */
const PR_RE_G = new RegExp(PR_RE.source, 'g')

const MODELS: readonly string[] = ['opus', 'sonnet']
const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Decision emitted by the planning child via the `ZMRNG_PLAN_READY` token. */
export interface PlanDecision {
  model: string
  effort: EffortLevel
  planPath: string | null
}

/** Parse the trailing `key=value` params of a `ZMRNG_PLAN_READY` line. */
export function parsePlanDecision(text: string): PlanDecision | undefined {
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
export function styleDirective(style: CaveStyle): string {
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

/** Exported for prompt-contract tests (phase 3). */
export function systemPrompt(
  branch: string,
  repoPath: string,
  defaultBranch: string,
  style: CaveStyle,
): string {
  return [
    `You are a zmrng autonomous worker operating on the target repository at \`${repoPath}\`.`,
    `You are running inside a dedicated git worktree ALREADY checked out on the fresh branch \`${branch}\`, cut from the repo's default branch (${defaultBranch}).`,
    '',
    'BRANCH-ONLY (hard rule, no exceptions):',
    `- NEVER switch to, commit on, merge into, or push to \`${defaultBranch}\`/\`main\`/\`master\`.`,
    '- NEVER create or switch to a different branch, and never `git checkout`/`git switch` anything — use the branch you are already on.',
    '- NEVER force-push, rebase onto, or rewrite published history. Your only write to the remote is `git push -u origin <your branch>`.',
    '- You deliver work as a PULL REQUEST. Merging is the operator\'s job on GitHub; never merge your own PR.',
    '',
    'WORKTREE HYGIENE (hard rule):',
    '- This worktree is owned by the orchestrator. NEVER run `git worktree remove|prune`, never delete the worktree directory, and never delete your branch — the orchestrator cleans both up after the operator merges.',
    '- Do not create additional worktrees.',
    '- Leave the tree clean: everything you produce is either committed on your branch or deleted. No stray scratch files, no `git stash`.',
    '',
    "Obey the target repository's CLAUDE.md and every rule under its .claude/rules/. Follow that repo's own conventions, types, and design tokens. Any repo security hooks remain active (they block .env access, force-push, and recursive deletes) — respect them.",
    '',
    'LIFECYCLE: every task moves through Plan → Implement (TDD) → Code Review → Validate → Sync Docs. The orchestrator enforces the phase boundaries; you enforce the steps inside your phase.',
    '',
    'You run inside a PIV pipeline (clarify → plan → execute), one phase per session, each handed off by an orchestrator. You signal phase completion by printing a CONTROL TOKEN on its own line; the orchestrator watches for it. Only emit the token for your current phase:',
    '- ZMRNG_READY — clarify phase complete.',
    '- ZMRNG_PLAN_READY model=<opus|sonnet> effort=<low|medium|high|xhigh|max> plan=<relative path to the plan file> — plan phase complete.',
    '- ZMRNG_VALIDATING — execute phase has moved from implementation into the QA/review/docs chain.',
    '- ZMRNG_BLOCKED: <reason> — emit this ONLY for a true environment gap, one of exactly three reasons: (1) a required toolchain/binary is missing from the environment, (2) authentication is broken (e.g. the target repo\'s credentials are unavailable), or (3) a subagent that the TARGET REPOSITORY ITSELF declares (not one zmrng seeds) is missing. Stop and wait for the operator to fix it and resume you.',
    '',
    'zmrng SEEDS its own QA subagents (`zmrng-qa`, `zmrng-code-reviewer`, `zmrng-doc-updater`) into this worktree before you start — they are GUARANTEED PRESENT. Their absence is never a reason to emit ZMRNG_BLOCKED.',
    '',
    'ORCHESTRATOR-OWNED FILES (never stage or commit): everything under `.claude/rules/zmrng-*`, `.claude/skills/zmrng-*`, `.claude/agents/zmrng-*`, `.claude/zmrng-hooks/`, and `.claude/settings.local.json` was seeded by zmrng itself, not the target repo. It is already excluded from `git add -A` via this worktree\'s `info/exclude`; never `git add --force` it or reference it in a PR.',
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

/** Exported for prompt-contract tests (phase 3). */
export function planKickoff(task: Task, transcript: string): string {
  return [
    'PLAN PHASE. The clarify phase is complete; this is a fresh session. Do NOT implement anything in this phase.',
    `Task title: ${task.title}`,
    `Task details: ${task.body}`,
    '',
    'Agreed scope from the clarify conversation:',
    transcript || '(no transcript captured — work from the task title/details)',
    '',
    'Steps:',
    '1. GRILL THE APPROACH FIRST — no code before the plan is sharp. Read the actual files you intend to change; do not plan against assumptions. Then interrogate your own approach in writing: what is the simplest thing that works, what does this break, what did you assume that the code does not support, what is out of scope. Name at least one alternative you rejected and why. Nothing is written to the plan until it survives this.',
    '2. Write a plan for this task to `.agents/plans/<kebab-case-name>.md` within THIS repository. A good plan states the goal, the approach, the exact files you expect to change, and the step-by-step implementation. The plan MUST contain an explicit "Test strategy" section naming: the test runner/command this repo uses, exactly which tests you will add or update (file paths), and what each one proves. If this repo has NO test runner, the section must say so plainly and state how the change will be verified instead — never omit the section.',
    '3. Have a subagent QA the plan: invoke the `zmrng-code-reviewer` agent (fall back to `zmrng-qa`) — both are seeded into this worktree and guaranteed present — to review the plan for soundness against the task and the repo conventions. If it finds the plan unsound, revise the plan and re-QA. Do AT MOST 2 revise+re-QA rounds, then proceed regardless.',
    '4. Assess complexity and choose the execute-phase model and effort: use `opus` for non-trivial/architectural/multi-file work and `sonnet` only for simple, mechanical changes; effort defaults to `high`, raise to `xhigh`/`max` for genuinely complex work and drop to `medium` only for trivial work.',
    'When the plan is written and QA is complete, output on its own line exactly:',
    'ZMRNG_PLAN_READY model=<opus|sonnet> effort=<low|medium|high|xhigh|max> plan=<relative path to the plan file>',
  ].join('\n')
}

/**
 * Where the worker writes its PR body. Inside the worktree's git dir, so it is
 * never tracked, never committed, and never left behind as a stray file.
 */
export const PR_BODY_FILE = '$(git rev-parse --git-dir)/zmrng-pr-body.md'

/**
 * The canonical PR body the worker must produce, mirroring
 * `.github/PULL_REQUEST_TEMPLATE.md`. Passed via `gh pr create --body-file` so
 * the lifecycle checklist is *guaranteed* present rather than hoped for —
 * `--fill` would silently drop it.
 */
export const PR_BODY_TEMPLATE = [
  '## What & why',
  '',
  '<one paragraph: the change and the motivation>',
  '',
  '<!-- coding-gate:checklist:start -->',
  '## Lifecycle checklist',
  '',
  '- [ ] **Plan** — grilled the approach before coding (link the plan file)',
  '- [ ] **Spec/Tickets** — plan carried into a spec or tickets',
  '- [ ] **TDD** — implemented RED → GREEN → REFACTOR (tests added/updated in the same commit)',
  '- [ ] **Review** — `code-reviewer` pass done; findings addressed',
  "- [ ] **Validate** — ran this repo's full validation; green",
  '<!-- coding-gate:checklist:end -->',
  '',
  '## Testing',
  '',
  '<the tests you added/updated and what each proves — or, if none, the explicit reason>',
  '',
  '## Validation',
  '',
  '<the exact commands you ran and their result>',
].join('\n')

/** Exported for prompt-contract tests (phase 3). */
export function executeKickoff(
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
    '',
    'IMPLEMENT WITH TDD — this is the workflow, not a suggestion. Follow the plan\'s "Test strategy" section:',
    '  RED — first, write or update the failing tests for the behaviour you are about to build, using THIS repo\'s existing test runner and conventions. Run them and confirm they FAIL for the right reason. Never write a test that passes before the implementation exists.',
    '  GREEN — implement the smallest change that makes those tests pass. Run the suite.',
    '  REFACTOR — clean up with the tests green; re-run to confirm they stay green.',
    '  Tests land in the SAME commit as the source they cover — never a follow-up commit.',
    'TOLERANCE (do not silently skip): if this repo genuinely has no test runner, or the change is untestable by its nature (pure docs/config), you may skip RED/GREEN — but you MUST then state that explicitly in the PR body under "Testing", naming the reason. An unexplained absence of tests is a failed execute phase.',
    '',
    'After implementation, BEFORE committing, print ZMRNG_VALIDATING on its own line, then run this chain in order. The `zmrng-qa`, `zmrng-code-reviewer`, and `zmrng-doc-updater` agents are seeded into this worktree and GUARANTEED PRESENT — never block because one of them is "missing":',
    '  1. `zmrng-qa` agent — run validation (typecheck/lint/build) and report PASS/FAIL; fix every failure (route fixes to the right specialist).',
    '  2. `zmrng-code-reviewer` agent — review the changes against the plan; address its findings.',
    '  3. `zmrng-doc-updater` agent (or the `sync-docs` skill) — sync the docs to the changes.',
    'Emit ZMRNG_BLOCKED at this step ONLY for a true environment gap: a required toolchain/binary is missing, authentication is broken, or a subagent the TARGET REPOSITORY ITSELF declares is missing — then STOP and wait for the operator to fix it and resume you; continue the chain afterward.',
    'Finally:',
    "- Run this repo's full validation and ensure every check passes — fix every failure. For a Node repo that is `npm run typecheck && npm run lint && npm test && npm run build` (skip a script this repo does not define).",
    '- MANDATORY before committing: run the `sync-docs` skill (the Skill tool with skill "sync-docs", equivalent to the operator running `/sync-docs`) to bring this repo\'s documentation in sync with your changes, and stage any docs it updates. Do this even if the doc step in the QA chain above already ran. Skip only if the skill is genuinely unavailable in this repo.',
    `- Stage the plan file itself (\`${planPath ?? 'the plan you wrote under .agents/plans/'}\`) along with your changes — the PR body links it, so an uncommitted plan is a dead link.`,
    '- Commit with a descriptive Conventional Commit message.',
    `- Push the branch: git push -u origin ${branch}`,
    `- Write the PR body to \`${PR_BODY_FILE}\` (a path inside the git dir — never tracked, never committed). It MUST follow this template verbatim, with every box honestly checked or explicitly explained:`,
    '',
    PR_BODY_TEMPLATE,
    '',
    `- Open the PR with that file (NOT \`--fill\`): gh pr create --base ${defaultBranch} --head ${branch} --title "<conventional commit style title>" --body-file "${PR_BODY_FILE}"`,
    '- Write the PR title and body in normal, professional English regardless of your narration style.',
    'Then output the PR URL on its own line.',
  ].join('\n')
}

/**
 * The lean execute kickoff for the `direct` flow. No plan file, no plan phase —
 * the clarify transcript is the brief. Deliberately strips the heavy execute
 * ceremony to stay snappy and cheap on menial work: NO `zmrng-qa`/
 * `zmrng-code-reviewer`/`zmrng-doc-updater` subagent spawns (validation is run
 * inline), TDD is conditional rather than mandatory, and doc-sync is
 * conditional. The hard gates are kept: branch-only (from the system prompt), a
 * green final validation, and a PR.
 *
 * Exported for prompt-contract tests.
 */
export function directKickoff(
  branch: string,
  defaultBranch: string,
  task: Task,
  transcript: string,
): string {
  return [
    'DIRECT EXECUTE PHASE. This is a fresh session with no separate plan phase — implement the task now, fully autonomously, with no further questions. Move fast: this flow is for menial/self-contained work, so favour the simplest change that fully solves it.',
    `You are already on branch \`${branch}\` in this worktree — do NOT create or switch branches.`,
    `Task title: ${task.title}`,
    `Task details: ${task.body}`,
    '',
    'Agreed scope from the clarify conversation (this is your brief — there is no plan file):',
    transcript || '(no transcript captured — work from the task title/details)',
    '',
    'HOW TO WORK:',
    '- Read the actual files you intend to change before editing — do not work from assumptions.',
    '- Make the change directly. Do NOT spawn the `zmrng-qa`, `zmrng-code-reviewer`, or `zmrng-doc-updater` subagents and do NOT write a plan file; this flow trades that ceremony for speed. Do the review inline, in your own head, as you go.',
    '- TESTS (conditional): if the change has behaviour worth locking in, add or update tests using this repo\'s existing test runner and land them in the SAME commit. If the change is a pure fix/config/merge-conflict resolution with nothing meaningful to test-drive, you may skip tests — but say so explicitly under "Testing" in the PR body, naming the reason. Never silently omit.',
    '- DOCS (conditional): only run the `sync-docs` skill if your change actually touches a documented surface (public API, commands, schema, user-facing behaviour). For a self-contained fix that changes no documented surface, skip it.',
    '',
    'BEFORE OPENING THE PR:',
    "- Run this repo's full validation INLINE yourself and ensure every check passes — fix every failure. For a Node repo that is `npm run typecheck && npm run lint && npm test && npm run build` (skip a script this repo does not define). This green run is the hard gate; do not open the PR until it passes.",
    '- Commit with a descriptive Conventional Commit message.',
    `- Push the branch: git push -u origin ${branch}`,
    `- Write the PR body to \`${PR_BODY_FILE}\` (a path inside the git dir — never tracked, never committed). It MUST follow this template verbatim, with every box honestly checked or explicitly explained (mark the Plan/Spec/Review boxes as intentionally skipped for the direct flow, and the TDD box honestly per what you did above):`,
    '',
    PR_BODY_TEMPLATE,
    '',
    `- Open the PR with that file (NOT \`--fill\`): gh pr create --base ${defaultBranch} --head ${branch} --title "<conventional commit style title>" --body-file "${PR_BODY_FILE}"`,
    '- Write the PR title and body in normal, professional English regardless of your narration style.',
    'If you discover mid-flight that this task is genuinely architectural/multi-file and needs a real plan, STOP and output `ZMRNG_BLOCKED: needs the plan flow` on its own line rather than half-planning here.',
    'Then output the PR URL on its own line.',
  ].join('\n')
}

export class TaskManager {
  private runners = new Map<string, RunnerLike>()
  /** Tasks holding an autonomous lane (held from planning through to the PR). */
  private executeLanes = new Set<string>()
  private executeQueue: string[] = []
  /** Task ids whose child is being intentionally killed for a phase handoff. */
  private replacing = new Set<string>()
  /** Status to restore when a `blocked` task is resumed. */
  private blockedFrom = new Map<string, TaskStatus>()
  /** Tasks whose current turn was hard-interrupted; suppress the result's fail logic. */
  private interrupting = new Set<string>()
  /**
   * Attachments dropped on the new-task box, held between `createTask` and the
   * first clarify send (no live session exists at create time). Consumed once in
   * `start()`; transient by design — a server restart before Start loses them.
   */
  private pendingAttachments = new Map<string, Attachment[]>()
  /**
   * `owner/name` of each task's target repo, resolved once at start from its
   * `origin` remote. A `null` entry means the target is local-only (no GitHub
   * remote) and PR URLs cannot be repo-scoped — see `prUrlForTask`.
   */
  private repoSlugs = new Map<string, string | null>()

  /**
   * @param runnerFactory builds the per-phase worker wrapper. Defaults to the
   *   real `claude`-spawning `Runner`; tests (and, later, pluggable agent
   *   adapters — Appendix A) inject a fake to drive the state machine without a
   *   real process. This one seam is the only test hook into the engine.
   */
  constructor(
    private db: Db,
    private broadcast: (e: WsEvent) => void,
    private runnerFactory: RunnerFactory = defaultRunnerFactory,
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
    this.repoSlugs.delete(taskId)
    this.freeLane(taskId)
    this.transition(taskId, 'failed', note)
  }

  /** Release an autonomous lane (idempotent) and promote the next queued task. */
  private freeLane(taskId: string): void {
    if (!this.executeLanes.delete(taskId)) return
    const next = this.executeQueue.shift()
    if (!next) return
    const task = this.db.getTask(next)
    // A queued task is parked in `planning` (plan flow) or `executing` (direct
    // flow); promote it by starting the fresh child its flow calls for.
    if (task && (task.status === 'planning' || task.status === 'executing')) {
      this.executeLanes.add(task.id)
      this.beginPhaseForFlow(task)
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
    const runner = this.runnerFactory(
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
    const pr = this.prUrlForTask(taskId, text)
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
    // Hand off the clarify session for a fresh autonomous session.
    this.replaceChild(task.id)
    // `plan` flow parks in `planning` (heavy pipeline); `direct` flow skips the
    // plan phase entirely and parks in `executing`. Both consume one lane.
    const parked: TaskStatus = task.flow === 'plan' ? 'planning' : 'executing'
    this.transition(task.id, parked)
    if (this.executeLanes.size < config.maxLanes) {
      this.executeLanes.add(task.id)
      const fresh = this.db.getTask(task.id)
      if (fresh) this.beginPhaseForFlow(fresh)
    } else {
      this.patch(task.id, { queued: true })
      this.executeQueue.push(task.id)
      this.emitEvent(task.id, 'status', {
        sub: 'status',
        note: `queued — ${this.executeLanes.size}/${config.maxLanes} lanes busy`,
      })
    }
  }

  /** Start the correct fresh session for a task's flow (holds an execute lane). */
  private beginPhaseForFlow(task: Task): void {
    if (task.flow === 'plan') this.beginPlan(task)
    else this.beginDirect(task)
  }

  /**
   * Start a fresh execute child for the `direct` flow — no plan phase. Uses the
   * task's own model/effort (defaults sonnet/medium for menial work) and seeds
   * the lean `directKickoff` with the clarify transcript as the brief.
   */
  private beginDirect(task: Task): void {
    this.patch(task.id, { queued: false })
    const model = task.model ?? DEFAULT_MODEL
    const effort = task.effort ?? DEFAULT_EFFORT
    if (!this.spawnPhase(task, model, effort)) return
    this.emitEvent(task.id, 'status', {
      sub: 'status',
      note: `direct execute — fresh session (${model} · ${effort}), no plan phase`,
    })
    const defaultBranch = repoById(task.repoId)?.defaultBranch ?? 'main'
    this.runners
      .get(task.id)
      ?.send(
        directKickoff(
          task.branch ?? 'unknown-branch',
          defaultBranch,
          task,
          this.clarifyTranscript(task.id),
        ),
      )
  }

  /** Start a fresh planning child (always opus/high) seeded with the clarify transcript. */
  private beginPlan(task: Task): void {
    this.patch(task.id, { queued: false })
    if (!this.spawnPhase(task, 'opus', 'high')) return
    this.emitEvent(task.id, 'status', {
      sub: 'status',
      note: 'plan phase — fresh session (opus · high), writing plan',
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

  /**
   * Pick the PR URL from a worker line that belongs to *this task's* target
   * repo. A worker legitimately quotes other repos' PR URLs (a linked issue, a
   * dependency's changelog); accepting one of those would flip the task to
   * `review` with somebody else's PR attached.
   *
   * When the target repo has no resolvable GitHub slug (local-only repo), fall
   * back to the first PR URL seen — repo-scoping is impossible there, and a
   * local-only target is a supported configuration.
   */
  private prUrlForTask(taskId: string, text: string): string | undefined {
    const urls = text.match(PR_RE_G) ?? []
    if (!urls.length) return undefined
    const slug = this.repoSlugs.get(taskId)
    if (!slug) return urls[0]
    return urls.find((u) => u.includes(`/${slug}/pull/`))
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
    flow?: FlowMode,
    attachments?: Attachment[],
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
      flow: flow ?? DEFAULT_FLOW,
      repoId: resolvedRepoId,
      now: now(),
    })
    // Hold any drop/paste attachments until the first clarify send (start()).
    if (attachments && attachments.length > 0) this.pendingAttachments.set(id, attachments)
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
    // Best-effort: copy zmrng's own harness (rules/skills/agents/hooks) into the
    // worktree so the worker gets it too. Never fails the task — a seeding
    // problem is logged to the operator and the worker proceeds regardless.
    try {
      const notes = await seedHarness(wt.worktreePath, repo.path, path.join(config.repoRoot, 'harness'))
      for (const note of notes) {
        this.emitEvent(taskId, 'status', { sub: 'status', note: `harness seed — ${note}` })
      }
    } catch (err) {
      this.emitEvent(taskId, 'status', {
        sub: 'status',
        note: `harness seed — failed: ${errMsg(err)} (continuing without it)`,
      })
    }

    // Resolved once here (not per worker line) so PR detection can be scoped to
    // this task's own repo. `null` = local-only target; detection degrades to
    // first-URL-wins.
    this.repoSlugs.set(taskId, await repoSlug(repo.path))
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
    // Consume any held new-task-box attachments — single-use, so a re-start
    // after a fail never double-injects them.
    const pending = this.pendingAttachments.get(taskId)
    this.pendingAttachments.delete(taskId)
    this.runners.get(taskId)?.send(clarifyKickoff(task), pending)
  }

  message(taskId: string, text: string, attachments?: Attachment[]): void {
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
    // Note in the log that files rode along (the blocks themselves aren't persisted).
    const count = attachments?.length ?? 0
    const logged = count > 0 ? `${text}${text ? ' ' : ''}[${count} attachment(s)]` : text
    this.emitEvent(taskId, 'operator', { sub: 'operator', text: logged })
    runner.send(text, attachments)
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

  /** Resume a `blocked` task after the operator has resolved the blocking condition. */
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
      text: 'The blocking condition has been resolved. Continue the phase from where you stopped.',
    })
    runner.send(
      'The blocking condition has now been resolved. Continue the phase from where you stopped — do not restart.',
    )
  }

  async done(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    this.runners.get(taskId)?.kill()
    this.runners.delete(taskId)
    this.blockedFrom.delete(taskId)
    this.interrupting.delete(taskId)
    this.repoSlugs.delete(taskId)
    this.freeLane(taskId)
    const repo = repoById(task.repoId)
    const repoPath = repo?.path ?? config.targetRepo
    // Remove the worktree first — it holds the feature branch checked out, which
    // would otherwise block the branch deletion in the local sync below.
    if (task.worktree) {
      await removeWorktree(repoPath, task.worktree)
      this.patch(taskId, { worktree: null })
      pruneUiStateTask(taskId)
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
    this.pendingAttachments.delete(taskId)
    this.repoSlugs.delete(taskId)
    this.freeLane(taskId)
    if (task.worktree) {
      const repoPath = repoById(task.repoId)?.path ?? config.targetRepo
      await removeWorktree(repoPath, task.worktree)
      this.patch(taskId, { worktree: null })
      pruneUiStateTask(taskId)
    }
    this.transition(taskId, 'failed', 'cancelled by operator')
  }

  /**
   * Hard-delete a task: removes its DB rows (task + events) and, if a worktree/
   * branch still exists (e.g. a `failed` task that never reached `done`), cleans
   * it up via the same worktree-removal path `done()`/`cancel()` use. Only
   * permitted for terminal statuses that can't have a live runner attached.
   */
  async deleteTask(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    const deletable: TaskStatus[] = ['backlog', 'done', 'failed']
    if (!deletable.includes(task.status)) {
      throw new Error(`cannot delete task in status '${task.status}'`)
    }
    this.runners.get(taskId)?.kill()
    this.runners.delete(taskId)
    this.blockedFrom.delete(taskId)
    this.interrupting.delete(taskId)
    this.pendingAttachments.delete(taskId)
    this.repoSlugs.delete(taskId)
    this.freeLane(taskId)
    if (task.worktree) {
      const repoPath = repoById(task.repoId)?.path ?? config.targetRepo
      await removeWorktree(repoPath, task.worktree)
    }
    pruneUiStateTask(taskId)
    this.db.deleteTask(taskId)
    this.broadcast({ type: 'task-removed', taskId })
  }

  /** Manual board action — shelve a finished task out of the active columns. */
  archive(taskId: string): void {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error('task not found')
    if (task.status !== 'done' && task.status !== 'failed') {
      throw new Error('only a done or failed task can be archived')
    }
    this.transition(taskId, 'archived')
  }

  /** Kill all live processes (graceful shutdown). */
  shutdown(): void {
    for (const runner of this.runners.values()) runner.kill()
    this.runners.clear()
  }
}
