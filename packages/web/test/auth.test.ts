import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  SESSION_KEY_PREFIX,
  sessionKey,
  loadSession,
  saveSession,
  clearSession,
  isSessionExpired,
  authHeaders,
  loginToOrigins,
  type LoginPost,
  type StoredSession,
} from '../src/auth'
import type { LoginResponse, PublicUser } from '../src/types'

/** The desktop deployment's two gated origins: the local sidecar and the VPS. */
const LOCAL = ''
const VPS = 'http://<vps-ip>:4500'

const ADA: PublicUser = { id: 1, username: 'ada', displayName: 'Ada' }
const GRACE: PublicUser = { id: 2, username: 'grace', displayName: 'Grace' }

/** A session that expires far enough out to still be live during the test run. */
function live(user: PublicUser, token: string): StoredSession {
  return { user, token, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }
}

function response(session: StoredSession): LoginResponse {
  return { user: session.user, token: session.token, expiresAt: session.expiresAt }
}

beforeEach(() => {
  localStorage.clear()
})

describe('sessionKey', () => {
  it('keys the empty (same-origin) origin as `local`, distinctly from a remote one', () => {
    expect(sessionKey(LOCAL)).toBe(`${SESSION_KEY_PREFIX}local`)
    expect(sessionKey(VPS)).toBe(`${SESSION_KEY_PREFIX}http://<vps-ip>:4500`)
    expect(sessionKey(LOCAL)).not.toBe(sessionKey(VPS))
  })

  it('normalizes whitespace, case and trailing slashes to one stable key', () => {
    const canonical = sessionKey(VPS)
    expect(sessionKey('  http://<vps-ip>:4500  ')).toBe(canonical)
    expect(sessionKey('http://<vps-ip>:4500/')).toBe(canonical)
    expect(sessionKey('http://<vps-ip>:4500///')).toBe(canonical)
    expect(sessionKey('HTTP://<vps-ip>:4500')).toBe(canonical)
    // A blank-but-not-empty origin is still the local one.
    expect(sessionKey('   ')).toBe(sessionKey(LOCAL))
  })
})

describe('origin-keyed storage (decision D1)', () => {
  it('holds INDEPENDENT sessions for two different origins', () => {
    const localSession = live(ADA, 'local-token')
    const vpsSession = live(GRACE, 'vps-token')
    saveSession(LOCAL, localSession)
    saveSession(VPS, vpsSession)

    // A session is issued by ONE server, so the desktop app (local sidecar for
    // the KB, VPS for Team Chat) necessarily holds two — neither overwrites the
    // other.
    expect(loadSession(LOCAL)).toEqual(localSession)
    expect(loadSession(VPS)).toEqual(vpsSession)
  })

  it('SHARES one session between two spellings of the SAME origin', () => {
    // This is the property that makes a single login cover both gated surfaces
    // on the VPS deployment, where the KB and Team Chat are the same server:
    // both surfaces resolve to one storage key, so one login authenticates both.
    const session = live(ADA, 'shared-token')
    saveSession(VPS, session)
    expect(loadSession('http://<vps-ip>:4500/')).toEqual(session)
    expect(loadSession('HTTP://<vps-ip>:4500')).toEqual(session)
  })

  it('round-trips a saved session', () => {
    const session = live(ADA, 'tok')
    saveSession(VPS, session)
    expect(loadSession(VPS)).toEqual(session)
  })

  it('clears only the origin it was asked to clear', () => {
    saveSession(LOCAL, live(ADA, 'local-token'))
    saveSession(VPS, live(GRACE, 'vps-token'))

    clearSession(VPS)

    expect(loadSession(VPS)).toBeNull()
    expect(loadSession(LOCAL)?.token).toBe('local-token')
  })
})

