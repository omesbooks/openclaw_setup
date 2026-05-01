#!/usr/bin/env bash
# install-openclaw.sh — One-click OpenClaw self-host installer
#
# Usage (interactive — prompts for inputs):
#   sudo bash install-openclaw.sh
#
# Usage (non-interactive, infrastructure only — customer adds API key later):
#   sudo bash install-openclaw.sh --domain customer-01.example.com --yes
#
# Usage (full 1-click — installs everything INCLUDING the customer's AI provider):
#   sudo bash install-openclaw.sh \
#     --domain customer-01.example.com \
#     --provider anthropic \
#     --api-key sk-ant-xxxxx \
#     --yes
#
# Result: HTTPS-enabled OpenClaw — customer just clicks the URL, no SSH needed.

set -euo pipefail

# ─── Globals ───────────────────────────────────────────────────────
DOMAIN=""
GATEWAY_USER=""
SSH_PASSWORD=""
PROVIDER=""
API_KEY=""
CUSTOM_BASE_URL=""
CUSTOM_MODEL_ID=""
ASSUME_YES=false

# Built-in presets for OpenAI-compatible custom providers.
# Mapped onto openclaw's --auth-choice custom-api-key + --custom-base-url + --custom-model-id.
NVIDIA_BASE_URL="https://integrate.api.nvidia.com/v1"
NVIDIA_DEFAULT_MODEL="moonshotai/kimi-k2-instruct"

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
  --domain <name>           Domain for this instance (e.g. customer-01.example.com)
  --user <name>             Gateway/SSH user (default: testuser)
  --password <pw>           SSH password (default: random)
  --provider <name>         AI provider:
                              anthropic | openai | gemini | openrouter | deepseek
                              nvidia   (NVIDIA Build — OpenAI-compatible, presets baked in)
                              custom   (any OpenAI-compatible endpoint)
  --api-key <key>           AI provider API key (used with --provider)
  --custom-base-url <url>   Required if --provider=custom; optional override for nvidia
  --custom-model-id <id>    Model id (default for nvidia: moonshotai/kimi-k2-instruct;
                            required for --provider=custom)
  --yes                     Skip all confirm prompts
  -h, --help                Show this help

If --provider and --api-key are both given, the AI provider is configured
during install — the customer just clicks the URL, no SSH needed.

DNS A record for <domain> must already point to this host.
Ports 22, 80, 443 must be reachable from the internet.
EOF
}

# ─── Args ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)           DOMAIN="$2"; shift 2 ;;
    --user)             GATEWAY_USER="$2"; shift 2 ;;
    --password)         SSH_PASSWORD="$2"; shift 2 ;;
    --provider)         PROVIDER="$2"; shift 2 ;;
    --api-key)          API_KEY="$2"; shift 2 ;;
    --custom-base-url)  CUSTOM_BASE_URL="$2"; shift 2 ;;
    --custom-model-id)  CUSTOM_MODEL_ID="$2"; shift 2 ;;
    --yes|-y)           ASSUME_YES=true; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  err "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Validate provider/key combo
if [[ -n "$PROVIDER" && -z "$API_KEY" ]] || [[ -z "$PROVIDER" && -n "$API_KEY" ]]; then
  err "Both --provider and --api-key must be given together"
  usage; exit 1
fi
case "${PROVIDER,,}" in
  ""|anthropic|openai|gemini|openrouter|deepseek|nvidia|custom) ;;
  *) err "Unknown --provider '$PROVIDER' (must be one of: anthropic, openai, gemini, openrouter, deepseek, nvidia, custom)"; exit 1 ;;
esac
PROVIDER="${PROVIDER,,}"

# nvidia: backfill defaults
if [[ "$PROVIDER" == "nvidia" ]]; then
  CUSTOM_BASE_URL="${CUSTOM_BASE_URL:-$NVIDIA_BASE_URL}"
  CUSTOM_MODEL_ID="${CUSTOM_MODEL_ID:-$NVIDIA_DEFAULT_MODEL}"
fi
# custom: both base URL and model id are required
if [[ "$PROVIDER" == "custom" ]]; then
  [[ -z "$CUSTOM_BASE_URL" ]] && { err "--custom-base-url is required when --provider=custom"; exit 1; }
  [[ -z "$CUSTOM_MODEL_ID" ]] && { err "--custom-model-id is required when --provider=custom"; exit 1; }
fi

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
  AI provider   : ${PROVIDER:-(skipped — customer will set via setup-provider)}
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

