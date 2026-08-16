import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { readWorktreeFile, writeWorktreeFile, listNotes, WorktreeFileError } from '../src/files.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zmrng-files-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readWorktreeFile', () => {
  it('reads a markdown file as utf8', () => {
    writeFileSync(path.join(dir, 'README.md'), '# hi')
    expect(readWorktreeFile(dir, 'README.md')).toEqual({
      path: 'README.md',
      format: 'markdown',
      encoding: 'utf8',
      content: '# hi',
    })
  })

  it('reads a code file as utf8 with format "code"', () => {
    writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1\n')
    const result = readWorktreeFile(dir, 'index.ts')
    expect(result.format).toBe('code')
    expect(result.encoding).toBe('utf8')
    expect(result.content).toBe('export const x = 1\n')
  })

  it('reads an image as base64', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(path.join(dir, 'pic.png'), bytes)
    const result = readWorktreeFile(dir, 'pic.png')
    expect(result.format).toBe('image')
    expect(result.encoding).toBe('base64')
    expect(Buffer.from(result.content, 'base64')).toEqual(bytes)
  })

  it('reads a nested file by relative path', () => {
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src', 'a.txt'), 'nested')
    expect(readWorktreeFile(dir, 'src/a.txt').content).toBe('nested')
  })

  it('throws for a missing file', () => {
    expect(() => readWorktreeFile(dir, 'missing.txt')).toThrow(WorktreeFileError)
  })

  it('rejects a path that escapes the worktree via ..', () => {
    const outside = path.join(path.dirname(dir), 'secret.txt')
    writeFileSync(outside, 'top secret')
    expect(() => readWorktreeFile(dir, '../secret.txt')).toThrow(WorktreeFileError)
  })

  it('rejects an absolute path', () => {
    writeFileSync(path.join(dir, 'a.txt'), 'ok')
    expect(() => readWorktreeFile(dir, path.join(dir, 'a.txt'))).toThrow(WorktreeFileError)
  })

  it('rejects a symlink that escapes the worktree', () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'zmrng-outside-'))
    writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret')
    symlinkSync(outsideDir, path.join(dir, 'escape'))
    expect(() => readWorktreeFile(dir, 'escape/secret.txt')).toThrow(WorktreeFileError)
    rmSync(outsideDir, { recursive: true, force: true })
  })
})

describe('writeWorktreeFile', () => {
  it('writes text content, visible on disk', () => {
    writeFileSync(path.join(dir, 'notes.md'), 'old')
    writeWorktreeFile(dir, 'notes.md', 'new content')
    expect(readFileSync(path.join(dir, 'notes.md'), 'utf8')).toBe('new content')
  })

  it('creates a new file that did not exist before', () => {
    writeWorktreeFile(dir, 'fresh.txt', 'hello')
    expect(readFileSync(path.join(dir, 'fresh.txt'), 'utf8')).toBe('hello')
  })

  it('rejects writing to an image path', () => {
    expect(() => writeWorktreeFile(dir, 'pic.png', 'nope')).toThrow(WorktreeFileError)
  })

  it('rejects writing to a pdf path', () => {
    expect(() => writeWorktreeFile(dir, 'doc.pdf', 'nope')).toThrow(WorktreeFileError)
  })

  it('rejects a path that escapes the worktree', () => {
    expect(() => writeWorktreeFile(dir, '../escape.txt', 'nope')).toThrow(WorktreeFileError)
  })

  it('creates missing parent dirs for a nested notes path', () => {
    const realDir = realpathSync(dir)
    const abs = path.join(realDir, '.zmrng', 'notes', 'new.md')
    expect(existsSync(path.dirname(abs))).toBe(false)
    writeWorktreeFile(realDir, '.zmrng/notes/new.md', 'hello note')
    expect(readFileSync(abs, 'utf8')).toBe('hello note')
  })
})

describe('listNotes', () => {
  it('returns [] when .zmrng/notes is absent', () => {
    expect(listNotes(dir)).toEqual([])
  })

  it('returns sorted .md basenames, ignoring non-.md files', () => {
    const notesDir = path.join(dir, '.zmrng', 'notes')
    mkdirSync(notesDir, { recursive: true })
    writeFileSync(path.join(notesDir, 'b.md'), 'b')
    writeFileSync(path.join(notesDir, 'a.md'), 'a')
    writeFileSync(path.join(notesDir, 'ignore.txt'), 'nope')
    expect(listNotes(dir)).toEqual(['a.md', 'b.md'])
  })
})
