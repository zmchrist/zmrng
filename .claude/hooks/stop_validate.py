#!/usr/bin/env python3
"""
Stop hook: validation gate (zmrng, self-contained).

Fires when the agent tries to end its turn. Runs the single-source validation
gate `.claude/validate.sh` (→ `verify.sh --fast`: typecheck + lint + test). If
it fails, the agent is told to fix the issues before stopping.

Unlike the generic parent-harness stop hook (which auto-detects a project by
walking first-level subdirs — a layout that does NOT match being run from a
single repo root), this hook is anchored to CLAUDE_PROJECT_DIR and simply runs
the repo's own gate. One source of truth: validate.sh → verify.sh.

Uses a tempfile flag to prevent infinite loops — if validation was already
attempted this turn, it passes through.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

FLAG_FILE = os.path.join(tempfile.gettempdir(), "zmrng_stop_hook_active")


def project_dir() -> Path:
    return Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())).resolve()


def main() -> None:
    # Prevent infinite loops
    if os.path.exists(FLAG_FILE):
        os.unlink(FLAG_FILE)
        sys.exit(0)

    root = project_dir()
    script = root / ".claude" / "validate.sh"
    if not script.exists():
        sys.exit(0)  # No gate to run — pass through

    Path(FLAG_FILE).touch()
    try:
        result = subprocess.run(
            ["bash", str(script)],
            capture_output=True, text=True, timeout=170, cwd=str(root),
        )
        if result.returncode != 0:
            out = (result.stdout + "\n" + result.stderr).strip()
            print(json.dumps({
                "decision": "block",
                "reason": f"Validation gate failed. Fix before finishing:\n\n{out[-2000:]}",
            }))
    except subprocess.TimeoutExpired:
        print(json.dumps({
            "decision": "block",
            "reason": "Validation gate timed out (170s). Run ./.claude/verify.sh manually to see where it hangs.",
        }))
    except (FileNotFoundError, OSError):
        pass  # Tooling missing — pass through
    finally:
        if os.path.exists(FLAG_FILE):
            os.unlink(FLAG_FILE)

    sys.exit(0)


if __name__ == "__main__":
    main()
