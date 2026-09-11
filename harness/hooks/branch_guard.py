#!/usr/bin/env python3
"""
PreToolUse hook: Branch-before-code guard.

Enforces the universal "never edit on a protected branch" invariant. When the
agent tries to Edit/Write/MultiEdit a file whose git repo currently has
main/master checked out, the edit is denied with instructions to branch first.

This replaces the prose rule ("branch before code, branch from origin/main")
that was previously pure agent discipline — the local pre-commit git hook only
caught it *after* work had already landed on main.

Key design points:
  - Protected-branch-only. It checks ONLY that HEAD is not main/master. It does
    NOT enforce any branch-NAME convention, because zmrng workers legitimately
    run on `feat/zmrng/<slug>-<shortId>` branches and would be bricked by a
    name-pattern rule. Name convention stays as prose.
  - Worktree-aware. It runs `git -C <file-dir> rev-parse` so a worktree checked
    out on its own branch resolves correctly (a worktree's .git is a file, not
    a dir).
  - Fails open. No git repo, detached HEAD, git missing, malformed input → pass
    through. Never bricks a session.
  - Escape hatch. Set HERMES_ALLOW_PROTECTED_EDIT=1 to bypass (aligns with the
    existing HERMES_ALLOW_PROTECTED_{COMMIT,PUSH} git-hook overrides).

Fires on: Edit, Write, MultiEdit
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PROTECTED = {"main", "master"}


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def current_branch(file_dir: str) -> str | None:
    """Return the checked-out branch for the repo containing file_dir, or None."""
    try:
        result = subprocess.run(
            ["git", "-C", file_dir, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if result.returncode != 0:
        return None
    branch = result.stdout.strip()
    # Detached HEAD reports "HEAD" — not a protected branch, let it pass.
    return branch or None


def main() -> None:
    if os.environ.get("HERMES_ALLOW_PROTECTED_EDIT") == "1":
        sys.exit(0)

    try:
        event = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)  # Fail open

    tool_input = event.get("tool_input", {})
    file_path = tool_input.get("file_path") or tool_input.get("path") or ""
    if not file_path:
        sys.exit(0)

    file_dir = str(Path(file_path).resolve().parent)
    branch = current_branch(file_dir)
    if branch is None:
        sys.exit(0)  # Not a git repo / detached / git unavailable — pass through

    if branch in PROTECTED:
        deny(
            f"Blocked: '{os.path.basename(file_path)}' is on protected branch "
            f"'{branch}'. Branch before code:\n"
            f"  git fetch origin && git checkout -b <type>/zc/<desc> origin/{branch}\n"
            f"(types: feat/ fix/ chore/ wip/). Override for a one-off with "
            f"HERMES_ALLOW_PROTECTED_EDIT=1."
        )

    sys.exit(0)


if __name__ == "__main__":
    main()
