#!/usr/bin/env bash
# zmrng quick start — checks prerequisites, installs deps, and launches the app.
# Safe to re-run. Never installs anything outside this repo's node_modules;
# never uses sudo; never touches the network except `npm install`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

REQUIRED_NODE_MAJOR=20
REQUIRED_NODE_MINOR=11
MAX_NODE_MAJOR=23

echo "== zmrng setup =="

# --- Node version -----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found."
  echo "  Install Node 20.11–22 (e.g. via https://nodejs.org or nvm: https://github.com/nvm-sh/nvm)."
  echo "  If you use nvm, run: nvm install && nvm use   (this repo pins Node via .nvmrc)"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=${NODE_VERSION%%.*}
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)

version_ok=true
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  version_ok=false
elif [ "$NODE_MAJOR" -eq "$REQUIRED_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$REQUIRED_NODE_MINOR" ]; then
  version_ok=false
elif [ "$NODE_MAJOR" -ge "$MAX_NODE_MAJOR" ]; then
  version_ok=false
fi

if [ "$version_ok" = false ]; then
  echo "✗ Node $NODE_VERSION found, but zmrng needs 20.11–22."
  if command -v nvm >/dev/null 2>&1; then
    echo "  nvm detected — run: nvm install && nvm use"
  else
    echo "  Install a matching version from https://nodejs.org, or install nvm:"
    echo "  https://github.com/nvm-sh/nvm"
  fi
  exit 1
fi
echo "✓ Node $NODE_VERSION"

# --- Install ------------------------------------------------------------
echo "Installing dependencies (this compiles two native modules — better-sqlite3,"
echo "node-pty — prebuilt binaries cover most platforms; if this step fails, see"
echo "INSTRUCTIONS.md for the Python/build-tools prerequisite)..."
npm install
echo "✓ npm install complete"

# --- .env ---------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ .env created from .env.example (every var has a sane default)"
else
  echo "✓ .env already present, left untouched"
fi

# --- Preflight: claude / gh CLI -----------------------------------------
echo ""
echo "-- Preflight --"
if command -v claude >/dev/null 2>&1; then
  echo "✓ claude CLI found"
else
  echo "✗ claude CLI not found — zmrng spawns it to do the actual work."
  echo "  Install: https://docs.claude.com/en/docs/claude-code — then log in with"
  echo "  your Claude subscription (do NOT set ANTHROPIC_API_KEY; zmrng strips it"
  echo "  from workers on purpose so it uses your subscription, not the metered API)."
fi

if command -v gh >/dev/null 2>&1; then
  echo "✓ gh CLI found"
else
  echo "✗ gh CLI not found — zmrng opens PRs by shelling out to \`gh pr create\`."
  echo "  Install: https://cli.github.com — then run: gh auth login"
  echo "  (the app still boots without this; PR creation just won't work yet)"
fi

echo ""
echo "== Starting zmrng: server :4500 + web :5174 =="
echo "Open http://localhost:5174 once both watchers are up."
npm run dev
