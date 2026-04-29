#!/usr/bin/env bash
# install-openclaw.sh — One-click OpenClaw self-host installer
#
# Usage (interactive — prompts for inputs):
#   sudo bash install-openclaw.sh
#
# Usage (non-interactive):
#   sudo bash install-openclaw.sh --domain customer-01.example.com --user testuser --yes
#
# Usage (pipe through SSH from your laptop):
#   ssh root@new-host 'bash -s' < install-openclaw.sh
#
# Result: HTTPS-enabled OpenClaw with auto-pair, ready for your customer.

set -euo pipefail

# ─── Globals ───────────────────────────────────────────────────────
DOMAIN=""
GATEWAY_USER=""
SSH_PASSWORD=""
ASSUME_YES=false

# ─── Colors ────────────────────────────────────────────────────────
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
Usage: sudo bash install-openclaw.sh [options]

Options:
  --domain <name>     Domain for this instance (e.g. customer-01.example.com)
  --user <name>       Gateway/SSH user (default: testuser)
  --password <pw>     SSH password (default: random)
  --yes               Skip all confirm prompts
  -h, --help          Show this help

DNS A record for <domain> must already point to this host.
Ports 22, 80, 443 must be reachable from the internet.
EOF
}

# ─── Args ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)   DOMAIN="$2"; shift 2 ;;
    --user)     GATEWAY_USER="$2"; shift 2 ;;
    --password) SSH_PASSWORD="$2"; shift 2 ;;
    --yes|-y)   ASSUME_YES=true; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          err "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# ─── Banner ────────────────────────────────────────────────────────
cat <<'BANNER'

  ╭───────────────────────────────────────────────╮
  │   🦞  OpenClaw 1-Click Self-Host Installer    │
  ╰───────────────────────────────────────────────╯

BANNER

# ─── Prereq ────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || fatal "Run as root (use sudo)"
. /etc/os-release 2>/dev/null || true
[[ "${ID:-}" == "ubuntu" ]] || warn "Tested on Ubuntu — your OS: ${ID:-unknown}"

# ─── Prompt for inputs ─────────────────────────────────────────────
step "Configuration"

if [[ -z "$DOMAIN" ]]; then
  read -rp "Domain (e.g. customer-01.example.com): " DOMAIN
fi
[[ -z "$DOMAIN" ]] && fatal "DOMAIN is required"

if [[ -z "$GATEWAY_USER" ]]; then
  read -rp "Gateway / SSH user [testuser]: " GATEWAY_USER
  GATEWAY_USER=${GATEWAY_USER:-testuser}
fi

if [[ -z "$SSH_PASSWORD" ]]; then
  SSH_PASSWORD=$(openssl rand -base64 18 | tr -d '=+/' | head -c 16)
  info "Generated random SSH password"
fi

GATEWAY_TOKEN=$(openssl rand -hex 32)
HOST_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
[[ -z "${HOST_IP:-}" ]] && HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

# ─── DNS check ─────────────────────────────────────────────────────
step "Checking DNS"
RESOLVED_IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
if [[ -z "$RESOLVED_IP" ]]; then
  warn "DNS for $DOMAIN does not resolve yet."
  warn "Add an A record: $DOMAIN → $HOST_IP"
  $ASSUME_YES || { read -rp "Continue anyway? [y/N] " yn; [[ "${yn:-}" =~ ^[Yy] ]] || fatal "aborted"; }
elif [[ "$RESOLVED_IP" != "$HOST_IP" ]]; then
  warn "DNS resolves $DOMAIN → $RESOLVED_IP, but this host's IP is $HOST_IP"
  warn "Let's Encrypt may fail until DNS matches."
  $ASSUME_YES || { read -rp "Continue anyway? [y/N] " yn; [[ "${yn:-}" =~ ^[Yy] ]] || fatal "aborted"; }
else
  ok "DNS $DOMAIN → $RESOLVED_IP (matches host)"
fi

