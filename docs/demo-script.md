# zmrng — 2-minute demo script

A shot-by-shot script for the README's "▶️ 2-minute demo" Loom. Goal: a hiring
manager watches a real task go **prompt → autonomous plan/implement/validate →
opened PR** with no human touching the code, and comes away believing you built
production-grade agent orchestration.

## Before you hit record (setup, off-camera)

- [ ] A **real target repo** configured in `config/repos.json` that you can push
      to — not zmrng itself. Something small and legible on screen (a demo repo
      with a couple of files reads better than a giant monorepo).
- [ ] `claude` logged in (Max/Pro), `gh auth login` done, `git` push rights on
      the target. Run `GET /api/preflight` once and confirm all three are green.
- [ ] Pick a task whose diff is **small, obviously-correct, and visual** so the
      PR is skimmable in the final shot. Good: "add a `--version` flag", "add a
      health-check endpoint", "fix this failing edge case." Avoid anything that
      needs a long clarify back-and-forth.
- [ ] Pre-write the one clarifying answer you'll type, so the clarify beat is
      crisp and not you thinking on camera.
- [ ] App running full-screen, clean theme, no unrelated tasks cluttering the
      list. Close notifications.
- [ ] Because a full autonomous run takes minutes, plan to **record the phases
      live but cut/speed-ramp the waiting** in edit (call it out below). Keep the
      final cut to ~2:00.

## Shot list (target ~2:00)

**0:00–0:12 — The hook (talk over the task list).**
> "This is zmrng. I drop in a coding task and one agent takes it all the way to
> an opened pull request — plan, implement, validate, PR — in an isolated git
> worktree, no babysitting. Watch."

Show the frosted-glass task list. Don't linger.

**0:12–0:30 — Drop the task.**
Click New Task. Type the title + body. Point out the per-task controls as you
set them: **model** (opus/sonnet), **effort**, **target repo** from the registry.
Click Start.
> "I pick the model, the effort, and which repo it drives. Start."

**0:30–0:45 — Clarify.**
The agent asks a scoping question. Type your pre-written answer.
> "First it clarifies scope — this is one long-lived session. I answer, and from
> here it's fully autonomous."

**0:45–1:10 — Autonomous phases (speed-ramp the waits in edit).**
Narrate over the phase pills advancing: **planning → executing → validating.**
> "A fresh session plans the change and QA's its own plan. Another session
> implements it test-first in the worktree — it can never touch main. Then it
> self-validates: typecheck, lint, tests, build, plus a code-review pass."

Let the worker log stream visibly for a beat — the tool/subagent rows are proof
it's really working, not a mock.

**1:10–1:25 — The security gate (differentiator — call it out).**
> "Before any PR there's a deterministic security scan — semgrep and
> osv-scanner — asserted by the orchestrator, fail-closed. Only a green verdict
> is allowed to open the PR."

**1:25–1:45 — The PR.**
The status hits **review** and the PR URL appears. Click it → GitHub. Scroll the
PR body: the lifecycle checklist, Testing and Validation sections, the diff.
> "And there's the pull request it opened — structured body, testing and
> validation sections, a clean diff. I review and merge on GitHub; zmrng never
> merges to main itself."

**1:45–2:00 — Close (why it matters).**
Back to the app.
> "So: a real development lifecycle enforced from the orchestrator — branch-only,
> test-first, self-validating, security-gated — not an agent in a loop hoping to
> behave. Built solo, TypeScript end to end, ships as a native app. Links in the
> README."

## Delivery notes

- Talk like an engineer to an engineer — concrete nouns (worktree, sentinel,
  fail-closed), no hype adjectives.
- The three beats that separate this from a toy: **isolated worktree /
  branch-only**, **self-validation gate**, **deterministic security scan**. Make
  sure all three land verbally.
- Keep your cursor deliberate; no hunting around the UI on camera.
- After recording: upload to Loom, drop the URL into the README (`[Loom link —
  TODO]` on line ~9) and optionally export a short GIF to `docs/demo.gif` and
  uncomment the image line just below it.
