import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  resolveRegistry,
  resolveAuthMode,
  resolveAgents,
  RegistryError,
  type RegistryEnv,
} from '../src/config.js'

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
