import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { RepoTarget } from './types.js'

/** Expand a leading ~ to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * zmrng repo root, resolved relative to this file. Works in dev (src/) and
 * after build (dist/): both are two levels under packages/server.
 *   packages/server/src/config.ts  -> ../../.. = repo root
 *   packages/server/dist/config.js -> ../../.. = repo root
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

/**
 * Writable per-user data dir for the SQLite db, git worktrees, and the repo
 * registry. In dev (no env) this is REPO_ROOT — today's behavior, byte-for-byte.
 * In the bundled desktop app it is `~/Library/Application Support/zmrng`, set by
 * the Tauri shell via ZMRNG_DATA_DIR, because the app bundle is read-only.
 */
const DATA_DIR = process.env.ZMRNG_DATA_DIR ?? REPO_ROOT
/** Repo registry (and an optional .env) live here — REPO_ROOT/config in dev. */
const CONFIG_DIR = path.join(DATA_DIR, 'config')

/**
 * Directory scanned for additional drivable repos. Every git repo directly
 * under it is auto-listed in the repo dropdown (override via ZMRNG_PROJECTS_DIR).
 */
const PROJECTS_DIR = path.resolve(
  expandHome(process.env.ZMRNG_PROJECTS_DIR ?? '~/Documents/Projects'),
)

/** Parse one `.env` file into process.env (existing keys win). */
function loadDotEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

/** Load `.env` from the repo root and (if different) the data dir (dev convenience). */
function loadDotEnv(): void {
  const seen = new Set<string>()
  for (const dir of [REPO_ROOT, DATA_DIR]) {
    const envPath = path.join(dir, '.env')
    if (seen.has(envPath)) continue
    seen.add(envPath)
    loadDotEnvFile(envPath)
  }
}

loadDotEnv()

export interface Config {
  port: number
  /** Absolute path to the default target repo (back-compat / display only). */
  targetRepo: string
  /** All git repos zmrng can drive, loaded from the repo registry. */
  repos: RepoTarget[]
  /** id of the repo a task targets when none is specified. */
  defaultRepoId: string
  /** Non-fatal registry problems (invalid entries skipped) — logged at startup. */
  repoWarnings: string[]
  defaultModel: string
  maxLanes: number
  repoRoot: string
  /** Writable per-user data dir (db, worktrees, config). REPO_ROOT in dev. */
  dataDir: string
  dbPath: string
  worktreesDir: string
  webDist: string
  /** True if ANTHROPIC_API_KEY was present and stripped so claude uses Max OAuth. */
  apiKeyStripped: boolean
}

