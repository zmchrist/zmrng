import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { resolveRegistry, RegistryError, type RegistryEnv } from '../src/config.js'

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
