#!/usr/bin/env bash
# verify.sh — single source of truth for the zmrng validation gate.
#
# Runs the four checks in order and prints a compact PASS/FAIL summary instead
# of flooding context with full tool output. On failure it shows only the first
# lines of the failing step's output — enough to act on, not enough to rot
# context.
#
# Called by:
#   - the agent (instead of memorising the 4-command incantation)
#   - .agents/scripts/loop.sh (per-item validation)
#   - .claude/validate.sh  → the Stop hook's custom-validation path
#
# Exit code: 0 iff every step passed. Non-zero on first-or-any failure.
#
# Flags:
#   --fast   skip `npm run build` (typecheck+lint+test only) for a quick loop.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

STEPS=("typecheck" "lint" "test")
[[ $FAST -eq 0 ]] && STEPS+=("build")

HEAD_LINES=40
FAILED=0
declare -a RESULTS

for step in "${STEPS[@]}"; do
    out="$(npm run "$step" 2>&1)"
    if [[ $? -eq 0 ]]; then
        RESULTS+=("PASS  $step")
    else
        RESULTS+=("FAIL  $step")
        FAILED=1
        echo "───────────────────────────────────────────────"
        echo "FAIL: npm run $step (first $HEAD_LINES lines)"
        echo "───────────────────────────────────────────────"
        echo "$out" | tail -n "$HEAD_LINES"
        echo ""
    fi
done

echo "=============== verify summary ================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "==============================================="

exit $FAILED
