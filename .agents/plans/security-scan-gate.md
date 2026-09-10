# Plan — Deterministic security-scan gate (Path A + phases-as-YAML deferred)

> **Rev 2 (post-grill, zc, 2026-09-10).** Grilled under the directive "keep the
> workflow lightweight/seamless, cut agent time, zoom range not heavy/cumbersome."
> Seven decisions locked (D1–D7 below) — they REVISE the Rev 1 body that follows.
> Where a locked decision reverses Rev 1 prose, a **Grill note:** is inlined at that
> spot; the D-block is authoritative. Recon receipts: `semgrep`/`osv-scanner` both
> ABSENT on this Mac; default `semgrep --config p/*` and `osv-scanner` both hit the
> NETWORK (registry + api.osv.dev) — the Rev 1 "offline/no-SaaS" premise (L54, L280)
> was false as written. `maxLanes=2` (config.ts:577). `validating` is already a live
> status with `VALIDATING_RE` (phases.ts:35). Docs produced: `docs/adr/0001-…md`,
> `CONTEXT.md`.

## Decisions (locked)

### D1 — Ruleset is high-signal-only; noise is the real agent-time cost
**Decision:** Drop `p/owasp-top-ten`. Semgrep runs `p/secrets` + a curated
high-confidence SAST set (default `p/semgrep` registry pack + language injection
rules). The gate **blocks only** on Semgrep `ERROR` severity AND high confidence,
plus any osv vuln with a fix available. Everything else is recorded, never gated.
**Why:** every false positive = a wasted fix round = burned agent time — the single
highest-leverage lever against the "cut agent time" directive. A gate that fires
rarely and only on real issues is what keeps the workflow seamless.
**Cost accepted:** a genuine low/medium-severity or low-confidence finding won't
block the PR (it's still surfaced for a human). Under-blocking is the correct bias
for an autonomous loop.
**Rejected:** `p/owasp-top-ten` as the default (Rev 1 L213) — FP-heavy, each spurious
red spins an autonomous fix round on a non-bug.

### D2 — Asymmetric flow gating: plan flow full, direct flow SCA-only
**Decision:** `plan` flow gets the full gate (SAST + SCA). `direct` flow runs the
**osv/SCA (dependency-CVE) check only** — no Semgrep SAST pass.
**Why:** direct is deliberately stripped for menial self-contained work
(phases.ts:279 — no QA/reviewer/doc subagents, conditional TDD); such changes rarely
introduce SQLi/path-traversal but a bad dep pin is both realistic and cheap to catch.
Keeps direct snappy while covering its actual risk.
**Cost accepted:** a SAST-class bug hand-written in a "menial" direct task isn't
machine-caught pre-PR (still catchable by a later CI mirror if added).
**Rejected:** gate both flows fully (heaviest, fights the directive); skip direct
entirely (a dep-CVE slips through a "menial" bump).

### D3 — Release the execute lane during the machine scan
**Decision:** the deterministic scanner run holds **no** execute lane. `onScanReady`
frees the lane before invoking `scanFactory`; a lane is re-acquired only if the scan
is red and a fix round is needed (queue behind the cap like any other execute work).
**Why:** the scan needs no live agent — idling one of only 2 lanes (config.ts:577)
on machine work halves concurrency for nothing.
**Cost accepted:** a red→fix transition may queue behind the lane cap (a fix round is
real agent work and correctly competes for a lane); extra transient state (a
`scanPending` set, lane-free).
**Rejected:** hold the lane through scan+fix (Rev 1 §1/L84-88) — wastes a scarce lane
on a deterministic step.

### D4 — Vendored/offline scanners, refreshed on a schedule not per-PR
**Decision:** commit a pinned Semgrep rules directory into zmrng and run
`semgrep --config <vendored-dir>` (no registry fetch); run osv-scanner with a
downloaded offline database (`--offline --download-offline-databases` refreshed out
of band, e.g. a scheduled job), not the per-run api.osv.dev query.
**Why:** restores the local-first ethos the Rev 1 text CLAIMED but the default
commands break; removes a per-PR network round-trip → no per-PR latency/flakiness.
**Cost accepted:** rules + vuln DB go stale between refreshes (acceptable for a gate,
not a live threat feed); a refresh job to own.
**Rejected:** default `--config p/*` + live osv API (Rev 1 L163-165, L280) — network
on every PR, the opposite of seamless.

### D5 — Auto-provision the binaries; block only if provisioning fails
**Decision:** on first use, provision the scanners rather than parking `blocked`:
osv-scanner via a pinned downloaded static binary (or `go run`), semgrep via a pinned
`uvx semgrep`/pinned venv. Only if provisioning itself fails do we park `blocked`.
**Why:** "install two tools by hand or every task blocks" is exactly the cumbersome
friction the directive targets — both are absent on this Mac today.
**Cost accepted:** a one-time provisioning cost + a pinned-version cache to maintain.
**Rejected:** park `blocked` on missing binary (Rev 1 §4/L172-176) as the primary
path — blocks every task until a manual install.

### D6 — Fold scan into `validating`; NO new `scanning` TaskStatus
**Decision:** do NOT add `'scanning'` to `TaskStatus`. The task stays in `validating`
through the scan; scan sub-state lives in a runtime map + a `security` event/sub-label
and the persisted `security_scans` rows. `securityStatus` column stays.
**Why:** the directive promotes Rev 1's own recorded fallback (L272-274) to the
default — a new status is churn across pills/labels/guards/lane-accounting/resume/
reconcileOrphans for a phase the operator can already see via an event. `validating`
already exists with `VALIDATING_RE` (phases.ts:35).
**Cost accepted:** the operator sees "scanning" as a sub-label/event under
`validating`, not as a first-class board column.
**Rejected:** new `scanning` status (Rev 1 §1) — maximal churn against a "keep it
light" ask.

### D7 — `ZMRNG_SECURITY_MAX_ROUNDS` default 2, not 3
**Decision:** default the fix-round budget to **2**.
**Why:** with the high-signal ruleset (D1) a real issue fixes in 1 round; 2 covers a
stumble; a 3rd round mostly means the agent is flailing on a false positive → park and
let a human look. Lower cap = less wasted agent time on the bad path.
**Cost accepted:** a genuinely-hard-but-real two-stumble fix parks for human review one
round sooner. Env-tunable up for repos that want it.
**Rejected:** default 3 (Rev 1 L64/L212) — one more autonomous round before a human is
looped.

## Build sequence (post-grill)

1. **Pure module** `securityScan.ts` (parse/normalize/evaluate/format) with the D1
   threshold logic (ERROR+high-confidence, osv fix-available). TDD against fixtures.
2. **Config** `resolveSecurityPolicy(env)` — D1 ruleset defaults, D7 `maxRounds=2`,
   D4 vendored-config/offline paths; per-repo `security?` override in `normalizeEntry`
   (config.ts:292). Implements D1/D4/D7.
3. **Scanner provisioning + runner** `ScanRunnerFactory` + `defaultScanRunnerFactory`:
   vendored semgrep rules dir, offline osv DB, first-use auto-provision (D4/D5).
4. **Types mirror** (both `types.ts`) — `SecurityFinding`/`Verdict`/`Policy`,
   `securityStatus?`, `security` `EventKind`. **NO `'scanning'` in `TaskStatus`** (D6).
5. **DB** additive `security_scans` table + `securityStatus` column (unchanged from Rev 1 §7).
6. **Prompts** — `ZMRNG_SCAN_READY` commit-and-wait tail replaces the push/PR tail in
   `executeKickoff` AND `directKickoff`; `securityFixKickoff` + `openPrKickoff`. Direct's
   fix prompt is SCA-only framed (D2).
7. **Orchestrator** `onScanReady` + iterate loop: free the lane before scan (D3),
   fold state into `validating` (D6), plan=full / direct=SCA-only branch (D2), round
   budget 2 (D7), fail-closed on scanner error.
8. **Route + web** `GET /api/tasks/:id/security-scans`, `api.listSecurityScans`, a
   Security findings panel + a `validating`-sub "scanning" label (NOT a new pill) (D6).
9. **Validate + Sync Docs** — four gates green; update CLAUDE.md lifecycle note (scan
   as a `validating` sub-step, not a new phase), codemap, `repos.example.json`.

## Motivation

AI coding workers are systematically weak at security in two ways the current
zmrng gate cannot catch:

1. **Vulnerabilities written into the code** — SQL injection, path traversal,
   hard-coded secrets, unsafe deserialization (SAST class).
2. **Dependencies pulled in with known CVEs**, including *transitive*
   sub-dependencies the worker never inspects (SCA class).

zmrng's pre-PR gate today is `typecheck && lint && test && build` — all
*static correctness*, zero *security*. A worker can ship a green PR that
compiles, lints, tests, and builds while carrying a SQLi or a CVE-laden
lockfile. An "add another agent to review it" step is **not** enough: the
reviewer agent shares the implementer's blind spots, so a probabilistic check
stacked on a probabilistic process still lets the same class of issue through.

The fix (per the deterministic-gates approach) is a **machine-run scan bracketing
a probabilistic fix**: run a fixed scanner the same way every time → if red, force
the worker to iterate → **re-run the same scanner and machine-assert green** →
only then allow the PR. The input is identical every run and the pass/fail
verdict is asserted by a tool, never self-certified by the agent.

This is **Path A**: implement the gate as native zmrng phases/seams (not by
adopting Archon as the engine). **Phase 2** (deferred, sketched at the end) is the
single idea worth stealing from Archon — externalizing the phase prompt chain
into versioned YAML so the workflow is editable without a rebuild — sequenced
*after* the security phase set is final.

## Goal (scope)

A new **orchestrator-enforced, deterministic security gate** that runs between
the execute/validate chain and PR creation, for **both** the `plan` and `direct`
flows:

1. Worker finishes implementation + the existing QA/validate/docs chain and
   **commits**, then emits a new control token `ZMRNG_SCAN_READY` and **stops
   without pushing or opening the PR**.
2. The **orchestrator** (deterministic TypeScript, not an agent) runs the fixed
   scanner set on the worktree and parses the result through a pure module.
3. Verdict:
   - **green** → orchestrator instructs the live worker session to push the
     branch and open the PR (existing PR path unchanged from there).
   - **red** & rounds remain → orchestrator feeds the findings back into the
     same live session, forcing a fix; worker re-commits and re-emits
     `ZMRNG_SCAN_READY`; the orchestrator **re-scans** (machine-asserted green).
   - **red** & rounds exhausted → park the task `blocked` with a findings
     summary for the operator (child kept alive, same as the missing-subagent
     block path).
4. Scanner set: **Semgrep** (SAST) + **osv-scanner** (SCA, incl. transitive
   deps). Both are free, static-binary, no-account, JSON-out, no SaaS — fits the
   local-first / Max-OAuth / no-cloud ethos. A SonarQube adapter can slot in
   later behind the same seam (see Alternatives).
5. Scans only **new** findings introduced by the branch (baseline-diff against
   the merge-base), so a task is never gated on pre-existing repo debt.
6. Findings + verdict per round are **persisted** (`security_scans` table) and
   surfaced in the UI (a `scanning` status pill + a findings panel). Read-only;
   the iterate loop is autonomous.

**Hard gate, in-worker, before the PR** — a red scan blocks the PR and forces
iteration; it is not a soft report and not a post-PR CI-only check. Bounded
retries (`ZMRNG_SECURITY_MAX_ROUNDS`, default 3) prevent an infinite loop.

**Out of scope (this plan):**
- Phase 2 phases-as-YAML externalization (separate plan; sketched below).
- SonarQube integration (future adapter behind the `ScanRunnerFactory` seam).
- A post-merge scheduled regression / discovery-publishing loop.
- PRD → backlog slicing, mission/out-of-scope drift gate, holdout verification
  (the other ai-software-factory ideas — separate future plans).
- A CI-side scan mirror in target repos (optional belt-and-suspenders, noted as
  a follow-up, not built here).

## Approach

> **Grill note (D6):** REVERSED. No new `scanning` status — the scan folds into
> `validating`. §1 below is superseded; kept for the rejected-alternative rationale.

### 1. New `scanning` TaskStatus (between `validating` and `review`)

The scan is a genuine new phase with its own iterate loop and its own UI pill, so
it earns a real status rather than being hidden inside `validating`.

- Add `'scanning'` to the `TaskStatus` union (server + web mirror).
- It is a **live** phase (like planning/executing/validating): included in the
  active set for token detection, `reconcileOrphans` staleness, the crash-fail
  guard in `onExit`, and lane accounting (the task holds its execute lane
  through the scan, since the same live worker session is doing the fixing).
- Status-pill / label / board additions in the web layer (one `--status-*`
  token, mirror the `validating` pill).

**Decision (flagged):** a new status adds churn across pills/labels/guards. The
lower-churn alternative is to keep the task in `validating` and track scan state
only in a runtime map. Recommended: the new status — the operator should *see*
"scanning for vulnerabilities" and the round count; it is the headline value of
this change. (Alternative recorded below.)

### 2. New control token `ZMRNG_SCAN_READY`

- Add `SCAN_READY_RE = /^\s*ZMRNG_SCAN_READY\s*$/m` (anchored, same convention
  as `READY_RE`/`VALIDATING_RE`).
- Emitted by the worker after the validate/docs chain **and the commit**, in
  place of today's "push → open PR → print URL" tail. The worker then waits.
- Detected in `detect()` while the task is in `executing`/`validating`/`scanning`
  → drives `onScanReady(task)`.

### 3. Kickoff changes — commit, then hand the PR back to the orchestrator

Both `executeKickoff` and `directKickoff` change their tail:

- **Today:** … run validation → commit → `git push -u origin <branch>` → write PR
  body → `gh pr create …` → print PR URL.
- **New:** … run validation → commit **on the branch** →
  print `ZMRNG_SCAN_READY` on its own line → **STOP. Do not push. Do not open the
  PR. Wait for the orchestrator's next instruction** (the orchestrator runs a
  deterministic security scan and will either tell you to open the PR, or hand
  you findings to fix).

