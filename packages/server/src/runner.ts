import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import type { EffortLevel, TaskUsage } from './types.js'

/** Per-result usage delta parsed from a `result` line. Shape mirrors `TaskUsage`. */
export type ResultUsage = TaskUsage

// ---- tolerant JSON helpers (claude stream-json shapes vary across versions) ----

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Concatenate the text blocks of an `assistant` message. */
export function assistantText(obj: Record<string, unknown>): string {
  const msg = asRecord(obj.message)
  const content = msg?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const rb = asRecord(b)
        return rb && rb.type === 'text' ? (asString(rb.text) ?? '') : ''
      })
      .join('')
  }
  return ''
}

/** Trim a string to a sane log length. */
function clip(s: string, max = 200): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * Compact one-line summary of a tool call from its `input` record.
 * Bash→command; Edit/Write/Read/NotebookEdit→file_path; Grep/Glob→pattern;
 * Task→description; fallback→short stringify of the first scalar input value.
 */
export function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const pick = (k: string): string | undefined => asString(input[k])
  switch (name) {
    case 'Bash':
      return clip(pick('command') ?? '')
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return clip(pick('file_path') ?? '')
    case 'Grep':
    case 'Glob':
      return clip(pick('pattern') ?? '')
    case 'Task':
      return clip(pick('description') ?? '')
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === 'string') return clip(v)
        if (typeof v === 'number' || typeof v === 'boolean') return clip(String(v))
      }
      return ''
    }
  }
}

/** Compact summary of a tool_result `content` (string, or array of text blocks). */
export function summarizeResult(content: unknown): string {
  if (typeof content === 'string') return clip(content)
  if (Array.isArray(content)) {
    return clip(
      content
        .map((b) => {
          const rb = asRecord(b)
          return rb && rb.type === 'text' ? (asString(rb.text) ?? '') : ''
        })
        .join(''),
    )
  }
  return ''
}

/** Extract a text delta from a `stream_event` partial line, if present. */
export function partialDelta(obj: Record<string, unknown>): string | undefined {
  const ev = asRecord(obj.event)
  if (ev?.type === 'content_block_delta') {
    const delta = asRecord(ev.delta)
    if (delta?.type === 'text_delta') return asString(delta.text)
  }
  return undefined
}

/** Parse token/cost usage from a `result` line; returns undefined when absent. */
export function parseUsage(obj: Record<string, unknown>): ResultUsage | undefined {
  const u = asRecord(obj.usage)
  if (!u) return undefined
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return {
    tokensIn: n(u.input_tokens),
    tokensOut: n(u.output_tokens),
    tokensCache: n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens),
    costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0,
    turns: typeof obj.num_turns === 'number' ? obj.num_turns : 0,
  }
}

export interface RunnerCallbacks {
  onSession(sessionId: string): void
  onAssistantText(text: string): void
  onPartial(text: string): void
  onResult(text: string, isError: boolean, usage: ResultUsage | undefined): void
  onToolUse(name: string, summary: string, isSubagent: boolean, subagentType?: string): void
  onSubagentResult(subagentType: string, summary: string, isError: boolean): void
  onExit(code: number | null, signal: NodeJS.Signals | null): void
  onSpawnError(err: Error): void
}

export interface SpawnOptions {
  cwd: string
  model: string
  effort: EffortLevel
  systemPrompt: string
}

const CLAUDE_ARGS_BASE = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--dangerously-skip-permissions',
]

/**
 * Wraps a single long-lived `claude` headless process for one task. Writes
 * operator turns to its stdin (stream-json) and parses event lines from stdout.
 */
export class Runner {
  private child: ChildProcessWithoutNullStreams
  private buf = ''
  private sessionSeen = false
  /** tool_use_id → subagent_type, for matching a Task spawn to its tool_result. */
  private pendingTasks = new Map<string, string>()

