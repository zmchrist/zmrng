import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentTarget, Message, MessageKind } from './types.js'

const exec = promisify(execFile)

/** The narrow structured-logging surface the responder needs (Pino-compatible). */
export interface ResponderLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/** One agent-bound chat turn, matching the U4 `fetch(agent.url)` request shape. */
export interface AgentChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// ---- pure helpers ----------------------------------------------------------

/**
 * True when `body` mentions the team bot by its `botHandle` (e.g. `@agent`).
 * Word-boundary anchored so a longer handle (`@agentsmith`) or an email local
 * part (`foo@agent.com`) never falsely triggers: the handle must not be preceded
 * or followed by a word character. An empty/blank handle never matches. Pure and
 * unit-tested — this is the sole trigger gate (no always-listening).
 */
export function detectMention(body: string, botHandle: string): boolean {
  const handle = botHandle.trim()
  if (!handle) return false
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `(?<!\w)` rejects `foo@agent` (the `@` is preceded by a word char); `(?!\w)`
  // rejects `@agentsmith` (the handle is followed by a word char).
  const re = new RegExp(`(?<!\\w)${escaped}(?!\\w)`)
  return re.test(body)
}

/**
 * Derive the author name the bot posts under from its handle by dropping a
 * single leading `@` (`@agent` -> `agent`). Falls back to the trimmed handle.
 */
export function botAuthorFromHandle(botHandle: string): string {
  const handle = botHandle.trim()
  return handle.startsWith('@') ? handle.slice(1) : handle
}

/**
 * Turn a channel's recent scrollback into the agent-bound `messages` array. The
 * bot's own prior posts (`kind === 'agent'`) map to `assistant`; every human
 * post maps to `user`, prefixed with the author handle so the shared agent can
 * tell teammates apart in a multi-party channel. Pure — `history` is expected
 * oldest-first (as `db.listMessages` returns it), and the triggering mention is
 * the final entry.
 */
