import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { mkdirSync, readdirSync, existsSync } from 'node:fs'
import type { WorktreeFileNode, WorktreeFileTree } from './types.js'

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

/**
 * After the operator merges a task's PR on GitHub, bring the local checkout back
 * in sync — safely, never touching uncommitted work:
 *   1. fetch origin (best effort)
 *   2. fast-forward the local default branch to origin/<default>
 *      - if it's the checked-out branch: `merge --ff-only`, but ONLY when the
 *        working tree is clean (skip + warn otherwise)
 *      - if it's not checked out: move the ref via a ff-only `fetch` (no tree touched)
 *   3. delete the local feature branch with `-d` (refuses unmerged branches, so a
 *      squash/rebase-merged PR's branch is kept, never force-deleted)
 * Returns human-readable notes (info + warnings) for the operator log. The
 * worktree must already be removed (it holds `branch` checked out).
 */
export async function syncLocalAfterMerge(
  repoPath: string,
  defaultBranch: string,
  branch: string,
): Promise<string[]> {
  const notes: string[] = []

  // 1. fetch origin — prune deleted remote branches too (you deleted it on GitHub).
  let fetched = false
  try {
    await git(repoPath, ['fetch', 'origin', '--prune', '--quiet'])
    fetched = true
  } catch {
    notes.push('fetch origin failed (offline or no remote) — skipped local default-branch update')
  }

  // 2. fast-forward the local default branch to match the freshly merged origin.
  if (fetched && (await refExists(repoPath, `origin/${defaultBranch}`))) {
    let current: string
    try {
      current = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    } catch {
      current = '' // detached HEAD — treat as "default branch not checked out"
    }
    if (current === defaultBranch) {
      const dirty = (await git(repoPath, ['status', '--porcelain'])).length > 0
      if (dirty) {
        notes.push(
          `local ${defaultBranch} has uncommitted changes — skipped fast-forward (your work untouched)`,
        )
      } else {
        try {
          await git(repoPath, ['merge', '--ff-only', `origin/${defaultBranch}`])
          notes.push(`fast-forwarded local ${defaultBranch} → origin/${defaultBranch}`)
        } catch {
          notes.push(`local ${defaultBranch} not fast-forwardable — left untouched`)
        }
      }
    } else {
      // Default branch isn't checked out anywhere — move its ref directly (ff-only).
      try {
        await git(repoPath, ['fetch', 'origin', `${defaultBranch}:${defaultBranch}`, '--quiet'])
        notes.push(`updated local ${defaultBranch} → origin/${defaultBranch}`)
      } catch {
        notes.push(`local ${defaultBranch} not fast-forwardable — left untouched`)
      }
    }
  }

  // 3. delete the local feature branch — only if safely merged.
  if (await refExists(repoPath, branch)) {
    try {
      await git(repoPath, ['branch', '-d', branch])
      notes.push(`deleted local branch ${branch}`)
    } catch {
      notes.push(
        `local branch ${branch} not detected as merged (squash/rebase merge?) — kept; delete manually if intended`,
      )
    }
  }

  return notes
}

/**
 * Directory names that are pruned from the worktree file listing: version
 * control, dependency, and build-output dirs that are heavy and rarely useful
 * for the operator to browse.
 */
const PRUNE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.vite',
  'worktrees',
])

/** Guard rails so a pathological tree can never stall the walk or blow the response. */
const MAX_DEPTH = 8
const MAX_ENTRIES = 4000

interface WalkBudget {
  count: number
}

/** Recursively list `dir`, returning sorted nodes (dirs first, then files). */
function walk(absDir: string, relDir: string, depth: number, budget: WalkBudget): WorktreeFileNode[] {
  if (depth > MAX_DEPTH || budget.count >= MAX_ENTRIES) return []

  let dirents: import('node:fs').Dirent[]
  try {
    dirents = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return [] // unreadable dir — skip rather than throw
  }

  const dirs: WorktreeFileNode[] = []
  const files: WorktreeFileNode[] = []
  for (const dirent of dirents) {
    if (budget.count >= MAX_ENTRIES) break
    const isDir = dirent.isDirectory()
    if (isDir && PRUNE_DIRS.has(dirent.name)) continue
    // Skip symlinks: don't follow (cycle risk) and don't list dangling links.
    if (dirent.isSymbolicLink()) continue

    const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name
    budget.count += 1
    if (isDir) {
      dirs.push({
        name: dirent.name,
        path: relPath,
        type: 'dir',
        children: walk(path.join(absDir, dirent.name), relPath, depth + 1, budget),
      })
    } else if (dirent.isFile()) {
      files.push({ name: dirent.name, path: relPath, type: 'file' })
    }
  }

  const byName = (a: WorktreeFileNode, b: WorktreeFileNode): number =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
  dirs.sort(byName)
  files.sort(byName)
  return [...dirs, ...files]
}

/**
 * List a task's worktree as a pruned, depth-capped file tree. Never throws:
 * a null/missing worktree returns an empty tree with `root: null`. Prunes VCS,
 * dependency, and build dirs; skips symlinks; caps depth and total node count.
 */
export function listWorktreeFiles(worktreePath: string | null): WorktreeFileTree {
  if (!worktreePath || !existsSync(worktreePath)) return { root: null, entries: [] }
  const entries = walk(worktreePath, '', 0, { count: 0 })
  return { root: worktreePath, entries }
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

/**
 * Resolve a repo's GitHub `owner/name` slug from its `origin` remote.
 *
 * Returns `null` for local-only repos (no `origin`, or a non-GitHub remote).
 * Callers must treat `null` as "unknown" and degrade gracefully rather than
 * rejecting — a local-only target repo is a supported configuration.
 */
export async function repoSlug(targetRepo: string): Promise<string | null> {
  let url: string
  try {
    url = await git(targetRepo, ['remote', 'get-url', 'origin'])
  } catch {
    return null
  }
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url)
  return m ? `${m[1]}/${m[2]}` : null
}
