import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { Db } from '../src/db.js'
import {
  AuthService,
  GENERIC_LOGIN_ERROR,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  LoginThrottle,
  bearerToken,
  clearCookie,
  isProtectedPath,
  parseCookieHeader,
  publicUser,
  sessionCookie,
} from '../src/auth.js'
import { hashPassword } from '../src/password.js'
import { hashToken, newToken } from '../src/session.js'
import { SESSION_COOKIE_NAME } from '../src/types.js'

let dir: string
let db: Db

const NOW = '2026-09-10T00:00:00.000Z'
const PASSWORD = 'correct horse battery'

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zmrng-auth-'))
  db = new Db(path.join(dir, 'zmrng.db'))
  db.createUser('zc', 'zc', hashPassword(PASSWORD), NOW)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** `nowIso` shifted by `ms`, for driving expiry/renewal without timers. */
function at(ms: number, from = NOW): string {
  return new Date(new Date(from).getTime() + ms).toISOString()
}

describe('isProtectedPath', () => {
  it('gates every KB and channel prefix', () => {
    for (const url of [
      '/api/spaces',
      '/api/spaces/1/tree',
      '/api/pages/7',
      '/api/folders/3',
      '/api/page-revisions/9/restore',
      '/api/channels',
      '/api/channels/2/messages?limit=10',
      '/api/auth/me',
      '/api/auth/logout',
    ]) {
      expect(isProtectedPath(url), url).toBe(true)
    }
  })

  // The near-miss half is the point: a gate that blanket-denies is not a gate.
  it('leaves the Workspace orchestrator surface and the login route open', () => {
    for (const url of [
      '/',
      '/index.html',
      '/api/tasks',
      '/api/tasks/abc/events',
      '/api/config',
      '/api/repos',
      '/api/preflight',
      '/api/settings',
      '/api/ui-state',
      '/api/auth/login',
      '/api/projects/files',
    ]) {
      expect(isProtectedPath(url), url).toBe(false)
    }
  })

  it('matches only on a path-segment boundary', () => {
    expect(isProtectedPath('/api/pages-public')).toBe(false)
    expect(isProtectedPath('/api/spacesx')).toBe(false)
    expect(isProtectedPath('/api/pages')).toBe(true)
  })
})

describe('parseCookieHeader', () => {
  it('survives absent, blank, multi-cookie and malformed headers', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
    expect(parseCookieHeader('')).toEqual({})
    expect(parseCookieHeader('   ')).toEqual({})
    expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' })
    // A pair with no `=`, a leading `=`, and stray whitespace are all skipped
    // or trimmed rather than throwing.
    expect(parseCookieHeader('novalue; =orphan;  c = 3 ')).toEqual({ c: '3' })
  })

  it('finds the session cookie among others', () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=abc123; other=x`
    expect(parseCookieHeader(header)[SESSION_COOKIE_NAME]).toBe('abc123')
  })
})

describe('bearerToken', () => {
  it('reads a bearer token case-insensitively and ignores anything else', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer abc')).toBe('abc')
    expect(bearerToken('  Bearer   abc  ')).toBe('abc')
    expect(bearerToken('Basic abc')).toBeUndefined()
    expect(bearerToken('abc')).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
  })
})

describe('sessionCookie / clearCookie', () => {
  it('always carries HttpOnly, SameSite=Strict and Path=/', () => {
    const cookie = sessionCookie('tok', { secure: false })
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=tok`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toMatch(/Max-Age=\d+/)
  })

  // Browsers silently DROP a Secure cookie on a plain-http origin, and the VPS
  // workspace is plain http on the tailnet — an unconditional flag would break
  // login there entirely (D2).
  it('omits Secure on http and includes it when asked', () => {
    expect(sessionCookie('tok', { secure: false })).not.toContain('Secure')
    expect(sessionCookie('tok', { secure: true })).toContain('Secure')
  })

  it('expires the cookie on logout with the same attributes', () => {
    const cookie = clearCookie({ secure: false })
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })
})

