import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  config,
  resolveRegistry,
  resolveAuthMode,
  resolveHarnessDir,
  resolveAgents,
  resolveSecurityPolicy,
  mergeSecurityPolicy,
  RegistryError,
  type RegistryEnv,
} from '../src/config.js'
import type { SecurityPolicy } from '../src/types.js'

let root: string
const NO_SCAN = '/zmrng-nonexistent-projects-dir-xyz'

beforeEach(() => {
  // realpath so `git rev-parse --show-toplevel` (which resolves symlinks, e.g.
  // macOS /var → /private/var) matches path.resolve() in isGitRepoRoot().
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-cfg-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A minimal (empty) real git repo — enough for isGitRepo/isGitRepoRoot. */
function gitRepo(name: string): string {
  const p = path.join(root, name)
  mkdirSync(p, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: p })
  return p
}

function configDirWith(json: unknown): string {
  const dir = path.join(root, 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'repos.json'), JSON.stringify(json))
  return dir
}

const emptyConfigDir = (): string => {
  const dir = path.join(root, 'empty-config')
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('resolveRegistry precedence', () => {
  it('repos.json wins over ZMRNG_REPOS env and legacy ZMRNG_TARGET_REPO', () => {
    const configDir = configDirWith([{ id: 'json-repo', path: '/fake/json' }])
    const env: RegistryEnv = {
      ZMRNG_REPOS: 'env-repo:/fake/env',
      ZMRNG_TARGET_REPO: '/fake/legacy',
    }
    const { repos } = resolveRegistry({ configDir, projectsDir: NO_SCAN, fallbackRoot: root, env })
    expect(repos.map((r) => r.id)).toEqual(['json-repo'])
  })

  it('ZMRNG_REPOS env wins over legacy when no repos.json', () => {
    const env: RegistryEnv = {
      ZMRNG_REPOS: 'env-repo:/fake/env',
      ZMRNG_TARGET_REPO: '/fake/legacy',
    }
    const { repos } = resolveRegistry({
      configDir: emptyConfigDir(),
      projectsDir: NO_SCAN,
      fallbackRoot: root,
      env,
    })
    expect(repos.map((r) => r.id)).toEqual(['env-repo'])
  })

  it('legacy ZMRNG_TARGET_REPO is used as the last explicit source', () => {
    const env: RegistryEnv = { ZMRNG_TARGET_REPO: '/fake/legacy' }
    const { repos } = resolveRegistry({
      configDir: emptyConfigDir(),
      projectsDir: NO_SCAN,
      fallbackRoot: root,
      env,
    })
    expect(repos.map((r) => r.id)).toEqual(['default'])
  })

  it('honours ZMRNG_DEFAULT_REPO when it names a present repo', () => {
    const env: RegistryEnv = {
      ZMRNG_REPOS: 'a:/fake/a,b:/fake/b',
      ZMRNG_DEFAULT_REPO: 'b',
    }
    const { defaultRepoId, targetRepo } = resolveRegistry({
      configDir: emptyConfigDir(),
      projectsDir: NO_SCAN,
      fallbackRoot: root,
      env,
    })
    expect(defaultRepoId).toBe('b')
    expect(targetRepo).toBe('/fake/b')
  })
})

describe('resolveRegistry auto-scan of ZMRNG_PROJECTS_DIR', () => {
  it('discovers a git repo directly under the projects dir', () => {
    const projectsDir = path.join(root, 'projects')
    mkdirSync(projectsDir, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: mkdirp(path.join(projectsDir, 'proj-a')) })
    const { repos } = resolveRegistry({
      configDir: emptyConfigDir(),
      projectsDir,
      fallbackRoot: root,
      env: {},
    })
    expect(repos.map((r) => r.id)).toContain('proj-a')
  })

  it('a stale repos.json entry does not shadow a same-id repo auto-scanned from the projects dir', () => {
    // Regression: mergeRepos deduped by id BEFORE validity was checked, so a
    // curated but broken repos.json entry claimed the id first, got filtered
    // out as invalid, and the real auto-scanned repo of the same id never
    // took its place — the id vanished from the registry entirely.
    const projectsDir = path.join(root, 'projects')
    execFileSync('git', ['init', '-q'], { cwd: mkdirp(path.join(projectsDir, 'example-app')) })
    const configDir = configDirWith([{ id: 'example-app', path: '/fake/stale-path-does-not-exist' }])
    const { repos } = resolveRegistry({
      configDir,
      projectsDir,
      fallbackRoot: root,
      env: {},
    })
    const found = repos.find((r) => r.id === 'example-app')
    expect(found?.path).toBe(path.join(projectsDir, 'example-app'))
  })
})

