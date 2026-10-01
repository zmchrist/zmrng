// The gauntlet Loop's prompt contract and control-token parsing. Every ticket step
// (builder, critic, validate, finish, fold) and the final PR is a FRESH `claude`
// child that gets one system prompt and one kickoff message from here; the run's
// persistent orchestrator gets its system prompt, kickoff, and respawn recap from
// here too. `loopPrompts.test.ts` pins every rule, the way `prompts.test.ts` pins
// phases.ts — a rule that exists only as prompt text is otherwise unguarded.
//
// Technique credit: robonuggets/gauntlet-loop (CC-BY-4.0), after Matt Shumer's
// "Claude of Duty".

import { MAX_ROUNDS, percentComplete, stripFencedCode } from './loopMap.js'
import { PR_BODY_FILE, PR_BODY_TEMPLATE, PR_RE, styleDirective } from './phases.js'
import {
  LOOP_MAX_LANES,
  type CaveStyle,
  type EffortLevel,
  type LoopRun,
  type LoopStep,
  type LoopTicket,
  type ModelAlias,
} from './types.js'

// ---- control tokens ----
// Line-anchored (like READY_RE in phases.ts): a token quoted mid-sentence never
// matches. After a token's colon only horizontal whitespace is allowed, so an
// empty token line can never swallow the next line as its value.

/** `GAUNTLET_STATUS=BUILT|GREEN|RED [reason]` — `GREENISH` and lower case never match. */
export const GAUNTLET_STATUS_RE = /^\s*GAUNTLET_STATUS=(BUILT|GREEN|RED)(?:[ \t]+(.*?))?\s*$/m
/** `GAUNTLET_VERDICT: <letter>` — captures the raw token; `verdictOutcome` maps it. */
export const GAUNTLET_VERDICT_RE = /^\s*GAUNTLET_VERDICT:[ \t]*(\S+)\s*$/m
/** `GAUNTLET_GAP: <the single biggest gap>` */
export const GAUNTLET_GAP_RE = /^\s*GAUNTLET_GAP:[ \t]*(\S.*?)\s*$/m
/** `GAUNTLET_QUESTION: <question>` — any step may park on one. */
export const GAUNTLET_QUESTION_RE = /^\s*GAUNTLET_QUESTION:[ \t]*(\S.*?)\s*$/m

export type StepStatus = 'BUILT' | 'GREEN' | 'RED'
const STATUSES: readonly StepStatus[] = ['BUILT', 'GREEN', 'RED']

export interface StepResult {
  status?: StepStatus
  /** Trailing text after the status (the RED reason; also kept after BUILT/GREEN). */
  reason?: string
  /** The raw captured verdict token, upper-cased. */
  verdict?: string
  gap?: string
  question?: string
  /** The last GitHub PR URL (`PR_RE`). */
  prUrl?: string
}

/** The LAST match of `re` in `text` (the agent's final word), or null. */
function lastMatch(re: RegExp, text: string): RegExpMatchArray | null {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const all = [...text.matchAll(new RegExp(re.source, flags))]
  return all.length ? all[all.length - 1] : null
}

/** Trimmed capture group, or undefined when absent/blank. */
function cap(m: RegExpMatchArray | null, group: number): string | undefined {
  const v = m?.[group]?.trim()
  return v ? v : undefined
}

/**
 * Parse a step's turn text. Fenced code blocks (``` and ~~~) are stripped FIRST,
 * so a token (or PR URL) shown inside a fence never counts. When a token appears
 * more than once, the LAST occurrence wins.
 */
export function parseStepResult(text: string): StepResult {
  const clean = stripFencedCode(text)
  const out: StepResult = {}

  const status = lastMatch(GAUNTLET_STATUS_RE, clean)
  const statusValue = STATUSES.find((s) => s === status?.[1])
  if (statusValue) {
    out.status = statusValue
    const reason = cap(status, 2)
    if (reason) out.reason = reason
  }
  const verdict = cap(lastMatch(GAUNTLET_VERDICT_RE, clean), 1)
  if (verdict) out.verdict = verdict.toUpperCase()
  const gap = cap(lastMatch(GAUNTLET_GAP_RE, clean), 1)
  if (gap) out.gap = gap
  const question = cap(lastMatch(GAUNTLET_QUESTION_RE, clean), 1)
  if (question) out.question = question
  const pr = lastMatch(PR_RE, clean)
  if (pr) out.prUrl = pr[0]
  return out
}

