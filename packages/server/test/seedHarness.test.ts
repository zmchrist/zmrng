import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { seedHarness } from '../src/worktree.js'

// The repo's REAL harness/ dir, resolved relative to this test file
// (packages/server/test/ → repo root → harness/).
const REPO_HARNESS_DIR = fileURLToPath(new URL('../../../harness', import.meta.url))

/** True if `python3` resolves to a runnable interpreter in this test env. */
function python3Available(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// seedHarness copies zmrng's own harness/ tree into a task worktree so a worker
// picks up the same rules/skills/agents/hooks, without ever letting `git add -A`
// sweep that orchestrator tooling into the worker's own PR. These tests drive
// the real function against a real temp git repo (standing in for a worktree)
// and a small fake harness/ fixture — no network, no real `claude`/`gh` calls.

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

function initRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-seed-repo-')))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'zmrng test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}

/** A minimal fake `harness/` fixture with one file per category. */
function initFakeHarness(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-seed-harness-')))
  mkdirSync(path.join(dir, 'rules'), { recursive: true })
  mkdirSync(path.join(dir, 'skills', 'demo-skill'), { recursive: true })
  mkdirSync(path.join(dir, 'agents'), { recursive: true })
  mkdirSync(path.join(dir, 'hooks'), { recursive: true })
  writeFileSync(path.join(dir, 'rules', 'testing.md'), '# testing rule\n')
  writeFileSync(path.join(dir, 'skills', 'demo-skill', 'SKILL.md'), '# demo skill\n')
  writeFileSync(path.join(dir, 'agents', 'qa.md'), '# qa agent\n')
  writeFileSync(path.join(dir, 'hooks', 'security_guard.py'), '# guard\n')
  writeFileSync(path.join(dir, 'hooks', 'branch_guard.py'), '# branch\n')
  writeFileSync(path.join(dir, 'hooks', 'pr_shape_guard.py'), '# pr shape\n')
  writeFileSync(path.join(dir, 'hooks', 'post_tool_use_lint.py'), '# lint\n')
  writeFileSync(path.join(dir, 'hooks', 'stop_validate.py'), '# validate\n')
  writeFileSync(path.join(dir, 'CLAUDE.md'), '# harness CLAUDE\n')
  mkdirSync(path.join(dir, 'commands', 'core_piv_loop'), { recursive: true })
  writeFileSync(path.join(dir, 'commands', 'core_piv_loop', 'plan-feature.md'), '# plan-feature\n')
  writeFileSync(path.join(dir, 'commands', 'core_piv_loop', 'execute.md'), '# execute\n')
  return dir
}

let worktreeDir: string
let harnessDir: string

beforeEach(() => {
  worktreeDir = initRepo()
  harnessDir = initFakeHarness()
})
afterEach(() => {
  rmSync(worktreeDir, { recursive: true, force: true })
  rmSync(harnessDir, { recursive: true, force: true })
})

