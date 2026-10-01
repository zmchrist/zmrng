import os from 'node:os'
import path from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { SESSION_TTL_MS } from './session.js'
import type { AgentTarget, RepoTarget, SecurityPolicy, SecuritySeverity } from './types.js'

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
  /**
   * Source dir `seedHarness()` copies zmrng's harness from. `<repoRoot>/harness`
   * in dev; the bundled `sidecar/harness` in the packaged app (via
   * `ZMRNG_HARNESS_DIR`, since `repoRoot` resolves inside the read-only `.app`).
   */
  harnessDir: string
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
  /**
   * Global-default security-gate policy (env-tunable via `resolveSecurityPolicy`).
   * A per-repo `RepoTarget.security` override is merged over this per task.
   */
  security: SecurityPolicy
  /** Root dir for the workspace terminal's PTY (== PROJECTS_DIR). */
  projectsDir: string
  /** Login shell for the workspace terminal (SHELL env, else a sane default). */
  shell: string
  /**
   * Grace window (ms) a detached terminal PTY is kept alive after its socket
   * drops, so a lock/unlock, a network blip, or a page reload can reattach to
   * the same live shell (`ZMRNG_TERMINAL_GRACE_MS`, default 10 min). The PTY is
   * reaped if nothing reattaches before it elapses.
   */
  terminalGraceMs: number
  /**
   * Max bytes of recent PTY output retained per session for replay on reattach
   * (`ZMRNG_TERMINAL_BUFFER_BYTES`, default 256 KiB). Oldest bytes are dropped
   * first — this bounds memory, not full scrollback.
   */
  terminalBufferBytes: number
  /**
   * Absolute path to the shared read-only reference checkout the team @mention
   * agent `git pull`s before answering (D8). Empty when `ZMRNG_WORKSPACE_REPO_PATH`
   * is unset — the pull is then skipped gracefully. The live path is
   * orchestrator/operator-owned deployment config.
   */
  workspaceRepoPath: string
  /**
   * id of the configured `AgentTarget` (U4) that acts as the shared team bot
   * (D4). Empty selects the first configured agent. Which live agent is the bot
   * is orchestrator/operator-owned deployment config.
   */
  workspaceBotAgentId: string
  /** The @mention handle that triggers the team agent (default `@agent`). */
  workspaceBotHandle: string
  /** How many recent channel messages are sent to the team agent as context. */
  workspaceScrollback: number
  /** Per-request timeout (ms) for the team-agent fetch; caps a hung upstream. */
  workspaceAgentTimeoutMs: number
  /**
   * Whether the `zmrng_session` login cookie carries the `Secure` attribute
   * (`ZMRNG_SECURE_COOKIES=1`). NEVER unconditional: the VPS workspace is plain
   * `http://` on the tailnet, and browsers silently DROP a `Secure` cookie on a
   * non-HTTPS origin — an unconditional flag would break login there entirely.
   * The cookie builder also sets it whenever the request itself arrived over
   * HTTPS, so this flag is the opt-in for a TLS-terminating proxy that forwards
   * plain http upstream (D2 of .agents/plans/zmrng-login-auth.md).
   */
  secureCookies: boolean
  /**
   * Lifetime (ms) of a login session (`ZMRNG_SESSION_TTL_MS`, default 7 days —
   * `SESSION_TTL_MS` in `session.ts`). Sessions slide: an active one renews
   * once less than 6 days remain, so a session only dies after a genuine week
   * of inactivity.
   */
  sessionTtlMs: number
  /**
   * This instance's HEAD sha (`git rev-parse HEAD` at boot), or '' when it could
   * not be resolved. Advertised in `GET /api/config` so a client can compare it
   * to a `new-version` frame and decide whether a self-update is available (D3).
   */
  headSha: string
  /**
   * Version-poll cadence in ms (`ZMRNG_VERSION_POLL_MS`). DEFAULT 0 = disabled,
   * so ordinary laptops never background-fetch; only the VPS opts in. When > 0 a
   * poller `git fetch`es origin and broadcasts a `new-version` frame over
   * /ws/workspace when origin/main moves ahead of this HEAD (WS-B / D3).
   */
  versionPollMs: number
  /**
   * Gauntlet-loop load gate (D7 of .agents/plans/gauntlet-loop-tab.md): no NEW
   * Loop ticket is picked while the 1-minute load average per core exceeds this
   * (`ZMRNG_LOOP_MAX_LOAD_PER_CORE`, default 1.0). In-flight steps are never killed.
   */
  loopMaxLoadPerCore: number
  /**
   * Gauntlet-loop load gate: no NEW Loop ticket is picked while AVAILABLE memory
   * is below this many MB (`ZMRNG_LOOP_MIN_FREE_MEM_MB`, default 2048).
   */
  loopMinFreeMemMb: number
  /**
   * How often (ms) the Loop pump re-checks a deferred pick while a running run
   * has free lane slots (`ZMRNG_LOOP_PUMP_INTERVAL_MS`, default 30000).
   */
  loopPumpIntervalMs: number
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
 * Source directory `seedHarness()` copies zmrng's own harness from. Honours a
 * `ZMRNG_HARNESS_DIR` override (home-expanded, resolved) — set by the Tauri shell
 * to the bundled `sidecar/harness` because `repoRoot` resolves *inside* the
 * read-only `.app` there and carries no `harness/`. Falls back to
 * `<repoRoot>/harness`, which is today's dev behaviour byte-for-byte. Mirrors the
 * `ZMRNG_WEB_DIST` seam.
 */
