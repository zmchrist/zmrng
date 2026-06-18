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

/** True if `ref` resolves to a commit in `repo`. */
async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the base ref to cut a task branch from, preferring the remote default
 * branch but degrading gracefully for local-only repos (no origin):
 *   origin/<defaultBranch> → local <defaultBranch> → HEAD
 */
async function resolveBase(repo: string, defaultBranch: string): Promise<string> {
  if (await refExists(repo, `origin/${defaultBranch}`)) return `origin/${defaultBranch}`
  if (await refExists(repo, defaultBranch)) return defaultBranch
  return 'HEAD'
}

/**
 * Fetch origin (best effort), then add a fresh worktree checked out on a new
 * branch cut from the target repo's default branch. The branch + worktree are
 * unique per task id; worktrees live under zmrng's own worktrees dir.
 */
export async function createWorktree(
  repoPath: string,
  defaultBranch: string,
  worktreesDir: string,
  taskId: string,
  title: string,
): Promise<WorktreeHandle> {
  mkdirSync(worktreesDir, { recursive: true })
  const shortId = taskId.slice(0, 8)
  const branch = `feat/zmrng/${slugify(title)}-${shortId}`
  const worktreePath = path.join(worktreesDir, shortId)

  // Best effort — local-only repos have no origin to fetch.
  try {
    await git(repoPath, ['fetch', 'origin', '--quiet'])
  } catch {
    // no remote / offline — fall back to local refs below
  }
  const base = await resolveBase(repoPath, defaultBranch)
  await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, base])
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
