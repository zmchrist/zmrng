# Handoff: build the 2-lane parallel gauntlet driver

**For:** a fresh agent (Hermes, `projects` profile) picking this up cold.
**Author:** prior session, 2026-08-15.
**One-line goal:** widen the unattended zmrng Stage-1 gauntlet driver from
single-lane serial (one ticket at a time) to **exactly 2 parallel lanes**, so two
independent tickets build concurrently while everything else (fold-back, safety) stays
as-is.

---

## Why 2 lanes, not 3 (operator constraint — do NOT exceed)

The operator (zc) explicitly capped this at **2 lanes** because his laptop can't handle
the process load of 3. Do the math on why: each lane runs a gauntlet that itself can
fan out up to 3 builder/critic children. 3 lanes × 3 children = ~9 concurrent headless
`claude` processes — too many for this machine and likely to trip Max-OAuth rate limits.

**Hard budget for this rewrite: 2 lanes, and cap per-lane builder/critic fan-out low
(1–2 children per lane) so the worst case is ~2 lanes × 2 = 4 concurrent `claude`
processes, plus the driver = ~5.** Do not raise either number without asking zc. If you
later want more, that's a separate conversation, not a default.

---

## FIRST: two gating steps before you touch anything

1. **Wait for the in-flight H3 tick to land.** When this handoff was written a tick was
   grinding ticket **H3** (`wt-H3` on branch `gauntlet/H3`, branched off integ tip
   `4218d68`). NEVER rewire the driver mid-flight. Confirm the tick is done first:
   ```bash
   cd /Users/tiofeliz/Developer/Projects/zmrng
   ls -la .gauntlet/driver.lock 2>/dev/null   # gone = no tick running
   git worktree list                          # no wt-H3 = tick cleaned up
   git fetch origin --quiet && git ls-remote --heads origin gauntlet/integ  # tip advanced past 4218d68 = H3 folded
   ```
   If the lock exists and is fresh (mtime within ~120 min), a tick IS grinding — wait
   and re-check. Only proceed when lock is absent AND no `wt-*` ticket worktree remains.

2. **Pause the cron job so no tick fires while you edit.**
   ```
   cronjob(action="pause", job_id="23cc98edf3d4")
   ```
   Resume it (`action="resume"`) only after the rewrite is tested and you've fired one
   verification tick successfully.

---

## Current state (as of this handoff)

- **Repo:** `/Users/tiofeliz/Developer/Projects/zmrng` (npm workspaces:
  `packages/server` + `packages/web`). Read its `CLAUDE.md`.
- **Map / MAP_PATH:** `.agents/plans/zmrng-stage1-gauntlet.md` — 13 tickets
  (H1–H4, U1–U6, DB, S1, S2, A1). Each has Status / Blocked-by / Bar / Measurable half /
  acceptance checkboxes. Driver flips TODO→DONE here.
- **Delivery model = INTEGRATION-BRANCH (already in force).** One accumulator branch
  `gauntlet/integ`. Each ticket branches OFF `origin/gauntlet/integ` (carries all prior
  DONE work), builds, gates green, folds back into integ. `DONE` = "already in integ."
  Driver NEVER touches `main` per-ticket; at all-green it opens ONE PR
  `gauntlet/integ → main`. Do not regress this to per-ticket-PR mode.
- **Done so far (folded in integ):** H1, A1, DB, U1, S1, H2 (+ H3 once its tick lands).
  Superseded open PRs #26/#27/#28 (DB/U1/S1) are intentionally left OPEN — zc will not
  merge them until the whole run is reviewed. Do NOT close them.
- **The cron job:** `job_id=23cc98edf3d4`, name "gauntlet: zmrng Stage-1", schedule
  `*/30 * * * *`, `deliver=all`, workdir the repo, toolsets
  `[terminal, file, delegation, web]`, `script=zmrng-gauntlet-lock.sh` (the lock guard
  wrapper). The job PROMPT is the driver — that's the main thing you rewrite.

### Key files (all already exist — you EDIT them, don't recreate)
- **Live cron prompt** — edit via `cronjob(action="update", job_id="23cc98edf3d4",
  prompt="…")`. This is the authoritative driver the scheduler runs. It currently
  encodes single-lane integration-branch mode. **This is the primary edit.**
- **Reference prompt:** `~/.hermes/profiles/projects/skills/software-development/gauntlet-loop/references/unattended-driver-prompt.md`
  — the reusable template. Mirror the 2-lane change here.
- **SKILL.md:** `~/.hermes/profiles/projects/skills/software-development/gauntlet-loop/SKILL.md`
  — the "Unattended from a wayfinder map" + "Hardware cap + overwrite guardrails"
  sections. Document 2-lane parallelism as a delivery/throughput option with the process
  budget and the file-overlap caveat.
- **Blocking-headless-claude wrapper:** `…/gauntlet-loop/scripts/gauntlet-claude.sh`
  `<worktree-dir> <model> <prompt-file>` — spawns a BLOCKING `claude -p`, strips
  `ANTHROPIC_API_KEY` (Max OAuth), prints child's final text. Builders/critics MUST use
  this, never `delegate_task` (background/non-durable in cron — the original bug this
  whole driver was rewritten to avoid). Reuse as-is.
- **Lock guard:** `…/gauntlet-loop/scripts/gauntlet-lock.sh`
  `acquire|touch|release <workdir> [stale_min]` — singleton mtime lock. The cron
  `script` field already calls `acquire`; heartbeat with `touch` between rounds; the
  driver `release`s at exit.

---

## The design: 2-lane parallelism

