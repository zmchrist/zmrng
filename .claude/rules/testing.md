# Pre-Implementation Checklist

Before starting any new feature implementation, verify the baseline is stable:

```bash
npm install                    # Dependencies install cleanly
npm run typecheck              # tsc --noEmit, both workspaces
npm run lint                   # ESLint, both workspaces
npm run build                  # tsc (server) + vite build (web)
```

**If any fail:** Fix first or document as a known issue before proceeding.

---

# Testing Conventions

## Current State
No test framework is configured yet. Validation is typecheck + lint + build.
When tests are added:
- Use a TypeScript-compatible framework (vitest, node:test)
- Mirror the workspace structure: tests per package
- Highest-value targets: stream-json line parsing, repo-registry fallback chain,
  SQLite migration/backfill, phase transitions (clarify→building→review)

## Pre-Commit Validation
```bash
npm run typecheck
npm run lint
npm run build
```

## Manual Smoke (when touching the engine)
```bash
npm run dev            # server + web
# - create a task, pick a repo, Start → clarify
# - answer questions → ZMRNG_READY → building → PR
# - confirm the PR opens in the chosen target repo
```

## Type-mirror check (cheap, catches the most common break)
Any change to `packages/server/src/types.ts` must be mirrored into
`packages/web/src/types.ts`; `npm run typecheck` over both workspaces verifies it.

## Workspace-Specific Commands
```bash
npm run dev:server             # Fastify server (tsx watch)
npm run dev:web                # Vite dev server
```
