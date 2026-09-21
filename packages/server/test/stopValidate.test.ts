import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'

// stop_validate.py used to resolve a project subdirectory via
// `find_active_project`, built for the operator's `~/Projects` container
// layout (git-diff the container, then look for a first-level subdir with a
// stack marker). In a zmrng-seeded worktree, CLAUDE_PROJECT_DIR *is* the
// project root; for an npm-workspaces repo a changed
// `packages/server/src/x.ts` maps to first-level dir `packages/`, which has
// no package.json, so the old logic silently returned None and validation
// never ran. These tests drive the real hook script end-to-end.

const HOOK = path.resolve(__dirname, '../../../harness/hooks/stop_validate.py')

function hasPython3(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const maybeIt = hasPython3() ? it : it.skip

function runHook(projectDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('python3', [HOOK], {
      cwd: projectDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      input: '',
      encoding: 'utf8',
    })
    return { status: 0, stdout }
  } catch (err) {
    const e = err as { status: number; stdout: string }
    return { status: e.status, stdout: e.stdout }
  }
}

describe('stop_validate.py', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-stopvalidate-')))
  })
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  maybeIt(
    'validates CLAUDE_PROJECT_DIR directly (no first-level-subdir lookup) and blocks on failure',
    () => {
      // npm-workspaces-shaped root: a package.json whose "typecheck" script
      // fails. Under the old find_active_project logic this would never even
      // run, because there's no changed-file-derived first-level subdir with
      // its own package.json.
      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'fixture', scripts: { typecheck: 'exit 1' } }),
      )

      const { stdout } = runHook(projectDir)

      expect(stdout.trim().length).toBeGreaterThan(0)
      const decision = JSON.parse(stdout.trim())
      expect(decision.decision).toBe('block')
      expect(decision.reason).toContain('typecheck FAILED')
    },
    30_000,
  )

  maybeIt('passes through cleanly when validation succeeds', () => {
    writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { typecheck: 'exit 0' } }),
    )

    const { stdout } = runHook(projectDir)

    expect(stdout.trim()).toBe('')
  })

  maybeIt(
    'keys the stop-flag file per project dir, so concurrent lanes never share one',
    () => {
      const dirA = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-lane-a-')))
      const dirB = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-lane-b-')))
      try {
        const script = [
          'import sys',
          `sys.path.insert(0, ${JSON.stringify(path.dirname(HOOK))})`,
          'import stop_validate as sv',
          'from pathlib import Path',
          `print(sv.get_flag_file(Path(${JSON.stringify(dirA)})))`,
          `print(sv.get_flag_file(Path(${JSON.stringify(dirB)})))`,
        ].join('\n')
        const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' })
        const [flagA, flagB] = out.trim().split('\n')
        expect(flagA).toBeTruthy()
        expect(flagB).toBeTruthy()
        expect(flagA).not.toBe(flagB)
      } finally {
        rmSync(dirA, { recursive: true, force: true })
        rmSync(dirB, { recursive: true, force: true })
      }
    },
  )
})

// ---------------------------------------------------------------------------
// verify.sh — the shared gate (agent, loop.sh, and the Stop hook via
// validate.sh). The gate used to run `npm run test --workspaces`, so a server
// failure was concatenated *above* the web workspace's green output and then
// printed with `tail` under a "first N lines" heading — the failure scrolled
// off entirely and the summary said only "FAIL test". These tests drive the
// real script against a temp npm-workspaces fixture.
// ---------------------------------------------------------------------------

const VERIFY = path.resolve(__dirname, '../../../.claude/verify.sh')

interface FixtureScripts {
  server: string
  web: string
}

function makeVerifyFixture(scripts: FixtureScripts): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'zmrng-verify-')))
  mkdirSync(path.join(root, '.claude'), { recursive: true })
  copyFileSync(VERIFY, path.join(root, '.claude', 'verify.sh'))
  chmodSync(path.join(root, '.claude', 'verify.sh'), 0o755)
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'verify-fixture',
      private: true,
      workspaces: ['packages/*'],
      scripts: {
        typecheck: 'exit 0',
        lint: 'exit 0',
        test: 'npm run test --workspaces --if-present',
        build: 'exit 0',
      },
    }),
  )
  for (const [dir, pkg] of [
    ['server', '@zmrng/server'],
    ['web', '@zmrng/web'],
  ] as const) {
    mkdirSync(path.join(root, 'packages', dir), { recursive: true })
    writeFileSync(
      path.join(root, 'packages', dir, 'package.json'),
      JSON.stringify({
        name: pkg,
        version: '0.0.0',
        scripts: { test: scripts[dir] },
      }),
    )
  }
  return root
}

function runVerify(root: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bash', [path.join(root, '.claude', 'verify.sh'), '--fast'], {
      cwd: root,
      encoding: 'utf8',
    })
    return { status: 0, stdout }
  } catch (err) {
    const e = err as { status: number; stdout: string }
    return { status: e.status, stdout: e.stdout }
  }
}

describe('verify.sh', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
  })

  function fixture(scripts: FixtureScripts): string {
    const root = makeVerifyFixture(scripts)
    roots.push(root)
    return root
  }

  it('passes with a per-workspace test step for each workspace', () => {
    const root = fixture({ server: 'exit 0', web: 'exit 0' })

    const { status, stdout } = runVerify(root)

    expect(status).toBe(0)
    expect(stdout).toContain('=============== verify summary ================')
    expect(stdout).toContain('PASS  test:server')
    expect(stdout).toContain('PASS  test:web')
  }, 60_000)

  it('names the failing workspace in the summary when the server suite fails', () => {
    const root = fixture({
      server: 'echo SERVER_BOOM && exit 1',
      web: 'echo web-green',
    })

    const { status, stdout } = runVerify(root)

    expect(status).not.toBe(0)
    expect(stdout).toContain('FAIL  test:server')
    expect(stdout).toContain('PASS  test:web')
  }, 60_000)

  // The marker lives inside a script *file*, never on the command line — npm's
  // own error block echoes the failing command near the tail, which would make
  // a command-line marker appear in `tail` output too.
  function withServerScript(body: string): string {
    const root = fixture({ server: 'bash ./boom.sh', web: 'exit 0' })
    writeFileSync(path.join(root, 'packages', 'server', 'boom.sh'), body)
    return root
  }

  it('prints the head of the failing output, matching its own "first N lines" wording', () => {
    const root = withServerScript(
      'echo HEAD_MARKER\nfor i in $(seq 1 200); do echo filler-$i; done\nexit 1\n',
    )

    const { stdout } = runVerify(root)

    expect(stdout).toContain('first 40 lines')
    expect(stdout).toContain('HEAD_MARKER')
  }, 60_000)

  it('still shows the tail when the output is longer than the head window', () => {
    const root = withServerScript(
      'for i in $(seq 1 200); do echo filler-$i; done\necho TAIL_MARKER\nexit 1\n',
    )

    const { stdout } = runVerify(root)

    expect(stdout).toContain('TAIL_MARKER')
  }, 60_000)
})