Two **new** exported kickoffs (single-sourced, pinned in `prompts.test.ts`):

- `securityFixKickoff(findings: string, round, maxRounds)` — sent into the **same
  live session** when the scan is red. Contains: the deterministic scan report
  (formatted findings), the instruction to fix every **blocking** finding (fix
  the code / pin or replace the vulnerable dependency, do not merely note it in
  the PR body), TDD where a regression test is meaningful, re-commit in place,
  then re-emit `ZMRNG_SCAN_READY`. States the round budget so the worker knows
  the gate re-asserts green by machine.
- `openPrKickoff(branch, defaultBranch, planPath?)` — sent when the scan is
  green. Reuses `PR_BODY_TEMPLATE` verbatim; instructs push → write PR body →
  `gh pr create` → print URL. This is the extracted tail of the current
  execute/direct kickoffs, so no PR ceremony is duplicated.

Rationale: the execute runner is a live `claude --input-format stream-json`
process that already supports multi-turn `send()` (that is how clarify
multi-turns). Feeding the fix prompt / open-PR prompt into the same session
avoids a fresh-session spawn per round and preserves the worker's context.

### 4. Deterministic scan — pure seam + injected runner

**Pure module `packages/server/src/securityScan.ts`** (React-free, IO-free —
mirrors the pure-reducer / tolerant-parser seams):