// ---- profiles ----

/** Model/effort per fresh child. Judgement-heavy steps run opus; mechanical ones sonnet. */
export const STEP_PROFILES: Record<
  LoopStep | 'final' | 'orchestrator',
  { model: ModelAlias; effort: EffortLevel }
> = {
  builder: { model: 'opus', effort: 'high' },
  critic: { model: 'opus', effort: 'high' },
  fold: { model: 'opus', effort: 'high' },
  orchestrator: { model: 'opus', effort: 'high' },
  validate: { model: 'sonnet', effort: 'medium' },
  finish: { model: 'sonnet', effort: 'medium' },
  final: { model: 'sonnet', effort: 'medium' },
}

// ---- step prompts ----

export interface StepPrompt {
  system: string
  kickoff: string
}

export interface LoopTicketCtx {
  number: number
  title: string
  body: string
  url: string
  bar: string
  round: number
  lastGap: string | null
}

export interface LoopStepCtx {
  /** owner/name */
  repoSlug: string
  defaultBranch: string
  /** gauntlet/<run8>/integ */
  integBranch: string
  /** gauntlet/<run8>/t<n> */
  ticketBranch: string
  ticket: LoopTicketCtx
  style: CaveStyle
}

const NO_PUSH =
  '- Do NOT push anything. The zmrng server does every push itself, after it verifies your work.'

/**
 * The rules block every step's system prompt carries: branch-only, worktree
 * hygiene, the repo's own rules, the GAUNTLET_QUESTION protocol, the control-line
 * format, and the narration style (code/commits/PR text stay normal English).
 */
function stepRules(branch: string, defaultBranch: string, style: CaveStyle, pushRule: string = NO_PUSH): string {
  return [
    'BRANCH-ONLY (hard rule, no exceptions):',
    `- You are on the branch \`${branch}\`. NEVER commit on, merge into, or push to \`${defaultBranch}\`/\`main\`/\`master\` (the default branch).`,
    '- NEVER `git checkout`/`git switch` to another branch, and never create one. Stay on the branch you are on.',
    '- NEVER force-push, never rebase, and never rewrite published history.',
    pushRule,
    '',
    'WORKTREE HYGIENE (hard rule):',
    '- This worktree is owned by the zmrng orchestrator. NEVER run `git worktree remove|prune`, never delete the worktree directory, and never delete a branch.',
    '- Leave the tree clean: everything you produce is either committed on your branch or deleted. No stray scratch files (use a temp dir from `mktemp -d` outside the worktree), no `git stash`.',
    '- Never stage or commit zmrng-seeded tooling (`.claude/rules/zmrng-*`, `.claude/skills/zmrng-*`, `.claude/agents/zmrng-*`, `.claude/zmrng-hooks/`, `.claude/settings.local.json`). It is excluded via `info/exclude`; never `git add --force` it.',
    '',
    "Obey the repository's CLAUDE.md and every rule under its .claude/rules/, and follow its own conventions. Any repository security hooks stay active; respect them.",
    '',
    'QUESTIONS: if you are truly blocked on a decision only a human or the orchestrator can make, print `GAUNTLET_QUESTION: <question>` on its own line and STOP. The answer arrives as your next message; then continue this same step. Never ask about anything you can decide or find out yourself.',
    '',
    'CONTROL LINES: print your GAUNTLET line on its own line, never inside a code block or sentence, exactly as specified, at the very end of your work.',
    styleDirective(style),
  ].join('\n')
}

/** The ticket header every ticket-step kickoff opens with. */
function ticketHeader(t: LoopTicketCtx): string[] {
  return [`Ticket: #${t.number} ${t.title}`, `URL: ${t.url}`, '', 'Goal (the ticket body):', t.body.trim() || '(empty body — work from the title)']
}

/**
 * A fresh BUILDER for one round: builds and commits on the ticket branch, never
 * judges its own work. Round > 1 carries the critic's last gap verbatim.
 */
