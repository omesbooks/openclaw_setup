# OpenClaw Signup Backend

Tiny Node.js + Express + SQLite service that powers a "1-click" signup form for OpenClaw self-host customers. Runs in its own LXC container ("control container"); SSHes into customer containers to run [`install.sh`](../install.sh).

## Architecture

```
Customer browser
        │ POST /api/provision
        ▼
control-container (this app)
   ├─ Caddy:443 → Express:3000
   ├─ SQLite (token ↔ container_ip mapping)
   └─ SSH key → customer LXCs
                        │ runs install.sh
                        ▼
            customer-N container (10.0.0.N)
            ├─ Node + openclaw + Caddy
            └─ Public: customer-N.openclaw.example.com
```

## Install on a fresh LXC

DNS A record + Mikrotik forwards (80, 443) for the signup domain need to be in place first.

```bash
ssh root@control-container "curl -fsSL \
  https://raw.githubusercontent.com/omesbooks/openclaw_setup/main/signup-backend/install-control.sh \
  | bash -s -- --domain signup.metaelearning.online --yes"
```

### With reCAPTCHA (recommended for public deployments)

Get a v3 site key + secret at <https://www.google.com/recaptcha/admin>, then:

```bash
ssh root@control-container "curl -fsSL \
  https://raw.githubusercontent.com/omesbooks/openclaw_setup/main/signup-backend/install-control.sh \
  | bash -s -- \
      --domain signup.metaelearning.online \
      --recaptcha-site-key '6Lc...' \
      --recaptcha-secret '6Lc...' \
      --yes"
```

reCAPTCHA can also be added/changed later by editing
`/etc/systemd/system/openclaw-signup.service` and restarting.

The installer:
1. installs Node 20, Caddy, Git
2. clones this repo to `/opt/openclaw-signup`
3. creates a system user `openclaw-signup`
4. generates an SSH keypair at `data/control_key`
5. installs the systemd service `openclaw-signup`
6. configures Caddy + Let's Encrypt for the signup domain
7. **prints the SSH public key** — copy it into each customer container's `/root/.ssh/authorized_keys` (or bake it into your LXC template)

## Adding a new customer container — full workflow

Each customer gets their own LXC. Steps the **operator** takes (5 minutes):

```
┌─ 1. Proxmox: clone your LXC template ─────────────────────────┐
│    → Customer container with a fresh public IP                  │
└──────────────────────────────────────────────────────────────────┘
┌─ 2. DNS: add an A record ────────────────────────────────────────┐
│    customer-N.openclaw.example.com → <public IP>                 │
└──────────────────────────────────────────────────────────────────┘
┌─ 3. Mikrotik (or your firewall): forward 22 + 80 + 443 ─────────┐
│    Public 22/80/443 → customer LXC                               │
└──────────────────────────────────────────────────────────────────┘
┌─ 4. SSH key on customer LXC ─────────────────────────────────────┐
│    Add the control container's public key to                      │
│    /root/.ssh/authorized_keys (see below).                       │
│    💡 Bake this into your LXC template once and skip every time. │
└──────────────────────────────────────────────────────────────────┘
┌─ 5. Admin dashboard → "+ Add container" ─────────────────────────┐
│    Domain + IP + SSH user → Create token → copy signup URL       │
└──────────────────────────────────────────────────────────────────┘
┌─ 6. Email the signup URL to the customer ────────────────────────┐
│    https://signup.metaelearning.online/?token=...                │
└──────────────────────────────────────────────────────────────────┘
```

The customer then clicks the URL, picks an AI provider, pastes their API key, watches the **live progress checklist**, and clicks "Open OpenClaw" when ready.

### Step 4 — installing the control public key on a customer LXC

Run **once** on each fresh customer LXC (or bake into your template):

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
cat >> /root/.ssh/authorized_keys <<'KEY'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…openclaw-signup-control
KEY
chmod 600 /root/.ssh/authorized_keys
```

Replace the placeholder line with the **actual public key** printed by `install-control.sh` at the end of installation. The control container holds the matching private key — no password is ever stored on either side.

### Step 5 — admin dashboard vs CLI

Both produce the same signup URL.

**Web (recommended):** open `https://<signup-domain>/admin`, click **"+ Add container"**, fill in:
- Domain: `customer-N.openclaw.example.com`
- Container IP: customer's public (or LAN) IP
- SSH user: `root` (default)

**CLI on the control container:**
```bash
oc-register customer-N.openclaw.example.com <ip>
```

Either way the dashboard shows the new row immediately. Use the **Copy signup URL** action to grab the link.

## What the customer sees

1. Click the signup URL.
2. Form: pick provider (Anthropic / OpenAI / Gemini / OpenRouter / DeepSeek), paste API key, optionally email.
3. Provider list now includes:
   - Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek
   - **NVIDIA Build** (presets baked in — base URL + Kimi K2 model)
   - **Custom** (any OpenAI-compatible endpoint — Together, Groq, Fireworks, Ollama, …; the form prompts for base URL + model id)
