#!/usr/bin/env bash
# Team-workspace VPS conditional auto-update (D2 of
# .agents/plans/instance-update-distribution-grill.md).
#
# Polls the git remote and re-runs scripts/deploy-workspace.sh ONLY when the
# tracked branch has moved — i.e. when `origin/<branch>` is ahead of the local
# checkout's HEAD. When already current it exits 0 silently, so it is cheap to
# run on a tight timer without churning rebuilds or dropping live sockets on
# every tick. Intended to be driven by a systemd timer (or crontab) on the VPS;
# see docs/team-workspace-deploy.md §5. Run it as the same user that owns the
# install dir and can manage the systemd service.
#
#   bash scripts/autoupdate-workspace.sh
#
# It shares deploy-workspace.sh's env contract — every var has a sane default:
#   ZMRNG_INSTALL_DIR  checkout to poll + redeploy   (default: /opt/zmrng-workspace)
#   ZMRNG_BRANCH       branch to track               (default: main)
#   ZMRNG_DEPLOY_SCRIPT path to deploy-workspace.sh   (default: <install>/scripts/deploy-workspace.sh)
# Any other ZMRNG_* override understood by deploy-workspace.sh is passed through
# unchanged (it inherits this process's environment).
set -euo pipefail

INSTALL_DIR="${ZMRNG_INSTALL_DIR:-/opt/zmrng-workspace}"
BRANCH="${ZMRNG_BRANCH:-main}"
DEPLOY_SCRIPT="${ZMRNG_DEPLOY_SCRIPT:-${INSTALL_DIR}/scripts/deploy-workspace.sh}"

log()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git not found"
[ -d "$INSTALL_DIR/.git" ] || die "no git checkout at $INSTALL_DIR (run deploy-workspace.sh first)"

# Fetch just the tracked branch; --quiet keeps a no-op tick out of the journal.
git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"

LOCAL_SHA="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
REMOTE_SHA="$(git -C "$INSTALL_DIR" rev-parse "origin/${BRANCH}")"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  # Already current — say nothing (silent no-op tick).
  exit 0
fi

log "New commit on origin/${BRANCH}: ${LOCAL_SHA:0:8} → ${REMOTE_SHA:0:8} — redeploying"
[ -f "$DEPLOY_SCRIPT" ] || die "deploy script not found at $DEPLOY_SCRIPT"

# deploy-workspace.sh does its own fetch + reset --hard origin/<branch> + rebuild
# + restart, and inherits our ZMRNG_* env. It only touches the checkout, never
# ZMRNG_DATA_DIR, so zmrng.db (channels/messages/members) survives the redeploy.
bash "$DEPLOY_SCRIPT"

ok "Auto-update complete — now at $(git -C "$INSTALL_DIR" rev-parse --short HEAD) on ${BRANCH}"
