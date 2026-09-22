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

# --- workspace scoping (--fast only) ---------------------------------------
#
# The turn-stop gate used to run both workspaces' suites on every turn, even
# when the turn never touched one of them. The web suite alone is ~59% of the
# gate's wall time, and almost all of that is jsdom construction rather than the
# tests, so it is not worth paying for a server-only or docs-only turn.
#
# This may only ever REMOVE work it can positively prove is unnecessary. Every
# ambiguous case — not a git repo, no origin/main, a changed path that is
# neither workspace-scoped nor known-inert — falls back to running both. The
# full pre-PR gate (no --fast) is never scoped, so the last gate before a PR
# still runs everything.
#
# Override: ZMRNG_VERIFY_NO_SCOPE=1
NEED_SERVER=1
NEED_WEB=1
SCOPE_NOTE=""

changed_paths() {
    git rev-parse --git-dir >/dev/null 2>&1 || return 1
    local base
    base="$(git merge-base HEAD origin/main 2>/dev/null)" || return 1
    [[ -n "$base" ]] || return 1
    {
        git diff --name-only "$base" HEAD 2>/dev/null
        git status --porcelain 2>/dev/null | sed 's/^.\{3\}//' | tr -d '"'
    } | sed '/^$/d' | sort -u
}

scope_steps() {
    local paths
    paths="$(changed_paths)" || { SCOPE_NOTE="not a git repo / no origin-main — running both"; return; }
    [[ -n "$paths" ]] || { SCOPE_NOTE="no changes detected — running both"; return; }

    local server=0 web=0 unknown=0 p
    while IFS= read -r p; do
        case "$p" in
            packages/server/*) server=1 ;;
            packages/web/*) web=1 ;;
            # Inert: never affects either suite.
            .agents/*|docs/*|*.md) ;;
            *) unknown=1 ;;
        esac
    done <<< "$paths"

    if [[ $unknown -eq 1 ]]; then
        SCOPE_NOTE="changes outside both workspaces — running both"
        return
    fi
    NEED_SERVER=$server
    NEED_WEB=$web
    SCOPE_NOTE="scoped to changed workspaces (server=$server web=$web)"
}

if [[ $FAST -eq 1 && "${ZMRNG_VERIFY_NO_SCOPE:-0}" != "1" ]]; then
    scope_steps
fi

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
    if [[ "$step" == "test:server" && $NEED_SERVER -eq 0 ]] \
    || [[ "$step" == "test:web" && $NEED_WEB -eq 0 ]]; then
        RESULTS+=("SKIP  $step (workspace unchanged)")
        continue
    fi
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
[[ -n "$SCOPE_NOTE" ]] && echo "  — $SCOPE_NOTE"
echo "==============================================="

exit $FAILED
