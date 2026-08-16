import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
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
