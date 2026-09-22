#!/usr/bin/env bash
# verify.sh — single source of truth for the zmrng validation gate.
#
# Runs the checks in order and prints a compact PASS/FAIL summary instead of
# flooding context with full tool output. On failure it shows the first lines of
# the failing step's output — enough to act on, not enough to rot context — plus
# the last lines when the output is longer than that window, so the aggregate
# pass counts stay visible.
#
# The test step is split per workspace (test:server, test:web) so the summary
# names the failing workspace. It used to be one `npm run test --workspaces`
# step whose combined output was printed with `tail`: web runs last, so a green
# web tail buried a red server run entirely and the summary said only
# "FAIL test".
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

STEPS=("typecheck" "lint" "test:server" "test:web")
[[ $FAST -eq 0 ]] && STEPS+=("build")

HEAD_LINES=40
TAIL_LINES=20
FAILED=0
declare -a RESULTS

# Each step maps to the command it runs. typecheck/lint/build already report
# per-workspace inline; only `test` needed splitting.
run_step() {
    case "$1" in
        test:server) npm run test -w @zmrng/server 2>&1 ;;
        test:web) npm run test -w @zmrng/web 2>&1 ;;
        *) npm run "$1" 2>&1 ;;
    esac
}

rule() { echo "───────────────────────────────────────────────"; }

for step in "${STEPS[@]}"; do
    out="$(run_step "$step")"
    if [[ $? -eq 0 ]]; then
        RESULTS+=("PASS  $step")
    else
        RESULTS+=("FAIL  $step")
        FAILED=1
        lines=$(printf '%s\n' "$out" | wc -l)
        rule
        echo "FAIL: $step (first $HEAD_LINES lines)"
        rule
        printf '%s\n' "$out" | head -n "$HEAD_LINES"
        if (( lines > HEAD_LINES )); then
            rule
            echo "FAIL: $step (last $TAIL_LINES lines of $lines)"
            rule
            printf '%s\n' "$out" | tail -n "$TAIL_LINES"
        fi
        echo ""
    fi
done

echo "=============== verify summary ================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "==============================================="

exit $FAILED
