# ADR-0001 — Deterministic security-scan gate (lightweight profile)

- **Status:** Accepted (implementation not started)
- **Date:** 2026-09-10
- **Deciders:** zc
- **Plan:** `.agents/plans/security-scan-gate.md` (Rev 2, post-grill)

## Context

AI coding workers are systematically weak at security in two classes zmrng's current
pre-PR gate (`typecheck && lint && test && build`) cannot catch: vulnerabilities
written into the code (SAST) and dependencies pulled in with known CVEs, including
transitive ones (SCA). Stacking another reviewer agent does not help — the reviewer
shares the implementer's blind spots. The fix is a machine-run scanner bracketing a
probabilistic fix: same input every run, pass/fail asserted by a tool, never
self-certified by the agent.

The original plan (Rev 1) specified this as a heavyweight in-worker phase: a new
`scanning` TaskStatus, an execute lane held through scan+fix, the full gate on both
flows, `p/owasp-top-ten` rules, network-default scanners, and a `blocked` park when
binaries are absent. It was then grilled under an explicit operator directive: keep
the workflow lightweight/seamless, cut agent time, don't make it cumbersome. Recon
falsified two Rev 1 premises — the "offline/no-SaaS" claim (default `semgrep --config
p/*` and `osv-scanner` both hit the network) and the "already available" assumption
(both binaries absent on the dev Mac). Seven decisions reshape the gate into a lean,
high-signal, lane-friendly, offline check.

## Decision

Ship the deterministic gate in a **lightweight profile**:

1. **D1 — High-signal-only ruleset.** Drop `p/owasp-top-ten`; run `p/secrets` + a
   curated high-confidence SAST set. Block ONLY on Semgrep `ERROR`+high-confidence
   and osv fix-available. Noise is the real agent-time cost.
2. **D2 — Asymmetric flow gating.** `plan` flow gets full SAST+SCA; `direct` flow
   gets SCA-only, preserving its deliberate snappiness.
3. **D3 — Lane released during the machine scan.** The deterministic scan holds no
   execute lane; a lane is re-acquired only for a red→fix round.
4. **D4 — Vendored/offline scanners.** Pinned Semgrep rules dir + offline osv DB,
   refreshed out of band; no per-PR network round-trip.
5. **D5 — Auto-provision binaries.** Provision semgrep/osv on first use; `blocked`
   only if provisioning fails, never as the primary path.
6. **D6 — No new `scanning` TaskStatus.** The scan folds into `validating`; sub-state
   lives in a runtime map + `security` event + `securityStatus` column.
7. **D7 — Round budget default 2** (was 3).

The hard invariants from Rev 1 are UNCHANGED: hard gate in-worker before the PR;
orchestrator (not the agent) runs the scanners and asserts the verdict; fail-closed
on scanner error; baseline-diff so pre-existing debt never gates; additive-only DB
migration; the agent is only ever the *fixer*, bracketed by machine scans.

## Q → Decision

| Q | Decision |
|---|---|
| Q1 Ruleset scope | D1 — drop owasp-top-ten; high-signal-only, ERROR+high-confidence |
| Q2 Which flows gated | D2 — plan full; direct SCA-only |
| Q3 Lane during scan | D3 — release the lane; re-acquire only for a fix round |
| Q4 Network stance | D4 — vendored/offline, refreshed out of band |
| Q5 Missing binary | D5 — auto-provision; block only on provision failure |
| Q6 New status vs fold | D6 — fold into `validating`, no new TaskStatus |
| Q7 Max rounds | D7 — default 2 |

## Consequences

- The gate fires rarely and only on real issues → minimal wasted autonomous fix
  rounds, directly serving the "cut agent time" directive.
- Concurrency is preserved (2 lanes never idled on machine work).
- No per-PR network latency/flakiness; local-first ethos restored honestly.
- No board-status churn; the operator sees scanning as a `validating` sub-label/event.
- **Costs accepted:** low/low-confidence findings don't block (surfaced for humans);
  a SAST bug in a menial direct task isn't machine-caught pre-PR; a vendored ruleset +
  offline DB go stale between refreshes (a refresh job to own); a two-stumble real fix
  parks for human review one round sooner.

## Rejected alternatives

- **Agent-as-security-reviewer as the gate** — same blind spots as the implementer.
- **Keep worker opening the PR, scan post-PR in CI only** — no pre-PR iteration;
  rejecting an already-open PR is ugly. (A CI mirror may be added *as well*, later.)
- **New `scanning` TaskStatus** — churn across pills/labels/guards/lane-accounting/
  resume for a phase already visible via an event (D6).
- **`p/owasp-top-ten` default** — FP-heavy; every false positive spins a fix round.
- **Full-repo scan** — punishes the task for pre-existing debt; floods the fixer.
- **Hold the lane through scan+fix** — idles a scarce lane on deterministic work.
- **Network-default scanners** — per-PR round-trip; flaky and slow.
- **Park `blocked` on missing binary as the primary path** — every task blocks until a
  manual two-tool install.
- **SonarQube** — free only on public repos; self-hosting is heavy (JVM+Postgres+RAM).
  A Sonar adapter can implement `ScanRunnerFactory` later.
- **Adopt Archon as the engine** — high-regret rewrite; only the YAML-as-data idea is
  worth taking, and only after the phase set is final (deferred Phase 2).
