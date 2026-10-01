# CONTEXT — zmrng glossary

Ubiquitous language for the zmrng orchestrator. One term per entry: the sharpened
definition + an `_Avoid_:` line naming the near-miss words it displaces.

## Security gate

**Security gate** — the deterministic, orchestrator-run scan bracketing a
probabilistic fix, sitting inside the `validating` phase between the worker's commit
and the PR. A machine (not an agent) runs a fixed scanner set on the worktree and
asserts pass/fail; a red verdict forces the same live worker to iterate, then the
same scanner re-asserts green before the PR is allowed.
_Avoid_: "security review" (implies an agent reviewer — the exact anti-pattern this
replaces); "CI scan" (that is post-PR; this is in-worker, pre-PR).

**SAST pass** — the Semgrep run: finds vulnerabilities written INTO the code (SQLi,
path traversal, hard-coded secrets, unsafe deserialization).
_Avoid_: "lint" (lint is static correctness; SAST is a distinct security class).

**SCA pass** — the osv-scanner run: finds dependencies (incl. transitive) with known
CVEs. Runs on BOTH flows; it is the ONLY security pass the `direct` flow gets.
_Avoid_: "dependency audit" (informal); "npm audit" (a different tool/DB).

**Blocking finding** — a finding the gate fails on: a Semgrep `ERROR`-severity AND
high-confidence result, or an osv vuln that has a fix available. Non-blocking findings
are recorded and surfaced, never gated.
_Avoid_: "high-severity finding" alone (confidence is part of the block rule);
"any finding" (most findings do not block, by design — D1).

**Baseline-diff** — scanning only the findings the branch INTRODUCED vs the
merge-base, never the whole repo, so a task is never gated on pre-existing repo debt.
_Avoid_: "full scan" / "repo scan" (the rejected alternative that floods the fixer).

**Vendored ruleset** — the pinned Semgrep rules directory committed into zmrng and
refreshed out of band, run with `--config <dir>` so no per-PR registry/network fetch
occurs. The offline osv vuln DB is its SCA counterpart.
_Avoid_: "the default ruleset" (`p/owasp-top-ten` etc. fetch from the network — the
false-premise Rev 1 assumed was offline).

**`ZMRNG_SCAN_READY`** — the control token the worker prints, on its own line, after
committing on the branch and BEFORE pushing/opening the PR, to hand control back to
the orchestrator for the scan. The orchestrator replies with `securityFixKickoff`
(red) or `openPrKickoff` (green) into the same live session.
_Avoid_: `ZMRNG_VALIDATING` (that marks entry into the QA/review/docs chain, earlier);
`ZMRNG_READY` (clarify-phase-complete, a different phase).

**Scan-pending (lane-free)** — the transient state while the deterministic scanner
runs holding NO execute lane (D3). A lane is re-acquired only if the scan is red and a
fix round is needed.
_Avoid_: "scanning phase holds a lane" (the rejected design that idles a scarce lane
on machine work).

## Agent efficiency monitor

**Efficiency profile** — the advisory artifact the efficiency monitor emits: a
per-agent/per-task ranked list of detected habits, each scored by estimated wasted
tokens/time and tagged with a lever pointer. Derived purely by reading the existing
`events` rows (`db.getEvents`) + the task's aggregate `usage`; it mutates nothing.
_Avoid_: "operator log" (the raw live per-event firehose — this is the aggregated
diagnosis OVER those events, not the stream itself); "efficiency report" (informal —
the profile is the named durable artifact zc calls the "efficiency file").

**Habit (finding)** — one recurring waste pattern the monitor detects from the aggregate
(e.g. repeated failed tool calls, opus-on-menial, subagent thrash), carrying
`{habit, wastedEstimate, lever}`. Keyed off tool-call FREQUENCY/counts + result-error
rates + task-level token totals, because `TaskUsage` is aggregate-per-task, not per-event.
_Avoid_: "event" (a single captured tool use / thought — a habit is a pattern across many
events); "bug" (a habit is wasteful-but-working behaviour, not a defect).

**Lever pointer** — the tag on a finding naming where its fix would land: `control`
(per-task `model`/`effort`/`flow` on the `tasks` row — bounded, reversible, the only
eventual auto-apply candidate), `phase-prompt` (`phases.ts` — human-only), or
`target-context` (the target repo's `CLAUDE.md`/rules token tax — out of zmrng's control
on arbitrary repos).
_Avoid_: "fix" (the pointer names the SURFACE, not the applied change — v1 applies
nothing); "auto-apply" (only `control` is ever an auto-apply target, and only later,
opt-in, operator-confirmed).

