// Server-side version poller (WS-B / D3). Periodically `git fetch`es origin and
// compares origin/main to the running HEAD; when origin/main is ahead, it holds
// the latest-known sha in memory and notifies a callback so the caller can
// broadcast a `new-version` frame over /ws/workspace. The pure comparison seam
// (`isAhead`) is unit-tested; the fetch/interval glue is untested I/O (same
// policy as the terminal/ML glue).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Pure: true iff `remoteSha` is a non-empty sha that differs from the running
 * `localSha` — i.e. origin/main has advanced to code this instance is not on.
 * An empty `remoteSha` (nothing fetched yet) is never "ahead". An empty
 * `localSha` (HEAD unreadable at boot) still counts a known remote as ahead so
 * the update signal is not silently suppressed.
 */
export function isAhead(localSha: string, remoteSha: string): boolean {
  return remoteSha.length > 0 && remoteSha !== localSha
}

export interface VersionPollerOptions {
  /** zmrng checkout root to fetch/compare in. */
  repoRoot: string
  /** This instance's running HEAD sha (from config.headSha). */
  localSha: string
  /** Poll cadence in ms. A non-positive value disables polling (laptop default). */
  intervalMs: number
  /** Invoked with the latest origin/main sha each time it moves ahead. */
  onNewVersion: (sha: string) => void
  /** Invoked when a fetch/parse cycle throws (logged by the caller via Pino). */
  onError: (err: unknown) => void
}

/**
 * Start the poller. Returns a stop function. A non-positive `intervalMs`
 * disables it entirely (returns a no-op stop) so ordinary laptops never
 * background-fetch — only the VPS opts in via `ZMRNG_VERSION_POLL_MS`. Each tick
 * fetches origin/main and, when `isAhead`, fires `onNewVersion` at most once per
 * distinct sha. Never throws — cycle failures go to `onError`.
 */
export function startVersionPoller(opts: VersionPollerOptions): () => void {
  if (opts.intervalMs <= 0) return () => {}
  let lastSeen = ''
  let stopped = false

  const tick = async (): Promise<void> => {
    try {
      await execFileAsync('git', ['-C', opts.repoRoot, 'fetch', '--quiet', 'origin', 'main'])
      const { stdout } = await execFileAsync('git', [
        '-C',
        opts.repoRoot,
        'rev-parse',
        'origin/main',
      ])
      const remote = stdout.trim()
      if (isAhead(opts.localSha, remote) && remote !== lastSeen) {
        lastSeen = remote
        opts.onNewVersion(remote)
      }
    } catch (err) {
      opts.onError(err)
    }
  }

  const timer = setInterval(() => {
    if (!stopped) void tick()
  }, opts.intervalMs)
  timer.unref()
  void tick()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