describe('resolveRegistry empty-registry guard (issue #16)', () => {
  it('synthesizes a usable default zmrng entry instead of throwing on repos[0]', () => {
    const fallbackRoot = gitRepo('self')
    const reg = resolveRegistry({
      configDir: emptyConfigDir(),
      projectsDir: NO_SCAN,
      fallbackRoot,
      env: {},
    })
    expect(reg.repos).toHaveLength(1)
    expect(reg.repos[0].id).toBe('zmrng')
    expect(reg.defaultRepoId).toBe('zmrng')
    expect(reg.targetRepo).toBe(fallbackRoot)
    expect(reg.warnings.join(' ')).toMatch(/registry empty/)
  })

  it('raises a typed RegistryError when even the fallback root is unusable', () => {
    expect(() =>
      resolveRegistry({
        configDir: emptyConfigDir(),
        projectsDir: NO_SCAN,
        fallbackRoot: '',
        env: {},
      }),
    ).toThrow(RegistryError)
  })
})

function mkdirp(p: string): string {
  mkdirSync(p, { recursive: true })
  return p
}

describe('resolveAuthMode', () => {
  it('defaults to oauth when unset', () => {
    expect(resolveAuthMode({})).toBe('oauth')
  })

  it('resolves apikey (case-insensitive)', () => {
    expect(resolveAuthMode({ ZMRNG_AUTH_MODE: 'apikey' })).toBe('apikey')
    expect(resolveAuthMode({ ZMRNG_AUTH_MODE: 'ApiKey' })).toBe('apikey')
    expect(resolveAuthMode({ ZMRNG_AUTH_MODE: 'APIKEY' })).toBe('apikey')
  })

  it('falls back to oauth for any other value', () => {
    expect(resolveAuthMode({ ZMRNG_AUTH_MODE: 'garbage' })).toBe('oauth')
    expect(resolveAuthMode({ ZMRNG_AUTH_MODE: 'oauth' })).toBe('oauth')
    expect(resolveAuthMode({ ZMRNG_AUTH_MODE: '' })).toBe('oauth')
  })
})

describe('resolveHarnessDir', () => {
  const REPO = '/fake/repo/root'

  it('falls back to <repoRoot>/harness when unset (dev behaviour)', () => {
    expect(resolveHarnessDir({}, REPO)).toBe(path.join(REPO, 'harness'))
  })

  it('honours ZMRNG_HARNESS_DIR (the packaged bundle path wins)', () => {
    const bundled = '/Apps/zmrng.app/Contents/Resources/sidecar/harness'
    expect(resolveHarnessDir({ ZMRNG_HARNESS_DIR: bundled }, REPO)).toBe(bundled)
  })

  it('expands a leading ~ and resolves the override', () => {
    expect(resolveHarnessDir({ ZMRNG_HARNESS_DIR: '~/custom/harness' }, REPO)).toBe(
      path.join(homedir(), 'custom', 'harness'),
    )
  })

  it('treats a blank/whitespace override as unset', () => {
    expect(resolveHarnessDir({ ZMRNG_HARNESS_DIR: '   ' }, REPO)).toBe(path.join(REPO, 'harness'))
  })
})

