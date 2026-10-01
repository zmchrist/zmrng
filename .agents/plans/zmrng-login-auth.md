# zmrng login — username/password auth for the Knowledge Base and Team Chat

## Goal

Gate the **Knowledge Base** and **Team Chat** surfaces behind a username/password
login. The Workspace (task orchestrator) surface stays open. A single login
covers both gated surfaces. The authenticated user replaces Team Chat's
self-asserted display handle end to end, authors every Knowledge Base write, and
feeds a new per-edit changelog.

Accounts are provisioned manually with a CLI script. There is no self-serve
signup, no password-reset flow, and no "one session at a time" rule.

---

## Grill

### What the code actually is (verified by reading it, not assumed)

| Claim | Reality |
|---|---|
| "There is no auth today" | Correct. `AuthBanner.tsx` / `preflight.ts` are about the **`claude` and `gh` CLI** logins, not app users. Nothing else in `packages/server/src` mentions user auth. |
| "KB and Team share an identity" | Partly. Both read one string, `settings.teamHandle`, from the **local** server's `settings` table (`GET/PUT /api/settings`). It is free text, asserted per frame, verified nowhere. |
| "KB already has revisions" | Yes — `page_revisions(page_id, body, author, created_at)`, snapshotted at most once per 30s (`PAGE_REVISION_THROTTLE_MS`). It covers **body edits only**: page create, rename, move and delete leave no trace. |
| "Both surfaces talk to one server" | **No.** This is the finding that shapes the whole plan — see below. |

### Contradiction 1 — Team Chat is cross-origin; the Knowledge Base is not

`packages/web/src/teamConfig.ts` hardcodes `WORKSPACE_URL =
'http://100.92.187.96:4500'`. `TeamView.tsx` opens its socket and all channel
REST against **that VPS origin**. `KbView.tsx` opens `/ws/workspace` and all KB
REST **same-origin** (its own doc comment says "same-origin").

So in the desktop/dev deployment these are two different servers with two
different `zmrng.db` files. A session issued by one is meaningless to the other.
Federating identity across two instances (a shared signing secret, JWT, an
identity server) is a much larger change than this task, and the operator
explicitly chose server-side sessions over JWT.

**Decision D1 — sessions are per server instance; the *login* is not.**

A session is necessarily scoped to the server that issued it — two servers, two
databases, two session tables. But the **operator must still only log in once**,
and that is achievable without federating anything:

- The client keeps an **origin-keyed** session store. When the two origins
  coincide — a teammate browsing the VPS directly, where KB and Team are the same
  server — one login trivially covers both.
- When they differ (the desktop app: local sidecar for KB, VPS for Team), the
  login pane **submits the one set of credentials to every gated origin it knows
  about**, in parallel, from a single form submission. The same username and
  password are provisioned on both servers (the CLI is run on each), so one
  submit establishes both sessions. The user types their password **once**.
  Note plainly what this means: the password is POSTed to **each** gated origin,
  over plain HTTP on the tailnet. That is not new exposure introduced by batching
  — it is exactly what logging into each server separately would do, with one
  fewer password entry — but it is the reason the origin list is a fixed,
  code-controlled set (the local origin plus `WORKSPACE_URL`) and never anything
  a page or a redirect can influence.
- Per-origin results are reported individually: if one origin is unreachable or
  rejects, the other still authenticates and the UI names which surface is still
  gated, rather than failing the whole login.

So the agreed requirement — "they shouldn't have to log in to both separately; if
they log in their status carries over to both pages" — is met in **both**
deployments. What is *not* provided is single-sign-on in the cryptographic sense:
the two servers do not trust each other, and provisioning a user on one does not
create them on the other. That is a deliberate consequence of rejecting
federation (alternative 6), and it is documented in `CLAUDE.md`.

Relocating the KB onto the VPS would collapse the two cases into one at the data
layer, but that moves where the operator's pages live and is **out of scope**.

### Contradiction 2 — `SameSite=Strict` + `Secure` cannot reach the VPS

The clarify phase settled on an `httpOnly; Secure; SameSite=Strict` cookie. Two
problems against the real deployment:

1. A `SameSite=Strict` cookie is **never** sent on a cross-site request, so the
   desktop app's Team connection to the VPS would never carry it.