  constructor(opts: SpawnOptions, private cb: RunnerCallbacks) {
    // Strip ANTHROPIC_API_KEY so claude authenticates with the operator's Max
    // OAuth login rather than silently billing the metered API — unless the
    // operator opted into ZMRNG_AUTH_MODE=apikey (keys-only stranger, no Max login).
    const env = { ...process.env }
    if (config.authMode === 'oauth') delete env.ANTHROPIC_API_KEY

    const args = [
      ...CLAUDE_ARGS_BASE,
      '--model',
      opts.model,
      '--effort',
      opts.effort,
      '--append-system-prompt',
      opts.systemPrompt,
      '--add-dir',
      opts.cwd,
    ]

    this.child = spawn('claude', args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.on('error', (err) => this.cb.onSpawnError(err))
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => {
      // claude writes progress/diagnostics to stderr; intentionally ignored
    })
    this.child.on('exit', (code, signal) => this.cb.onExit(code, signal))
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (line) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let obj: Record<string, unknown> | undefined
    try {
      obj = asRecord(JSON.parse(line))
    } catch {
      return // tolerant: ignore non-JSON noise
    }
    if (!obj) return

    const sid = asString(obj.session_id)
    if (sid && !this.sessionSeen) {
      this.sessionSeen = true
      this.cb.onSession(sid)
    }

    switch (asString(obj.type)) {
      case 'stream_event': {
        const d = partialDelta(obj)
        if (d) this.cb.onPartial(d)
        return
      }
      case 'assistant': {
        const text = assistantText(obj)
        if (text.trim()) this.cb.onAssistantText(text)
        this.handleToolUse(obj)
        return
      }
      case 'user': {
        this.handleToolResult(obj)
        return
      }
      case 'result': {
        this.cb.onResult(asString(obj.result) ?? '', obj.is_error === true, parseUsage(obj))
        return
      }
      default:
        // system/init captured via session_id; other types ignored.
        // The child may emit `control_request`/`control_response` lines of its own;
        // under `--dangerously-skip-permissions` no control responder is required.
        return
    }
  }

  /** Walk an `assistant` message for `tool_use` blocks (main tools + Task spawns). */
  private handleToolUse(obj: Record<string, unknown>): void {
    const msg = asRecord(obj.message)
    const content = msg?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      const rb = asRecord(block)
      if (!rb || rb.type !== 'tool_use') continue
      const name = asString(rb.name)
      if (!name) continue
      const input = asRecord(rb.input)
      const id = asString(rb.id)
      if (name === 'Task') {
        const subagentType = asString(input?.subagent_type) ?? 'subagent'
        if (id) {
          // Bounded guard: drop the oldest tracked spawns if the map runs away.
          if (this.pendingTasks.size > 200) {
            const oldest = this.pendingTasks.keys().next().value
            if (oldest) this.pendingTasks.delete(oldest)
          }
          this.pendingTasks.set(id, subagentType)
        }
        this.cb.onToolUse(name, summarizeTool(name, input), true, subagentType)
      } else {
        this.cb.onToolUse(name, summarizeTool(name, input), false)
      }
    }
  }

  /** Walk a `user` message for `tool_result` blocks tied to a tracked Task spawn. */
  private handleToolResult(obj: Record<string, unknown>): void {
    const msg = asRecord(obj.message)
    const content = msg?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      const rb = asRecord(block)
      if (!rb || rb.type !== 'tool_result') continue
      const id = asString(rb.tool_use_id)
      if (!id) continue
      const subagentType = this.pendingTasks.get(id)
      // Main-worker tool results are intentionally not surfaced; only tracked Tasks.
      if (!subagentType) continue
      this.cb.onSubagentResult(subagentType, summarizeResult(rb.content), rb.is_error === true)
      this.pendingTasks.delete(id)
    }
  }

  /** Send an operator turn into the live session. */
  send(text: string): void {
    const payload =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n'
    this.child.stdin.write(payload)
  }

  /**
   * Send a stream-json interrupt control request to the live child (ESC-style),
   * cutting the in-flight turn without killing the process. The child keeps the
   * session and idles awaiting the operator's next message.
   */
  interrupt(): void {
    try {
      const payload =
        JSON.stringify({
          type: 'control_request',
          request_id: randomUUID(),
          request: { subtype: 'interrupt' },
        }) + '\n'
      this.child.stdin.write(payload)
    } catch {
      // stdin already closed
    }
  }

  /** Close stdin and terminate the child process. */
  kill(): void {
    try {
      this.child.stdin.end()
    } catch {
      // stdin already closed
    }
    try {
      this.child.kill('SIGTERM')
    } catch {
      // already exited
    }
  }
}

/**
 * The surface `TaskManager` depends on: enough to drive a worker turn, stop it,
 * or kill it. `Runner` satisfies this; a test double (or, later, a pluggable
 * agent adapter — see Appendix A of the productization plan) can too.
 */
export interface RunnerLike {
  send(text: string): void
  interrupt(): void
  kill(): void
}

/** Builds the worker process wrapper for a task's phase. Swappable for tests/adapters. */
export type RunnerFactory = (opts: SpawnOptions, cb: RunnerCallbacks) => RunnerLike

/** The default factory: spawn the real `claude` child. */
export const defaultRunnerFactory: RunnerFactory = (opts, cb) => new Runner(opts, cb)