describe('seedHarness', () => {
  it('copies rules/skills/agents/hooks under a zmrng- namespace', async () => {
    await seedHarness(worktreeDir, '/some/target/repo', harnessDir)

    expect(existsSync(path.join(worktreeDir, '.claude', 'rules', 'zmrng-testing.md'))).toBe(true)
    expect(
      existsSync(path.join(worktreeDir, '.claude', 'skills', 'zmrng-demo-skill', 'SKILL.md')),
    ).toBe(true)
    expect(existsSync(path.join(worktreeDir, '.claude', 'agents', 'zmrng-qa.md'))).toBe(true)
    expect(
      existsSync(path.join(worktreeDir, '.claude', 'zmrng-hooks', 'security_guard.py')),
    ).toBe(true)
    expect(existsSync(path.join(worktreeDir, '.claude', 'settings.local.json'))).toBe(true)

    const settings = JSON.parse(
      readFileSync(path.join(worktreeDir, '.claude', 'settings.local.json'), 'utf8'),
    )
    // security_guard must stay the first PreToolUse registration.
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('security_guard.py')
    // branch_guard + pr_shape_guard must also be registered somewhere in PreToolUse.
    const preCommands = (settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((group) => group.hooks.map((h) => h.command))
    expect(preCommands.some((c) => c.includes('branch_guard.py'))).toBe(true)
    expect(preCommands.some((c) => c.includes('pr_shape_guard.py'))).toBe(true)
  })

  it('tolerates a subdirectory in hooks/ (e.g. python __pycache__) — copies files, skips dirs', async () => {
    // python compiling the hooks drops a __pycache__ dir alongside the .py files;
    // the copy loop must skip it, not crash on copyFileSync of a directory.
    mkdirSync(path.join(harnessDir, 'hooks', '__pycache__'), { recursive: true })
    writeFileSync(path.join(harnessDir, 'hooks', '__pycache__', 'security_guard.pyc'), 'bytecode')

    await expect(seedHarness(worktreeDir, '/some/target/repo', harnessDir)).resolves.toBeDefined()

    expect(existsSync(path.join(worktreeDir, '.claude', 'zmrng-hooks', 'security_guard.py'))).toBe(
      true,
    )
    expect(existsSync(path.join(worktreeDir, '.claude', 'zmrng-hooks', '__pycache__'))).toBe(false)
  })

  it('copies core_piv_loop commands unprefixed — slash resolution needs the exact name', async () => {
    await seedHarness(worktreeDir, '/some/target/repo', harnessDir)

    expect(
      existsSync(path.join(worktreeDir, '.claude', 'commands', 'core_piv_loop', 'plan-feature.md')),
    ).toBe(true)
    expect(
      existsSync(path.join(worktreeDir, '.claude', 'commands', 'core_piv_loop', 'execute.md')),
    ).toBe(true)
  })

  it('never clobbers a pre-existing command file with the same name', async () => {
    const commandsDir = path.join(worktreeDir, '.claude', 'commands', 'core_piv_loop')
    mkdirSync(commandsDir, { recursive: true })
    const ownContent = '# the target repo already owns this command\n'
    writeFileSync(path.join(commandsDir, 'plan-feature.md'), ownContent)

    await seedHarness(worktreeDir, '/some/target/repo', harnessDir)

    expect(readFileSync(path.join(commandsDir, 'plan-feature.md'), 'utf8')).toBe(ownContent)
    expect(existsSync(path.join(commandsDir, 'execute.md'))).toBe(true)
  })

  it('is never swept into `git add -A` — seeded paths stay untracked', async () => {
    await seedHarness(worktreeDir, '/some/target/repo', harnessDir)
    git(worktreeDir, ['add', '-A'])
    const status = git(worktreeDir, ['status', '--porcelain'])

    expect(status).not.toContain('zmrng-')
    expect(status).not.toContain('settings.local.json')
    expect(status).not.toContain('zmrng-hooks')
    expect(status).not.toContain('core_piv_loop')
  })

  it('running twice does not duplicate info/exclude lines or throw', async () => {
    await seedHarness(worktreeDir, '/some/target/repo', harnessDir)
    await expect(seedHarness(worktreeDir, '/some/target/repo', harnessDir)).resolves.toBeTruthy()

    const gitCommonDir = git(worktreeDir, ['rev-parse', '--git-common-dir'])
    const excludePath = path.join(
      path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(worktreeDir, gitCommonDir),
      'info',
      'exclude',
    )
    const contents = readFileSync(excludePath, 'utf8')
    const markerCount = contents.split('zmrng seedHarness').length - 1
    expect(markerCount).toBe(1)
  })

  it('never clobbers a pre-existing target CLAUDE.md — writes zmrng-lifecycle.md instead', async () => {
    const originalClaude = '# this repo already has its own CLAUDE.md\n'
    writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), originalClaude)

    await seedHarness(worktreeDir, '/some/target/repo', harnessDir)

    expect(readFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'utf8')).toBe(originalClaude)
    expect(
      readFileSync(path.join(worktreeDir, '.claude', 'rules', 'zmrng-lifecycle.md'), 'utf8'),
    ).toContain('harness CLAUDE')
  })

  it('writes the harness CLAUDE.md to the worktree root when none exists yet', async () => {
    await seedHarness(worktreeDir, '/some/target/repo', harnessDir)

    expect(readFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'utf8')).toContain('harness CLAUDE')
    expect(existsSync(path.join(worktreeDir, '.claude', 'rules', 'zmrng-lifecycle.md'))).toBe(false)
  })

  it('skips all hook seeding + emits the operator note when python3 is unavailable', async () => {
    const notes = await seedHarness(
      worktreeDir,
      '/some/target/repo',
      harnessDir,
      'zmrng-nonexistent-interpreter',
    )

    expect(notes).toContain(
      'harness hooks skipped — python3 not found; security_guard/lint/validate inactive for this task',
    )
    expect(existsSync(path.join(worktreeDir, '.claude', 'zmrng-hooks', 'security_guard.py'))).toBe(
      false,
    )

    // Non-hook seeding still proceeds.
    expect(existsSync(path.join(worktreeDir, '.claude', 'rules', 'zmrng-testing.md'))).toBe(true)
    expect(existsSync(path.join(worktreeDir, '.claude', 'agents', 'zmrng-qa.md'))).toBe(true)

    // No hook commands registered in settings.local.json (file may not even exist).
    const settingsPath = path.join(worktreeDir, '.claude', 'settings.local.json')
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
      expect(settings.hooks).toBeUndefined()
    }
  })

  it('registers hooks + copies hook scripts when python3 is available', async () => {
    const notes = await seedHarness(worktreeDir, '/some/target/repo', harnessDir, 'python3')

    expect(notes).not.toContain(
      'harness hooks skipped — python3 not found; security_guard/lint/validate inactive for this task',
    )
    expect(existsSync(path.join(worktreeDir, '.claude', 'zmrng-hooks', 'security_guard.py'))).toBe(
      true,
    )

    const settings = JSON.parse(
      readFileSync(path.join(worktreeDir, '.claude', 'settings.local.json'), 'utf8'),
    )
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('security_guard.py')
  })

  // The decisive worker-parity check: seed from the REAL repo harness/ dir (not
  // the fake fixture) and prove a freshly seeded worker worktree carries all five
  // enforcement hooks, wired across PreToolUse/PostToolUse/Stop, none crashing on
  // python3 3.9 (guards against a future PEP-604 `X | None` regression).
  it('seeds all five real harness hooks + registrations, none crashing on python3', async () => {
    await seedHarness(worktreeDir, '/some/target/repo', REPO_HARNESS_DIR, 'python3')

    const FIVE_HOOKS = [
      'security_guard.py',
      'branch_guard.py',
      'pr_shape_guard.py',
      'post_tool_use_lint.py',
      'stop_validate.py',
    ]

    // (a) all five scripts land in .claude/zmrng-hooks/
    const hooksDir = path.join(worktreeDir, '.claude', 'zmrng-hooks')
    for (const name of FIVE_HOOKS) {
      expect(existsSync(path.join(hooksDir, name)), `${name} should be seeded`).toBe(true)
    }

    // (b) settings.local.json carries all five registrations across the events.
    const settings = JSON.parse(
      readFileSync(path.join(worktreeDir, '.claude', 'settings.local.json'), 'utf8'),
    )
    const allCommands = ['PreToolUse', 'PostToolUse', 'Stop']
      .flatMap((event) => (settings.hooks[event] ?? []) as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((group) => group.hooks.map((h) => h.command))
    for (const name of FIVE_HOOKS) {
      expect(
        allCommands.some((c) => c.includes(name)),
        `${name} should be registered in settings.local.json`,
      ).toBe(true)
    }

    // (c) each seeded hook runs exit-0 under python3 with `{}` on stdin. Skip
    //     gracefully if python3 isn't resolvable in this test env.
    if (!python3Available()) return
    for (const name of FIVE_HOOKS) {
      expect(() => {
        execFileSync('python3', [path.join(hooksDir, name)], {
          input: '{}',
          stdio: ['pipe', 'ignore', 'ignore'],
          // stop_validate would auto-detect + run this worktree's stack; run it
          // from the fresh temp worktree (empty git repo) so it detects nothing.
          cwd: worktreeDir,
        })
      }, `${name} should exit 0 on python3 with {} stdin`).not.toThrow()
    }
  })
})
