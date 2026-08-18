# Plan — PR UI Screenshots

## Goal
When a zmrng worker's implementation touches the target repo's **frontend/UI**, the
worker should capture a final-state screenshot of the changed view(s) with the Playwright
MCP browser tools, commit the PNG(s) onto the PR branch, and post a **separate PR comment**
that embeds the image(s) — so the operator can *see* the UI work before merging.

Backend-only changes (no UI files in the diff) skip this step entirely. The whole feature
is delivered as **prompt text** in `packages/server/src/phases.ts` (the worker kickoff that
already owns the implement → validate → PR flow), pinned by the prompt-contract test, plus
doc updates. No new runtime code path, no new REST route, no schema change.

## Why this is a prompt change, not new code
The worker is a headless `claude` child that already runs the full implement/validate/PR
sequence autonomously, driven entirely by the kickoff strings in `phases.ts`
(`executeKickoff`). It already has the tools it needs at runtime: Bash (`gh`, `git`, `npm
run dev`), and — when the target repo/host provides it — the Playwright MCP browser tools.
Teaching the worker to screenshot is therefore adding an instruction to `executeKickoff`,
not building a capture pipeline in the server. The server never sees or stores the image;
it lives in the PR branch and the PR comment, exactly like the rest of the worker's output.

## Grilling the approach

### Simplest thing that works
Add one conditional block to `executeKickoff` (the heavy/plan-flow execute prompt): *after*
validation is green and *before* committing, if the diff includes UI/frontend files, start
the dev server, drive Playwright MCP to the changed view, screenshot it to
`.github/pr-screenshots/<branch-slug>/`, and stage it so it rides the branch push. Then,
*after* `gh pr create` returns the PR URL but *before* the worker prints that URL as its
final line, post a `gh pr comment <pr-url>` embedding the image via its
`raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>` URL. Pin the new rules in
`prompts.test.ts`; sync the docs.

### What this breaks / the sharp edges (each must be handled in the prompt)
1. **PR-URL detection kills the runner.** `TaskManager.detect()` (`phases.ts:509`) matches a
   PR URL in the worker's **assistant/result text** and immediately calls `onPr()`, which
   `kill()`s the child. `gh pr create`'s URL surfaces in a Bash *tool_result*, which
   detection does **not** scan — the task only advances when the worker *writes* the URL in
   prose ("output the PR URL on its own line"). Therefore the comment step must run **before**
   that final PR-URL line. The prompt must state this ordering explicitly, or the runner dies
   between opening the PR and posting the comment.
2. **Playwright MCP is not guaranteed in the worker.** The child is spawned (`runner.ts:223`)
   with **no `--mcp-config`**; it only gets Playwright if the target repo's `.mcp.json` or the
   host's user config provides it. So the step must be **best-effort**: if the browser tools
   are unavailable, skip the screenshot, note it in the PR body's Testing section, and carry
   on — **never** emit `ZMRNG_BLOCKED` (a missing MCP browser tool is not one of the three
   sanctioned block reasons, and blocking a whole task over a screenshot is wrong).
3. **The prompt is repo-agnostic.** `executeKickoff` runs against *any* target repo, so it
   must **not** hardcode `packages/web`. "Frontend/UI change" is defined from the worker's own
   `git diff` (React/Vue/Svelte components, `.css`/`.scss`, `.html`, template/page files) —
   the worker judges it, the prompt gives examples.
4. **Branch-scoped raw URL lifetime.** `raw.githubusercontent.com/.../<branch>/...` resolves
   only while the branch exists. That is exactly the review window (operator reviews *before*
   merge, and `done()` only deletes the branch *after* merge), so it is correct for the stated
   goal ("see the work before I merge"). Acceptable and documented as a known limitation.
5. **Dev-server lifecycle.** The worker must start the dev server in the background, wait for
   it to be reachable, screenshot, then stop it — and it must not leave the process or any
   scratch files behind (worktree-hygiene rule). The prompt says "background + tear down".

