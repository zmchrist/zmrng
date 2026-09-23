import crypto from 'node:crypto'

// Pure session-token primitives: minting, hashing, and the expiry/renewal
// policy. Deliberately free of any DB or Fastify dependency so the policy can be
// unit-tested on its own and read in one screen — the persistence and the route
// gate live in db.ts and auth.ts.
//
// The raw token is only ever held by the client (cookie or bearer); the server
// stores its sha256 digest, so a leaked database snapshot does not hand over
// live sessions. sha256 with no salt/stretching is correct here and not a
// password-hashing mistake: the input is 256 bits of CSPRNG output, which has no
// searchable keyspace to protect.

/** 7 days. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Sliding renewal: renew once LESS than 6 days remain (~24h of the window
 * spent), so a fresh session causes no DB write on every request.
 */
export const SESSION_RENEW_BELOW_MS = 6 * 24 * 60 * 60 * 1000

/** Raw token size, in bytes (256 bits of CSPRNG output). */
export const TOKEN_BYTES = 32

/**
 * Mint a new session token: `TOKEN_BYTES` random bytes, base64url-encoded so it
 * is safe to put in a cookie or an `Authorization` header unescaped. This is the
 * only form the client ever sees; it is never stored server-side.
 */
export function newToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url')
}

/** sha256 hex digest of a raw token — the value the `sessions` table stores. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * ISO timestamp `ttlMs` after `nowIso` (default `SESSION_TTL_MS`). An
 * unparseable `nowIso` falls back to the wall clock rather than throwing, so a
 * bad caller shortens nothing and still produces a valid expiry.
 */
export function expiryFrom(nowIso: string, ttlMs: number = SESSION_TTL_MS): string {
  const base = Date.parse(nowIso)
  const from = Number.isNaN(base) ? Date.now() : base
  return new Date(from + ttlMs).toISOString()
}

/**
 * Has the session expired as of `nowIso`? True at the boundary (`now >=
 * expiresAt`), and true for an unparseable timestamp on either side — an
 * undatable session fails closed rather than living forever.
 */
export function isExpired(expiresAtIso: string, nowIso: string): boolean {
  const expiresAt = Date.parse(expiresAtIso)
  const now = Date.parse(nowIso)
  if (Number.isNaN(expiresAt) || Number.isNaN(now)) return true
  return now >= expiresAt
}

/**
 * Should this session's expiry be pushed out on the current request? Only once
 * the remaining lifetime has dropped below `SESSION_RENEW_BELOW_MS` — a session
 * minted moments ago answers `false`, which is what keeps an active client from
 * writing to the `sessions` table on every single request. An already-expired
 * (or undatable) session is never renewed; it is rejected instead.
 */
export function shouldRenew(expiresAtIso: string, nowIso: string): boolean {
  if (isExpired(expiresAtIso, nowIso)) return false
  const remaining = Date.parse(expiresAtIso) - Date.parse(nowIso)
  return remaining < SESSION_RENEW_BELOW_MS
}
