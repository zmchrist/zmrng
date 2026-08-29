#!/usr/bin/env bash
# Team-workspace VPS deploy (D2 of .agents/plans/layman-onboarding-grill.md).
#
# Stands up the SAME zmrng server binary on a VPS as the shared Team workspace
# server. Idempotent: safe to re-run to pick up a new commit. Run it ON the VPS
# (or over ssh), as a user that can write the install dir and manage systemd.
#
#   bash scripts/deploy-workspace.sh
#
# It does NOT expose anything publicly. The Tailscale tailnet is the security
# perimeter (self-asserted handles == tailnet membership is the access control):
# the server binds 0.0.0.0 inside the box, and the firewall step restricts the
# workspace port to the tailscale0 interface only. See
# docs/team-workspace-deploy.md for the full runbook + the live smoke test.
#
# Everything is overridable via env; every var has a sane default:
#   ZMRNG_REPO_URL     git remote to clone            (default: origin of this checkout)
#   ZMRNG_INSTALL_DIR  where to clone/pull            (default: /opt/zmrng-workspace)
#   ZMRNG_BRANCH       branch to deploy               (default: main)
#   ZMRNG_PORT         workspace port                 (default: 4500)
#   ZMRNG_DATA_DIR     stable dir for zmrng.db        (default: /var/lib/zmrng-workspace)
#   ZMRNG_ENV_FILE     env file systemd loads         (default: /etc/zmrng/workspace.env)
#   ZMRNG_SERVICE      systemd unit name              (default: zmrng-workspace)
#   ZMRNG_RUN_USER     unix user the service runs as  (default: current user)
#   ZMRNG_APPLY_FIREWALL=1  actually apply the tailnet-only nft rule (default: print only)
#   ZMRNG_SKIP_SYSTEMD=1    build + configure only, do not touch systemd
set -euo pipefail

INSTALL_DIR="${ZMRNG_INSTALL_DIR:-/opt/zmrng-workspace}"
BRANCH="${ZMRNG_BRANCH:-main}"
PORT="${ZMRNG_PORT:-4500}"
DATA_DIR="${ZMRNG_DATA_DIR:-/var/lib/zmrng-workspace}"
ENV_FILE="${ZMRNG_ENV_FILE:-/etc/zmrng/workspace.env}"
SERVICE="${ZMRNG_SERVICE:-zmrng-workspace}"
RUN_USER="${ZMRNG_RUN_USER:-$(id -un)}"

log()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. Preflight ────────────────────────────────────────────────────────────
log "Preflight checks"
command -v git  >/dev/null || die "git not found"
command -v node >/dev/null || die "node not found (need >=20.11.0 <23)"
command -v npm  >/dev/null || die "npm not found"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ] || [ "$NODE_MAJOR" -ge 23 ]; then
  warn "node $(node -v) is outside the supported range >=20.11.0 <23 — proceeding anyway"
fi

if command -v tailscale >/dev/null; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  if [ -n "$TS_IP" ]; then
    ok "Tailscale up — tailnet IP ${TS_IP}"
  else
    warn "Tailscale installed but no IPv4 address — is it 'tailscale up'?"
  fi
else
  warn "Tailscale not found. The tailnet IS the security perimeter for this POC."
  warn "Install + 'tailscale up' before exposing the workspace. See the runbook."
  TS_IP=""
fi

# Default repo URL to this checkout's origin when not overridden.
REPO_URL="${ZMRNG_REPO_URL:-}"
if [ -z "$REPO_URL" ]; then
  REPO_URL="$(git -C "$(dirname "$0")/.." remote get-url origin 2>/dev/null || true)"
  [ -n "$REPO_URL" ] || die "ZMRNG_REPO_URL not set and no origin remote found to default from"
fi

# ── 1. Clone or update the checkout ─────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --prune origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/${BRANCH}"
else
  log "Cloning $REPO_URL → $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
ok "Checkout at $(git -C "$INSTALL_DIR" rev-parse --short HEAD) on $BRANCH"

# ── 2. Install deps + build ─────────────────────────────────────────────────
log "Installing dependencies (npm ci)"
( cd "$INSTALL_DIR" && npm ci )
log "Building server + web (npm run build)"
( cd "$INSTALL_DIR" && npm run build )
ok "Build complete"

# ── 3. Stable data dir + env file (never clobber an existing env) ───────────
mkdir -p "$DATA_DIR"
chown -R "$RUN_USER" "$DATA_DIR" 2>/dev/null || true
ok "Data dir $DATA_DIR (zmrng.db persists here across redeploys)"

if [ ! -f "$ENV_FILE" ]; then
  log "Writing starter env file at $ENV_FILE (edit it, then re-run or restart)"
  mkdir -p "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<EOF
