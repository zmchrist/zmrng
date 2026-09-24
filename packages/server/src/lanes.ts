// Type-only import: `terminal.ts` pulls in node-pty at runtime, and the lane
// assembler must stay importable (and unit-testable) without it. The timer seam
// itself is re-declared locally below.
import type { TimerFns } from './terminal.js'
import type { LaneChat, LaneOccupancy, LaneSnapshot, LaneTerminal, LaneWorker } from './types.js'

/**
 * The three live-session managers the lane snapshot is assembled from, reduced
 * to the read-only accessors it actually needs. Injecting the accessors (rather
 * than the managers) is what keeps `buildLaneSnapshot` pure and hermetic.
 */
export interface LaneSources {
  /** `TaskManager.laneSnapshot()` — the execute-lane pool plus live worker rows. */
  tasks(): { execute: LaneOccupancy; workers: LaneWorker[] }
  /** `ChatManager.snapshot()` — live standalone chat sessions. */
  chats(): LaneChat[]
  /** `TerminalManager.snapshot()` — live PTY sessions. */
  terminals(): LaneTerminal[]
}

/**
 * Assemble the exact payload `GET /api/lanes` and the `lanes` WebSocket frame
 * carry. Pure: every input arrives through `sources` and the timestamp is
 * passed in, so the whole wire shape is testable without booting Fastify or
 * spawning anything. Each source is read exactly once per build.
 */
export function buildLaneSnapshot(sources: LaneSources, at: string): LaneSnapshot {
  const { execute, workers } = sources.tasks()
  return { at, execute, workers, chats: sources.chats(), terminals: sources.terminals() }
}

/** The real `setTimeout` pair, mirroring `terminal.ts`'s default timer seam. */
const realTimers: TimerFns = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

/** Default coalescing window (ms) for a burst of lane changes. */
const DEFAULT_DELAY_MS = 150

/**
 * Coalescing broadcaster for the lane snapshot. A single subagent tool event can
 * fire several `onChange` notifications in a row, and a busy instance fires them
 * from three managers at once — so `notify()` schedules ONE trailing build+send
 * and absorbs every further notify inside that window, rather than rebuilding
 * and re-serializing the frame per event.
 */
export class LaneEmitter {
  /** The pending trailing timer, or `null` when no send is scheduled. */
  private pending: ReturnType<typeof setTimeout> | null = null

  /**
   * @param sources the three managers' read-only snapshot accessors.
   * @param send sink for a built snapshot (the hub broadcast in `index.ts`).
   * @param timers injectable timer seam so tests drive the window synchronously.
   * @param delayMs the coalescing window.
   * @param clock supplies the snapshot's `at` instant (injectable for tests).
   */
  constructor(
    private sources: LaneSources,
    private send: (snapshot: LaneSnapshot) => void,
    private timers: TimerFns = realTimers,
    private delayMs: number = DEFAULT_DELAY_MS,
    private clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Request a push. Absorbed if one is already scheduled (trailing, not leading). */
  notify(): void {
    if (this.pending !== null) return
    this.pending = this.timers.setTimeout(() => {
      // Cleared BEFORE the send so a notify raised by the send path re-arms the
      // window instead of being swallowed.
      this.pending = null
      this.send(this.snapshot())
    }, this.delayMs)
  }

  /** Build a snapshot right now, without scheduling or sending — the REST route
   *  (`GET /api/lanes`) and the `/ws` connect frame both use this. */
  snapshot(): LaneSnapshot {
    return buildLaneSnapshot(this.sources, this.clock())
  }
}