# ─── Plan ──────────────────────────────────────────────────────────
step "Plan"
cat <<EOF
  Domain        : $DOMAIN
  Gateway user  : $GATEWAY_USER
  SSH password  : $SSH_PASSWORD
  Gateway token : ${GATEWAY_TOKEN:0:16}…
  Host IP       : $HOST_IP
EOF

if ! $ASSUME_YES; then
  echo
  read -rp "Proceed? [Y/n] " yn
  [[ "${yn:-}" =~ ^[Nn] ]] && fatal "aborted"
fi

# ─── Step 1: deps ──────────────────────────────────────────────────
step "[1/9] Installing system dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg sudo \
  debian-keyring debian-archive-keyring apt-transport-https \
  python3 openssl >/dev/null
ok "deps installed"

# ─── Step 2: Node 24 ───────────────────────────────────────────────
step "[2/9] Installing Node.js 24"
NEED_NODE=true
if command -v node >/dev/null 2>&1; then
  V=$(node --version | sed 's/v//' | cut -d. -f1)
  [[ "$V" == "24" ]] && NEED_NODE=false
fi
if $NEED_NODE; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node --version) / npm $(npm --version)"

# ─── Step 3: openclaw ──────────────────────────────────────────────
step "[3/9] Installing OpenClaw"
if ! command -v openclaw >/dev/null 2>&1; then
  curl -fsSL https://openclaw.ai/install.sh | bash >/dev/null 2>&1 || true
fi
command -v openclaw >/dev/null 2>&1 || fatal "openclaw install failed"
ok "openclaw $(openclaw --version 2>&1 | head -1)"

# ─── Step 4: Caddy ─────────────────────────────────────────────────
step "[4/9] Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
ok "$(caddy version | head -1)"

# ─── Step 5: gateway user ──────────────────────────────────────────
step "[5/9] Setting up user $GATEWAY_USER"
if ! id "$GATEWAY_USER" >/dev/null 2>&1; then
  adduser --gecos "" --disabled-password "$GATEWAY_USER" >/dev/null
  usermod -aG sudo "$GATEWAY_USER"
fi
echo "$GATEWAY_USER:$SSH_PASSWORD" | chpasswd
loginctl enable-linger "$GATEWAY_USER" 2>/dev/null || true
ok "user ready, linger enabled"

# ─── Step 6: openclaw onboard ──────────────────────────────────────
step "[6/9] Onboarding OpenClaw"
sudo -u "$GATEWAY_USER" -i bash <<EOF >/dev/null 2>&1 || true
  openclaw onboard --install-daemon --non-interactive --accept-risk \
    --flow quickstart --auth-choice skip \
    --gateway-bind loopback --gateway-port 18789 \
    --gateway-auth token --gateway-token "$GATEWAY_TOKEN"
EOF
ok "onboarded"

# ─── Step 7: patch config ──────────────────────────────────────────
step "[7/9] Patching gateway config (autoApproveCidrs / trustedProxies / allowedOrigins)"
sudo -u "$GATEWAY_USER" python3 - "$DOMAIN" "/home/$GATEWAY_USER/.openclaw/openclaw.json" <<'PYEOF'
import json, sys
domain, path = sys.argv[1], sys.argv[2]
c = json.load(open(path))
g = c.setdefault("gateway", {})
g["trustedProxies"] = ["127.0.0.1", "::1"]
g.setdefault("controlUi", {})["allowedOrigins"] = [f"https://{domain}"]
g.setdefault("nodes", {}).setdefault("pairing", {})["autoApproveCidrs"] = ["0.0.0.0/0", "::/0"]
json.dump(c, open(path, "w"), indent=2)
PYEOF
sudo -u "$GATEWAY_USER" -i openclaw gateway restart >/dev/null 2>&1 || true
ok "config patched + gateway restarted"

# ─── Step 8: Caddy config ──────────────────────────────────────────
step "[8/9] Configuring Caddy reverse proxy"
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
cat > /etc/caddy/Caddyfile <<EOF
{
    servers {
        protocols h1 h2
    }
}

