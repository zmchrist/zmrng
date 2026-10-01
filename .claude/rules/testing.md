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
- **`db.ts`** — temp-file SQLite; `ensureColumns()`/`ensureAuthSchema()` migration +
  idempotency, including an explicit **DATA-LOSS GUARD**: pre-existing task/page/member/
  message rows must be unchanged after migrating a pre-auth database, because the VPS
  redeploys in place over its live `zmrng.db`. Also users/sessions/changelog round-trips
  and `memberForUser`'s stability across reconnects. Plus
  atomic `addUsage()` accumulation. Also covers the additive `stale` column: added
  by `ensureColumns()` on a pre-`stale` schema, idempotent on re-open, and
  `updateTask({ stale: true })` round-trips through `getTask()`. The data-loss guard
  **now covers the Loop tables too**: `ensureLoopSchema()` creates `loop_runs`/
  `loop_tickets`/`loop_events` + the `loop_events_run` index on an OLD-schema database,
  re-opening is idempotent, and on a current pre-loop database every existing table keeps
  its exact rows AND columns. Plus run/ticket/event round-trips (malformed JSON columns read
  back as the empty value, never throw), `listLoopRuns` ordering, `listLoopEvents` (most
  recent `limit` oldest-first, kind filter, 200 default / 1..1000 clamp) and atomic
  `addLoopUsage` (run AND ticket, run-only for the orchestrator, no-op for unknowns).
- **Auth** — `password.test.ts` (hash→verify round-trip, distinct salts, malformed
  stored hashes rejected rather than thrown, unicode/empty/very-long passwords),
  `session.test.ts` (token uniqueness/length, `hashToken` determinism, expiry boundaries,
  and that a FRESH session does not trigger a renewal write), `auth.test.ts` (login
  success/failure with the same generic message for a wrong password and an unknown user,
  the token HASH being what is stored, bearer-over-cookie precedence, expiry/revocation,
  the sliding renewal, cookie construction with and without `Secure`, throttle lock and
  release, and `isProtectedPath` for every gated prefix **and** the ungated near-misses).
- **The login gate** (`authRoutes.test.ts`) — the integration layer. `registerAuth` on a
  bare `Fastify()` over a temp-file DB, driven with `app.inject()` (no port, no network).
  Proves the whole credential round trip: login returns a cookie AND a body token, bad
  credentials 401 with no cookie, a gated route is 401/200/200/401 across no-credential /
  cookie / bearer / garbage, an ungated route is 200 in every one of those states, an
  unrouted path under a gated prefix still 401s, logout kills both transports, and
  repeated failures trip a 429.
- **KB attribution** (`kb.test.ts`) — the same `inject()` pattern over `registerKbRoutes`.
  The central claim of the login feature: a client-supplied `author` on create/restore/
  rename/move/delete is IGNORED and the authenticated user is recorded instead. Plus one
  changelog entry per action, a delete entry outliving its page, newest-first/space-scoped/
  limit-clamped reads, and a 401 sweep over all 15 KB routes.
- **`createUser.test.ts`** — the CLI's exported parse/validate/provision functions against
  a temp DB; re-provisioning an existing username resets the password rather than
  duplicating the row. The `process.argv`/TTY entrypoint is never executed.
