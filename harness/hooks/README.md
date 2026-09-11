# harness/hooks — vendored, intentionally diverged

These are zmrng's own vendored copies of the operator's parent hooks
(`../.claude/hooks/` one level up in the Projects harness), seeded into every
task worktree by `seedHarness()` (`packages/server/src/worktree.ts`) under
`.claude/zmrng-hooks/`.

## Hook inventory

All five hooks carry `from __future__ import annotations` so they run on stock
`python3` 3.9 (PEP-604 `X | None` annotations otherwise crash the interpreter,
which would fail the hook open and silently disable enforcement).

| Hook | Event | What | Override |
|------|-------|------|----------|
| `security_guard.py` | PreToolUse | Blocks `.env` access, recursive deletes, force-push to protected branches, `git reset --hard` | — |
| `branch_guard.py` | PreToolUse (Edit/Write/MultiEdit) | Blocks edits when the file's repo is on a protected branch (`main`/`master`) — branch first. Worktree-aware (`git -C`). | `HERMES_ALLOW_PROTECTED_EDIT=1` |
| `pr_shape_guard.py` | PreToolUse (Bash) | Rejects `gh pr create` with `--fill` or without `--body-file` | `HERMES_ALLOW_PR_FILL=1` |
| `post_tool_use_lint.py` | PostToolUse (Edit/Write/MultiEdit) | Advisory linter for the detected stack — never blocks, always exits 0 | — |
| `stop_validate.py` | Stop | Runs the project's validation gate; blocks the stop if it fails | — |

`security_guard.py`, `branch_guard.py`, and `pr_shape_guard.py` ship verbatim
from the parent hooks (`../.claude/hooks/`) — correct as-is for workers.

`stop_validate.py` has intentionally diverged from the parent original and
must **not** be re-synced from `../.claude/hooks/stop_validate.py`:

- **Dropped `find_active_project`.** The parent version was built for the
  operator's `~/Projects` *container* layout: it git-diffs the container and
  looks for a first-level subdirectory carrying a stack marker
  (`package.json`, `pyproject.toml`, etc.). In a zmrng-seeded task worktree,
  `CLAUDE_PROJECT_DIR` *is* the project root already — there is no container
  to descend into. For an npm-workspaces repo like zmrng itself, a changed
  file such as `packages/server/src/x.ts` maps to first-level directory
  `packages/`, which has no `package.json` of its own, so the old logic
  returned `None` and validation silently never ran. The fixed version
  resolves `project_dir = get_project_dir()` (the resolved
  `CLAUDE_PROJECT_DIR`) and runs the existing marker-based stack
  auto-detection + `validate_*` functions directly against it.
- **Per-worktree stop-flag file.** The parent version uses one global temp
  path (`claude_stop_hook_active`) to guard against infinite Stop-hook loops.
  zmrng runs concurrent lanes (`ZMRNG_MAX_LANES`, default 2) — two worktrees
  hitting Stop at the same time would race that single file, letting one
  worktree skip validation. The fixed version keys the flag filename by
  hashing the resolved project dir
  (`claude_stop_hook_active_<sha256(project_dir)[:16]>`), so each worktree
  gets its own flag.

If the parent hooks change upstream, port fixes forward by hand — do not
overwrite this directory with a fresh copy of `../.claude/hooks/`.