$DOMAIN {
    log {
        output file /var/log/caddy/access.log
        format json
    }
    reverse_proxy 127.0.0.1:18789
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || fatal "Caddyfile invalid"
systemctl reload caddy
ok "Caddy reloaded (Let's Encrypt cert in flight)"

# ─── Step 9: setup-provider script ─────────────────────────────────
step "[9/9] Installing setup-provider helper for the customer"
cat > /usr/local/bin/setup-provider <<'SETUP_PROVIDER_EOF'
#!/usr/bin/env bash
# setup-provider — Configure an AI provider for OpenClaw via a friendly prompt.
# Preserves protected gateway settings so the Web UI keeps working.
set -euo pipefail

CONFIG="$HOME/.openclaw/openclaw.json"

if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'; BLU=$'\033[0;34m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  RED=""; GRN=""; YLW=""; BLU=""; DIM=""; RST=""
fi

err()  { echo "${RED}ERROR:${RST} $*" >&2; }
warn() { echo "${YLW}WARN:${RST} $*" >&2; }
ok()   { echo "${GRN}✓${RST} $*"; }
info() { echo "${BLU}·${RST} $*"; }

command -v openclaw >/dev/null 2>&1 || { err "openclaw not installed"; exit 1; }
command -v python3  >/dev/null 2>&1 || { err "python3 required"; exit 1; }
[[ -f "$CONFIG" ]] || { err "OpenClaw not onboarded yet."; exit 1; }

cat <<'BANNER'

  ╭──────────────────────────────────────────╮
  │   OpenClaw — AI Provider Setup           │
  ╰──────────────────────────────────────────╯

BANNER

SNAPSHOT=$(python3 - "$CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
g = cfg.get("gateway", {}) or {}
auth = g.get("auth", {}) or {}
print(g.get("port") or 18789)
print(g.get("bind") or "loopback")
print(auth.get("mode") or "token")
print(auth.get("token") or "")
PY
)
mapfile -t cfg_lines <<<"$SNAPSHOT"
GW_PORT="${cfg_lines[0]}"
GW_BIND="${cfg_lines[1]}"
GW_AUTH="${cfg_lines[2]}"
GW_TOKEN="${cfg_lines[3]}"

info "Current gateway: bind=${GW_BIND} port=${GW_PORT} auth=${GW_AUTH}"
echo

echo "Choose your AI provider:"
echo "  1) Anthropic   (Claude — recommended for code / agentic work)"
echo "  2) OpenAI      (GPT-5.5)"
echo "  3) Google      (Gemini)"
echo "  4) OpenRouter  (multi-provider gateway)"
echo "  5) DeepSeek"
echo
read -rp "Enter choice [1-5]: " choice

case "$choice" in
  1) PROVIDER="Anthropic";  AUTH_CHOICE="anthropic-api-key";  KEY_FLAG="--anthropic-api-key";  KEY_URL="https://console.anthropic.com/settings/keys" ;;
  2) PROVIDER="OpenAI";     AUTH_CHOICE="openai-api-key";     KEY_FLAG="--openai-api-key";     KEY_URL="https://platform.openai.com/api-keys" ;;
  3) PROVIDER="Gemini";     AUTH_CHOICE="gemini-api-key";     KEY_FLAG="--gemini-api-key";     KEY_URL="https://aistudio.google.com/apikey" ;;
  4) PROVIDER="OpenRouter"; AUTH_CHOICE="openrouter-api-key"; KEY_FLAG="--openrouter-api-key"; KEY_URL="https://openrouter.ai/keys" ;;
  5) PROVIDER="DeepSeek";   AUTH_CHOICE="deepseek-api-key";   KEY_FLAG="--deepseek-api-key";   KEY_URL="https://platform.deepseek.com/api_keys" ;;
  *) err "Invalid choice"; exit 1 ;;
esac

echo
info "Provider: ${PROVIDER}"
info "Get an API key at: ${KEY_URL}"
echo

