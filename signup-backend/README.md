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

The installer:
1. installs Node 20, Caddy, Git
2. clones this repo to `/opt/openclaw-signup`
3. creates a system user `openclaw-signup`
4. generates an SSH keypair at `data/control_key`
5. installs the systemd service `openclaw-signup`
6. configures Caddy + Let's Encrypt for the signup domain
7. **prints the SSH public key** — copy it into each customer container's `/root/.ssh/authorized_keys` (or bake it into your LXC template)

## Add a customer

After preparing the customer's LXC + DNS A record + Mikrotik forward:

```bash
oc-register customer-foo.openclaw.example.com 10.0.0.12
```

Outputs a signup URL like:

```
https://signup.metaelearning.online/?token=<random>
```

Send that URL to your customer. They:
1. Open the URL in any browser
2. Pick AI provider, paste API key
3. Wait ~3 minutes
4. Get the customer URL → click → use OpenClaw

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
