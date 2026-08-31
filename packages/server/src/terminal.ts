import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { config } from './config.js'
import type { TermClientMsg } from './types.js'

/**
 * The surface a terminal WebSocket route depends on: write operator keystrokes,
 * resize the tty, or kill the shell. A node-pty session satisfies this; a test
 * double can too — mirroring the `RunnerLike` seam in `runner.ts`.
 */
export interface PtySession {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** Callbacks a PTY forwards to its owner: shell output, and process exit. */
export interface PtyCallbacks {
  onData(data: string): void
  onExit(code: number | null): void
}

/** Everything the factory needs to spawn one shell. */
export interface PtySpawnOptions {
  cwd: string
  shell: string
  env: NodeJS.ProcessEnv
}

/** Builds the PTY wrapper for one terminal. Swappable for tests/adapters. */
export type PtyFactory = (opts: PtySpawnOptions, cb: PtyCallbacks) => PtySession

// ---- tolerant client-frame parsing -----------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/**
 * Parse one client->server terminal frame from raw WebSocket text. Tolerant:
 * malformed JSON, an unknown `type`, or a missing/ill-typed field all yield
 * `undefined` rather than throwing.
 */
export function parseClientMsg(raw: string): TermClientMsg | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const obj = asRecord(parsed)
  if (!obj) return undefined
  if (obj.type === 'attach') {
    if (typeof obj.cols !== 'number' || typeof obj.rows !== 'number') return undefined
    if (obj.sessionId !== undefined && typeof obj.sessionId !== 'string') return undefined
    const frame: TermClientMsg = { type: 'attach', cols: obj.cols, rows: obj.rows }
    if (typeof obj.sessionId === 'string') frame.sessionId = obj.sessionId
    return frame
  }
  if (obj.type === 'input') {
    return typeof obj.data === 'string' ? { type: 'input', data: obj.data } : undefined
  }
  if (obj.type === 'resize') {
    return typeof obj.cols === 'number' && typeof obj.rows === 'number'
      ? { type: 'resize', cols: obj.cols, rows: obj.rows }
      : undefined
  }
  return undefined
}

// ---- default node-pty factory ----------------------------------------------

/** The default factory: spawn a real login shell via node-pty. */
export const defaultPtyFactory: PtyFactory = (opts, cb) => {
  const term = pty.spawn(opts.shell, [], {
    name: 'xterm-color',
    cwd: opts.cwd,
    env: opts.env,
    cols: 80,
    rows: 24,
  })
  term.onData((d) => cb.onData(d))
  term.onExit(({ exitCode }) => cb.onExit(exitCode))
  return {
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: () => {
      try {
        term.kill()
      } catch {
        // already exited
      }
    },
  }
}

// ---- session-backed terminal manager ---------------------------------------

/** The `setTimeout`/`clearTimeout` pair, injectable so tests drive grace expiry
 *  synchronously instead of waiting on real wall-clock time. */
export interface TimerFns {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

const realTimers: TimerFns = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

/**
 * One live terminal session: the PTY plus a bounded ring buffer of its recent
 * output, the currently-attached socket callbacks (or `null` while detached),
 * and a grace-timer handle that reaps the PTY if nothing reattaches in time.
 */
interface TermSession {
  pty: PtySession
  /** Retained output chunks (oldest first) for replay on reattach. */
  buffer: string[]
  /** Total retained bytes across `buffer`, kept ≤ the byte cap. */
  bufferBytes: number
  /** Attached socket callbacks, or `null` while detached (buffer keeps recording). */
  cb: PtyCallbacks | null
  /** Pending reap timer set while detached; cancelled on reattach. */
  graceTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Owns the live terminal PTYs, keyed by a server-assigned session id. A socket
 * *attaches* to a session rather than *owning* it: on socket close the session is
 * `detach`ed (kept alive for a grace window) instead of killed, so a lock/unlock,
 * a network blip, or a page reload can `attach` back to the same shell and replay
 * its recent output. `killAll()` tears them all down on shutdown. Mirrors
 * `TaskManager`'s runner-factory seam (plus an injectable timer seam) so tests
 * never spawn a real shell or wait on real time.
 */
export class TerminalManager {
  private sessions = new Map<string, TermSession>()

