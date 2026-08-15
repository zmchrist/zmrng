#!/usr/bin/env python3
"""
Stop hook: Validation gate.

Fires when Claude tries to end its turn. Detects the project stack and runs
lint + test commands. If any fail, Claude is told to fix the issues before stopping.

Supports:
  - Python: ruff check + pytest
  - TypeScript/Node: tsc --noEmit + npm test (or vitest/jest)
  - Rust: cargo check + cargo test
  - Go: go vet + go test
  - Custom: .claude/validate.sh script (takes priority over auto-detect)

Uses a flag file to prevent infinite loops — if validation was already
attempted this turn, it passes through.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def get_project_dir() -> Path:
    """Get the project directory from environment."""
    return Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())).resolve()


def get_flag_file(project_dir: Path) -> str:
    """
    Per-worktree stop-flag file, keyed by hashing the resolved project dir.

    zmrng runs concurrent lanes (multiple worktrees hitting this hook at the
    same time). A single global flag file would race: one worktree's Stop
    could consume the flag another worktree just set, letting it skip
    validation. Keying the flag filename by project dir gives each worktree
    its own flag.
    """
    digest = hashlib.sha256(str(project_dir).encode()).hexdigest()[:16]
    return os.path.join(tempfile.gettempdir(), f"claude_stop_hook_active_{digest}")


def run_cmd(cmd: list[str], cwd: str, timeout: int = 120) -> tuple[bool, str]:
    """Run a command and return (success, output)."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd,
        )
        output = (result.stdout + "\n" + result.stderr).strip()
        return result.returncode == 0, output
    except subprocess.TimeoutExpired:
        return False, f"Command timed out after {timeout}s: {' '.join(cmd)}"
    except FileNotFoundError:
        return True, ""  # Tool not installed — skip


def validate_custom(project_dir: Path) -> tuple[bool, str]:
    """Run .claude/validate.sh if it exists."""
    script = project_dir / ".claude" / "validate.sh"
    if script.exists():
        return run_cmd(["bash", str(script)], cwd=str(project_dir), timeout=180)
    return True, ""


def validate_python(project_dir: Path) -> tuple[bool, list[str]]:
    """Run ruff + pytest for Python projects."""
    failures = []

    # Find the right directory (might have a backend/ subdirectory)
    py_dir = project_dir
    if (project_dir / "backend" / "pyproject.toml").exists():
        py_dir = project_dir / "backend"

    # Ruff
    ok, out = run_cmd(["uv", "run", "ruff", "check", "."], cwd=str(py_dir))
    if not ok:
        failures.append(f"ruff check FAILED:\n{out[:800]}")

    # Pytest
    ok, out = run_cmd(["uv", "run", "pytest", "-q", "--tb=short", "-x"], cwd=str(py_dir))
    if not ok:
        failures.append(f"pytest FAILED:\n{out[:800]}")

    return len(failures) == 0, failures


def validate_node(project_dir: Path) -> tuple[bool, list[str]]:
    """Run tsc + test for Node/TypeScript projects."""
    failures = []

    # Find the right directory
    node_dir = project_dir
    if (project_dir / "frontend" / "package.json").exists() and not (project_dir / "package.json").exists():
        node_dir = project_dir / "frontend"

    pkg_json = node_dir / "package.json"
    if not pkg_json.exists():
        return True, []

    # Read package.json to check available scripts
    try:
        with open(pkg_json) as f:
            pkg = json.load(f)
        scripts = pkg.get("scripts", {})
    except (json.JSONDecodeError, OSError):
        return True, []

    # TypeScript check
    if "typecheck" in scripts:
        ok, out = run_cmd(["npm", "run", "typecheck"], cwd=str(node_dir))
        if not ok:
            failures.append(f"typecheck FAILED:\n{out[:800]}")
    elif (node_dir / "tsconfig.json").exists():
        ok, out = run_cmd(["npx", "tsc", "--noEmit"], cwd=str(node_dir))
        if not ok:
            failures.append(f"tsc --noEmit FAILED:\n{out[:800]}")

    # Lint
    if "lint" in scripts:
        ok, out = run_cmd(["npm", "run", "lint"], cwd=str(node_dir))
        if not ok:
            failures.append(f"lint FAILED:\n{out[:800]}")

    # Tests
    if "test" in scripts:
        ok, out = run_cmd(["npm", "test"], cwd=str(node_dir))
        if not ok:
            failures.append(f"test FAILED:\n{out[:800]}")

    return len(failures) == 0, failures


def validate_rust(project_dir: Path) -> tuple[bool, list[str]]:
    """Run cargo check + cargo test for Rust projects."""
    failures = []

    ok, out = run_cmd(["cargo", "check"], cwd=str(project_dir))
    if not ok:
        failures.append(f"cargo check FAILED:\n{out[:800]}")

    ok, out = run_cmd(["cargo", "test", "--", "--quiet"], cwd=str(project_dir))
    if not ok:
        failures.append(f"cargo test FAILED:\n{out[:800]}")

    return len(failures) == 0, failures


def validate_go(project_dir: Path) -> tuple[bool, list[str]]:
    """Run go vet + go test for Go projects."""
    failures = []

    ok, out = run_cmd(["go", "vet", "./..."], cwd=str(project_dir))
    if not ok:
        failures.append(f"go vet FAILED:\n{out[:800]}")

    ok, out = run_cmd(["go", "test", "./..."], cwd=str(project_dir))
    if not ok:
        failures.append(f"go test FAILED:\n{out[:800]}")

    return len(failures) == 0, failures


def main() -> None:
    project_dir = get_project_dir()
    flag_file = get_flag_file(project_dir)

    # Prevent infinite loops
    if os.path.exists(flag_file):
        os.unlink(flag_file)
        sys.exit(0)

    # Set the flag before running validation
    Path(flag_file).touch()

    try:
        # Custom validation takes priority
        custom_ok, custom_out = validate_custom(project_dir)
        if (project_dir / ".claude" / "validate.sh").exists():
            if not custom_ok:
                decision = {
                    "decision": "block",
                    "reason": f"Custom validation failed in {project_dir.name}:\n{custom_out[:1000]}",
                }
                print(json.dumps(decision))
                sys.exit(0)
            else:
                sys.exit(0)  # Custom validation passed

        # Auto-detect stack and validate
        all_failures: list[str] = []

        if (project_dir / "pyproject.toml").exists() or (project_dir / "backend" / "pyproject.toml").exists():
            ok, failures = validate_python(project_dir)
            all_failures.extend(failures)

        if (project_dir / "package.json").exists():
            ok, failures = validate_node(project_dir)
            all_failures.extend(failures)
        elif (project_dir / "frontend" / "package.json").exists():
            ok, failures = validate_node(project_dir)
            all_failures.extend(failures)

        if (project_dir / "Cargo.toml").exists():
            ok, failures = validate_rust(project_dir)
            all_failures.extend(failures)

        if (project_dir / "go.mod").exists():
            ok, failures = validate_go(project_dir)
            all_failures.extend(failures)

        if all_failures:
            summary = "\n\n".join(all_failures)
            decision = {
                "decision": "block",
                "reason": f"Validation failed in {project_dir.name}. Fix these issues before finishing:\n\n{summary[:2000]}",
            }
            print(json.dumps(decision))

    finally:
        # Clean up flag on any exit path
        if os.path.exists(flag_file):
            os.unlink(flag_file)

    sys.exit(0)


if __name__ == "__main__":
    main()
