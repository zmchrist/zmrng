import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const exec = promisify(execFile)

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args], {
    maxBuffer: 1024 * 1024 * 16,
  })
  return stdout.trim()
}

/** Turn a task title into a branch-safe slug. */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || 'task'
}

export interface WorktreeHandle {
  branch: string
  worktreePath: string
}

/**
 * Fetch origin, then add a fresh worktree checked out on a new branch cut from
 * origin/main. The branch + worktree are unique per task id.
 */
export async function createWorktree(
  targetRepo: string,
  worktreesDir: string,
  taskId: string,
  title: string,
): Promise<WorktreeHandle> {
  mkdirSync(worktreesDir, { recursive: true })
  const shortId = taskId.slice(0, 8)
  const branch = `feat/zmrng/${slugify(title)}-${shortId}`
  const worktreePath = path.join(worktreesDir, shortId)

  await git(targetRepo, ['fetch', 'origin', '--quiet'])
  await git(targetRepo, [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    'origin/main',
  ])
  return { branch, worktreePath }
}

/** Remove a worktree (force, in case of uncommitted changes) and prune. */
export async function removeWorktree(
  targetRepo: string,
  worktreePath: string,
): Promise<void> {
  try {
    await git(targetRepo, ['worktree', 'remove', '--force', worktreePath])
  } catch {
    // already gone or never created — prune stale entries regardless
  }
  try {
    await git(targetRepo, ['worktree', 'prune'])
  } catch {
    // best effort
  }
}
