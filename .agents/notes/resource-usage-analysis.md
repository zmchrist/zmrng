# Resource usage analysis — worker fleet contention

Sample: 60 points @ 5s = 5 minutes, 2026-09-20 22:56–23:01 local, while the
operator created and drove tasks through workers.
Raw logs: `/tmp/zmrng-perf/{load,mem,ps,agg,counts,psi}.log`.

Machine: 6 cores, 31 GB RAM, 8 GB swap, 98 GB disk (20% used).

---

## Headline

**CPU is the only saturated resource, and ~85–90% of the demand is the test
runner — not the agents.**

| Metric | p50 | p90 | max |
|---|---|---|---|
| Total CPU demand (capacity = 600%) | **571%** | **685%** | **858%** |
| Load average (1m) | 11.71 | 13.02 | 13.37 |
| CPU PSI `some avg10` | **59.4%** | 76.9% | 81.8% |
| IO PSI `some avg10` | 0.00 | 0.00 | 0.18 |

- At p90 the box is asked for **685% of 600%** available. Oversubscribed ~2x
  sustained; load never dropped below 8.99.
- CPU pressure p50 **59%** — most of the time, most runnable work is stalled
  waiting for a core.
- **IO pressure is effectively zero.** Disk is not involved.
- Memory used: mean 3.2 GB, max 3.8 GB of 31 GB. **Swap never touched.**

## Where the CPU actually goes

Mean CPU% and RSS per process family across the window:

| Family | mean CPU% | mean RSS | mean count |
|---|---|---|---|
| `node (vitest 1..5)` (forks) | **343.8%** | 874 MB | 8.8 |
| `node` (unlabelled workers/tsc) | 134.0% | 331 MB | 2.7 |
| `node (vitest)` (parents) | 35.2% | 297 MB | 2.0 |
| `npm run test` | 5.4% | 222 MB | 3.5 |
| **claude workers** | **13.3%** | 927 MB | 3.0 |
| esbuild / python3 hooks / npm / tsc | ~12% | small | — |

**The agents are nearly free.** Three live `claude` workers consume **13.3% CPU
total** (~4% of one core each) and ~310 MB each — they are I/O-bound waiting on
the API. Meanwhile vitest alone accounts for roughly **510% of the 571% p50
demand**.

Process counts (min/mean/max) over the window:

    vitest   1 / 13.9 / 27
    claude   3 /  3.0 /  4
    esbuild  0 /  2.0 /  4
    tsc      1 /  1.6 /  5

**Implication: throttling workers is the wrong lever. Throttling validation is
the right one.** More agents cost almost nothing; each agent's *turn-stop gate*
costs ~1.7 cores.

---

## Root cause 1 — the validation gate runs twice per worker turn

Worker worktrees wire the Stop hook **twice**:

