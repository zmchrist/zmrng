import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
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

/** Load a .env file at the repo root into process.env if present (dev convenience). */
function loadDotEnv(): void {
  const envPath = path.join(REPO_ROOT, '.env')
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
  // 1. config/repos.json (gitignored; machine-specific paths)
  const jsonPath = path.join(REPO_ROOT, 'config', 'repos.json')
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

function buildConfig(): Config {
  const candidates = loadRepoCandidates()
  const warnings: string[] = []
  const valid = candidates.filter((r) => {
    if (isGitRepo(r.path)) return true
    warnings.push(`repo "${r.id}" skipped — not a git repo at ${r.path}`)
    return false
  })
  // Keep candidates best-effort if validation eliminated everything, so the server still boots.
  const repos = valid.length ? valid : candidates

  const envDefault = process.env.ZMRNG_DEFAULT_REPO?.trim()
  const defaultRepoId =
    envDefault && repos.some((r) => r.id === envDefault) ? envDefault : repos[0].id

  return {
    port: Number(process.env.ZMRNG_PORT ?? 4500),
    targetRepo: repos.find((r) => r.id === defaultRepoId)?.path ?? repos[0].path,
    repos,
    defaultRepoId,
    repoWarnings: warnings,
    defaultModel: process.env.ZMRNG_MODEL ?? 'opus',
    maxLanes: Number(process.env.ZMRNG_MAX_LANES ?? 2),
    repoRoot: REPO_ROOT,
    dbPath: path.join(REPO_ROOT, 'zmrng.db'),
    worktreesDir: path.join(REPO_ROOT, 'worktrees'),
    webDist: path.join(REPO_ROOT, 'packages', 'web', 'dist'),
    apiKeyStripped: Boolean(process.env.ANTHROPIC_API_KEY),
  }
}

export const config: Config = buildConfig()

/** Resolve a repo target by id from the registry. */
export function repoById(id: string): RepoTarget | undefined {
  return config.repos.find((r) => r.id === id)
}
