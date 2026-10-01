import crypto from 'node:crypto'

// Password hashing for the app's own user accounts, isolated in this one module
// on purpose: it is the swap seam for D3 of the login plan. The agreed algorithm
// was argon2id, but every argon2 binding for Node is a node-gyp native addon,
// and the Tauri sidecar bundler would have to vendor and ABI-match a second
// prebuilt `.node` for every target — a new way for the shipped `.app` to fail
// at runtime. `node:crypto`'s scrypt is in the standard library, is memory-hard,
// and is an OWASP-acceptable password hash.
//
// The stored string carries its algorithm and parameters as a version prefix
// (`scrypt$N$r$p$salt$key`), so moving to argon2id later is a one-file change:
// `verifyPassword` can branch on the prefix and keep verifying old rows while
// `hashPassword` starts writing the new one.
//
// Both functions are SYNCHRONOUS by choice. Hashing costs ~100ms, but login is a
// rare, throttled path (and account provisioning is a CLI one-shot), so blocking
// the loop briefly there is cheaper than the complexity of an async seam — and
// the cost is the point of a password hash.

/** scrypt cost parameter (2**15). 128 * N * r = 32 MiB of working memory. */
export const SCRYPT_N = 32768
/** scrypt block size. */
export const SCRYPT_R = 8
/** scrypt parallelisation factor. */
export const SCRYPT_P = 1
/** Random salt length, in bytes. */
export const SALT_BYTES = 32
/** Derived key length, in bytes. */
export const KEY_BYTES = 64

/** Version tag written as the first field of every stored hash. */
const PREFIX = 'scrypt'

/**
 * `crypto.scryptSync` caps working memory at 32 MiB by default, and N=32768 with
 * r=8 needs exactly 128 * N * r = 32 MiB *plus* allocator overhead — so the call
 * throws `memory limit exceeded` unless maxmem is raised. Doubling the required
 * size is the documented headroom.
 */
function maxmemFor(n: number, r: number): number {
  return 128 * n * r * 2
}

/**
 * Hash a password with a fresh random salt. Returns the full self-describing
 * stored string: `scrypt$<N>$<r>$<p>$<salt-base64>$<key-base64>`. Two calls with
 * the same password always differ — the salt is random per call.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES)
  const key = crypto.scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  })
  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

/** Parse a `$`-separated parameter field, rejecting anything non-numeric. */
function parseParam(field: string): number | null {
  if (!/^\d+$/.test(field)) return null
  const value = Number(field)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Verify a password against a stored hash. NEVER throws: a malformed, truncated,
 * wrongly-prefixed, non-numeric-parameter or undecodable string is simply `false`.
 *
 * The N/r/p used for the re-derivation are the ones PARSED OUT OF `stored`, not
 * the current constants, so raising the cost parameters later does not lock
 * existing users out of their accounts. The comparison is `timingSafeEqual`,
 * guarded by an explicit length check first (it throws on a length mismatch).
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const fields = stored.split('$')
    if (fields.length !== 6) return false
    const [prefix, nField, rField, pField, saltB64, keyB64] = fields
    if (prefix !== PREFIX) return false

    const n = parseParam(nField)
    const r = parseParam(rField)
    const p = parseParam(pField)
    if (n === null || r === null || p === null) return false
    // A corrupted row must not be able to ask for an unbounded allocation.
    if (128 * n * r > 1024 * 1024 * 1024) return false

    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(keyB64, 'base64')
    if (salt.length === 0 || expected.length === 0) return false

    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: maxmemFor(n, r),
    })
    if (actual.length !== expected.length) return false
    return crypto.timingSafeEqual(actual, expected)
  } catch {
    // Unparseable/undecodable stored hash, or scrypt rejecting the parsed
    // parameters — a failed verification, never an exception at the call site.
    return false
  }
}
