import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import {
  mkdirSync,
  readdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import { config } from './config.js'
import type { WorktreeFileNode, WorktreeFileTree } from './types.js'

const exec = promisify(execFile)

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args], {
    maxBuffer: 1024 * 1024 * 16,
  })
  return stdout.trim()
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
 * Hook registrations seeded into `.claude/settings.local.json`, pointing at the
 * copies under `.claude/zmrng-hooks/`. Merged additively with any settings the
 * target worktree already has (never overwrites the target's own entries).
 * H3 will adapt these scripts further; this is the minimal wiring so
 * `security_guard.py` fires immediately.
 */
function zmrngHooksConfig(): Record<string, unknown[]> {
  const hookPath = (name: string): string => `\${CLAUDE_PROJECT_DIR}/.claude/zmrng-hooks/${name}`
  return {
    PreToolUse: [
      {
        matcher: 'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep',
        hooks: [
          {
            type: 'command',
            command: `python3 "${hookPath('security_guard.py')}"`,
            timeout: 5,
            statusMessage: 'Security check...',
          },
        ],
      },
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: `python3 "${hookPath('branch_guard.py')}"`,
            timeout: 8,
            statusMessage: 'Branch guard...',
          },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: `python3 "${hookPath('pr_shape_guard.py')}"`,
            timeout: 5,
            statusMessage: 'PR shape check...',
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: [{ type: 'command', command: `python3 "${hookPath('post_tool_use_lint.py')}"`, timeout: 30 }],
      },
    ],
    Stop: [
      {
        hooks: [{ type: 'command', command: `python3 "${hookPath('stop_validate.py')}"`, timeout: 120 }],
      },
    ],
  }
}

const HOOKS_SKIPPED_NOTE =
  'harness hooks skipped — python3 not found; security_guard/lint/validate inactive for this task'

/** True if `bin` resolves to a runnable interpreter (`<bin> --version` exits 0). */
async function probeInterpreter(bin: string): Promise<boolean> {
  try {
    await exec(bin, ['--version'])
    return true
  } catch {
    return false
  }
}

/** List `<dir>/*` entries (files or dirs), or `[]` if `dir` doesn't exist. */
function listEntries(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort()
}

/** Strip a file extension for use as a `zmrng-<name>` suffix. */
function stem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '')
}

/**
 * Copy zmrng's own `harness/` tree (rules, skills, agents, hooks, CLAUDE.md) into
 * a task worktree under a `zmrng-` namespace, register the hooks, and exclude
 * every seeded path from `git add -A` via `info/exclude` — so a worker can never
 * sweep orchestrator tooling into its own PR. Always copies (never symlinks) and
 * never clobbers anything the target repo already owns. Idempotent: safe to call
 * more than once for the same worktree (e.g. a retried start()).
 *
 * Before touching hooks, probes whether `pythonBin` (default `python3`, or
 * `ZMRNG_PYTHON_BIN` if set) is runnable. If it isn't, hook scripts are not
 * copied and no hook is registered in `settings.local.json` — an inactive
 * `security_guard.py` erroring on every tool call is worse than one honest
 * operator note. Non-hook seeding (rules, skills, agents, CLAUDE.md) still
 * proceeds either way.
 *
 * Returns human-readable notes for the operator log, mirroring
 * `syncLocalAfterMerge`'s convention.
 */
