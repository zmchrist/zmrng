import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { createWorktree, listWorktreeFiles, selfUpdate } from '../src/worktree.js'
import type { WorktreeFileNode } from '../src/types.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zmrng-wt-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Flatten a node tree to a set of relative paths for easy assertions. */
function paths(nodes: WorktreeFileNode[]): string[] {
  const out: string[] = []
  const walk = (ns: WorktreeFileNode[]): void => {
    for (const n of ns) {
      out.push(n.path)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

describe('listWorktreeFiles', () => {
  it('returns an empty tree with root null for a null path', () => {
    expect(listWorktreeFiles(null)).toEqual({ root: null, entries: [] })
  })

  it('returns an empty tree for a missing directory', () => {
    expect(listWorktreeFiles(path.join(dir, 'does-not-exist'))).toEqual({
      root: null,
      entries: [],
    })
  })

  it('lists files and nested dirs relative to the worktree root', () => {
    writeFileSync(path.join(dir, 'README.md'), '# hi')
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {}')

    const tree = listWorktreeFiles(dir)
    expect(tree.root).toBe(dir)
    const p = paths(tree.entries)
    expect(p).toContain('README.md')
    expect(p).toContain('src')
    expect(p).toContain('src/index.ts')
  })

  it('prunes .git, node_modules, dist, and .zmrng', () => {
    for (const heavy of ['.git', 'node_modules', 'dist', '.zmrng']) {
      mkdirSync(path.join(dir, heavy))
      writeFileSync(path.join(dir, heavy, 'junk'), 'x')
    }
    writeFileSync(path.join(dir, 'keep.txt'), 'ok')

    const p = paths(listWorktreeFiles(dir).entries)
    expect(p).toContain('keep.txt')
    expect(p).not.toContain('.git')
    expect(p).not.toContain('node_modules')
    expect(p).not.toContain('dist')
    expect(p).not.toContain('.zmrng')
  })

  it('sorts dirs before files, each alphabetically', () => {
    writeFileSync(path.join(dir, 'b.txt'), '')
    writeFileSync(path.join(dir, 'a.txt'), '')
    mkdirSync(path.join(dir, 'zeta'))
    mkdirSync(path.join(dir, 'alpha'))

    const names = listWorktreeFiles(dir).entries.map((n) => n.name)
    expect(names).toEqual(['alpha', 'zeta', 'a.txt', 'b.txt'])
  })

  it('skips symlinks (no cycle-following)', () => {
    mkdirSync(path.join(dir, 'real'))
    writeFileSync(path.join(dir, 'real', 'f.txt'), '')
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'))

    const p = paths(listWorktreeFiles(dir).entries)
    expect(p).toContain('real')
    expect(p).not.toContain('link')
  })

  it('keeps dotfiles by default (task worktree) but drops them with skipDotEntries (Projects scan)', () => {
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules')
    mkdirSync(path.join(dir, '.github'))
    writeFileSync(path.join(dir, '.github', 'ci.yml'), '')
    writeFileSync(path.join(dir, 'keep.txt'), 'ok')

    // Default (worktree) behavior: dotfiles are useful and kept.
    const kept = paths(listWorktreeFiles(dir).entries)
    expect(kept).toContain('.gitignore')
    expect(kept).toContain('.github')

    // Projects scan: hidden entries are noise and dropped, real files stay.
    const scanned = paths(listWorktreeFiles(dir, { skipDotEntries: true }).entries)
    expect(scanned).toContain('keep.txt')
    expect(scanned).not.toContain('.gitignore')
    expect(scanned).not.toContain('.github')
  })
})

/** Runs a git command for real against a temp repo — no network, no mocking. */
function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

// Uses a non-`main`/`master` branch name for these temp repos: the operator's
// global pre-commit hook blocks direct commits on `main`/`master` on ANY repo
// on this machine (a real safety net, not something to bypass), and every
// test here commits directly. `selfUpdate`'s `defaultBranch` param is exactly
// what makes that side-steppable without touching the hook.
const DEFAULT_BRANCH = 'trunk'

function initRepo(): string {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-selfupdate-')))
  git(repo, ['init', '-q', '-b', DEFAULT_BRANCH])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'zmrng test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(repo, 'README.md'), '# temp repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

/** Clones `origin` into a fresh temp dir with a tracked `origin` remote. */
function cloneRepo(origin: string): string {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-selfupdate-clone-')))
  git(repo, ['clone', '-q', origin, repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'zmrng test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  return repo
}

describe('selfUpdate', () => {
  let origin: string
  let local: string

  beforeEach(() => {
    origin = initRepo()
    local = cloneRepo(origin)
  })
  afterEach(() => {
    rmSync(origin, { recursive: true, force: true })
    rmSync(local, { recursive: true, force: true })
  })

  it('fast-forwards local main to a new commit on origin/main', async () => {
    writeFileSync(path.join(origin, 'NEW.md'), 'fresh content\n')
    git(origin, ['add', '-A'])
    git(origin, ['commit', '-q', '-m', 'new commit on origin'])

    await selfUpdate(local, DEFAULT_BRANCH)

    const head = execFileSync('git', ['-C', local, 'rev-parse', 'HEAD']).toString().trim()
    const originHead = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD']).toString().trim()
    expect(head).toBe(originHead)
  })

  it('is a no-op when already up to date with origin/main', async () => {
    const before = execFileSync('git', ['-C', local, 'rev-parse', 'HEAD']).toString().trim()
    await selfUpdate(local, DEFAULT_BRANCH)
    const after = execFileSync('git', ['-C', local, 'rev-parse', 'HEAD']).toString().trim()
    expect(after).toBe(before)
  })

  it('aborts with an error on a dirty working tree, never touching the change', async () => {
    writeFileSync(path.join(origin, 'NEW.md'), 'fresh content\n')
    git(origin, ['add', '-A'])
    git(origin, ['commit', '-q', '-m', 'new commit on origin'])
    writeFileSync(path.join(local, 'README.md'), 'local edit, uncommitted\n')

    await expect(selfUpdate(local, DEFAULT_BRANCH)).rejects.toThrow(/uncommitted changes/)

    const local_readme = execFileSync('git', ['-C', local, 'status', '--porcelain']).toString()
    expect(local_readme).toContain('README.md')
  })

  it('aborts with an error when local history has diverged (not fast-forwardable)', async () => {
    writeFileSync(path.join(origin, 'NEW.md'), 'fresh content\n')
    git(origin, ['add', '-A'])
    git(origin, ['commit', '-q', '-m', 'new commit on origin'])

    writeFileSync(path.join(local, 'LOCAL.md'), 'local-only commit\n')
    git(local, ['add', '-A'])
    git(local, ['commit', '-q', '-m', 'local-only commit'])

    await expect(selfUpdate(local, DEFAULT_BRANCH)).rejects.toThrow(/diverged/)
  })

  it('aborts with an error when not on the default branch', async () => {
    git(local, ['checkout', '-q', '-b', 'other-branch'])
    await expect(selfUpdate(local, DEFAULT_BRANCH)).rejects.toThrow(/checked out on other-branch/)
  })
})

describe('createWorktree', () => {
  let repo: string

  beforeEach(() => {
    repo = initRepo()
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  const wtDir = (): string => path.join(repo, 'worktrees')

  it('creates a fresh branch + worktree from the default branch', async () => {
    const wt = await createWorktree(repo, DEFAULT_BRANCH, wtDir(), 'task-1234abcd', 'Add mobile design')
    expect(wt.branch).toBe('feat/zmrng/add-mobile-design-task-123')
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', wt.branch]).toString()
    expect(branches).toContain(wt.branch)
    const list = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain']).toString()
    expect(list).toContain(realpathSync(wt.worktreePath))
  })

  it('reuses an already-registered worktree at the same path (restart)', async () => {
    const first = await createWorktree(repo, DEFAULT_BRANCH, wtDir(), 'task-1234abcd', 'Add mobile design')
    // A commit made in the prior session must survive the restart reuse.
    writeFileSync(path.join(first.worktreePath, 'work.txt'), 'wip\n')
    git(first.worktreePath, ['add', '-A'])
    git(first.worktreePath, ['commit', '-q', '-m', 'wip'])

    const second = await createWorktree(repo, DEFAULT_BRANCH, wtDir(), 'task-1234abcd', 'Add mobile design')
    expect(second.worktreePath).toBe(first.worktreePath)
    expect(second.branch).toBe(first.branch)
    const log = execFileSync('git', ['-C', first.worktreePath, 'log', '--oneline']).toString()
    expect(log).toContain('wip')
  })

  it('reattaches a pre-existing branch whose worktree was removed (retry/restart)', async () => {
    const first = await createWorktree(repo, DEFAULT_BRANCH, wtDir(), 'task-1234abcd', 'Add mobile design')
    // Simulate a prior attempt that made a commit on the branch, then lost its
    // worktree dir (leaving the branch behind — the reported failure mode).
    writeFileSync(path.join(first.worktreePath, 'work.txt'), 'wip\n')
    git(first.worktreePath, ['add', '-A'])
    git(first.worktreePath, ['commit', '-q', '-m', 'wip on branch'])
    git(repo, ['worktree', 'remove', '--force', first.worktreePath])

    // Must NOT throw "a branch named ... already exists" — reattaches instead.
    const second = await createWorktree(repo, DEFAULT_BRANCH, wtDir(), 'task-1234abcd', 'Add mobile design')
    expect(second.branch).toBe(first.branch)
    const log = execFileSync('git', ['-C', second.worktreePath, 'log', '--oneline']).toString()
    expect(log).toContain('wip on branch')
  })
})
