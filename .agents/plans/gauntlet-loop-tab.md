# Plan: Loop tab — a gauntlet loop over a GitHub ticket map

**Branch:** `feat/zmrng/loop-1fd592c2` (already checked out; never `main`).
**Scope type:** new feature, server + web + type mirror. Desktop rebuild required
(`npm run desktop:build`, or `build` + `bundle:sidecar` on a host without Rust).

## Goal

Add a **Loop** mode to the desktop app. In it the operator runs a *gauntlet loop*
over a map of GitHub-issue tickets until the map is complete:

- **Left, full height, ⅓ width:** a persistent **orchestrator** `claude` session the
  operator chats with. Its tool calls (`curl` against a loopback REST surface, plus
  `gh`) drive the run: start/stop lanes, reorder ticket priority, answer lane
  questions, edit tickets on GitHub and refresh the map.
- **Right, top:** up to **3 lane windows**, one per in-flight ticket. Each card shows the
  ticket, its current step (executing / reviewing / validating / finishing / folding),
  the gauntlet round, tokens used, elapsed time, model, and its latest activity line.
- **Right, below the lanes:** the **ticket map**, a dependency DAG built from GitHub's
  native "blocked by" links. Done tickets have a checked checkbox and open ones stay
  unchecked. A header shows the percentage of tickets completed.

### Settled scope (from clarify, do not re-ask)

- The loop logic is **reimplemented in zmrng**; the operator's laptop skill is not
  invoked. Source technique: robonuggets/gauntlet-loop (CC-BY-4.0, after Matt Shumer's
  "Claude of Duty"). The source must be credited in the docs.