export async function seedHarness(
  worktreePath: string,
  targetRepoPath: string,
  harnessDir: string = path.join(config.repoRoot, 'harness'),
  pythonBin: string = process.env.ZMRNG_PYTHON_BIN ?? 'python3',
): Promise<string[]> {
  const notes: string[] = []
  if (!existsSync(harnessDir)) {
    notes.push(`harness source dir not found at ${harnessDir} — skipped seeding`)
    return notes
  }

  const hooksAvailable = await probeInterpreter(pythonBin)

  const claudeDir = path.join(worktreePath, '.claude')
  const rulesDir = path.join(claudeDir, 'rules')
  const skillsDir = path.join(claudeDir, 'skills')
  const agentsDir = path.join(claudeDir, 'agents')
  const hooksDestDir = path.join(claudeDir, 'zmrng-hooks')
  mkdirSync(rulesDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(agentsDir, { recursive: true })
  mkdirSync(hooksDestDir, { recursive: true })

  // Relative (POSIX, worktree-rooted) paths of every seeded file/dir, for the
  // info/exclude block below.
  const seeded: string[] = []

  for (const name of listEntries(path.join(harnessDir, 'rules'))) {
    const destName = `zmrng-${name}`
    copyFileSync(path.join(harnessDir, 'rules', name), path.join(rulesDir, destName))
    seeded.push(`.claude/rules/${destName}`)
  }

  for (const name of listEntries(path.join(harnessDir, 'skills'))) {
    const destName = `zmrng-${name}`
    cpSync(path.join(harnessDir, 'skills', name), path.join(skillsDir, destName), { recursive: true })
    seeded.push(`.claude/skills/${destName}/`)
  }

  for (const name of listEntries(path.join(harnessDir, 'agents'))) {
    const destName = `zmrng-${stem(name)}.md`
    copyFileSync(path.join(harnessDir, 'agents', name), path.join(agentsDir, destName))
    seeded.push(`.claude/agents/${destName}`)
  }

  // core_piv_loop commands seed unprefixed (unlike rules/skills/agents above):
  // `/core_piv_loop:plan-feature` and `:execute` only slash-resolve on an exact
  // `.claude/commands/core_piv_loop/<name>` path, so a `zmrng-` prefix would break
  // resolution. Never clobber a target repo's own file of the same name.
  const pivCommandsSrc = path.join(harnessDir, 'commands', 'core_piv_loop')
  if (existsSync(pivCommandsSrc)) {
    const pivCommandsDest = path.join(claudeDir, 'commands', 'core_piv_loop')
    mkdirSync(pivCommandsDest, { recursive: true })
    for (const name of listEntries(pivCommandsSrc)) {
      const dest = path.join(pivCommandsDest, name)
      if (!existsSync(dest)) {
        copyFileSync(path.join(pivCommandsSrc, name), dest)
      }
      seeded.push(`.claude/commands/core_piv_loop/${name}`)
    }
  }

  if (hooksAvailable) {
    for (const name of listEntries(path.join(harnessDir, 'hooks'))) {
      const src = path.join(harnessDir, 'hooks', name)
      // Skip stray non-file entries (e.g. a `__pycache__/` dir left behind by
      // running a hook script directly) — this loop only ever seeds flat .py files.
      if (!statSync(src).isFile()) continue
      copyFileSync(src, path.join(hooksDestDir, name))
    }
    seeded.push('.claude/zmrng-hooks/')
  } else {
    notes.push(HOOKS_SKIPPED_NOTE)
  }

  // Root CLAUDE.md: never clobber a target's own — fall back to a rules file.
  const harnessClaudeMd = path.join(harnessDir, 'CLAUDE.md')
  if (existsSync(harnessClaudeMd)) {
    const rootClaudeMd = path.join(worktreePath, 'CLAUDE.md')
    if (existsSync(rootClaudeMd)) {
      copyFileSync(harnessClaudeMd, path.join(rulesDir, 'zmrng-lifecycle.md'))
      seeded.push('.claude/rules/zmrng-lifecycle.md')
    } else {
      copyFileSync(harnessClaudeMd, rootClaudeMd)
      seeded.push('CLAUDE.md')
    }
  }

  // Merge hook registrations into settings.local.json, additive only — never
  // drop or overwrite entries the target worktree already has.
  const settingsPath = path.join(claudeDir, 'settings.local.json')
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      notes.push('settings.local.json was invalid JSON — starting fresh (original left unread)')
      settings = {}
    }
  }
  if (hooksAvailable) {
    const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {}
    for (const [event, entries] of Object.entries(zmrngHooksConfig())) {
      const existing = hooks[event] ?? []
      for (const entry of entries) {
        const dupe = existing.some((e) => JSON.stringify(e) === JSON.stringify(entry))
        if (!dupe) existing.push(entry)
      }
      hooks[event] = existing
    }
    settings.hooks = hooks
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
    seeded.push('.claude/settings.local.json')
  }

  // Notes (`.zmrng/notes/`) are worker-scoped scratch, not part of the seeded
  // harness content, but must ride the same git-add exclusion so a worker can
  // never sweep them into a PR.
  seeded.push('.zmrng/')

  // Exclude every seeded path from `git add -A` in this worktree, idempotently.
  try {
    const gitCommonDir = await git(worktreePath, ['rev-parse', '--git-common-dir'])
    const absGitCommonDir = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(worktreePath, gitCommonDir)
    const infoDir = path.join(absGitCommonDir, 'info')
    mkdirSync(infoDir, { recursive: true })
    const excludePath = path.join(infoDir, 'exclude')
    const marker = '# zmrng seedHarness — orchestrator-owned, never commit'
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    if (!current.includes(marker)) {
      const block = [marker, ...seeded].join('\n')
      writeFileSync(excludePath, `${current}${current.endsWith('\n') || !current ? '' : '\n'}${block}\n`)
      notes.push(`excluded ${seeded.length} zmrng-seeded path(s) from git add in ${excludePath}`)
    } else {
      notes.push('zmrng-seeded paths already excluded from git add — skipped')
    }
  } catch (err) {
    notes.push(`failed to update info/exclude: ${errMsg(err)}`)
  }

  notes.push(`seeded harness into ${worktreePath} (target repo: ${targetRepoPath}) from ${harnessDir}`)
  return notes
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
 * Fast-forward `repoRoot`'s checked-out `defaultBranch` to `origin/<defaultBranch>`.
 * Used by the Settings "reboot" self-update flow to bring zmrng's own checkout
 * up to date before rebuilding + restarting. Throws with a human-readable
 * message (surfaced to the operator) rather than silently degrading, unlike
 * {@link syncLocalAfterMerge} — a reboot the operator explicitly triggered
 * should fail loudly if it can't actually update:
 *   - dirty working tree → abort (never touches uncommitted work)
 *   - not on `defaultBranch` (or detached HEAD) → abort
 *   - diverged from origin (not fast-forwardable) → abort
 */
