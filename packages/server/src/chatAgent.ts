import { randomUUID } from 'node:crypto'
import { config, repoById } from './config.js'
import { styleDirective } from './phases.js'
import {
  defaultRunnerFactory,
  sanitizeAttachments,
  type RunnerCallbacks,
  type RunnerFactory,
  type RunnerLike,
  type SpawnOptions,
} from './runner.js'
import type {
  CaveStyle,
  ChatClientMsg,
  EffortLevel,
  LaneChat,
  TaskUsage,
  WorkflowPreset,
} from './types.js'

// ---- workflow presets ------------------------------------------------------

/**
 * The directive body for each named workflow preset, keyed by `WorkflowPreset`.
 * zmrng OWNS these committed copies (ADR-0002 D3): they are authored for zmrng
 * users and are NEVER read from or symlinked to the operator's `~/.hermes`
 * skills at runtime, so a fresh clone works with no external setup. They are
 * allowed to drift from the operator's evolving personal skills of the same
 * name — different audiences. Only single-session-viable presets ship here
 * (ADR-0002 D4): `grill` and `teach-me`. `code-review` lands in #159; `none`
 * appends nothing. Each is inlined into the chat system prompt with zero tool
 * round-trips, exactly like `styleDirective`.
 */
const WORKFLOW_BODIES: Record<Exclude<WorkflowPreset, 'none' | 'code-review'>, string> = {
  grill: [
    'Operate in GRILL mode: interrogate the idea before building anything.',
    '- Do NOT write code, edit files, or take irreversible action until the operator',
    '  and you share an explicit understanding of the goal and approach.',
    '- Ask questions to close the gaps, but be economical: batch INDEPENDENT questions',
    '  into one message; only serialize a question when its answer genuinely depends on',
    '  the answer to a previous one.',
    '- For EVERY question, recommend your own best answer (a default the operator can',
    '  simply confirm) — never ask an open question you could answer yourself.',
    '- Look facts up; do not ask the operator for anything you can determine by reading',
    '  the code, files, or configuration yourself. Reserve questions for genuine',
    '  judgment calls and missing intent.',
    '- Surface tradeoffs, risks, and rejected alternatives; push back on weak premises',
    '  rather than agreeing by default.',
    '- Only once the shared understanding is explicit should you propose enacting it.',
  ].join('\n'),
  'teach-me': [
    'Operate in TEACH-ME mode: explain as you go so the operator learns, not just gets an answer.',
    '- Lead with the concept and the "why" before the "how"; build from what the operator',
    '  already knows toward the new idea.',
    '- Prefer clear, concrete explanations and small worked examples over terse assertions.',
    '- Define jargon the first time you use it; call out common misconceptions and pitfalls.',
    '- When you show code or a command, explain what each meaningful part does and why.',
    '- Check understanding: offer a brief recap of the key takeaways, and invite follow-up',
    '  questions rather than assuming the explanation landed.',
    '- Favor teaching the transferable principle over solving only the immediate instance.',
  ].join('\n'),
}

/**
 * Working-mode block appended to the chat system prompt for a selected workflow
 * preset — structurally identical to `styleDirective` (an inlined instruction
 * block, zero tool round-trips) and COMPOSING with it (ADR-0002 D5): style is
 * narration register, workflow is session behavior; both append. `'none'` (the
 * default) and `'code-review'` (reserved for #159) return `''`, so the prompt is
 * byte-identical to the pre-workflow one when no shipped preset is selected.
 */
export function workflowDirective(workflow: WorkflowPreset): string {
  if (workflow === 'none' || workflow === 'code-review') return ''
  return ['', 'WORKING MODE:', WORKFLOW_BODIES[workflow]].join('\n')
}

// ---- conversational system prompt ------------------------------------------

/**
 * The system prompt for a standalone chat-panel agent. Deliberately NOT the
 * zmrng-worker prompt (`phases.ts` `systemPrompt`): there is no task, branch,
 * PR, or control-token protocol here. It frames the agent as a helpful
 * assistant embedded in the zmrng chat panel with read/explore filesystem
 * access to the configured Projects directory, asks it to keep tool use
 * purposeful, and appends the shared caveman `styleDirective` for non-`normal`
 * styles (identical wording to the worker, so the caveman contract stays DRY),
 * then the `workflowDirective` for the selected preset. The two directives are
 * orthogonal and both append (ADR-0002 D5): `style = 'normal'` and
 * `workflow = 'none'` (the defaults) each add nothing, so the prompt is
 * byte-identical to the pre-workflow one.
 */
export function chatSystemPrompt(
  style: CaveStyle,
  projectsDir: string,
  workflow: WorkflowPreset = 'none',
): string {
  // `styleDirective` stays the final array element (preserving the exact
  // pre-workflow output); `workflowDirective` is concatenated as a suffix so a
  // `'none'` workflow (→ `''`) leaves the prompt byte-identical to before, while
  // a selected preset appends its block after the style block (ADR-0002 D5).
  return (
    [
      'You are a helpful assistant embedded in the zmrng chat panel — a live,',
      'conversational side channel, not an autonomous task worker.',
      `You have read and explore filesystem access to the operator's projects at \`${projectsDir}\`.`,
      'This is a free-form conversation with no lifecycle, no phases, and no',
      'special output protocol — just answer, explore, and help directly.',
      'Keep tool use purposeful: surface meaningful actions, not every internal step.',
      styleDirective(style),
    ].join('\n') + workflowDirective(workflow)
  )
}