  constructor(
    private factory: PtyFactory = defaultPtyFactory,
    private timers: TimerFns = realTimers,
    private idFactory: () => string = () => randomUUID(),
  ) {}

  private get graceMs(): number {
    return config.terminalGraceMs
  }

  private get maxBufferBytes(): number {
    return config.terminalBufferBytes
  }

  /**
   * Attach a socket's callbacks to a terminal session and return its id plus the
   * bytes to replay so the client can redraw.
   *
   * - Known session → reattach: cancel its grace timer, swap in `cb`, replay the
   *   ring buffer. If it was still attached (e.g. a stale socket), the previous
   *   `cb` is simply dropped — the caller closes that socket.
   * - Unknown / expired / omitted id → spawn a fresh PTY under a new id (empty
   *   replay). The child inherits `process.env` with `ANTHROPIC_API_KEY` stripped
   *   under OAuth mode, mirroring `runner.ts` (Max OAuth, never the metered API).
   */
  attach(sessionId: string | undefined, cb: PtyCallbacks): { sessionId: string; replay: string } {
    if (sessionId) {
      const existing = this.sessions.get(sessionId)
      if (existing) {
        if (existing.graceTimer) {
          this.timers.clearTimeout(existing.graceTimer)
          existing.graceTimer = null
        }
        existing.cb = cb
        return { sessionId, replay: existing.buffer.join('') }
      }
    }

    const id = this.idFactory()
    const env = { ...process.env }
    if (config.authMode === 'oauth') delete env.ANTHROPIC_API_KEY

    const session: TermSession = { pty: null as unknown as PtySession, buffer: [], bufferBytes: 0, cb, graceTimer: null }
    session.pty = this.factory(
      { cwd: config.projectsDir, shell: config.shell, env },
      {
        onData: (data) => {
          this.record(session, data)
          session.cb?.onData(data)
        },
        onExit: (code) => {
          // Drop the session before notifying so a later killAll()/detach never
          // touches an already-exited shell.
          this.sessions.delete(id)
          if (session.graceTimer) this.timers.clearTimeout(session.graceTimer)
          session.cb?.onExit(code)
        },
      },
    )
    this.sessions.set(id, session)
    return { sessionId: id, replay: '' }
  }

  /** Route an operator keystroke frame to the session's PTY (no-op if unknown). */
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data)
  }

  /** Resize the session's tty (no-op if unknown). */
  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.pty.resize(cols, rows)
  }

  /**
   * Detach the socket from a session and start its grace timer. The PTY keeps
   * running (and recording into the buffer) so a reattach within the window can
   * resume it; if nothing reattaches, the timer reaps the PTY. No-op if unknown.
   */
  detach(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.cb = null
    if (session.graceTimer) this.timers.clearTimeout(session.graceTimer)
    session.graceTimer = this.timers.setTimeout(() => {
      this.sessions.delete(sessionId)
      try {
        session.pty.kill()
      } catch {
        // already exited
      }
    }, this.graceMs)
  }

  /** Append output to the ring buffer, dropping oldest bytes past the cap. */
  private record(session: TermSession, data: string): void {
    session.buffer.push(data)
    session.bufferBytes += Buffer.byteLength(data)
    while (session.bufferBytes > this.maxBufferBytes && session.buffer.length > 1) {
      const dropped = session.buffer.shift()
      if (dropped !== undefined) session.bufferBytes -= Buffer.byteLength(dropped)
    }
    // A single chunk larger than the whole cap: keep only its tail.
    if (session.bufferBytes > this.maxBufferBytes && session.buffer.length === 1) {
      let only = session.buffer[0]
      while (Buffer.byteLength(only) > this.maxBufferBytes && only.length > 0) {
        only = only.slice(1)
      }
      session.buffer[0] = only
      session.bufferBytes = Buffer.byteLength(only)
    }
  }

  /** Kill and forget every tracked session, clearing any grace timers (shutdown). */
  killAll(): void {
    for (const session of this.sessions.values()) {
      if (session.graceTimer) this.timers.clearTimeout(session.graceTimer)
      try {
        session.pty.kill()
      } catch {
        // already exited
      }
    }
    this.sessions.clear()
  }
}
