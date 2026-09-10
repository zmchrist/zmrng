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