# ─── Step 5: gateway user + sudoers entry ──────────────────────────
step "[5/9] Setting up user $GATEWAY_USER"
if ! id "$GATEWAY_USER" >/dev/null 2>&1; then
  adduser --gecos "" --disabled-password "$GATEWAY_USER" >/dev/null
  usermod -aG sudo "$GATEWAY_USER"
fi
echo "$GATEWAY_USER:$SSH_PASSWORD" | chpasswd
# Allow the gateway user to restart the system openclaw-gateway service without
# password (so setup-provider can apply provider changes).
cat > /etc/sudoers.d/openclaw-gateway <<EOF
${GATEWAY_USER} ALL=(root) NOPASSWD: /bin/systemctl restart openclaw-gateway, /bin/systemctl status openclaw-gateway, /bin/systemctl is-active openclaw-gateway
EOF
chmod 440 /etc/sudoers.d/openclaw-gateway
ok "user ready, sudoers configured"

# ─── Step 6: openclaw onboard (writes ~/.openclaw/openclaw.json) ───
step "[6/9] Onboarding OpenClaw"
# We deliberately skip --install-daemon: openclaw's systemd-user installer
# is fragile inside LXC containers (DBUS/XDG_RUNTIME_DIR aren't always set up).
# We install a plain SYSTEM systemd unit ourselves below, which is bulletproof.
sudo -u "$GATEWAY_USER" -i bash <<EOF >/tmp/install-onboard.log 2>&1
  openclaw onboard --non-interactive --accept-risk \
    --flow quickstart --auth-choice skip \
    --gateway-bind loopback --gateway-port 18789 \
    --gateway-auth token --gateway-token "$GATEWAY_TOKEN" --skip-health
EOF
ok "onboarded"

# Install a system-level systemd unit that runs the gateway as $GATEWAY_USER.
# This bypasses the user-systemd quirks in unprivileged Proxmox LXC.
cat > /etc/systemd/system/openclaw-gateway.service <<EOF
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${GATEWAY_USER}
Group=${GATEWAY_USER}
WorkingDirectory=/home/${GATEWAY_USER}
Environment=HOME=/home/${GATEWAY_USER}
Environment=OPENCLAW_GATEWAY_PORT=18789
ExecStart=/usr/bin/openclaw gateway run
Restart=always
RestartSec=5
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable openclaw-gateway >/dev/null 2>&1 || true
systemctl restart openclaw-gateway

# Wait for the gateway to be reachable. First-run installs bundled runtime
# deps (acpx, browser, bonjour, …) which can take 60-90s.
info "Waiting for gateway port 18789 (up to 180s, first run installs deps)..."
GATEWAY_READY=false
for i in {1..90}; do
  if (echo > /dev/tcp/127.0.0.1/18789) >/dev/null 2>&1; then
    GATEWAY_READY=true
    break
  fi
  sleep 2
done
$GATEWAY_READY && ok "gateway listening on :18789" || warn "gateway not reachable yet — continuing anyway"

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
systemctl restart openclaw-gateway
# Wait again — restart triggers config reload but no extra dep install this time.
for i in {1..30}; do
  (echo > /dev/tcp/127.0.0.1/18789) >/dev/null 2>&1 && break
  sleep 1
done
ok "config patched + gateway restarted"

# ─── Step 8: Caddy config ──────────────────────────────────────────
step "[8/9] Configuring Caddy reverse proxy"
# (Access logs go to systemd journal automatically — no file path needed.
# A file path under /var/log/caddy fights with Caddy's systemd hardening
# on some images and causes reload to hang.)
cat > /etc/caddy/Caddyfile <<EOF
{
    servers {
        protocols h1 h2
    }
}