# zmrng team-workspace server env — loaded by the systemd unit.
# SECURITY: never set ANTHROPIC_API_KEY here (oauth mode strips it anyway).

ZMRNG_PORT=${PORT}
ZMRNG_DATA_DIR=${DATA_DIR}

# Server-side default URL surfaced to clients via GET /api/config. Optional —
# teammates can instead paste it into Settings (localStorage zmrng-workspace-url).
# Use the tailnet IP or MagicDNS name, e.g. http://${TS_IP:-100.x.y.z}:${PORT}
ZMRNG_WORKSPACE_URL=

# ── @mention team agent (T4). Leave blank to run the workspace WITHOUT a bot. ──
# Absolute path to a read-only reference checkout the bot 'git pull's before it
# answers. Empty = the pull is skipped gracefully.
ZMRNG_WORKSPACE_REPO_PATH=
# id of the configured AgentTarget (config/agents.json) that acts as the bot.
# Empty selects the first configured agent.
ZMRNG_WORKSPACE_BOT_AGENT=
# The @mention handle that triggers the bot.
ZMRNG_WORKSPACE_BOT_HANDLE=@agent
# How many recent channel messages are relayed to the bot as context.
ZMRNG_WORKSPACE_SCROLLBACK=20
# Per-request timeout (ms) that caps a hung upstream bot.
ZMRNG_WORKSPACE_AGENT_TIMEOUT_MS=60000
EOF
  ok "Starter env written — review $ENV_FILE before going live"
else
  ok "Existing env at $ENV_FILE left untouched"
fi

# ── 4. Firewall: restrict the workspace port to the tailscale0 interface ─────
# The server binds 0.0.0.0; the tailnet is the perimeter, so the port must be
# reachable ONLY over tailscale0. On a SHARED box this rule is not applied
# automatically — set ZMRNG_APPLY_FIREWALL=1 to apply, else it is printed for
# you to review and run by hand.
NFT_RULE="add rule inet filter input tcp dport ${PORT} iifname != \"tailscale0\" drop"
if [ "${ZMRNG_APPLY_FIREWALL:-0}" = "1" ]; then
  if command -v nft >/dev/null; then
    log "Applying nftables tailnet-only rule for port ${PORT}"
    nft list table inet filter >/dev/null 2>&1 || nft add table inet filter
    nft list chain inet filter input >/dev/null 2>&1 || \
      nft 'add chain inet filter input { type filter hook input priority 0; policy accept; }'
    nft "$NFT_RULE"
    ok "nft rule applied: port ${PORT} reachable only on tailscale0"
  else
    warn "nft not found; apply an equivalent iptables rule by hand (see runbook)"
  fi
else
  warn "Firewall NOT applied (shared box safety). Review + apply this rule yourself:"
  printf '    nft %s\n' "\"$NFT_RULE\"" >&2
  printf '    (iptables equivalent: iptables -A INPUT -p tcp --dport %s ! -i tailscale0 -j DROP)\n' "$PORT" >&2
fi

# ── 5. systemd unit ─────────────────────────────────────────────────────────
if [ "${ZMRNG_SKIP_SYSTEMD:-0}" = "1" ]; then
  warn "ZMRNG_SKIP_SYSTEMD=1 — skipping systemd unit. Start manually with:"
  # shellcheck disable=SC2016  # the $(...) is literal text printed for the user to run
  printf '    (cd %s && env $(grep -v "^#" %s | xargs) npm start)\n' "$INSTALL_DIR" "$ENV_FILE" >&2
  ok "Configure-only run complete"
  exit 0
fi

command -v systemctl >/dev/null || die "systemctl not found and ZMRNG_SKIP_SYSTEMD is not set"
UNIT_PATH="/etc/systemd/system/${SERVICE}.service"
log "Writing systemd unit $UNIT_PATH"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=zmrng team-workspace server
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v npm) start
Restart=on-failure
RestartSec=3
# Hardening: this instance serves the shared workspace only — never spawns
# task workers, so it needs no access to the operator's Max OAuth login.

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
ok "Service ${SERVICE} (re)started"

# ── 6. Health check on the tailnet address ──────────────────────────────────
sleep 2
HEALTH_HOST="${TS_IP:-127.0.0.1}"
if curl -fsS "http://${HEALTH_HOST}:${PORT}/api/config" >/dev/null 2>&1; then
  ok "Health check OK — GET http://${HEALTH_HOST}:${PORT}/api/config responded"
else
  warn "Health check did not respond yet. Inspect: journalctl -u ${SERVICE} -n 50 --no-pager"
fi

echo
ok "Deploy complete. Next: run the live smoke test in docs/team-workspace-deploy.md §Smoke test."
printf '  Teammate Settings → workspace URL: \033[1mhttp://%s:%s\033[0m\n' "${TS_IP:-<tailnet-ip>}" "$PORT"