/**
 * The system prompt for the Local Voice Chat surface. Unlike `chatSystemPrompt`,
 * this is a fixed *spoken* register — every reply is read aloud by a TTS engine,
 * so the persona optimizes for the ear, not the eye. It deliberately does NOT
 * take a `CaveStyle`: caveman is a text-compression register that sounds broken
 * when spoken, so voice always uses this one warm, natural-speech voice. Same
 * read/explore filesystem access and no-lifecycle framing as the text chat; only
 * the delivery contract differs.
 */
export function voiceSystemPrompt(projectsDir: string): string {
  return [
    'You are a voice assistant embedded in zmrng. Every reply you write is spoken',
    'aloud to the operator by a text-to-speech engine, so speak — do not write.',
    `You have read and explore filesystem access to the operator's projects at \`${projectsDir}\`.`,
    'This is a free-form spoken conversation: no tasks, phases, branches, PRs, or',
    'control tokens. Just talk, explore, and help.',
    '',
    'HOW TO SPEAK:',
    '- Warm, natural, concise — like a sharp colleague talking, not a document being read.',
    '- Plain conversational prose ONLY. No markdown, asterisks, bullet or numbered',
    '  lists, headings, tables, or code blocks — a TTS engine reads those symbols',
    '  literally ("asterisk", "bullet") and it sounds broken.',
    '- Keep turns short: one to three sentences by default. The operator can interrupt',
    '  you, and a long monologue cannot be barged cleanly. If there is more to say,',
    '  give the headline and offer to go deeper.',
    '- Never read code, file contents, diffs, or long identifiers aloud. Summarize in',
    '  words ("I changed the runner to strip the API key") and offer to show it on',
    '  screen instead.',
    '- Say numbers, paths, and symbols the way a person would: "port forty-five',
    '  hundred", not "4500"; "the runner file", not "runner dot t s".',
    '- Natural acknowledgments ("got it", "okay", "mm-hm") are good — they keep the',
    '  conversation feeling alive.',
    '- This is NOT caveman: speak in full, warm, natural sentences.',
    '',
    'Keep tool use purposeful and quiet: explore when it helps, but narrate only the',
    'meaningful result in a sentence, never a play-by-play of every step.',
  ].join('\n')
}

// ---- tolerant client-frame parsing -----------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/**
 * Parse one client->server chat frame from raw WebSocket text. Tolerant:
 * malformed JSON, an unknown `type`, or a missing/ill-typed field all yield
 * `undefined` rather than throwing (mirrors `terminal.ts` `parseClientMsg`).
 */
export function parseChatClientMsg(raw: string): ChatClientMsg | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const obj = asRecord(parsed)
  if (!obj) return undefined
  if (obj.type === 'start') {
    if (
      typeof obj.model === 'string' &&
      typeof obj.effort === 'string' &&
      typeof obj.style === 'string'
    ) {
      return {
        type: 'start',
        model: obj.model,
        effort: obj.effort as EffortLevel,
        style: obj.style as CaveStyle,
        ...(typeof obj.repoId === 'string' ? { repoId: obj.repoId } : {}),
        // Tolerant like the other optional fields: a missing/ill-typed workflow
        // is simply dropped, defaulting to `'none'` downstream. `'none'` is
        // omitted so a default frame stays byte-identical to the pre-workflow one.
        ...(typeof obj.workflow === 'string' && obj.workflow !== 'none'
          ? { workflow: obj.workflow as WorkflowPreset }
          : {}),
        ...(obj.voice === true ? { voice: true } : {}),
      }
    }
    return undefined
  }
  if (obj.type === 'input') {
    if (typeof obj.text !== 'string') return undefined
    // Tolerant: a malformed/oversized/disallowed attachments field is dropped,
    // never thrown on. Only attach when at least one entry survives sanitizing.
    const attachments = sanitizeAttachments(obj.attachments)
    return attachments.length > 0
      ? { type: 'input', text: obj.text, attachments }
      : { type: 'input', text: obj.text }
  }
  if (obj.type === 'interrupt') {
    return { type: 'interrupt' }
  }
  return undefined
}

// ---- chat session manager --------------------------------------------------

/** The controls chosen for one chat session (per-tab, ephemeral). */
export interface ChatConfig {
  model: string
  effort: EffortLevel
  style: CaveStyle
  /** Picks which registered repo the session's cwd is rooted at. A missing or
   *  unresolvable id falls back to `config.projectsDir` ("Projects root"). */
  repoId?: string
  /** Optional named working mode; its `workflowDirective` block is appended to
   *  the chat system prompt, composing with `style`. Defaults to `'none'`
   *  (appends nothing). Ignored on the voice branch, like `style`. */
  workflow?: WorkflowPreset
  /** When true, spawn with `voiceSystemPrompt` (spoken register) instead of
   *  `chatSystemPrompt`; `style` is then ignored. Set by the Voice surface. */
  voice?: boolean
}