export function builderPrompt(ctx: LoopStepCtx): StepPrompt {
  const t = ctx.ticket
  const gap = t.round > 1 ? t.lastGap?.trim() : undefined
  const system = [
    `You are a gauntlet BUILDER for ticket #${t.number} of ${ctx.repoSlug}: one fresh session, one round of building. You run in the ticket's dedicated git worktree, already checked out on \`${ctx.ticketBranch}\`.`,
    '',
    'BUILD, DO NOT JUDGE: NEVER judge your own work and NEVER compare it to the bar. A separate, fresh critic judges it blind after you finish; any verdict or score you give yourself is ignored.',
    '',
    stepRules(ctx.ticketBranch, ctx.defaultBranch, ctx.style),
  ].join('\n')
  const kickoff = [
    `GAUNTLET BUILDER — ticket #${t.number}, round ${t.round} of ${MAX_ROUNDS}.`,
    '',
    ...ticketHeader(t),
    '',
    'The bar (the named reference the output has to beat — context only, the critic does the comparing):',
    t.bar,
    ...(gap
      ? [
          '',
          "THE CRITIC'S SINGLE BIGGEST GAP FROM LAST ROUND — close this first:",
          gap,
          '',
          'The commits from earlier rounds are already on this branch: improve on them rather than starting over.',
        ]
      : []),
    '',
    'Steps:',
    `1. Implement the ticket on \`${ctx.ticketBranch}\` (the branch you are on). Read the code you touch before changing it, and follow the repository's conventions.`,
    "2. Add or update tests with the repository's own test runner wherever the change is testable.",
    '3. Commit ALL of your work on this branch with a descriptive Conventional Commit message (normal, professional English). Leave the tree clean: nothing uncommitted, no stray files.',
    '4. Do NOT push. Do NOT judge your work or compare it to the bar; just build it as well as you can.',
    '',
    'When everything is committed, print exactly this on its own line and stop:',
    'GAUNTLET_STATUS=BUILT',
  ].join('\n')
  return { system, kickoff }
}

/**
 * A fresh, READ-ONLY critic doing a blind binary A/B. `oursLabel` (server-
 * randomized) is the label of the work in this checkout; the other label is the
 * bar. Both are described neutrally, always in A-then-B order, so neither the
 * wording nor the order says which one was just built.
 */
export function criticPrompt(ctx: LoopStepCtx, oursLabel: 'A' | 'B', baseSha: string): StepPrompt {
  const t = ctx.ticket
  const describe = (label: 'A' | 'B'): string =>
    label === oursLabel
      ? `- Candidate ${label} — the change in this checkout: inspect it with \`git diff ${baseSha}..HEAD\` and the files at HEAD; run it if you can.`
      : `- Candidate ${label} — the bar reference below: fetch and inspect it yourself (open its link, read or run the named thing). Never judge it from its name alone.`
  const system = [
    `You are a harsh critic: a fresh, READ-ONLY judge for ticket #${t.number} of ${ctx.repoSlug}. You run in the ticket's git worktree, on \`${ctx.ticketBranch}\`.`,
    '',
    'READ-ONLY (hard rule, overrides anything below about committing): NEVER edit, create, or delete files in this worktree. NEVER commit. NEVER run a git command that changes HEAD, the index, or the working tree (no commit, checkout, switch, reset, merge, rebase, stash, add, restore, clean, cherry-pick, revert). Read-only git (`git diff`, `git log`, `git show`, `git status`) is fine. For scratch space (e.g. to download or run the bar) use a temp dir from `mktemp -d` outside this worktree. When you finish, the tree must be exactly as you found it.',
    '',
    'BLIND BINARY A/B: you compare two candidates labelled only A and B. Judge only what each candidate does against the goal; do not speculate about where either came from or who produced it. Your answer is a single LETTER — NEVER a score, never a score out of 10, never a tie.',
    '',
    stepRules(ctx.ticketBranch, ctx.defaultBranch, ctx.style),
  ].join('\n')
  const kickoff = [
    `GAUNTLET CRITIC — ticket #${t.number}.`,
    '',
    ...ticketHeader(t),
    '',
    'Two candidates, A and B:',
    describe('A'),
    describe('B'),
    '',
    'The bar reference:',
    t.bar,
    '',
    'Steps:',
    '1. Inspect both candidates thoroughly and harshly against the goal: missing behaviour, bugs, rough edges, worse UX, slower, less complete.',
    '2. Decide which candidate is better overall. Binary: exactly one single LETTER, A or B. NEVER a score, NEVER a score out of 10, NEVER a tie. When in doubt, the candidate with fewer real defects wins.',
    '3. Name the single biggest gap of the losing candidate versus the winner: one concrete, actionable gap. Always name one, even when the decision was easy.',
    '',
    'Then print exactly these two lines, each on its own line, and stop:',
    'GAUNTLET_VERDICT: <A|B>',
    'GAUNTLET_GAP: <the single biggest gap of the losing candidate vs the winner>',
  ].join('\n')
  return { system, kickoff }
}

