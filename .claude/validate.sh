#!/usr/bin/env bash
# validate.sh — thin wrapper so the Stop hook (stop_validate.py, which looks for
# .claude/validate.sh) runs the exact same gate as the agent and loop.sh.
# One source of truth: verify.sh. Uses --fast (typecheck+lint+test, skip build) so
# the turn-stop gate stays inside the hook timeout; the full build runs in the
# explicit pre-PR `verify.sh` (no flag).
exec "$(dirname "$0")/verify.sh" --fast