- `parseSemgrep(raw: string): SemgrepFinding[]` — tolerant (never throws on
  malformed/empty JSON; unknown shape → `[]`).
- `parseOsv(raw: string): OsvFinding[]` — tolerant, walks results → packages →
  vulnerabilities (incl. transitive), captures whether a fixed version exists.
- `normalizeFindings(semgrep, osv): SecurityFinding[]` — unified shape
  (`{ tool, ruleId, severity, title, path?, line?, package?, cve?, fixAvailable? }`).
- `evaluateThreshold(findings, policy): { verdict: 'pass'|'fail'; blocking:
  SecurityFinding[] }` — the deterministic gate logic.
- `formatFindingsForAgent(blocking): string` — the report string fed to
  `securityFixKickoff` (stable, deterministic ordering).

**Injected `ScanRunnerFactory`** (mirrors `RunnerFactory` / `PtyFactory`):

```ts
export interface ScanRequest { worktree: string; baseRef: string; policy: SecurityPolicy }
export interface RawScanOutput { semgrep: string; osv: string; toolVersions: Record<string,string> }
export type ScanRunnerFactory = (req: ScanRequest) => Promise<RawScanOutput>
export const defaultScanRunnerFactory: ScanRunnerFactory = /* execFile semgrep + osv-scanner */
```

