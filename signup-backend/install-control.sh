#!/usr/bin/env bash
# install-control.sh — One-click installer for the OpenClaw control container.
#
# Usage (run as root on a fresh Ubuntu 22.04 LXC):
#   curl -fsSL https://raw.githubusercontent.com/omesbooks/openclaw_setup/main/signup-backend/install-control.sh \
#     | bash -s -- --domain signup.metaelearning.online --yes
#
# Result:
#   - Node.js 20 + the signup backend running as systemd service
#   - Caddy + Let's Encrypt for the signup domain
#   - SSH keypair generated for talking to customer containers
#   - Public key printed at the end — copy it into customer LXCs'
#     /root/.ssh/authorized_keys (or bake it into your LXC template)
#
# After install, register customers from this container:
#   register-container customer-foo.openclaw.example.com 10.0.0.12

set -euo pipefail

DOMAIN=""
ASSUME_YES=false
INSTALL_DIR="/opt/openclaw-signup"
SERVICE_USER="openclaw-signup"
GIT_REPO="https://github.com/omesbooks/openclaw_setup.git"

if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'; BLU=$'\033[0;34m'
  CYN=$'\033[0;36m'; DIM=$'\033[2m'; BLD=$'\033[1m'; RST=$'\033[0m'
else
  RED=""; GRN=""; YLW=""; BLU=""; CYN=""; DIM=""; BLD=""; RST=""
fi

err()   { echo "${RED}✗${RST} $*" >&2; }
warn()  { echo "${YLW}!${RST} $*" >&2; }
ok()    { echo "${GRN}✓${RST} $*"; }
info()  { echo "${BLU}·${RST} $*"; }
step()  { echo; echo "${BLD}${CYN}── $* ──${RST}"; }
fatal() { err "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: sudo bash install-control.sh [options]

Options:
  --domain <name>   Public domain for the signup form (e.g. signup.metaelearning.online)
  --yes             Skip confirm prompts

DNS A record for <domain> must point to this host.
Ports 80, 443 must be reachable from the internet.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)  DOMAIN="$2"; shift 2 ;;
    --yes|-y)  ASSUME_YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         err "Unknown option: $1"; usage; exit 1 ;;
  esac
done

cat <<'BANNER'

  ╭───────────────────────────────────────────────╮
  │   🦞  OpenClaw — Control container installer  │
  ╰───────────────────────────────────────────────╯

BANNER

[[ $EUID -eq 0 ]] || fatal "Run as root (use sudo)"

if [[ -z "$DOMAIN" ]]; then
  read -rp "Public signup domain (e.g. signup.metaelearning.online): " DOMAIN
fi
[[ -z "$DOMAIN" ]] && fatal "DOMAIN is required"

step "Plan"
echo "  Domain        : $DOMAIN"
echo "  Install dir   : $INSTALL_DIR"
echo "  Service user  : $SERVICE_USER"
$ASSUME_YES || { read -rp "Proceed? [Y/n] " yn; [[ "${yn:-}" =~ ^[Nn] ]] && fatal "aborted"; }

step "[1/7] Installing system dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg git build-essential python3 \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null
ok "deps installed"

step "[2/7] Installing Node.js 20"
if ! command -v node >/dev/null 2>&1 || [[ "$(node --version | sed 's/v//' | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node --version) / npm $(npm --version)"

step "[3/7] Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
ok "$(caddy version | head -1)"

step "[4/7] Cloning repo + installing dependencies"
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 "$GIT_REPO" "$INSTALL_DIR" >/dev/null
else
  git -C "$INSTALL_DIR" pull --ff-only >/dev/null
fi
cd "$INSTALL_DIR/signup-backend"
npm install --omit=dev --silent
ok "node modules installed"

step "[5/7] Creating service user + SSH keypair"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  adduser --system --group --home "$INSTALL_DIR/signup-backend" --no-create-home --shell /bin/bash "$SERVICE_USER"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/signup-backend"
mkdir -p "$INSTALL_DIR/signup-backend/data"
chmod 700 "$INSTALL_DIR/signup-backend/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/signup-backend/data"

KEY_PATH="$INSTALL_DIR/signup-backend/data/control_key"
if [[ ! -f "$KEY_PATH" ]]; then
  sudo -u "$SERVICE_USER" ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -C "openclaw-signup-control" >/dev/null
fi
PUB_KEY=$(cat "${KEY_PATH}.pub")
ok "SSH key ready: $KEY_PATH"

step "[6/7] systemd service"
cat > /etc/systemd/system/openclaw-signup.service <<EOF
[Unit]
Description=OpenClaw signup backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/signup-backend
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=SIGNUP_BASE_URL=https://${DOMAIN}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now openclaw-signup
sleep 2
ok "openclaw-signup.service running"

step "[7/7] Caddy reverse proxy"
cat > /etc/caddy/Caddyfile <<EOF
{
    servers {
        protocols h1 h2
    }
}

${DOMAIN} {
    reverse_proxy 127.0.0.1:3000
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || fatal "Caddyfile invalid"
systemctl reload caddy
ok "Caddy reloaded (Let's Encrypt cert in flight)"

# Add register-container to PATH
ln -sf "$INSTALL_DIR/signup-backend/bin/register-container.js" /usr/local/bin/register-container
chmod +x "$INSTALL_DIR/signup-backend/bin/register-container.js"

# Convenience wrapper that runs as the service user.
cat > /usr/local/bin/oc-register <<'EOF'
#!/bin/bash
exec sudo -u openclaw-signup -H \
  env SIGNUP_BASE_URL="${SIGNUP_BASE_URL:-}" \
  /usr/bin/node /opt/openclaw-signup/signup-backend/bin/register-container.js "$@"
EOF
chmod 755 /usr/local/bin/oc-register

cat <<EOF

  ╭────────────────────────────────────────────────────────────────╮
  │   ${GRN}🎉 Control container ready!${RST}                                  │
  ╰────────────────────────────────────────────────────────────────╯

  ${BLD}Signup form${RST}
    https://${DOMAIN}/

  ${BLD}Public SSH key — add this to /root/.ssh/authorized_keys on each${RST}
  ${BLD}customer container (or bake into your LXC template)${RST}:

${PUB_KEY}

  ${BLD}Register a new customer container${RST}
    oc-register customer-foo.openclaw.example.com 10.0.0.12

  ${BLD}Logs${RST}
    journalctl -u openclaw-signup -f
    journalctl -u caddy -f

  ${BLD}Storage${RST}
    DB:  ${INSTALL_DIR}/signup-backend/data/tokens.db
    Key: ${INSTALL_DIR}/signup-backend/data/control_key

EOF