### What parallelizes safely, and what must NOT
- **Parallelize:** the BUILD stage of two mutually-independent frontier tickets whose
  file sets are **disjoint**. Each lane = its own git worktree + branch off the current
  `gauntlet/integ` tip, its own gauntlet (builder/critic subprocesses), its own gate.
- **Serialize (never race):** the **fold-back into `gauntlet/integ`**. Two merges into
  integ at once WILL corrupt it. After both lanes finish, fold them in **one at a time**,
  re-running the gate on integ after each fold. This is the single most important
  invariant of the rewrite.

### Lane selection (the disjoint-file rule)
The map has ~3 natural file-disjoint lanes:
- **H-lane** (harness/hooks: H2→H3→H4) — touches `harness/`, `worktree.ts`, hooks.
- **U-lane** (UI: U1→U2→U3→U4→U5→U6) — touches `packages/web/**`, heavy shared-file
  overlap *within* the lane (App.tsx, App.module.css, theme.css).
- **S-lane** (auth/packaging: S1→S2) — touches auth/preflight/packaging.

Rule the driver must apply each tick:
1. Compute the frontier (all TODO tickets whose blockers are all DONE-in-integ).
2. Group frontier tickets by lane (H / U / S).
3. Pick **at most 2 tickets from 2 DIFFERENT lanes** with disjoint file sets. Never run
   two tickets from the same lane in parallel (they share files → fold-back conflict).
   Never run more than 2 total.
4. If only 1 frontier ticket is available (or only one lane has work), run 1 lane — that's
   fine, it degrades cleanly to the current serial behavior.

Within a lane, tickets stay strictly serial across ticks (U2 before U3, etc.), exactly
as the blocking edges already dictate.

### Per-tick flow (2-lane)
1. **Lock check** (unchanged) — BUSY→exit; ACQUIRED/STALE-STEAL→proceed.
2. **Read map, compute frontier, pick ≤2 disjoint-lane tickets** (above).
3. **Isolate each lane:** `git worktree add ../wt-<id> -b gauntlet/<id>
   origin/gauntlet/integ` (fallback `origin/main` only if integ doesn't exist yet).
4. **Run both gauntlets concurrently:** for each lane, launch its builder/critic via
   `gauntlet-claude.sh` through `terminal(background=true)`, then a
   `process(action='wait')` loop that heartbeats the lock
   (`gauntlet-lock.sh touch <repo>`) each iteration. Keep per-lane fan-out ≤2 children.
   Wait on BOTH lanes to reach a critic-win (or MAX_ROUNDS=6 fuse → mark that ticket
   `needs-human`, continue with the other).
5. **Gate each lane's worktree green** (`typecheck && lint && test && build`) before it's
   eligible to fold.
6. **Fold SEQUENTIALLY into integ** (never concurrent): fold lane A → re-gate integ →
   push; then fold lane B → re-gate integ → push. Resolve any fold conflict in favor of
   the newest ticket's intent, keep integ green. Mark each ticket DONE with the integ
   merge SHA.
7. **Cleanup + release:** remove both ticket worktrees + any scratch integ worktree,
   `gauntlet-lock.sh release`, exit silently.
8. **All-green done check:** unchanged — when no TODO-unblocked tickets remain, open the
   single `gauntlet/integ → main` PR and post the one final ping.

### Safety invariants that MUST survive the rewrite (check each after editing)
- Builders write; critics are READ-ONLY.
- Builder/critic are BLOCKING `gauntlet-claude.sh` subprocesses — never `delegate_task`.
- Worktree-per-ticket isolation; lanes have disjoint file sets.
- Fold-back into integ is SERIAL, gate-green-before-fold, never concurrent.
- Never push to / merge `main` per-ticket; the only main-facing action is the final PR.
- Singleton lock still guarantees ONE driver process (the 2 lanes are children OF that
  one driver tick, not 2 drivers). The lock is unchanged.
- server↔web `types.ts` manual mirror kept in sync (every type change touches both).
- MAX_ROUNDS=6 fuse per piece; process budget ≤ ~5 concurrent claude procs total.

---

## Verify the rewrite before handing back to the schedule
1. With the job still paused, fire ONE manual tick: `cronjob(action="run",
   job_id="23cc98edf3d4")`. Expect the `run` call to hit the ~300s client idle timeout —
   that's benign; the tick keeps grinding server-side. Verify by inspecting git, not by
   the tool return.
2. Confirm: two `wt-*` worktrees appeared (2 lanes), both branched off the integ tip;
   both folded into integ sequentially; integ tip advanced by 2 tickets; both tickets
   marked DONE with SHAs; lock released; no leftover worktrees.
3. Run the full gate on the new integ tip in a scratch detached worktree to capture fresh
   verification evidence (pattern the prior session used:
   `git worktree add ../wt-verify origin/gauntlet/integ --detach`, `npm install`,
   `npm run typecheck && npm run lint && npm test && npm run build`, then
   `git worktree remove ../wt-verify --force`).
4. If green, `cronjob(action="resume", …)` and report. If the tick misbehaved (raced the
   fold, spawned too many procs, conflicted), fix before resuming — a broken parallel
   driver corrupting integ is worse than the serial one.

## Known gotchas (from the session that built the current driver)
- Synchronous `cronjob(action="run")` blocks the MCP server for the whole tick; the
  client aborts at 300s but the tick completes. Always verify via git state, never the
  tool's timeout.
- The U-lane's tickets share App.tsx/App.module.css/theme.css heavily — that's why they
  must stay serial within the lane. The earlier manual integ build hand-resolved 8
  conflicts across those exact files; don't let two U-lane tickets run together.
- `deliver=all` logs "no delivery target resolved" on CLI runs — harmless, it just means
  no gateway channel is wired for this local session.
