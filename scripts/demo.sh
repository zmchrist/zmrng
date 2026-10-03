#!/usr/bin/env bash
# zmrng demo profile — launches the app against a throwaway, empty data dir and a
# demo-only projects dir, so a screen recording shows NONE of your real tasks,
# Knowledge Base pages, Team chat, or project file tree. Same binary as a normal
# run; nothing here touches your real ~/Library/Application Support/zmrng data.
#
# Override the two locations with env vars if you like:
#   ZMRNG_DEMO_DATA_DIR      (default ~/zmrng-demo-data)      empty DB + worktrees
#   ZMRNG_DEMO_PROJECTS_DIR  (default ~/zmrng-demo-projects)  scanned for target repos
# Pass a default target repo id through as usual:
#   ZMRNG_DEFAULT_REPO=<id> scripts/demo.sh
#
# Safe to re-run. Never uses sudo; the only network use is npm's (via `npm run dev`).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DATA_DIR="${ZMRNG_DEMO_DATA_DIR:-$HOME/zmrng-demo-data}"
PROJECTS_DIR="${ZMRNG_DEMO_PROJECTS_DIR:-$HOME/zmrng-demo-projects}"

echo "== zmrng demo profile =="
echo "  data dir     : $DATA_DIR    (throwaway — delete it to reset the demo)"
echo "  projects dir : $PROJECTS_DIR"
echo

mkdir -p "$DATA_DIR" "$PROJECTS_DIR"

# --- Which repos will show in the dropdown / file tree -----------------------
repo_count=0
if [ -d "$PROJECTS_DIR" ]; then
  while IFS= read -r gitdir; do
    repo_count=$((repo_count + 1))
    echo "  • demo repo: $(basename "$(dirname "$gitdir")")"
  done < <(find "$PROJECTS_DIR" -maxdepth 2 -name .git -print 2>/dev/null)
fi
if [ "$repo_count" -eq 0 ]; then
  echo "  ⚠ No git repos found under $PROJECTS_DIR."
  echo "    The demo task needs a target repo you can PUSH to (so the PR opens)."
  echo "    Clone a small one, e.g.:"
  echo "      git clone <your-demo-repo> \"$PROJECTS_DIR/demo-app\""
  echo "    then re-run this script. (The 'zmrng' self-entry also appears, but"
  echo "    don't demo against it — that would put this codebase on screen.)"
  echo
fi

# --- Advisory prerequisite checks (never hard-fail) --------------------------
for bin in claude gh git; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "  ✓ $bin on PATH"
  else
    echo "  ✗ $bin NOT on PATH — the autonomous run needs it to reach a PR"
  fi
done

# A VITE_WORKSPACE_URL baked into the root .env would make the Team tab show your
# VPS in the recording. Warn so you can comment it out before recording.
if [ -f .env ] && grep -qE '^[[:space:]]*VITE_WORKSPACE_URL=..' .env; then
  echo "  ⚠ .env sets VITE_WORKSPACE_URL — the Team tab will show your VPS on camera."
  echo "    Comment it out for the recording (the Team tab is then empty)."
fi
echo

echo "Launching dev server — record http://localhost:5174 (NOT :4500)."
echo "Pick the demo repo as the task target. Press Ctrl-C to stop."
echo

export ZMRNG_DATA_DIR="$DATA_DIR"
export ZMRNG_PROJECTS_DIR="$PROJECTS_DIR"
exec npm run dev
