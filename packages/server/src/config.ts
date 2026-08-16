import os from 'node:os'
import path from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { AgentTarget, RepoTarget } from './types.js'

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

/** First directory in `candidates` that exists, else the last candidate. */
function firstExistingDir(candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(expandHome(c))) return c
  }
  return candidates[candidates.length - 1]
}

/**
 * Directory scanned for additional drivable repos. Every git repo directly
 * under it is auto-listed in the repo dropdown. Override via ZMRNG_PROJECTS_DIR;
 * otherwise resolve to the first of `~/Projects` → `~/Developer/Projects` →
 * `~/Documents/Projects` that exists, so existing installs keep working.
 */
const PROJECTS_DIR = path.resolve(
  expandHome(
    process.env.ZMRNG_PROJECTS_DIR ??
      firstExistingDir(['~/Projects', '~/Developer/Projects', '~/Documents/Projects']),
  ),
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
  /** Optional external chat agents (U4). Empty when none are configured — the chat panel then hides. */
  agents: AgentTarget[]
  defaultModel: string
  maxLanes: number
  repoRoot: string
  /** Writable per-user data dir (db, worktrees, config). REPO_ROOT in dev. */
  dataDir: string
  dbPath: string
  webDist: string
  /**
   * `oauth` (default): ANTHROPIC_API_KEY is stripped from worker child envs so
   * `claude` authenticates with the operator's Max OAuth login.
   * `apikey`: the key is preserved, letting a stranger with no Max login run
   * workers against the metered API instead.
   */
  authMode: AuthMode
  /** Root dir for the workspace terminal's PTY (== PROJECTS_DIR). */
  projectsDir: string
  /** Login shell for the workspace terminal (SHELL env, else a sane default). */
  shell: string
}

export type AuthMode = 'oauth' | 'apikey'

/**
 * Parse `ZMRNG_AUTH_MODE` into an `AuthMode` — pure and unit-testable, mirroring
 * `resolveRegistry`'s testability pattern. Any value other than `apikey`
 * (case-insensitive) resolves to the safe default, `oauth`.
 */
export function resolveAuthMode(env: { ZMRNG_AUTH_MODE?: string }): AuthMode {
  return env.ZMRNG_AUTH_MODE?.trim().toLowerCase() === 'apikey' ? 'apikey' : 'oauth'
}

/**
 * Normalise a raw agent entry into an `AgentTarget`, or `undefined` when it is
 * missing a non-empty id/label/url. `headers` is kept only when it is a plain
 * object of string values.
 */
function normalizeAgent(e: Partial<AgentTarget>): AgentTarget | undefined {
  const id = e.id?.trim()
  const label = e.label?.trim()
  const url = e.url?.trim()
  if (!id || !label || !url) return undefined
  const agent: AgentTarget = { id, label, url }
  if (e.headers && typeof e.headers === 'object') {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(e.headers)) {
      if (typeof v === 'string') headers[k] = v
    }
    if (Object.keys(headers).length) agent.headers = headers
  }
  return agent
}

/**
 * Resolve the optional chat-agent registry — pure and unit-testable, mirroring
 * `resolveRegistry`. Precedence: `<configDir>/agents.json` wins; else the
 * `ZMRNG_AGENTS` env; else `[]` (chat panel hidden). Malformed entries are
 * skipped so one bad entry never sinks the rest.
 *
 * `ZMRNG_AGENTS` accepts either a JSON array of `{id,label,url,headers?}`, or a
 * comma-separated list of `id:label:url` triples (the url keeps everything after
 * the second colon, so `https://…` is preserved). Env entries can't carry headers.
 */
export function resolveAgents(opts: {
  configDir: string
  env: { ZMRNG_AGENTS?: string }
}): AgentTarget[] {
  // 1. <configDir>/agents.json (gitignored; may hold secret headers)
  const jsonPath = path.join(opts.configDir, 'agents.json')
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as Partial<AgentTarget>[]
      if (Array.isArray(parsed)) {
        const entries = parsed.map(normalizeAgent).filter((a): a is AgentTarget => !!a)
        if (entries.length) return entries
      }
    } catch {
      // malformed JSON — fall through to env
    }
  }
  // 2. ZMRNG_AGENTS env — JSON array or `id:label:url` triples
  const raw = opts.env.ZMRNG_AGENTS?.trim()
  if (raw) {
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw) as Partial<AgentTarget>[]
        if (Array.isArray(parsed)) {
          const entries = parsed.map(normalizeAgent).filter((a): a is AgentTarget => !!a)
          if (entries.length) return entries
        }
      } catch {
        // fall through to triple parsing
      }
    }
    const entries = raw
      .split(',')
      .map((triple) => {
        const first = triple.indexOf(':')
        if (first === -1) return undefined
        const second = triple.indexOf(':', first + 1)
        if (second === -1) return undefined
        return normalizeAgent({
          id: triple.slice(0, first),
          label: triple.slice(first + 1, second),
          url: triple.slice(second + 1),
        })
      })
      .filter((a): a is AgentTarget => !!a)
    if (entries.length) return entries
  }
  return []
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

