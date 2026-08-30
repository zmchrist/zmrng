import { describe, it, expect } from 'vitest'
import { liveTaskCount, shouldBlockUpdate, updateAvailable } from '../src/updateGate'
import type { Task, TaskStatus } from '../src/types'

/** Minimal Task factory — only `status` matters to the update gate. */
function task(id: string, status: TaskStatus): Task {
  return {
    id,
    status,
    title: id,
    body: '',
    repoId: 'zmrng',
    branch: 'main',
    model: 'opus',
    effort: 'high',
    style: 'caveman-full',
    flow: 'direct',
    queued: false,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  } as unknown as Task
}

const LIVE: TaskStatus[] = ['planning', 'executing', 'validating']
const IDLE: TaskStatus[] = ['clarify', 'backlog', 'review', 'done']

describe('liveTaskCount', () => {
  it('is 0 for an empty array and an empty record', () => {
    expect(liveTaskCount([])).toBe(0)
    expect(liveTaskCount({})).toBe(0)
  })

  it('is 0 when no task is in a live status', () => {
    const tasks = IDLE.map((s, i) => task(`t${i}`, s))
    expect(liveTaskCount(tasks)).toBe(0)
  })

  it.each(LIVE)('counts a single %s task as live', (status) => {
    expect(liveTaskCount([task('a', status)])).toBe(1)
  })

  it('counts only the live tasks in a mixed set', () => {
    const tasks = [
      task('a', 'planning'),
      task('b', 'done'),
      task('c', 'executing'),
      task('d', 'clarify'),
      task('e', 'validating'),
      task('f', 'backlog'),
    ]
    expect(liveTaskCount(tasks)).toBe(3)
  })

  it('accepts a Record<string, Task> as well as an array', () => {
    const rec: Record<string, Task> = {
      a: task('a', 'executing'),
      b: task('b', 'review'),
    }
    expect(liveTaskCount(rec)).toBe(1)
  })
})

describe('shouldBlockUpdate', () => {
  it('is false when nothing is live', () => {
    expect(shouldBlockUpdate([])).toBe(false)
    expect(shouldBlockUpdate(IDLE.map((s, i) => task(`t${i}`, s)))).toBe(false)
  })

  it.each(LIVE)('is true when a %s task is live', (status) => {
    expect(shouldBlockUpdate([task('a', status)])).toBe(true)
  })

  it('is true for a mixed set containing a live task', () => {
    expect(shouldBlockUpdate([task('a', 'done'), task('b', 'validating')])).toBe(true)
  })
})

describe('updateAvailable', () => {
  it('is false when either sha is empty or undefined', () => {
    expect(updateAvailable('', 'abc')).toBe(false)
    expect(updateAvailable('abc', '')).toBe(false)
    expect(updateAvailable(undefined, 'abc')).toBe(false)
    expect(updateAvailable('abc', undefined)).toBe(false)
    expect(updateAvailable('', '')).toBe(false)
  })

  it('is false when the shas are identical', () => {
    expect(updateAvailable('deadbeef', 'deadbeef')).toBe(false)
  })

  it('is true when both shas are known and differ', () => {
    expect(updateAvailable('deadbeef', 'cafef00d')).toBe(true)
  })
})
