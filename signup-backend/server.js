// server.js — Express API for the OpenClaw signup form.
const express = require('express');
const path = require('path');
const { getToken, updateToken } = require('./lib/db');
const { runInstallScript } = require('./lib/installer');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const VALID_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'deepseek',
];

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Token info — used by the form to show the customer their domain.
app.get('/api/token-info', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token required' });

  const record = getToken(token);
  if (!record) return res.status(404).json({ error: 'invalid token' });

  res.json({
    domain: record.domain,
    status: record.status,
    customerUrl: record.customer_url || null,
    error: record.error_message || null,
  });
});

// Status polling.
app.get('/api/status', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token required' });

  const record = getToken(token);
  if (!record) return res.status(404).json({ error: 'invalid token' });

  res.json({
    status: record.status,
    customerUrl: record.customer_url || null,
    error: record.error_message || null,
  });
});

// Submit provisioning. Returns immediately; the heavy work runs in the
// background and the frontend polls /api/status.
app.post('/api/provision', async (req, res) => {
  const { token, provider, apiKey, email } = req.body || {};

  if (!token || !provider || !apiKey) {
    return res.status(400).json({ error: 'token, provider, apiKey are required' });
  }
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'invalid provider' });
  }
  if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 500) {
    return res.status(400).json({ error: 'invalid apiKey' });
  }

  const record = getToken(token);
  if (!record) return res.status(404).json({ error: 'invalid token' });

  if (record.status === 'ready') {
    return res.json({ status: 'ready', url: record.customer_url });
  }
  if (record.status === 'provisioning') {
    return res.json({ status: 'provisioning' });
  }

  updateToken(token, {
    status: 'provisioning',
    customer_email: email || null,
    provider,
    error_message: null,
  });

  // Acknowledge before starting long work.
  res.json({ status: 'provisioning' });

  // Run the installer in the background.
  (async () => {
    const tag = `[${token.slice(0, 8)} ${record.domain}]`;
    console.log(`${tag} provisioning on ${record.container_ip}`);
    try {
      const { customerUrl, sshPassword, gatewayToken } = await runInstallScript({
        host: record.container_ip,
        user: record.container_user,
        domain: record.domain,
        provider,
        apiKey,
        log: (kind, text) => process.stdout.write(`${tag} ${kind === 'stderr' ? '!' : '·'} ${text}`),
      });

      if (!customerUrl) {
        throw new Error('install.sh finished but no customer URL was found in output.');
      }

      updateToken(token, {
        status: 'ready',
        customer_url: customerUrl,
        ssh_password: sshPassword,
        gateway_token: gatewayToken,
      });
      console.log(`${tag} ready: ${customerUrl}`);
    } catch (err) {
      console.error(`${tag} failed:`, err.message);
      updateToken(token, {
        status: 'failed',
        error_message: err.message.slice(0, 1000),
      });
    }
  })();
});

app.listen(PORT, HOST, () => {
  console.log(`OpenClaw signup backend listening on http://${HOST}:${PORT}`);
});
