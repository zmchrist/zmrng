import { useId, useState, type FormEvent } from 'react'
import styles from './LoginPane.module.css'
import { isSameOrigin } from '../api'
import { loginToOrigins, type LoginPost, type OriginLoginResult } from '../auth'
import type { LoginRequest, LoginResponse } from '../types'

/**
 * The login form, rendered in place of a gated surface (the Knowledge Base or
 * Team Chat). One component serves both: `label` names the surface being
 * unlocked and `origins` is the fixed, code-controlled set of servers this
 * submit authenticates against.
 *
 * Decision D1 of `.agents/plans/zmrng-login-auth.md`: sessions are per server
 * instance, but the LOGIN is not. A single submit POSTs the same credentials to
 * every gated origin in parallel (`loginToOrigins`), so the operator types
 * their password once whether the two gated surfaces share one origin (a
 * teammate browsing the VPS) or span two (the desktop app: local sidecar for
 * the KB, VPS for Team). Per-origin failures are reported inline instead of
 * failing the whole login — an unreachable VPS must not cost the local session.
 */
interface Props {
  /** The gated origins to authenticate against. `''` means same-origin. */
  origins: readonly string[]
  /** The surface being unlocked, e.g. "Knowledge Base". */
  label: string
  /** Fired once at least one origin authenticated, with every per-origin result. */
  onAuthed: (results: OriginLoginResult[]) => void
  /** Injected for tests; defaults to a real `fetch` against `<origin>/api/auth/login`. */
  post?: LoginPost
}

/** Read the server's own error text, falling back to a generic line. */
async function readError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null) {
      const { error } = body as { error?: unknown }
      if (typeof error === 'string' && error !== '') return error
    }
  } catch {
    // non-JSON body (a proxy error page, an empty 502) — fall through
  }
  if (res.status === 429) return 'Too many attempts. Try again in a few minutes.'
  return 'Login failed.'
}

/**
 * The default network call. `credentials: 'include'` is what lets the SAME-ORIGIN
 * response set the httpOnly `zmrng_session` cookie; the returned body token is
 * what the cross-origin desktop→VPS path stores and sends as a bearer header,
 * since a `SameSite=Strict` cookie can never make that trip (D2).
 *
 * Cross-origin MUST use `'omit'`: the server reflects arbitrary origins and so
 * never sends `access-control-allow-credentials`, which makes the browser
 * discard a credentialed cross-origin response (Safari: "Load failed") even
 * though the server accepted the login. Same rule as `send()` in `api.ts`.
 */
const defaultPost: LoginPost = async (
  origin: string,
  credentials: LoginRequest,
): Promise<LoginResponse> => {
  const res = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: isSameOrigin(origin) ? 'include' : 'omit',
    body: JSON.stringify(credentials),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as LoginResponse
}

/** A blank origin is this app's own server; anything else names itself. */
function originLabel(origin: string): string {
  return origin.trim() === '' ? 'this device' : origin
}

export function LoginPane({ origins, label, onAuthed, post = defaultPost }: Props) {
  const usernameId = useId()
  const passwordId = useId()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gated, setGated] = useState<OriginLoginResult[]>([])

  const canSubmit = username.trim() !== '' && password !== '' && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    setGated([])
    try {
      const results = await loginToOrigins(origins, username.trim(), password, post)
      const failed = results.filter((r) => !r.ok)
      if (failed.length === results.length) {
        // Total failure: surface the server's own message and keep BOTH fields —
        // retyping a username after a mistyped password is a real annoyance.
        setError(failed[0]?.error ?? 'Login failed.')
        return
      }
      // Partial success still authenticates: report which surface stays gated.
      setGated(failed)
      onAuthed(results)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <form
        className={styles.panel}
        onSubmit={submit}
        aria-label={`Log in to ${label}`}
      >
        <div className={styles.head}>
          <span className={styles.eyebrow}>Sign in</span>
          <h2 className={styles.title}>{label}</h2>
          <p className={styles.sub}>
            This surface is private. Accounts are provisioned by the operator —
            there is no signup.
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={usernameId}>
            Username
          </label>
          <input
            id={usernameId}
            className={styles.input}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={passwordId}>
            Password
          </label>
          <input
            id={passwordId}
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
          />
        </div>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {gated.length > 0 && (
          <div className={styles.gated} role="status">
            Signed in, but one server could not be reached — anything it serves
            stays locked:
            <ul className={styles.gatedList}>
              {gated.map((r) => (
                <li key={r.origin} className={styles.gatedItem}>
                  {originLabel(r.origin)} — {r.error ?? 'unavailable'}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button className={styles.submit} type="submit" disabled={!canSubmit} aria-busy={busy}>
          Log in
        </button>

        {busy && (
          <p className={styles.status} aria-live="polite">
            Signing in…
          </p>
        )}

        {origins.length > 1 && (
          <p className={styles.hint}>
            One submit signs you in to all {origins.length} servers this app
            talks to, so you only type your password once.
          </p>
        )}
      </form>
    </div>
  )
}
