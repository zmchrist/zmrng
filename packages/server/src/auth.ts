import { randomBytes } from 'node:crypto'
import { SESSION_COOKIE_NAME } from './types.js'
import type { PublicUser, User } from './types.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  SESSION_TTL_MS,
  expiryFrom,
  hashToken,
  isExpired,
  newToken,
  shouldRenew,
} from './session.js'
import type { Db } from './db.js'

/**
 * The user/session table surface `AuthService` needs, kept narrow so tests can
 * drive it with a temp-file `Db` (or a hand-rolled double) rather than a booted
 * server — the same seam `WorkspaceManager`/`ChannelManager` use.
 */
export type AuthStore = Pick<
  Db,
  | 'getUserByUsername'
  | 'getUserById'
  | 'createSession'
  | 'getSession'
  | 'touchSession'
  | 'deleteSession'
  | 'deleteExpiredSessions'
>

/** Failures allowed per `(username, IP)` before the pair is locked out. */
export const LOGIN_FAILURE_LIMIT = 5

/** Fixed window the failure count is measured over (15 minutes). */
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * The ONE message a failed login ever returns, whatever went wrong. A wrong
 * password and an unknown username must be indistinguishable or the endpoint
 * becomes a username oracle.
 */
export const GENERIC_LOGIN_ERROR = 'invalid username or password'

/** Every REST prefix that requires an authenticated session.
 *
 * The Knowledge Base (`/api/spaces`, `/api/pages`, `/api/folders`,
 * `/api/page-revisions`) and Team Chat (`/api/channels`) surfaces are gated;
 * the Workspace task orchestrator is deliberately NOT — gating it would put a
 * login wall in front of the operator's own tooling (alternative 4, rejected).
 * `/api/auth/login` must stay open for obvious reasons, while `/api/auth/me`
 * and `/api/auth/logout` are gated because they only mean anything for a
 * caller that already holds a session.
 */
export const PROTECTED_PREFIXES: readonly string[] = [
  '/api/spaces',
  '/api/pages',
  '/api/folders',
  '/api/page-revisions',
  '/api/channels',
  '/api/auth/me',
  '/api/auth/logout',
]

/**
 * Does this request path sit behind the login gate? Matches a prefix exactly or
 * as a path segment boundary (`/api/pages/7` yes, `/api/pages-public` no), and
 * ignores any query string. The near-miss half matters as much as the hit half:
 * `/api/tasks`, `/api/config`, `/api/preflight`, `/api/settings`,
 * `/api/auth/login` and the static UI must all stay open.
 */
export function isProtectedPath(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  return PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/** Strip a `User` down to what a client may see — never the password hash. */
export function publicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, displayName: user.displayName }
}

/**
 * Parse a raw `Cookie` request header into a name→value map. Tolerant by
 * design: an absent, blank or malformed header yields an empty map rather than
 * throwing, and a pair with no `=` is skipped. Values are `decodeURIComponent`d
 * where that succeeds (a session token is base64url, so this is belt-and-braces
 * for hand-set cookies).
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    const raw = part.slice(eq + 1).trim()
    let value = raw
    try {
      value = decodeURIComponent(raw)
    } catch {
      // A malformed percent-escape keeps the raw value rather than failing.
    }
    out[name] = value
  }
  return out
}

/** Pull the token out of an `Authorization: Bearer <token>` header (case-insensitive). */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : undefined
}

/**
 * Build the `Set-Cookie` value for a freshly-issued session.
 *
 * `Secure` is conditional ON PURPOSE (D2): browsers silently DROP a `Secure`
 * cookie on a plain-http origin, and the VPS workspace is plain http on the
 * tailnet — an unconditional flag would break login there entirely. It is set
 * when the request itself arrived over HTTPS, or when `ZMRNG_SECURE_COOKIES=1`
 * marks a TLS-terminating proxy in front. `SameSite=Strict` means a hostile
 * site can neither read the cookie nor ride it; the cross-origin desktop→VPS
 * path uses a bearer header instead, so no cookie ever has to travel cross-site.
 */
