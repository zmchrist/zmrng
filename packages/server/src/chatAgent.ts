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
      systemPrompt: chatSystemPrompt(cfg.style, root),
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
