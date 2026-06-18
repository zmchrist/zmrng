# Known Errors & Solutions

Check here before debugging. Add a new entry whenever a fix took >2 min, had a
non-obvious root cause, or is likely to recur. Template in
`.claude/rules/error-handling.md`.

---

### Workers silently bill the metered API
- **Error:** No error surfaced — Anthropic API usage/cost appears even though the
  operator has a Max subscription.
- **Cause:** `ANTHROPIC_API_KEY` present in the parent env is inherited by the spawned
  `claude` child, which then prefers the metered API over Max OAuth.
- **Solution:** In `runner.ts`, copy `process.env` and `delete env.ANTHROPIC_API_KEY`
  before `spawn`. Never export the key in the shell that runs zmrng.
- **Files:** `packages/server/src/runner.ts` (constructor, env setup)
- **Date Found:** 2026-06-17

### Bodyless POST returns 400 (FST_ERR_CTP_EMPTY_JSON_BODY)
- **Error:** `FST_ERR_CTP_EMPTY_JSON_BODY` — Fastify 400 on `start`/`done`/`cancel`.
- **Cause:** The fetch sent `content-type: application/json` with no body; Fastify's JSON
  content-type parser rejects an empty body.
- **Solution:** Only set the JSON content-type header when a body is actually sent.
- **Files:** `packages/web/src/api.ts` (`req` helper — conditional headers)
- **Date Found:** 2026-06-17

### stream-json lines fail to parse / partial lines
- **Error:** `JSON.parse` throws on a `claude` stdout line, or text arrives mangled.
- **Cause:** stdout chunks don't align to line boundaries (a JSON object can be split
  across two `data` events), and claude emits non-JSON diagnostics too.
- **Solution:** Buffer stdout, split on `\n`, `JSON.parse` each complete line inside
  try/catch, and ignore lines that don't parse or whose shape is unknown. Shapes vary
  across claude versions — narrow with tolerant `asRecord`/`asString` helpers, never `any`.
- **Files:** `packages/server/src/runner.ts` (`onStdout`, `handleLine`)
- **Date Found:** 2026-06-17

### Worktree creation fails on a local-only target repo
- **Error:** `git worktree add ... origin/main` fails — `invalid reference: origin/main`.
- **Cause:** The target repo has no `origin` remote (local-only), so `origin/<branch>`
  doesn't resolve.
- **Solution:** Resolve the base ref with a fallback chain: `origin/<defaultBranch>` →
  local `<defaultBranch>` → `HEAD`; `git fetch origin` is best-effort (wrapped in try/catch).
- **Files:** `packages/server/src/worktree.ts` (`resolveBase`, `createWorktree`)
- **Date Found:** 2026-06-17

### Web typecheck fails after a server type change
- **Error:** `tsc` errors in `packages/web` referencing a property that exists on the server.
- **Cause:** `packages/web/src/types.ts` is a MANUAL mirror of the server types and was
  not updated alongside `packages/server/src/types.ts` (there is no shared package).
- **Solution:** Mirror every server type change into the web types file in the same change.
- **Files:** `packages/server/src/types.ts`, `packages/web/src/types.ts`
- **Date Found:** 2026-06-17