/** A fresh VALIDATOR: discover and run the repo's own gate, fix, commit; GREEN or RED. */
export function validatePrompt(ctx: LoopStepCtx): StepPrompt {
  const t = ctx.ticket
  const system = [
    `You are a gauntlet VALIDATOR for ticket #${t.number} of ${ctx.repoSlug}: a fresh session in the ticket's git worktree, on \`${ctx.ticketBranch}\`. The ticket's change already won its critic round; your job is to make the repository's own validation gate pass on it.`,
    '',
    stepRules(ctx.ticketBranch, ctx.defaultBranch, ctx.style),
  ].join('\n')
  const kickoff = [
    `GAUNTLET VALIDATE — ticket #${t.number}: ${t.title}`,
    `URL: ${t.url}`,
    '',
    'Steps:',
    "1. Discover the repository's own validation gate: read its CLAUDE.md (and .claude/rules/), its package.json scripts, Makefile, justfile, or CI workflow, and find its typecheck, lint, test, and build commands. Skip a check the repository does not define.",
    "2. Run every check. Fix each failure with the smallest correct change. Never delete, skip, or weaken a test or a lint rule to make it pass, and never drop the ticket's behaviour.",
    '3. Re-run until every check is green. Commit your fixes on this branch with a descriptive Conventional Commit message (normal, professional English). Leave the tree clean. Do NOT push.',
    '',
    'When every check passes and everything is committed, print on its own line:',
    'GAUNTLET_STATUS=GREEN',
    'If you cannot get the gate green, print instead, on its own line (a one-line reason naming the failing check):',
    'GAUNTLET_STATUS=RED <reason>',
    'Then stop.',
  ].join('\n')
  return { system, kickoff }
}

/** A fresh docs FINISHER: sync the repo's docs to the ticket's change, commit; GREEN. */
export function finishPrompt(ctx: LoopStepCtx): StepPrompt {
  const t = ctx.ticket
  const system = [
    `You are a gauntlet DOCS FINISHER for ticket #${t.number} of ${ctx.repoSlug}: a fresh session in the ticket's git worktree, on \`${ctx.ticketBranch}\`. The change is built, judged, and validated; your job is to bring the repository's documentation in sync with it.`,
    '',
    stepRules(ctx.ticketBranch, ctx.defaultBranch, ctx.style),
  ].join('\n')
  const kickoff = [
    `GAUNTLET FINISH (sync docs) — ticket #${t.number}: ${t.title}`,
    `URL: ${t.url}`,
    '',
    'Steps:',
    `1. Read what this ticket changed: \`git log ${ctx.integBranch}..HEAD\` and \`git diff ${ctx.integBranch}...HEAD\`.`,
    "2. Sync the docs to the change: use the repository's own `sync-docs` skill if it has one (the Skill tool), else the seeded `zmrng-sync-docs` skill; failing both, update the README, CLAUDE.md, and docs/ pages that describe the changed behaviour by hand. Docs only — no code changes in this step.",
    '3. Commit the doc updates on this branch with a descriptive Conventional Commit message (normal, professional English). If nothing needed updating, commit nothing. Leave the tree clean. Do NOT push.',
    '',
    'Then print exactly this on its own line and stop:',
    'GAUNTLET_STATUS=GREEN',
  ].join('\n')
  return { system, kickoff }
}

/**
 * A fresh FOLDER in the integration worktree: serially merge the ticket branch
 * into integ, keep integ green, commit. Never pushes — the server pushes integ
 * after machine-asserting the merge.
 */