- **Tickets:** GitHub issues. A run's map is the **parent/epic issue's sub-issues**
  (falling back to `#N` references in the epic body's task list). Dependencies come
  from GitHub's issue-dependency "blocked by" links. Each ticket's **bar** (the named
  reference to beat) lives in the ticket body.
- **Per ticket, fresh agent per step:** a BUILDER builds. A separate, fresh, READ-ONLY
  CRITIC does a blind binary A/B against the bar and names the single biggest gap. A
  loss feeds the gap into the next builder round. A ticket exits on a **WIN**, and a
  `MAX_ROUNDS = 6` fuse parks it as `needs-human`. After the win: validate, then sync
  docs, then fold into the integration branch.
- **Delivery (operator choice 1b):** every ticket branches off a per-run integration
  branch and folds back into it **serially**. At the end there is **one PR integ → the
  default branch**. Never auto-merge, and never touch `main` per ticket.
- **Lanes (revised in the second clarify session; supersedes the earlier shared-cap
  decision):** Loop lanes have their **own pool, separate from the task execute-lane
  cap** (`config.maxLanes`). The pool holds at most **3 lanes in total across every
  Loop run at once** (`LOOP_MAX_LANES = 3`), not 3 per run. Loop lanes never count
  against, and are never shown in, the task Lanes tab. The operator accepted that Loop
  lanes plus up to 4 task lanes can mean 8 or more `claude` processes at once.
- **Lane count is the orchestrator's call, informed by real machine load.** The
  orchestrator chooses how many lanes to run (0–3) from the ticket map *and* an actual
  CPU and memory reading the server exposes (`GET /api/loop/load`). On top of that
  advisory reading, the server enforces a **hard gate on new picks** (decided in this
  plan, see D7): a new lane is not started while the machine is over the configured
  load or under the configured available-memory floor. In-flight steps are never
  killed by the gate. The operator can still override the lane count from the header.
- **Orchestrator:** a persistent `claude` session whose tool calls drive the lanes.
  "Reorder" changes pick priority among *unblocked* tickets only, and dependencies stay
  authoritative. "Edit ticket list" means editing GitHub issues (title, body,
  blocked-by links) and adding or removing tickets from the run.
- **Bar rule is strict:** a ticket with no bar is never picked. It parks
  `needs-human` until the operator or the orchestrator adds a bar. There is no
  fallback to acceptance criteria.
- **Issues already closed on GitHub** show as done (checked) from the start.
- **Runs:** one run is open in the view at a time, with a picker for older runs.
- **Layout:** fixed. No dragging or resizing.
- **Persistence:** run state survives an app restart. On reboot a live run is marked
  `stale` and the operator resumes it, mirroring Restart-agent.
- **Out of scope:** auto-merge, the phone layout (Loop is desktop-only; the phone shell
  never shows it), changes to the Workspace tab, attachments in the orchestrator chat,
  editing the existing task pipeline's behavior, a per-repo configurable validation
  command, and automatic security-fix rounds.

## Grill (approach interrogation)

**Simplest thing that works.** A new server module, `LoopManager`, owns a run's state
machine. It spawns fresh `claude` children per step through the **existing
`RunnerFactory` seam**, the same one `TaskManager` and `ChatManager` use. The API-key
strip therefore holds by construction, and the engine tests stay hermetic. All
decision logic (frontier, pick order, verdict mapping, token parsing, map layout,
percent) lives in **pure modules** so it can be unit-tested without processes.

**Rejected alternative 1: make each ticket a zmrng `Task` and reuse `TaskManager`'s
pipeline.** `TaskManager` drives one *long-lived* session through
plan → execute → validate → scan → PR. The gauntlet needs a *fresh* context per step,
a builder/critic loop with a round fuse, serial folding into an integration branch, and
no per-ticket PR. Bending `TaskManager` to that would rewrite the repo's
highest-value state machine. Ticket rows would also pollute the Task list, and
Done/Cancel/Restart would act on them with the wrong semantics. Rejected.

**Rejected alternative 2: a bash supervisor plus cron watchdog, like the operator's
laptop setup.** zmrng is already a long-lived supervisor with persistence, a lane cap,
and a UI. A second process tree would duplicate all of that and be invisible to the UI.
Rejected.

**Rejected alternative 3: the orchestrator drives lanes through control tokens in its
prose.** That is cheap to parse, but the operator explicitly asked for *tool calls*.
Tokens quoted in prose are also a known false-positive source (see the `READY_RE`
near-miss tests). The orchestrator instead calls a small loopback REST surface with
`curl` (Bash tool). Every action lands on a route that validates input and is
unit-tested with `app.inject()`. An MCP server would also work, but it means a new
protocol surface and `--mcp-config` plumbing through `Runner`. Rejected for v1.

**Rejected alternative 4: share the task execute-lane cap (`config.maxLanes`).** This
was the first draft's choice (an external-lane API on `TaskManager`). The operator
overruled it: Loop lanes get their own pool. That also keeps the task pipeline
untouched, which is in scope's favour: `phases.ts` gains no lane code at all. The cost
is a higher worst-case process count, which the operator accepted and which the
load gate (D7) bounds in practice.

**Rejected alternative 5: a static lane cap with no load reading.** The prior 2-lane
handoff (`.agents/handoffs/2lane-parallel-gauntlet-driver.md`) records that the
operator's laptop cannot take 3 lanes, while another host can. A static number is
wrong on one machine or the other, which is why the operator asked for a real
CPU/memory reading.

**Rejected alternative 6: an advisory-only load reading (no server gate).** The
orchestrator is an LLM. It may forget to check `/load`, or check once and then raise
lanes an hour later under a different load. The operator's stated goal is "make sure
we aren't spawning too many agents", which needs an enforcement point that does not
depend on the model's diligence. The gate is cheap (one sample per pick) and only ever
*defers* a pick; it never kills running work.

**Rejected alternative 7: `os.freemem()` as the memory reading.** On macOS (the
desktop app's host) `os.freemem()` reports only truly free pages and excludes the
inactive/purgeable cache, so it routinely reads a few hundred MB on a healthy machine.
A gate on it would block every pick. The probe reads *available* memory instead:
`MemAvailable` from `/proc/meminfo` on Linux, and free + inactive + speculative +
purgeable pages from `vm_stat` on macOS, falling back to `os.freemem()` elsewhere.

**What this could break.**
- Nothing in the task pipeline's lane accounting: Loop lanes live in `LoopManager`'s
  own pool. The Lanes tab does not show Loop lanes (they are shown in the Loop tab);
  this is deliberate and called out in the docs.
- `WorkspaceMode` gains `'loop'`. Every switch over it (`mobileNav.viewForMode`,
  `modeForView`, App's breadcrumb, `railState`) has to be checked, and `typecheck`
  catches exhaustive `Record`s. On a phone, App coerces `'loop'` to `'workspace'`.
- The type mirror: every new type goes into both `types.ts` files in the same commit.
- SQLite: the change is **additive only**, with three `CREATE TABLE IF NOT EXISTS`
  tables and no column changes to existing tables. A data-loss guard test is extended.

**What I assumed that the code may not support (verified or mitigated).**
- `Runner.send()` while a turn is in flight. Mitigation: the server never sends into a
  busy orchestrator. Loop notifications queue in memory and flush on `onResult`
  (idle).
- GitHub's sub-issues API (`GET /repos/{o}/{r}/issues/{n}/sub_issues`) and its
  issue-dependencies API (`GET …/issues/{n}/dependencies/blocked_by`). Mitigation:
  every GitHub call goes through an injected `LoopGitHub` seam, so tests never call
  `gh`. The real implementation falls back to parsing `#N` task-list lines in the epic
  body, and `Blocked by #N` lines in a ticket body, when an endpoint returns 404 or
  errors.
- `os.loadavg()` is meaningful on macOS and Linux (the app's hosts) but returns
  `[0, 0, 0]` on Windows. Mitigation: the CPU half of the gate then never trips, which
  is the documented behaviour; the memory half still applies. Windows is not a
  supported desktop host.
- `vm_stat` output shape on macOS (`Pages free: 12345.` lines plus a
  `page size of 16384 bytes` header). Mitigation: parsing is a pure function tested
  against a checked-in fixture; any parse failure falls back to `os.freemem()` and
  never throws.
- The server's own port, used for the orchestrator's `curl`. It is passed in as
  `apiBase` (`http://127.0.0.1:${config.port}`) and never hard-coded.
- The critic cannot be literally blind, because it fetches the bar itself. "Blind"
  is enforced the way the technique describes. The server randomizes which label
  (`A`/`B`) is ours, the prompt strips provenance, and the critic must answer with a
  letter. The server maps the letter to WIN or LOSE (`verdictOutcome`). A tie or an
  unparseable answer is a **LOSE**, because the output must *beat* the bar.

**Out of scope (explicit):** listed above. Also excluded: a per-repo configurable
validation command (the validate agent discovers and runs the repo's own gate, as
zmrng workers already do), and any SVG edge-routing beyond straight connectors.

## Design

### Run lifecycle

```
draft ─start─▶ running ⇄ paused ─(all tickets done)─▶ finalizing ─PR url─▶ complete
   │              │                                       │
   │              └─(no runnable ticket, some needs-human)─▶ running (idle; orchestrator notified)
   └─ any state ─archive─▶ archived      boot with live run ─▶ stale ─resume─▶ previous status
```
`LoopRunStatus = 'draft' | 'running' | 'paused' | 'finalizing' | 'complete' | 'blocked' | 'stale' | 'archived'`.
A run reaches `blocked` only through the final-PR security scan (red or erroring
scanner, fail-closed) or a final-PR agent failure.

Finalizing is **automatic**: the moment every non-skipped ticket is `done`,
`maybeFinalize` runs `finalizing` → security scan on the integ worktree. A green scan
spawns the final-PR agent, and its PR URL leads to `complete`. A red scan leads to
`blocked`.

### Ticket lifecycle (per ticket, one lane, fresh agent per step)

```
todo ─pick─▶ executing(builder r) ─BUILT─▶ reviewing(critic r) ─WIN─▶ validating ─GREEN─▶ finishing(docs) ─GREEN─▶ folding ─verified─▶ done
                 ▲                                │LOSE(gap)          │RED(reason → gap)
                 └──────── round r+1 ◀────────────┴───────────────────┘   round > MAX_ROUNDS(6) ─▶ needs-human
any step: GAUNTLET_QUESTION ─▶ waiting (lane held, runner kept alive) ─answer─▶ same step continues
```
`LoopTicketState = 'todo' | 'blocked' | 'executing' | 'reviewing' | 'validating' | 'finishing' | 'folding' | 'waiting' | 'done' | 'needs-human' | 'skipped'`.
- `blocked` is derived: an open ticket that has an unfinished blocker.
- `done` is set by a fold, or at fetch time when the issue is already **closed** on GitHub.
- A blocker outside the map counts as satisfied iff that issue is closed.
- The lane is held from `pick` until `done`, `needs-human`, or a stop. The fold waits on
  a per-run **mutex**, because folding is serial and never concurrent.

### Steps, models, and control tokens

Every step is a **fresh** runner, killed once its step result is accepted. All tokens
are line-anchored (like `READY_RE`), so a token quoted mid-prose never matches.

| Step | cwd | Model / effort | Must end with |
|------|-----|----------------|---------------|
| builder | ticket worktree | opus / high | commits its work, then `GAUNTLET_STATUS=BUILT` |
| critic (read-only) | ticket worktree | opus / high | `GAUNTLET_VERDICT: A` or `B`, then `GAUNTLET_GAP: <one biggest gap>` |
| validate | ticket worktree | sonnet / medium | `GAUNTLET_STATUS=GREEN`, or `GAUNTLET_STATUS=RED <reason>` |
| finishing (sync docs) | ticket worktree | sonnet / medium | `GAUNTLET_STATUS=GREEN` |
| fold | integ worktree | opus / high | `GAUNTLET_STATUS=GREEN` (merged, gate green, committed) or `RED <reason>` |
| final PR | integ worktree | sonnet / medium | the PR URL (`PR_RE`) |
| orchestrator | integ worktree | opus / high | (persistent; no token) |

Any step may emit `GAUNTLET_QUESTION: <question>`. When it does, the ticket goes to
`waiting`, the question is forwarded to the orchestrator, and the runner stays alive.
`POST …/tickets/:n/answer` sends the answer into that same runner.

When a step's turn ends with no token, the server nudges once ("finish and emit your
GAUNTLET status line"). A second miss, a non-zero exit, or a spawn error sends the
ticket to `needs-human`, and the reason is reported to the orchestrator.

**Machine assertions** (deterministic, after the agent's claim; the pattern of the
scan gate):
- After the builder: the ticket worktree is clean (`git status --porcelain` empty) and
  HEAD advanced. Otherwise the builder is nudged to commit.
- After the critic: HEAD is unchanged and the tree is clean, because critics are
  read-only. A violation sends the ticket to `needs-human`.
- After the fold: the ticket branch tip is an ancestor of integ HEAD
  (`merge-base --is-ancestor`) and the integ worktree is clean. Then the **server**
  pushes integ (`git push origin <integ>`, a non-default branch, never forced).
- Before the final PR: the existing deterministic security scan (`scanFactory`, repo
  policy, base = default branch) runs on the integ worktree. Red or error leads to the
  run `blocked`, fail-closed, with the findings sent to the orchestrator. Green spawns
  the final-PR agent.

### Lane pool and load gate

- **Pool.** `LoopManager` owns one in-memory pool, a `Set<string>` of
  `<runId>:<issue>` holders, capped at `LOOP_MAX_LANES = 3` across all runs. A lane is
  held from pick until the ticket is `done`, `needs-human`, stopped, or the run is
  archived (a ticket waiting on the fold mutex keeps its lane). Nothing in
  `TaskManager` changes.
- **Per-run target.** `run.lanes` (0–3) is the run's target. A run's free slots are
  `min(run.lanes - heldByRun, LOOP_MAX_LANES - pool.size)`. `pump()` walks `running`
  runs oldest first, so with several runs active the oldest fills first.
- **Default lane count.** A new run starts at `lanes = 1`, the conservative choice.
  The orchestrator's first turn reads the map and `/load`, then sets the count through
  `POST …/lanes` and tells the operator why. The operator can override it from the
  header select at any time.
- **Load probe.** `LoadProbe.sample()` returns a `LoopLoad`: core count, 1-minute load
  average, load per core, total and *available* memory in MB, the configured
  thresholds, `allowsNewLane`, and a human-readable `reason` when it does not. The
  default probe uses `node:os` plus `/proc/meminfo` (Linux) or `vm_stat` (macOS), as
  described in rejected alternative 7.
- **Gate (D7).** Before every new pick, `pump()` samples once. If
  `loadPerCore > config.loopMaxLoadPerCore` (env `ZMRNG_LOOP_MAX_LOAD_PER_CORE`,
  default `1.0`) or `memAvailableMb < config.loopMinFreeMemMb` (env
  `ZMRNG_LOOP_MIN_FREE_MEM_MB`, default `2048`), no ticket is picked in that pump. The
  run's `note` records the deferral, and the orchestrator is notified **once per
  deferral episode** (a flag cleared when a pick next succeeds), never on every
  re-check. The gate never stops an in-flight step and never lowers `run.lanes`.
- **Re-check.** While any `running` run has free slots, a pump timer
  (`config.loopPumpIntervalMs`, env `ZMRNG_LOOP_PUMP_INTERVAL_MS`, default 30000)
  re-runs `pump()`, so a deferred pick resumes once load drops. The timer is
  `unref()`-ed and cleared in `shutdown()`. Tests drive `pump()` directly with a fake
  probe and never wait on the timer.
- **Visibility.** The latest sample rides on `LoopRunView` as `load`, and the pool on
  `pool: { used, max }`. The lanes header renders e.g.
  "Pool 2/3 · load 0.62/core · 5.1 GB free", and a "picks paused: high load" chip when
  the gate is closed.

### Git topology (inside the target repo, per the worktree-location rule)

- Integration branch `gauntlet/<run8>/integ`, cut from `origin/<default>` at run
  creation. Its worktree is `<repo>/worktrees/loop-<run8>-integ`.
- Ticket branch `gauntlet/<run8>/t<issue>`, cut from the integ tip **at pick time** so
  it carries every earlier fold. Its worktree is `<repo>/worktrees/loop-<run8>-t<issue>`.
- Both worktrees are seeded with `seedHarness` (as `TaskManager.start` does), so
  `info/exclude` keeps seeded files out of commits.
- After a ticket's fold, its worktree is removed (`removeWorktree`) and the branch is
  kept. Archiving a run removes the integ worktree. Branches are never deleted by force.
- Local helpers reuse `worktree.ts`. `createWorktree` hard-codes the
  `feat/zmrng/<slug>` naming, so it gains an **optional** `{ branch, base }` override
  parameter. Existing callers stay byte-identical.

### Orchestrator

- At most one per run. It is spawned at run creation, and otherwise **lazily** by
  `ensureOrchestrator(runId)`: on resume, on an operator chat message, or on a loop
  event for a run whose orchestrator is not alive. A lazy spawn is always fresh, with
  a recap built from DB state and the last 20 chat lines. The orchestrator is killed
  when its run reaches `complete` or `archived`, so finished runs do not keep a
  `claude` process alive; chatting to a finished run respawns it.
- Its system prompt (`loopOrchestratorPrompt`) states its role: guide the run, never
  edit code, never merge, never push `main`. It also carries the run facts (repo,
  slug, epic, integ branch, `apiBase`, run id) and a **curl cheat sheet** for every
  route below, plus the `gh` commands for editing issues and blocked-by links, after
  which it calls `/refresh`. It states the lane rules: the pool is shared by every
  Loop run (max 3 total), it should `GET /load` before raising the lane count, and the
  server will defer picks when the machine is over the load or memory threshold. The
  first kickoff tells it to read the map and `/load`, set the lane count, and explain
  the choice to the operator before anyone presses Start. The narration style follows the operator's caveman
  default; code and PR text stay normal English.
- The operator's chat goes to `POST …/chat`. Loop events go into a queue: a ticket
  WIN, LOSE (with gap), done, needs-human, a lane question, the map finishing, and a
  blocked run. The queue flushes as a single `[loop event]` user message when the
  orchestrator is idle.
- Its transcript persists in `loop_events` (kind `chat`). Its token deltas stream to
  the client as `loop-partial` frames.

### Server API (ungated, like the Workspace surface; plain-function `registerLoopRoutes(app, deps)`)

| Method / path | Body | Effect |
|---|---|---|
| `GET /api/loop/load` | — | a fresh `LoopLoad` sample (CPU, available memory, thresholds, `allowsNewLane`, `reason`) plus `pool: { used, max }` |
| `GET /api/loop/runs` | — | list `LoopRun[]` (non-archived first) |
| `GET /api/loop/runs/:id` | — | `LoopRunView` (run + tickets + live lanes) |
| `GET /api/loop/runs/:id/events?limit=` | — | recent `LoopEvent[]` (chat + activity) |
| `POST /api/loop/runs` | `{ repoId, epic, lanes? }` | fetch the map, create integ, spawn the orchestrator, status `draft`, `lanes` default 1 |
| `POST …/:id/start` / `pause` | — | `running` / `paused` (pause lets in-flight steps finish but picks nothing new) |
| `POST …/:id/lanes` | `{ count: 0..3 }` | the run's target lane count, 0 = stop picking. The global pool and the load gate still apply at pick time |
| `POST …/:id/priority` | `{ order: number[] }` | pick priority among unblocked tickets |
| `POST …/:id/refresh` | — | re-fetch the map from GitHub, keeping local state for known tickets |
| `POST …/:id/tickets` / `DELETE …/tickets/:n` | `{ number }` | add or skip a ticket |
| `POST …/:id/tickets/:n/stop` | — | kill the step, release the lane, ticket → `todo` |
| `POST …/:id/tickets/:n/retry` | — | `needs-human` → `todo`, reset rounds |
| `POST …/:id/tickets/:n/answer` | `{ text }` | answer a `waiting` ticket |
| `POST …/:id/chat` | `{ text }` | operator message → orchestrator |
| `POST …/:id/resume` | — | `stale` → previous status, respawn the orchestrator, re-run in-flight steps fresh |
| `POST …/:id/archive` | — | kill all runners, release lanes, remove worktrees |

Bodies are validated (types, ranges, issue numbers being positive ints). A bad body
returns 400 and a missing run returns 404. Every POST tolerates an empty body, so it
avoids the `FST_ERR_CTP_EMPTY_JSON_BODY` gotcha documented in `.claude/errors.md`.
Creation rejects a repo with no GitHub `origin` (`repoSlug` null) with 400.

WebSocket (the existing `/ws` hub; additive `WsEvent` members):
- `{ type: 'loop', run: LoopRunView }`, coalesced per run with a 150 ms trailing
  window (the same pattern as `LaneEmitter`). The view carries `pool` and the latest
  `load` sample; the pump timer re-broadcasts a `running` run's view only when its
  load sample's `allowsNewLane` flips or a displayed number changes by the formatted
  precision, so the timer does not spam the socket.
- `{ type: 'loop-event', runId, event: LoopEvent }`.
- `{ type: 'loop-partial', runId, text }` for orchestrator token deltas only.
- `{ type: 'loop-removed', runId }` on archive.

### Persistence (additive-only migrations)

```sql
CREATE TABLE IF NOT EXISTS loop_runs (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, epic INTEGER NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, prev_status TEXT, lanes INTEGER NOT NULL DEFAULT 1,
  integ_branch TEXT NOT NULL, integ_worktree TEXT, priority TEXT NOT NULL DEFAULT '[]',
  pr_url TEXT, note TEXT, usage TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS loop_tickets (
  run_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  url TEXT NOT NULL, gh_state TEXT NOT NULL, blocked_by TEXT NOT NULL DEFAULT '[]',
  bar TEXT, state TEXT NOT NULL, step TEXT, round INTEGER NOT NULL DEFAULT 0, last_gap TEXT,
  branch TEXT, worktree TEXT, fold_sha TEXT, question TEXT, note TEXT,
  usage TEXT NOT NULL DEFAULT '{}', started_at TEXT, step_started_at TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY (run_id, number));
CREATE TABLE IF NOT EXISTS loop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ticket INTEGER,
  kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS loop_events_run ON loop_events(run_id, id);
```
These go into `SCHEMA` (fresh DBs) **and** an idempotent `ensureLoopSchema()` called
from the `Db` constructor, the same shape as `ensureAuthSchema`. No existing table is
altered. Enum columns (`status`, `state`, `step`, `kind`) store the TypeScript literal
values verbatim (lower-case, e.g. `builder`, `needs-human`); `step` is meaningful only
while `state` is an in-flight state or `waiting`, and is otherwise the last step run.
JSON columns (`priority`, `blocked_by`, `usage`, `payload`) are parsed defensively on
read and fall back to their empty value.

**Note on the existing types draft.** The uncommitted `types.ts` draft predates this
revision: it still lacks `LoopLoad`, `LoopPool`, and `LoopRunView.pool`/`load`, and its
`LOOP_MAX_LANES` comment still describes the overruled shared cap. Those are step-1
work items in the execute phase, not omissions in this plan; nothing is implemented in
the plan phase.

A ticket with **no bar** is never picked. It is parked `needs-human` with the note
"ticket has no bar", because a vague bar fails the whole technique. The orchestrator
can add a bar through `gh issue edit` and then call `/refresh` + `/retry`.

**Bar parsing:** a `## Bar` (any heading level) section, or a `Bar:` line, in the
issue body.

**Blocked-by fallback:** `Blocked by #N` / `Depends on #N` lines.

## Exact files

**Server (new)**
- `packages/server/src/loopMap.ts`: pure functions. `parseBar(body)`,
  `parseBlockedByFallback(body)`, `parseEpicChildrenFallback(body)`,
  `deriveStates(tickets)` (todo vs blocked, external blockers), `findCycle(tickets)`,
  `frontier(tickets)`, `pickNext(tickets, priority, freeSlots)`,
  `percentComplete(tickets)` (done ÷ non-skipped, rounded),
  `verdictOutcome(letter, oursLabel)`, `nextAfterLoss(ticket, gap)` (round fuse →
  `needs-human` past `MAX_ROUNDS = 6`).
- `packages/server/src/loopPrompts.ts`: token regexes (`GAUNTLET_STATUS_RE`,
  `GAUNTLET_VERDICT_RE`, `GAUNTLET_GAP_RE`, `GAUNTLET_QUESTION_RE`), `parseStepResult(text)`,
  and the prompt builders `builderPrompt`, `criticPrompt`, `validatePrompt`,
  `finishPrompt`, `foldPrompt`, `finalPrKickoff`, `loopOrchestratorPrompt`,
  `orchestratorRecap`. Prompts reuse `styleDirective` and `PR_BODY_TEMPLATE` /
  `PR_BODY_FILE` from `phases.ts` so the PR-body contract stays DRY.
- `packages/server/src/loopGithub.ts`: the `LoopGitHub` interface
  (`fetchMap(slug, epic)`, `fetchIssue(slug, n)`) plus a `gh api` implementation using
  `promisify(execFile)` (the `agentResponder.ts` style), with the fallbacks above.
- `packages/server/src/loopLoad.ts`: the load probe. Pure `parseMeminfo(text)` (the
  `MemAvailable` kB line → MB, null when absent), `parseVmStat(text)` (page size from
  the header × free + inactive + speculative + purgeable pages → MB, null on a
  malformed header), and `assessLoad(raw, thresholds)` → `LoopLoad` (computes
  `loadPerCore`, `allowsNewLane`, and the `reason` string naming which threshold
  tripped). The `LoadProbe` interface (`sample(): Promise<LoopLoad>`) and
  `defaultLoadProbe(thresholds, platform?, readers?)`, whose file/`execFile` readers are
  injectable so the platform branches are testable without `vm_stat` or `/proc`.
- `packages/server/src/loop.ts`: the `LoopManager` class. Constructor:
  `(db, broadcast, deps: { runnerFactory, github, load, scanFactory, apiBase, pumpIntervalMs?, clock? })`,
  where `load: LoadProbe`. The lane pool is internal, not a dependency.
  - **In-memory state:**
    - `stepRunners: Map<string /* runId:n */, { runner, step, turnText, nudged, awaitingAnswer }>`
    - `orchestrators: Map<runId, { runner, busy: boolean }>`
    - `pendingNotes: Map<runId, string[]>`, the orchestrator queue, flushed as one
      message on idle
    - `foldInFlight: Map<runId, number>`, the ticket currently folding
    - `foldQueue: Map<runId, number[]>`, tickets waiting to fold, in FIFO order
    - `pool: Set<string>`, the `<runId>:<n>` lane holders, global across runs, capped
      at `LOOP_MAX_LANES`
    - `lastLoad: LoopLoad | null` and `loadDeferred: Set<runId>` (the once-per-episode
      notification flag)
    - `pumpTimer`, the `unref()`-ed re-check interval
  - **Fold serialization:** finishing GREEN calls `enqueueFold(run, n)`. That method
    spawns the fold runner only when `foldInFlight` has no entry for the run, and
    otherwise appends to `foldQueue`. Fold completion (done or needs-human) clears
    `foldInFlight` and starts the next queued fold. A fold in progress is never started
    twice, because Node runs single-threaded and there is no await between the check
    and the set. Shape:
    ```ts
    enqueueFold(runId, n) {
      if (this.foldInFlight.has(runId)) { queueFor(runId).push(n); return }
      this.foldInFlight.set(runId, n)        // synchronous claim, before any await
      void this.runStep(runId, n, 'fold')
    }
    onFoldSettled(runId, n) {                // called on done, needs-human, stop, or archive
      if (this.foldInFlight.get(runId) !== n) return   // stale/duplicate settle: ignore
      this.foldInFlight.delete(runId)
      const next = queueFor(runId).shift()
      if (next !== undefined) this.enqueueFold(runId, next)
    }
    ```
    `stopTicket` on a ticket that is only *queued* removes it from `foldQueue` without
    touching `foldInFlight`. `archive` clears both maps for the run. On `resume` after a
    restart both maps start empty, and every ticket persisted in `folding` state is
    re-enqueued in ticket-number order, so serial folding still holds.
  - **Pool accounting invariant:** every path that ends a ticket's lane (`done`,
    `needs-human`, `stopTicket`, `archive`, a spawn error) goes through one
    `releaseLane(runId, n)` that deletes the holder and calls `pump()`. On restart the
    pool starts empty; `resume` re-acquires a slot for each in-flight ticket before
    re-running its step and, if the pool is full (another run took slots meanwhile),
    returns that ticket to `todo` rather than exceeding the cap. Resume does **not**
    consult the load gate for these re-acquired tickets, because they were already
    admitted; it only gates new picks.
  - **Key methods:**
    - `pump(runId?)` samples load once, and if the gate is open fills each `running`
      run's free slots (see "Lane pool and load gate") via `pickNext`.
    - `pickTicket(run, n)` takes a pool slot, reads the integ HEAD sha
      (`rev-parse <integ>`), calls `createWorktree(…, { branch, base: sha })` and
      `seedHarness`, persists the branch and worktree, and then calls
      `runStep(run, n, 'builder')`.
    - `runStep` spawns a fresh runner with the step's profile and prompt.
    - `onStepResult` parses the token and machine-asserts, then advances the ticket.
    - `maybeFinalize(run)` runs automatically when every non-skipped ticket is `done`.
      It sets the run to `finalizing`, runs the scan, and then either spawns the
      final-PR agent (green) or sets the run to `blocked` (red or error). Neither the
      operator nor the orchestrator has to trigger it.
    - `buildRecap(runId)` is the respawn context: run facts, a per-ticket state table,
      and the last 20 chat lines.
    - `notifyOrchestrator(runId, line)` queues a line, and flushes it immediately if
      the orchestrator is idle.
  - **Public methods:** they mirror the routes (including `load()` for
    `GET /api/loop/load`), plus `reconcileOrphans()`, `pump(runId?)`, `shutdown()`,
    and `hardKillAll()`.
- `packages/server/src/loopRoutes.ts`: `registerLoopRoutes(app, { loop })`, a plain
  function and not a plugin.

**Server (edit)**
- `types.ts`: `LoopRunStatus`, `LoopTicketState`, `LoopStep`, `LoopRun`, `LoopTicket`,
  `LoopLane`, `LoopRunView`, `LoopEvent`, `LoopEventPayload`, the `WsEvent` additions,
  and `'loop'` added to `WorkspaceMode`. **The worktree already holds an uncommitted
  draft of these types (both files, identical diffs) from the first planning pass.**
  Step 1 keeps it and amends it: rewrite the `LOOP_MAX_LANES` comment (a global Loop
  pool, *not* counted against `config.maxLanes`), describe `LoopRun.lanes` as the
  run's target within that pool, add `LoopLoad`
  (`cores`, `loadAvg1`, `loadPerCore`, `memTotalMb`, `memAvailableMb`,
  `maxLoadPerCore`, `minFreeMemMb`, `allowsNewLane`, `reason: string | null`,
  `sampledAt`) and `LoopPool` (`used`, `max`), and add `pool: LoopPool` and
  `load: LoopLoad | null` to `LoopRunView`.
- `config.ts`: `loopMaxLoadPerCore` (`ZMRNG_LOOP_MAX_LOAD_PER_CORE`, default 1.0),
  `loopMinFreeMemMb` (`ZMRNG_LOOP_MIN_FREE_MEM_MB`, default 2048), and
  `loopPumpIntervalMs` (`ZMRNG_LOOP_PUMP_INTERVAL_MS`, default 30000). A non-numeric
  or non-positive value falls back to the default, so a typo cannot disable the gate.
- `db.ts`: the schema plus `ensureLoopSchema()`, and the methods `insertLoopRun`,
  `getLoopRun`, `listLoopRuns`, `updateLoopRun`, `upsertLoopTicket`, `listLoopTickets`,
  `updateLoopTicket`, `insertLoopEvent`, `listLoopEvents`, `addLoopUsage` (atomic, like
  `addUsage`).
- `phases.ts`: **no behaviour change.** It is only imported from (`styleDirective`,
  `PR_BODY_TEMPLATE`, `PR_BODY_FILE`, `PR_RE`). The task lane pool is untouched.
- `worktree.ts`: optional `{ branch, base }` override on `createWorktree`, and an
  exported `gitIn(cwd, args)` helper (or reuse the existing private `git` by exporting
  it).
- `index.ts`: construct `LoopManager` (with `defaultLoadProbe` built from the config
  thresholds), register routes, call `loop.reconcileOrphans()` at boot, and add
  `loop.shutdown()` / `hardKillAll()` to the existing shutdown and exit paths.

**Web (new)**
- `packages/web/src/loopMap.ts`: pure layout. `layoutMap(tickets)` → layered DAG
  (column = longest blocker chain depth, row = order within the column; a cycle falls
  back to one column), `mapEdges`, `percentComplete`, `ticketGlyph(state)` (checked /
  unchecked / active / warn / skipped), `laneCards(view)`, `stepLabel`, `formatRound`.
  `formatElapsed` and `formatTokens` are reused from `laneRows.ts`. Also
  `poolSummary(view)` → the "Pool 2/3 · load 0.62/core · 5.1 GB free" string and the
  gate-closed flag.
- `packages/web/src/loopProtocol.ts`: the typed REST helpers for `/api/loop/*`, built
  on `api.ts`'s `send()`.
- `packages/web/src/components/LoopView.tsx` + `LoopView.module.css`: the mode root. It
  shows a run picker and a new-run form (repo select and epic number; the lane count is
  left to the orchestrator) when no run is open. Otherwise it shows a CSS grid: `grid-template-columns: 1fr 2fr`, the
  left `LoopChat` spanning full height, and the right column split into `LoopLanes`
  (top) and `LoopMap` (below). It has Start/Pause, lane-count, Resume, and Archive
  controls in a slim header.
- `components/LoopChat.tsx`: the orchestrator bubble thread, reusing the `chatThread.ts`
  reducer and `ChatPane.module.css`-style classes. It shows tool-call rows (the
  orchestrator's curl/gh calls) as compact notes.
- `components/LoopLanes.tsx`: a header with `poolSummary` and a "picks paused: high
  load" chip while the gate is closed, then up to 3 lane cards. Each shows `#n` + title (a link to the
  issue via `openExternal`), a step pill, round `r/6`, tokens, elapsed (a 1 s tick only
  while the Loop mode is active), model, the last activity line, the question (if
  waiting), and a Stop button. Empty slots render a muted "idle lane".
- `components/LoopMap.tsx`: the header ("N of M done · P%"), plus nodes positioned from
  `layoutMap` with checkbox glyphs. Straight SVG connectors join blocker → ticket.
  Positions are inline styles, the sanctioned "genuinely dynamic value" case.
- `NavIcon.tsx`: a new `'loop'` outline icon.

**Web (edit)**
- `types.ts`: the mirror of all server type additions.
- `App.tsx`: loop state (`runs`, the open run view, events), WS handling for the four
  new frames, a `mode === 'loop'` content panel, breadcrumb `'Loop'`, and a phone
  coercion of `'loop'` → `'workspace'`.
- `components/ActivityRail.tsx`: a `{ id: 'loop', icon: 'loop', label: 'Loop' }` entry.
- `mobileNav.ts`: confirm `viewForMode('loop')` falls back to `'tasks'`, with no new
  phone view.
- `theme.css`: new `--loop-*` tokens only if an existing `--status-*` / `--actor-*`
  token cannot express a ticket state. Prefer reuse: executing → `--status-executing`,
  reviewing → `--actor-code-reviewer`, validating → `--status-validating`,
  done → `--status-done`, needs-human → `--status-blocked`.

**Docs (via sync-docs in the validate phase):** `.claude/docs/services-reference.md`
(LoopManager, routes, tokens, topology, CC-BY credit), `.claude/docs/codemap.md`,
`.claude/rules/frontend-react.md` (component list), `.claude/rules/testing.md` (What's
covered), a short CLAUDE.md pointer paragraph, and
`docs/adr/0003-gauntlet-loop.md` (decisions D1–D6 below).

## Decisions (for the ADR)

- D1: a separate `LoopManager`, not Task rows.
- D2: the orchestrator acts through loopback REST via `curl` tool calls, not prose tokens
  and not MCP (v1).
- D3 (revised): Loop lanes have their own pool, separate from `config.maxLanes`, capped
  at 3 in total across all Loop runs. The first draft's shared cap was overruled by the
  operator. The task pipeline's lane code is untouched.
- D4: an integration branch per run, serial folding under a mutex, one final PR, the
  server pushes integ only after a machine-asserted fold.
- D5: blind binary A/B with server-randomized labels, where a tie or an unparseable
  answer loses, and a `MAX_ROUNDS = 6` fuse leads to `needs-human`.
- D6: the final PR passes the existing deterministic security scan, fail-closed to a
  `blocked` run. This is a deliberate v1 simplification. Unlike the task pipeline, the
  loop has **no automatic security-fix rounds**. On red, the orchestrator relays the
  findings, and the operator either adds a fix ticket to the run, which reopens the
  map, or fixes the problem manually. A future fix-round feature must not assume the
  task pipeline's RED → FIX loop exists here.
- D7: the lane count is chosen by the orchestrator from the map and a real CPU and
  available-memory reading (`GET /api/loop/load`), and the server **hard-gates new
  picks** on the same reading (load per core over `loopMaxLoadPerCore`, or available
  memory under `loopMinFreeMemMb`). The gate defers picks only; it never kills
  in-flight work and never rewrites the run's lane target. "Available" memory is
  `MemAvailable` on Linux and free + inactive + speculative + purgeable pages on macOS,
  because `os.freemem()` under-reports on macOS.

## Implementation steps (ordered; each step lands with its tests, RED → GREEN → REFACTOR)

1. **Types.** Amend the existing uncommitted draft in both `types.ts` files as
   described above (pool comment, `LoopLoad`, `LoopPool`, `LoopRunView.pool`/`load`),
   keeping the two diffs identical. Run `npm run typecheck` and fix every
   exhaustiveness fallout (mobileNav, App breadcrumb).
2. **DB.** Add the schema and `ensureLoopSchema` plus the methods, with tests first in
   `db.test.ts`.
3. **Config + load probe.** Add the three config fields (tests first in
   `config.test.ts`) and `loopLoad.ts` (tests first in `loopLoad.test.ts`, with
   `/proc/meminfo` and `vm_stat` fixtures under `packages/server/test/fixtures/`).
4. **Pure server logic.** Build `loopMap.ts` and `loopPrompts.ts`, with tests first.
5. **GitHub seam.** Build `loopGithub.ts`. Unit-test only its pure parsing of `gh api`
   JSON (fixture strings), and never execute `gh`.
6. **Worktree override.** Add the `createWorktree` `{ branch, base }` option, with a
   `worktree.test.ts` case.
7. **LoopManager.** Build `loop.ts` and drive it with `loopManager.test.ts`, scenario
   by scenario (see the test strategy below).
8. **Routes and wiring.** Build `loopRoutes.ts` + `loopRoutes.test.ts`, then wire up
   `index.ts`.
9. **Web pure modules.** Build `loopMap.ts`, then `loopProtocol.ts`, with tests.
10. **Web components.** Build `LoopView`, `LoopChat`, `LoopLanes`, `LoopMap`, the
    `ActivityRail` entry, `NavIcon`, and the App wiring, with component tests.
11. **Validate.** Run `npm run typecheck && npm run lint && npm test && npm run build`.
    Then run `npm run desktop:build`, or `npm run build && npm run bundle:sidecar`
    where Rust is absent (recorded in operator memory for one host). Then run the
    `code-reviewer` pass and sync-docs, and stage this plan file.

## Test strategy

**Runner:** Vitest in both workspaces. Use `npm test` (both), `npm run test -w
@zmrng/server`, and `npm run test -w @zmrng/web`. The full gate is
`npm run typecheck && npm run lint && npm test && npm run build`. The hard rules
hold: no real `claude`, no `gh`, no network. git runs for real against temp repos.

**Server**
- `packages/server/test/loopMap.test.ts` (new) proves the following:
  - `parseBar` finds a `## Bar` section and a `Bar:` line, and returns null when
    neither is present.
  - The blocked-by and epic-children fallbacks parse `Blocked by #12` and `- [ ] #34`,
    and ignore `#12` in prose and code spans.
  - `deriveStates` treats a closed external blocker as satisfied and an open one as
    blocking.
  - `findCycle` detects A→B→A.
  - `frontier` excludes blocked, skipped, done, and in-flight tickets.
  - `pickNext` honours the priority order, then the issue number, and never exceeds
    the free slots.
  - `percentComplete` handles an empty map, excludes skipped tickets, and rounds.
  - `verdictOutcome` returns WIN only when the chosen letter is ours, and treats a tie
    or garbage as LOSE.
  - `nextAfterLoss` increments the round and parks at round 7 (`MAX_ROUNDS = 6`).
- `packages/server/test/loopPrompts.test.ts` (new) pins the gauntlet contract, the way
  `prompts.test.ts` does. These cases prove it:
  - The builder prompt carries the goal, bar, and last gap, and says to commit and never
    judge its own work.
  - The critic prompt says "harsh critic", READ-ONLY, fetch the bar, blind A/B with
    provenance stripped, binary letter (never score /10), and single biggest gap.
  - Every step prompt carries the branch-only rules (never `main`, never force-push)
    and the worktree-hygiene rules.
  - The fold prompt says serial merge into integ, keep integ green, never `main`.
  - The final-PR kickoff uses `--body-file`, never `--fill`, with `Closes #n` per done
    ticket and the base being the default branch.
  - The orchestrator prompt lists every route in the curl cheat sheet and says never
    edit code or merge.
  - `parseStepResult` covers every token, including near-misses: a token quoted inside
    a sentence or a code fence does not match, and `GAUNTLET_STATUS=GREENISH` does not
    match.
- `packages/server/test/loopLoad.test.ts` (new) proves:
  - `parseMeminfo` reads `MemAvailable` from a real-shaped fixture and returns null when
    the line is missing.
  - `parseVmStat` computes free + inactive + speculative + purgeable × page size from a
    real-shaped macOS fixture (16384-byte pages), and returns null on a malformed
    header.
  - `assessLoad` allows a lane under both thresholds, refuses over the load-per-core
    threshold, refuses under the memory floor, names the tripped threshold(s) in
    `reason`, and treats a `[0,0,0]` load average as CPU-unconstrained.
  - `defaultLoadProbe` with injected readers takes the Linux branch, the macOS branch,
    and falls back to `os.freemem()`-shaped input when a reader throws or parsing
    fails, never throwing itself.
- `packages/server/test/config.test.ts` (edit) proves the three loop config fields
  default correctly and that garbage or non-positive env values fall back to the
  default.
- `packages/server/test/loopGithub.test.ts` (new) checks the pure mapping of fixture
  `gh api` JSON (sub_issues, blocked_by, issue) into tickets. The fallback is used when
  the injected exec rejects with a 404-shaped error. The exec is injected, so `gh`
  never runs.
- `packages/server/test/loopManager.test.ts` (new) is the highest-value test. It runs
  the real `LoopManager` over a **real temp git repo with a bare `origin`** (so pushes
  work), a fake `RunnerFactory` (the `FakeRunner` pattern from `taskManager.test.ts`,
  with scripted turns that may run real `git` commits in the worktree to simulate the
  builder or fold agent), a fake `LoopGitHub`, a fake `LoadProbe` whose next sample
  each test sets, and a fake scan.
  Scenarios:
  1. Creation fetches the map, creates the integ branch and worktree, spawns the
     orchestrator, and leaves the run in `draft`. A repo without a slug is rejected.
  2. On `start`, a frontier ticket takes a lane, its worktree branches off the integ
     tip, and a builder spawns there with the opus profile. A blocked ticket is not
     picked.
  3. BUILT plus a clean tree leads to the critic, a fresh runner. A dirty tree after
     the builder leads to a nudge, not the critic.
  4. A critic LOSE puts the gap into the next builder prompt and sets round = 2. A WIN
     leads to validate, then finishing, then fold.
  5. The fold runs a real merge in the fake turn; the ancestor assertion passes, integ
     is pushed to the bare origin, the ticket is `done` with `fold_sha`, its worktree
     is removed, and the dependent ticket becomes pickable.
  6. Two tickets reaching fold together fold **serially**: the second fold runner is
     not spawned until the first completes. Stopping the queued ticket removes it from
     the queue, and a duplicate settle for an already-finished fold starts nothing.
  7. The round fuse moves a ticket to `needs-human` after 6 losses, releases the lane,
     and notifies the orchestrator.
  8. A question leads to `waiting`, the question queues for the orchestrator and flushes
     only when it is idle, and the answer is `send()`-ed into the same live runner.
  9. A critic that modifies the tree leads to `needs-human`. A missing token twice leads
     to `needs-human`.
  10. Global pool: two `running` runs with `lanes = 3` each and plenty of frontier
      tickets hold **3 lanes in total**, never more, and the older run fills first.
      When one lane is released, `pump()` picks the next ticket. Lane count 0 lets
      in-flight steps finish but picks nothing new. The task pool is not consulted (no
      `TaskManager` is constructed in this test at all).
  11. `stopTicket` kills the runner, releases the lane, and returns the ticket to
      `todo`. `pause` keeps in-flight work but stops picking.
  12. All tickets done leads to the scan; a green scan spawns the final-PR agent, and a
      PR URL makes the run `complete` with `pr_url`. A red or erroring scan makes the
      run `blocked`, fail-closed.
  13. Restart: a second `LoopManager` on the same DB with `reconcileOrphans()` marks the
      run `stale`; `resume` respawns the orchestrator with the recap and re-runs the
      in-flight step fresh in the existing worktree, re-acquiring its pool slot. If the
      pool is already full, that ticket returns to `todo` and `pool.used` never exceeds
      3. Two tickets persisted in `folding` are re-folded serially.
  14. Archive kills all runners, releases all lanes, and removes the worktrees.
  15. Orchestrator coalescing: three loop events arrive while the orchestrator is
      mid-turn (`busy`), and **zero** sends happen. On its `onResult`, exactly **one**
      `[loop event]` message carrying all three lines is sent. An event that arrives
      while the orchestrator is idle is sent immediately.
  16. `buildRecap` contains the run facts (repo, epic, integ branch, apiBase), every
      ticket's state and round, and the last 20 chat lines, and no more. On `resume`,
      the respawned orchestrator's system prompt or first message contains it.
  17. Critic read-only violation (explicit): the fake critic turn writes and commits a
      file, so the HEAD-unchanged/clean assertion fails, the ticket goes to
      `needs-human`, the lane is released, and the orchestrator is notified. No fold is
      ever enqueued.
  18. Load gate: with the fake probe over the load threshold, `pump()` picks nothing,
      the run's note records the deferral, and the orchestrator is notified **once**
      across three further pumps. A builder already running is untouched. When the
      probe drops below the threshold, the next `pump()` picks the ticket, and a later
      deferral notifies again. The same holds for the memory floor.
  19. Lazy orchestrator: after the run reaches `complete` its orchestrator runner is
      killed; an operator chat message to that run spawns a fresh one whose kickoff
      contains the recap.
  20. `load()` returns the fake probe's sample with `pool.used` equal to the number of
      held lanes, and the broadcast `LoopRunView` carries the same `pool` and `load`.
- `packages/server/test/loopRoutes.test.ts` (new): `registerLoopRoutes` on a bare
  `Fastify()` with a stub manager, driven by `app.inject()`. It proves each route calls
  the right method with validated args, `GET /api/loop/load` returns the manager's
  sample, bad bodies get 400 (non-int epic, lanes > 3,
  non-array priority, empty answer), an unknown run gets 404, and a bodyless POST
  works.
- `packages/server/test/db.test.ts` (edit) proves the loop tables are created on a
  pre-existing database, and **pre-existing task/message rows are unchanged** (the
  data-loss guard extended). It also checks idempotent reopen, a run/ticket/event round
  trip, and atomic `addLoopUsage` accumulation.
- `packages/server/test/taskManager.test.ts`: **unchanged**, and it must stay green
  untouched, which is the evidence that the task pipeline was not modified.
- `packages/server/test/worktree.test.ts` (edit) proves the `createWorktree` branch/base
  override creates the given branch off the given base, and default behavior is
  unchanged.

**Web**
- `packages/web/test/loopMap.test.ts` (new) proves:
  - `layoutMap` assigns columns by longest blocker depth (a chain A→B→C gives columns
    0, 1, 2, and a diamond lays out correctly), and a cycle falls back without
    throwing.
  - Edges only connect tickets inside the map.
  - `percentComplete` and `ticketGlyph` return the right value for every state.
  - `laneCards` orders by lane, pads idle slots up to the lane count, and formats
    `round r/6`.
  - `poolSummary` formats "Pool 2/3 · load 0.62/core · 5.1 GB free", reports the
    gate as closed when `allowsNewLane` is false, and degrades to "Pool 2/3" when
    `load` is null.
- `packages/web/test/LoopView.test.tsx` (new) renders a fixture `LoopRunView` and
  proves the three regions are present (chat, lanes, map).
  - The map header shows "2 of 4 · 50%".
  - Done tickets render a checked checkbox and open ones unchecked (by accessible role
    and state).
  - A lane card shows the ticket, step label, tokens, and elapsed.
  - A waiting lane shows its question.
  - Stop calls the stop API.
  - A view whose `load.allowsNewLane` is false shows the "picks paused: high load"
    chip.
  - With no run open, the new-run form submits `{ repoId, epic }`.
- `packages/web/test/ActivityRail.test.tsx` (edit) proves the Loop button renders and
  selects `'loop'`.
- `packages/web/test/mobileNav.test.ts` (edit) proves `viewForMode('loop')` returns
  `'tasks'`.

**Manual smoke (engine touched):** run `npm run dev`, open Loop, create a run against a
scratch repo with an epic of 2 or 3 sub-issues that carry bars, and watch the
orchestrator greet. Start a lane and confirm the builder appears in the lane card and
the map updates on fold. The operator does this, because real `claude`/`gh` are not
exercised by tests.

## Risks

- **Size.** This is the largest single feature to date. Mitigation: the ordered steps
  above, with each step's tests green before the next.
- **GitHub API shape drift.** This is isolated behind `LoopGitHub` with body-text
  fallbacks.
- **Orchestrator misuse of the API.** Every route validates input. The orchestrator
  cannot touch `main`, because the only push in the system is the server's integ push,
  and the final PR is opened by a separate PR agent with `--body-file`.
- **Load.** Loop lanes no longer share the task cap, so the worst case is 3 Loop lane
  steps, one orchestrator per live run, and a final-PR agent, on top of up to
  `maxLanes` task workers: 8 or more `claude` processes, which the operator accepted.
  The load gate (D7) is the practical bound: it stops new picks once the machine is
  saturated or short of memory. Finished runs kill their orchestrator, so idle runs
  hold no process. The defaults (1.0 load per core, 2048 MB available) are
  env-tunable per host.
- **Gate flapping.** A pick itself raises load, so the gate can open and close around
  the threshold. That is acceptable: it only defers picks, the pump re-checks on a
  30 s cadence rather than in a tight loop, and the orchestrator is notified once per
  deferral episode, not per check.
