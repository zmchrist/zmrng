# harness/hooks — vendored, intentionally diverged

These are zmrng's own vendored copies of the operator's parent hooks
(`../.claude/hooks/` one level up in the Projects harness), seeded into every
task worktree by `seedHarness()` (`packages/server/src/worktree.ts`) under
`.claude/zmrng-hooks/`.

`security_guard.py` is unchanged — ships verbatim.

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
