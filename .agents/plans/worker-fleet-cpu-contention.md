# Plan — Reduce worker-fleet CPU contention

**Type:** Bug fix + performance refactor
**Complexity:** Medium
**Workspaces:** `packages/server`, `packages/web`, plus repo-root `.claude/` harness
**Evidence:** `.agents/notes/resource-usage-analysis.md` (60-point, 5-minute sample,
2026-09-20). Measurements are already taken — **do not re-measure during
implementation.**

## User story

```
As the solo operator running several zmrng workers at once
I want the validation gate to stop saturating my 6-core box
So that workers finish faster and stop failing on phantom test regressions
```

## Problem

On a 6-core / 31 GB box running three live workers:

- Total CPU demand p50 **571%**, p90 **685%**, max **858%** against 600% capacity.
- CPU PSI `some avg10` p50 **59.4%**; load average 8.99-13.37.
- Memory peaked at 3.8 GB of 31 GB, swap never touched, IO PSI ~0.

**The agents are not the cost.** Three `claude` workers used **13.3% CPU total**
(~4% of one core each); vitest accounted for roughly **510% of the 571% p50**.
Peak 27 vitest processes on 6 cores.

Consequence: **three red validation gates in ~10 minutes, none reproducible.**
Each false red blocks a worker turn, costs a round chasing a phantom regression,
and that round adds more load — a self-reinforcing loop.

## Root causes (all four confirmed by reading the code)

### RC1 — every seeded hook fires twice in a worker worktree

`seedHarness()` (`packages/server/src/worktree.ts:253`) copies zmrng's
`harness/hooks/*.py` into `<worktree>/.claude/zmrng-hooks/` and registers them in
`.claude/settings.local.json` via `zmrngHooksConfig()` (`worktree.ts:146`). The
target repo's own `.claude/settings.json` separately registers its own copies
under `.claude/hooks/`. Claude Code merges both files, so **both fire**.

The existing dedupe cannot catch this — `worktree.ts:355`:

```ts
const dupe = existing.some((e) => JSON.stringify(e) === JSON.stringify(entry))
```

It is an exact structural match over entries **within `settings.local.json` only**.
The target's entry lives in a different file *and* differs textually
(`.claude/hooks/...` vs `.claude/zmrng-hooks/...`), so it never matches.

Duplication confirmed for all five hooks. The two `stop_validate.py`
implementations differ in source but converge on the same work — the harness one
documents "Custom: `.claude/validate.sh` script (takes priority over
auto-detect)", and zmrng's own is a thin wrapper on the same `validate.sh`. Both
therefore run `verify.sh --fast` (typecheck + lint + test over both workspaces).
They also use **different loop-guard flag files**
(`zmrng_stop_hook_active` vs a per-project hashed name), so neither suppresses
the other.

Cost is not limited to the Stop hook:

| Hook | Fires on | Duplicated cost |
|---|---|---|
| `stop_validate.py` | every turn end | 2x full gate (~1.7 cores each) |
| `post_tool_use_lint.py` | every Edit/Write | 2x `tsc` (30s timeout) — explains sampled `tsc` max=5 |
| `security_guard.py` | every Bash/Read/Edit/... | 2x python3 startup per tool call |
| `branch_guard.py`, `pr_shape_guard.py` | Edit/Write, Bash | 2x python3 startup |

### RC2 — vitest is unbounded

Neither `packages/server/vitest.config.ts` nor `packages/web/vitest.config.ts`
sets `poolOptions`. Vitest 3.2.7 defaults to `maxForks = cores - 1 = 5`, so
every run claims 5 forks regardless of what else is running.

Amplification: `3 workers x 2 Stop hooks x 2 workspaces x 5 forks` -> sampled 27.

### RC3 — `verify.sh` hides which workspace failed

`.claude/verify.sh` captures the combined output of `npm run test --workspaces`
(server first, web second) and on failure prints:

```bash
echo "FAIL: npm run $step (first $HEAD_LINES lines)"
echo "$out" | tail -n "$HEAD_LINES"
```

Two defects: it says "first" but runs `tail`; and because web runs last and
passed, a **server** failure scrolls off entirely. Two of the three observed red
gates presented as a wall of green with no indication of the failing workspace.

Second-order cost: a masked failure is indistinguishable from a real one, so the
only safe response is re-running the whole suite — ~1.7 cores of load, making the
next flake likelier.