export function resolveHarnessDir(env: { ZMRNG_HARNESS_DIR?: string }, repoRoot: string): string {
  const override = env.ZMRNG_HARNESS_DIR?.trim()
  return override ? path.resolve(expandHome(override)) : path.join(repoRoot, 'harness')
}

/**
 * The locked default Semgrep `--config` for the security gate (D1/D4): a
 * vendored high-signal rules directory plus the secrets pack. Deliberately does
 * NOT include `p/owasp-top-ten` (dropped as false-positive-heavy per D1). The
 * actual vendored directory is provisioned in Slice 2; this is the default
 * string the policy carries.
 */
const DEFAULT_SEMGREP_CONFIG = 'security/semgrep-rules,p/secrets'

/** Env inputs for the security policy, isolated so `resolveSecurityPolicy` is testable. */
export interface SecurityEnv {
  ZMRNG_SECURITY_ENABLED?: string
  ZMRNG_SECURITY_MAX_ROUNDS?: string
  ZMRNG_SECURITY_SEMGREP_CONFIG?: string
  ZMRNG_SECURITY_MIN_SEVERITY?: string
}

/** Coerce a severity string onto the SecuritySeverity scale, or `undefined` if unknown. */
function parseSeverity(v: string | undefined): SecuritySeverity | undefined {
  switch (v?.trim().toUpperCase()) {
    case 'ERROR':
      return 'ERROR'
    case 'WARNING':
      return 'WARNING'
    case 'INFO':
      return 'INFO'
    default:
      return undefined
  }
}

/**
 * Resolve the global-default `SecurityPolicy` from env — pure and unit-testable,
 * mirroring `resolveAuthMode`. Locked defaults (D1/D7): enabled=true, maxRounds=2,
 * minSeverity=ERROR, semgrepConfig=DEFAULT_SEMGREP_CONFIG (no owasp-top-ten).
 * The gate is disabled ONLY on an explicit falsey `ZMRNG_SECURITY_ENABLED`
 * (`false`/`0`/`no`, case-insensitive); any other value (incl. unset) keeps it on.
 */
export function resolveSecurityPolicy(env: SecurityEnv): SecurityPolicy {
  const enabledRaw = env.ZMRNG_SECURITY_ENABLED?.trim().toLowerCase()
  const enabled = !(enabledRaw === 'false' || enabledRaw === '0' || enabledRaw === 'no')
  const rounds = Number(env.ZMRNG_SECURITY_MAX_ROUNDS)
  const maxRounds = Number.isInteger(rounds) && rounds > 0 ? rounds : 2
  const semgrepConfig = env.ZMRNG_SECURITY_SEMGREP_CONFIG?.trim() || DEFAULT_SEMGREP_CONFIG
  const minSeverity = parseSeverity(env.ZMRNG_SECURITY_MIN_SEVERITY) ?? 'ERROR'
  return { enabled, maxRounds, semgrepConfig, minSeverity }
}