export function foldPrompt(ctx: LoopStepCtx, integWorktree: string): StepPrompt {
  const t = ctx.ticket
  const system = [
    `You are the gauntlet FOLDER for ticket #${t.number} of ${ctx.repoSlug}: a fresh session in the run's integration worktree, on \`${ctx.integBranch}\`. Folds are serial: yours is the only fold running in this run, and other tickets fold after you.`,
    '',
    stepRules(ctx.integBranch, ctx.defaultBranch, ctx.style),
  ].join('\n')
  const kickoff = [
    `GAUNTLET FOLD — ticket #${t.number}: ${t.title}`,
    `Integration worktree (your cwd): ${integWorktree}`,
    `Integration branch (checked out): ${ctx.integBranch}`,
    `Ticket branch to fold in: ${ctx.ticketBranch}`,
    '',
    'Steps:',
    `1. Merge the ticket branch into the integration branch you are on: git merge --no-ff ${ctx.ticketBranch}`,
    "2. Resolve any conflicts so BOTH sides keep their intent. The integration branch carries every earlier fold; never drop another ticket's work to make this one fit.",
    "3. Keep the integration branch GREEN: run the repository's own validation gate (typecheck, lint, test, build — whatever its CLAUDE.md, package.json scripts, or Makefile define) and fix every failure.",
    '4. Commit everything (the merge commit plus any fixes) on the integration branch with clear messages (normal, professional English). Leave the tree clean.',
    `5. Never touch \`${ctx.defaultBranch}\`/\`main\`. Do NOT push — the zmrng server verifies the merge and pushes the integration branch itself.`,
    'If the merge cannot be completed, run `git merge --abort`, leave the tree clean, and report RED.',
    '',
    'When the merge is committed and the gate is green, print on its own line:',
    'GAUNTLET_STATUS=GREEN',
    'If you cannot fold the ticket, print instead, on its own line (a one-line reason):',
    'GAUNTLET_STATUS=RED <reason>',
    'Then stop.',
  ].join('\n')
  return { system, kickoff }
}

export interface FinalPrCtx {
  repoSlug: string
  defaultBranch: string
  integBranch: string
  epic: number
  epicTitle: string
  done: { number: number; title: string }[]
  style: CaveStyle
}

/**
 * The final-PR agent: push integ (never forced), write the body to PR_BODY_FILE
 * from PR_BODY_TEMPLATE plus one `Closes #n` per done ticket, open ONE PR
 * integ → default branch with `--body-file` (never `--fill`), never merge.
 */
export function finalPrKickoff(ctx: FinalPrCtx): StepPrompt {
  const pushRule = `- Your ONLY write to the remote is \`git push -u origin ${ctx.integBranch}\` (never force). Push nothing else.`
  const system = [
    `You are the gauntlet FINAL PR agent for epic #${ctx.epic} of ${ctx.repoSlug}: a fresh session in the run's integration worktree, on \`${ctx.integBranch}\`. Every ticket of the epic has folded into this branch and it passed the deterministic security scan. Your only job is to open ONE pull request from it into \`${ctx.defaultBranch}\`.`,
    '',
    stepRules(ctx.integBranch, ctx.defaultBranch, ctx.style, pushRule),
  ].join('\n')
  const closes = ctx.done.map((t) => `Closes #${t.number}`)
  const kickoff = [
    `GAUNTLET FINAL PR — epic #${ctx.epic}: ${ctx.epicTitle}`,
    '',
    'Tickets delivered on this branch:',
    ...(ctx.done.length ? ctx.done.map((t) => `- #${t.number} ${t.title}`) : ['(none)']),
    '',
    'Steps:',
    `1. Push the integration branch (never force): git push -u origin ${ctx.integBranch}`,
    `2. Write the PR body to \`${PR_BODY_FILE}\` (inside the git dir — never tracked, never committed). It MUST follow this template, with every box honestly checked or explicitly explained (where an item does not apply to a gauntlet run, e.g. there is no plan file, say so next to it):`,
    '',
    PR_BODY_TEMPLATE,
    '',
    ...(closes.length
      ? ['   After the template, append these lines verbatim, one per line, so each ticket closes on merge:', '', ...closes]
      : ['   No ticket is done, so add no `Closes` lines.']),
    '',
    `3. Open the PR with that file — NEVER \`--fill\`: gh pr create --base ${ctx.defaultBranch} --head ${ctx.integBranch} --repo ${ctx.repoSlug} --title "<conventional commit style title for epic #${ctx.epic}>" --body-file "${PR_BODY_FILE}"`,
    '4. NEVER merge the PR (no `gh pr merge`). The operator reviews and merges it on GitHub.',
    'Write the PR title and body in normal, professional English regardless of your narration style.',
    '',
    'Then print the PR URL on its own line and stop.',
  ].join('\n')
  return { system, kickoff }
}

