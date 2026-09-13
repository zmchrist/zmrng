#!/usr/bin/env python3
"""
PreToolUse hook: Worktree-isolation guard.

Stops two concurrent Claude Code sessions from editing the SAME working-tree
directory — the collision that silently corrupts each session's uncommitted
work (one session switches branch / stashes / rewrites while the other is
mid-edit). Branches do NOT isolate agents; directories (worktrees) do. This
hook makes "each agent works in its own worktree" a checked invariant instead
of pure discipline.

Mechanism — a per-worktree session lock:
  - On the first Edit/Write/MultiEdit, the session CLAIMS the worktree by
    writing a lock file keyed by the worktree root (session_id + timestamp).
  - A DIFFERENT session that tries to edit the same worktree while the lock is
    still fresh is DENIED and told to create its own worktree.
  - First-claim wins. Solo work is unaffected: the owning session just
    refreshes its own lock on every edit.
  - Worktree isolation gives BRANCH isolation for free — git forbids checking
    out one branch in two worktrees.

Design points:
  - Locks live OUTSIDE the repo (temp dir), so they never show as modified
    files and never get committed.
  - Stale locks auto-release: a lock older than the TTL is reclaimable, so a
    crashed / closed session never bricks the worktree forever.
  - Fails OPEN: no git repo, no session_id, git missing, unwritable lock dir,
    malformed input → pass through. A guard must never brick a legit session.
  - Escape hatch: HERMES_ALLOW_SHARED_WORKTREE=1 bypasses entirely (aligns with
    the HERMES_ALLOW_PROTECTED_{EDIT,COMMIT,PUSH} override convention).
  - TTL override: HERMES_WORKTREE_LOCK_TTL (seconds, default 3600). An actively
    editing session refreshes well within this; only a long-idle owner (>TTL
    between edits) can be evicted by a newcomer.

Fires on: Edit, Write, MultiEdit
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DEFAULT_TTL_SECONDS = 3600


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def worktree_root(file_dir: str) -> str | None:
    """Resolve the working-tree root for the repo containing file_dir.

    Uses --show-toplevel so a linked worktree resolves to its OWN root (each
    worktree is a distinct top-level), which is exactly the isolation boundary
    we want to key the lock on. Returns None if not a git repo / git missing.
    """
    try:
        result = subprocess.run(
            ["git", "-C", file_dir, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if result.returncode != 0:
        return None
    root = result.stdout.strip()
    return root or None


def lock_dir() -> str:
    d = os.path.join(tempfile.gettempdir(), "claude-worktree-locks")
    os.makedirs(d, exist_ok=True)
    return d


def lock_path(root: str) -> str:
    key = hashlib.sha256(root.encode("utf-8")).hexdigest()[:16]
    return os.path.join(lock_dir(), f"{key}.lock")


def ttl_seconds() -> int:
    raw = os.environ.get("HERMES_WORKTREE_LOCK_TTL", "")
    try:
        val = int(raw)
        return val if val > 0 else DEFAULT_TTL_SECONDS
    except (ValueError, TypeError):
        return DEFAULT_TTL_SECONDS


def read_lock(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def write_lock(path: str, session_id: str, root: str) -> None:
    try:
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({
                "session_id": session_id,
                "worktree": root,
                "ts": int(time.time()),
                "pid": os.getpid(),
            }, fh)
        os.replace(tmp, path)
    except OSError:
        pass  # Unwritable lock dir → fail open, just don't enforce.


def main() -> None:
    if os.environ.get("HERMES_ALLOW_SHARED_WORKTREE") == "1":
        sys.exit(0)

    try:
        event = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)  # Fail open

    session_id = str(event.get("session_id") or "").strip()
    if not session_id:
        sys.exit(0)  # No session identity → can't arbitrate, pass through.

    tool_input = event.get("tool_input", {})
    file_path = tool_input.get("file_path") or tool_input.get("path") or ""
    if not file_path:
        sys.exit(0)

    file_dir = str(Path(file_path).resolve().parent)
    root = worktree_root(file_dir)
    if root is None:
        sys.exit(0)  # Not a git repo / git unavailable — pass through.

    path = lock_path(root)
    existing = read_lock(path)
    now = int(time.time())

    if existing is not None:
        owner = str(existing.get("session_id") or "")
        ts = existing.get("ts")
        fresh = isinstance(ts, int) and (now - ts) < ttl_seconds()
        if fresh and owner and owner != session_id:
            deny(
                "Blocked: another active Claude session already owns this "
                f"worktree ('{root}').\n"
                "Two agents in one working tree collide — one switches branch / "
                "stashes / rewrites while the other is mid-edit, silently "
                "corrupting each other's uncommitted work. Branches don't "
                "isolate agents; worktrees do.\n"
                "Give this agent its OWN worktree, then relaunch it from there:\n"
                "  git worktree add ../<repo>-<task> -b <type>/zc/<desc> origin/main\n"
                "  cd ../<repo>-<task>   # start the session here\n"
                "(types: feat/ fix/ chore/ wip/). If the other session is "
                "actually dead, its lock self-expires after "
                f"{ttl_seconds()}s of inactivity. Deliberate one-off override: "
                "HERMES_ALLOW_SHARED_WORKTREE=1."
            )

    # Either unclaimed, stale, or already ours → (re)claim and refresh.
    write_lock(path, session_id, root)
    sys.exit(0)


if __name__ == "__main__":
    main()
