# CLAUDE.md — Project Harness

This file defines the working lifecycle for any coding session in this
repository. It is stack-agnostic: it does not assume a particular language,
framework, or build tool. Adapt the commands referenced below to whatever
this project actually uses.

## Workflow: PIV Loop (Plan → Implement → Validate → Review)

Every non-trivial change follows this loop. Do not skip steps.

| Step | What happens |
|------|--------------|
| 1. Plan | Write a short plan before touching any files. State the approach, the files you expect to change, and how you will test the change. |
| 2. Implement | Make the change, writing or updating tests alongside the code they cover. |
| 3. Validate | Run this project's build, lint, and test commands. All must pass before the work is considered done. |
| 4. Review | Re-read the diff against the plan. Check for correctness, leftover debug code, and missing tests. |

## Plan before code

Do not start editing files until you have a plan. A plan does not need to be
long — for a small change, a few sentences naming the approach and the files
involved is enough. For larger changes, write the plan down (e.g. in a
`plans/` directory or similar) so it survives the session and can be handed
off or reviewed later.

When planning, name at least one alternative approach you considered and why
you rejected it. Read the relevant files before planning against them — do
not plan from assumptions about code you have not looked at.

## Branch before code

Never commit directly to the repository's main/default branch. Before making
any file changes, create a feature branch from the up-to-date default branch.
Use a short, descriptive branch name that reflects the type of change (e.g. a
`feat/`, `fix/`, or `chore/` prefix).

Work is delivered as a pull request for human review — do not merge your own
work into the default branch.

## Implementation discipline

- Tests land in the same change as the code they cover, not as a follow-up.
- Prefer the smallest change that correctly solves the problem. Do not add
  speculative abstractions, unrequested features, or unrelated cleanup.
- If a change is genuinely untestable (e.g. pure documentation), say so
  explicitly rather than silently skipping tests.
- Before finishing, run this project's validation commands (typecheck/build,
  lint, tests — whichever apply) and confirm they pass.

## Roles

Beyond the main working session, this harness defines a small set of
generic subagent roles for larger tasks:

- **qa** — runs the test suite and validation checks, reports PASS/FAIL. Does
  not modify code.
- **code-reviewer** — reviews completed work against the plan and coding
  standards. Does not modify code.
- **doc-updater** — brings documentation back in sync with the code after a
  change lands.

Use these roles to separate "doing the work" from "checking the work."

## Communication style

Default narration register for this harness is **caveman** — short,
compressed, technically precise, no filler or pleasantries. See the
`caveman` skill for the exact rules and intensity levels. This register
applies to narration, status updates, and logs only. It never applies to
code, commit messages, pull request titles/bodies, or planning documents —
those are always written in normal, professional English.

## Documentation sync

Before a non-trivial commit, bring project documentation back in line with
the code (see the `sync-docs` skill). Do this before committing, not after.

## Safety

A small set of enforcement hooks guard this session (see `hooks/README.md`):

- a **security** guard blocks destructive or unsafe actions (reading `.env`
  files, force-pushing to protected branches, recursive deletes,
  `git reset --hard`);
- a **branch** guard blocks file edits while the repo is on a protected branch
  (`main`/`master`) — branch first (override `HERMES_ALLOW_PROTECTED_EDIT=1`);
- a **pull-request shape** guard rejects opening a PR with `--fill` or without
  `--body-file`, so PRs carry the template checklist (override
  `HERMES_ALLOW_PR_FILL=1`);
- an advisory **lint** hook runs after edits (never blocks);
- a **validation** hook runs the project's own gate when the turn tries to end
  and blocks the stop if it fails.

Do not attempt to bypass or disable them. If a hook blocks a legitimate action,
find another approach rather than working around the check.
