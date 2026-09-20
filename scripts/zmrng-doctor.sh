#!/usr/bin/env bash
# zmrng-doctor — lightweight leak detector for zmrng agent processes.
#
# WHY: each zmrng task spawns a long-lived headless `claude` (~300-350MB RSS)
# inside a git worktree, and `claude` itself spawns subagents + tool subprocesses
# (bash, git, semgrep, osv-scanner, vitest, tsc, vite). When the app quits — or
# especially when you just close a browser tab in dev/`npm start` mode — those
# grandchildren can be orphaned (reparented to launchd, PPID 1) and keep burning
# CPU/RAM. A few orphans = >1GB resident + pegged cores = the freeze you saw.
#
# WHAT: finds every process whose working directory sits under a zmrng worktrees
# dir (dev repo + the app's data dir), tags each LIVE (has a real zmrng server
# parent) or ORPHANED (reparented / no live server), and totals CPU+RAM. Read-only
# by default. Pass --kill to SIGTERM→SIGKILL the ORPHANED ones (never the live app).
#
# Zero dependencies: bash + ps + lsof + pgrep (all stock macOS). Nothing installed,
# nothing left running.
#
# Usage:
#   scripts/zmrng-doctor.sh            # report only
#   scripts/zmrng-doctor.sh --kill     # report, then reap orphans (asks first)
#   scripts/zmrng-doctor.sh --kill -y  # reap orphans without prompting
set -euo pipefail

KILL=0; YES=0
for a in "$@"; do
  case "$a" in
    --kill) KILL=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

# --- locate zmrng worktree roots (dev repo + shipped app data dir) -------------
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANDIDATE_ROOTS=(
  "$REPO_ROOT/worktrees"
  "$HOME/Library/Application Support/zmrng/worktrees"
  "${ZMRNG_DATA_DIR:-}/worktrees"
)
ROOTS=()
for r in "${CANDIDATE_ROOTS[@]}"; do
  [ -n "$r" ] && [ -d "$r" ] && ROOTS+=("$r")
done

# --- find live zmrng SERVER pids (dev tsx, built dist, or bundled sidecar) -----
# A worker whose ancestor is one of these is LIVE (managed); anything else with a
# worktree cwd is ORPHANED.
SERVER_PIDS=" $( { pgrep -f 'packages/server/src/index.ts|server/dist/index.js|sidecar/server.mjs' 2>/dev/null || true; } | tr '\n' ' ') "

# walk PPID chain; echo 0/1 whether pid descends from a live server
descends_from_server() {
  local pid="$1" hops=0
  while [ "$pid" -gt 1 ] && [ "$hops" -lt 40 ]; do
    case "$SERVER_PIDS" in *" $pid "*) echo 1; return;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -z "$pid" ] && break
    hops=$((hops+1))
  done
  echo 0
}

cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

under_worktree() {
  local cwd="$1"
  [ -z "$cwd" ] && return 1
  for root in "${ROOTS[@]}"; do
    case "$cwd" in "$root"/*|"$root") return 0;; esac
  done
  return 1
}

# --- scan candidate processes -------------------------------------------------
# Cast a wide net (claude + common tool procs), then keep only those whose cwd is
# inside a worktree — that's the reliable "belongs to a zmrng task" signal and it
# won't misfire on your other (non-zmrng) claude sessions.
CANDIDATES="$(pgrep -f 'claude|node|semgrep|osv-scanner|vitest|tsc|vite|npm|git' 2>/dev/null | sort -un || true)"

printf '%-7s %-7s %6s %9s  %-8s %s\n' PID PPID %CPU RSS_MB STATE CWD
echo   "----------------------------------------------------------------------------"

total_cpu=0; total_rss=0; n_live=0; n_orphan=0
ORPHAN_PIDS=()

for pid in $CANDIDATES; do
  [ "$pid" = "$$" ] && continue
  ps -p "$pid" >/dev/null 2>&1 || continue
  cwd="$(cwd_of "$pid")"
  under_worktree "$cwd" || continue

  read -r ppid cpu rss <<<"$(ps -o ppid=,pcpu=,rss= -p "$pid" 2>/dev/null)"
  [ -z "${ppid:-}" ] && continue
  rss_mb=$(( rss / 1024 ))

  if [ "$(descends_from_server "$pid")" = 1 ]; then
    state="LIVE"; n_live=$((n_live+1))
  else
    state="ORPHAN"; n_orphan=$((n_orphan+1)); ORPHAN_PIDS+=("$pid")
  fi

  printf '%-7s %-7s %6s %9s  %-8s %s\n' "$pid" "$ppid" "$cpu" "$rss_mb" "$state" "${cwd/#$HOME/~}"
  total_cpu=$(awk "BEGIN{print $total_cpu + $cpu}")
  total_rss=$((total_rss + rss_mb))
done

echo   "----------------------------------------------------------------------------"
printf 'zmrng worktree procs: %d live, %d ORPHANED  |  total CPU %.1f%%  RAM %d MB\n' \
  "$n_live" "$n_orphan" "$total_cpu" "$total_rss"

if [ "${#ROOTS[@]}" -eq 0 ]; then
  echo "note: no worktrees dir found yet — nothing to leak, or app never ran here."
fi

if [ "$n_orphan" -eq 0 ]; then
  echo "clean: no orphaned agent processes."
  exit 0
fi

echo
echo "ORPHANED processes are not attached to any live zmrng server — leftover leaks."
if [ "$KILL" -ne 1 ]; then
  echo "Re-run with --kill to reap them:  scripts/zmrng-doctor.sh --kill"
  exit 1
fi

if [ "$YES" -ne 1 ]; then
  printf 'Reap %d orphaned process(es)? [y/N] ' "${#ORPHAN_PIDS[@]}"
  read -r ans
  case "$ans" in y|Y) ;; *) echo "aborted."; exit 1;; esac
fi

# SIGTERM, grace, then SIGKILL any that ignored it.
for pid in "${ORPHAN_PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
sleep 3
for pid in "${ORPHAN_PIDS[@]}"; do
  if ps -p "$pid" >/dev/null 2>&1; then kill -KILL "$pid" 2>/dev/null || true; fi
done
echo "reaped ${#ORPHAN_PIDS[@]} orphaned process(es)."
