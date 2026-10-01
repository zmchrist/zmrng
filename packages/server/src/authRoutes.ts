import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  AuthService,
  GENERIC_LOGIN_ERROR,
  LoginThrottle,
  bearerToken,
  clearCookie,
  isProtectedPath,
  parseCookieHeader,
  sessionCookie,
} from './auth.js'
import {
  MAX_PASSWORD_LEN,
  MAX_USERNAME_LEN,
  SESSION_COOKIE_NAME,
} from './types.js'
import type { AuthState, LoginResponse, PublicUser } from './types.js'

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The caller's authenticated user, resolved once per request by the
     * `onRequest` hook `registerAuth` installs. `undefined` on an
     * unauthenticated request — which only reaches a handler at all when the
     * route is ungated, since a gated path is answered 401 by the hook itself.
     */
    authUser?: PublicUser
  }
}

/** What `registerAuth` needs from its host. */
export interface AuthRouteDeps {
  auth: AuthService
  /**
   * Force the `Secure` cookie attribute even on a plain-http request (a
   * TLS-terminating proxy in front). The cookie is ALSO marked secure whenever
   * the request itself arrived over HTTPS — see `sessionCookie` for why this is
   * never unconditional.
   */
  secureCookies: boolean
  /** Session lifetime, used for the cookie's `Max-Age`. */
  sessionTtlMs?: number
  /** Injectable for tests that need to drive the lockout window directly. */
  throttle?: LoginThrottle
}

/** Reply body for every rejection this module produces. */
interface ErrorBody {
  error: string
}

/** Is this request's transport HTTPS (so the cookie may carry `Secure`)? */
function isHttps(req: FastifyRequest): boolean {
  return req.protocol === 'https'
}

/** The session token a request presents, bearer header first, then cookie. */
function requestToken(req: FastifyRequest): string | undefined {
  return (
    bearerToken(req.headers.authorization) ??
    parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME]
  )
}

/**
 * Install the login gate and the three `/api/auth/*` routes onto `app`.
 *
 * This is a PLAIN FUNCTION, not a `fastify-plugin`-wrapped plugin, and
 * deliberately so: an encapsulated plugin's `onRequest` hook only covers routes
 * declared inside that plugin, which would leave every KB and channel route in
 * `index.ts` ungated. Called directly on the instance, the hook applies to the
 * whole server.
 *
 * It lives in its own module so the gate is INTEGRATION-testable: `index.ts`
 * opens the real database, spawns managers and top-level-`await`s at import
 * time, so a test that imported it would boot a whole server. `registerAuth`
 * can instead be attached to a bare `Fastify()` over a temp-file DB and driven
 * with `app.inject()` — no port, no network, so the repo's hermetic-test rule
 * holds.
 *
 * Register it AFTER the CORS hook: an `OPTIONS` preflight must be answered
 * before the gate sees it (the gate skips `OPTIONS` too, belt-and-braces —
 * a browser never sends credentials on a preflight, so gating one would break
 * every cross-origin call).
 */
export function registerAuth(app: FastifyInstance, deps: AuthRouteDeps): void {
  const throttle = deps.throttle ?? new LoginThrottle()
  const { auth } = deps
  const secureFor = (req: FastifyRequest): boolean => deps.secureCookies || isHttps(req)

  app.decorateRequest('authUser', undefined)

  // One session resolution per request: attach the user when there is one, and
  // answer 401 when a GATED path has none. Ungated paths fall through either
  // way — the Workspace orchestrator surface stays fully open.
  //
  // The gate consults BOTH the raw target and the route pattern Fastify matched.
  // The route pattern is the authoritative one — whatever a raw target spells,
  // if the router resolved it to `/api/spaces/:id/tree` it is a KB read — while
  // the raw-URL check still covers a request that matches NO route, so a 404
  // under a gated prefix is refused rather than leaking that the page is absent.
  app.addHook('onRequest', (req, reply, done) => {
    if (req.method === 'OPTIONS') {
      done()
      return
    }
    const user = auth.resolve(req.headers.authorization, req.headers.cookie)
    if (user) req.authUser = user
    const routeUrl = req.routeOptions.url
    const gated =
      isProtectedPath(req.url) || (routeUrl !== undefined && isProtectedPath(routeUrl))
    if (!user && gated) {
      void reply.code(401).send({ error: 'authentication required' } satisfies ErrorBody)
      return
    }
    done()
  })

  /**
   * Exchange credentials for a session. Answers with BOTH a `Set-Cookie` (the
   * same-origin transport) and the raw token in the body (the cross-origin
   * bearer transport) — see D2. A failure never says which half was wrong.
   */
  app.post('/api/auth/login', (req, reply): LoginResponse | undefined => {
    const body = req.body as { username?: unknown; password?: unknown } | undefined
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!username || !password) {
      void reply.code(400).send({ error: 'username and password are required' } satisfies ErrorBody)
      return undefined
    }
    if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) {
      void reply.code(400).send({ error: 'username or password too long' } satisfies ErrorBody)
      return undefined
    }
    const ip = req.ip
    if (throttle.locked(username, ip)) {
      const retryAfter = Math.ceil(throttle.retryAfterMs(username, ip) / 1000)
      void reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({ error: 'too many failed login attempts — try again later' } satisfies ErrorBody)
      return undefined
    }
    const result = auth.login(username, password)
    if (!result) {
      throttle.fail(username, ip)
      // No `Set-Cookie` on a failure — a rejected attempt must leave the
      // caller's credential state exactly as it found it.
      void reply.code(401).send({ error: GENERIC_LOGIN_ERROR } satisfies ErrorBody)
      return undefined
    }
    throttle.reset(username, ip)
    void reply.header(
      'set-cookie',
      sessionCookie(result.token, {
        secure: secureFor(req),
        maxAgeMs: deps.sessionTtlMs,
      }),
    )
    app.log.info({ username: result.user.username }, 'login succeeded')
    return result
  })

  /**
   * Revoke this caller's session and expire the cookie. Gated, so an
   * unauthenticated call is already a 401 by the time it gets here.
   */
  app.post('/api/auth/logout', (req, reply): { ok: true } => {
    auth.logout(requestToken(req))
    void reply.header('set-cookie', clearCookie({ secure: secureFor(req) }))
    return { ok: true }
  })

  /** Who the caller is on THIS origin. Gated, so `authUser` is always set. */
  app.get('/api/auth/me', (req, reply): AuthState | undefined => {
    const user = req.authUser
    if (!user) {
      void reply.code(401).send({ error: 'authentication required' } satisfies ErrorBody)
      return undefined
    }
    return { user }
  })
}

/**
 * The authenticated user for a handler on a GATED route, or `undefined` after
 * answering 401. The gate hook already rejects an unauthenticated caller, so
 * the `undefined` branch is defence in depth — it exists so handlers never need
 * a non-null assertion to reach the identity they must attribute writes to.
 */
export function requireUser(req: FastifyRequest, reply: FastifyReply): PublicUser | undefined {
  const user = req.authUser
  if (!user) {
    void reply.code(401).send({ error: 'authentication required' } satisfies ErrorBody)
    return undefined
  }
  return user
}
