// lib/installer.js — SSH into a customer container and run install.sh.
const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const path = require('path');

const SSH_KEY_PATH =
  process.env.SSH_KEY_PATH ||
  path.join(__dirname, '..', 'data', 'control_key');

const INSTALL_SCRIPT_URL =
  process.env.INSTALL_SCRIPT_URL ||
  'https://raw.githubusercontent.com/omesbooks/openclaw_setup/main/install.sh';

// Strip ANSI escape codes so we can reliably regex over openclaw's output.
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function shellEscapeSingleQuoted(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// User-facing checklist entries, in display order. Each `trigger` regex
// matches a line in install.sh's stdout that signals the step has STARTED.
// The list is also exposed to the frontend so the UI can render every step
// (including future ones) up front.
const PROGRESS_STEPS = [
  { name: 'Connecting to your workspace',         trigger: /\[installer\] curl missing|=== install plan|^Installing system dependencies/i },
  { name: 'Installing system packages',           trigger: /\[1\/9\] Installing system dependencies/ },
  { name: 'Installing Node.js runtime',           trigger: /\[2\/9\] Installing Node\.js/ },
  { name: 'Installing OpenClaw',                  trigger: /\[3\/9\] Installing OpenClaw/ },
  { name: 'Installing web server (Caddy)',        trigger: /\[4\/9\] Installing Caddy/ },
  { name: 'Setting up service user',              trigger: /\[5\/9\] Setting up user/ },
  { name: 'Configuring OpenClaw',                 trigger: /\[6\/9\] Onboarding/ },
  { name: 'Starting OpenClaw service (≈60s)',     trigger: /Waiting for gateway port/ },
  { name: 'Applying security settings',           trigger: /\[7\/9\] Patching gateway config/ },
  { name: 'Setting up HTTPS reverse proxy',       trigger: /\[8\/9\] Configuring Caddy/ },
  { name: 'Installing helper scripts',            trigger: /\[9\/9\] Installing setup-provider/ },
  { name: 'Enabling auto-pairing',                trigger: /auto-pair watchdog enabled/i },
  { name: 'Applying your AI provider',            trigger: /\[10\] Configuring AI provider/ },
  { name: 'Verifying TLS certificate',            trigger: /Waiting for Let's Encrypt cert/ },
];

function detectStep(line) {
  for (const s of PROGRESS_STEPS) {
    if (s.trigger.test(line)) return s.name;
  }
  return null;
}

async function runInstallScript({ host, user, domain, provider, apiKey, log, onProgress }) {
  if (!fs.existsSync(SSH_KEY_PATH)) {
    throw new Error(
      `SSH private key not found at ${SSH_KEY_PATH}. Generate it with ssh-keygen.`
    );
  }
  const privateKey = fs.readFileSync(SSH_KEY_PATH, 'utf8');

  const ssh = new NodeSSH();
  await ssh.connect({
    host,
    username: user,
    privateKey,
    readyTimeout: 30000,
    keepaliveInterval: 10000,
  });

  // Bootstrap curl if the customer container is too minimal to have it.
  // (Common on slim Ubuntu LXC templates.) Runs as root via the SSH session.
  const fetchCmd = [
    'curl -fsSL',
    shellEscapeSingleQuoted(INSTALL_SCRIPT_URL),
    '| bash -s --',
    '--domain', shellEscapeSingleQuoted(domain),
    '--provider', shellEscapeSingleQuoted(provider),
    '--api-key', shellEscapeSingleQuoted(apiKey),
    '--yes',
  ].join(' ');

  const cmd = `set -e
if ! command -v curl >/dev/null 2>&1; then
  echo "[installer] curl missing, installing..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates
fi
${fetchCmd}`;

  let stdout = '';
  let stderr = '';
  let stdoutBuffer = '';
  const stepsReached = [];
  const seenSteps = new Set();

  function ingestLine(line) {
    const cleaned = stripAnsi(line);
    const stepName = detectStep(cleaned);
    if (stepName && !seenSteps.has(stepName)) {
      seenSteps.add(stepName);
      stepsReached.push(stepName);
      onProgress?.({ stepsReached: [...stepsReached], currentStep: stepName });
    }
  }

  try {
    const result = await ssh.execCommand(cmd, {
      execOptions: { pty: false },
      onStdout: (chunk) => {
        const text = chunk.toString();
        stdout += text;
        // Process by lines so we don't miss a step boundary that lands mid-chunk.
        stdoutBuffer += text;
        let idx;
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          ingestLine(stdoutBuffer.slice(0, idx));
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
        }
        log?.('stdout', text);
      },
      onStderr: (chunk) => {
        const text = chunk.toString();
        stderr += text;
        log?.('stderr', text);
      },
    });
    if (stdoutBuffer) ingestLine(stdoutBuffer);

    if (result.code !== 0) {
      const tail = stripAnsi((stderr || stdout)).split('\n').slice(-15).join('\n');
      throw new Error(`install.sh exited ${result.code}\n${tail}`);
    }
  } finally {
    ssh.dispose();
  }

  // Parse credentials from the installer's summary block.
  const cleaned = stripAnsi(stdout);
  const customerUrl = (cleaned.match(/https:\/\/\S+\?token=[a-f0-9]+/i) || [])[0] || null;
  const sshPassword = (cleaned.match(/SSH password\s+(\S+)/i) || [])[1] || null;
  const gatewayToken = customerUrl
    ? (customerUrl.match(/token=([a-f0-9]+)/i) || [])[1] || null
    : null;

  return { customerUrl, sshPassword, gatewayToken, output: cleaned };
}

module.exports = {
  runInstallScript,
  PROGRESS_STEPS: PROGRESS_STEPS.map((s) => s.name),
};
