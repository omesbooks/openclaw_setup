# OpenClaw 1-Click Self-Host Installer

A single-script installer that turns a fresh Ubuntu 22.04 container into a customer-ready, HTTPS-enabled OpenClaw deployment with **zero browser friction**: no auth dialog, no device pairing, no manual config — the customer clicks the URL and lands on the chat UI.

## What you get

```
Browser ──HTTPS──▶ Caddy:443 ──HTTP──▶ openclaw:18789 (loopback)
                       │                      │
                       │                      ├ token auth
                       │                      └ autoApproveCidrs: 0.0.0.0/0
                       └ Let's Encrypt cert (auto-renew)
```

- **Caddy** terminates TLS with an automatic Let's Encrypt cert
- **OpenClaw gateway** runs as a `systemd --user` service with `linger` enabled (survives logout, auto-restarts on boot)
- **Auto-approve pairing** (`gateway.nodes.pairing.autoApproveCidrs = ["0.0.0.0/0", "::/0"]`) — every browser/device works on first connect
- **`setup-provider`** helper script (installed at `/usr/local/bin/setup-provider`) lets the customer add their AI API key in one prompt-driven step

## Prerequisites

Before running the installer, make sure:

1. A fresh **Ubuntu 22.04** LXC/VM with **root SSH access**
2. **DNS A record** for the domain pointing to the host's public IP (e.g. `customer-01.openclaw.example.com → 1.2.3.4`)
3. Ports **22, 80, 443** reachable from the internet (for SSH and Let's Encrypt HTTP-01 challenge)

## Usage

### Full 1-click — customer just opens the URL (recommended)

```bash
ssh root@new-host "curl -fsSL https://raw.githubusercontent.com/omesbooks/openclaw_setup/main/install.sh \
  | bash -s -- \
      --domain customer-01.openclaw.example.com \
      --provider anthropic \
      --api-key sk-ant-xxxxx \
      --yes"
```

The installer prints `Customer URL` at the end — that's all the customer needs. They click → chat works immediately, no SSH required.

### Infrastructure only (customer adds their own key later)

```bash
ssh root@new-host "curl -fsSL https://raw.githubusercontent.com/omesbooks/openclaw_setup/main/install.sh \
  | bash -s -- --domain customer-01.openclaw.example.com --yes"
```

Customer SSHes in once and runs `setup-provider` to add their key.

### Interactive (prompts for everything)

```bash
ssh root@new-host
curl -fsSL https://raw.githubusercontent.com/omesbooks/openclaw_setup/main/install.sh | bash
```

### Pin a version (recommended for production)

```bash
curl -fsSL https://raw.githubusercontent.com/omesbooks/openclaw_setup/v1.1.0/install.sh \
  | bash -s -- --domain xxx --provider anthropic --api-key sk-ant-... --yes
```

## Options

| Flag | Default | Description |
|---|---|---|
| `--domain <name>` | _(prompted)_ | Domain for this instance |
| `--user <name>` | `testuser` | Linux + Gateway user |
| `--password <pw>` | _(random)_ | SSH password |
| `--provider <name>` | _(skipped)_ | AI provider: `anthropic` \| `openai` \| `gemini` \| `openrouter` \| `deepseek` |
| `--api-key <key>` | _(skipped)_ | API key for `--provider` |
| `--yes`, `-y` | _off_ | Skip confirm prompts |
| `-h`, `--help` | | Show help |

`--provider` and `--api-key` must be given together. If both are given, the AI provider is configured during install and chat works immediately on the customer's first visit.

## What the installer does

1. Installs system deps (curl, ca-cert, gnupg, python3)
2. Installs Node.js 24 via NodeSource
3. Installs OpenClaw via the official `install.sh`
4. Installs Caddy via the official Cloudsmith repo
5. Creates the Linux user, sets password, enables systemd `linger`
6. Runs `openclaw onboard --install-daemon --auth-choice skip` with a freshly generated gateway token
7. Patches `~/.openclaw/openclaw.json`:
   - `gateway.trustedProxies = ["127.0.0.1", "::1"]`
   - `gateway.controlUi.allowedOrigins = ["https://<domain>"]`
   - `gateway.nodes.pairing.autoApproveCidrs = ["0.0.0.0/0", "::/0"]`
8. Writes `/etc/caddy/Caddyfile` reverse-proxying `<domain>` → `127.0.0.1:18789`
9. Embeds `/usr/local/bin/setup-provider` for the customer to add their AI key
10. Waits for the Let's Encrypt cert to be issued and verifies TLS
11. Prints the customer-facing credentials

## Customer onboarding

After provisioning, send the customer:

```
Web UI:   https://<domain>/?token=<gateway-token>
SSH:      ssh <user>@<domain>
Password: <ssh-password>

First run:
1. SSH in
2. Run: setup-provider
3. Pick provider (Anthropic / OpenAI / Gemini / OpenRouter / DeepSeek)
4. Paste your API key
5. Open the Web UI URL — chat works.
```

## Updating an existing instance

Re-run `install.sh` on the same host with the same `--domain`. The script is idempotent (skips installs that exist) but it **will reset** the gateway token and SSH password — only re-run when you want to rotate credentials.

## Security notes

- The gateway token in the URL is the access credential. Treat it like a password.
- Anyone with the URL can use the instance; share the URL via a secure channel.
- API costs are billed to whoever's API key is set via `setup-provider` (BYOK by design).
- For higher-trust setups consider Tailscale Serve or a Caddy `forward_auth` upgrade — see `docs.openclaw.ai`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Let's Encrypt validation failed` | Port 80 not reachable, or DNS doesn't match host | Open port 80, verify `dig +short <domain>` |
| `Browser shows "secure context required"` | Connecting via plain HTTP | Use the `https://` URL |
| `device pairing required` | `autoApproveCidrs` got reset | Re-run `setup-provider` (auto-restores) or apply the patch in step 7 manually |
| `gateway 401 unauthorized` from CLI | CLI doesn't know the token | `openclaw gateway status` reads `~/.openclaw/openclaw.json` automatically — make sure you're the right user |

## License

MIT