// ---- orchestrator ----

export interface OrchestratorCtx {
  runId: string
  repoId: string
  repoSlug: string
  defaultBranch: string
  epic: number
  epicTitle: string
  integBranch: string
  /** e.g. http://127.0.0.1:4500 — the server's own loopback base, never hard-coded. */
  apiBase: string
  style: CaveStyle
}

const JSON_POST = "curl -sS -X POST -H 'content-type: application/json' -d"

/** The curl cheat sheet: every orchestrator-facing route, base + run id substituted. */
function curlCheatSheet(apiBase: string, runId: string): string[] {
  const api = `${apiBase}/api/loop`
  const run = `${api}/runs/${runId}`
  return [
    'Bodyless POST routes take NO body: send them without a content-type header and without -d (the server rejects `content-type: application/json` with an empty body). Only routes that take a JSON body get `-H \'content-type: application/json\' -d \'…\'`. For text containing quotes, build the JSON with jq: `jq -n --arg text "…" \'{text:$text}\' | curl … -d @- <url>`.',
    `curl -sS ${api}/load   # machine load + Loop pool: cores, loadPerCore, memAvailableMb, thresholds, allowsNewLane, reason, pool {used,max}`,
    `curl -sS ${api}/runs   # every Loop run`,
    `curl -sS ${run}   # this run: run, tickets (state, round, bar), live lanes, pool, load`,
    `curl -sS '${run}/events?limit=50'   # recent chat + lane activity`,
    `curl -sS -X POST ${run}/start   # start picking tickets (only when the operator asks)`,
    `curl -sS -X POST ${run}/pause   # stop picking; in-flight steps finish`,
    `${JSON_POST} '{"count":N}' ${run}/lanes   # this run's lane target, 0..${LOOP_MAX_LANES} (0 = stop picking)`,
    `${JSON_POST} '{"order":[12,7,9]}' ${run}/priority   # pick order among UNBLOCKED tickets`,
    `curl -sS -X POST ${run}/refresh   # re-fetch the map from GitHub after any issue edit`,
    `${JSON_POST} '{"number":N}' ${run}/tickets   # add issue #N to the run`,
    `curl -sS -X DELETE ${run}/tickets/<n>   # skip ticket #n`,
    `curl -sS -X POST ${run}/tickets/<n>/stop   # kill its step, free the lane, back to todo`,
    `curl -sS -X POST ${run}/tickets/<n>/retry   # needs-human -> todo, rounds reset`,
    `${JSON_POST} '{"text":"…"}' ${run}/tickets/<n>/answer   # answer a waiting lane's question`,
    `curl -sS -X POST ${run}/resume   # resume a stale run after an app restart`,
    `curl -sS -X POST ${run}/archive   # archive the run (only when the operator asks)`,
  ]
}

/** The `gh` commands for editing tickets and their links. */
function ghCheatSheet(slug: string, epic: number): string[] {
  return [
    `GITHUB (tickets are issues of ${slug}; after ANY change, re-sync the map with POST …/refresh):`,
    `- read an issue: gh issue view <n> --repo ${slug} --json number,title,body,state`,
    `- edit a title: gh issue edit <n> --repo ${slug} --title "<title>"`,
    `- edit a body (e.g. add a "## Bar" section): f=$(mktemp); gh issue view <n> --repo ${slug} --json body -q .body > "$f"; <edit "$f">; gh issue edit <n> --repo ${slug} --body-file "$f"`,
    `- create a ticket (give it a "## Bar" section): gh issue create --repo ${slug} --title "<title>" --body-file "$f"`,
    `- an issue's numeric id (the link APIs need it): gh api repos/${slug}/issues/<n> --jq .id`,
    `- make an issue a sub-issue of the epic: gh api -X POST repos/${slug}/issues/${epic}/sub_issues -F sub_issue_id=<id of the child>`,
    `- list what #<n> is blocked by: gh api repos/${slug}/issues/<n>/dependencies/blocked_by`,
    `- mark #<n> blocked by #<m>: gh api -X POST repos/${slug}/issues/<n>/dependencies/blocked_by -F issue_id=<id of m>`,
    `- remove that link: gh api -X DELETE repos/${slug}/issues/<n>/dependencies/blocked_by/<id of m>`,
    '- then: POST …/refresh, and POST …/tickets {"number":N} for a created ticket the refresh did not pick up.',
    '- Write issue titles and bodies in normal, professional English regardless of your narration style.',
  ]
}

