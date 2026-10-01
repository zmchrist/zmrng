import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from '../password.js'
import {
  MAX_DISPLAY_NAME_LEN,
  MAX_PASSWORD_LEN,
  MAX_USERNAME_LEN,
  MIN_PASSWORD_LEN,
} from '../types.js'
import type { User } from '../types.js'
import type { Db } from '../db.js'

/**
 * `create-user` — the provisioning path for zmrng application accounts.
 *
 * This script is the ONLY way an account comes into existence: there is
 * deliberately no self-serve signup and no password-reset flow anywhere in the
 * app, so an operator with shell access to the box running the server is the
 * whole account-management surface. Running it a second time for a username
 * that already exists RESETS that user's password in place (same row, same id,
 * same display name) — that is not an accident, it is the documented recovery
 * path for a forgotten password, and the reason there is no reset endpoint.
 *
 * Run it against the same `zmrng.db` the server opens:
 *
 *   npm run create-user -w @zmrng/server -- --username zc --display-name "ZC"
 *
 * The argument parsing (`parseArgs`), the password policy (`validatePassword`)
 * and the provisioning call (`provisionUser`) are exported separately from the
 * `process.argv`/TTY entrypoint at the bottom of this file, so tests drive the
 * logic without executing the script — no prompt, no `process.exit`, and no
 * touching the operator's real database.
 *
 * NOTE for a later reader: `console.log`/`console.error` below are correct and
 * deliberate. The repo's "never `console.log`, use Pino" rule is about SERVER
 * code, where structured logs go to a log stream; this is a CLI whose output is
 * its user interface, and it has no Fastify logger to speak through.
 */

/**
 * The slice of `Db` this CLI needs, kept narrow so tests can inject a temp-file
 * `Db` — the same seam style as `AuthStore` in `../auth.ts`.
 */
export type UserStore = Pick<Db, 'createUser' | 'getUserByUsername' | 'setUserPassword'>

/** Arguments accepted on the command line. `password` is prompted for when absent. */
export interface CreateUserArgs {
  username: string
  displayName: string
  password?: string
}

/** Parse outcome. `parseArgs` NEVER throws — bad input is a value, not an exception. */
export type ParseResult = { ok: true; args: CreateUserArgs } | { ok: false; error: string }

/** What `provisionUser` did: `created: false` means an existing password was RESET. */
export interface ProvisionResult {
  user: User
  created: boolean
}

/** One-line usage, printed alongside every parse error. */
export const USAGE =
  'usage: npm run create-user -w @zmrng/server -- --username <name> [--display-name <name>] [--password <password>]'

const FLAGS = ['--username', '--display-name', '--password'] as const
type Flag = (typeof FLAGS)[number]

function isFlag(token: string): token is Flag {
  return (FLAGS as readonly string[]).includes(token)
}

/**
 * Parse `--username <u> [--display-name <d>] [--password <p>]`, in either the
 * `--flag value` or the `--flag=value` form.
 *
 * `--username` is required; `--display-name` defaults to the username;
 * `--password` is optional (the entrypoint prompts for it with echo suppressed
 * when it is absent, which is the preferred form — a password passed as an
 * argument lands in the shell history and in `ps` output).
 *
 * Every rejection returns `{ ok: false, error }` naming the offending token:
 * missing/blank `--username`, an unknown flag, a bare positional argument, a
 * flag missing its value, a repeated flag, and a username over
 * `MAX_USERNAME_LEN`. A value that itself starts with `--` counts as "missing
 * its value" in the space-separated form; use `--password=--literal` to pass one.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const seen = new Map<Flag, string>()

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)

    if (!name.startsWith('--')) {
      return { ok: false, error: `unexpected argument "${token}" — flags only` }
    }
    if (!isFlag(name)) {
      return { ok: false, error: `unknown flag "${name}"` }
    }
    if (seen.has(name)) {
      return { ok: false, error: `flag ${name} was given more than once` }
    }

    let value: string
    if (eq !== -1) {
      value = token.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `flag ${name} is missing its value` }
      }
      value = next
      i++
    }
    seen.set(name, value)
  }

  const username = (seen.get('--username') ?? '').trim()
  if (!username) {
    return { ok: false, error: '--username is required and cannot be blank' }
  }
  if (username.length > MAX_USERNAME_LEN) {
    return {
      ok: false,
      error: `--username is ${username.length} characters; the maximum is ${MAX_USERNAME_LEN}`,
    }
  }

  // A blank --display-name falls back to the username rather than erroring: the
  // default is the username anyway, so an empty one is a no-op, not a mistake.
  const displayName = (seen.get('--display-name') ?? '').trim() || username
  // This is now the ONLY place a display name enters the system. Before login,
  // the workspace socket's `hello` frame carried one and the parser capped it;
  // `hello` no longer carries a name at all, so without this check an unbounded
  // display name would reach the `members` table and ride every roster snapshot.
  if (displayName.length > MAX_DISPLAY_NAME_LEN) {
    return {
      ok: false,
      error: `--display-name is ${displayName.length} characters; the maximum is ${MAX_DISPLAY_NAME_LEN}`,
    }
  }

  return { ok: true, args: { username, displayName, password: seen.get('--password') } }
}

/**
 * The whole password policy: a length floor and a length ceiling, nothing else.
 * Returns an error message, or `undefined` when the password is acceptable.
 *
 * There are deliberately NO composition rules (no "one digit, one symbol,
 * one capital") — that is a decision, not an omission. Composition rules push
 * people toward short, predictable, mutated-dictionary passwords like
 * `Passw0rd!` and away from long passphrases, which are strictly stronger. The
 * `MAX_PASSWORD_LEN` ceiling is not a policy either, it is a DoS bound: every
 * candidate is fed to a deliberately expensive scrypt hash.
 *
 * Enforced here, at provisioning time — never at login, where echoing a policy
 * back at a caller only tells an attacker which guesses not to bother with.
 */