4. Live progress checklist (~14 steps, ticks one by one):
   - Connecting to your workspace
   - Installing system packages
   - Installing Node.js runtime
   - Installing OpenClaw
   - Installing web server (Caddy)
   - Setting up service user
   - Configuring OpenClaw
   - Starting OpenClaw service (≈60s)
   - Applying security settings
   - Setting up HTTPS reverse proxy
   - Installing helper scripts
   - Enabling auto-pairing
   - Applying your AI provider
   - Verifying TLS certificate
4. Click **Open OpenClaw →** when it turns into a button.
5. Browser pairs automatically within ~3 seconds (auto-pair watchdog), opens the chat UI.

If the customer wants to change provider or rotate their API key later, they reuse the same signup URL and click **"Need to change provider or API key? →"** on the success screen.

## Admin commands

```bash
# List all tokens + their status
oc-register --list

# Revoke a token (signup URL becomes invalid)
oc-register --revoke <token>
```

## Data flow

```
1. POST /api/provision
   { token, provider, apiKey, email? }

2. Lookup token in SQLite → (domain, container_ip, container_user)

3. Mark token status = 'provisioning'

4. Respond 200 immediately (frontend polls /api/status)

5. Background: SSH into container_ip, run:
   curl -fsSL .../install.sh | bash -s -- \
     --domain <domain> --provider <provider> --api-key <key> --yes

6. Parse customer URL from install output

7. Update DB: status = 'ready', customer_url = ...

8. Frontend polls /api/status, sees 'ready', shows the URL.
```

## Environment variables

| Var | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express port |
| `HOST` | `127.0.0.1` | Bind address (Caddy fronts public) |
| `DB_PATH` | `data/tokens.db` | SQLite file |
| `SSH_KEY_PATH` | `data/control_key` | Private key for outbound SSH |
| `INSTALL_SCRIPT_URL` | GitHub raw URL of `install.sh` | What gets piped to bash on customer containers |
| `SIGNUP_BASE_URL` | `https://signup.metaelearning.online` | Used by `oc-register` to build the URL it prints |
| `RECAPTCHA_SITE_KEY` | _(empty)_ | Google reCAPTCHA v3 site key (frontend) |
| `RECAPTCHA_SECRET` | _(empty)_ | reCAPTCHA secret (server-side verify). If empty, reCAPTCHA is disabled. |
| `RECAPTCHA_MIN_SCORE` | `0.5` | Minimum reCAPTCHA score to allow (0.0–1.0) |
| `ADMIN_USER` | `admin` | Username for the admin dashboard (Basic auth) |
| `ADMIN_PASSWORD` | _(empty)_ | Password for the admin dashboard. If empty, `/admin` is disabled. |

## Admin dashboard

`GET /admin` — Basic auth, listing every registered token + status + actions.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/tokens` | List every registered token + status |
| `POST` | `/api/admin/tokens` | Create a new token (body: `{domain, containerIp, containerUser?}`) |
| `DELETE` | `/api/admin/tokens/:token` | Revoke a token (LXC is **not** touched) |
| `POST` | `/api/admin/tokens/:token/reset` | Reset status to `pending` so the form can be reused |
| `GET` | `/api/admin/tokens/:token/liveness` | Server-side probe of the customer's `/healthz` |

All admin endpoints require Basic auth using `ADMIN_USER` + `ADMIN_PASSWORD`.

## Rate limits

- `POST /api/provision` — 5 / IP / minute
- `GET  /api/status`    — 30 / IP / 10 seconds (generous for polling)

Adjust in `server.js` if needed.

## Reprovisioning ("reset")

Customers can change their AI provider/key without operator help:

1. On the success screen, click "Need to change provider or API key? →"
2. Confirm the prompt (warns the existing URL will stop working)
3. Pick a new provider, paste a new key
4. The same token is reused; `install.sh` runs again on the same container,
   which generates a fresh gateway token + URL.

State machine:
```
pending      → provisioning → ready / failed
ready/failed → provisioning → ready / failed   (reprovision allowed)
provisioning → 409 conflict                      (already in flight)
```

## Logs

```bash
journalctl -u openclaw-signup -f
journalctl -u caddy -f
```

## Security notes

- The signup token is the access credential — anyone with the URL can configure that one container, exactly once.
- API keys never touch the SQLite DB; they're passed straight to `install.sh` over SSH.
- The control container holds an SSH key with root access to every customer container — back it up encrypted, rotate periodically.
- `data/` is `chmod 700` and owned by the `openclaw-signup` system user.

## Local dev

```bash
cd signup-backend
npm install
DB_PATH=./tmp.db SSH_KEY_PATH=~/.ssh/id_ed25519 node server.js
# in another terminal
npm run register -- customer-test.example.com 10.0.0.12
# open http://127.0.0.1:3000/?token=<token>
```
