---
name: resource-optimization
description: Measure, attribute, and fix system resource contention (CPU/memory/IO) while a real workload runs — profiling the worker fleet, diagnosing a slow or saturated box, chasing load-induced test flakes, or tuning concurrency caps. Use when asked to "analyze resource usage", "optimize CPU/memory", "why is the machine slow", "why do tests flake under load", or before changing a lane cap, fork count, or parallelism setting. Produces a measured baseline, a root-cause note, and a plan whose acceptance criteria are re-measured numbers.
---

# resource-optimization

The loop that turns "the box feels slow" into a defensible plan. Five steps,
in order. **Do not skip step 2** — it is the step that reliably overturns the
obvious guess.

    1. SAMPLE    measure under a real workload, in the background
    2. ATTRIBUTE which process family owns the demand (not which one you assume)
    3. ROOT-CAUSE read the code until the mechanism is proven, not inferred
    4. PLAN      fixes ordered cheapest-first, with re-measured acceptance
    5. RE-MEASURE compare against the recorded baseline; append, never overwrite

## 1. Sample

```bash
.claude/skills/resource-optimization/scripts/sample.sh /tmp/zmrng-perf 60 5 &
```

Rules that keep the data honest:

- **Run it in the background and let the real workload proceed.** A benchmark
  invented for the occasion measures the benchmark. Ask the operator to keep
  doing what they were doing.
- **Sample for minutes, not seconds.** Contention is bursty; a single `top` is
  an anecdote.
- **Record capacity first** (`nproc`, total RAM). Every conclusion is a ratio
  against capacity, and `sample.sh` writes it to `meta.txt`.
- Take a baseline snapshot before starting so you can spot a workload that
  changed mid-sample.

## 2. Attribute

```bash
.claude/skills/resource-optimization/scripts/analyze.sh /tmp/zmrng-perf
```

Read it in this order — the order matters, because each answer narrows the next:

1. **Which resource is stalling?** PSI `some avg10` for cpu / io / memory. Load
   average alone cannot distinguish a CPU-bound box from an IO-bound one. If
   `io` is ~0 and `cpu` is high, stop thinking about disk. If swap is untouched
   and headroom is large, stop thinking about memory.
2. **Total demand vs capacity.** Percentiles, never the mean — the mean hides
   the saturation spikes that cause the failures. Demand above 100% of capacity
   is oversubscription, and the excess is pure queueing.
3. **Attribution by command family.** The top line is usually not what you
   expected. Compare CPU *and* process count: many cheap processes and one
   expensive one demand different fixes.

**The question that reframes the problem:** is the thing you were about to
throttle actually the thing consuming the resource? In the zmrng case the answer
was no — `claude` agents cost 13.3% CPU total while the test runner they trigger
cost ~510%. Throttling agents would have made things slower for no gain. Check
this before proposing any cap.

## 3. Root-cause

Attribution says *what*. Only reading the code says *why*. Carry each candidate
to a proven mechanism — file and line — before it earns a place in the plan.

- Prefer a config/wiring explanation over a code-is-slow explanation. Unbounded
  defaults (a test pool sized to all cores), duplicated work (the same hook
  registered in two files), and missing dedupe are the common causes.
- **State the mechanism precisely enough to be wrong.** Write down why the
  existing guard does not already prevent it. If you cannot, you have a
  hypothesis, not a root cause.
- When a first hypothesis fails to survive the code, **say so in the note and
  correct it.** A plan built on a plausible-but-wrong mechanism fixes nothing.

### Load-induced flakes are a resource symptom

Intermittent test failures under contention are usually not "flaky tests" in the
hand-wave sense. Contention changes scheduling, which changes timing and
work-to-worker assignment, which surfaces latent ordering or teardown bugs.
Treat each one as a real defect **plus** evidence of the contention.

Prove a suspected flake is not a regression before spending a round on it:

```bash
git status --short                      # is the tree actually clean?
npx vitest run <file> --root <pkg>      # does it pass in isolation?
npm run test -w <workspace>             # does the full suite pass when load eases?
--repeat 20                             # does the fix hold, or did you get lucky once?
```

A single green run proves nothing about a timing-dependent failure.

## 4. Plan

Write to `.agents/plans/<slug>.md` per `.claude/rules/planning-workflow.md`.

- Order fixes **cheapest-first by value/effort**, and make each one
  independently revertible.
- Put diagnosability first. If a gate hides which component failed, fix that
  before the performance work — otherwise every later step is debugged blind.
- Quantify each fix against the measured baseline ("~halves gate cost, -285%
  CPU"), not adjectivally.
- Record settled decisions in the plan itself so they are not re-litigated.
- Note second-order costs. A masked failure forces a full re-run, which adds
  load, which causes the next failure — name these loops explicitly.

## 5. Re-measure

**The acceptance criteria are numbers, not impressions.** Re-run `sample.sh`
under a comparable workload and compare to the recorded baseline:

| Metric | Baseline | Target |
|---|---|---|
| Total CPU demand p50 | … | … |
| CPU PSI `some avg10` p50 | … | … |
| Peak process count (the guilty family) | … | … |
| Failures per unit time | … | 0 |

Append the new run to the notes file; **never overwrite the baseline** — the
before/after pair is the evidence that the change worked.

## Output artifacts

- `.agents/notes/<slug>.md` — measurements, root causes, raw log paths. Written
  during steps 1-3, and the plan cites it rather than restating it.
- `.agents/plans/<slug>.md` — the plan, per the repo's normal planning workflow.

## Notes

- Operator-harness only. This is a diagnostic loop for the person running the
  fleet, so it lives in `.claude/skills/` and is deliberately **not** mirrored
  into `harness/skills/` (which is seeded into every worker worktree).
- `sample.sh`'s `counts.log` line lists the process families to track. Edit it
  for the fleet you are profiling — it is the one workload-specific part.
- PSI requires Linux (`/proc/pressure/*`). On a kernel without it the pressure
  section is simply empty; fall back to load average vs core count, and lean
  harder on the attribution table.