/**
 * Owns the set of live chat `Runner`s. Each `create()` spawns one conversational
 * `claude` rooted at the chosen repo's path (`cfg.repoId`, resolved via
 * `repoById`), or `config.projectsDir` when `repoId` is absent/unresolvable
 * ("Projects root", the default). No worktree is created — the session just
 * runs at the repo root; `killAll()` tears every session down on shutdown.
 * Mirrors `TerminalManager`'s factory seam so tests never spawn a real
 * `claude`. The OAuth env-strip already lives inside `Runner`'s constructor, so
 * (unlike `TerminalManager`) this manager does not repeat it.
 */
/**
 * What the manager remembers about one live chat session, over and above the
 * `RunnerLike` handle itself: the controls it was spawned with, the repo it is
 * rooted at, and a running usage accumulator folded in from each `result`. All
 * in-memory and transient — a chat session is never persisted.
 */
interface ChatSessionMeta {
  id: string
  model: string
  effort: EffortLevel
  style: CaveStyle
  /** The RESOLVED registered repo, or `null` for the Projects-root fallback. */
  repoId: string | null
  voice: boolean
  startedAt: string
  usage: TaskUsage
}

/** A zeroed usage accumulator for a freshly-created session. */
function emptyUsage(): TaskUsage {
  return { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 }
}

export class ChatManager {
  /** Live sessions keyed by their runner handle (the identity the route holds). */
  private sessions = new Map<RunnerLike, ChatSessionMeta>()

  /**
   * @param idFactory assigns each session's row id. Defaults to `randomUUID`;
   *   tests inject a deterministic counter (copying `TerminalManager`'s seam).
   * @param onChange fired whenever the live-session set or a session's usage
   *   changes, so the lane emitter can coalesce a rebuild. Both params are
   *   optional and trailing: existing one-argument constructions are unaffected.
   */
  constructor(
    private factory: RunnerFactory = defaultRunnerFactory,
    private idFactory: () => string = () => randomUUID(),
    private onChange: () => void = () => {},
  ) {}

  /** Spawn one chat session with the given controls and track it. */
  create(cfg: ChatConfig, cb: RunnerCallbacks): RunnerLike {
    const repo = cfg.repoId ? repoById(cfg.repoId) : undefined
    const root = repo?.path ?? config.projectsDir
    const opts: SpawnOptions = {
      cwd: root,
      model: cfg.model,
      effort: cfg.effort,
      systemPrompt: cfg.voice
        ? voiceSystemPrompt(root)
        : chatSystemPrompt(cfg.style, root, cfg.workflow ?? 'none'),
    }
    const meta: ChatSessionMeta = {
      id: this.idFactory(),
      model: cfg.model,
      effort: cfg.effort,
      style: cfg.style,
      // Derived exactly like `root` above: an absent OR unresolvable repoId is
      // the "Projects root" fallback, and reports as `null` rather than echoing
      // an id the session is not actually rooted at.
      repoId: repo?.id ?? null,
      voice: cfg.voice === true,
      startedAt: new Date().toISOString(),
      usage: emptyUsage(),
    }
    const session = this.factory(opts, {
      ...cb,
      onResult: (text, isError, usage) => {
        // Fold the result's usage delta into the session accumulator BEFORE
        // calling through, so a caller reacting to `onResult` already sees the
        // updated snapshot. The pass-through contract is unchanged: same args,
        // always called.
        if (usage) {
          const acc = meta.usage
          acc.tokensIn += usage.tokensIn
          acc.tokensOut += usage.tokensOut
          acc.tokensCache += usage.tokensCache
          acc.costUsd += usage.costUsd
          acc.turns += usage.turns
          this.onChange()
        }
        cb.onResult(text, isError, usage)
      },
      onExit: (code, signal) => {
        // Drop out of the tracked map before notifying, so a later killAll()
        // never double-kills an already-exited session.
        this.sessions.delete(session)
        this.onChange()
        cb.onExit(code, signal)
      },
    })
    this.sessions.set(session, meta)
    this.onChange()
    return session
  }

  /** Kill and forget every tracked session (graceful shutdown). */
  killAll(): void {
    for (const session of this.sessions.keys()) {
      try {
        session.kill()
      } catch {
        // already exited
      }
    }
    this.sessions.clear()
    this.onChange()
  }

  /** One read-only `LaneChat` row per LIVE session, for the lane viewer. The
   *  usage object is copied so a later fold-in can't mutate an emitted frame. */
  snapshot(): LaneChat[] {
    return [...this.sessions.values()].map((m) => ({
      id: m.id,
      model: m.model,
      effort: m.effort,
      style: m.style,
      repoId: m.repoId,
      voice: m.voice,
      startedAt: m.startedAt,
      usage: { ...m.usage },
    }))
  }
}