$DOMAIN {
    reverse_proxy 127.0.0.1:18789
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || fatal "Caddyfile invalid"
systemctl reload caddy
ok "Caddy reloaded (Let's Encrypt cert in flight)"

# ─── Auto-pair watchdog ────────────────────────────────────────────
# OpenClaw 2026.4.27 restricts autoApproveCidrs to role=node connections,
# so browsers (role=operator + isControlUi/isWebchat) always require manual
# pairing approval. We work around this by running a small daemon as the
# gateway user that polls `openclaw devices list` every few seconds and
# approves any pending request automatically.
cat > /usr/local/bin/openclaw-auto-pair <<'WATCHDOG_EOF'
#!/usr/bin/env bash
# Auto-approve any pending device pairing request.
# Runs as the gateway user. Polls every WATCHDOG_INTERVAL seconds (default 15).
# Each `openclaw devices list` call spawns a Node.js process and opens a WS
# session, so 3s polling can saturate small LXCs. 15s is a good balance
# between pairing UX (~15s wait on first connect) and CPU load.
set +e
export HOME="${HOME:-/home/$(id -un)}"
INTERVAL="${WATCHDOG_INTERVAL:-15}"

while true; do
  PENDING_IDS=$(openclaw devices list 2>/dev/null | awk '
    /^Paired/   { in_pending = 0 }
    in_pending && /^│ [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ { print $2 }
    /^Pending/  { in_pending = 1 }
  ')
  for REQ_ID in $PENDING_IDS; do
    [[ -n "$REQ_ID" ]] && openclaw devices approve "$REQ_ID" >/dev/null 2>&1 && \
      echo "[auto-pair] approved $REQ_ID"
  done
  sleep "$INTERVAL"
done
WATCHDOG_EOF
chmod 755 /usr/local/bin/openclaw-auto-pair

cat > /etc/systemd/system/openclaw-auto-pair.service <<EOF
[Unit]
Description=OpenClaw auto-approve pending device pairings
After=openclaw-gateway.service
Requires=openclaw-gateway.service

[Service]
Type=simple
User=${GATEWAY_USER}
Group=${GATEWAY_USER}
Environment=HOME=/home/${GATEWAY_USER}
ExecStart=/usr/local/bin/openclaw-auto-pair
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable openclaw-auto-pair >/dev/null 2>&1 || true
systemctl restart openclaw-auto-pair
ok "auto-pair watchdog enabled"

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
echo "  2) OpenAI      (GPT)"
echo "  3) Google      (Gemini)"
echo "  4) OpenRouter  (multi-provider gateway)"
echo "  5) DeepSeek"
echo "  6) NVIDIA      (NVIDIA Build — Kimi K2, Llama, DeepSeek-V3, …)"
echo "  7) Custom      (any OpenAI-compatible endpoint — Together, Groq, Ollama, …)"
echo
read -rp "Enter choice [1-7]: " choice

CUSTOM_BASE_URL=""
CUSTOM_MODEL_ID=""

case "$choice" in
  1) PROVIDER="Anthropic";  AUTH_CHOICE="anthropic-api-key";  KEY_FLAG="--anthropic-api-key";  KEY_URL="https://console.anthropic.com/settings/keys" ;;
  2) PROVIDER="OpenAI";     AUTH_CHOICE="openai-api-key";     KEY_FLAG="--openai-api-key";     KEY_URL="https://platform.openai.com/api-keys" ;;
  3) PROVIDER="Gemini";     AUTH_CHOICE="gemini-api-key";     KEY_FLAG="--gemini-api-key";     KEY_URL="https://aistudio.google.com/apikey" ;;
  4) PROVIDER="OpenRouter"; AUTH_CHOICE="openrouter-api-key"; KEY_FLAG="--openrouter-api-key"; KEY_URL="https://openrouter.ai/keys" ;;
  5) PROVIDER="DeepSeek";   AUTH_CHOICE="deepseek-api-key";   KEY_FLAG="--deepseek-api-key";   KEY_URL="https://platform.deepseek.com/api_keys" ;;
  6) PROVIDER="NVIDIA Build"
     AUTH_CHOICE="custom-api-key"
     KEY_FLAG="--custom-api-key"
     KEY_URL="https://build.nvidia.com/ — sign in, copy nvapi-… key"
     CUSTOM_BASE_URL="https://integrate.api.nvidia.com/v1"
     CUSTOM_MODEL_ID="moonshotai/kimi-k2-instruct"
     ;;
  7) PROVIDER="Custom (OpenAI-compatible)"
     AUTH_CHOICE="custom-api-key"
     KEY_FLAG="--custom-api-key"
     KEY_URL="<your provider's docs>"
     read -rp "Base URL (e.g. https://api.together.xyz/v1): " CUSTOM_BASE_URL
     read -rp "Model id (e.g. meta-llama/Llama-3.3-70B-Instruct-Turbo): " CUSTOM_MODEL_ID
     [[ -z "$CUSTOM_BASE_URL" || -z "$CUSTOM_MODEL_ID" ]] && { err "Base URL and Model id are required"; exit 1; }
     ;;
  *) err "Invalid choice"; exit 1 ;;
esac

echo
info "Provider: ${PROVIDER}"
info "Get an API key at: ${KEY_URL}"
[[ -n "$CUSTOM_BASE_URL" ]] && info "Base URL : ${CUSTOM_BASE_URL}"
[[ -n "$CUSTOM_MODEL_ID" ]] && info "Model    : ${CUSTOM_MODEL_ID}"
echo

if [[ "$choice" == "6" ]]; then
  read -rp "Override default model? [enter to keep ${CUSTOM_MODEL_ID}]: " override
  [[ -n "$override" ]] && CUSTOM_MODEL_ID="$override"
