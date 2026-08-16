import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { listWorktreeFiles } from '../src/worktree.js'
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
