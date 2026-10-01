import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  assessLoad,
  defaultLoadProbe,
  parseMeminfo,
  parseVmStat,
  type LoadReaders,
  type LoadThresholds,
  type RawLoad,
} from '../src/loopLoad.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const MEMINFO = readFileSync(path.join(FIXTURES, 'proc-meminfo.txt'), 'utf8')
const VM_STAT = readFileSync(path.join(FIXTURES, 'vm_stat.txt'), 'utf8')

const MB = 1024 * 1024
const T: LoadThresholds = { maxLoadPerCore: 1.0, minFreeMemMb: 2048 }
const NOW = new Date('2026-10-01T12:00:00.000Z')

/** Drop every line of `text` that starts with `prefix`. */
function without(text: string, prefix: string): string {
  return text
    .split('\n')
    .filter((l) => !l.startsWith(prefix))
    .join('\n')
}

describe('parseMeminfo (Linux /proc/meminfo)', () => {
  it('reads MemAvailable (kB) from a real-shaped fixture as whole MB, rounded down', () => {
    // 20481000 kB / 1024 = 20000.98 MB → 20000 (never over-report free memory).
    expect(parseMeminfo(MEMINFO)).toBe(20000)
  })

  it('reads MemAvailable, NOT MemFree or MemTotal', () => {
    expect(parseMeminfo('MemTotal: 8192 kB\nMemFree: 1024 kB\nMemAvailable: 4096 kB\n')).toBe(4)
  })

  it('returns null when the MemAvailable line is missing (pre-3.14 kernels, garbage)', () => {
    expect(parseMeminfo(without(MEMINFO, 'MemAvailable:'))).toBeNull()
    expect(parseMeminfo('')).toBeNull()
    expect(parseMeminfo('MemAvailable: lots kB')).toBeNull()
  })
})

describe('parseVmStat (macOS vm_stat)', () => {
  it('sums free + inactive + speculative + purgeable pages x the header page size', () => {
    // (9876 + 498765 + 12345 + 23456) pages x 16384 B = 8506.9 MB → 8506.
    expect(parseVmStat(VM_STAT)).toBe(8506)
  })

  it('does not count active, wired, purged, or compressor pages', () => {
    const text = [
      'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
      'Pages free:                               256.',
      'Pages active:                          999999.',
      'Pages wired down:                      999999.',
      'Pages purged:                          999999.',
      'Pages occupied by compressor:          999999.',
    ].join('\n')
    expect(parseVmStat(text)).toBe(1) // 256 x 4096 B = 1 MB
  })

  it('counts a missing optional line (speculative / purgeable / inactive) as 0', () => {
    const text = without(without(VM_STAT, 'Pages speculative:'), 'Pages purgeable:')
    // (9876 + 498765) x 16384 B = 7947.5 MB → 7947.
    expect(parseVmStat(text)).toBe(7947)
  })

  it('returns null on a malformed or missing page-size header', () => {
    expect(parseVmStat(without(VM_STAT, 'Mach Virtual Memory Statistics'))).toBeNull()
    expect(
      parseVmStat(VM_STAT.replace('page size of 16384 bytes', 'page size of many bytes')),
    ).toBeNull()
    expect(parseVmStat(VM_STAT.replace('page size of 16384 bytes', 'page size of 0 bytes'))).toBeNull()
    expect(parseVmStat('')).toBeNull()
  })

  it('returns null when there is no "Pages free" line (not vm_stat output at all)', () => {
    expect(parseVmStat(without(VM_STAT, 'Pages free:'))).toBeNull()
  })
})

describe('assessLoad', () => {
  const raw = (over: Partial<RawLoad> = {}): RawLoad => ({
    cores: 4,
    loadAvg1: 2.47,
    memTotalMb: 32768,
    memAvailableMb: 8192,
    ...over,
  })

  it('allows a lane under both thresholds, with no reason, echoing thresholds and sample time', () => {
    expect(assessLoad(raw(), T, NOW)).toEqual({
      cores: 4,
      loadAvg1: 2.47,
      loadPerCore: 0.62, // 2.47 / 4 = 0.6175 → 2 dp
      memTotalMb: 32768,
      memAvailableMb: 8192,
      maxLoadPerCore: 1.0,
      minFreeMemMb: 2048,
      allowsNewLane: true,
      reason: null,
      sampledAt: '2026-10-01T12:00:00.000Z',
    })
  })

  it('refuses over the load-per-core threshold and names it with the numbers', () => {
    const load = assessLoad(raw({ loadAvg1: 5.68 }), T, NOW)
    expect(load.loadPerCore).toBe(1.42)
    expect(load.allowsNewLane).toBe(false)
    expect(load.reason).toBe('load 1.42/core > 1.00')
  })

  it('refuses under the available-memory floor and names it with the numbers', () => {
    const load = assessLoad(raw({ memAvailableMb: 1500 }), T, NOW)
    expect(load.allowsNewLane).toBe(false)
    expect(load.reason).toBe('available memory 1500 MB < 2048 MB')
  })

  it('names BOTH tripped thresholds, joined with "; "', () => {
    const load = assessLoad(raw({ loadAvg1: 5.68, memAvailableMb: 1500 }), T, NOW)
    expect(load.allowsNewLane).toBe(false)
    expect(load.reason).toBe('load 1.42/core > 1.00; available memory 1500 MB < 2048 MB')
  })

  it('sitting exactly ON a threshold still allows (strictly over load / strictly under memory)', () => {
    const load = assessLoad(raw({ loadAvg1: 4, memAvailableMb: 2048 }), T, NOW)
    expect(load.loadPerCore).toBe(1)
    expect(load.allowsNewLane).toBe(true)
    expect(load.reason).toBeNull()
  })

  it('treats a [0,0,0] load average (Windows) as CPU-unconstrained; memory still gates', () => {
    const tight: LoadThresholds = { maxLoadPerCore: 0.01, minFreeMemMb: 2048 }
    expect(assessLoad(raw({ loadAvg1: 0 }), tight, NOW)).toMatchObject({
      loadPerCore: 0,
      allowsNewLane: true,
    })
    expect(assessLoad(raw({ loadAvg1: 0, memAvailableMb: 100 }), tight, NOW)).toMatchObject({
      allowsNewLane: false,
      reason: 'available memory 100 MB < 2048 MB',
    })
  })

  it('treats a core count below 1 as 1 (never divides by zero)', () => {
    const load = assessLoad(raw({ cores: 0, loadAvg1: 0.5 }), T, NOW)
    expect(load.cores).toBe(1)
    expect(load.loadPerCore).toBe(0.5)
  })

  it('defaults sampledAt to the current time', () => {
    const before = Date.now()
    const at = Date.parse(assessLoad(raw(), T).sampledAt)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })
})

