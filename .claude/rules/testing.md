# Pre-Implementation Checklist

Before starting any new feature implementation, verify the baseline is stable:

```bash
npm install                    # Dependencies install cleanly
npm run typecheck              # tsc --noEmit, both workspaces
npm run lint                   # ESLint, both workspaces
npm test                       # Vitest run, both workspaces
npm run build                  # tsc (server) + vite build (web)
```

**If any fail:** Fix first or document as a known issue before proceeding.

---

# Testing Conventions

## Framework
**Vitest** in both workspaces (chosen over Jest: native ESM, no transform config,
Vite already present for web).

- **Server** (`packages/server`) — `environment: 'node'`. Tests + fixtures live in
  `packages/server/test/` (kept out of the `tsc` build, which compiles `src/` only).
  Config: `packages/server/vitest.config.ts`.
- **Web** (`packages/web`) — `environment: 'jsdom'` + `@testing-library/react`.
  Tests in `packages/web/test/`; setup in `packages/web/test/setup.ts` (jest-dom
  matchers). Config: `packages/web/vitest.config.ts`.

Run: `npm test` (both), `npm run test:watch` (both), or `-w @zmrng/server` /
`-w @zmrng/web` for one workspace.

## What's covered
- **`phases.ts`** — `parsePlanDecision()` and every control-token regex
  (`READY_RE`, `PLAN_READY_RE`, `VALIDATING_RE`, `BLOCKED_RE`, `PR_RE`), including
  near-miss cases that must NOT match (tokens quoted in prose, non-PR GitHub URLs).
- **`runner.ts`** — `summarizeTool()`, `summarizeResult()`, `parseUsage()`,
  `assistantText()`, `partialDelta()`, fed real-shaped stream-json lines checked
  in under `test/fixtures/stream-json.jsonl`.
- **`db.ts`** — temp-file SQLite; `ensureColumns()` migration + idempotency and
  atomic `addUsage()` accumulation.
- **`config.ts`** — `resolveRegistry()` precedence (`repos.json` → env → legacy),
  auto-scan, and the empty-registry guard (issue #16).
- **Worker prompts** (`prompts.test.ts`) — the harness contract. `systemPrompt()`,
  `planKickoff()`, `executeKickoff()`, and `PR_BODY_TEMPLATE` are pinned: the
  branch-only + worktree-hygiene rules, the grill/test-strategy planning steps,
  RED→GREEN→REFACTOR, `--body-file` (never `--fill`), and checklist parity with
  `.github/PULL_REQUEST_TEMPLATE.md`. Deleting a rule from a prompt fails CI.
- **State machine** (`taskManager.test.ts`) — the highest-value artifact. Drives
  the real `TaskManager` over a **real temp git repo** (worktree create/remove run
  for real) with a **fake runner** injected through `TaskManager`'s optional
  `runnerFactory` constructor param. Scripts stream-json lines and asserts every
  status transition that has a control token, plus `blocked`/resume, the lane
  cap + queue, and `interrupt()` suppressing the failure path.

## Hard rules
- **No test spawns a real `claude` process, calls `gh`, or touches the network.**
  The runner-factory seam is what keeps the engine tests hermetic; git runs for
  real against a temp repo (worktree/branch behaviour is the part worth proving).
- **Never depend on `ANTHROPIC_API_KEY`** or a global git config; the state-machine
  test sets local `user.name`/`user.email` on its temp repo.
- **Coverage is not a gate.** Do not add coverage thresholds.

## Type-mirror check (cheap, catches the most common break)
Any change to `packages/server/src/types.ts` must be mirrored into
`packages/web/src/types.ts`; `npm run typecheck` over both workspaces verifies it.

## Manual Smoke (when touching the engine)
```bash
npm run dev            # server + web
# - create a task, pick a repo, Start → clarify
# - answer questions → ZMRNG_READY → planning → executing → validating → PR
# - confirm the PR opens in the chosen target repo
```

## Workspace-Specific Commands
```bash
npm run dev:server             # Fastify server (tsx watch)
npm run dev:web                # Vite dev server
```
