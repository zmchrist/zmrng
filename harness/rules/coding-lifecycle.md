# Coding Lifecycle

Every change to this repo — whether made by the operator, a Claude Code
session, or an autonomous worker driving this same harness — moves through
the same five steps. If this project has its own kickoff/system prompts for
an autonomous worker, keep them saying the same thing as this file. **If you
change one, change the other** — and pin the contract with a test if the
project has a test suite.

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
5. **Validate + Sync Docs** — run the project's typecheck/build, lint, and
   test commands, all green, then run the `sync-docs` skill and stage whatever
   docs it updates. **Stage the plan file too** — the PR checklist links it, so
   an uncommitted plan is a dead link.

## Branch-only (hard rule)

- Never commit on, merge into, or push to `main`/`master`. Branch from
  `origin/main`: `git fetch origin && git checkout -b <type>/<desc> origin/main`.
- Never force-push, rebase onto, or rewrite published history.
- Work is delivered as a **pull request**. The operator merges on GitHub.

## Worktree hygiene (hard rule, for workers)

- If work runs inside an orchestrator-managed git worktree, treat it as
  owned by the orchestrator: never run `git worktree remove|prune`, never
  delete the worktree dir, never delete your own branch — the orchestrator
  cleans both up after the operator merges the PR.
- Leave the tree clean: everything is committed on the branch or deleted. No
  stray scratch files, no `git stash`.

## PR body

PRs are opened with `gh pr create --body-file`, **never `--fill`** — `--fill`
silently drops the checklist. The body follows
`.github/PULL_REQUEST_TEMPLATE.md`: What & why, the five-item lifecycle
checklist (inside the `coding-gate:checklist` markers), **Testing**, and
**Validation** (the exact commands run and their result). Write the body to
an untracked scratch file (e.g. under `$(git rev-parse --git-dir)/`) so it is
never committed.

PR titles/bodies, commit messages, code, and plan files are always normal,
professional English — even when a session's narration register is caveman.