describe('defaultLoadProbe (injected readers — never touches /proc, vm_stat, or os)', () => {
  interface Calls {
    readFile: string[]
    execFile: [string, string[]][]
  }

  /** Fully-injected readers: 8 cores, load 2.0, 16 GB total, 3 GB "freemem". */
  function readers(over: Partial<LoadReaders> = {}): { r: LoadReaders; calls: Calls } {
    const calls: Calls = { readFile: [], execFile: [] }
    const r: LoadReaders = {
      readFile: async (p) => {
        calls.readFile.push(p)
        return MEMINFO
      },
      execFile: async (cmd, args) => {
        calls.execFile.push([cmd, args])
        return VM_STAT
      },
      cpus: () => 8,
      loadavg: () => [2.0, 1.5, 1.0],
      totalmem: () => 16384 * MB,
      freemem: () => 3072 * MB,
      ...over,
    }
    return { r, calls }
  }

  it('Linux: reads MemAvailable from /proc/meminfo and never runs vm_stat', async () => {
    const { r, calls } = readers()
    const load = await defaultLoadProbe(T, 'linux', r).sample()
    expect(calls.readFile).toEqual(['/proc/meminfo'])
    expect(calls.execFile).toEqual([])
    expect(load).toMatchObject({
      cores: 8,
      loadAvg1: 2.0,
      loadPerCore: 0.25,
      memTotalMb: 16384,
      memAvailableMb: 20000,
      allowsNewLane: true,
    })
  })

  it('macOS: runs `vm_stat` and sums its available pages, never reading /proc', async () => {
    const { r, calls } = readers()
    const load = await defaultLoadProbe(T, 'darwin', r).sample()
    expect(calls.execFile).toEqual([['vm_stat', []]])
    expect(calls.readFile).toEqual([])
    expect(load.memAvailableMb).toBe(8506)
  })

  it('falls back to freemem() when the Linux reader throws', async () => {
    const { r } = readers({
      readFile: async () => {
        throw new Error('ENOENT: /proc/meminfo')
      },
    })
    await expect(defaultLoadProbe(T, 'linux', r).sample()).resolves.toMatchObject({
      memAvailableMb: 3072,
    })
  })

  it('falls back to freemem() when the Linux file does not parse', async () => {
    const { r } = readers({ readFile: async () => 'garbage' })
    expect((await defaultLoadProbe(T, 'linux', r).sample()).memAvailableMb).toBe(3072)
  })

  it('falls back to freemem() when vm_stat fails or prints garbage', async () => {
    const failing = readers({
      execFile: async () => {
        throw new Error('spawn vm_stat ENOENT')
      },
    })
    expect((await defaultLoadProbe(T, 'darwin', failing.r).sample()).memAvailableMb).toBe(3072)
    const garbage = readers({ execFile: async () => 'nope' })
    expect((await defaultLoadProbe(T, 'darwin', garbage.r).sample()).memAvailableMb).toBe(3072)
  })

  it('uses freemem() directly on other platforms, touching neither reader', async () => {
    const { r, calls } = readers()
    const load = await defaultLoadProbe(T, 'win32', r).sample()
    expect(load.memAvailableMb).toBe(3072)
    expect(calls.readFile).toEqual([])
    expect(calls.execFile).toEqual([])
  })

  it('never throws, even when the os readers themselves throw', async () => {
    const boom = (): never => {
      throw new Error('boom')
    }
    const { r } = readers({ cpus: boom, loadavg: boom, totalmem: boom, readFile: boom })
    const load = await defaultLoadProbe(T, 'linux', r).sample()
    expect(load.cores).toBe(1)
    expect(load.loadAvg1).toBe(0)
    expect(load.memTotalMb).toBe(0)
    expect(load.memAvailableMb).toBe(3072)
  })

  it('applies the thresholds it was built with', async () => {
    const { r } = readers()
    const load = await defaultLoadProbe({ maxLoadPerCore: 0.1, minFreeMemMb: 64000 }, 'linux', r).sample()
    expect(load).toMatchObject({ maxLoadPerCore: 0.1, minFreeMemMb: 64000, allowsNewLane: false })
    expect(load.reason).toBe('load 0.25/core > 0.10; available memory 20000 MB < 64000 MB')
  })
})