/** The orchestrator's SYSTEM prompt: role, run facts, cheat sheets, lane rules, style. */
export function loopOrchestratorPrompt(ctx: OrchestratorCtx): string {
  return [
    `You are the zmrng gauntlet-loop ORCHESTRATOR for Loop run ${ctx.runId}. The operator chats with you; you drive the run through the zmrng server's loopback REST API (with curl) and GitHub (with gh). You are persistent: the operator's messages and loop events arrive as your next messages.`,
    '',
    'RUN FACTS:',
    `- run id: ${ctx.runId}`,
    `- repo id: ${ctx.repoId} (GitHub ${ctx.repoSlug}, default branch \`${ctx.defaultBranch}\`)`,
    `- epic: #${ctx.epic} — ${ctx.epicTitle}`,
    `- integration branch: \`${ctx.integBranch}\` (your cwd is its worktree)`,
    `- API base: ${ctx.apiBase}`,
    '',
    `HOW THE GAUNTLET WORKS: each ticket (a sub-issue of the epic) runs in its own lane with a fresh agent per step. A builder builds; a fresh read-only critic judges a blind A/B against the ticket's bar and names the single biggest gap; a loss feeds that gap into the next builder round (after ${MAX_ROUNDS} lost rounds the ticket parks needs-human); a win moves on to validate, then sync docs, then a serial fold into the integration branch. When every ticket is done the server runs the security scan and opens ONE final PR (integration branch → \`${ctx.defaultBranch}\`) by itself; you never trigger that.`,
    '',
    'YOUR ROLE (hard rules):',
    '- You guide the run: choose the lane count, reorder priority, answer lane questions, edit tickets on GitHub, add or skip tickets, and keep the operator informed.',
    '- NEVER edit code or any file in a worktree. NEVER commit. NEVER merge (no `git merge`, no `gh pr merge`). NEVER push anything, and never push `main` or the default branch: the lanes do the code work and the server does every push.',
    '- Never `git checkout`/`git switch`, never `git worktree remove|prune`, never delete a branch. Never write scratch files in your cwd (it is the integration worktree): use `mktemp`.',
    '- Act only through the routes and gh commands below.',
    '',
    'CURL CHEAT SHEET (this run; responses are JSON):',
    ...curlCheatSheet(ctx.apiBase, ctx.runId),
    '',
    ...ghCheatSheet(ctx.repoSlug, ctx.epic),
    '',
    'LANES AND MACHINE LOAD:',
    `- The Loop lane pool is shared by EVERY Loop run: at most ${LOOP_MAX_LANES} ticket lanes in flight in total (LOOP_MAX_LANES=${LOOP_MAX_LANES}), separate from the task pipeline's lanes. This run's lane count (0–${LOOP_MAX_LANES}) is its target within that pool; 0 stops picking.`,
    '- GET /load before raising the lane count: weigh the runnable tickets in the map against the CPU load per core and the available memory, and tell the operator why you chose the number.',
    "- The server defers every NEW pick while the machine is over the load threshold or under the available-memory threshold (`allowsNewLane: false`), and resumes picking by itself once load drops. In-flight work is never killed by the gate, and the gate never changes the run's lane count.",
    '- Priority (POST …/priority) only reorders UNBLOCKED tickets; blocked-by links stay authoritative.',
    '- A ticket with no bar is never picked; it parks needs-human. Fix it by adding a "## Bar" section to the issue (gh issue edit), then POST …/refresh and POST …/tickets/<n>/retry.',
    '',
    'EVENTS AND QUESTIONS:',
    '- Loop events (a ticket WIN, or LOSE with its gap, done, needs-human, a lane question, deferred picks, the map finishing, a blocked run) arrive as messages beginning `[loop event]`. Relay what matters to the operator, briefly.',
    '- A lane that asks a question parks waiting. Answer it with POST …/tickets/<n>/answer {"text":"…"} when you can; ask the operator first when it needs a human decision.',
    '- needs-human tickets: fix the cause (bar, ticket text, dependency), then POST …/tickets/<n>/retry.',
    '',
    'Keep replies to the operator short and concrete.',
    styleDirective(ctx.style),
  ].join('\n')
}

