# ADR-0003 — Gauntlet loop (the Loop tab)

- **Status:** Implemented (branch `feat/zmrng/loop-1fd592c2`)
- **Date:** 2026-10-01
- **Deciders:** zc
- **Plan:** `.agents/plans/gauntlet-loop-tab.md`
- **Credit:** the technique is the *gauntlet loop* from robonuggets/gauntlet-loop
  (CC-BY-4.0), itself after Matt Shumer's "Claude of Duty". zmrng reimplements the
  loop server-side; no code or skill from the source is invoked or vendored.

## Context

The operator wants to run a whole map of GitHub-issue tickets (an epic's sub-issues)
to completion with minimal supervision, using the gauntlet technique: per ticket, a
fresh BUILDER builds; a separate, fresh, READ-ONLY CRITIC does a blind binary A/B
against the ticket's named **bar** and names the single biggest gap; a loss feeds
that gap into the next builder round; a WIN moves on to validate → sync docs → a fold
into an integration branch. A round fuse parks a ticket for a human.

Before this, the loop ran as a bash supervisor plus a cron watchdog on the operator's
laptop: invisible to zmrng's UI, with a static lane count that was wrong on one host
or another (the laptop cannot take 3 lanes; another host can).

## Decision

A new **Loop** mode in the desktop app, owned by a new server module `LoopManager`
(`packages/server/src/loop.ts`) with its own REST surface (`/api/loop/*`), three
additive SQLite tables, and a fixed three-region view (orchestrator chat ⅓ left;
lane cards and the ticket DAG on the right).

1. **D1 — A separate `LoopManager`, not Task rows.** `TaskManager` drives one
   long-lived session through plan → execute → validate → scan → PR; the gauntlet
   needs a fresh context per step, a builder/critic loop with a round fuse, serial
   folding, and no per-ticket PR. Reusing Task rows would bend the repo's
   highest-value state machine and pollute the Task list. `phases.ts` is only
   imported from (style directive, PR-body contract, `PR_RE`); its behaviour and its
   lane code are untouched.
2. **D2 — The orchestrator acts through loopback REST via `curl` tool calls.** Not
   control tokens in prose (a known false-positive source) and not MCP (a new
   protocol surface plus `--mcp-config` plumbing — deferred). Every action lands on a
   route that validates its input and is unit-tested with `app.inject()`.
3. **D3 — Loop lanes have their own pool.** A global in-memory pool capped at
   `LOOP_MAX_LANES = 3` across *all* Loop runs, separate from the task execute-lane
   cap (`config.maxLanes`). Loop lanes never count against, and are never shown in,
   the task Lanes tab. The first draft shared the task cap; the operator overruled it
   and accepted that Loop lanes plus task lanes can mean 8+ `claude` processes.
4. **D4 — Integration branch per run, serial folds, one final PR.** Every ticket
   branches off `gauntlet/<run8>/integ` at pick time and folds back serially under a
   per-run mutex. The **server** pushes integ only after a machine-asserted fold
   (ticket tip is an ancestor of integ HEAD, integ tree clean); never forced, never
   `main`. When every non-skipped ticket is done, one PR integ → default branch is
   opened by a separate PR agent with `--body-file` (never `--fill`). Never
   auto-merged.
5. **D5 — Blind binary A/B with server-randomized labels.** The critic sees two
   neutrally-described candidates labelled A and B; the server randomizes which label
   is the ticket's work and maps the critic's letter to WIN/LOSE. A tie or an
   unparseable answer is a LOSE (the work must *beat* the bar). `MAX_ROUNDS = 6`
   parks the ticket `needs-human`. A ticket with no bar is never picked.
6. **D6 — The final PR passes the existing deterministic security scan,
   fail-closed.** Red or a scanner error leaves the run `blocked` with the findings
   relayed to the orchestrator. Deliberately **no automatic security-fix rounds** in
   v1: the operator adds a fix ticket (which reopens the map) or fixes it by hand. A
   future fix-round feature must not assume the task pipeline's RED → FIX loop exists
   here.
7. **D7 — Lane count chosen by the orchestrator from real machine load; the server
   hard-gates new picks.** `GET /api/loop/load` reports cores, the 1-minute load
   average per core, and *available* memory (Linux `MemAvailable`; macOS free +
   inactive + speculative + purgeable pages from `vm_stat`, because `os.freemem()`
   under-reports on macOS). The orchestrator reads it to choose 0–3 lanes; on top of
   that, the server defers every NEW pick while load per core exceeds
   `ZMRNG_LOOP_MAX_LOAD_PER_CORE` (default 1.0) or available memory is under
   `ZMRNG_LOOP_MIN_FREE_MEM_MB` (default 2048). The gate only defers picks: it never
   kills in-flight work and never rewrites the run's lane target. The orchestrator is
   notified once per deferral episode; a pump timer (`ZMRNG_LOOP_PUMP_INTERVAL_MS`,
   default 30 s) re-checks.

Every step is a fresh `claude` child spawned through the existing `RunnerFactory`
seam, so the `ANTHROPIC_API_KEY` strip holds by construction and the engine tests
stay hermetic. All decision logic (frontier, pick order, verdict mapping, token
parsing, load assessment, map layout) lives in pure modules.

## Consequences

- One UI surface replaces the laptop supervisor + watchdog; run state survives an app
  restart (a live run reboots `stale` and resumes like Restart-agent).
- Machine assertions bracket every agent claim (builder committed and left a clean
  tree; critic left HEAD and the tree untouched; fold verified before the push).
- **Costs accepted:** a higher worst-case process count (D3), bounded in practice by
  the load gate (D7); finished runs kill their orchestrator so idle runs hold no
  process. A red final scan needs a human or a new ticket (D6). The critic cannot be
  literally blind (it fetches the bar itself); "blind" is enforced by neutral prompts
  and server-side label randomization. The phone shell never shows the Loop mode.

## Rejected alternatives

- **Each ticket as a zmrng Task** — see D1.
- **A bash supervisor + cron watchdog** (the laptop setup) — duplicates zmrng's
  supervisor, persistence, lane cap and UI, invisibly.
- **Prose control tokens or MCP for the orchestrator** — see D2.
- **Sharing the task execute-lane cap** — overruled by the operator (D3).
- **A static lane cap with no load reading** — wrong on one host or another (D7).
- **An advisory-only load reading** — depends on the model's diligence; the gate is
  the enforcement point (D7).
- **`os.freemem()` as the memory reading** — reads a few hundred MB on a healthy Mac
  and would block every pick (D7).