export function validatePassword(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LEN) {
    return `password must be at least ${MIN_PASSWORD_LEN} characters (got ${password.length})`
  }
  if (password.length > MAX_PASSWORD_LEN) {
    return `password must be at most ${MAX_PASSWORD_LEN} characters (got ${password.length})`
  }
  return undefined
}

/**
 * Create the account, or reset its password if the username already exists.
 *
 * The plaintext never reaches the database layer: it is hashed here with
 * `hashPassword` (versioned scrypt) and only the stored string is passed on. A
 * reset touches the password hash and `updated_at` ONLY — an existing user's
 * display name is left alone, so re-provisioning cannot silently rename
 * someone. Existing sessions are deliberately not swept: that is a policy call
 * for the auth layer, not for a provisioning script.
 */
export function provisionUser(
  db: UserStore,
  args: { username: string; displayName: string; password: string },
  now: string = new Date().toISOString(),
): ProvisionResult {
  const passwordHash = hashPassword(args.password)
  const existing = db.getUserByUsername(args.username)

  if (existing) {
    const updated = db.setUserPassword(existing.id, passwordHash, now)
    if (!updated) {
      throw new Error(`user "${args.username}" disappeared while resetting its password`)
    }
    return { user: updated, created: false }
  }

  return { user: db.createUser(args.username, args.displayName, passwordHash, now), created: true }
}

/**
 * Is this module the program being run, rather than an import? Compares the
 * interpreter's script path (`process.argv[1]`) with this file's own path, so
 * it holds both for `tsx src/cli/createUser.ts` and for `node
 * dist/cli/createUser.js` — and is false under Vitest, whose `argv[1]` is the
 * test runner. Exported so that guard is itself testable.
 */
export function isDirectRun(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false
  try {
    return path.resolve(argv1) === fileURLToPath(moduleUrl)
  } catch {
    // A non-file:// module URL (never the case for a script on disk) — treat it
    // as "not the entrypoint" rather than throwing at module load.
    return false
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Read a password from a TTY with echo suppressed. Raw mode is what turns the
 * echo off; it also means this loop has to handle Enter, backspace and Ctrl-C
 * itself. There is no fallback to an echoing prompt: if stdin is not a TTY
 * (a pipe, a CI step) the caller is told to pass `--password` instead rather
 * than having the password silently printed or read from a pipe by surprise.
 */
async function promptPassword(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    throw new Error(
      'no --password given and stdin is not a TTY, so it cannot be prompted for without echoing it — pass --password <password>',
    )
  }

  process.stdout.write(prompt)
  return await new Promise<string>((resolve, reject) => {
    let value = ''
    const done = (err: Error | null, out: string): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      if (err) reject(err)
      else resolve(out)
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(null, value)
        if (ch === '\u0003') return done(new Error('aborted'), '')
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += ch
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
  })
}

/** Run the CLI. Returns the process exit code; never throws. */
async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    console.error(`create-user: ${parsed.error}`)
    console.error(USAGE)
    return 2
  }

  let password = parsed.args.password
  if (password === undefined) {
    try {
      password = await promptPassword(`password for "${parsed.args.username}": `)
    } catch (err) {
      console.error(`create-user: ${errMsg(err)}`)
      return 2
    }
  }

  const bad = validatePassword(password)
  if (bad) {
    console.error(`create-user: ${bad}`)
    return 2
  }

  // Imported here, not at the top of the file, so merely importing this module
  // (which the tests do) neither builds the config — its module body scans the
  // filesystem and shells out to git — nor opens the operator's real zmrng.db.
  const { config } = await import('../config.js')
  const { Db } = await import('../db.js')

  const db = new Db(config.dbPath)
  try {
    const { user, created } = provisionUser(db, {
      username: parsed.args.username,
      displayName: parsed.args.displayName,
      password,
    })
    const what = created ? 'created user' : 'reset the password for user'
    console.log(`${what} "${user.username}" (${user.displayName}) in ${config.dbPath}`)
    return 0
  } catch (err) {
    console.error(`create-user: ${errMsg(err)}`)
    return 1
  } finally {
    db.close()
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`create-user: ${errMsg(err)}`)
      process.exit(1)
    },
  )
}