describe('loadSession tolerance', () => {
  it('returns null when nothing is stored for that origin', () => {
    expect(loadSession(VPS)).toBeNull()
  })

  it('returns null for non-JSON garbage rather than throwing', () => {
    localStorage.setItem(sessionKey(VPS), 'not json {{{')
    expect(() => loadSession(VPS)).not.toThrow()
    expect(loadSession(VPS)).toBeNull()
  })

  it('returns null for JSON of the wrong shape', () => {
    const soon = new Date(Date.now() + 60_000).toISOString()
    const bad: unknown[] = [
      null,
      42,
      'a string',
      {},
      { token: 'tok', expiresAt: soon }, // no user
      { user: ADA, expiresAt: soon }, // no token
      { user: ADA, token: 'tok' }, // no expiresAt
      { user: { id: 'one' }, token: 'tok', expiresAt: soon }, // ill-typed user
      { user: ADA, token: 7, expiresAt: soon }, // ill-typed token
    ]
    for (const value of bad) {
      localStorage.setItem(sessionKey(VPS), JSON.stringify(value))
      expect(loadSession(VPS)).toBeNull()
    }
  })

  it('drops an EXPIRED stored session and removes its key', () => {
    const stale: StoredSession = {
      user: ADA,
      token: 'stale',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    localStorage.setItem(sessionKey(VPS), JSON.stringify(stale))

    expect(loadSession(VPS)).toBeNull()
    expect(localStorage.getItem(sessionKey(VPS))).toBeNull()
  })
})

describe('isSessionExpired', () => {
  const at = (ms: number): StoredSession => ({
    user: ADA,
    token: 'tok',
    expiresAt: new Date(ms).toISOString(),
  })

  it('is false strictly before the boundary and true at or after it', () => {
    const boundary = Date.parse('2026-09-23T12:00:00.000Z')
    expect(isSessionExpired(at(boundary), boundary - 1)).toBe(false)
    expect(isSessionExpired(at(boundary), boundary)).toBe(true)
    expect(isSessionExpired(at(boundary), boundary + 1)).toBe(true)
  })

  it('fails CLOSED for an unparseable expiry', () => {
    expect(isSessionExpired({ user: ADA, token: 'tok', expiresAt: 'whenever' })).toBe(true)
    expect(isSessionExpired({ user: ADA, token: 'tok', expiresAt: '' })).toBe(true)
  })

  it('defaults to Date.now() when no clock is passed', () => {
    expect(isSessionExpired(live(ADA, 'tok'))).toBe(false)
    expect(
      isSessionExpired({
        user: ADA,
        token: 'tok',
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    ).toBe(true)
  })
})

describe('authHeaders', () => {
  it('emits an Authorization bearer header for a live session', () => {
    saveSession(VPS, live(ADA, 'vps-token'))
    expect(authHeaders(VPS)).toEqual({ Authorization: 'Bearer vps-token' })
  })

  it('emits nothing when that origin has no session', () => {
    saveSession(LOCAL, live(ADA, 'local-token'))
    expect(authHeaders(VPS)).toEqual({})
  })

  it('emits nothing for an expired session', () => {
    localStorage.setItem(
      sessionKey(VPS),
      JSON.stringify({
        user: ADA,
        token: 'stale',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    )
    expect(authHeaders(VPS)).toEqual({})
  })
})

describe('loginToOrigins (decision D1 — one password entry, N origins)', () => {
  it('stores a session for EACH of two distinct origins from one submit', async () => {
    const post = vi.fn<LoginPost>(async (origin) =>
      response(live(ADA, origin === VPS ? 'vps-token' : 'local-token')),
    )

    const results = await loginToOrigins([LOCAL, VPS], 'ada', 'hunter22', post)

    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenCalledWith(LOCAL, { username: 'ada', password: 'hunter22' })
    expect(post).toHaveBeenCalledWith(VPS, { username: 'ada', password: 'hunter22' })
    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(loadSession(LOCAL)?.token).toBe('local-token')
    expect(loadSession(VPS)?.token).toBe('vps-token')
  })

  it('DEDUPES origins so the shared-origin VPS case issues exactly ONE request', async () => {
    const post = vi.fn<LoginPost>(async () => response(live(ADA, 'one-token')))

    const results = await loginToOrigins(
      [VPS, 'http://<vps-ip>:4500/', 'HTTP://<vps-ip>:4500'],
      'ada',
      'hunter22',
      post,
    )

    expect(post).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
    expect(results[0].origin).toBe(VPS)
    expect(loadSession(VPS)?.token).toBe('one-token')
  })

  it('stores the succeeding origin even when another origin fails, and names the failure', async () => {
    const post = vi.fn<LoginPost>(async (origin) => {
      if (origin === VPS) throw new Error('Failed to fetch')
      return response(live(ADA, 'local-token'))
    })

    const results = await loginToOrigins([LOCAL, VPS], 'ada', 'hunter22', post)

    const local = results.find((r) => r.origin === LOCAL)
    const vps = results.find((r) => r.origin === VPS)
    expect(local?.ok).toBe(true)
    expect(local?.session?.token).toBe('local-token')
    expect(vps?.ok).toBe(false)
    expect(vps?.error).toBe('Failed to fetch')

    // The reachable origin's session survives the other's failure.
    expect(loadSession(LOCAL)?.token).toBe('local-token')
    expect(loadSession(VPS)).toBeNull()
  })

  it('reports a non-Error rejection without throwing', async () => {
    const post = vi.fn<LoginPost>(async () => {
      throw 'nope'
    })
    const results = await loginToOrigins([VPS], 'ada', 'hunter22', post)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toBe('nope')
  })

  it('treats a malformed login response as a failure rather than storing junk', async () => {
    const post = vi.fn<LoginPost>(
      async () => ({ user: ADA, token: '' }) as unknown as LoginResponse,
    )
    const results = await loginToOrigins([VPS], 'ada', 'hunter22', post)
    expect(results[0].ok).toBe(false)
    expect(loadSession(VPS)).toBeNull()
  })
})