2. The VPS is plain `http://100.92.187.96:4500`. Browsers **drop** `Secure`
   cookies on non-HTTPS origins (localhost excepted), so an unconditional
   `Secure` flag silently breaks login on the VPS entirely.

**Decision D2 — one session token, two transports.**

- `POST /api/auth/login` sets `zmrng_session=<token>; HttpOnly; SameSite=Strict;
  Path=/; Max-Age=604800` **and** returns the same token in the JSON body.
- `Secure` is added only when the request arrived over HTTPS (`req.protocol`) or
  `ZMRNG_SECURE_COOKIES=1` is set. Never unconditionally.
- Server-side resolution order: `Authorization: Bearer <token>` header, then the
  cookie.
- Same-origin browsing (the VPS case, and the desktop's own KB) rides the
  httpOnly cookie and never exposes the token to JS.
- The cross-origin desktop→VPS Team path stores the returned token in
  `localStorage` and sends it as a bearer header, because no cookie can make that
  trip without TLS.

The bearer path is the weaker of the two (readable by JS). Accepted, and stated
in the PR: the perimeter is Tailscale-only, and the one place the app renders
untrusted content — `kbMarkdown.ts` — HTML-escapes before rendering.

### Contradiction 3 — CORS reflects any origin

`index.ts:169` reflects `req.headers.origin` back as
`access-control-allow-origin`. Its comment justifies this with "there are no
cookies/credentials to protect" — a statement this task would falsify if the
cookie had to travel cross-origin.

Because D2 puts the cross-origin path on a **bearer header** instead of a cookie,
`Access-Control-Allow-Credentials: true` is never needed. The permissive CORS
policy therefore stays exactly as it is, and `SameSite=Strict` means a hostile
site can neither read the cookie nor ride it. The only change is adding
`authorization` to `access-control-allow-headers`.

This is the decisive argument for the bearer fallback over trying to force
cookies cross-origin: it keeps the blast radius at zero.

### Contradiction 4 — argon2 would break the sidecar bundle

Clarify settled on argon2id. `argon2` is a node-gyp native addon.
`packages/desktop/scripts/bundle-sidecar.mjs` keeps a **hand-maintained**
`VENDORED` list of native modules (`better-sqlite3`, `bindings`,
`file-uri-to-path`, `node-pty`) that esbuild cannot inline, copies a matching
official Node binary to keep the ABI aligned, and **throws on any non-macOS
host**. Adding a second gyp-built addon means a new vendored closure, a new
prebuild dependency, and a new way for the shipped `.app` to fail at runtime.

**Decision D3 — `node:crypto` `scrypt` behind a swap seam.** scrypt is in the
Node standard library, is memory-hard, and is listed by OWASP as an acceptable
password-hashing choice alongside argon2id. Parameters: `N=2**15, r=8, p=1`,
32-byte random salt, 64-byte key, stored as
`scrypt$32768$8$1$<salt-b64>$<key-b64>`, compared with `timingSafeEqual`.

This **deviates from the agreed argon2id** and is flagged as such. The mitigation
is that `hashPassword`/`verifyPassword` live alone in
`packages/server/src/password.ts` with a versioned prefix in the stored string,
so moving to argon2id later is a one-file change plus a re-provision — and the
verify path can accept both prefixes if it ever needs to. If the operator would
rather take the bundler cost now, say so and it is a small swap.

### Contradiction 5 — the changelog is half-built and half-wrong

`page_revisions` is already an edit log, but it only records **body saves**, and
only once per 30s. It never sees a page being created, renamed, moved or deleted,
and it cannot outlive its page. Reusing it would ship a changelog with holes.

**Decision D4 — a dedicated additive `kb_changelog` table**, written on create /
rename / move / body-save / delete, recording `user_id`, `username`, `action`,
`detail`, `page_id`, `space_id`, `created_at`. Body-save entries reuse the same
30s throttle so continuous autosave does not spam the feed. `page_revisions` is
untouched and keeps doing its job (restorable snapshots).

### What this breaks

- **The wire protocol changes.** `hello` stops carrying `displayName`;
  `message`, `react` and `page.edit` stop carrying `author`/`handle`. The server
  derives all four from the socket's authenticated session. Any client older than
  this change stops being able to post — acceptable, the operator controls every
  install, and this is precisely the "replace the self-asserted handle" ask. It
  also closes a real spoofing hole: today any client can post as any name.
- **`settings.teamHandle` stops being the identity.** The column and the
  `WorkspaceSettings` field **stay** (the additive-only migration rule forbids
  dropping them); the UI simply no longer reads or writes them.
  `kbHandles.ts` and `kbHandles.test.ts` are deleted — source files, not schema.
- **Existing `members` rows** are handle-keyed with no user. They are left in
  place; a new nullable `user_id` column links authenticated members going
  forward.
- **Existing KB pages** keep their free-text `author`/`updated_by` strings. No
  backfill, no rewrite — the migration rule forbids rewriting rows.

### Assumptions checked against the code, not guessed

- `@fastify/websocket` v11 hands the handler `(socket, req)`; `index.ts` currently
  destructures only `socket`, so the handshake `Cookie` header is available by
  widening that signature. Verified against the existing `/ws/terminal` and
  `/ws/chat` routes, which already take `req`-shaped access.
- `config.dbPath` is `path.join(DATA_DIR, 'zmrng.db')` with `DATA_DIR =
  ZMRNG_DATA_DIR ?? REPO_ROOT`, so the CLI script opens the same DB the server
  does, including on the VPS, just by importing `config`.
- `db.ts` `ensureColumns()` is the additive migration seam; `SCHEMA` is for fresh
  DBs. New tables go in **both**.

### Alternatives rejected

1. **JWT / stateless tokens.** Rejected in clarify and again here: logout and
   expiry need a server-side revocation list anyway, which is just the sessions
   table with extra steps.
2. **Cookie-only, no bearer fallback.** Simplest to reason about, and it is what
   clarify agreed. Rejected: it cannot work at all for the desktop→VPS Team
   connection (Contradiction 2), which is the main multi-user path.
3. **Reflected-origin CORS with `Allow-Credentials: true`.** Would let a cookie
   travel cross-origin. Rejected: reflecting arbitrary origins *with* credentials
   is a serious vulnerability, and it still fails on plain HTTP because of
   `Secure`.
4. **Gate the whole app, including Workspace.** Matches the task title's first
   sentence. Rejected: clarify explicitly narrowed it to KB + Team, and gating
   Workspace would put a login wall in front of the operator's own orchestrator.
5. **Reuse `page_revisions` as the changelog.** Less code. Rejected per
   Contradiction 5 — it silently misses create/rename/move/delete.
6. **Federate identity between the local server and the VPS.** Would deliver one
   login across the desktop's split origins. Rejected: shared-secret distribution
   plus a trust protocol between instances, far beyond this task.

---

## Configuration defaults

Pinned here so they are decisions, not implementer guesses. Each is a named
constant in the module that owns it, and each is asserted by the test named
beside it.

| Constant | Value | Where | Pinned by |
|---|---|---|---|
| `SESSION_TTL_MS` | `7 * 24 * 60 * 60 * 1000` (7 days) | `session.ts` | `session.test.ts` |
| Sliding-renewal window | Renew when **less than 6 days** remain, i.e. once ~24h of the window is spent. Keeps a fresh session from writing to the DB on every request. | `session.ts` (`shouldRenew`) | `session.test.ts` |
| `SCRYPT_N` / `r` / `p` | `32768` / `8` / `1`, 32-byte salt, 64-byte key | `password.ts` | `password.test.ts` |
| Login throttle | **5** failures per `(username, IP)` within **15 min** → `429` until the window expires. Counted in memory; a restart clears it. | `auth.ts` (`LoginThrottle`) | `auth.test.ts`, `authRoutes.test.ts` |
| Session cookie name | `zmrng_session` | `auth.ts` | `auth.test.ts` |
| Token size | 32 random bytes (256 bits), base64url | `session.ts` | `session.test.ts` |
| Password rules | **Minimum 8 characters; no composition rules and no maximum.** The operator asked only that it be hashed properly, so this is the one floor worth enforcing — it stops a one-character password without imposing rules that push people toward worse passwords. Enforced in the CLI at provisioning time, not at login. | `cli/createUser.ts` | `createUser.test.ts` |

---

## Approach

Six layers, each independently testable:

1. **Password + token primitives** (`password.ts`, `session.ts`) — pure, no DB.
2. **Persistence** (`db.ts`) — `users`, `sessions`, `kb_changelog` tables;
   `user_id` columns on `members` and `page_revisions`.
3. **Auth service + route gate** (`auth.ts`, `index.ts`) — login/logout/me,
   session resolution, a protected-prefix `onRequest` hook, login throttling.
4. **Socket identity** (`workspace.ts`, `index.ts`, `types.ts`) — `hello` carries
   a token (or relies on the handshake cookie); author fields leave the wire.
5. **KB attribution + changelog** (`db.ts`, `index.ts`) — every KB write records
   the authenticated user; a new changelog feed endpoint.
6. **Frontend** (`auth.ts`, `LoginPane.tsx`, `App.tsx`, `TeamView.tsx`,
   `KbView.tsx`, `api.ts`, `types.ts`) — origin-keyed session store, login pane,
   handle UI removed.

Plus the **CLI provisioning script**.

---

## Files

### New — server

| File | Purpose |
|---|---|
| `packages/server/src/password.ts` | `hashPassword` / `verifyPassword` over `node:crypto` scrypt; versioned `scrypt$N$r$p$salt$key` format; `timingSafeEqual`. The swap seam for D3. |
| `packages/server/src/session.ts` | `newToken()` (32 random bytes, base64url), `hashToken()` (sha256 → hex), `isExpired()`, `shouldRenew()` (sliding-window policy), `SESSION_TTL_MS`. Pure. |
| `packages/server/src/auth.ts` | `AuthService`: `login`, `logout`, `resolve(bearer, cookie)`, `touch` (sliding renewal). `LoginThrottle`: pure fixed-window failure counter. `parseCookieHeader`, `sessionCookie()` / `clearCookie()` builders, `isProtectedPath()`, `resolveSocketIdentity(cookieHeader, helloToken)`. |
| `packages/server/src/authRoutes.ts` | A Fastify plugin — `registerAuth(app, { auth, db })` — owning the `onRequest` session/gate hook and the three `/api/auth/*` routes. **This exists so the gate is integration-testable.** `index.ts` currently opens the real DB, spawns managers and top-level-`await`s at import time, so importing it from a test would boot a whole server; a plugin can be registered onto a bare `Fastify()` in a test and driven with `app.inject()` (no port, no network). |
| `packages/server/src/cli/createUser.ts` | Provisioning CLI. Argument parsing and the provisioning call are exported separately from the `process.argv`/TTY entrypoint, so tests drive the logic without executing the script. |

### New — web

| File | Purpose |
|---|---|
| `packages/web/src/auth.ts` | Pure, React-free origin-keyed session store: `sessionKey(origin)`, `loadSession`, `saveSession`, `clearSession`, `isSessionExpired`, `authHeaders`, plus `loginToOrigins(origins, username, password, post)` — the D1 multi-origin submit, with the network call injected so it is testable without `fetch`. localStorage only. |
| `packages/web/src/components/LoginPane.tsx` | The login form. Props: `origins` (deduped list of the gated origins this submit should authenticate against — one entry in the VPS case, two in the desktop case), `label`, `onAuthed`. Reused verbatim by both gated surfaces, and reports per-origin failures inline. |
| `packages/web/src/components/LoginPane.module.css` | Frosted-glass styling, `var(--*)` tokens only. |

### Modified — server

| File | Change |
|---|---|
| `db.ts` | `users` / `sessions` / `kb_changelog` in `SCHEMA` **and** `ensureColumns()`; `user_id` added to `members` and `page_revisions`. New methods: `createUser`, `getUserByUsername`, `getUserById`, `setUserPassword`, `createSession`, `getSession`, `touchSession`, `deleteSession`, `deleteExpiredSessions`, `memberForUser`, `addChangelogEntry`, `listChangelog`. `updatePageBody` gains a `userId` param and writes a throttled `edit` entry. |
| `types.ts` | **Source of truth.** `User`, `PublicUser`, `Session`, `LoginRequest`, `LoginResponse`, `AuthState`, `KbChangeAction`, `KbChangeEntry`; `WsWorkspaceClientMsg` loses `displayName`/`author`/`handle` and `hello` gains optional `token`; `WsWorkspaceServerMsg` gains `{ type: 'unauthorized' }`. |
| `index.ts` | `authorization` added to CORS allow-headers; `registerAuth(...)` wired in after the CORS hook; `GET /api/spaces/:id/changelog`; every KB write route passes the authenticated user; `/ws/workspace` widened to `(socket, req)` and authenticated. |
| `workspace.ts` | `parseWorkspaceClientMsg` drops the author/handle fields and accepts an optional `hello.token`. `WorkspaceManager.join` takes a `User`. `ChannelManager.post`/`react` and `PageManager.savePage` take the authenticated identity from the caller, not the frame. |
| `config.ts` | `secureCookies: boolean` (`ZMRNG_SECURE_COOKIES`), `sessionTtlMs`. |
| `package.json` (server) | `create-user` / `create-user:dist` scripts. |

### Modified — web

| File | Change |
|---|---|
| `types.ts` | **Manual mirror** of every server type above. |
| `api.ts` | `login`, `logout`, `me`; an `origin`-aware request helper attaching `Authorization` and `credentials: 'include'` for same-origin; `getChangelog`. |
| `App.tsx` | Session state per surface origin; render `LoginPane` in place of `KbView`/`TeamView` when unauthenticated; drop `teamHandle` plumbing; feed `teamUnread` the authenticated username. |
| `TeamView.tsx` | Join-by-handle form removed; identity is the session user; frames no longer carry `author`/`handle`; logout button. |
| `KbView.tsx` | `HandleGate` removed; `canEdit` is "is authenticated"; changelog panel; logout button. |
| `workspaceProtocol.ts` | `encodeHello(token?)`; `encodeMessage`/`encodeReact`/`encodePageEdit` drop their identity args. |
| `teamUnread.ts` | Own-post detection keyed on the authenticated username (signature unchanged, caller changes). |

### Deleted

`packages/web/src/kbHandles.ts`, `packages/web/test/kbHandles.test.ts` — the
self-asserted-handle model they encode no longer exists.

### Docs

`CLAUDE.md` (auth section + the D1 per-instance limitation + the `create-user`
command), `.claude/docs/services-reference.md`, `.claude/docs/codemap.md`,
`docs/team-workspace-deploy.md` (provisioning on the VPS), `.claude/errors.md`
if anything non-obvious surfaces.

---

## Step-by-step

1. **Baseline** — `npm install` (this worktree has **no `node_modules`** yet, so
   this is a real step, not a formality), then `npm run typecheck && npm run lint
   && npm test && npm run build`. Record the result; fix or document anything
   already red before touching code.
   Also **verify, against the installed package**, that `@fastify/websocket`'s
   handler signature is `(socket, request)` — the plan's one claim that could not
   be checked from disk. If it is not, fall back to a single-use token in the
   `/ws/workspace` query string, minted by `POST /api/auth/ws-ticket` and
   redeemed once; do **not** put the long-lived session token in a URL.
2. **`password.ts`** — RED: round-trip, wrong-password rejection, distinct salts
   for identical passwords, malformed-hash rejection, empty/long/unicode
   passwords. GREEN: implement.
3. **`session.ts`** — RED: token uniqueness and length, `hashToken`
   determinism, `isExpired` boundaries, `shouldRenew` only inside the renewal
   window. GREEN.
4. **`db.ts`** — RED (extend `db.test.ts`): the three new tables plus the two new
   columns appear via `ensureColumns()` on a pre-auth schema, are idempotent on
   re-open, and **no existing row is rewritten**; user create/lookup; unique
   username; session create/get/touch/delete/expiry-sweep; changelog insert and
   ordered read. GREEN.
5. **`auth.ts`** — RED: login success/failure, unknown-user rejection taking the
   dummy-verify path (no enumeration), generic error text, throttle lock after N
   failures and release after the window, cookie header construction with and
   without `Secure`, `parseCookieHeader` edge cases, bearer-over-cookie
   precedence, `isProtectedPath` for every gated prefix **and** the ungated ones
   that must not match. GREEN.
6. **`authRoutes.ts`** — RED first, as `inject()` integration tests against a
   bare Fastify with the plugin registered: login returns a cookie **and** a body
   token; a gated route with no credential is 401; the same route with the cookie
   is 200; with a bearer header is 200; with a garbage or expired token is 401;
   an ungated route is 200 throughout; logout makes the previously-good token
   401. GREEN: implement the plugin. Gate `/api/spaces`, `/api/pages`,
   `/api/folders`, `/api/page-revisions`, `/api/channels`, `/api/auth/me`,
   `/api/auth/logout`. Leave `/api/tasks`, `/api/config`, `/api/auth/login`,
   `/api/preflight` and static ungated. Wire `registerAuth` into `index.ts`.
7. **Socket auth** — RED: `resolveSocketIdentity` unit tests (bearer-from-`hello`
   beats cookie; absent/expired/unknown token yields no identity), plus a
   fake-socket test that an unauthenticated socket receives `unauthorized` and is
   closed, and that no post/react/edit is persisted from it. GREEN: the
   `workspace.ts` parser and managers, then the `/ws/workspace` route, using the
   resolved user for every post/react/edit.
8. **KB attribution + changelog** — RED: extend `kb.test.ts` for per-action
   changelog entries and authenticated `author`/`updated_by`. GREEN: thread the
   authenticated user through every KB write route and `updatePageBody`; add
   `GET /api/spaces/:id/changelog`.
9. **CLI** — RED: `createUser.test.ts` against the exported parse/provision
   functions and a temp DB. GREEN: `createUser.ts` — `--username`,
   `--display-name`, optional `--password` (otherwise a no-echo prompt via
   raw-mode stdin); re-running for an existing username **resets** the password
   (the documented recovery path); non-zero exit with a clear message on bad
   input.
10. **Web pure modules** — RED then GREEN for `auth.ts` (including the
    multi-origin login helper from D1) and `workspaceProtocol.ts`.
11. **Web UI** — RED: `LoginPane.test.tsx`, and the KB gating assertions in
    `KbView.spaces.test.tsx`. GREEN: `LoginPane`, then `App.tsx` gating, then the
    `TeamView` / `KbView` identity refactor and the changelog panel. Delete
    `kbHandles.*`. Handle a **401 from an expired session** by clearing that
    origin's stored session and re-showing the login pane rather than surfacing a
    raw error.
12. **Type mirror** — reconcile `packages/web/src/types.ts` against the server's
    and let `npm run typecheck` prove it.
13. **Review** — `zmrng-code-reviewer` pass against this plan; address findings.
14. **Validate + sync docs** — full gate green, then the `sync-docs` skill; stage
    this plan file.

---

## Test strategy

**Runner:** Vitest in both workspaces. Commands: `npm test` (both),
`npm run test -w @zmrng/server`, `npm run test -w @zmrng/web`. The full gate is
`npm run typecheck && npm run lint && npm test && npm run build`.

**Hard rules carried over from `.claude/rules/testing.md`:** no test spawns a real
`claude`, calls `gh`, or touches the network; no test depends on
`ANTHROPIC_API_KEY` or global git config; SQLite tests use a temp-file DB;
coverage is not a gate.

### Server — new files

| File | What it proves |
|---|---|
| `packages/server/test/password.test.ts` | hash→verify round-trips; a wrong password fails; the same password hashed twice yields different stored strings (random salt) and both verify; a malformed/truncated/unknown-prefix stored hash is rejected rather than throwing; empty, very long, and unicode passwords all round-trip. |
| `packages/server/test/session.test.ts` | `newToken()` is unique across many calls and long enough to resist guessing; `hashToken` is deterministic and does not return the token itself; `isExpired` is correct either side of the boundary; `shouldRenew` fires only once the sliding window is entered, so a fresh session causes no DB write. |
| `packages/server/test/auth.test.ts` | Login succeeds for valid credentials and returns a session whose stored row holds the **hash**, never the raw token. Login fails for a wrong password **and** for an unknown username with the *same* generic message. `LoginThrottle` locks after N failures and releases after the window. `resolve()` prefers a bearer header over a cookie, and rejects an expired, deleted or unknown token. `sessionCookie()` omits `Secure` on http and includes it on https / `ZMRNG_SECURE_COOKIES=1`, and always carries `HttpOnly` + `SameSite=Strict`. `parseCookieHeader` survives absent, blank, multi-cookie and malformed headers. `isProtectedPath` returns true for every gated prefix and **false** for `/api/tasks`, `/api/config`, `/api/auth/login`, `/api/preflight` and `/` — the near-miss half is the point. |
| `packages/server/test/authRoutes.test.ts` | **The integration layer.** Registers `registerAuth` on a bare `Fastify()` over a temp-file DB and drives it with `app.inject()` — no port, no network, so the repo's hermetic-test rule holds. Proves the whole credential round trip end to end: `POST /api/auth/login` with good credentials returns 200, a `Set-Cookie` carrying `HttpOnly`+`SameSite=Strict`, and a body token; with bad credentials returns 401 and **no** `Set-Cookie`. A gated route (`/api/spaces`) is 401 with no credential, 200 with the cookie, 200 with `Authorization: Bearer`, and 401 with a garbage, tampered or expired token. An ungated route (`/api/tasks`) is 200 in every one of those states — the near-miss half that proves the gate is not simply blanket-denying. `GET /api/auth/me` reflects the logged-in user. After `POST /api/auth/logout` the previously-working token and cookie both 401, and the response clears the cookie. Repeated bad logins trip the throttle with a 429. |
| `packages/server/test/createUser.test.ts` | The CLI's pure argument parser: required flags, missing-flag errors, re-provisioning an existing username resets rather than duplicating. Driven against a temp DB through the same exported function the CLI entrypoint calls — the script's `process.argv`/TTY shell is not executed. |

### Server — extended

| File | Added coverage |
|---|---|
| `packages/server/test/db.test.ts` | `ensureColumns()` adds `users`, `sessions`, `kb_changelog`, `members.user_id` and `page_revisions.user_id` to a **pre-auth** schema; re-opening is idempotent; **pre-existing task/page/member/message rows are byte-identical afterwards** (the VPS-data-loss guard from `CLAUDE.md`). User create/lookup/password-reset; duplicate username rejected. Session create/get/touch/delete and the expiry sweep. `memberForUser` upserts by `user_id` and leaves legacy handle-only rows alone. Changelog insert + newest-first read, and that `updatePageBody` writes a throttled `edit` entry without breaking the existing 30s revision throttle. |
| `packages/server/test/workspace.test.ts` | `parseWorkspaceClientMsg` **rejects** a `message`/`react`/`page.edit` frame that still carries a client `author`/`handle` — proving identity can no longer be asserted over the wire — and accepts `hello` both with and without a `token`. `ChannelManager.post`/`react` and `PageManager.savePage` attribute to the identity passed by the caller, never one from the frame. `WorkspaceManager.join` maps a `User` to a stable member row across reconnects. **Socket handshake auth:** `resolveSocketIdentity` prefers a `hello` bearer token over the handshake cookie and yields nothing for an absent, expired, unknown or tampered token; and, against a plain-object fake socket (the pattern `workspace.test.ts` already uses), an unauthenticated socket is sent `{type:'unauthorized'}` and closed, with **no** message, reaction or page edit persisted from it. |
| `packages/server/test/kb.test.ts` | Every KB write records the authenticated user in `author`/`updated_by` and emits the right changelog `action` for create, rename, move, body-save and delete; the changelog endpoint returns newest-first and is scoped to its space. |

### Web — new

| File | What it proves |
|---|---|
| `packages/web/test/auth.test.ts` | The origin-keyed store: two different origins hold independent sessions **and the same origin shares one** — the unit test that pins D1's "one login covers both surfaces when the origins coincide". Save/load round-trip, `clearSession` scoped to one origin, `isSessionExpired` boundaries, tolerance of absent/corrupt localStorage values, and `authHeaders` emitting `Authorization` only when a live session exists. **Multi-origin login (D1):** one submit against two distinct origins stores two sessions; a deduped single origin issues exactly one request; and a partial failure (one origin rejects or is unreachable) still stores the session that succeeded and reports which origin failed. |
| `packages/web/test/LoginPane.test.tsx` | Renders username/password fields; submit is disabled until both are filled; a rejected login shows the server's generic error and does **not** clear the username; a successful login calls `onAuthed` with the session; the password input is `type="password"` and the form is keyboard-submittable. |

### Web — extended

| File | Added coverage |
|---|---|
| `packages/web/test/workspaceProtocol.test.ts` | `encodeHello` emits `{type:'hello'}` with a token when given one and without when not, and **never** emits `displayName`; `encodeMessage`/`encodeReact`/`encodePageEdit` no longer carry identity fields; `parseWorkspaceServerMsg` recognises the new `unauthorized` frame and still rejects junk. |
| `packages/web/test/KbView.spaces.test.tsx` | The unauthenticated KB renders `LoginPane` instead of the tree; an authenticated one renders the tree with editing enabled (replacing the deleted `HandleGate` assertions). |
| `packages/web/test/teamUnread.test.ts` | Own-post suppression keyed on the authenticated username. |

### Deleted

`packages/web/test/kbHandles.test.ts`, with its module.

### Manual smoke (engine + auth surfaces touched)

```
npm run create-user -- --username zc --display-name "zc"
npm run dev            # browse http://localhost:5174
```
- KB tab → login pane → log in → tree loads, editing enabled, edits attributed
  to `zc`, changelog shows the edit.
- Team tab → already authenticated on the same origin (no second prompt) → post
  a message → it appears authored by `zc`.
- Reload → still authenticated (cookie). Logout → both surfaces gate again while
  Workspace stays fully usable throughout.
- `curl -i localhost:4500/api/spaces` with no session → **401**;
  `curl -i localhost:4500/api/tasks` → **200**.

### Validation limits on this host — stated plainly

`CLAUDE.md` requires finishing with `npm run desktop:build`. **That is not
possible in this worktree:** `cargo`/`rustc` are absent, and
`bundle-sidecar.mjs` throws `sidecar bundle currently targets macOS only` on
Linux. The gate run here is therefore `npm run typecheck && npm run lint && npm
test && npm run build`, and the PR's **Validation** section will say exactly
that, naming `desktop:build` as the step the operator must run on the macOS host
before the change is shipped in the `.app`.

---

## Risks and residual concerns

- **Protocol break.** Old clients can no longer post. Intended, but it means the
  VPS and every desktop install must update together.
- **Bearer token in `localStorage`** on the cross-origin Team path — see D2. The
  markdown renderer escapes HTML, and the perimeter is Tailscale, but this is
  strictly weaker than the cookie path and is called out in the PR.
- **Plain HTTP on the VPS.** Credentials cross the tailnet unencrypted. The
  tailnet is itself encrypted, so this is acceptable under the existing
  documented exposure model — but TLS remains the correct long-term fix and is
  out of scope here.
- **Sessions renew on activity** (see *Configuration defaults*), so one only dies
  after a genuine week of inactivity.
- **No password reset**, by decision. Re-running `create-user` for an existing
  username resets the password; that is the documented recovery path.
- **A user must be provisioned on each server** they use. D1 gives one *login*,
  not one *account*: `create-user` is run on the desktop host and on the VPS.
  Documented in `CLAUDE.md` and `docs/team-workspace-deploy.md`.
- **Logout is per origin, and per client for the bearer path.** Same-origin tabs
  share the httpOnly cookie, so logging out in one logs out all of them; the
  cross-origin token lives in that client's `localStorage`, so another device
  stays logged in until its own session expires. Expected for server-side
  sessions, but documented so it is not mistaken for a bug.
- **Session expiry is handled by re-prompting, not by background refresh.** The
  client clears that origin's session on any 401 and shows the login pane again.
  No silent token-refresh machinery.
- **scrypt instead of argon2id** — D3. Flagged for the operator; the seam makes
  it cheap to revisit.

## Explicitly out of scope

Self-serve signup; password reset; 2FA; any "one session at a time" rule
(dropped by the operator); gating the Workspace surface; moving the KB onto the
VPS; federating identity between server instances; TLS termination; any change
to the Tailscale-only exposure model.
