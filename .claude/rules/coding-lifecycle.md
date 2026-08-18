# Coding Lifecycle

Every change to this repo — by the operator, by a Claude Code session, or by a
zmrng worker driving zmrng itself — moves through the same five steps. zmrng's
worker prompts (`systemPrompt()`, `planKickoff()`, `executeKickoff()` in
`packages/server/src/phases.ts`) encode exactly these steps, so this file and
those prompts must say the same thing. **If you change one, change the other**
— `packages/server/test/prompts.test.ts` pins the prompt half of that contract.

## The five steps

1. **Plan** — grill the approach before writing anything. Read the files you
   intend to change; do not plan against assumptions. Name at least one
   alternative you rejected and why. Write the plan to `.agents/plans/<slug>.md`.
   The plan MUST contain a **Test strategy** section: the test command, the
   exact test files you will add or update, and what each proves. A repo with no
   test runner says so explicitly — the section is never omitted.
2. **Spec / Tickets** — carry the plan into a spec (small, single-agent) or
   tickets (larger, parallelized). Skip only for genuinely single-file changes.
3. **Implement with TDD** — **RED** (write the failing test, run it, confirm it
   fails for the right reason) → **GREEN** (smallest change that passes) →
   **REFACTOR** (clean up, suite stays green). Tests land in the **same commit**
   as the source they cover, never a follow-up commit.
   *Tolerance:* if a change is genuinely untestable (pure docs/config), say so
   explicitly in the PR body under **Testing**. An unexplained absence of tests
   is a failed implementation.
4. **Review** — a `code-reviewer` pass (self or subagent) against the plan;
   address the findings before opening the PR.
5. **Validate + Sync Docs** — `npm run typecheck && npm run lint && npm test &&
   npm run build`, all green, then run the `sync-docs` skill and stage whatever
   docs it updates. **Stage the plan file too** — the PR checklist links it, so
   an uncommitted plan is a dead link. **UI-touching changes attach a
   final-state screenshot to the PR** — capture the changed view(s) with the
   Playwright MCP browser tools (best-effort; skip and note it under Testing if
   they are unavailable — never `ZMRNG_BLOCKED`), commit the PNG(s) under
   `.github/pr-screenshots/<branch-slug>/`, and post them as a separate PR
   comment. Backend-only changes skip this. (This is a declared contract with
   `executeKickoff` in `packages/server/src/phases.ts`, pinned by
   `prompts.test.ts` — change one, change the other.)

## Branch-only (hard rule)

- Never commit on, merge into, or push to `main`/`master`. Branch from
  `origin/main`: `git fetch origin && git checkout -b <type>/zc/<desc> origin/main`.
- Never force-push, rebase onto, or rewrite published history.
- Work is delivered as a **pull request**. The operator merges on GitHub.

## Worktree hygiene (hard rule, for workers)

- The worktree is owned by the orchestrator. Never run `git worktree
  remove|prune`, never delete the worktree dir, never delete your own branch —
  `done()` (`worktree.ts`) cleans both up after the operator merges the PR.
- Leave the tree clean: everything is committed on the branch or deleted. No
  stray scratch files, no `git stash`.

## PR body

PRs are opened with `gh pr create --body-file`, **never `--fill`** — `--fill`
silently drops the checklist. The body follows
`.github/PULL_REQUEST_TEMPLATE.md`: What & why, the five-item lifecycle
checklist (inside the `coding-gate:checklist` markers), **Testing**, and
**Validation** (the exact commands run and their result). Workers write the body
to `$(git rev-parse --git-dir)/zmrng-pr-body.md` so it is never tracked.

PR titles/bodies, commit messages, code, and plan files are always normal,
professional English — even when a task's narration `style` is caveman.