| File | Hook | Timeout |
|---|---|---|
| `worktrees/<id>/.claude/settings.json` | `.claude/hooks/stop_validate.py` (target repo's own) | 180s |
| `worktrees/<id>/.claude/settings.local.json` | `.claude/zmrng-hooks/stop_validate.py` (zmrng-seeded) | 120s |

zmrng is its own target repo, so every worker inherits both, and they run the
**identical** `verify.sh --fast` (typecheck + lint + test over both workspaces).

Observed in worktree `ca1e9d61`: three concurrent `verify.sh --fast` processes
(PIDs 654924, 656099, 657927) plus a fourth `stop_validate.py` from a
`/tmp/zmrng-seed-repo-*` dir. Pure duplicated work.

## Root cause 2 — vitest is unbounded and assumes it owns the box

Neither `packages/server/vitest.config.ts` nor `packages/web/vitest.config.ts`
sets `poolOptions`. Vitest defaults to `maxForks = cores - 1 = 5`, so every run
claims 5 forks regardless of what else is running.

### Amplification

    3 live claude workers
      x 2 Stop hooks (duplicate gate)
      x 2 workspaces (server + web, run sequentially by npm)
      x 5 vitest forks (unbounded default)
    => sampled peak 27 vitest processes on 6 cores

## Root cause 3 — the lane cap does not bound validation

`config.maxLanes` (default 2, `ZMRNG_MAX_LANES`) bounds *agent* lanes but not
the processes agents spawn. The cheap resource (agent sessions, 13% CPU) is
capped; the expensive one (test forks, ~510% CPU) is governed by nothing.

---

## Consequence — load-induced flakes, three times in ~10 minutes

Both observed live this session on a clean tree at HEAD `45a779b`:

**Flake 1 (web).**

    KbView.spaces.test.tsx > hides the "New space" button for a read-only viewer
    TypeError: Cannot read properties of undefined (reading 'then')
      at src/components/KbView.tsx:312  (api.getSpaceTree(spaceId).then(...))

Not a regression — file alone 6/6 (4.0s); full web suite once load eased
**51/51 files, 494/494 tests** (22.1s).

The tell is in the timings of the same 51-file suite:

| Run | Result | Duration | `environment` (summed across forks) |
|---|---|---|---|
| under peak load | 1 failed | 28.26s | **73.65s** |
| after load eased | 51/51 | 22.11s | 57.26s |

`getSpaceTree` being undefined points at module-mock bleed between test files
sharing a fork. Which files land on which fork depends on pool scheduling, and
scheduling shifts under load. **Contention does not merely slow the suite — it
reshuffles fork assignment and surfaces a latent isolation bug as an
intermittent failure.**

**Flake 2.** A gate reported `FAIL test` while displaying 51/51 web passes.

**Flake 3.** Same shape again ~3 minutes later, at *lower* load (web suite 15.7s
vs 29.6s at peak) — so the flake window is not confined to the worst contention.

**Verification that none of the three is a regression.** On the same clean tree:

| Command | Exit | Result |
|---|---|---|
| `npm run test -w @zmrng/server` | 0 | 22 files, 479 tests passed |
| `npm run test -w @zmrng/web` | 0 | 51 files, 494 tests passed |
| `bash .claude/verify.sh --fast` | **0** | PASS typecheck / PASS lint / PASS test |

`packages/desktop` has no `test` script, so `--workspaces --if-present` covers
exactly those two. Flakes 2 and 3 are attributable to the **server** workspace
by elimination (npm runs server first, web second; web printed green in both
tails, and overall was red).

Flake frequency observed: **3 red gates in ~10 minutes, zero reproducible.**

Cost per flake: a red gate blocks the worker turn, the worker burns a round
chasing a phantom regression, and that round adds more load. Self-reinforcing.

## Root cause 4 — `verify.sh` hides which workspace failed

`.claude/verify.sh` captures the combined output of `npm run test --workspaces`
(server then web concatenated) and on failure prints:

    echo "FAIL: npm run $step (first $HEAD_LINES lines)"
    echo "$out" | tail -n "$HEAD_LINES"

Two defects:

1. It says "first N lines" but runs `tail` — it prints the **last** 40.
2. Because web runs last and passed, a **server** failure is scrolled off
   entirely. Flake 2 presented as "FAIL test" above a wall of green.

This is why flakes 2 and 3 each took extra commands to localize — every red gate
presented as a wall of green with no indication of which workspace failed.
Cheap fix, high debugging value, independent of any resource work.

A second-order cost: a masked failure is indistinguishable from a real one, so
the only safe response is to re-run the whole suite — which adds ~1.7 cores of
load and makes the next flake more likely.

## Latent bug worth fixing on its own merit

`packages/web/test/KbView.spaces.test.tsx` depends on another test file's `api`
mock; under a different fork assignment `api.getSpaceTree` is undefined. A real
isolation defect currently masked by lucky scheduling.

---

## Optimization candidates (for the plan)

Ordered by value/effort. Estimates are against the p50 571% demand.

1. **Drop the duplicate Stop hook** — when target repo == zmrng, the seeded
   `zmrng-hooks/stop_validate.py` is redundant with the repo's own. Roughly
   **halves gate cost (~-285% CPU)**. Cheapest, largest win, near-zero risk.
2. **Bound vitest** — set `poolOptions.forks.maxForks` (2–3) in both configs, or
   drive it from an env var the orchestrator sets per worker. Caps the blast
   radius of any single run.
3. **Serialize the gate fleet-wide** — cross-worker lock or token bucket so at
   most one `verify.sh` runs at a time; workers queue instead of piling on.
   Turns a 2x oversubscription into a queue, which is strictly better for
   wall-clock *and* eliminates the flake class.
4. **Make lanes account for validation**, not just live agent sessions — or
   decouple: raise `maxLanes` (agents are cheap) while capping concurrent gates.
5. **Fix `verify.sh` failure reporting** — per-workspace steps, and `head` to
   match its own message.
6. **Fix the `KbView.spaces.test.tsx` isolation defect** so the gate stops
   producing false reds.

Note the direction of 4: the data says the current cap is tuned against the
wrong resource. Agent concurrency could likely *increase* if validation
concurrency were capped.
