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

/**
 * Owns the set of live terminal PTYs. Each `create()` spawns one shell rooted at
 * `config.projectsDir`; `killAll()` tears them all down on shutdown. Mirrors
 * `TaskManager`'s runner-factory seam so tests never spawn a real shell.
 */
export class TerminalManager {
  private sessions = new Set<PtySession>()

  constructor(private factory: PtyFactory = defaultPtyFactory) {}

  /**
   * Spawn one interactive shell and track it. The child inherits `process.env`
   * (so it sources the user's PATH/HOME/rc files), with `ANTHROPIC_API_KEY`
   * stripped under OAuth mode — mirroring `runner.ts` so a `claude` launched in
   * the terminal uses Max OAuth, never the metered API.
   */
  create(cb: PtyCallbacks): PtySession {
    const env = { ...process.env }
    if (config.authMode === 'oauth') delete env.ANTHROPIC_API_KEY

    const session = this.factory(
      { cwd: config.projectsDir, shell: config.shell, env },
      {
        onData: cb.onData,
        onExit: (code) => {
          // Drop out of the tracked set before notifying, so a later killAll()
          // never double-kills an already-exited shell.
          this.sessions.delete(session)
          cb.onExit(code)
        },
      },
    )
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