fi

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
if [[ "$AUTH_CHOICE" == "custom-api-key" ]]; then
  args+=( --custom-base-url "$CUSTOM_BASE_URL" --custom-model-id "$CUSTOM_MODEL_ID" --custom-compatibility openai )
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
sudo systemctl restart openclaw-gateway 2>/dev/null \
  || openclaw gateway restart >/dev/null 2>&1 \
  || warn "gateway restart failed; service may pick up changes automatically"

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

# ─── Optional Step 10: configure AI provider ───────────────────────
if [[ -n "$PROVIDER" && -n "$API_KEY" ]]; then
  step "[10] Configuring AI provider ($PROVIDER)"

  case "$PROVIDER" in
    anthropic)        AUTH_CHOICE="anthropic-api-key";  KEY_FLAG="--anthropic-api-key" ;;
    openai)           AUTH_CHOICE="openai-api-key";     KEY_FLAG="--openai-api-key" ;;
    gemini)           AUTH_CHOICE="gemini-api-key";     KEY_FLAG="--gemini-api-key" ;;
    openrouter)       AUTH_CHOICE="openrouter-api-key"; KEY_FLAG="--openrouter-api-key" ;;
    deepseek)         AUTH_CHOICE="deepseek-api-key";   KEY_FLAG="--deepseek-api-key" ;;
    nvidia|custom)    AUTH_CHOICE="custom-api-key";     KEY_FLAG="--custom-api-key" ;;
  esac

  # snapshot protected fields before re-running onboard
  PROTECTED_BACKUP=$(sudo -u "$GATEWAY_USER" python3 - "/home/$GATEWAY_USER/.openclaw/openclaw.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
g = c.get("gateway", {}) or {}
print(json.dumps({
  "trustedProxies": g.get("trustedProxies"),
  "controlUi": g.get("controlUi"),
  "nodes_pairing": (g.get("nodes", {}) or {}).get("pairing"),
}))
PY
)

  EXTRA_FLAGS=""
  if [[ "$AUTH_CHOICE" == "custom-api-key" ]]; then
    EXTRA_FLAGS="--custom-base-url '$CUSTOM_BASE_URL' --custom-model-id '$CUSTOM_MODEL_ID' --custom-compatibility openai"
  fi

  set +e
  sudo -u "$GATEWAY_USER" -i bash <<EOF >/tmp/install-provider.log 2>&1
openclaw onboard --non-interactive --accept-risk --flow quickstart \
  --auth-choice "$AUTH_CHOICE" "$KEY_FLAG" '$API_KEY' $EXTRA_FLAGS \
  --gateway-port 18789 --gateway-bind loopback \
  --gateway-auth token --gateway-token "$GATEWAY_TOKEN" --skip-health
EOF
  PROVIDER_RC=$?
  set -e
  if [[ $PROVIDER_RC -ne 0 ]]; then
    warn "provider config returned exit $PROVIDER_RC — see /tmp/install-provider.log"
    tail -10 /tmp/install-provider.log >&2 || true
  fi

  # restore protected fields
  sudo -u "$GATEWAY_USER" python3 - "/home/$GATEWAY_USER/.openclaw/openclaw.json" "$PROTECTED_BACKUP" <<'PY'
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

  systemctl restart openclaw-gateway
  for i in {1..30}; do
    (echo > /dev/tcp/127.0.0.1/18789) >/dev/null 2>&1 && break
    sleep 1
  done
  ok "AI provider $PROVIDER configured"
fi

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
echo
echo "  ╭────────────────────────────────────────────────────────────────╮"
echo "  │   ${GRN}🎉 OpenClaw is ready!${RST}                                       │"
echo "  ╰────────────────────────────────────────────────────────────────╯"
echo
echo "  ${BLD}Customer URL${RST}"
echo "    ${CYN}https://${DOMAIN}/?token=${GATEWAY_TOKEN}${RST}"
echo
if [[ -n "$PROVIDER" ]]; then
  echo "  ${BLD}AI provider${RST}      $PROVIDER (configured — chat works immediately)"
  echo
  echo "  ${BLD}Customer flow${RST}    Click the URL above. That's it."
else
  echo "  ${BLD}First-run step (customer)${RST}"
  echo "    SSH in and run: ${DIM}setup-provider${RST}"
  echo "    Choose AI provider, paste API key, done."
fi
echo
echo "  ${BLD}SSH access${RST}       ssh ${GATEWAY_USER}@${DOMAIN}"
echo "  ${BLD}SSH password${RST}     ${SSH_PASSWORD}"
echo
echo "  ${BLD}Save these credentials NOW — they aren't stored anywhere else.${RST}"
echo
