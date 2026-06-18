import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
function assistantText(obj: Record<string, unknown>): string {
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

/** Extract a text delta from a `stream_event` partial line, if present. */
function partialDelta(obj: Record<string, unknown>): string | undefined {
  const ev = asRecord(obj.event)
  if (ev?.type === 'content_block_delta') {
    const delta = asRecord(ev.delta)
    if (delta?.type === 'text_delta') return asString(delta.text)
  }
  return undefined
}

/** Parse token/cost usage from a `result` line; returns undefined when absent. */
function parseUsage(obj: Record<string, unknown>): ResultUsage | undefined {
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

  constructor(opts: SpawnOptions, private cb: RunnerCallbacks) {
    // Strip ANTHROPIC_API_KEY so claude authenticates with the operator's Max
    // OAuth login rather than silently billing the metered API.
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY

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
        return
      }
      case 'result': {
        this.cb.onResult(asString(obj.result) ?? '', obj.is_error === true, parseUsage(obj))
        return
      }
      default:
        return // system/init captured via session_id; other types ignored
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
