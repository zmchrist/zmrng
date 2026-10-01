# Fix: cross-origin login fails with "Load failed"

## Problem
Logging in from the browser reports "Signed in, but one server could not be
reached — http://100.92.187.96:4500 — Load failed". The VPS is reachable and
accepts the login, but `LoginPane`'s default `post` always fetches with
`credentials: 'include'`. The server reflects arbitrary origins and therefore
never sends `access-control-allow-credentials`, so the browser discards the
credentialed cross-origin response before the app sees it.

## Approach
Use the same credential rule as `send()` in `api.ts`:
`credentials: isSameOrigin(origin) ? 'include' : 'omit'`. Export `isSameOrigin`
from `api.ts` so the rule lives in one place.

Rejected alternatives:
- Sending `access-control-allow-credentials` from the server — combined with the
  reflected-origin CORS policy this would let any origin ride the session cookie.
- Replacing the default `post` with `api.login` — it would lose `LoginPane`'s
  friendlier error text (the 429 "Too many attempts" message and the
  "Login failed." fallback).

## Test strategy
- Command: `npm run test -w @zmrng/web`
- `packages/web/test/LoginPane.test.tsx`: a new test renders `LoginPane` with the
  real default `post` and a stubbed `fetch`, submits against `['', VPS]`, and
  asserts the same-origin request uses `credentials: 'include'` and the VPS
  request uses `'omit'`. It failed before the fix and passes after.
