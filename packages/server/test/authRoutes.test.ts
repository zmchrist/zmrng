import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { Db } from '../src/db.js'
import { AuthService } from '../src/auth.js'
import { registerAuth, requireUser } from '../src/authRoutes.js'
import { hashPassword } from '../src/password.js'
import { hashToken, newToken } from '../src/session.js'
import { SESSION_COOKIE_NAME } from '../src/types.js'
import type { LoginResponse } from '../src/types.js'

// The integration layer for the login gate. `index.ts` opens the real DB, spawns
// managers and top-level-`await`s at import time, so importing it here would
// boot a whole server; `registerAuth` is a plain function precisely so it can be
// attached to a bare Fastify over a temp-file DB and driven with `inject()` —
// no port, no network, so the repo's hermetic-test rule holds.

let dir: string
let db: Db
let app: FastifyInstance

const NOW = '2026-09-10T00:00:00.000Z'
const PASSWORD = 'correct horse battery'

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'zmrng-authroutes-'))
  db = new Db(path.join(dir, 'zmrng.db'))
  db.createUser('zc', 'zc', hashPassword(PASSWORD), NOW)

  app = Fastify()
  registerAuth(app, { auth: new AuthService(db), secureCookies: false })
  // Stand-ins for the real server's gated + ungated surfaces. The paths are
  // what matter — `isProtectedPath` keys on the prefix, not on the handler.
  app.get('/api/spaces', (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return undefined
    return { spaces: [], viewer: user.username }
  })
  app.get('/api/tasks', () => ({ tasks: [] }))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Log in over the wire and return the raw token plus the `Set-Cookie` value. */
async function login(
  username = 'zc',
  password = PASSWORD,
): Promise<{ status: number; token?: string; setCookie?: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  const setCookie = res.headers['set-cookie']
  const token =
    res.statusCode === 200 ? (res.json() as LoginResponse).token : undefined
  return {
    status: res.statusCode,
    token,
    setCookie: Array.isArray(setCookie) ? setCookie[0] : setCookie,
  }
}

describe('POST /api/auth/login', () => {
  it('returns the user, a body token AND an httpOnly cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'zc', password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as LoginResponse
    expect(body.user).toEqual({ id: expect.any(Number), username: 'zc', displayName: 'zc' })
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(20)
    expect(typeof body.expiresAt).toBe('string')

    const cookie = res.headers['set-cookie']
    const value = Array.isArray(cookie) ? cookie[0] : cookie
    expect(value).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(value).toContain('HttpOnly')
    expect(value).toContain('SameSite=Strict')
    // Plain http in this test: a Secure cookie would be dropped by a browser.
    expect(value).not.toContain('Secure')
  })

  it('rejects bad credentials with 401 and NO cookie', async () => {
    for (const creds of [
      { username: 'zc', password: 'wrong' },
      { username: 'nobody', password: PASSWORD },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: creds })
      expect(res.statusCode).toBe(401)
      expect(res.headers['set-cookie']).toBeUndefined()
      // Both failures report the SAME message — no username oracle.
      expect((res.json() as { error: string }).error).toBe('invalid username or password')
    }
  })

  it('400s a missing or blank field without counting it as a failed attempt', async () => {
    for (const payload of [{}, { username: 'zc' }, { username: '  ', password: PASSWORD }]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload })
      expect(res.statusCode).toBe(400)
    }
    // Still able to log in: the 400s did not eat the throttle budget.
    expect((await login()).status).toBe(200)
  })

  it('trips the throttle with a 429 after repeated bad passwords', async () => {
    let last = 0
    for (let i = 0; i < 6; i++) last = (await login('zc', 'wrong')).status
    expect(last).toBe(429)
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'zc', password: PASSWORD },
    })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})

describe('the gate', () => {
  it('401s a gated route with no credential', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces' })
    expect(res.statusCode).toBe(401)
  })

  it('200s a gated route with the cookie', async () => {
    const { setCookie } = await login()
    const res = await app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { cookie: setCookie ?? '' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { viewer: string }).viewer).toBe('zc')
  })

  it('200s a gated route with an Authorization bearer header', async () => {
    const { token } = await login()
    const res = await app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { authorization: `Bearer ${token ?? ''}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('401s a garbage, tampered or expired token', async () => {
    const { token } = await login()
    const user = db.getUserByUsername('zc')!
    const lapsed = newToken()
    db.createSession(user.id, hashToken(lapsed), NOW, NOW) // already expired

    for (const header of [
      'Bearer not-a-token',
      `Bearer ${token ?? ''}x`,
      `Bearer ${newToken()}`,
      `Bearer ${lapsed}`,
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/spaces',
        headers: { authorization: header },
      })
      expect(res.statusCode, header).toBe(401)
    }
  })

  // A request under a gated prefix that matches NO route is still refused, so a
  // 401 vs 404 never tells an anonymous caller which pages exist. This also
  // pins that the gate survives an unrouted request at all: it consults the
  // route pattern Fastify matched, which is absent on a 404.
  it('401s an unrouted path under a gated prefix, and 404s it once authenticated', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/spaces/999/no-such-thing' })
    expect(anon.statusCode).toBe(401)
    const { token } = await login()
    const authed = await app.inject({
      method: 'GET',
      url: '/api/spaces/999/no-such-thing',
      headers: { authorization: `Bearer ${token ?? ''}` },
    })
    expect(authed.statusCode).toBe(404)
  })

  // The near-miss half: a gate that blanket-denies is not a gate. The Workspace
  // orchestrator surface must stay usable in every credential state.
  it('leaves an ungated route at 200 throughout', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).statusCode).toBe(200)
    const { token, setCookie } = await login()
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/tasks',
          headers: { authorization: `Bearer ${token ?? ''}` },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/tasks',
          headers: { cookie: setCookie ?? '' },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/tasks',
          headers: { authorization: 'Bearer garbage' },
        })
      ).statusCode,
    ).toBe(200)
  })
})

describe('GET /api/auth/me', () => {
  it('reflects the logged-in user and 401s without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401)
    const { token } = await login()
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token ?? ''}` },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { user: { username: string } }).user.username).toBe('zc')
  })
})

describe('POST /api/auth/logout', () => {
  it('revokes the session for BOTH transports and clears the cookie', async () => {
    const { token, setCookie } = await login()
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token ?? ''}` },
    })
    expect(res.statusCode).toBe(200)
    const cleared = res.headers['set-cookie']
    expect(Array.isArray(cleared) ? cleared[0] : cleared).toContain('Max-Age=0')

    // The same token AND the cookie issued with it are now both dead.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/spaces',
          headers: { authorization: `Bearer ${token ?? ''}` },
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/spaces',
          headers: { cookie: setCookie ?? '' },
        })
      ).statusCode,
    ).toBe(401)
  })

  it('401s an unauthenticated logout (it is itself a gated route)', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(401)
  })
})
