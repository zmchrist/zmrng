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
- `hooks/` — 3 hook scripts copied down from `../.claude/hooks/` (one level
  up in this repo layout) so the payload is self-contained:
  - `security_guard.py` — universal safety hook, registered live in
    `settings.json`.
  - `post_tool_use_lint.py`, `stop_validate.py` — copied in as-is; not yet
    wired into `settings.json` (capability-gated wiring lands separately).
- `settings.json` — registers only `security_guard.py` as a `PreToolUse`
  hook, plus a baseline permissions allow/deny list. No MCP servers.
- `CLAUDE.md` — generic PIV-lifecycle instructions for a seeded worker.
