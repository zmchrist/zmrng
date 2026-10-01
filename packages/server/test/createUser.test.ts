import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { Db } from '../src/db.js'
import { verifyPassword } from '../src/password.js'
import {
  MAX_DISPLAY_NAME_LEN,
  MAX_PASSWORD_LEN,
  MAX_USERNAME_LEN,
  MIN_PASSWORD_LEN,
} from '../src/types.js'
import { isDirectRun, parseArgs, provisionUser, validatePassword } from '../src/cli/createUser.js'

// These tests drive the CLI's EXPORTED parse/provision functions only. The
// `process.argv`/TTY entrypoint is never executed here — no prompt, no
// `process.exit`, no real `zmrng.db` — which is the whole reason the module
// splits its logic out from its shell.

let dir: string
let dbPath: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zmrng-createuser-'))
  dbPath = path.join(dir, 'zmrng.db')
  db = new Db(dbPath)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Count matching user rows through a second connection (WAL allows readers). */
function userCount(p: string, username: string): number {
  const raw = new Database(p)
  const row = raw.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get(username) as {
    n: number
  }
  raw.close()
  return row.n
}

describe('parseArgs', () => {
  it('parses the `--flag value` form', () => {
    const res = parseArgs(['--username', 'zc', '--display-name', 'ZC', '--password', 'hunter2222'])
    expect(res).toEqual({
      ok: true,
      args: { username: 'zc', displayName: 'ZC', password: 'hunter2222' },
    })
  })

  it('parses the `--flag=value` form', () => {
    const res = parseArgs(['--username=zc', '--display-name=Z C', '--password=hunter2222'])
    expect(res).toEqual({
      ok: true,
      args: { username: 'zc', displayName: 'Z C', password: 'hunter2222' },
    })
  })

  it('defaults --display-name to the username', () => {
    const res = parseArgs(['--username', 'zc'])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.args.displayName).toBe('zc')
    expect(res.args.password).toBeUndefined()
  })

  it('errors when --username is absent', () => {
    const res = parseArgs(['--display-name', 'ZC'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/--username/)
  })

  it('errors when --username is blank', () => {
    const res = parseArgs(['--username', '   '])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/--username/)
  })

  it('errors on an unknown flag, naming it', () => {
    const res = parseArgs(['--username', 'zc', '--admin'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/--admin/)
  })

  it('errors on a bare positional argument, naming it', () => {
    const res = parseArgs(['zc'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/zc/)
  })

  it('errors when a flag is missing its value', () => {
    const res = parseArgs(['--username'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/--username/)
    expect(res.error).toMatch(/value/i)
  })

  it('errors when the username is longer than MAX_USERNAME_LEN', () => {
    const res = parseArgs(['--username', 'u'.repeat(MAX_USERNAME_LEN + 1)])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(String(MAX_USERNAME_LEN))
  })

  // The CLI is now the ONLY place a display name enters the system: `hello` no
  // longer carries one, so nothing else bounds it. An unbounded name would land
  // in `members` and ride every roster snapshot.
  it('errors when the display name is longer than MAX_DISPLAY_NAME_LEN', () => {
    const res = parseArgs([
      '--username',
      'ada',
      '--display-name',
      'D'.repeat(MAX_DISPLAY_NAME_LEN + 1),
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(String(MAX_DISPLAY_NAME_LEN))
  })

  it('accepts a display name of exactly MAX_DISPLAY_NAME_LEN', () => {
    const res = parseArgs([
      '--username',
      'ada',
      '--display-name',
      'D'.repeat(MAX_DISPLAY_NAME_LEN),
    ])
    expect(res.ok).toBe(true)
  })

  it('accepts a username of exactly MAX_USERNAME_LEN', () => {
    expect(parseArgs(['--username', 'u'.repeat(MAX_USERNAME_LEN)]).ok).toBe(true)
  })
})

describe('validatePassword', () => {
  it('rejects a password one character short of the minimum', () => {
    const err = validatePassword('a'.repeat(MIN_PASSWORD_LEN - 1))
    expect(err).toBeTypeOf('string')
    expect(err).toMatch(String(MIN_PASSWORD_LEN))
  })

  it('accepts a password of exactly MIN_PASSWORD_LEN', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LEN))).toBeUndefined()
  })

  it('rejects a password longer than MAX_PASSWORD_LEN', () => {
    const err = validatePassword('a'.repeat(MAX_PASSWORD_LEN + 1))
    expect(err).toBeTypeOf('string')
    expect(err).toMatch(String(MAX_PASSWORD_LEN))
  })

  it('imposes no composition rules — a long all-lowercase passphrase is fine', () => {
    expect(validatePassword('correct horse battery staple')).toBeUndefined()
  })
})

describe('provisionUser', () => {
  it('creates a user whose stored hash verifies and is not the plaintext', () => {
    const res = provisionUser(db, { username: 'zc', displayName: 'ZC', password: 'hunter2222' })

    expect(res.created).toBe(true)
    expect(res.user.username).toBe('zc')
    expect(res.user.displayName).toBe('ZC')
    expect(res.user.passwordHash).not.toBe('hunter2222')
    expect(res.user.passwordHash.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('hunter2222', res.user.passwordHash)).toBe(true)

    expect(db.getUserByUsername('zc')?.passwordHash).toBe(res.user.passwordHash)
  })

  it('re-provisioning an existing username RESETS the password instead of duplicating', () => {
    const first = provisionUser(db, { username: 'zc', displayName: 'ZC', password: 'hunter2222' })
    const second = provisionUser(db, {
      username: 'zc',
      displayName: 'Ignored Rename',
      password: 'newpass2222',
    })

    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)
    expect(userCount(dbPath, 'zc')).toBe(1)

    const stored = db.getUserByUsername('zc')
    expect(stored).toBeDefined()
    if (!stored) return
    expect(verifyPassword('hunter2222', stored.passwordHash)).toBe(false)
    expect(verifyPassword('newpass2222', stored.passwordHash)).toBe(true)
  })
})

describe('entrypoint guard', () => {
  it('isDirectRun is false under the test runner and true for the module path', () => {
    const moduleUrl = new URL('../src/cli/createUser.ts', import.meta.url).href
    const modulePath = fileURLToPath(moduleUrl)

    expect(isDirectRun(process.argv[1], moduleUrl)).toBe(false)
    expect(isDirectRun(undefined, moduleUrl)).toBe(false)
    expect(isDirectRun(modulePath, moduleUrl)).toBe(true)
  })

  it('importing the module runs no prompt, no exit and no console output', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)}) during import`)
    }) as never)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const mod = await import('../src/cli/createUser.js')
    expect(typeof mod.parseArgs).toBe('function')
    expect(exit).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(process.stdin.isRaw).not.toBe(true)

    exit.mockRestore()
    log.mockRestore()
    error.mockRestore()
  })
})