/** Env inputs for the gauntlet-loop settings, isolated so `resolveLoopConfig` is testable. */
export interface LoopEnv {
  ZMRNG_LOOP_MAX_LOAD_PER_CORE?: string
  ZMRNG_LOOP_MIN_FREE_MEM_MB?: string
  ZMRNG_LOOP_PUMP_INTERVAL_MS?: string
}

/** The resolved gauntlet-loop settings (a slice of `Config`). */
export interface LoopConfig {
  loopMaxLoadPerCore: number
  loopMinFreeMemMb: number
  loopPumpIntervalMs: number
}

/** A positive finite number from an env string, else `fallback` (blank/garbage/0/negative). */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const v = raw?.trim() ? Number(raw) : Number.NaN
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * Resolve the gauntlet-loop load-gate thresholds and pump cadence from env —
 * pure and unit-testable, mirroring `resolveSecurityPolicy`. Each field falls
 * back to its default independently on a non-numeric, non-finite, or
 * non-positive value, so a typo can never disable the gate (e.g. a 0 memory
 * floor) or spin the pump.
 */
export function resolveLoopConfig(env: LoopEnv): LoopConfig {
  return {
    loopMaxLoadPerCore: positiveNumber(env.ZMRNG_LOOP_MAX_LOAD_PER_CORE, 1.0),
    loopMinFreeMemMb: positiveNumber(env.ZMRNG_LOOP_MIN_FREE_MEM_MB, 2048),
    loopPumpIntervalMs: positiveNumber(env.ZMRNG_LOOP_PUMP_INTERVAL_MS, 30000),
  }
}

/**
 * Merge an optional per-repo `security` partial OVER a global-default policy,
 * field-by-field (a repo that omits a field inherits the default). Pure — the
 * orchestrator (Slice 2) calls this to resolve the effective policy per task.
 */
export function mergeSecurityPolicy(
  global: SecurityPolicy,
  override: Partial<SecurityPolicy> | undefined,
): SecurityPolicy {
  return { ...global, ...(override ?? {}) }
}

/**
 * Validate a raw per-repo `security` value into a `Partial<SecurityPolicy>`,
 * or `undefined` when absent/ill-typed. Only plain objects are accepted; each
 * known field is copied only when its type matches, so one bad key never sinks
 * the whole override (mirrors `normalizeAgent`'s defensive field handling).
 */
function normalizeSecurity(raw: unknown): Partial<SecurityPolicy> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: Partial<SecurityPolicy> = {}
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.maxRounds === 'number' && Number.isInteger(r.maxRounds) && r.maxRounds > 0) {
    out.maxRounds = r.maxRounds
  }
  if (typeof r.semgrepConfig === 'string' && r.semgrepConfig.trim()) {
    out.semgrepConfig = r.semgrepConfig.trim()
  }
  const sev = parseSeverity(typeof r.minSeverity === 'string' ? r.minSeverity : undefined)
  if (sev) out.minSeverity = sev
  return Object.keys(out).length ? out : undefined
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
  const entry: RepoTarget = {
    id,
    label: e.label?.trim() || id,
    path: path.resolve(expandHome(rawPath)),
    defaultBranch: e.defaultBranch?.trim() || 'main',
  }
  const security = normalizeSecurity(e.security)
  if (security) entry.security = security
  return entry
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

/**
 * Merge repo lists in priority order, deduping by id and by resolved path
 * (first wins) — EXCEPT when the first-seen entry for an id is not a real git
 * repo and a later entry for the same id is: the later, valid entry wins. This
 * stops a stale curated `repos.json` entry (bad path) from shadowing a same-id
 * repo the projects-dir auto-scan would otherwise have supplied, only to then
 * get dropped itself as invalid — which previously made the id vanish
 * entirely instead of falling through to the valid repo.
 */