/**
 * The orchestrator's first user message. A fresh run: read the map and the load,
 * set the lane count, explain it, and wait to be asked before starting. With a
 * recap (a lazy respawn or a resume): the recap verbatim.
 */
export function orchestratorKickoff(ctx: OrchestratorCtx, recap?: string): string {
  const run = `${ctx.apiBase}/api/loop/runs/${ctx.runId}`
  if (recap !== undefined) {
    return [
      `You are resuming as the orchestrator of Loop run ${ctx.runId} (epic #${ctx.epic}, ${ctx.repoSlug}). Your previous session ended and this is a fresh one. The run as the server last recorded it:`,
      '',
      recap,
      '',
      `Re-read the live state before acting (curl -sS ${run}); do not redo anything the recap shows as done. Then tell the operator briefly where the run stands. Do not start, pause, or archive the run unless the operator asks.`,
    ].join('\n')
  }
  return [
    `Loop run ${ctx.runId} is open for epic #${ctx.epic} (${ctx.epicTitle}) in ${ctx.repoSlug}. It is a draft: nothing runs until it is started.`,
    '',
    'First:',
    `1. Read the ticket map: curl -sS ${run}`,
    `2. Read the machine load: curl -sS ${ctx.apiBase}/api/loop/load`,
    `3. Choose this run's lane count (0–${LOOP_MAX_LANES}) from the runnable tickets and the load, and set it: ${JSON_POST} '{"count":N}' ${run}/lanes`,
    '4. Explain your choice to the operator in a few lines, and flag any ticket that has no bar or is blocked by an issue outside the map.',
    'Do NOT start the run yourself (POST …/start) unless the operator asks you to.',
  ].join('\n')
}

export interface RecapInput {
  run: LoopRun
  tickets: LoopTicket[]
  /** The run's chat transcript lines, oldest first. Only the last 20 are kept. */
  chat: string[]
  /** The server's loopback base, shown in the run facts when given. */
  apiBase?: string
}

/** Chat lines a respawned orchestrator gets back. */
const RECAP_CHAT_LINES = 20
const RECAP_NOTE_MAX = 200

/** One markdown-table cell: single line, pipes escaped, length-capped. */
function cell(s: string, max = Number.POSITIVE_INFINITY): string {
  const flat = s.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The respawn context: run facts, a per-ticket state table (ascending), and at
 * most the last 20 chat lines. Built from DB state only.
 */
export function orchestratorRecap(input: RecapInput): string {
  const { run, tickets, chat, apiBase } = input
  const counted = tickets.filter((t) => t.state !== 'skipped').length
  const done = tickets.filter((t) => t.state === 'done').length
  const shown = chat.slice(-RECAP_CHAT_LINES)
  const rows = [...tickets]
    .sort((a, b) => a.number - b.number)
    .map((t) => {
      const note = t.state === 'waiting' && t.question ? `question: ${t.question}` : (t.note ?? '')
      return `| #${t.number} | ${cell(t.title)} | ${t.state} | ${t.round} | ${cell(note, RECAP_NOTE_MAX)} |`
    })
  return [
    'RUN RECAP',
    `- run: ${run.id}`,
    `- repo id: ${run.repoId}`,
    `- epic: #${run.epic} — ${run.title}`,
    `- status: ${run.status}`,
    `- lanes: ${run.lanes} (this run's target within the shared Loop pool)`,
    `- integration branch: ${run.integBranch}`,
    ...(apiBase ? [`- API base: ${apiBase}`] : []),
    ...(run.priority.length ? [`- priority: ${run.priority.map((n) => `#${n}`).join(', ')}`] : []),
    ...(run.prUrl ? [`- PR: ${run.prUrl}`] : []),
    ...(run.note ? [`- note: ${cell(run.note)}`] : []),
    `- progress: ${done} of ${counted} done (${percentComplete(tickets)}%)`,
    '',
    'TICKETS',
    '| # | title | state | round | note |',
    '|---|---|---|---|---|',
    ...(rows.length ? rows : ['| — | (no tickets) | | | |']),
    '',
    shown.length
      ? `RECENT CHAT (last ${shown.length} of ${chat.length} lines, oldest first):`
      : 'RECENT CHAT: (no chat yet)',
    ...shown,
  ].join('\n')
}
