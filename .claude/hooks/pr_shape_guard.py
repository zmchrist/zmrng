#!/usr/bin/env python3
"""
PreToolUse hook: PR-shape guard.

Enforces the "PRs carry the lifecycle checklist" invariant deterministically.
`gh pr create --fill` silently drops the PR template (and its checklist), and a
bare `gh pr create` with no body is the same failure. Both are rejected here so
the rule stops being prose-only agent discipline.

Rule (from coding-lifecycle.md): PRs are opened with `--body-file`, never
`--fill`. The body follows .github/PULL_REQUEST_TEMPLATE.md.

Fails open on anything that isn't a `gh pr create` command. Escape hatch:
HERMES_ALLOW_PR_FILL=1.

Fires on: Bash
"""

from __future__ import annotations

import json
import os
import re
import sys


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def main() -> None:
    if os.environ.get("HERMES_ALLOW_PR_FILL") == "1":
        sys.exit(0)

    try:
        event = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)  # Fail open

    if event.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = event.get("tool_input", {}).get("command", "")
    if not cmd:
        sys.exit(0)

    # Only care about `gh pr create` (allow gh pr edit/view/list/etc.).
    if not re.search(r"\bgh\s+pr\s+create\b", cmd):
        sys.exit(0)

    if re.search(r"(^|\s)--fill\b", cmd):
        deny(
            "Blocked: `gh pr create --fill` drops the PR template and its "
            "lifecycle checklist. Write the body to a file and use "
            "`--body-file <path>` following .github/PULL_REQUEST_TEMPLATE.md."
        )

    if not re.search(r"(^|\s)--body-file\b", cmd):
        deny(
            "Blocked: `gh pr create` must use `--body-file <path>` (never "
            "`--body`/`--fill`) so the PR carries the lifecycle checklist from "
            ".github/PULL_REQUEST_TEMPLATE.md."
        )

    sys.exit(0)


if __name__ == "__main__":
    main()
