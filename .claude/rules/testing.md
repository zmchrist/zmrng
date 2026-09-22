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
- **Web** (`packages/web`) — `environment: 'happy-dom'` + `@testing-library/react`.
  Tests in `packages/web/test/`; setup in `packages/web/test/setup.ts` (jest-dom
  matchers, plus a `scrollIntoView` stub neither DOM implementation provides).
  Config: `packages/web/vitest.config.ts`. happy-dom replaced jsdom because
  environment construction — not the tests — dominated the suite: measured over 8
  interleaved runs, wall time went 33.5s → 18.8s and the `environment` phase 38s →
  13.9s, with all 571 tests passing unchanged. The swap needed no test edits: the
  files that need `matchMedia`/`ResizeObserver`/`visualViewport` already stub them
  by hand, since jsdom did not provide those either.

Run: `npm test` (both), `npm run test:watch` (both), or `-w @zmrng/server` /
`-w @zmrng/web` for one workspace.

### Fork cap (load-induced flakes)
Both `vitest.config.ts`s set `test.poolOptions.forks.maxForks` from
`ZMRNG_VITEST_MAX_FORKS` (default 3) instead of leaving it at vitest's own default
(`cores - 1`). `runner.ts` sets `ZMRNG_VITEST_MAX_FORKS=2` in a worker child's env
(right after the `ANTHROPIC_API_KEY` strip), so several workers validating at once
don't each claim most of the box — an oversubscribed host produces flaky failures that
are load, not a real regression. `.claude/verify.sh` runs the test step split per
workspace (`test:server`, `test:web`, via `npm run test -w @zmrng/<ws>`) rather than one
combined `npm run test --workspaces` step, so a failing workspace is named in the
summary instead of being hidden behind the other workspace's output.

### Workspace scoping (`--fast` only)
`verify.sh --fast` — the turn-stop gate — skips a workspace's suite when the turn
did not touch that workspace, reported as `SKIP  test:web (workspace unchanged)`
plus a summary line naming why. The web suite is ~59% of the gate's wall time and
almost all of that was DOM-environment construction rather than tests (`tests 8.00s`
vs `environment 37.55s` across 54 files, measured under jsdom), so a server-only or
docs-only turn was paying ~37s for nothing. The happy-dom swap cut that cost roughly
in half; scoping removes the rest of it on turns that never touch web.

Scoping may only ever **remove** work it can positively prove is unnecessary.
The changed-path set is branch commits (`merge-base HEAD origin/main`) plus
uncommitted work; paths classify as `packages/server/**`, `packages/web/**`, or
inert (`.agents/**`, `docs/**`, `*.md`). Anything else — root configs, `.claude/**`
— is **unknown** and forces both. Not a git repo, no `origin/main`, or an empty
change set also fall back to both.

`typecheck` and `lint` always run for both workspaces: `typecheck` is what catches
server↔web type-mirror drift, the exact failure scoping could otherwise hide. The
full pre-PR gate (`verify.sh` with no flag) is **never** scoped. Override:
`ZMRNG_VERIFY_NO_SCOPE=1`.

Rejected alternatives, all measured: `pool: 'threads'` is only ~10% at equal
concurrency (its apparent 45% was higher default parallelism), and `isolate: false`
is ~4x faster but fails 73-81 of 571 tests and swings between 5s and 63s per run.
**Do not retry `isolate: false` as a test-hygiene project** — it is not a mock-leak
problem. It reproduces with two throwaway files that each render their own trivial
`<button>`, with no mocks, hooks, timers or shared state: whichever file runs second
in a worker renders nothing and every query misses. That is a defect in the Vitest
3.2.7 + React 19 + `@testing-library/react` + DOM-environment combination, not
something per-file test hygiene can fix; it needs an upstream fix, not a refactor.

## What's covered
- **`phases.ts`** — `parsePlanDecision()` and every control-token regex
  (`READY_RE`, `PLAN_READY_RE`, `VALIDATING_RE`, `BLOCKED_RE`, `PR_RE`), including
  near-miss cases that must NOT match (tokens quoted in prose, non-PR GitHub URLs).
- **`runner.ts`** — `summarizeTool()`, `summarizeResult()`, `parseUsage()`,
  `assistantText()`, `partialDelta()`, fed real-shaped stream-json lines checked
  in under `test/fixtures/stream-json.jsonl`; `buildUserMessage()` (text-only shape,
  image/document content-block ordering, mixed attachments) and `sanitizeAttachments()`
  (accepts a valid image/PDF, rejects a bad media type, rejects an oversized decoded
  payload, caps the array at `MAX_ATTACHMENTS`, and tolerates non-array/malformed input).
- **`db.ts`** — temp-file SQLite; `ensureColumns()` migration + idempotency and
  atomic `addUsage()` accumulation. Also covers the additive `stale` column: added
  by `ensureColumns()` on a pre-`stale` schema, idempotent on re-open, and
  `updateTask({ stale: true })` round-trips through `getTask()`.
- **`config.ts`** — `resolveRegistry()` precedence (`repos.json` → env → legacy),
  auto-scan, and the empty-registry guard (issue #16).
- **Worker prompts** (`prompts.test.ts`) — the harness contract. `systemPrompt()`,
  `planKickoff()`, `executeKickoff()`, and `PR_BODY_TEMPLATE` are pinned: the
  branch-only + worktree-hygiene rules, the grill/test-strategy planning steps,
  RED→GREEN→REFACTOR, `--body-file` (never `--fill`), and checklist parity with
  `.github/PULL_REQUEST_TEMPLATE.md`. Deleting a rule from a prompt fails CI. Also
  covers `resumeKickoff()` per phase: the RESUME preamble (`RESUME`, `inspect`, `do
  NOT redo`, title/body carried), the delegated per-phase kickoff present
  **verbatim** (proving reuse rather than a divergent copy), and — for `planning`
  — that the transcript appears exactly once (not duplicated by the preamble).
- **State machine** (`taskManager.test.ts`) — the highest-value artifact. Drives
  the real `TaskManager` over a **real temp git repo** (worktree create/remove run
  for real) with a **fake runner** injected through `TaskManager`'s optional
  `runnerFactory` constructor param. Scripts stream-json lines and asserts every
  status transition that has a control token, plus `blocked`/resume, the lane
  cap + queue, and `interrupt()` suppressing the failure path. Also covers restart
  after an orphaned session: constructing a second `TaskManager` on the same `db`
  with an empty `runners` map (simulated app restart), `reconcileOrphans()` marking
  the live-phase task `stale`, `restartAgent()` spawning a fresh runner in the same
  worktree, and lane-aware queuing (`resuming` Set) when lanes are full.

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