describe('LoginThrottle', () => {
  it('locks after the limit and releases when the window elapses', () => {
    const throttle = new LoginThrottle()
    const t0 = 1_000_000
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) throttle.fail('zc', '1.2.3.4', t0)
    expect(throttle.locked('zc', '1.2.3.4', t0)).toBe(false)
    throttle.fail('zc', '1.2.3.4', t0)
    expect(throttle.locked('zc', '1.2.3.4', t0)).toBe(true)
    expect(throttle.retryAfterMs('zc', '1.2.3.4', t0)).toBe(LOGIN_FAILURE_WINDOW_MS)
    expect(throttle.locked('zc', '1.2.3.4', t0 + LOGIN_FAILURE_WINDOW_MS)).toBe(false)
  })

  it('is keyed on (username, IP), not on either alone', () => {
    const throttle = new LoginThrottle()
    const t0 = 1_000_000
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) throttle.fail('zc', '1.2.3.4', t0)
    expect(throttle.locked('zc', '1.2.3.4', t0)).toBe(true)
    expect(throttle.locked('zc', '5.6.7.8', t0)).toBe(false)
    expect(throttle.locked('other', '1.2.3.4', t0)).toBe(false)
  })

  it('forgets a pair on reset', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) throttle.fail('zc', '1.2.3.4', 0)
    throttle.reset('zc', '1.2.3.4')
    expect(throttle.locked('zc', '1.2.3.4', 0)).toBe(false)
  })
})

describe('AuthService.login', () => {
  it('issues a session storing only the token HASH, never the raw token', () => {
    const auth = new AuthService(db)
    const result = auth.login('zc', PASSWORD, NOW)
    expect(result).toBeDefined()
    const token = result!.token
    const stored = db.getSession(hashToken(token))
    expect(stored).toBeDefined()
    expect(stored!.tokenHash).toBe(hashToken(token))
    expect(stored!.tokenHash).not.toBe(token)
    // The raw token appears nowhere in the row.
    expect(JSON.stringify(stored)).not.toContain(token)
    expect(result!.user).toEqual({ id: expect.any(Number), username: 'zc', displayName: 'zc' })
  })

  it('rejects a wrong password and an unknown username identically', () => {
    const auth = new AuthService(db)
    expect(auth.login('zc', 'wrong', NOW)).toBeUndefined()
    expect(auth.login('nobody', PASSWORD, NOW)).toBeUndefined()
    // Neither path may leave a session behind.
    expect(db.deleteExpiredSessions(at(10 * 365 * 24 * 60 * 60 * 1000))).toBe(0)
  })

  it('never leaks the password hash through publicUser', () => {
    const user = db.getUserByUsername('zc')!
    expect(Object.keys(publicUser(user)).sort()).toEqual(['displayName', 'id', 'username'])
  })
})