describe('resolveSecurityPolicy', () => {
  it('applies the locked defaults when env is empty (D1/D7)', () => {
    const p = resolveSecurityPolicy({})
    expect(p.enabled).toBe(true)
    expect(p.maxRounds).toBe(2)
    expect(p.minSeverity).toBe('ERROR')
    // D1: high-signal only — p/secrets in, owasp-top-ten out
    expect(p.semgrepConfig).toContain('p/secrets')
    expect(p.semgrepConfig).not.toContain('owasp')
  })

  it('disables the gate only on an explicit falsey ZMRNG_SECURITY_ENABLED', () => {
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_ENABLED: 'false' }).enabled).toBe(false)
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_ENABLED: '0' }).enabled).toBe(false)
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_ENABLED: 'no' }).enabled).toBe(false)
    // anything else (incl. unset / 'true') keeps it enabled
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_ENABLED: 'true' }).enabled).toBe(true)
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_ENABLED: 'garbage' }).enabled).toBe(true)
  })

  it('reads env overrides for maxRounds / semgrepConfig / minSeverity', () => {
    const p = resolveSecurityPolicy({
      ZMRNG_SECURITY_MAX_ROUNDS: '5',
      ZMRNG_SECURITY_SEMGREP_CONFIG: 'my/rules',
      ZMRNG_SECURITY_MIN_SEVERITY: 'warning',
    })
    expect(p.maxRounds).toBe(5)
    expect(p.semgrepConfig).toBe('my/rules')
    expect(p.minSeverity).toBe('WARNING')
  })

  it('ignores a non-numeric / non-positive maxRounds and keeps the default 2', () => {
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_MAX_ROUNDS: 'abc' }).maxRounds).toBe(2)
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_MAX_ROUNDS: '0' }).maxRounds).toBe(2)
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_MAX_ROUNDS: '-3' }).maxRounds).toBe(2)
  })

  it('ignores an unknown minSeverity and keeps the ERROR floor', () => {
    expect(resolveSecurityPolicy({ ZMRNG_SECURITY_MIN_SEVERITY: 'bogus' }).minSeverity).toBe('ERROR')
  })
})

describe('mergeSecurityPolicy (per-repo override over global default)', () => {
  const base: SecurityPolicy = {
    enabled: true,
    maxRounds: 2,
    semgrepConfig: 'security/semgrep-rules,p/secrets',
    minSeverity: 'ERROR',
  }

  it('returns the global default unchanged when there is no override', () => {
    expect(mergeSecurityPolicy(base, undefined)).toEqual(base)
    expect(mergeSecurityPolicy(base, {})).toEqual(base)
  })

  it('merges override fields OVER the global default field-by-field', () => {
    const merged = mergeSecurityPolicy(base, { maxRounds: 4, minSeverity: 'WARNING' })
    expect(merged.maxRounds).toBe(4)
    expect(merged.minSeverity).toBe('WARNING')
    // untouched fields inherit the default
    expect(merged.enabled).toBe(true)
    expect(merged.semgrepConfig).toBe('security/semgrep-rules,p/secrets')
  })

  it('honors security.enabled === false as the opt-out', () => {
    expect(mergeSecurityPolicy(base, { enabled: false }).enabled).toBe(false)
  })
})

describe('RepoTarget.security override in the registry', () => {
  it('preserves a valid per-repo security partial from repos.json', () => {
    const configDir = configDirWith([
      { id: 'r', path: gitRepo('r-secure'), security: { enabled: false, maxRounds: 3 } },
    ])
    const { repos } = resolveRegistry({ configDir, projectsDir: NO_SCAN, fallbackRoot: root, env: {} })
    const r = repos.find((x) => x.id === 'r')
    expect(r?.security).toEqual({ enabled: false, maxRounds: 3 })
  })

  it('leaves security undefined when the repo omits it', () => {
    const configDir = configDirWith([{ id: 'r', path: gitRepo('r-plain') }])
    const { repos } = resolveRegistry({ configDir, projectsDir: NO_SCAN, fallbackRoot: root, env: {} })
    expect(repos.find((x) => x.id === 'r')?.security).toBeUndefined()
  })

  it('drops a non-object security value rather than carrying garbage', () => {
    const configDir = configDirWith([
      { id: 'r', path: gitRepo('r-bad'), security: 'nope' as unknown as object },
    ])
    const { repos } = resolveRegistry({ configDir, projectsDir: NO_SCAN, fallbackRoot: root, env: {} })
    expect(repos.find((x) => x.id === 'r')?.security).toBeUndefined()
  })
})