export async function selfUpdate(repoRoot: string, defaultBranch = 'main'): Promise<void> {
  try {
    await git(repoRoot, ['fetch', 'origin', '--quiet'])
  } catch (err) {
    throw new Error(`git fetch origin failed: ${errMsg(err)}`, { cause: err })
  }

  const statusOutput = await git(repoRoot, ['status', '--porcelain'])
  if (statusOutput.length > 0) {
    const files = statusOutput
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3))
    throw new Error(
      `working tree has uncommitted changes — aborted self-update (${files.join(', ')})`,
    )
  }

  let current: string
  try {
    current = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  } catch {
    throw new Error('repo is in detached HEAD — aborted self-update')
  }
  if (current !== defaultBranch) {
    throw new Error(`checked out on ${current}, not ${defaultBranch} — aborted self-update`)
  }

  try {
    await git(repoRoot, ['merge', '--ff-only', `origin/${defaultBranch}`])
  } catch {
    throw new Error(`local ${defaultBranch} has diverged from origin/${defaultBranch} — not fast-forwardable`)
  }
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
  '.zmrng',
])

/** Guard rails so a pathological tree can never stall the walk or blow the response. */
const MAX_DEPTH = 8
const MAX_ENTRIES = 4000

interface WalkBudget {
  count: number
}

/** Optional tuning for {@link listWorktreeFiles}. */
export interface WalkOptions {
  /**
   * Skip every entry (file or dir) whose name begins with a dot. Off for a task
   * worktree (dotfiles like `.gitignore`/`.github` are useful there); on for the
   * broad Projects-directory scan, where hidden config/cache dirs are noise.
   */
  skipDotEntries?: boolean
}

/** Recursively list `dir`, returning sorted nodes (dirs first, then files). */
function walk(
  absDir: string,
  relDir: string,
  depth: number,
  budget: WalkBudget,
  options: WalkOptions,
): WorktreeFileNode[] {
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
    if (options.skipDotEntries && dirent.name.startsWith('.')) continue
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
        children: walk(path.join(absDir, dirent.name), relPath, depth + 1, budget, options),
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
 * List a directory as a pruned, depth-capped file tree. Never throws:
 * a null/missing directory returns an empty tree with `root: null`. Prunes VCS,
 * dependency, and build dirs; skips symlinks; caps depth and total node count.
 * Used both for a task's worktree and (with `skipDotEntries`) the Projects dir.
 */
export function listWorktreeFiles(
  worktreePath: string | null,
  options: WalkOptions = {},
): WorktreeFileTree {
  if (!worktreePath || !existsSync(worktreePath)) return { root: null, entries: [] }
  const entries = walk(worktreePath, '', 0, { count: 0 }, options)
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
