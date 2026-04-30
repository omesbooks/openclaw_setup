// server.js — Express API for the OpenClaw signup form.
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { getToken, updateToken } = require('./lib/db');
const { runInstallScript } = require('./lib/installer');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const RECAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY || '';
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || '';
const RECAPTCHA_MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);

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

// ─── Rate limits ────────────────────────────────────────────────────
const provisionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 5, // 5 provision requests / IP / minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again in a minute.' },
});

const statusLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 sec
  max: 30, // generous for polling
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many status checks, slow down.' },
});

// ─── reCAPTCHA verification ─────────────────────────────────────────
async function verifyRecaptcha(captchaToken, ip) {
  if (!RECAPTCHA_SECRET) {
    return { success: true, skipped: true };
  }
  if (!captchaToken) {
    return { success: false, reason: 'missing-captcha' };
  }
  try {
    const params = new URLSearchParams({
      secret: RECAPTCHA_SECRET,
      response: captchaToken,
    });
    if (ip) params.set('remoteip', ip);

    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    const score = typeof data.score === 'number' ? data.score : 1;
    const passed = data.success === true && score >= RECAPTCHA_MIN_SCORE;
    return { success: passed, score, raw: data };
  } catch (err) {
    return { success: false, reason: 'verify-failed', error: err.message };
  }
}

// ─── Endpoints ──────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Public config — frontend reads this to know the reCAPTCHA site key.
app.get('/api/config', (_req, res) => {
  res.json({
    recaptchaSiteKey: RECAPTCHA_SITE_KEY || null,
  });
});

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
    provider: record.provider || null,
    error: record.error_message || null,
  });
});

// Status polling.
app.get('/api/status', statusLimiter, (req, res) => {
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

// Submit provisioning — works for both first-time and reprovisioning.
//
// status flow:
//   pending      → provisioning → ready/failed
//   ready/failed → provisioning → ready/failed   (re-submit allowed)
//   provisioning → 409  (already in flight)
app.post('/api/provision', provisionLimiter, async (req, res) => {
  const { token, provider, apiKey, email, captchaToken } = req.body || {};

  if (!token || !provider || !apiKey) {
    return res.status(400).json({ error: 'token, provider, apiKey are required' });
  }
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'invalid provider' });
  }
  if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 500) {
    return res.status(400).json({ error: 'invalid apiKey' });
  }

  // reCAPTCHA gate (only if configured server-side).
  const captcha = await verifyRecaptcha(captchaToken, req.ip);
  if (!captcha.success) {
    return res.status(403).json({
      error: 'captcha verification failed',
      reason: captcha.reason || `score ${captcha.score}`,
    });
  }

  const record = getToken(token);
  if (!record) return res.status(404).json({ error: 'invalid token' });

  if (record.status === 'provisioning') {
    return res.status(409).json({
      error: 'already provisioning, please wait',
      status: 'provisioning',
    });
  }

  // Allow first-time, retries (failed), and reprovisioning (ready) in one path.
  const isReprovision = record.status === 'ready';

  updateToken(token, {
    status: 'provisioning',
    customer_email: email || record.customer_email || null,
    provider,
    error_message: null,
    customer_url: null,
  });

  res.json({ status: 'provisioning', isReprovision });

  // Background work.
  (async () => {
    const tag = `[${token.slice(0, 8)} ${record.domain}]`;
    console.log(`${tag} ${isReprovision ? 're-' : ''}provisioning on ${record.container_ip}`);
    try {
      const { customerUrl, sshPassword, gatewayToken } = await runInstallScript({
        host: record.container_ip,
        user: record.container_user,
        domain: record.domain,
        provider,
        apiKey,
        log: (kind, text) =>
          process.stdout.write(`${tag} ${kind === 'stderr' ? '!' : '·'} ${text}`),
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
  if (RECAPTCHA_SECRET) {
    console.log(`reCAPTCHA enabled (min score: ${RECAPTCHA_MIN_SCORE})`);
  } else {
    console.log('reCAPTCHA disabled (set RECAPTCHA_SITE_KEY + RECAPTCHA_SECRET to enable)');
  }
});
