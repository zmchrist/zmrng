// Origin-keyed session store for the username/password login that gates the
// Knowledge Base and Team Chat surfaces. Pure and React-free; the only ambient
// dependency is localStorage, mirroring the other client-only stores
// (`opacity.ts`, `themes.ts`) — no server state, no context, no hook.
//
// WHY ORIGIN-KEYED. A session is necessarily issued by ONE server: two servers
// mean two databases, two `sessions` tables, and a token from one is
// meaningless to the other. The desktop app talks to two — the local sidecar
// serves the Knowledge Base same-origin, while Team Chat talks to the VPS at
// `teamConfig.WORKSPACE_URL` — so the client must hold one session PER ORIGIN
// rather than a single global "logged in" flag. Storing them under one key
// would let whichever surface authenticated last silently clobber the other's
// token.
//
// WHY THE OPERATOR STILL ONLY TYPES THEIR PASSWORD ONCE (decision D1 of
// `.agents/plans/zmrng-login-auth.md`). `loginToOrigins()` takes the whole set
// of gated origins and submits the SAME credentials to each of them in
// parallel from one form submission, storing each result independently. When
// the two origins coincide — a teammate browsing the VPS directly, where the
// KB and Team Chat are the same server — the list dedupes to one entry and one
// login trivially covers both surfaces. When they differ, both sessions are
// established by that single submit. Per-origin failures are reported
// individually so an unreachable VPS never blocks the local login.
//
// Say plainly what that means: the password is POSTed to EACH gated origin.
// That is not new exposure — it is exactly what logging into each server
// separately would do, with one fewer password entry — but it is precisely why
// the origin list is a fixed, code-controlled set (the local origin plus
// `WORKSPACE_URL`) and must NEVER be anything a page, a redirect, or any other
// untrusted input can influence.
//
// This is not single-sign-on in the cryptographic sense: the two servers do not
// trust each other, and an account must be provisioned on each (`create-user`).

import type { LoginRequest, LoginResponse, PublicUser } from './types'

/** localStorage key prefix; the normalized origin is appended verbatim. */
export const SESSION_KEY_PREFIX = 'zmrng-session:'

/** What the client keeps for one origin: who you are there, and the bearer token. */
export interface StoredSession {
  user: PublicUser
  token: string
  expiresAt: string
}

/**
 * The localStorage key for an origin. Normalizes by trimming, lowercasing and
 * stripping trailing slashes so `http://host:4500/` and `HTTP://host:4500`
 * resolve to ONE session — that is what lets two surfaces pointed at the same
 * server share a single login. The empty (same-origin) case is keyed `local`
 * so it never collides with a real origin string.
 */
export function sessionKey(origin: string): string {
  const normalized = origin.trim().toLowerCase().replace(/\/+$/, '')
  return `${SESSION_KEY_PREFIX}${normalized === '' ? 'local' : normalized}`
}

function isPublicUser(value: unknown): value is PublicUser {
  if (typeof value !== 'object' || value === null) return false
  const u = value as Record<string, unknown>
  return (
    typeof u.id === 'number' &&
    typeof u.username === 'string' &&
    typeof u.displayName === 'string'
  )
}

/**
 * Shape guard for anything claiming to be a stored session — a hand-edited
 * localStorage value, a stale value written by an older build, or a malformed
 * server response. Rejecting here is what keeps `loadSession` total.
 */
function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    isPublicUser(s.user) &&
    typeof s.token === 'string' &&
    s.token !== '' &&
    typeof s.expiresAt === 'string' &&
    s.expiresAt !== ''
  )
}

/**
 * True once the session's window has closed. Fails CLOSED: an unparseable
 * `expiresAt` counts as expired rather than as "never expires", so a corrupt
 * value re-prompts for a login instead of sending a dead token forever.
 */
export function isSessionExpired(session: StoredSession, nowMs: number = Date.now()): boolean {
  const expiry = Date.parse(session.expiresAt)
  if (Number.isNaN(expiry)) return true
  return nowMs >= expiry
}

/**
 * The live session for an origin, or null. Total by design: an absent key,
 * non-JSON garbage, JSON of the wrong shape, and an unavailable localStorage
 * all yield null rather than throwing. An EXPIRED session also yields null and
 * is evicted, so the caller re-prompts instead of retrying a dead token.
 */
export function loadSession(origin: string): StoredSession | null {
  const key = sessionKey(origin)
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return null // localStorage unavailable (private mode, quota)
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isStoredSession(parsed)) return null

  if (isSessionExpired(parsed)) {
    clearSession(origin)
    return null
  }
  return parsed
}

export function saveSession(origin: string, session: StoredSession): void {
  try {
    localStorage.setItem(sessionKey(origin), JSON.stringify(session))
  } catch {
    // localStorage unavailable — the session just won't survive a reload.
  }
}

/** Forget one origin's session. Scoped: every other origin stays logged in. */
export function clearSession(origin: string): void {
  try {
    localStorage.removeItem(sessionKey(origin))
  } catch {
    // nothing to do
  }
}

/**
 * The `Authorization` header for an origin, or `{}` when that origin has no
 * live session. Same-origin requests ride the httpOnly `zmrng_session` cookie
 * and do not need this; the cross-origin desktop→VPS path does, because a
 * `SameSite=Strict` cookie can never make that trip (D2).
 */
export function authHeaders(origin: string): Record<string, string> {
  const session = loadSession(origin)
  return session ? { Authorization: `Bearer ${session.token}` } : {}
}

/** Per-origin outcome of one multi-origin login submit. */
export interface OriginLoginResult {
  origin: string
  ok: boolean
  session?: StoredSession
  error?: string
}

/**
 * The injected network call — one `POST <origin>/api/auth/login`. Injected so
 * this module stays testable without `fetch` and without a network.
 */
export type LoginPost = (origin: string, credentials: LoginRequest) => Promise<LoginResponse>

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Submit ONE set of credentials to every gated origin, in parallel, from a
 * single form submission (D1).
 *
 * Origins are deduped by their normalized `sessionKey`, so the VPS deployment —
 * where both gated surfaces share one origin — issues exactly one request. Each
 * success is stored under its own key; each failure is reported with its
 * message and leaves the other origins untouched, so an unreachable VPS never
 * costs the operator their local session.
 *
 * Note that this POSTs the password to each origin in `origins`. The list must
 * therefore be a fixed, code-controlled set — never anything a page or a
 * redirect can influence.
 */
export async function loginToOrigins(
  origins: readonly string[],
  username: string,
  password: string,
  post: LoginPost,
): Promise<OriginLoginResult[]> {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const origin of origins) {
    const key = sessionKey(origin)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(origin)
  }

  const credentials: LoginRequest = { username, password }

  return Promise.all(
    unique.map(async (origin): Promise<OriginLoginResult> => {
      try {
        const res = await post(origin, credentials)
        const session: unknown = {
          user: res?.user,
          token: res?.token,
          expiresAt: res?.expiresAt,
        }
        if (!isStoredSession(session)) {
          return { origin, ok: false, error: 'malformed login response' }
        }
        saveSession(origin, session)
        return { origin, ok: true, session }
      } catch (err) {
        return { origin, ok: false, error: errMsg(err) }
      }
    }),
  )
}
