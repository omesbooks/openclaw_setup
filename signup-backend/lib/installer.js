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

async function runInstallScript({ host, user, domain, provider, apiKey, log }) {
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

  const cmd = [
    'curl -fsSL',
    shellEscapeSingleQuoted(INSTALL_SCRIPT_URL),
    '| bash -s --',
    '--domain', shellEscapeSingleQuoted(domain),
    '--provider', shellEscapeSingleQuoted(provider),
    '--api-key', shellEscapeSingleQuoted(apiKey),
    '--yes',
  ].join(' ');

  let stdout = '';
  let stderr = '';

  try {
    const result = await ssh.execCommand(cmd, {
      execOptions: { pty: false },
      onStdout: (chunk) => {
        const text = chunk.toString();
        stdout += text;
        log?.('stdout', text);
      },
      onStderr: (chunk) => {
        const text = chunk.toString();
        stderr += text;
        log?.('stderr', text);
      },
    });

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

module.exports = { runInstallScript };