### Assumptions to make explicit
- Playwright MCP browser tools (`browser_navigate`, `browser_take_screenshot`, …) are the
  capture mechanism when present — matches the operator's answer (Q3: "go with Playwright MCP").
- Committing the PNG into the branch under `.github/pr-screenshots/<slug>/` is the host
  mechanism (worker's own recommendation in clarify; the operator deferred to it on Q4).
- A single final-state screenshot per changed view (Q5: "just final state", no before/after).

### Alternatives considered and rejected
- **`gh` direct image upload to a comment.** GitHub exposes no public API for attaching an
  arbitrary image to a comment body (the web UI's `user-attachments` upload is browser-only);
  `gh` cannot do it. Rejected — this is exactly why the commit-to-branch + raw-URL path exists.
- **External image host (imgur/S3).** Needs credentials the worker must never hold, adds an
  outbound dependency, and leaves the image outside the PR's own history. Rejected.
- **base64 data-URI in the markdown.** GitHub markdown does not render `data:` image URIs.
  Rejected.
- **A server-side capture pipeline** (server spawns Playwright, stores PNGs, injects into the
  PR). Massive scope creep — new dependency, storage, and a capture path duplicating what the
  worker already can do with the browser tools it has. Contradicts "attachments/artifacts are
  never persisted server-side." Rejected.
- **Adding the step to `directKickoff` too.** The direct flow deliberately strips ceremony for
  menial/self-contained work ("move fast"). Bolting a dev-server + browser-capture ritual onto
  it fights that intent, and the agreed scope centered on the standard worker flow. **Out of
  scope for v1** — `executeKickoff` only. Documented as a deliberate exclusion so it can be
  revisited if UI-touching direct-flow tasks turn out to matter.

## Files to change
- `packages/server/src/phases.ts` — add the conditional screenshot-and-comment instruction to
  `executeKickoff` (in the "Finally:" sequence, ordered as grilled above: capture+stage before
  commit/push; `gh pr comment` after `gh pr create` and before the final PR-URL line). No
  change to `directKickoff`, `planKickoff`, `systemPrompt`, or the state machine.
- `packages/server/test/prompts.test.ts` — add assertions in the `executeKickoff` describe block
  pinning the new rules (see Test strategy).
- `CLAUDE.md` — one line in the `phases.ts` service description noting the conditional
  UI-screenshot step in the execute kickoff.
- `.claude/rules/coding-lifecycle.md` — a short note under step 5 (Validate) that UI-touching
  changes attach a final-state screenshot to the PR (this file and the prompts are a declared
  contract — "if you change one, change the other").
- `.claude/docs/services-reference.md` — if it documents `executeKickoff`, add the step there
  (verify during implementation; skip if not present). Handled by the `sync-docs`/doc-updater
  pass regardless.

## Step-by-step implementation
1. **RED** — add the new `executeKickoff` assertions to `prompts.test.ts` (below); run
   `npm test -w @zmrng/server`; confirm they fail because the strings are absent.
2. **GREEN** — insert the conditional block into `executeKickoff` in `phases.ts`. Draft wording
   (normal professional English, generic across target repos):
   - Under "Finally:", *before* the commit step: "If your changes include user-facing UI (from
     your own `git diff`: React/Vue/Svelte components, CSS/SCSS, HTML, page/template files),
     capture a final-state screenshot of the changed view(s): start the dev server in the
     background, wait until it is reachable, and — **if the Playwright MCP browser tools are
     available** — navigate to the changed view and save a PNG under
     `.github/pr-screenshots/<branch-slug>/`, then stop the dev server. Stage the PNG(s) so they
     are committed and pushed with the branch. If the browser tools are not available, skip the
     capture and say so under Testing in the PR body — do NOT emit ZMRNG_BLOCKED for a missing
     screenshot tool. Backend-only changes skip this step entirely."
   - *After* the `gh pr create` line and *before* "Then output the PR URL on its own line":
     "If you captured screenshot(s) above, post them as a separate PR comment now (before you
     print the PR URL below, so the session stays live): `gh pr comment <pr-url> --body` with
     markdown image tags referencing each file's
     `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/.github/pr-screenshots/<slug>/<file>.png`
     URL."
   Re-run the server suite → green.
   - **Wording specifics to nail down in GREEN** (flagged by plan QA): (a) tell the worker to
     derive `<owner>/<repo>` from `git remote get-url origin` (or `gh repo view`), not guesswork;
     (b) make "wait until reachable" concrete — poll the dev-server port (e.g. curl the local URL
     until it answers) before navigating; (c) make "stop the dev server" concrete — `kill` the
     backgrounded dev-server PID so no process or scratch file is left behind (worktree-hygiene).
