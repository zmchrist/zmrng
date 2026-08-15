import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import type { WorktreeFileContent, WorktreeFileFormat } from './types.js'

export class WorktreeFileError extends Error {}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'])
const MARKDOWN_EXT = new Set(['.md', '.markdown'])
const PDF_EXT = new Set(['.pdf'])

const MAX_READ_BYTES = 25 * 1024 * 1024

function formatFor(relPath: string): WorktreeFileFormat {
  const ext = path.extname(relPath).toLowerCase()
  if (PDF_EXT.has(ext)) return 'pdf'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  return 'code'
}

/**
 * Resolve `relPath` against `worktreePath` and reject anything that escapes
 * the worktree root — `..` segments, absolute paths, or a symlink that
 * resolves outside the root. Never reads/writes outside the task's worktree.
 */
function resolveWithinWorktree(worktreePath: string, relPath: string): string {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]+/).includes('..')) {
    throw new WorktreeFileError('invalid path')
  }
  const root = path.resolve(worktreePath)
  const abs = path.resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new WorktreeFileError('path escapes worktree')
  }

  const realRoot = existsSync(root) ? realpathSync(root) : root
  const checkPath = existsSync(abs) ? abs : path.dirname(abs)
  const realCheck = existsSync(checkPath) ? realpathSync(checkPath) : checkPath
  if (realCheck !== realRoot && !realCheck.startsWith(realRoot + path.sep)) {
    throw new WorktreeFileError('path escapes worktree (symlink)')
  }
  return abs
}

/** Read a worktree file. Text formats (markdown/code) are returned utf8, image/pdf as base64. */
export function readWorktreeFile(worktreePath: string, relPath: string): WorktreeFileContent {
  const abs = resolveWithinWorktree(worktreePath, relPath)
  if (!existsSync(abs)) throw new WorktreeFileError('file not found')
  const format = formatFor(relPath)
  const buf = readFileSync(abs)
  if (buf.byteLength > MAX_READ_BYTES) throw new WorktreeFileError('file too large')
  if (format === 'image' || format === 'pdf') {
    return { path: relPath, format, encoding: 'base64', content: buf.toString('base64') }
  }
  return { path: relPath, format, encoding: 'utf8', content: buf.toString('utf8') }
}

/** Write text content into a worktree file. Rejects image/pdf paths — those are read-only. */
export function writeWorktreeFile(worktreePath: string, relPath: string, content: string): void {
  const format = formatFor(relPath)
  if (format === 'image' || format === 'pdf') {
    throw new WorktreeFileError('cannot write binary files')
  }
  const abs = resolveWithinWorktree(worktreePath, relPath)
  writeFileSync(abs, content, 'utf8')
}