- Default impl runs, from the worktree:
  - `semgrep --config <policy.semgrepConfig> --baseline-commit <merge-base> --json`
    (baseline-diff → only findings the branch introduced).
  - `osv-scanner --format json --lockfile <detected lockfile>` (or `--recursive`
    on the worktree) for new/changed dependencies.
  - Merge-base resolved via `git merge-base <defaultBranch> HEAD`.
- `TaskManager` takes `scanFactory: ScanRunnerFactory = defaultScanRunnerFactory`
  as a 4th constructor arg. Tests inject a fake returning fixture JSON — the
  orchestrator scan step never spawns real scanners, hits the network, or needs
  the binaries installed.

> **Grill note (D4/D5):** REVISED. Scanners run VENDORED/OFFLINE (pinned semgrep
> rules dir; osv offline DB), not the network defaults shown above. Missing binaries
> are AUTO-PROVISIONED on first use; `blocked` only if provisioning fails.

**Missing binaries** — reuse the `preflight.checkOnPath` heuristic. If a
required scanner is absent: the gate cannot run deterministically, so **park
`blocked`** ("install `semgrep` / `osv-scanner` to satisfy the security gate, or
disable it for this repo") — never silently skip. The **only** non-blocking
escape is an explicit per-repo opt-out (below).

### 5. Orchestrator wiring — `onScanReady` + the iterate loop

New private flow in `TaskManager`:

- `securityRounds: Map<string, number>` (runtime, transient; cleared on
  completion/cancel/delete alongside the existing transient sets).
- `onScanReady(task)`:
  1. `transition(task.id, 'scanning', 'running security scan')`.
  2. Resolve `SecurityPolicy` for the task's repo (§6). If `enabled === false` →
     `send(openPrKickoff(...))` and return (opt-out path — the only silent skip,
     recorded as `securityStatus: 'skipped'`).
  3. Preflight the scanner binaries; if missing → `onBlocked(task, '…install…')`.
  4. `await scanFactory({ worktree, baseRef: defaultBranch, policy })`.
  5. `const findings = normalizeFindings(parseSemgrep(...), parseOsv(...))`;
     `const { verdict, blocking } = evaluateThreshold(findings, policy)`.
  6. Persist a `security_scans` row (task, round, verdict, findings JSON, tool
     versions); patch `securityStatus`; emit a `security` event (findings summary
     for the UI).
  7. **green** → `patch(securityStatus:'pass')`; `send(openPrKickoff(...))`. The
     existing `ZMRNG_...`/PR-URL detection then drives `onPr` → `review`.
  8. **red** & `round < maxRounds` → increment round;
     `send(securityFixKickoff(formatFindingsForAgent(blocking), round, maxRounds))`.
     The worker fixes, re-commits, re-emits `ZMRNG_SCAN_READY` → `onScanReady`
     re-runs (the machine re-assertion).
  9. **red** & rounds exhausted → `onBlocked(task, 'security scan still red after
     N rounds — <short summary>')`. Child kept alive; operator inspects/resumes.
- A scan-run failure (scanner crash / unparseable output that is not simply
  "no findings") is treated as **red-blocked**, never as a pass — a broken gate
  must fail closed.

### 6. Per-repo `SecurityPolicy` (global default + optional override)

- A global default `SecurityPolicy` on `config`, env-tunable:
  - `ZMRNG_SECURITY_ENABLED` (default `true`)
  - `ZMRNG_SECURITY_MAX_ROUNDS` (default `2`)  <!-- Grill note D7: was 3 -->
  - `ZMRNG_SECURITY_SEMGREP_CONFIG` (default: vendored high-signal dir + `p/secrets`;
    <!-- Grill note D1: dropped p/owasp-top-ten as FP-heavy -->)
  - `ZMRNG_SECURITY_MIN_SEVERITY` (default: block Semgrep `ERROR`; block any
    osv vuln that has a fix available)
- Optional per-repo override on the `RepoTarget` entry in `config/repos.json`
  (new optional `security?: Partial<SecurityPolicy>` field), merged over the
  global default. Documented in `repos.example.json`. Repos that say nothing
  inherit the default. `security.enabled = false` is the honest opt-out.

**Decision (flagged):** policy source is `config/repos.json` (where repo-specific
zmrng config already lives) rather than a new `.zmrng/security.json` convention
inside each target repo. A repo-versioned policy file is a reasonable future
addition but is more surface than Phase 1 needs.

### 7. DB — additive `security_scans` table + `securityStatus` column

Per the ADDITIVE-ONLY migration policy:

- `security_scans` table (`CREATE TABLE IF NOT EXISTS` in `SCHEMA`): `id`,
  `task_id`, `round`, `verdict`, `findings_json`, `tool_versions_json`,
  `created_at`. `SecurityScanRow` + `rowToSecurityScan` mapper; prepared
  statements mirroring the `task_comments` / `chat_messages` patterns
  (`insertSecurityScan`, `listSecurityScansForTask`).
- `securityStatus TEXT` column on `tasks` via `ensureColumns()` (nullable;
  `'pending'|'pass'|'fail'|'skipped'`), mirrored on `Task` (`securityStatus?`),
  with `TaskRow` / `rowToTask` / `TaskPatch` / `COLUMN_BY_FIELD` wired — exactly
  the `stale`/`queued` precedent, so existing fixtures need no change.

### 8. Types mirror (BOTH files)

`packages/server/src/types.ts` (source) + `packages/web/src/types.ts` (mirror):
`SecuritySeverity`, `SecurityFinding`, `SecurityVerdict`, `SecurityPolicy`,
`'scanning'` in `TaskStatus`, `securityStatus?` on `Task`, and a `security`
`EventKind` payload variant for the findings summary. `npm run typecheck` over
both workspaces catches drift.

### 9. Web UI (read-only)

- `scanning` status pill + label (mirror `validating`), one `--status-*` token —
  **grep `theme.css` to confirm the token name exists before using it.**
- A **Security** section in the worker/task panel: current `securityStatus`, the
  round count, and the latest blocking findings (tool, rule/CVE, severity,
  file:line or package). Fed by the persisted rows via a small
  `GET /api/tasks/:id/security-scans` endpoint (or the `security` ws event for
  live updates). Connection glue stays thin; the render is derived from a plain
  list — no new pure reducer required unless the live/merge case needs one.

## Alternatives rejected

- **Agent-as-security-reviewer only** (a `zmrng-security-reviewer` subagent in
  the QA chain, no tool) — the exact anti-pattern this plan exists to beat: same
  blind spots as the implementer, green PR with the vuln still in. Kept nowhere
  as the *gate*; an agent is only ever the *fixer*, bracketed by machine scans.
- **Keep the worker opening the PR, scan post-PR in CI only** — the worker never
  iterates before the operator sees the PR, and rejecting an already-open PR is
  ugly. In-worker + pre-PR is the whole point (a CI mirror can be added *as
  well*, later).
- **Run the scan inside the worker via a seeded script (agent-driven)** — the
  agent could skip or misreport it; determinism requires the orchestrator to run
  it and assert the verdict. The worker only *fixes*.
- **Keep the task in `validating`, no new status** — lower churn, but the
  operator can't see the scan phase or round count. Recorded as the fallback if
  the status churn proves costly.
- **Full-repo scan (not baseline-diff)** — punishes the task for pre-existing
  repo debt and floods the fixer with unrelated findings; baseline-diff against
  the merge-base gates only what the branch introduced.
- **SonarQube (Cole's tool)** — Sonar Cloud is free only on public repos; private
  repos need a paid plan or a self-hosted SonarQube Community (JVM + Postgres +
  heavy RAM), against the local-first ethos. Semgrep + osv-scanner give both vuln
  classes free and offline. A Sonar adapter can implement `ScanRunnerFactory`
  later for anyone who wants the dashboard — the seam is deliberately generic.
- **Adopt Archon as the engine now** — high-regret rewrite of runner/phases,
  discards the tailored sentinel state machine, and Archon's SDLC pack is not yet
  merged upstream. Only the YAML-as-data idea is worth taking, and only after the
  phase set (incl. this gate) is final — hence Phase 2 is deferred.

## Files to change

**Server**
- `packages/server/src/types.ts` — `'scanning'` status; `securityStatus?` on
  `Task`; `SecuritySeverity`/`SecurityFinding`/`SecurityVerdict`/`SecurityPolicy`;
  `security` `EventKind` payload.
- `packages/server/src/securityScan.ts` — **new** pure module (parse / normalize /
  evaluate / format).
- `packages/server/src/config.ts` — global `SecurityPolicy` default + env parsing
  (a pure `resolveSecurityPolicy(env)` mirroring `resolveAuthMode`); optional
  `security?` on `RepoTarget` in `normalizeEntry`.
- `packages/server/src/runner.ts` (or a new `scanRunner.ts`) — `ScanRunnerFactory`,
  `defaultScanRunnerFactory`, `ScanRequest`/`RawScanOutput`.
- `packages/server/src/phases.ts` — `SCAN_READY_RE`; `securityFixKickoff` +
  `openPrKickoff` (exported); `executeKickoff`/`directKickoff` tail change; the
  `scanFactory` constructor arg; `onScanReady` + the iterate loop; `securityRounds`
  map + transient-set hygiene in cancel/done/delete; `detect()` handles
  `ZMRNG_SCAN_READY`; `scanning` added to the live-phase sets (`reconcileOrphans`,
  `onExit` fail guard, lane accounting); resume handling for a `scanning` orphan.
- `packages/server/src/db.ts` — `security_scans` table + row/mapper + prepared
  statements; `securityStatus` column via `ensureColumns()`; `TaskRow`/`rowToTask`/
  `TaskPatch`/`COLUMN_BY_FIELD`.
- `packages/server/src/index.ts` — construct `TaskManager` with the scan factory;
  `GET /api/tasks/:id/security-scans`.

**Web (mirror + UI)**
- `packages/web/src/types.ts` — mirror every shared type above.
- `packages/web/src/api.ts` — `listSecurityScans(id)`.
- `packages/web/src/components/…` — `scanning` pill/label; the Security findings
  panel in the worker/task view; wire the new api call / `security` event.
- `packages/web/src/theme.css` — a `--status-scanning` token only if a suitable
  one does not already exist (grep first).

**Docs (Sync Docs step)**
- `CLAUDE.md` — the new phase in the lifecycle diagram (… validating → **scanning**
  → review), the gate description, the new env vars, the ADDITIVE `security_scans`
  note.
- `.claude/docs/codemap.md` + `.claude/docs/services-reference.md` —
  `securityScan.ts`, `scanRunner`, the new `TaskManager` methods, the route.
- `config/repos.example.json` — document the optional `security` override.
- `.claude/errors.md` — any gotcha found during build (e.g. semgrep baseline
  behavior on a shallow worktree).

## Step-by-step implementation (TDD)

1. **Pure module (RED→GREEN):** `test/securityScan.test.ts` with fixture JSON in
   `test/fixtures/` — `parseSemgrep`/`parseOsv` tolerant on empty/malformed/
   unknown shape; `normalizeFindings` merges + captures transitive osv +
   fixAvailable; `evaluateThreshold` blocks/allows per policy (severity floor,
   fix-available rule); `formatFindingsForAgent` stable ordering. Then implement
   `securityScan.ts`.
2. **Config (RED→GREEN):** `test/config.test.ts` — `resolveSecurityPolicy(env)`
   defaults + overrides; `RepoTarget.security` parsed/merged. Then implement.
3. **Types mirror:** add all shared types to both `types.ts`; `npm run typecheck`.
4. **DB (RED→GREEN):** `test/db.test.ts` — `security_scans` created (raw
   `sqlite_master`), round-trip, idempotent re-open, persist-across-reopen;
   `securityStatus` migrates onto a legacy schema + round-trips. Then implement.
5. **Prompts (RED→GREEN):** `test/prompts.test.ts` — pin the `ZMRNG_SCAN_READY`
   commit-and-wait tail in `executeKickoff` **and** `directKickoff` (and the
   removal of the old inline push/PR from the primary path); a `securityFixKickoff`
   describe (contains the report, "fix don't just report", round budget, re-emit
   token) and an `openPrKickoff` describe (reuses `PR_BODY_TEMPLATE` verbatim —
   `toContain(PR_BODY_TEMPLATE)`). Then edit the prompts.
6. **State machine (RED→GREEN):** `test/taskManager.test.ts` — inject a
   `FakeScanRunner`:
   1. Drive a task to `executing`; scripted `ZMRNG_SCAN_READY` → task goes
      `scanning`, scan runs.
   2. **green** fixture → worker receives `openPrKickoff`; a scripted PR URL →
      `review`; a `security_scans` row persisted with `verdict:'pass'`.
   3. **red then green**: round 1 red → worker receives `securityFixKickoff` with
      the findings + round 1/3; scripted re-emit `ZMRNG_SCAN_READY` → round 2
      green → `openPrKickoff` → PR → `review`. Assert two persisted scan rows.
   4. **rounds exhausted**: `maxRounds=1`, red both times → task parks `blocked`
      with a findings-summary reason; child stays alive.
   5. **opt-out**: `security.enabled=false` → straight to `openPrKickoff`,
      `securityStatus:'skipped'`, no scan row.
   6. **missing binary**: fake preflight reports semgrep absent → `blocked` with
      the install message; no pass.
   7. **fail-closed**: scan factory rejects / returns garbage → treated as red,
      never pass.
7. **Route + boot wiring** in `index.ts` (+ a light route test if the repo has an
   HTTP-inject harness; otherwise covered by the db/state tests, matching the
   repo's existing thin-wrapper convention).
8. **Web:** `api.listSecurityScans` + `scanning` pill + Security panel (+ a
   component test asserting a red task renders its blocking findings and the
   round count, and a `scanning` task shows the scanning pill).
9. **Validate + Sync Docs** — all four gates green; run `sync-docs`; update
   CLAUDE.md lifecycle diagram + codemap/services-reference; screenshot the
   Security panel (best-effort).

## Test strategy

Runner: **Vitest**, both workspaces — `npm test` (server `node`, web `jsdom`).
Hermetic: the pure module and threshold logic are unit-tested against committed
fixture JSON; the state-machine test injects `FakeScanRunner` + the existing
`FakeRunner` on the temp-git-repo harness in `taskManager.test.ts` — **no real
`semgrep`/`osv-scanner`, no real `claude`/`gh`, no network**. Prompt behavior is
pinned as regex/`toContain` contracts in `prompts.test.ts` (the kickoff strings
are the harness — a silent edit that drops the commit-and-wait rule or the
fix-don't-report rule degrades every future run with no other signal). Every test
count stays ≥ baseline; the gate ADDS coverage. The one genuinely
un-unit-testable path — that the real `semgrep`/`osv-scanner` binaries produce
the JSON shapes the parsers expect — is verified once by hand against the real
tools on a repo with a known planted vuln, and that verification is recorded in
the implementation report (the fixtures are captured from that real run).

---

## Phase 2 (DEFERRED — separate plan) — the one idea from Archon: phases-as-YAML

Once the phase set is final **including this security gate**, externalize the
hardcoded prompt chain in `phases.ts` into a versioned YAML workflow
(`clarify → plan → execute → validate → **scan** → PR`), so the workflow can be
edited/tuned without a TypeScript rebuild, diffed in git, and eventually A/B'd.
This is the Archon "workflow as data" lever, ported natively — NOT adopting
Archon as the engine. Do it **after**, never during: externalizing a moving
target is wasted work, and the security gate is what makes the phase set worth
freezing. The same YAML seam is where an alternate gate (e.g. a SonarQube
`ScanRunnerFactory`) or a future runtime-verification phase would plug in. Write
its own plan when we get there.
