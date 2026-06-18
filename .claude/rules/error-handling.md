# Error Handling Protocol

When encountering errors, follow this process:

## 1. Check Known Solutions First
Before debugging, search `.claude/errors.md` for the error message or keywords.
Several recurring zmrng gotchas are documented there (API-billing leak, bodyless
POST 400, stream-json parsing).

## 2. Diagnose Root Cause
- Read the full error message and stack trace
- Identify the **root cause**, not just symptoms
- Check if the error is in project code vs dependencies
- Reproduce the error to confirm understanding

## 3. Fix and Verify
- Apply the fix
- Run validation: `npm run typecheck && npm run lint && npm run build`
- Confirm the error is resolved

## 4. Document New Solutions (Immediately)
**Right after fixing** a new error, document it in `.claude/errors.md` while context
is fresh.

**Document if ANY of these are true:**
- Took more than 2 minutes to debug
- Root cause was non-obvious
- Likely to recur in this codebase
- Required searching external resources

**Skip documenting:**
- Simple typos or syntax errors
- One-off mistakes (wrong path, etc.)
- Errors already in errors.md

**Template:**
```markdown
### [Short descriptive title]
- **Error:** [Exact error message]
- **Cause:** [Root cause]
- **Solution:** [What fixed it]
- **Files:** [Affected files:line_numbers]
- **Date Found:** [YYYY-MM-DD]
```

Include before/after code examples when the fix involves code changes.

## Error Categories
- **Runner / child process:** spawn failures, stream-json parse errors, premature exit,
  API-key leakage (must be stripped from child env)
- **WebSocket:** connection drops, message parsing, auto-reconnect failures
- **SQLite:** WAL locks, schema/migration issues, busy timeouts
- **Fastify routes:** bodyless POST 400 (`FST_ERR_CTP_EMPTY_JSON_BODY`), validation
- **Worktree / git:** base-ref resolution for local-only repos, stale worktrees
- **Build/TypeScript:** type errors, server↔web type-mirror drift, ESM import paths
