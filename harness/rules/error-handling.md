# Error Handling Protocol

When encountering errors, follow this process:

## 1. Check Known Solutions First
Before debugging, search the project's known-errors / troubleshooting doc (if it
keeps one) for the error message or keywords. Recurring project-specific gotchas
should be documented there (e.g. credential leaks, malformed-request errors,
streaming/parsing edge cases).

## 2. Diagnose Root Cause
- Read the full error message and stack trace
- Identify the **root cause**, not just symptoms
- Check if the error is in project code vs dependencies
- Reproduce the error to confirm understanding

## 3. Fix and Verify
- Apply the fix
- Run the project's validation commands (typecheck/build, lint, tests —
  whichever apply)
- Confirm the error is resolved

## 4. Document New Solutions (Immediately)
**Right after fixing** a new error, document it in the project's known-errors /
troubleshooting doc (if it keeps one) while context is fresh.

**Document if ANY of these are true:**
- Took more than 2 minutes to debug
- Root cause was non-obvious
- Likely to recur in this codebase
- Required searching external resources

**Skip documenting:**
- Simple typos or syntax errors
- One-off mistakes (wrong path, etc.)
- Errors already documented

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
- **Process / subprocess:** spawn failures, malformed streamed output, premature
  exit, credential leakage (secrets must be stripped from any spawned child's
  environment)
- **Networking:** connection drops, message parsing, reconnect/backoff failures
- **Persistence layer:** lock contention, schema/migration issues, timeout handling
- **API layer:** malformed/empty request bodies, validation errors
- **Version control / worktree:** base-ref resolution for local-only branches,
  stale worktrees
- **Build/type system:** type errors, cross-module type-mirror drift, import
  path resolution
