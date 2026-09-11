#!/usr/bin/env python3
"""
PreToolUse hook: Security guard.

Blocks:
  - Reading or editing .env files (allows .env.example, .env.template, etc.)
  - Recursive deletion (rm -rf, find -delete, git clean -d)
  - Force-push to main/master
  - Obfuscated patterns targeting .env files
  - git reset --hard (discards uncommitted work)

Fires on: Bash, Read, Edit, Write, MultiEdit, NotebookEdit, Glob, Grep
Fails open on malformed input — never bricks a session.
Active even under --dangerously-skip-permissions.
"""

from __future__ import annotations

import json
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
    try:
        event = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)  # Fail open

    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input", {})

    # --- File-path checks (Read, Edit, Write, Glob, Grep) ---
    file_path = (
        tool_input.get("file_path")
        or tool_input.get("path")
        or tool_input.get("pattern")
        or ""
    )

    if file_path:
        basename = file_path.rsplit("/", 1)[-1] if "/" in file_path else file_path
        # Block .env but allow .env.example, .env.template, .env.local.example, etc.
        if re.match(r"^\.env(\.[a-zA-Z0-9_-]+)?$", basename):
            # Allow safe variants
            safe_suffixes = (".example", ".template", ".sample", ".defaults", ".schema")
            if not any(basename.endswith(s) for s in safe_suffixes):
                deny(f"Blocked: cannot access '{basename}'. Secrets must stay out of context. Use .env.example for templates.")

    # --- Bash command checks ---
    if tool_name == "Bash":
        cmd = tool_input.get("command", "")
        if not cmd:
            sys.exit(0)

        # Block recursive deletes
        if re.search(r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive|-rf|-fr)\s", cmd):
            deny("Blocked: recursive file deletion (rm -rf). Remove files individually.")
        if re.search(r"find\s.*-delete", cmd):
            deny("Blocked: find -delete is a recursive deletion command.")
        if re.search(r"git\s+clean\s+.*-[a-zA-Z]*d", cmd):
            deny("Blocked: git clean -d removes untracked directories recursively.")

        # Block force-push to main/master
        if re.search(r"git\s+push\s+(-f|--force)(\s+\S+\s+)?(main|master)", cmd):
            deny("Blocked: force-push to main/master is not allowed.")
        if re.search(r"git\s+push\s+\S+\s+(main|master)\s+(-f|--force)", cmd):
            deny("Blocked: force-push to main/master is not allowed.")

        # Block .env access via cat, less, more, head, tail, etc.
        if re.search(r"(cat|less|more|head|tail|nano|vim?|code)\s+[^\|;]*\.env\b", cmd):
            if not re.search(r"\.env\.(example|template|sample|defaults|schema)", cmd):
                deny("Blocked: cannot read .env file via shell command. Use .env.example for templates.")

        # Block obfuscated .env access patterns
        if re.search(r"\.\s*e\s*n\s*v\b", cmd) or re.search(r"\.e\*", cmd) or re.search(r"\.\?\?v", cmd):
            if not re.search(r"\.env\.(example|template|sample)", cmd):
                deny("Blocked: suspected obfuscated .env access attempt.")

        # Block git reset --hard
        if re.search(r"git\s+reset\s+--hard", cmd):
            deny("Blocked: git reset --hard discards uncommitted work. Use git stash or targeted reset instead.")


if __name__ == "__main__":
    main()
