#!/bin/bash
# Autonomous Loop Driver (Mode 3)
# Spawns fresh Claude instances per work item from a task file.
#
# Usage: .agents/scripts/loop.sh <task-file> [--max-iterations N]
#
# Examples:
#   .agents/scripts/loop.sh .agents/tasks/my-feature.md
#   .agents/scripts/loop.sh .agents/tasks/my-feature.md --max-iterations 10

set -euo pipefail

TASK_FILE="${1:?Usage: loop.sh <task-file> [--max-iterations N]}"
shift

# Parse optional flags
MAX_ITERATIONS=20
while [[ $# -gt 0 ]]; do
    case "$1" in
        --max-iterations)
            MAX_ITERATIONS="${2:?--max-iterations requires a number}"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ ! -f "$TASK_FILE" ]]; then
    echo "Error: Task file not found: $TASK_FILE" >&2
    exit 1
fi

STATE_DIR=".agents/loop-state"
mkdir -p "$STATE_DIR"

CONSECUTIVE_FAILURES=0
ITERATION=0
COMPLETED=0
BLOCKED=0

echo "=== Loop Starting ==="
echo "Task file: $TASK_FILE"
echo "Max iterations: $MAX_ITERATIONS"
echo ""

while [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; do
    ITERATION=$((ITERATION + 1))

    # Find next unchecked item number (matches "- [ ] N." pattern)
    NEXT=$(grep -E '^\- \[ \] [0-9]+\.' "$TASK_FILE" | head -1 | sed 's/^- \[ \] \([0-9]*\)\..*/\1/')
    if [ -z "$NEXT" ]; then
        echo "=== All items complete or blocked. ==="
        break
    fi

    echo "=== Iteration $ITERATION: Work Item $NEXT ==="
    echo "Started: $(date -Iseconds)"

    # Fresh Claude instance per item (no context pollution)
    claude --print "/work-item $TASK_FILE $NEXT" 2>&1 | tee "$STATE_DIR/iter-$ITERATION.log"

    # Check outcome by examining task file
    if grep -q "^\- \[x\] $NEXT\." "$TASK_FILE"; then
        echo ">>> Item $NEXT: DONE"
        CONSECUTIVE_FAILURES=0
        COMPLETED=$((COMPLETED + 1))
    elif grep -q "^\- \[BLOCKED\] $NEXT\." "$TASK_FILE"; then
        echo ">>> Item $NEXT: BLOCKED"
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
        BLOCKED=$((BLOCKED + 1))
    else
        echo ">>> Item $NEXT: FAILED (no status change)"
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    fi

    # Circuit breaker: 3 consecutive failures
    if [ "$CONSECUTIVE_FAILURES" -ge 3 ]; then
        echo ""
        echo "=== CIRCUIT BREAKER: 3 consecutive failures. Stopping. ==="
        break
    fi

    echo ""
done

echo "=== Loop Complete ==="
echo "Iterations: $ITERATION"
echo "Completed: $COMPLETED"
echo "Blocked: $BLOCKED"
echo "Finished: $(date -Iseconds)"