- **`config.ts`** — `resolveRegistry()` precedence (`repos.json` → env → legacy),
  auto-scan, and the empty-registry guard (issue #16). Also `resolveLoopConfig()`: the
  three Loop fields (`loopMaxLoadPerCore`/`loopMinFreeMemMb`/`loopPumpIntervalMs`) default
  correctly, read valid overrides (including a fractional load per core), and each falls
  back to its default INDEPENDENTLY on a blank/garbage/non-finite/zero/negative value — so
  a typo can never disable the load gate.
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
- **Loop pure logic** (`loopMap.test.ts`, `loopPrompts.test.ts`) — the gauntlet
  contract, pinned the way `prompts.test.ts` pins `phases.ts`. `loopMap.test.ts`: `parseBar`
  (`## Bar` section, `Bar:` line, null otherwise; fences and HTML comments ignored), the
  blocked-by / epic-children fallbacks (`Blocked by #12`, `- [ ] #34` match; `#12` in prose
  and code spans does NOT), `deriveStates` (a closed external blocker is satisfied, an open
  one blocks), `findCycle`, `frontier`/`pickNext` (priority, then issue number, never above
  the free slots, never a barless ticket), `percentComplete` (empty map, skipped excluded,
  rounding), `verdictOutcome` (WIN only on our label; a tie or garbage is a LOSE) and
  `nextAfterLoss` (parks at round 7). `loopPrompts.test.ts`: every step system prompt
  carries branch-only + worktree-hygiene + the `GAUNTLET_QUESTION` protocol; the builder
  never judges its own work and carries the last gap verbatim; the critic is harsh,
  READ-ONLY, blind (provenance stripped), answers a LETTER never a score; the fold prompt is
  serial and never touches `main`; the final-PR kickoff uses `--body-file` (never `--fill`),
  `Closes #n` per done ticket and pushes only integ; the orchestrator prompt lists every
  curl route and says never edit code or merge; `orchestratorRecap` carries the run facts,
  every ticket and only the last 20 chat lines; and `parseStepResult` includes the
  **near-miss** cases that must NOT match — a token quoted mid-sentence, inside a
  ``` / `~~~` fence (even unclosed) or inline code, and `GAUNTLET_STATUS=GREENISH` /
  lower-case statuses. Deleting a rule from a prompt fails CI.
- **`loopLoad.test.ts`** — `parseMeminfo` and `parseVmStat` against checked-in real-shaped
  fixtures (`test/fixtures/proc-meminfo.txt`, `vm_stat.txt`, 16384-byte pages; null on a
  missing line / malformed header), `assessLoad` (allows under both thresholds, refuses over
  load-per-core, refuses under the memory floor, names every tripped threshold in `reason`,
  treats `[0,0,0]` as CPU-unconstrained) and `defaultLoadProbe` with INJECTED readers — the
  Linux branch, the macOS branch, and the `os.freemem()` fallback when a reader throws or
  parsing fails, never throwing itself. Nothing touches `/proc`, `vm_stat` or the host.
- **`loopGithub.test.ts`** — `ghLoopGitHub` over an **injected exec** (`gh` never runs):
  native sub-issues + `blocked_by` JSON mapped into tickets, the epic task-list fallback and
  the `Blocked by #N` body fallback when the endpoint rejects, external-blocker state
  (unknown ⇒ open), and input validation (slug / issue number) before any call.
- **`loopRoutes.test.ts`** — `registerLoopRoutes` on a bare `Fastify()` with a STUB
  manager, driven by `app.inject()` (the `kb.test.ts` pattern): each route forwards
  validated args, `GET /api/loop/load` returns the manager's sample, bad bodies are 400
  (non-int epic, lanes > 3, non-array priority, empty answer/chat text), an unknown run is
  404, a manager error carrying a `status` keeps it, anything else is a 500, and a bodyless
  POST works.
- **Loop engine** (`loopManager.test.ts`) — the highest-value Loop artifact. Drives the REAL
  `LoopManager` over a **real temp git repo with a bare `origin`** (so the server's integ
  push really lands) with a **fake `RunnerFactory`** (scripted turns that may run real `git`
  commits/merges in the step's cwd), a **fake `LoopGitHub`**, a **fake load probe** whose
  next sample each test sets, and a **fake scan**. Every async job is awaited through the
  manager's **`whenIdle()` seam** — never a sleep. Its `describe` blocks follow the plan's
  **20 scenarios**: creation (+ rejected repos), picking off the integ tip, the builder
  assertion/nudge, LOSE → gap into the next round, a real fold + push + dependent pick,
  the **serial fold mutex** (queued stop, duplicate settle), the 6-round fuse, questions
  and answers, the critic read-only violation, the **global 3-lane pool** across runs, stop
  and pause, finalize (green → PR agent → `complete`; red / erroring scan → `blocked`,
  fail-closed), restart (`reconcileOrphans`/`resume`, a full pool never exceeded, serial
  re-fold), archive, orchestrator coalescing (zero sends while busy, then ONE
  `[loop event]` message) / recap (last 20 chat lines) / lazy respawn, the **load gate**
  (deferral notified once per episode, in-flight work untouched, a failing probe
  fail-closed and logged), and `load()` + the broadcast view carrying `pool` and `load`. It
  never constructs a `TaskManager`, and **`taskManager.test.ts` is untouched** — that is
  the evidence the task pipeline was not modified.
- **`worktree.test.ts`** — `createWorktree`'s `{ branch, base, dir }` override (a given
  branch off a given base sha or another branch's tip, a plain `dir` name enforced, an empty
  override changes nothing, still idempotent) and the exported `gitIn`.
- **Web Loop** — `loopMap.test.ts` (`layoutMap` columns by longest blocker chain incl. a
  diamond and a cycle that does not throw, edges only inside the map, geometry, progress
  and `mapHeader`, `ticketGlyph`/`stepLabel`/`phaseColor` for every state, `laneCards`
  padding idle slots, `poolSummary` incl. a closed gate and a null `load`),
  `loopState.test.ts` (persisted open run, runs list, events merge/dedupe/cap, partial cap,
  `loopThread`), `loopProtocol.test.ts` (every `/api/loop/*` call's method/path/body, no
  content-type on a bodyless POST, the server's `{error}` surfaced on a 4xx),
  `LoopView.test.tsx` (the three regions, the map header and checked/unchecked checkboxes,
  lane cards, a waiting lane's question, the elapsed tick running only while active, Stop /
  Archive confirms, the "picks paused: high load" chip, header actions per status, the
  chat composer, and the no-run picker + new-run form submitting `{ repoId, epic }`), plus
  Loop cases in `ActivityRail.test.tsx` (the Loop button selects `'loop'`),
  `NavIcon.test.tsx` and `mobileNav.test.ts` (`viewForMode('loop')` → `'tasks'`, no Loop
  phone view).

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
