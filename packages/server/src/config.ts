import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

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
  /** Absolute path to the git repo zmrng drives (v1: Pheme). */
  targetRepo: string
  defaultModel: string
  maxLanes: number
  repoRoot: string
  dbPath: string
  worktreesDir: string
  webDist: string
  /** True if ANTHROPIC_API_KEY was present and stripped so claude uses Max OAuth. */
  apiKeyStripped: boolean
}

function buildConfig(): Config {
  const targetRepo = path.resolve(
    expandHome(process.env.ZMRNG_TARGET_REPO ?? '~/Documents/Projects/pheme'),
  )
  return {
    port: Number(process.env.ZMRNG_PORT ?? 4500),
    targetRepo,
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