/**
 * Seed the writable data-dir registry from the copy bundled with the app. The
 * desktop bundle ships the curated `config/repos.json` next to the server (see
 * bundle-sidecar.mjs → sidecar/config/repos.json); the app's data dir starts
 * empty, so without this the bundled app falls back to legacy/auto-scan and the
 * curated repos/labels never appear in the dropdown. Best-effort and
 * a no-op in dev (DATA_DIR === REPO_ROOT, so source and dest are the same file).
 */
function seedRegistry(): void {
  const dest = path.join(CONFIG_DIR, 'repos.json')
  if (existsSync(dest)) return
  // The server bundle lives at <resources>/sidecar/server.mjs, so the seeded
  // registry sits at <resources>/sidecar/config/repos.json (next to this module).
  const seed = path.join(import.meta.dirname, 'config', 'repos.json')
  if (path.resolve(seed) === path.resolve(dest) || !existsSync(seed)) return
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    copyFileSync(seed, dest)
  } catch {
    // best effort — fall through to env/legacy/auto-scan registry
  }
}

/** Registry-relevant environment inputs, isolated so `resolveRegistry` is testable. */
export interface RegistryEnv {
  ZMRNG_REPOS?: string
  ZMRNG_TARGET_REPO?: string
  ZMRNG_DEFAULT_REPO?: string
}

/**
 * Load repo registry candidates in priority order:
 * `<configDir>/repos.json` → `ZMRNG_REPOS` env → legacy `ZMRNG_TARGET_REPO`.
 * The first source that yields any entries wins.
 */
function loadRepoCandidates(configDir: string, env: RegistryEnv): RepoTarget[] {
  // 1. <configDir>/repos.json (gitignored; machine-specific paths)
  const jsonPath = path.join(configDir, 'repos.json')
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
  const envRepos = env.ZMRNG_REPOS?.trim()
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
  // 3. legacy single ZMRNG_TARGET_REPO — emit an entry only when it is set.
  //    When unset there is no hardcoded fallback repo; the zmrng self entry
  //    plus the PROJECTS_DIR auto-scan supply a usable default registry.
  const legacy = env.ZMRNG_TARGET_REPO?.trim()
  if (legacy) {
    const entry = normalizeEntry({ id: 'default', label: 'default', path: legacy })
    if (entry) return [entry]
  }
  return []
}

/**
 * Auto-discover every git repo directly under PROJECTS_DIR. Folder name is used
 * as both id and label; defaultBranch falls back to `main` (worktree creation
 * degrades to the repo's actual HEAD when `main` is absent). Missing/unreadable
 * directory is non-fatal — returns an empty list.
 */