## Chat workflows

**Workflow preset** — a named, user-selectable working mode for a standalone Chat-card
session (`/ws/chat`): the operator picks one from a `workflow` dropdown alongside
model/effort/style, and the session adopts that mode (e.g. `grill`, `teach-me`). Mechanically
it is a prompt preset (see **Workflow directive**), NOT seeded skill files and NOT the
worker's PIV pipeline. zmrng owns its own committed copies of the preset bodies; they are
allowed to drift from the operator's personal Hermes skills of the same name (ADR-0002 D3).
_Avoid_: "skill" (a workflow preset is not a discoverable `.claude/` skill — it never
touches the filesystem; the harness skills the worker gets are a different mechanism);
"workflow" bare when you mean the task lifecycle (the worker's plan→execute→validate→PR
pipeline is also "a workflow" — say "the pipeline" for that, "workflow preset" for this).

**Workflow directive** — the block of instructions a selected **Workflow preset** appends
to the Chat session's system prompt at spawn, produced by `workflowDirective(workflow)` in
`chatAgent.ts`. Structurally identical to `styleDirective` (`phases.ts`) — inlined into the
prompt with zero tool round-trips — and COMPOSES with it: style governs how narration reads,
the workflow directive governs what the session does. `workflow = 'none'` appends nothing.
_Avoid_: "system prompt" (the directive is one appended block, not the whole prompt);
"style directive" (orthogonal — style is register, workflow is behavior; both append, ADR-0002 D5).

## Login

**Gated surface** — a surface that requires an authenticated session: the **Knowledge
Base** and **Team Chat**. The Workspace task orchestrator is deliberately NOT one —
gating the operator's own tooling buys nothing. The gated set is one list,
`PROTECTED_PREFIXES` in `auth.ts`; a new gated route goes there, never behind an ad-hoc
check in a handler.
_Avoid_: "the app requires login" (two surfaces do, the orchestrator does not);
"protected route" used loosely (the prefix list is the definition).

**Account** — a provisioned user row (`users`), created only by the `create-user` CLI.
There is no self-serve signup and no password-reset flow; re-running the CLI for an
existing username resets that password, and that is the whole recovery story.
_Avoid_: "sign-up" / "registration" (neither exists); "member" (a `members` row is the
Team roster projection of an account, not the account).

**Session** — a server-side row (`sessions`) holding the sha256 of a bearer token and an
expiry, minted by login and destroyed by logout. Deliberately NOT a JWT: revocation and
expiry would need a server-side list anyway, which is this table with extra steps.
Slides on activity — renewed once less than six days of its seven-day window remain — so
it dies only after a genuine week of inactivity.
_Avoid_: "token" alone (the raw token is the client's credential; the session is the
server's record of it, and only its hash is stored); "JWT" (explicitly rejected).

**Two transports** — the one session token travels two ways: an `HttpOnly;
SameSite=Strict` cookie for same-origin browsing, and an `Authorization: Bearer` header
for the desktop app's cross-origin Team connection to the VPS, which no cookie can reach
without TLS. The bearer path is the weaker of the two (readable by JS) and is accepted
because the perimeter is Tailscale-only.
_Avoid_: "cookie auth" / "token auth" as if choosing one (both exist, by transport, and
the server resolves bearer first, then cookie).

**Origin-keyed session** — the client stores one session PER SERVER ORIGIN, because a
session is only meaningful to the server that issued it and the desktop app talks to two
(local sidecar for the KB, VPS for Team). One submit of the login form POSTs the same
credentials to every gated origin in parallel, so the operator types their password once.
_Avoid_: "SSO" / "single sign-on" (there is one LOGIN, not one ACCOUNT — the servers do
not trust each other, and `create-user` must be run on each host).

**Changelog** — the `kb_changelog` feed: one row per KB page create / rename / move /
body-save / delete, naming the user who did it, and outliving the page it describes.
Distinct from **page revisions**, which are restorable body snapshots that only ever see
body saves and are deleted with their page.
_Avoid_: "history" (ambiguous between the two — say "revisions" for the restorable
snapshots, "changelog" for the audit feed).