### RC4 — `KbView.spaces.test.tsx` leaks a pending effect across mock teardown

**The earlier "module-mock bleed between files sharing a fork" hypothesis in the
notes was wrong.** Reading the code gives the real mechanism, and it is
intra-file:

1. `renderKb()` awaits only `findByRole('button', { name: 'general' })` — which
   resolves as soon as `getSpaces` renders the switcher.
2. Resolving `getSpaces` sets `spaceId`, which schedules a **second** passive
   effect (`KbView.tsx:307`) calling `api.getSpaceTree(spaceId).then(...)`.
   The test never awaits this one.
3. `afterEach(() => vi.restoreAllMocks())` runs. Under Vitest 3, `mockRestore()`
   on a plain `vi.fn()` (no original implementation) resets it to return
   `undefined`.
4. If React flushes that pending passive effect after step 3,
   `api.getSpaceTree(spaceId)` returns `undefined` -> `TypeError: Cannot read
   properties of undefined (reading 'then')`.

Whether the flush lands before or after teardown is **timing-dependent**, which
is exactly why it surfaces under CPU contention. `restoreAllMocks` is also
pointless here — the file creates no `vi.spyOn` spies. It is the only web test
file using it.

## Non-goals (this phase)

- Fleet-wide gate serialization (cross-worker lock / token bucket).
- Decoupling `maxLanes` from validation concurrency.

Both are recorded as Phase 2 below. Phase 1 is expected to remove most of the
contention on its own; Phase 2 should be re-measured against the new baseline
rather than designed against the old one.

---

## Implementation

Branch: `perf/zc/worker-fleet-cpu-contention` off `origin/main`.

Tasks are ordered so each is independently valuable and independently
revertible. **T3 first** — it makes every later step's failures legible.

### T3 — `verify.sh`: name the failing workspace, print the head

**File:** `.claude/verify.sh`

Split the `test` step into per-workspace steps so the summary names the culprit,
and fix the head/tail contradiction.

- Replace the single `test` step with `test:server` and `test:web`, each running
  `npm run test -w @zmrng/<ws>`.
- Keep `typecheck` and `lint` as-is (they already report per-workspace inline).
- Change `tail -n "$HEAD_LINES"` to `head -n "$HEAD_LINES"` so the message and
  behaviour agree — a vitest failure summary appears near the top of the failing
  file's output, while the tail is the aggregate pass count.
- Print **both** head and tail when they differ, clearly labelled, so the
  aggregate counts stay visible.

Constraint: `verify.sh` is the shared gate for the agent, `loop.sh`, and the Stop
hook. Keep the exit contract (`0` iff every step passed) and the
`=== verify summary ===` block shape — `stopValidate.test.ts` and the hook parse
around it.

### T1 — stop seeding hooks the target repo already registers

**File:** `packages/server/src/worktree.ts` (`seedHarness`, `zmrngHooksConfig`)

Before registering seeded hooks, read the target worktree's **own**
`.claude/settings.json` and collect the set of hook-script **basenames** it
already registers (across all events). Skip seeding — both the script copy and
the `settings.local.json` registration — for any harness hook whose basename is
already present.

Rationale for matching on basename rather than exact command string: the two
registrations intentionally differ by path, so only the basename is stable. A
target repo that ships its own `stop_validate.py` has deliberately opted into its
own gate, and that gate is authoritative for its repo.

Details:

- Parse defensively; a missing or malformed `settings.json` means "target
  registers nothing" and seeding proceeds unchanged (mirror the existing
  invalid-JSON tolerance at `worktree.ts:346`).
- Scan every event key (`PreToolUse`, `PostToolUse`, `Stop`, ...), not just
  `Stop` — `post_tool_use_lint.py` (2x `tsc` per edit) is the second-largest win.
- Emit one operator note per skipped hook, matching the existing notes
  convention: `harness hook <name> not seeded — target repo registers its own`.
- Escape hatch: `ZMRNG_FORCE_SEED_HOOKS=1` restores current behaviour.
- `seedHarness` already takes `targetRepoPath`, but hooks must be detected in the
  **worktree's** `.claude/settings.json` (already checked out), which is
  `worktreePath` — use that.
- Preserve idempotency: re-running `seedHarness` must stay a no-op.

**Do not** change the `info/exclude` behaviour — a skipped hook simply has no
path to exclude.