function scanProjectsDir(projectsDir: string): RepoTarget[] {
  let entries
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: RepoTarget[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const full = path.join(projectsDir, e.name)
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

/**
 * Resolve the real zmrng checkout to seed as a self-drivable repo target.
 *
 * REPO_ROOT is `../../..` from this module — the repo root in dev, but it
 * resolves *inside* the read-only `.app` bundle in the packaged desktop app
 * (the sidecar lives at `<bundle>/Contents/Resources/sidecar/`). Driving a repo
 * inside the bundle is never valid, so derive the actual checkout from git:
 *  - dev: REPO_ROOT is itself a repo root → use it.
 *  - bundle nested in a dev checkout: walk up to the git toplevel (the real repo).
 *  - installed app (no surrounding checkout): no self entry — the operator drives
 *    repos from the seeded registry instead.
 */
function resolveSelfRepo(): RepoTarget | undefined {
  if (isGitRepoRoot(REPO_ROOT)) {
    return normalizeEntry({ id: 'zmrng', label: 'zmrng', path: REPO_ROOT })
  }
  try {
    const top = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim()
    if (top && isGitRepoRoot(top) && !top.includes('.app/')) {
      return normalizeEntry({ id: 'zmrng', label: 'zmrng', path: top })
    }
  } catch {
    // REPO_ROOT is not inside a git work tree — packaged app with no checkout.
  }
  return undefined
}

/** Raised when no drivable repo can be resolved AND no usable fallback root exists. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryError'
  }
}

/** The resolved registry portion of the config, isolated for unit testing. */
export interface ResolvedRegistry {
  repos: RepoTarget[]
  defaultRepoId: string
  targetRepo: string
  warnings: string[]
}

/**
 * Resolve the repo registry from its inputs — pure enough to unit-test without
 * the module-level singletons. Precedence: explicit registry
 * (`repos.json` → env → legacy) → the zmrng self entry → the projects auto-scan.
 *
 * ISSUE #16 guard: on `main` the legacy branch always emitted a hardcoded
 * `default` entry, so `repos` was never empty. That fallback is gone (Phase 1),
 * making the all-empty case reachable (packaged app / empty data dir / no
 * projects dir / no seeded registry). Rather than dereferencing `repos[0]` and
 * throwing a `TypeError` at boot, synthesize a minimal zmrng entry from
 * `fallbackRoot`; only when even that is unusable do we raise a typed
 * `RegistryError` the caller can log via Pino.
 */
export function resolveRegistry(opts: {
  configDir: string
  projectsDir: string
  selfRepo?: RepoTarget
  fallbackRoot: string
  env?: RegistryEnv
}): ResolvedRegistry {
  const env = opts.env ?? (process.env as RegistryEnv)
  const candidates = mergeRepos([
    loadRepoCandidates(opts.configDir, env),
    opts.selfRepo ? [opts.selfRepo] : [],
    scanProjectsDir(opts.projectsDir),
  ])
  const warnings: string[] = []
  const valid = candidates.filter((r) => {
    if (isGitRepo(r.path)) return true
    warnings.push(`repo "${r.id}" skipped — not a git repo at ${r.path}`)
    return false
  })
  // Keep candidates best-effort if validation eliminated everything, so the server still boots.
  let repos = valid.length ? valid : candidates

  // ISSUE #16: an empty registry is now reachable. Synthesize a usable default
  // from the repo root instead of throwing on `repos[0]`.
  if (repos.length === 0) {
    const fallback = normalizeEntry({ id: 'zmrng', label: 'zmrng', path: opts.fallbackRoot })
    if (fallback) {
      repos = [fallback]
      warnings.push(
        `repo registry empty — synthesized a default "zmrng" entry from ${fallback.path}`,
      )
    }
  }
  if (repos.length === 0) {
    throw new RegistryError(
      'no drivable repo could be resolved and no usable fallback root was provided',
    )
  }

  // Default to the zmrng entry unless the operator pins another via env.
  const envDefault = env.ZMRNG_DEFAULT_REPO?.trim()
  const defaultRepoId =
    envDefault && repos.some((r) => r.id === envDefault)
      ? envDefault
      : (repos.find((r) => r.id === 'zmrng')?.id ?? repos[0].id)
  const targetRepo = repos.find((r) => r.id === defaultRepoId)?.path ?? repos[0].path
  return { repos, defaultRepoId, targetRepo, warnings }
}

function buildConfig(): Config {
  // Seed the curated registry into the (initially empty) data dir before loading.
  seedRegistry()
  // zmrng itself is drivable and is the default target where a real checkout
  // exists; resolveSelfRepo() returns undefined for a packaged app inside a
  // read-only bundle (REPO_ROOT would otherwise point into the .app).
  const selfRepo = resolveSelfRepo()
  const { repos, defaultRepoId, targetRepo, warnings } = resolveRegistry({
    configDir: CONFIG_DIR,
    projectsDir: PROJECTS_DIR,
    selfRepo,
    fallbackRoot: REPO_ROOT,
  })

  // Ensure the writable data dir exists before db code touches it. In dev
  // this already exists (REPO_ROOT); recursive mkdir is an idempotent no-op.
  mkdirSync(DATA_DIR, { recursive: true })

  return {
    port: Number(process.env.ZMRNG_PORT ?? 4500),
    targetRepo,
    repos,
    defaultRepoId,
    repoWarnings: warnings,
    agents: resolveAgents({ configDir: CONFIG_DIR, env: process.env }),
    defaultModel: process.env.ZMRNG_MODEL ?? 'opus',
    maxLanes: Number(process.env.ZMRNG_MAX_LANES ?? 2),
    repoRoot: REPO_ROOT,
    dataDir: DATA_DIR,
    dbPath: path.join(DATA_DIR, 'zmrng.db'),
    webDist: process.env.ZMRNG_WEB_DIST ?? path.join(REPO_ROOT, 'packages', 'web', 'dist'),
    authMode: resolveAuthMode(process.env),
    projectsDir: PROJECTS_DIR,
    shell: process.env.SHELL?.trim() || '/bin/sh',
  }
}

export const config: Config = buildConfig()

/** Resolve a repo target by id from the registry. */
export function repoById(id: string): RepoTarget | undefined {
  return config.repos.find((r) => r.id === id)
}