describe('AuthService.resolve', () => {
  it('accepts the cookie and the bearer header, preferring the bearer', () => {
    const auth = new AuthService(db)
    const cookieSession = auth.login('zc', PASSWORD, NOW)!
    db.createUser('other', 'Other', hashPassword(PASSWORD), NOW)
    const bearerSession = auth.login('other', PASSWORD, NOW)!

    expect(auth.resolve(undefined, `${SESSION_COOKIE_NAME}=${cookieSession.token}`, NOW)?.username)
      .toBe('zc')
    expect(auth.resolve(`Bearer ${bearerSession.token}`, undefined, NOW)?.username).toBe('other')
    // Both present: the explicitly-presented bearer credential wins.
    expect(
      auth.resolve(
        `Bearer ${bearerSession.token}`,
        `${SESSION_COOKIE_NAME}=${cookieSession.token}`,
        NOW,
      )?.username,
    ).toBe('other')
  })

  it('rejects an absent, unknown, tampered, logged-out or expired token', () => {
    const auth = new AuthService(db)
    const { token } = auth.login('zc', PASSWORD, NOW)!
    expect(auth.resolve(undefined, undefined, NOW)).toBeUndefined()
    expect(auth.resolve(`Bearer ${newToken()}`, undefined, NOW)).toBeUndefined()
    expect(auth.resolve(`Bearer ${token}x`, undefined, NOW)).toBeUndefined()
    // One week later the session has lapsed...
    expect(auth.resolve(`Bearer ${token}`, undefined, at(8 * 24 * 60 * 60 * 1000))).toBeUndefined()
    // ...and noticing an expired session sweeps its row.
    expect(db.getSession(hashToken(token))).toBeUndefined()

    const second = auth.login('zc', PASSWORD, NOW)!
    auth.logout(second.token)
    expect(auth.resolve(`Bearer ${second.token}`, undefined, NOW)).toBeUndefined()
  })

  it('slides an active session only once the renewal window is entered', () => {
    const auth = new AuthService(db)
    const { token } = auth.login('zc', PASSWORD, NOW)!
    const issued = db.getSession(hashToken(token))!.expiresAt

    // A fresh session must cause NO write — that is the whole point of the
    // sliding-window threshold.
    auth.resolve(`Bearer ${token}`, undefined, at(60_000))
    expect(db.getSession(hashToken(token))!.expiresAt).toBe(issued)

    // Two days in, less than six days remain, so it renews.
    const later = at(2 * 24 * 60 * 60 * 1000)
    auth.resolve(`Bearer ${token}`, undefined, later)
    const renewed = db.getSession(hashToken(token))!.expiresAt
    expect(new Date(renewed).getTime()).toBeGreaterThan(new Date(issued).getTime())
  })
})

describe('AuthService.resolveSocketIdentity', () => {
  it('prefers the hello token over the handshake cookie', () => {
    const auth = new AuthService(db)
    const cookieSession = auth.login('zc', PASSWORD, NOW)!
    db.createUser('other', 'Other', hashPassword(PASSWORD), NOW)
    const helloSession = auth.login('other', PASSWORD, NOW)!

    expect(
      auth.resolveSocketIdentity(`${SESSION_COOKIE_NAME}=${cookieSession.token}`, undefined, NOW)
        ?.username,
    ).toBe('zc')
    expect(auth.resolveSocketIdentity(undefined, helloSession.token, NOW)?.username).toBe('other')
    expect(
      auth.resolveSocketIdentity(
        `${SESSION_COOKIE_NAME}=${cookieSession.token}`,
        helloSession.token,
        NOW,
      )?.username,
    ).toBe('other')
  })

  it('yields nothing for an absent, unknown, tampered or expired token', () => {
    const auth = new AuthService(db)
    const { token } = auth.login('zc', PASSWORD, NOW)!
    expect(auth.resolveSocketIdentity(undefined, undefined, NOW)).toBeUndefined()
    expect(auth.resolveSocketIdentity(undefined, newToken(), NOW)).toBeUndefined()
    expect(auth.resolveSocketIdentity(undefined, `${token}x`, NOW)).toBeUndefined()
    expect(
      auth.resolveSocketIdentity(undefined, token, at(8 * 24 * 60 * 60 * 1000)),
    ).toBeUndefined()
  })
})

describe('AuthService.sweep', () => {
  it('deletes only lapsed sessions', () => {
    const auth = new AuthService(db)
    auth.login('zc', PASSWORD, NOW)
    expect(auth.sweep(at(60_000))).toBe(0)
    expect(auth.sweep(at(8 * 24 * 60 * 60 * 1000))).toBe(1)
  })
})

describe('the generic login error', () => {
  // A message that distinguished "no such user" from "wrong password" would
  // turn the login route into a username oracle.
  it('never names which half of the credentials was wrong', () => {
    expect(GENERIC_LOGIN_ERROR).not.toMatch(
      /unknown|no such|not found|does not exist|wrong password|incorrect password/i,
    )
    expect(GENERIC_LOGIN_ERROR).toMatch(/invalid/i)
  })
})