**SETTLED — `security_guard.py` is exempt from dedupe in this phase.** It stays
doubled. Rationale: it is the one hook whose absence costs safety rather than
speed, and the two copies are known to differ in source. Its duplicated cost is a
python3 process startup per tool call, not a test suite — negligible against the
measured problem. Implement the dedupe for the other four
(`stop_validate.py`, `post_tool_use_lint.py`, `branch_guard.py`,
`pr_shape_guard.py`) and hard-code `security_guard.py` on an exemption list with
a comment pointing at this decision. Revisit only after T1 is proven in
practice.

### T2 — bound vitest fork count

**Files:** `packages/server/vitest.config.ts`, `packages/web/vitest.config.ts`,
`packages/server/src/runner.ts`

In both vitest configs, set `poolOptions.forks.maxForks`, reading the value from
the `ZMRNG_VITEST_MAX_FORKS` environment variable and defaulting to **3** when it
is unset (coerce with `Number(...)`, matching how `config.ts` reads
`ZMRNG_MAX_LANES` at `config.ts:686`).

- Default **3** (down from the effective 5) so an interactive solo run stays
  fast while a single suite can no longer claim the whole box.
- `runner.ts` already builds the child environment at `runner.ts:225` (where it
  strips the metered API key). Set `ZMRNG_VITEST_MAX_FORKS` to **2** there for
  worker children, so the orchestrator bounds its fleet without slowing the
  operator's own runs.
- Add a short comment in each config explaining *why* the cap exists, in the
  style of the existing `testTimeout` comment — that comment already records
  load-induced flakes, so this is the same lesson one step further.

Note the interaction with the existing 30s `testTimeout`: capping forks makes a
single suite marginally slower in isolation but raises total fleet throughput.
The generous timeout already absorbs this.

### T4 — fix the `KbView.spaces.test.tsx` flake

**File:** `packages/web/test/KbView.spaces.test.tsx`

Two changes, both needed:

1. Make `renderKb()` await the settled tree load so no effect is left pending —
   e.g. `await waitFor(() => expect(getSpaceTree).toHaveBeenCalled())` after the
   existing `findByRole`.
2. Replace `vi.restoreAllMocks()` with `vi.clearAllMocks()`. The file creates no
   spies, so restore has no legitimate target; clearing call history is the
   actual intent, and it leaves `beforeEach`'s `mockResolvedValue` wiring intact.

Do not "fix" this by loosening `KbView.tsx` — the component's cancelled-flag
pattern is correct. The defect is in the test.

---

## Test strategy

**Command:** `npm test` (Vitest, both workspaces). Full gate:
`npm run typecheck && npm run lint && npm test && npm run build`.

| Task | Test file | What it proves |
|---|---|---|
| T1 | `packages/server/test/seedHarness.test.ts` (extend) | **RED first.** New cases: (a) a worktree whose `.claude/settings.json` registers `stop_validate.py` gets **no** `zmrng-hooks/stop_validate.py` copy and no `Stop` entry in `settings.local.json`, while the non-duplicated hooks are still seeded; (b) a worktree with no `settings.json` seeds all five, unchanged; (c) basename matching works across events (`post_tool_use_lint.py` under `PostToolUse`); (d) malformed `settings.json` falls back to seeding everything; (e) `ZMRNG_FORCE_SEED_HOOKS=1` seeds all five even when duplicated; (f) idempotency — running twice is still a no-op; (g) **`security_guard.py` is seeded even when the target registers its own** — the exemption, pinned so a refactor cannot drop it. |
| T2 | `packages/server/test/runner.test.ts` (extend) | The child environment carries `ZMRNG_VITEST_MAX_FORKS=2`. This belongs beside the existing API-key-strip test — same env-construction seam. A small assertion covers the config default of 3. |
| T3 | `packages/server/test/stopValidate.test.ts` (extend) | The summary block still parses; a failing step prints the head and names the workspace. If the existing test does not already shell out to `verify.sh`, drive the script against a temp fixture repo rather than mocking it — the bug was in the shell, so the shell is what must be covered. |
| T4 | `packages/web/test/KbView.spaces.test.tsx` | Existing 6 tests stay green. The isolation fix is verified by repetition, not a new assertion — see below. |

**T4 verification (the flake is timing-dependent, so a single green run proves
nothing):**

```bash
npx vitest run test/KbView.spaces.test.tsx --root packages/web --repeat 20
```

Then reproduce the original conditions — run the full web suite under
artificial load — and confirm green. Before the fix this file failed
intermittently under peak load; after, it must not.

