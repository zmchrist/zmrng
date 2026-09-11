#!/usr/bin/env python3
"""
PostToolUse hook: Auto-lint after edits.

Fires on: Edit, Write, MultiEdit
Detects the file type and project stack, then runs the appropriate linter.
Advisory only — always exits 0. Surfaces issues without blocking.

Supported stacks:
  - Python (ruff) — looks for pyproject.toml or requirements.txt
  - TypeScript/JavaScript (tsc) — looks for tsconfig.json
  - Rust (cargo check) — looks for Cargo.toml
  - Go (go vet) — looks for go.mod
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_project_root(file_path: str) -> Path | None:
    """Walk up from the file to find the nearest project root."""
    current = Path(file_path).resolve().parent
    projects_dir = Path(os.environ.get("CLAUDE_PROJECT_DIR", "")).resolve()

    while current != current.parent and current >= projects_dir:
        markers = ["pyproject.toml", "package.json", "Cargo.toml", "go.mod"]
        if any((current / m).exists() for m in markers):
            return current
        current = current.parent
    return None


def lint_python(file_path: str, project_root: Path) -> None:
    """Run ruff on a Python file."""
    if not file_path.endswith(".py"):
        return

    # Check for ruff via uv or direct
    if (project_root / "pyproject.toml").exists() and shutil.which("uv"):
        result = subprocess.run(
            ["uv", "run", "--directory", str(project_root), "ruff", "check", file_path],
            capture_output=True, text=True, timeout=15,
        )
    elif shutil.which("ruff"):
        result = subprocess.run(
            ["ruff", "check", file_path],
            capture_output=True, text=True, timeout=15,
        )
    else:
        return

    if result.returncode != 0:
        print(f"[lint] ruff issues in {os.path.basename(file_path)}:", file=sys.stderr)
        print(result.stdout[:500], file=sys.stderr)


def lint_typescript(file_path: str, project_root: Path) -> None:
    """Run tsc --noEmit for TypeScript files."""
    if not file_path.endswith((".ts", ".tsx")):
        return

    # Find the nearest tsconfig.json
    ts_dir = Path(file_path).parent
    while ts_dir >= project_root:
        if (ts_dir / "tsconfig.json").exists():
            break
        ts_dir = ts_dir.parent
    else:
        return

    if shutil.which("npx"):
        result = subprocess.run(
            ["npx", "tsc", "--noEmit"],
            capture_output=True, text=True, timeout=30,
            cwd=str(ts_dir),
        )
        if result.returncode != 0:
            # Show only errors related to the edited file
            basename = os.path.basename(file_path)
            relevant = [l for l in result.stdout.splitlines() if basename in l]
            if relevant:
                print(f"[lint] tsc issues in {basename}:", file=sys.stderr)
                print("\n".join(relevant[:10]), file=sys.stderr)


def lint_rust(file_path: str, project_root: Path) -> None:
    """Run cargo check for Rust files."""
    if not file_path.endswith(".rs"):
        return
    if shutil.which("cargo"):
        result = subprocess.run(
            ["cargo", "check", "--quiet"],
            capture_output=True, text=True, timeout=30,
            cwd=str(project_root),
        )
        if result.returncode != 0:
            print(f"[lint] cargo check issues:", file=sys.stderr)
            print(result.stderr[:500], file=sys.stderr)


def lint_go(file_path: str, project_root: Path) -> None:
    """Run go vet for Go files."""
    if not file_path.endswith(".go"):
        return
    if shutil.which("go"):
        result = subprocess.run(
            ["go", "vet", "./..."],
            capture_output=True, text=True, timeout=30,
            cwd=str(project_root),
        )
        if result.returncode != 0:
            print(f"[lint] go vet issues:", file=sys.stderr)
            print(result.stderr[:500], file=sys.stderr)


def main() -> None:
    try:
        event = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    tool_input = event.get("tool_input", {})
    file_path = tool_input.get("file_path", "")

    if not file_path:
        sys.exit(0)

    project_root = find_project_root(file_path)
    if not project_root:
        sys.exit(0)

    try:
        if file_path.endswith(".py"):
            lint_python(file_path, project_root)
        elif file_path.endswith((".ts", ".tsx", ".js", ".jsx")):
            lint_typescript(file_path, project_root)
        elif file_path.endswith(".rs"):
            lint_rust(file_path, project_root)
        elif file_path.endswith(".go"):
            lint_go(file_path, project_root)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass  # Advisory — never block

    sys.exit(0)  # Always exit 0 — advisory only


if __name__ == "__main__":
    main()
