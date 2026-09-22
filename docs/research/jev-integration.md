# Jev (TypeSafe AI) — integration research for zmrng

*Researched 2026-09-22. Vendor claims are marked as such; nothing below has been benchmarked
against zmrng's own workloads.*

## What Jev is

Jev is the first **"System One" model** from TypeSafe AI (announced 2026-09-15). It is not a
chat model: it takes unstructured application state plus a map of **typed questions** and returns
**typed answers with calibrated probabilities** — no prose, no schema errors. The founder's framing
is "unstructured state in, typed probabilistic decisions out."

- **Question primitives:** `Choice` (one of up to 255 options), `Score` (an ordered scale), and
  `Noul` (a binary yes/no returning a 0–1 probability). Choice and Score also carry a 0–1
  confidence derived from the shape of the probability distribution.
- **Surface:** one endpoint, `POST https://api.typesafe.ai/v1/systemone`, carrying `state`,
  `model` (e.g. `jev-latest`), and the question map; all questions in a request are answered in
  parallel. SDKs exist for JS (`@typesafe-ai/sdk`) and Python.
- **Vendor-claimed performance:** 70–500 ms end-to-end, $0.042 per million input tokens, output
  tokens free, ~32k context on Jev 1.13. Text input only — no images, audio, or PDFs.
- **Status:** hosted API in early access behind a waitlist. No weights, no self-hosting. "Zero
  hallucinations" means *schema compliance only* — a well-typed answer can still be wrong.

The natural fit is a decision point already buried inside software, where the code wants a small
typed answer plus a confidence it can threshold on, and where a full LLM turn is overkill.

## Where it could fit zmrng

Ranked by value, all evaluated against the current architecture:

1. **Security-scan verdict triage** (`securityScan.ts` / `scanRunner.ts`). The gate is
   deliberately deterministic and fail-closed: semgrep + osv-scanner, machine-asserted `pass`/
   `fail`. Jev must **never** decide the verdict — that would undo ADR 0001. The honest use is
   *downstream of* a `fail`: a `Score` on "how likely is this finding to be a real, exploitable
   issue in this diff" to order the findings the worker is handed, so a red round fixes the
   dangerous thing first instead of chasing a transitive dev-dependency advisory. Advisory
   ranking only; the gate stays deterministic.
2. **`ZMRNG_BLOCKED` reason classification** (`phases.ts`). The token carries free text. A
   `Choice` over `missing-toolchain | broken-auth | missing-subagent | needs-plan-flow | other`
   would let the board show a typed block reason and let the operator filter, without a regex
   guessing game. Low risk: misclassification costs a wrong pill, not a wrong action.
3. **Per-task model/effort selection.** Today `model` and `effort` are operator-chosen per task.
   A `Choice` over `opus|sonnet` plus a `Score` over the effort ladder, fed the task title/body
   and target repo, could pre-fill the form. Keep it a **suggestion the operator can override**,
   never an automatic switch — a silently wrong pick burns a whole run.
4. **Worker stream-event classification** (`runner.ts`). A `Score` on "is this event worth
   surfacing" could drive a signal-only filter over the worker log, or flag a run that has been
   thrashing. Nice-to-have; the log is already legible.
5. **Team `@agent` routing** (`agentResponder.ts`). `detectMention` is an exact word-boundary
   rule and works. Jev could add a `Noul` on "does this message actually want the agent" for
   implicit asks, but the current explicit trigger is a feature, not a limitation — **lowest
   priority, arguably out of scope**.
6. **Guardrails on worker actions.** Tempting and wrong. The guardrails that matter (branch-only,
   worktree hygiene, environment-file access, force-push) are enforced by deterministic hooks and
   prompt contracts. Replacing a hard rule with a probability is a regression regardless of how
   well calibrated the probability is. Jev could at most *pre-screen* an action to raise an
   advisory note alongside — never in place of — the hook.

## Integration options

- **A — Do nothing yet.** Watch it out of early access. Costs nothing, loses nothing.
- **B — One narrow probe (recommended).** Add a `JevClient` module behind an interface, wired
  into exactly one call site: `ZMRNG_BLOCKED` reason classification. It is off the critical path,
  cheap, and failure degrades to today's behaviour (`other`). It proves calibration, latency, and
  the config/test story on a decision where being wrong is harmless.
- **C — Broad adoption.** Triage ranking + model/effort suggestion + log filtering at once. Not
  justified before B has produced real numbers.

**Recommendation: B**, gated on Jev leaving early access before anything user-visible depends on
it. Every Jev call must be optional-by-default and fail-soft — if the key is absent or the call
errors or times out, zmrng behaves exactly as it does today.

## What would be annoying to integrate

- **It breaks the Max-OAuth-only invariant.** `runner.ts` deliberately strips `ANTHROPIC_API_KEY`
  so `claude` can never bill a metered API. Jev is a *separate* metered vendor with its own key.
  It does not violate the letter of that rule, but it adds a second billing surface and a second
  secret to a project whose stated posture is "no cloud" — and it sends task titles, block
  reasons, or diff findings to a third party. That is the real cost, not the $0.042/Mtok.
- **Early access.** Waitlist-gated, no SLA, one region (US West Coast), and versioned model names
  (`jev-1.13`) that will move. A hard dependency on an alpha API in the security path is a
  non-starter; that is another reason the probe belongs somewhere harmless.
- **Config and secret handling.** A new key means a new `config.ts` entry, a new gitignored
  secret, and a decision about the desktop app — the sidecar would need it too, and the app ships
  to a machine that is not the operator's dev box.
- **Test hermeticity.** `.claude/rules/testing.md` forbids network calls in tests. Jev needs the
  same injected-factory seam as `RunnerFactory`/`PtyFactory`, plus fixtures for the typed
  responses. That is the single largest chunk of the work for the probe.
- **Calibration is a population property.** Confidence is calibrated *across* a group of
  predictions, not guaranteed per answer, so every consumer needs an explicit threshold and an
  explicit low-confidence fallback. Skipping that is how a probabilistic router quietly rots.
- **Text-only input.** zmrng already accepts image/PDF attachments; none of that state can be fed
  to Jev, so any state passed to it has to be flattened to text first.
- **One more vendor.** A second AI dependency alongside `claude`, with its own outage mode, in a
  tool whose whole value is running unattended.

## Sources

- [Introducing System One models and Jev — TypeSafe AI](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [System One concepts — TypeSafe docs](https://docs.typesafe.ai/concepts/system-one)
- [TypeSafe AI releases Jev — MarkTechPost](https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/)
- [A new kind of AI model from a ChatGPT inventor — TechCrunch](https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/)