/** True if `p` exists and is inside a git work tree. */
function isGitRepo(p: string): boolean {
  if (!existsSync(p)) return false
  try {
    execFileSync('git', ['-C', p, 'rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/**
 * True if `p` is the ROOT of its own git work tree (not merely nested inside a
 * parent repo). Used for project scanning so plain folders under a parent git
 * repo aren't mistaken for drivable repos.
 */
function isGitRepoRoot(p: string): boolean {
  if (!existsSync(p)) return false
  try {
    const top = execFileSync('git', ['-C', p, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim()
    return path.resolve(top) === path.resolve(p)
  } catch {
    return false
  }
}

function normalizeEntry(e: Partial<RepoTarget>): RepoTarget | undefined {
  const id = e.id?.trim()
  const rawPath = e.path?.trim()
  if (!id || !rawPath) return undefined
  return {
    id,
    label: e.label?.trim() || id,
    path: path.resolve(expandHome(rawPath)),
    defaultBranch: e.defaultBranch?.trim() || 'main',
  }
}

/** Load repo registry candidates: config/repos.json → ZMRNG_REPOS env → legacy ZMRNG_TARGET_REPO. */
function loadRepoCandidates(): RepoTarget[] {
  // 1. <dataDir>/config/repos.json (gitignored; machine-specific paths)
  const jsonPath = path.join(CONFIG_DIR, 'repos.json')
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as Partial<RepoTarget>[]
      if (Array.isArray(parsed)) {
        const entries = parsed.map(normalizeEntry).filter((e): e is RepoTarget => !!e)
        if (entries.length) return entries
      }
    } catch {
      // malformed JSON — fall through to env/legacy
    }
  }
  // 2. ZMRNG_REPOS env — comma-separated `id:path` pairs
  const envRepos = process.env.ZMRNG_REPOS?.trim()
  if (envRepos) {
    const entries = envRepos
      .split(',')
      .map((pair) => {
        const idx = pair.indexOf(':')
        if (idx === -1) return undefined
        return normalizeEntry({ id: pair.slice(0, idx), path: pair.slice(idx + 1) })
      })
      .filter((e): e is RepoTarget => !!e)
    if (entries.length) return entries
  }
  // 3. legacy single ZMRNG_TARGET_REPO
  return [
    normalizeEntry({
      id: 'default',
      label: 'default',
      path: process.env.ZMRNG_TARGET_REPO ?? '~/Documents/Projects/pheme',
    })!,
  ]
}

/**
 * Auto-discover every git repo directly under PROJECTS_DIR. Folder name is used
 * as both id and label; defaultBranch falls back to `main` (worktree creation
 * degrades to the repo's actual HEAD when `main` is absent). Missing/unreadable
 * directory is non-fatal — returns an empty list.
 */
function scanProjectsDir(): RepoTarget[] {
  let entries
  try {
    entries = readdirSync(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const out: RepoTarget[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const full = path.join(PROJECTS_DIR, e.name)
    if (!isGitRepoRoot(full)) continue
    const norm = normalizeEntry({ id: e.name, label: e.name, path: full })
    if (norm) out.push(norm)
  }
  return out
}

/** Merge repo lists in priority order, deduping by id and by resolved path (first wins). */
function mergeRepos(lists: RepoTarget[][]): RepoTarget[] {
  const byId = new Set<string>()
  const byPath = new Set<string>()
  const out: RepoTarget[] = []
  for (const r of lists.flat()) {
    if (byId.has(r.id) || byPath.has(r.path)) continue
    byId.add(r.id)
    byPath.add(r.path)
    out.push(r)
  }
  return out
}

function buildConfig(): Config {
  // zmrng itself is always drivable and is the default target, so a default-repo
  // task operates in the zmrng checkout rather than some other project.
  const selfEntry = normalizeEntry({ id: 'zmrng', label: 'zmrng', path: REPO_ROOT })!
  // Priority: explicit registry (custom labels/branches) → zmrng → scanned projects.
  const candidates = mergeRepos([loadRepoCandidates(), [selfEntry], scanProjectsDir()])
  const warnings: string[] = []
  const valid = candidates.filter((r) => {
    if (isGitRepo(r.path)) return true
    warnings.push(`repo "${r.id}" skipped — not a git repo at ${r.path}`)
    return false
  })
  // Keep candidates best-effort if validation eliminated everything, so the server still boots.
  const repos = valid.length ? valid : candidates

  // Default to zmrng (the repo at REPO_ROOT) unless the operator pins another via env.
  const envDefault = process.env.ZMRNG_DEFAULT_REPO?.trim()
  const selfRepoId = repos.find((r) => r.path === REPO_ROOT)?.id
  const defaultRepoId =
    envDefault && repos.some((r) => r.id === envDefault)
      ? envDefault
      : (selfRepoId ?? repos[0].id)

  const worktreesDir = path.join(DATA_DIR, 'worktrees')
  // Ensure the writable dirs exist before db/worktree code touches them. In dev
  // these already exist (REPO_ROOT); recursive mkdir is an idempotent no-op.
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(worktreesDir, { recursive: true })

  return {
    port: Number(process.env.ZMRNG_PORT ?? 4500),
    targetRepo: repos.find((r) => r.id === defaultRepoId)?.path ?? repos[0].path,
    repos,
    defaultRepoId,
    repoWarnings: warnings,
    defaultModel: process.env.ZMRNG_MODEL ?? 'opus',
    maxLanes: Number(process.env.ZMRNG_MAX_LANES ?? 2),
    repoRoot: REPO_ROOT,
    dataDir: DATA_DIR,
    dbPath: path.join(DATA_DIR, 'zmrng.db'),
    worktreesDir,
    webDist: process.env.ZMRNG_WEB_DIST ?? path.join(REPO_ROOT, 'packages', 'web', 'dist'),
    apiKeyStripped: Boolean(process.env.ANTHROPIC_API_KEY),
  }
}

export const config: Config = buildConfig()

/** Resolve a repo target by id from the registry. */
export function repoById(id: string): RepoTarget | undefined {
  return config.repos.find((r) => r.id === id)
}
