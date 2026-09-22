# Scope the `--fast` gate to the workspaces a turn actually changed

## Problem

Every worker turn-end runs `verify.sh --fast`, which runs the full test suite
for **both** workspaces regardless of what the turn touched. Measured on cora
(6 cores, idle-ish):

| Step | Wall | Share of gate |
|------|------|---------------|
| typecheck | 6.5s | 10% |
| lint | 9.3s | 15% |
| test:server | 9.5s | 15% |
| **test:web** | **36.9s** | **59%** |

Total ~62s wall, ~145 CPU-seconds, paid per turn per worker.

The web suite's cost is dominated by environment construction, not by the tests:
a run reports `tests 8.00s` against `environment 37.55s` — 54 files each build a
fresh jsdom. Two cheaper-looking fixes were measured and rejected:

- **`pool: 'threads'`** — appeared 45% faster, but only because the unflagged run
  used a higher default concurrency. At equal concurrency (the worker's cap of 2)
  it is 31–33s vs 35–36s, roughly 10%. Not worth a pool change.
- **`isolate: false`** — 8.4s (4x faster), but 81 of 519 tests fail: the suite
  genuinely depends on per-file isolation. Worth pursuing separately as a test
  hygiene project; out of scope here.

So the remaining lever is not making the web suite faster — it is not running it
when the turn never touched web.

## Approach

In `verify.sh`, **only under `--fast`**, compute the set of changed paths and
drop `test:server` / `test:web` when that workspace has no changes.

Change detection is the union of:
- uncommitted changes (`git status --porcelain`)
- commits on the branch (`git diff --name-only $(git merge-base HEAD origin/main) HEAD`)

Each changed path is classified:

| Path | Requires |
|------|----------|
| `packages/server/**` | server |
| `packages/web/**` | web |
| `.agents/**`, `docs/**`, any `*.md` | nothing (inert) |
| anything else (root configs, `.claude/**`, workflows) | **both** (conservative) |

`typecheck` and `lint` always run for both workspaces — they are 26% of the gate
and `typecheck` is what catches server↔web type-mirror drift, which is exactly
the failure mode scoping could otherwise hide.

**Fail-safe in every ambiguous case**: not a git repo, `git` missing, no
`origin/main` ref, merge-base failure, or an empty change set → run both
workspaces. The optimisation may only ever *remove* work it can positively prove
is unnecessary.

The full gate (`verify.sh` with no flag — the pre-PR run, which also builds)
is **never** scoped. So the last gate before a PR still runs everything.

Override: `ZMRNG_VERIFY_NO_SCOPE=1` restores unconditional behaviour.

### Alternative rejected

*Cache test results by content hash and skip unchanged suites.* More general, but
needs a cache location, invalidation, and a correctness story for flaky/ordering
effects. Path-based scoping is dumber, auditable in a summary line, and fails
safe. Revisit only if scoping proves insufficient.

## Expected effect

A server-only or docs-only turn drops from ~62s to ~25s wall and from ~145 to
~57 CPU-seconds — roughly **60% off the most common turn-end**. A turn touching
both workspaces is unchanged.

## Test strategy

Command: `npm run test -w @zmrng/server`

File: `packages/server/test/stopValidate.test.ts`, extending the existing
`describe('verify.sh')` block and its temp npm-workspaces fixture. The fixture
gains an optional git repo plus a way to stage changed paths.

| Case | Proves |
|------|--------|
| server-only change | `test:web` skipped, `test:server` runs |
| web-only change | `test:server` skipped, `test:web` runs |
| both changed | both run |
| docs-only (`.agents/**`) change | both skipped |
| root config change (e.g. `package.json`) | both run — conservative branch |
| non-git directory | both run — fail-safe |
| `ZMRNG_VERIFY_NO_SCOPE=1` | both run despite a scoped change set |
| full gate (no `--fast`) | both run despite a scoped change set |

The existing verify.sh cases must stay green: their fixture is not a git repo,
so they exercise the fail-safe path and should be unaffected.
