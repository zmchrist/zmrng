# Code review — zmrng login (KB + Team Chat)

- **Date:** 2026-09-23
- **Plan:** `.agents/plans/zmrng-login-auth.md`
- **Branch:** `feat/zmrng/zmrng-login-c1d32e9e`
- **Verdict:** **APPROVE** — no blocking and no important issues.

## Scope reviewed

The whole feature: `password.ts`, `session.ts`, `auth.ts`, `authRoutes.ts`,
`kbRoutes.ts`, `cli/createUser.ts`, the `db.ts` schema and migration, the
`/ws/workspace` socket authentication in `index.ts`, `workspace.ts`'s frame parsing and
managers, and the web side (`auth.ts`, `LoginPane.tsx`, `api.ts`, `App.tsx`,
`KbView.tsx`, `TeamView.tsx`) plus every test file added or rewritten.

## Security properties verified directly

- The raw session token is never persisted or logged — only its sha256. The one log line
  that touches a token records a boolean (`bearer: msg.token !== undefined`), not a value.
- `verifyPassword` fails closed on every malformed input (wrong field count, unknown
  prefix, non-numeric parameters, bad base64, zero-length salt/key) and never throws. It
  re-derives using the parameters parsed from the stored hash, so an old-parameter hash
  keeps verifying.
- Login is not a username oracle: an unknown username runs a full scrypt verify against a
  dummy hash, and both failure modes return the same `GENERIC_LOGIN_ERROR`.
- The throttle locks after 5 failures per `(username, IP)` within 15 minutes and is keyed
  on the pair, not on either half alone.
- The session cookie is always `HttpOnly; SameSite=Strict; Path=/`, and `Secure` is
  conditional on HTTPS or `ZMRNG_SECURE_COOKIES=1` — never unconditional, since a browser
  silently drops a `Secure` cookie on the VPS's plain-http origin.
- No route or socket write is reachable without a session: the gate consults both the raw
  URL and the route Fastify matched, and an unrouted path under a gated prefix still 401s.
- Identity cannot be asserted by a client anywhere. REST writes take the user from
  `requireUser`; socket writes take it from the authenticated session; and
  `parseWorkspaceClientMsg` *rejects* a `message`/`react`/`page.edit` frame that still
  carries an `author`/`handle` rather than silently ignoring the field.

## Findings

### 1. `page_revisions.user_id` omitted — deviation from the plan, judged an improvement

The plan called for a `user_id` column on both `members` and `page_revisions`; the
implementation added it only to `members`. A revision snapshots the page's **prior** body,
whose author is the free-text `pages.updated_by` string with no user id behind it, so the
column could only ever be null — and the additive-only migration rule means a column added
today can never be removed. The omission is documented in `db.ts` and pinned by an
assertion in `db.test.ts`. **Accepted as a justified improvement on the plan.**

### 2. `kbRoutes.ts` doc comment overstated the pattern — fixed

The module comment claimed "every write route here calls `requireUser`", but the space and
folder routes rely on the `onRequest` gate alone. Not a security gap (the gate covers every
route in the module), but an inaccurate comment. **Corrected** to state what is true: every
route is gated by the hook, and the routes that additionally call `requireUser` are the ones
that need the *identity* for attribution.

### 3. The display-name length bound was orphaned by the change — fixed

Found outside the review, during a separate pass. Before login, `parseWorkspaceClientMsg`
rejected a `hello` whose trimmed display name exceeded `MAX_DISPLAY_NAME_LEN`, which kept an
unbounded handle out of `members` (where it would ride every roster snapshot). `hello` no
longer carries a name at all, so **nothing** enforced that bound afterwards, and the CLI had
become the only place a display name enters the system. **Fixed** in `cli/createUser.ts`
with tests on both the over-cap and exactly-at-cap cases, and the two now-false `types.ts`
doc comments corrected in both mirrors.

### 4. Re-gating on an expired session — fixed during implementation

An `unauthorized` socket frame (or a failed logout) that only called `onLogout()` did not
actually re-gate: the stored session still looked live by its own clock, so the parent
re-read it and re-rendered the same view behind a dead socket. Both gated views now clear
that origin's session first. Pinned by a test.

## Test quality

The tests discriminate rather than merely pass. Two pieces of evidence:

- The KB attribution suite was validated by deliberate regression — trusting `body.author`
  on create and restore, and deleting the `page.delete` changelog write, each produced the
  expected failures.
- That same pass caught a **vacuous assertion**: the rename-detail test used overlapping
  titles (`Runbook` → `Runbook v2`), so a regression dropping the old title from the detail
  string still passed. Rewritten with non-overlapping titles and index ordering.

## Validation at review time

`npm run typecheck`, `npm run lint`, `npm test` (27 files / 643 server, 58 files / 605 web)
and `npm run build` all pass. `npm run desktop:build` is **not runnable on this host** (no
Rust toolchain; `bundle-sidecar.mjs` targets macOS only) and must be run on the macOS host
before the change ships in the `.app`.