3. **REFACTOR** — tidy the wording, keep the "Then output the PR URL on its own line" as the
   final instruction; confirm the ordering reads unambiguously. Suite stays green.
4. Update `CLAUDE.md`, `.claude/rules/coding-lifecycle.md`, and (if applicable)
   `.claude/docs/services-reference.md`.
5. Full validation: `npm run typecheck && npm run lint && npm test && npm run build`.

## Test strategy
- **Runner / command:** Vitest, `npm test` (both workspaces) or `npm test -w @zmrng/server`.
  The prompt lives server-side, so the relevant target is `packages/server/test/prompts.test.ts`.
- **File updated:** `packages/server/test/prompts.test.ts`, `describe('executeKickoff', …)`.
- **New assertions (what each proves):**
  1. *Mentions capturing a UI screenshot for frontend changes* — `expect(prompt).toMatch(/screenshot/i)`
     and a reference to the changed UI/view. Proves the capture instruction was not silently dropped.
  2. *Uses Playwright and is conditional on UI changes* — matches `/Playwright/` and asserts the
     backend-only-skips wording (`/[Bb]ackend-only/` or `/skip/i` near the UI condition). Proves the
     step is gated, not unconditional.
  3. *Commits under the screenshots folder* — `expect(prompt).toContain('.github/pr-screenshots/')`.
     Proves the host mechanism (commit-to-branch) is specified.
  4. *Posts a separate PR comment* — `expect(prompt).toMatch(/gh pr comment/)`. Proves the delivery
     channel is the agreed separate comment, not the PR body.
  5. *Degrades gracefully, never blocks on a missing browser tool* — assert the prompt tells the
     worker to skip when Playwright MCP is unavailable and does **not** turn that into a
     `ZMRNG_BLOCKED` (e.g. `expect(prompt).toMatch(/not.*available/i)` near the screenshot step and
     no new `ZMRNG_BLOCKED` for it). Proves sharp-edge #2 is encoded.
  6. *Comment is posted before the final PR-URL line* — assert the `gh pr comment` substring index
     is **less than** the index of the "output the PR URL" instruction:
     `expect(prompt.indexOf('gh pr comment')).toBeLessThan(prompt.indexOf('output the PR URL'))`.
     Proves sharp-edge #1 (runner-kill ordering) is encoded.
- The existing `executeKickoff` / `PR_BODY_TEMPLATE` / `directKickoff` assertions must all still
  pass — in particular `directKickoff` "does not reference a plan file" and its no-`RED —` checks,
  confirming the new wording did not leak into the direct flow.

## Out of scope
- `directKickoff` (direct flow) screenshotting — deliberate, documented.
- Any server-side capture/storage of images, new REST route, schema, or type change.
- Before/after or multi-shot capture (final state only, per Q5).
- Guaranteeing Playwright MCP is present in the worker (host/target-repo config concern).

## Execute-phase sizing
Multi-file (prompt + contract test + three docs) and the wording must satisfy several sharp
edges precisely (runner-kill ordering, graceful MCP degradation, repo-agnostic phrasing). Prose
that is easy to get subtly wrong → **opus / high**.