export function buildAgentMessages(history: Message[]): AgentChatMessage[] {
  return history.map((m) =>
    m.kind === 'agent'
      ? { role: 'assistant' as const, content: m.body }
      : { role: 'user' as const, content: `${m.author}: ${m.body}` },
  )
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/**
 * Extract the reply text from a raw agent HTTP body, tolerantly. Accepts a JSON
 * object carrying `reply` | `content` | `text` | `message` (first string wins),
 * else falls back to the raw body trimmed. Pure — no `any`, mirrors the
 * asRecord/asString tolerance the repo uses for untyped fetch responses.
 */
export function parseAgentReply(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const obj = asRecord(JSON.parse(trimmed))
    if (obj) {
      for (const key of ['reply', 'content', 'text', 'message']) {
        const v = obj[key]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  return trimmed
}

/**
 * Resolve which configured `AgentTarget` acts as the team bot. When `botAgentId`
 * names a configured agent it wins; otherwise the FIRST configured agent is the
 * bot (D4 default). Returns `undefined` when no agents are configured — the
 * responder is then disabled and mentions are a graceful no-op.
 */
export function resolveBotAgent(
  agents: AgentTarget[],
  botAgentId: string,
): AgentTarget | undefined {
  const id = botAgentId.trim()
  if (id) {
    const match = agents.find((a) => a.id === id)
    if (match) return match
  }
  return agents[0]
}

// ---- agent responder -------------------------------------------------------

/** Persist-and-fan-out sink — the ChannelManager's `post`, injected. */
type PostFn = (
  channelId: number,
  author: string,
  body: string,
  kind: MessageKind,
) => Message | undefined

/** Best-effort `git pull` of the read-only reference checkout. */
type PullFn = (checkoutPath: string) => Promise<void>

export interface AgentResponderDeps {
  /** The resolved bot AgentTarget (the U4 endpoint the mention is relayed to). */
  botAgent: AgentTarget
  /** The mention handle, e.g. `@agent`. */
  botHandle: string
  /** How many recent messages of the channel to send as context (default 20). */
  scrollback: number
  /** Read-only reference checkout path git-pulled before answering ('' = skip). */
  checkoutPath: string
  /** Recent-scrollback source (narrowed for testability). */
  listMessages: (channelId: number, before: number | null, limit: number) => Message[]
  /** Persist + fan out the agent reply (ChannelManager.post, injected). */
  post: PostFn
  /** Structured logger (Pino-compatible). */
  log: ResponderLog
  /** Injected fetch seam (defaults to global fetch). */
  fetchFn?: typeof fetch
  /** Injected pull seam (defaults to `git -C <path> pull --ff-only`). */
  pullFn?: PullFn
}

/**
 * The ONE shared team-agent responder (D8): a single instance wired once at
 * server construction serves EVERY channel's mentions — never one instance per
 * channel. The 'persistent memory' is a property of the remote Hermes endpoint
 * (D4); this class just routes every channel's mention to that one endpoint.
 *
 * On a mention it: (1) best-effort `git pull`s the read-only reference checkout
 * (never throws into the caller), (2) gathers the last N messages of THAT
 * channel, (3) relays them to the bot AgentTarget via the U4 `fetch(agent.url)`
 * request/response adapter, and (4) posts the reply back into the SAME channel
 * as a `kind='agent'` message so it persists + fans out + renders distinguishably.
 * It never creates worktrees and never executes code.
 */
export class AgentResponder {
  private readonly fetchFn: typeof fetch
  private readonly pullFn: PullFn

  constructor(private readonly deps: AgentResponderDeps) {
    this.fetchFn = deps.fetchFn ?? fetch
    this.pullFn = deps.pullFn ?? defaultPull
  }

  /** True when `body` mentions this bot's handle. */
  mentions(body: string): boolean {
    return detectMention(body, this.deps.botHandle)
  }

  /**
   * Handle a mention in `channelId`. Best-effort throughout: any failure (pull,
   * fetch, non-OK status) is logged structurally and swallowed — this never
   * throws, so the socket message handler can fire it without a try/catch and
   * the socket can never crash on an agent failure. Posts a `kind='agent'` reply
   * only on a successful, non-empty response.
   */
  async handleMention(channelId: number): Promise<void> {
    const botAuthor = botAuthorFromHandle(this.deps.botHandle)
    await this.pull()
    const history = this.deps.listMessages(channelId, null, this.deps.scrollback)
    const messages = buildAgentMessages(history)
    const url = this.deps.botAgent.url
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.deps.botAgent.headers },
        body: JSON.stringify({
          messages,
          context: { channelId, checkoutPath: this.deps.checkoutPath },
        }),
      })
      if (!res.ok) {
        this.deps.log.error(
          { channelId, agentId: this.deps.botAgent.id, status: res.status },
          'team-agent upstream returned an error',
        )
        return
      }
      const reply = parseAgentReply(await res.text())
      if (!reply) {
        this.deps.log.warn(
          { channelId, agentId: this.deps.botAgent.id },
          'team-agent returned an empty reply — nothing posted',
        )
        return
      }
      this.deps.post(channelId, botAuthor, reply, 'agent')
      this.deps.log.info({ channelId, agentId: this.deps.botAgent.id }, 'team-agent replied')
    } catch (err) {
      this.deps.log.error(
        { err, channelId, agentId: this.deps.botAgent.id },
        'team-agent fetch failed',
      )
    }
  }

  /** Best-effort reference-checkout refresh. Never throws; skips when unset. */
  private async pull(): Promise<void> {
    const p = this.deps.checkoutPath.trim()
    if (!p) {
      this.deps.log.info({}, 'team-agent reference checkout unset — skipping pull')
      return
    }
    try {
      await this.pullFn(p)
      this.deps.log.info({ checkoutPath: p }, 'team-agent reference checkout pulled')
    } catch (err) {
      this.deps.log.warn(
        { err, checkoutPath: p },
        'team-agent reference-checkout pull failed — continuing',
      )
    }
  }
}

/**
 * Default pull: fast-forward-only `git pull` of the reference checkout. Reuses
 * the `promisify(execFile)` style from worktree.ts. Read-only w.r.t. teammates —
 * one shared reference checkout, never a per-teammate worktree, never code exec.
 */
async function defaultPull(checkoutPath: string): Promise<void> {
  await exec('git', ['-C', checkoutPath, 'pull', '--ff-only'], {
    maxBuffer: 1024 * 1024 * 16,
  })
}
