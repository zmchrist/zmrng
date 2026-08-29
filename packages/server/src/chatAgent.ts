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
import type { CaveStyle, ChatClientMsg, EffortLevel } from './types.js'

// ---- conversational system prompt ------------------------------------------

/**
 * The system prompt for a standalone chat-panel agent. Deliberately NOT the
 * zmrng-worker prompt (`phases.ts` `systemPrompt`): there is no task, branch,
 * PR, or control-token protocol here. It frames the agent as a helpful
 * assistant embedded in the zmrng chat panel with read/explore filesystem
 * access to the configured Projects directory, asks it to keep tool use
 * purposeful, and appends the shared caveman `styleDirective` for non-`normal`
 * styles (identical wording to the worker, so the caveman contract stays DRY).
 */
export function chatSystemPrompt(style: CaveStyle, projectsDir: string): string {
  return [
    'You are a helpful assistant embedded in the zmrng chat panel — a live,',
    'conversational side channel, not an autonomous task worker.',
    `You have read and explore filesystem access to the operator's projects at \`${projectsDir}\`.`,
    'This is a free-form conversation with no lifecycle, no phases, and no',
    'special output protocol — just answer, explore, and help directly.',
    'Keep tool use purposeful: surface meaningful actions, not every internal step.',
    styleDirective(style),
  ].join('\n')
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
export class ChatManager {
  private sessions = new Set<RunnerLike>()

  constructor(private factory: RunnerFactory = defaultRunnerFactory) {}

  /** Spawn one chat session with the given controls and track it. */
  create(cfg: ChatConfig, cb: RunnerCallbacks): RunnerLike {
    const root = (cfg.repoId ? repoById(cfg.repoId)?.path : undefined) ?? config.projectsDir
    const opts: SpawnOptions = {
      cwd: root,
      model: cfg.model,
      effort: cfg.effort,
      systemPrompt: cfg.voice ? voiceSystemPrompt(root) : chatSystemPrompt(cfg.style, root),
    }
    const session = this.factory(opts, {
      ...cb,
      onExit: (code, signal) => {
        // Drop out of the tracked set before notifying, so a later killAll()
        // never double-kills an already-exited session.
        this.sessions.delete(session)
        cb.onExit(code, signal)
      },
    })
    this.sessions.add(session)
    return session
  }

  /** Kill and forget every tracked session (graceful shutdown). */
  killAll(): void {
    for (const session of this.sessions) {
      try {
        session.kill()
      } catch {
        // already exited
      }
    }
    this.sessions.clear()
  }
}