describe('terminal config fields', () => {
  it('populates an absolute projectsDir and a non-empty shell on the resolved config', () => {
    expect(path.isAbsolute(config.projectsDir)).toBe(true)
    expect(typeof config.shell).toBe('string')
    expect(config.shell.length).toBeGreaterThan(0)
  })
})

describe('team workspace URL is not server config', () => {
  it('exposes no workspaceUrl on the resolved config (the env var is ignored)', () => {
    // The Team VPS base is fixed in the web client (teamConfig.WORKSPACE_URL)
    // for every install, so neither ZMRNG_WORKSPACE_URL nor a persisted setting
    // can point a client anywhere else.
    expect('workspaceUrl' in config).toBe(false)
  })
})

describe('resolveAgents', () => {
  /** Write an agents.json into a fresh config dir and return that dir. */
  function agentsConfigDir(json: unknown): string {
    const dir = path.join(root, 'agents-config')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(json))
    return dir
  }

  it('returns [] when no config and no env (chat panel hidden — standalone)', () => {
    expect(resolveAgents({ configDir: emptyConfigDir(), env: {} })).toEqual([])
  })

  it('reads agents.json, preserving headers', () => {
    const configDir = agentsConfigDir([
      { id: 'a', label: 'Agent A', url: 'https://x/v1', headers: { authorization: 'Bearer t' } },
    ])
    const agents = resolveAgents({ configDir, env: {} })
    expect(agents).toEqual([
      { id: 'a', label: 'Agent A', url: 'https://x/v1', headers: { authorization: 'Bearer t' } },
    ])
  })

  it('agents.json wins over ZMRNG_AGENTS env', () => {
    const configDir = agentsConfigDir([{ id: 'json', label: 'JSON', url: 'https://json/v1' }])
    const agents = resolveAgents({
      configDir,
      env: { ZMRNG_AGENTS: 'env:Env:https://env/v1' },
    })
    expect(agents.map((a) => a.id)).toEqual(['json'])
  })

  it('parses ZMRNG_AGENTS id:label:url triples, keeping the url past the second colon', () => {
    const agents = resolveAgents({
      configDir: emptyConfigDir(),
      env: { ZMRNG_AGENTS: 'a:Agent A:https://x/v1,b:Agent B:https://y/v1' },
    })
    expect(agents).toEqual([
      { id: 'a', label: 'Agent A', url: 'https://x/v1' },
      { id: 'b', label: 'Agent B', url: 'https://y/v1' },
    ])
  })

  it('parses ZMRNG_AGENTS as a JSON array', () => {
    const agents = resolveAgents({
      configDir: emptyConfigDir(),
      env: { ZMRNG_AGENTS: JSON.stringify([{ id: 'j', label: 'J', url: 'https://j/v1' }]) },
    })
    expect(agents).toEqual([{ id: 'j', label: 'J', url: 'https://j/v1' }])
  })

  it('skips malformed entries (missing id/label/url)', () => {
    const configDir = agentsConfigDir([
      { id: '', label: 'no id', url: 'https://x' },
      { id: 'nolabel', url: 'https://x' },
      { id: 'nourl', label: 'no url' },
      { id: 'ok', label: 'OK', url: 'https://ok/v1' },
    ])
    expect(resolveAgents({ configDir, env: {} }).map((a) => a.id)).toEqual(['ok'])
  })

  it('falls back to env when agents.json is malformed JSON', () => {
    const dir = path.join(root, 'bad-agents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'agents.json'), '{ not json')
    const agents = resolveAgents({ configDir: dir, env: { ZMRNG_AGENTS: 'e:E:https://e/v1' } })
    expect(agents.map((a) => a.id)).toEqual(['e'])
  })
})