read -rsp "Paste your API key (input hidden, press Enter when done): " API_KEY
echo
echo

if [[ -z "${API_KEY// }" ]]; then
  err "API key cannot be empty"
  exit 1
fi

PROTECTED_BACKUP=$(python3 - "$CONFIG" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
g = c.get("gateway", {}) or {}
out = {
  "trustedProxies": g.get("trustedProxies"),
  "controlUi": g.get("controlUi"),
  "nodes_pairing": (g.get("nodes", {}) or {}).get("pairing"),
}
print(json.dumps(out))
PY
)

args=(
  --non-interactive --accept-risk
  --flow quickstart
  --auth-choice "$AUTH_CHOICE"
  "$KEY_FLAG" "$API_KEY"
  --gateway-port "$GW_PORT"
  --gateway-bind "$GW_BIND"
  --gateway-auth "$GW_AUTH"
)
if [[ -n "$GW_TOKEN" && "$GW_AUTH" == "token" ]]; then
  args+=( --gateway-token "$GW_TOKEN" )
fi

info "Applying configuration..."
if openclaw onboard "${args[@]}" >/tmp/setup-provider.log 2>&1; then
  ok "${PROVIDER} configured"
else
  err "Configuration failed. Last 10 lines of /tmp/setup-provider.log:"
  tail -10 /tmp/setup-provider.log >&2 || true
  exit 1
fi

info "Restoring template settings..."
python3 - "$CONFIG" "$PROTECTED_BACKUP" <<'PY'
import json, sys
path, backup_json = sys.argv[1], sys.argv[2]
backup = json.loads(backup_json)
c = json.load(open(path))
g = c.setdefault("gateway", {})
if backup.get("trustedProxies") is not None:
    g["trustedProxies"] = backup["trustedProxies"]
if backup.get("controlUi") is not None:
    g["controlUi"] = backup["controlUi"]
if backup.get("nodes_pairing") is not None:
    g.setdefault("nodes", {})["pairing"] = backup["nodes_pairing"]
json.dump(c, open(path, "w"), indent=2)
PY
ok "Template settings restored"

info "Restarting gateway..."
openclaw gateway restart >/dev/null 2>&1 || warn "gateway restart failed; daemon may pick up changes automatically"

echo
ok "Setup complete!"
echo "  Open the OpenClaw Control UI in your browser:"
if [[ -n "$GW_TOKEN" ]]; then
  echo "    https://<your-host>/?token=${GW_TOKEN}"
else
  echo "    https://<your-host>/"
fi
echo
SETUP_PROVIDER_EOF
chmod 755 /usr/local/bin/setup-provider
ok "/usr/local/bin/setup-provider installed"

# ─── Wait for cert ─────────────────────────────────────────────────
step "Waiting for Let's Encrypt cert (up to 60s)..."
CERT_OK=false
for i in {1..30}; do
  if echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
        | openssl x509 -noout -issuer 2>/dev/null | grep -q "Let's Encrypt"; then
    CERT_OK=true
    break
  fi
  sleep 2
done
$CERT_OK && ok "TLS cert ready" || warn "Cert not ready in 60s — check 'journalctl -u caddy' for ACME issues"

# ─── Summary ───────────────────────────────────────────────────────
cat <<EOF

  ╭────────────────────────────────────────────────────────────────╮
  │   ${GRN}🎉 OpenClaw is ready!${RST}                                       │
  ╰────────────────────────────────────────────────────────────────╯

  ${BLD}Customer URL${RST}
    ${CYN}https://${DOMAIN}/?token=${GATEWAY_TOKEN}${RST}

  ${BLD}SSH access${RST}
    ssh ${GATEWAY_USER}@${DOMAIN}
    password: ${SSH_PASSWORD}

  ${BLD}First-run step (customer)${RST}
    SSH in and run: ${DIM}setup-provider${RST}
    Choose AI provider, paste API key, done.

  ${BLD}Save these credentials NOW — they aren't stored anywhere else.${RST}

EOF