export function sessionCookie(
  token: string,
  opts: { secure: boolean; maxAgeMs?: number },
): string {
  const maxAge = Math.floor((opts.maxAgeMs ?? SESSION_TTL_MS) / 1000)
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ]
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/** The `Set-Cookie` value that expires the session cookie (logout). */
export function clearCookie(opts: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Fixed-window failure counter keyed on `(username, IP)`. In memory only — a
 * restart clears it, which is an accepted trade (the point is to blunt online
 * guessing, not to be a durable ban list). Pure and time-injectable so the
 * window is testable without timers.
 */
export class LoginThrottle {
  private hits = new Map<string, { count: number; firstAt: number }>()

  constructor(
    private readonly limit: number = LOGIN_FAILURE_LIMIT,
    private readonly windowMs: number = LOGIN_FAILURE_WINDOW_MS,
  ) {}

  private key(username: string, ip: string): string {
    return `${username}\u0000${ip}`
  }

  /** Drop the entry if its window has elapsed; returns the live entry, if any. */
  private live(
    username: string,
    ip: string,
    now: number,
  ): { count: number; firstAt: number } | undefined {
    const key = this.key(username, ip)
    const entry = this.hits.get(key)
    if (!entry) return undefined
    if (now - entry.firstAt >= this.windowMs) {
      this.hits.delete(key)
      return undefined
    }
    return entry
  }

  /** Is this `(username, IP)` currently locked out? */
  locked(username: string, ip: string, now: number = Date.now()): boolean {
    const entry = this.live(username, ip, now)
    return entry !== undefined && entry.count >= this.limit
  }

  /** Record one failed attempt, starting a fresh window when none is live. */
  fail(username: string, ip: string, now: number = Date.now()): void {
    const key = this.key(username, ip)
    const entry = this.live(username, ip, now)
    if (entry) entry.count += 1
    else this.hits.set(key, { count: 1, firstAt: now })
  }

  /** Forget this pair's failures (called on a successful login). */
  reset(username: string, ip: string): void {
    this.hits.delete(this.key(username, ip))
  }

  /** Milliseconds until the current window expires (0 when not locked). */
  retryAfterMs(username: string, ip: string, now: number = Date.now()): number {
    const entry = this.live(username, ip, now)
    if (!entry || entry.count < this.limit) return 0
    return Math.max(0, entry.firstAt + this.windowMs - now)
  }
}

/**
 * A stored hash verified against when the username is unknown, so a miss costs
 * the same scrypt work as a hit and the response time does not leak account
 * existence. Derived once, lazily, from random bytes — no password matches it.
 */
let dummyHash: string | undefined
function dummyPasswordHash(): string {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'))
  return dummyHash
}

/**
 * Issues, resolves and revokes login sessions. Sessions are SERVER-SIDE by
 * decision (not JWTs): logout and expiry are a row delete rather than a
 * revocation list bolted onto a stateless token. Only the sha256 of a token is
 * ever stored, so the table is useless to an attacker who reads it.
 *
 * Resolution order is `Authorization: Bearer` first, then the `zmrng_session`
 * cookie. Same-origin browsing rides the httpOnly cookie and never exposes the
 * token to JS; the cross-origin desktop→VPS Team path has no cookie it can
 * send (no TLS, `SameSite=Strict`) and presents the bearer header instead (D2).
 */
export class AuthService {
  constructor(
    private readonly db: AuthStore,
    private readonly ttlMs: number = SESSION_TTL_MS,
  ) {}

  /**
   * Verify credentials and mint a session. Returns `undefined` for BOTH a wrong
   * password and an unknown username — the caller reports `GENERIC_LOGIN_ERROR`
   * either way. An unknown username still runs a full scrypt verify against a
   * dummy hash so the two paths cost the same.
   */
  login(
    username: string,
    password: string,
    now: string = new Date().toISOString(),
  ): { user: PublicUser; token: string; expiresAt: string } | undefined {
    const user = this.db.getUserByUsername(username)
    if (!user) {
      verifyPassword(password, dummyPasswordHash())
      return undefined
    }
    if (!verifyPassword(password, user.passwordHash)) return undefined
    const token = newToken()
    const expiresAt = expiryFrom(now, this.ttlMs)
    this.db.createSession(user.id, hashToken(token), now, expiresAt)
    return { user: publicUser(user), token, expiresAt }
  }

  /** Revoke one session by its raw token (idempotent — an unknown token is a no-op). */
  logout(token: string | undefined): void {
    if (!token) return
    this.db.deleteSession(hashToken(token))
  }

  /**
   * Resolve a request's credentials to a user, preferring the bearer header
   * over the cookie. An unknown, tampered, deleted or expired token yields
   * `undefined` (and an expired row is swept as we notice it). An ACTIVE
   * session slides: once less than the renewal window remains, its expiry is
   * pushed out — a fresh session writes nothing, so this is not a DB write per
   * request.
   */
  resolve(
    authorization: string | undefined,
    cookieHeader: string | undefined,
    now: string = new Date().toISOString(),
  ): PublicUser | undefined {
    const token =
      bearerToken(authorization) ?? parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME]
    return this.resolveToken(token, now)
  }

  /**
   * The workspace socket's analogue of `resolve`. A same-origin socket carries
   * the session cookie on its HTTP handshake; a cross-origin one cannot, so its
   * `hello` frame carries the bearer token instead — which therefore WINS when
   * both are present (an explicitly-presented credential beats an ambient one).
   */
  resolveSocketIdentity(
    cookieHeader: string | undefined,
    helloToken: string | undefined,
    now: string = new Date().toISOString(),
  ): PublicUser | undefined {
    const token = helloToken ?? parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME]
    return this.resolveToken(token, now)
  }

  /** Delete every expired session row. Returns how many were removed. */
  sweep(now: string = new Date().toISOString()): number {
    return this.db.deleteExpiredSessions(now)
  }

  private resolveToken(token: string | undefined, now: string): PublicUser | undefined {
    if (!token) return undefined
    const session = this.db.getSession(hashToken(token))
    if (!session) return undefined
    if (isExpired(session.expiresAt, now)) {
      this.db.deleteSession(session.tokenHash)
      return undefined
    }
    const user = this.db.getUserById(session.userId)
    if (!user) return undefined
    if (shouldRenew(session.expiresAt, now)) {
      this.db.touchSession(session.id, expiryFrom(now, this.ttlMs))
    }
    return publicUser(user)
  }
}
