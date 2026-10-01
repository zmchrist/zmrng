import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { promisify } from 'node:util'
import type { LoopLoad } from './types.js'

/**
 * The gauntlet loop's machine-load probe (D7 of .agents/plans/gauntlet-loop-tab.md).
 * The orchestrator reads a sample to choose a lane count, and `LoopManager`
 * hard-gates every NEW pick on `allowsNewLane`.
 *
 * Memory is AVAILABLE memory, not `os.freemem()`: on macOS `freemem()` counts
 * only truly free pages and excludes the inactive/purgeable cache, so it reads a
 * few hundred MB on a healthy machine and a gate on it would block every pick.
 * Linux reads `MemAvailable` from `/proc/meminfo`; macOS sums free + inactive +
 * speculative + purgeable pages from `vm_stat`; anything else (or any failure)
 * falls back to `os.freemem()`.
 */

const BYTES_PER_MB = 1024 * 1024

/** Cap on a `vm_stat` run so a hung child can never stall a pick. */
const VM_STAT_TIMEOUT_MS = 5000

export interface LoadThresholds {
  /** Picks pause while the 1-minute load average per core exceeds this. */
  maxLoadPerCore: number
  /** Picks pause while available memory is below this many MB. */
  minFreeMemMb: number
}

/** One raw reading, before the thresholds are applied. */
export interface RawLoad {
  cores: number
  loadAvg1: number
  memTotalMb: number
  memAvailableMb: number
}

/** `MemAvailable` (kB) from `/proc/meminfo` as whole MB, rounded down; null when absent. */
export function parseMeminfo(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+)(?:\s*kB)?\s*$/m.exec(text)
  return m ? Math.floor(Number(m[1]) / 1024) : null
}

/** The page count on one `vm_stat` line (e.g. `Pages free:   12345.`), or null when absent. */
function vmStatPages(text: string, label: string): number | null {
  const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text)
  return m ? Number(m[1]) : null
}

/**
 * Available memory in whole MB (rounded down) from macOS `vm_stat` output: the
 * header's page size x (free + inactive + speculative + purgeable pages). Null on
 * a missing/malformed page-size header, or when there is no `Pages free` line at
 * all (the output is not `vm_stat`'s); the other three lines are optional and
 * count 0 when missing (older macOS has no speculative/purgeable lines).
 */
export function parseVmStat(text: string): number | null {
  const header = /page size of (\d+) bytes/.exec(text)
  const pageSize = header ? Number(header[1]) : 0
  if (pageSize <= 0) return null
  const free = vmStatPages(text, 'Pages free')
  if (free === null) return null
  const pages =
    free +
    (vmStatPages(text, 'Pages inactive') ?? 0) +
    (vmStatPages(text, 'Pages speculative') ?? 0) +
    (vmStatPages(text, 'Pages purgeable') ?? 0)
  return Math.floor((pages * pageSize) / BYTES_PER_MB)
}

/** Round to 2 decimals (the precision `loadPerCore` is shown and compared at). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Apply the thresholds to one raw reading. `loadPerCore` = `loadAvg1 / cores`
 * rounded to 2 dp (a core count below 1 counts as 1). A new lane is refused
 * while `loadPerCore` is strictly OVER `maxLoadPerCore` or `memAvailableMb` is
 * strictly UNDER `minFreeMemMb`; `reason` names each tripped threshold with its
 * numbers (joined `; `) and is null when allowed. A `[0,0,0]` load average
 * (Windows has none) therefore never trips the CPU half; memory still gates.
 */
export function assessLoad(raw: RawLoad, t: LoadThresholds, now: Date = new Date()): LoopLoad {
  const cores = Number.isFinite(raw.cores) && raw.cores >= 1 ? raw.cores : 1
  const loadAvg1 = Number.isFinite(raw.loadAvg1) && raw.loadAvg1 > 0 ? raw.loadAvg1 : 0
  const loadPerCore = round2(loadAvg1 / cores)
  const reasons: string[] = []
  if (loadPerCore > t.maxLoadPerCore) {
    reasons.push(`load ${loadPerCore.toFixed(2)}/core > ${t.maxLoadPerCore.toFixed(2)}`)
  }
  if (raw.memAvailableMb < t.minFreeMemMb) {
    reasons.push(`available memory ${raw.memAvailableMb} MB < ${t.minFreeMemMb} MB`)
  }
  return {
    cores,
    loadAvg1,
    loadPerCore,
    memTotalMb: raw.memTotalMb,
    memAvailableMb: raw.memAvailableMb,
    maxLoadPerCore: t.maxLoadPerCore,
    minFreeMemMb: t.minFreeMemMb,
    allowsNewLane: reasons.length === 0,
    reason: reasons.length ? reasons.join('; ') : null,
    sampledAt: now.toISOString(),
  }
}

export interface LoadProbe {
  /** A fresh sample. Never rejects. */
  sample(): Promise<LoopLoad>
}

/** The OS/file/process reads behind a sample — injectable so every branch is testable. */
export interface LoadReaders {
  readFile(path: string): Promise<string>
  execFile(cmd: string, args: string[]): Promise<string>
  cpus(): number
  loadavg(): number[]
  /** bytes */
  totalmem(): number
  /** bytes */
  freemem(): number
}

const execFileAsync = promisify(execFile)

const DEFAULT_READERS: LoadReaders = {
  readFile: (p) => readFile(p, 'utf8'),
  execFile: async (cmd, args) => {
    const { stdout } = await execFileAsync(cmd, args, { timeout: VM_STAT_TIMEOUT_MS })
    return stdout
  },
  cpus: () => os.cpus().length,
  loadavg: () => os.loadavg(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
}

/** `read()`, or `fallback` if it throws — a probe must never fail a pick on a bad read. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** Available memory in MB for `platform`; any failure falls back to `freemem()`. */
async function availableMemMb(platform: NodeJS.Platform, r: LoadReaders): Promise<number> {
  try {
    const mb =
      platform === 'linux'
        ? parseMeminfo(await r.readFile('/proc/meminfo'))
        : platform === 'darwin'
          ? parseVmStat(await r.execFile('vm_stat', []))
          : null
    if (mb !== null) return mb
  } catch {
    // unreadable /proc or a failed vm_stat — fall through to freemem()
  }
  return safely(() => Math.floor(r.freemem() / BYTES_PER_MB), 0)
}

/**
 * The production probe: `node:os` for cores / load / total memory, plus the
 * platform's available-memory source (see the module comment). `platform` and
 * `readers` are injectable so tests never touch `/proc`, `vm_stat`, or the host.
 * `sample()` never rejects: every read degrades to a safe fallback.
 */
export function defaultLoadProbe(
  t: LoadThresholds,
  platform: NodeJS.Platform = process.platform,
  readers: Partial<LoadReaders> = {},
): LoadProbe {
  const r: LoadReaders = { ...DEFAULT_READERS, ...readers }
  return {
    async sample(): Promise<LoopLoad> {
      const memAvailableMb = await availableMemMb(platform, r)
      return assessLoad(
        {
          cores: safely(() => r.cpus(), 1),
          loadAvg1: safely(() => r.loadavg()[0] ?? 0, 0),
          memTotalMb: safely(() => Math.floor(r.totalmem() / BYTES_PER_MB), 0),
          memAvailableMb,
        },
        t,
      )
    },
  }
}