function mergeRepos(lists: RepoTarget[][]): RepoTarget[] {
  const byId = new Map<string, RepoTarget>()
  const byPath = new Set<string>()
  for (const r of lists.flat()) {
    const existing = byId.get(r.id)
    if (existing) {
      if (isGitRepo(existing.path) || !isGitRepo(r.path)) continue
      byId.set(r.id, r)
      byPath.add(r.path)
      continue
    }
    if (byPath.has(r.path)) continue
    byId.set(r.id, r)
    byPath.add(r.path)
  }
  return [...byId.values()]
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

/**
 * Current HEAD sha of the zmrng checkout at `repoRoot`, or '' on any failure
 * (missing git, detached/bare state, packaged app with no checkout). Never
 * throws — resolving the sha must never block boot. Mirrors the `execFileSync`
 * shape used by `isGitRepoRoot`/`resolveSelfRepo`.
 */
function readHeadSha(repoRoot: string): string {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return ''
  }
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
    // 4, raised from 2. Profiling the fleet showed agents are nearly free —
    // 3 concurrent `claude` workers burned 15.6% of one core between them,
    // being I/O-bound on the API. The CPU cost was never the agents, it was the
    // validation gate each one spawns per turn, which the lane cap does not
    // bound. With the gate itself now cheaper (seeded-hook dedupe, vitest fork
    // cap, workspace scoping) the old cap of 2 was throttling the cheap
    // resource. See .agents/notes/resource-usage-analysis.md.
    maxLanes: Number(process.env.ZMRNG_MAX_LANES ?? 4),
    repoRoot: REPO_ROOT,
    harnessDir: resolveHarnessDir(process.env, REPO_ROOT),
    dataDir: DATA_DIR,
    dbPath: path.join(DATA_DIR, 'zmrng.db'),
    webDist: process.env.ZMRNG_WEB_DIST ?? path.join(REPO_ROOT, 'packages', 'web', 'dist'),
    authMode: resolveAuthMode(process.env),
    security: resolveSecurityPolicy(process.env),
    projectsDir: PROJECTS_DIR,
    shell: process.env.SHELL?.trim() || '/bin/sh',
    terminalGraceMs: Number(process.env.ZMRNG_TERMINAL_GRACE_MS ?? 600000),
    terminalBufferBytes: Number(process.env.ZMRNG_TERMINAL_BUFFER_BYTES ?? 262144),
    workspaceRepoPath: process.env.ZMRNG_WORKSPACE_REPO_PATH?.trim() || '',
    workspaceBotAgentId: process.env.ZMRNG_WORKSPACE_BOT_AGENT?.trim() || '',
    workspaceBotHandle: process.env.ZMRNG_WORKSPACE_BOT_HANDLE?.trim() || '@agent',
    workspaceScrollback: Number(process.env.ZMRNG_WORKSPACE_SCROLLBACK ?? 20),
    workspaceAgentTimeoutMs: Number(process.env.ZMRNG_WORKSPACE_AGENT_TIMEOUT_MS ?? 60000),
    secureCookies: process.env.ZMRNG_SECURE_COOKIES === '1',
    sessionTtlMs: Number(process.env.ZMRNG_SESSION_TTL_MS ?? SESSION_TTL_MS),
    headSha: readHeadSha(REPO_ROOT),
    versionPollMs: Number(process.env.ZMRNG_VERSION_POLL_MS ?? 0),
    ...resolveLoopConfig(process.env),
  }
}

export const config: Config = buildConfig()

/** Resolve a repo target by id from the registry. */
export function repoById(id: string): RepoTarget | undefined {
  return config.repos.find((r) => r.id === id)
}

/**
 * Re-run the repo registry resolution against the live filesystem. `config.repos`
 * is a boot-time singleton (frozen once at server start), so a repo directory
 * created or renamed under PROJECTS_DIR after boot never appears until this is
 * called — used by `GET /api/repos` so the task-creation dropdown reflects
 * newly added repos on a plain page refresh, no server restart required.
 */
export function liveRepos(): RepoTarget[] {
  return resolveRegistry({
    configDir: CONFIG_DIR,
    projectsDir: PROJECTS_DIR,
    selfRepo: resolveSelfRepo(),
    fallbackRoot: REPO_ROOT,
  }).repos
}