**Hard rules carried from `.claude/rules/testing.md`:** no test spawns a real
`claude`, calls `gh`, or touches the network. `seedHarness` tests already drive a
real temp git repo and a fake `harness/` fixture — extend that pattern, don't
invent a new one. No coverage thresholds.

**Regression guard:** `prompts.test.ts` pins the worker-prompt contract. T1
changes *which hooks are seeded*, not prompt text, so it should stay green — if
it goes red, that is a real signal, not a test to update.

---

## Validation

```bash
npm run typecheck      # both workspaces (catches server<->web type-mirror drift)
npm run lint
npm test
npm run build
```

Then, per the App-only directive in `CLAUDE.md` — T2 touches `runner.ts`, which
is bundled into the sidecar, so a source build is **not** sufficient:

```bash
npm run desktop:build  # build -> bundle:sidecar -> tauri build -> fresh .app
```

## Acceptance criteria

1. A worker worktree targeting zmrng registers **one** `stop_validate` hook, not
   two; likewise `post_tool_use_lint`, `branch_guard`, `pr_shape_guard`.
   `security_guard` **stays doubled by design** — a test must pin that exemption
   so a later refactor cannot silently drop it.
2. A target repo with **no** hooks of its own still receives all five seeded.
3. `ZMRNG_FORCE_SEED_HOOKS=1` restores today's behaviour.
4. A failing gate names the failing workspace in the summary, and prints output
   consistent with its own "first N lines" wording.
5. `KbView.spaces.test.tsx` survives `--repeat 20` and a full-suite run under load.
6. No vitest run exceeds 3 forks locally, or 2 in a worker child.
7. Full gate green; `.app` rebuilt.

**Measured re-check (the real acceptance test):** re-run the sampler from
`.agents/notes/resource-usage-analysis.md` for 5 minutes under a comparable
workload (3 workers, tasks in flight) and compare against the recorded baseline:

| Metric | Baseline p50 | Target |
|---|---|---|
| Total CPU demand | 571% | < 400% |
| CPU PSI `some avg10` | 59.4% | < 35% |
| Peak vitest processes | 27 | <= 8 |
| Red gates per 10 min | 3 | 0 |

Record the new numbers in the notes file; do not overwrite the baseline.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A target repo's own hook is weaker than zmrng's, so skipping the seeded one reduces safety | Medium | Match on basename only — a same-named hook is a deliberate opt-in. `ZMRNG_FORCE_SEED_HOOKS=1` escape hatch. Note it in the operator log so the choice is visible, not silent. |
| `security_guard.py` skipped in error, so a worker loses its secret-file / force-push / recursive-delete protection | Low | **Resolved by design:** `security_guard.py` is exempt from dedupe and stays doubled (see T1). Pinned by a test. |
| Capping `maxForks` slows a solo interactive run | Medium | Default 3 (not 1); overridable; workers get 2 while the operator keeps 3. |
| `verify.sh` changes break `loop.sh` or the Stop hook's parsing | Medium | Preserve exit contract and summary-block shape; `stopValidate.test.ts` covers it. |
| T4's `waitFor` masks rather than fixes the race | Low | Verify with `--repeat 20` plus a real under-load run, not a single green. |

## Phase 2 (after re-measuring)

- **Fleet-wide gate serialization** — cross-worker lock or token bucket so at
  most one `verify.sh` runs at a time. Converts oversubscription into a queue:
  strictly better wall-clock *and* it eliminates the flake class outright.
- **Decouple `maxLanes` from validation concurrency** — the data says the current
  cap is tuned against the wrong resource. Agents cost 13.3% CPU total, so lane
  count could likely *increase* once gate concurrency is capped. Size this
  against the post-Phase-1 baseline.

## Context references

- `.agents/notes/resource-usage-analysis.md` — the measurements. Read first.
- `packages/server/src/worktree.ts:140-200` (`zmrngHooksConfig`), `:253` (`seedHarness`), `:339-364` (settings merge)
- `packages/server/src/runner.ts:222-242` (child environment construction)
- `packages/server/test/seedHarness.test.ts` — temp-repo + fake-harness pattern to extend
- `.claude/verify.sh`, `.claude/validate.sh`
- `packages/web/test/KbView.spaces.test.tsx`, `packages/web/src/components/KbView.tsx:295-320`
- `.claude/rules/testing.md`, `.claude/rules/coding-lifecycle.md`
