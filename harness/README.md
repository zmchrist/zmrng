# harness/

This is the shippable, stack-agnostic harness payload — the subset of this
repo's own `.claude/` dev harness that a seeder can drop into a fresh target
repo. It is separate from `.claude/` (this repo's own dev configuration) and
is never modified by working inside `.claude/`.

Contents:

- `agents/` — 3 generic subagent roles (`qa`, `code-reviewer`, `doc-updater`).
- `skills/` — 2 generic skills (`caveman`, `sync-docs`), copied whole.
- `rules/` — 4 stack-agnostic rules (coding lifecycle, planning workflow,
  error handling, testing).
- `hooks/` — 5 hook scripts copied down from `../.claude/hooks/` (one level
  up in this repo layout) so the payload is self-contained. All five carry
  `from __future__ import annotations` so they run on stock macOS `python3`
  3.9:
  - `security_guard.py` — blocks `.env` access, recursive deletes,
    force-push to main, `git reset --hard`.
  - `branch_guard.py` — blocks Edit/Write while the repo is on
    `main`/`master`. Override: `HERMES_ALLOW_PROTECTED_EDIT=1`.
  - `pr_shape_guard.py` — rejects `gh pr create --fill` / missing
    `--body-file`. Override: `HERMES_ALLOW_PR_FILL=1`.
  - `post_tool_use_lint.py` — advisory linter (never blocks).
  - `stop_validate.py` — runs the target's validation gate on turn-end.
  Hook *registration* is not read from any settings file — it is hardcoded
  in `zmrngHooksConfig()` (`packages/server/src/worktree.ts`), which
  `seedHarness()` merges into each worker worktree's
  `.claude/settings.local.json`. That function is the single source of truth
  for which hooks are wired.
- `CLAUDE.md` — generic PIV-lifecycle instructions for a seeded worker.
