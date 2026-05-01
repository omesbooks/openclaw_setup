// server.js — Express API for the OpenClaw signup form.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const {
  getToken,
  updateToken,
  listTokens,
  createToken,
  deleteToken,
} = require('./lib/db');
const { runInstallScript, PROGRESS_STEPS } = require('./lib/installer');

// Per-token live progress (kept in memory; survives polling but not restart).
// { token: { current: string|null, completed: string[], finishedAt?: number } }
const progressMap = new Map();
function setProgress(token, value) {
  progressMap.set(token, value);
}
function getProgress(token) {
  return progressMap.get(token) || null;
}
// Sweep entries 30 minutes after they finish.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [token, p] of progressMap.entries()) {
    if (p.finishedAt && p.finishedAt < cutoff) progressMap.delete(token);
  }
}, 5 * 60 * 1000).unref();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const RECAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY || '';
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || '';
const RECAPTCHA_MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_ENABLED = ADMIN_PASSWORD.length > 0;

const SIGNUP_BASE_URL =
  process.env.SIGNUP_BASE_URL || 'https://signup.metaelearning.online';

const VALID_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'deepseek',
  'nvidia',  // OpenAI-compatible preset (NVIDIA Build)
  'custom',  // any OpenAI-compatible endpoint, requires customBaseUrl + customModelId
];

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_DEFAULT_MODEL = 'moonshotai/kimi-k2-instruct';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

// ─── Admin auth helpers (used by gated routes below; must be defined
//     before app.use(express.static) so /admin.* gated routes match first) ──
function safeEqual(a, b) {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_ENABLED) {
    return res.status(503).json({
      error: 'Admin disabled. Set ADMIN_PASSWORD env to enable.',
    });
  }
  const auth = req.headers.authorization || '';
  const send401 = () => {
    res.set('WWW-Authenticate', 'Basic realm="OpenClaw Admin"');
    return res.status(401).end();
  };
  if (!auth.startsWith('Basic ')) return send401();

  let user, pass;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return send401();
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch {
    return send401();
  }

  if (!safeEqual(user, ADMIN_USER) || !safeEqual(pass, ADMIN_PASSWORD)) {
    return send401();
  }
  next();
}

// ─── Admin assets (gated, registered BEFORE express.static so static
//     never serves them anonymously). ─────────────────────────────────
app.get('/admin', requireAdmin, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
app.get('/admin.js', requireAdmin, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.js'))
);
app.get('/admin.css', requireAdmin, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.css'))
);

// ─── Public static (everything else in /public) ─────────────────────
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Customer form at "/" (public).
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

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

// Public config — frontend reads this to know the reCAPTCHA site key
// and the full ordered list of progress steps it should render up front.
app.get('/api/config', (_req, res) => {
  res.json({
    recaptchaSiteKey: RECAPTCHA_SITE_KEY || null,
    progressSteps: PROGRESS_STEPS,
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
    progress: getProgress(token),
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
  let { customBaseUrl, customModelId } = req.body || {};

  if (!token || !provider || !apiKey) {
    return res.status(400).json({ error: 'token, provider, apiKey are required' });
  }
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'invalid provider' });
  }
  if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 500) {
    return res.status(400).json({ error: 'invalid apiKey' });
  }

  // NVIDIA: backfill defaults so the customer can omit base URL / model.
  if (provider === 'nvidia') {
    customBaseUrl = customBaseUrl || NVIDIA_BASE_URL;
    customModelId = customModelId || NVIDIA_DEFAULT_MODEL;
  }
  // Custom: require both base URL + model id.
  if (provider === 'custom') {
    if (!customBaseUrl || !customModelId) {
      return res.status(400).json({ error: 'customBaseUrl and customModelId are required for custom provider' });
    }
  }
  // Sanity-check URL + model values (length + simple charset).
  if (customBaseUrl && (customBaseUrl.length > 500 || !/^https?:\/\//i.test(customBaseUrl))) {
    return res.status(400).json({ error: 'invalid customBaseUrl' });
  }
  if (customModelId && (customModelId.length > 200 || !/^[a-zA-Z0-9._\-/:]+$/.test(customModelId))) {
    return res.status(400).json({ error: 'invalid customModelId' });
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

  // Reset live progress for this token.
  setProgress(token, { current: null, completed: [] });

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
        customBaseUrl,
        customModelId,
        log: (kind, text) =>
          process.stdout.write(`${tag} ${kind === 'stderr' ? '!' : '·'} ${text}`),
        onProgress: ({ stepsReached, currentStep }) => {
          // Mark the previously-current step as completed; promote the new one.
          const prev = stepsReached.slice(0, -1);
          setProgress(token, { current: currentStep, completed: prev });
        },
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
      // Mark every step complete + stamp finishedAt for cleanup.
      const p = getProgress(token);
      if (p) {
        const allCompleted = [...new Set([...p.completed, ...(p.current ? [p.current] : [])])];
        setProgress(token, {
          current: null,
          completed: allCompleted,
          finishedAt: Date.now(),
        });
      }
      console.log(`${tag} ready: ${customerUrl}`);
    } catch (err) {
      console.error(`${tag} failed:`, err.message);
      updateToken(token, {
        status: 'failed',
        error_message: err.message.slice(0, 1000),
      });
      const p = getProgress(token);
      if (p) setProgress(token, { ...p, finishedAt: Date.now() });
    }
  })();
});

// ─── Admin API (gated; HTML/JS/CSS gated above) ─────────────────────
app.use('/api/admin', requireAdmin);

// List tokens — sanitized, no api keys (we never store them anyway).
app.get('/api/admin/tokens', (_req, res) => {
  const rows = listTokens().map((r) => ({
    token: r.token,
    domain: r.domain,
    container_ip: r.container_ip,
    container_user: r.container_user,
    status: r.status,
    customer_email: r.customer_email,
    customer_url: r.customer_url,
    provider: r.provider,
    error_message: r.error_message,
    created_at: r.created_at,
    updated_at: r.updated_at,
    signup_url: `${SIGNUP_BASE_URL}/?token=${r.token}`,
  }));
  res.json({ tokens: rows, signupBaseUrl: SIGNUP_BASE_URL });
});

// Create new token (web equivalent of `oc-register` CLI).
app.post('/api/admin/tokens', (req, res) => {
  const { domain, containerIp, containerUser } = req.body || {};
  if (!domain || !containerIp) {
    return res.status(400).json({ error: 'domain and containerIp required' });
  }
  if (!/^[a-z0-9.-]+$/i.test(domain)) {
    return res.status(400).json({ error: 'invalid domain' });
  }
  if (!/^[0-9a-f.:]+$/i.test(containerIp)) {
    return res.status(400).json({ error: 'invalid containerIp' });
  }
  const token = createToken({
    domain,
    containerIp,
    containerUser: containerUser || 'root',
  });
  res.status(201).json({
    token,
    domain,
    container_ip: containerIp,
    signup_url: `${SIGNUP_BASE_URL}/?token=${token}`,
  });
});

// Delete a token (revoke the signup URL — does NOT touch the LXC itself).
app.delete('/api/admin/tokens/:token', (req, res) => {
  const result = deleteToken(req.params.token);
  if (result.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Reset token status to 'pending' so it can be (re)provisioned via the form.
app.post('/api/admin/tokens/:token/reset', (req, res) => {
  const r = getToken(req.params.token);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.status === 'provisioning') {
    return res.status(409).json({ error: 'in flight, wait for it to finish' });
  }
  updateToken(req.params.token, {
    status: 'pending',
    customer_url: null,
    error_message: null,
  });
  res.json({ ok: true });
});

// Liveness check for a customer URL (server-side fetch, avoids CORS hassle).
app.get('/api/admin/tokens/:token/liveness', async (req, res) => {
  const r = getToken(req.params.token);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (!r.customer_url) return res.json({ reachable: false, reason: 'no url' });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const probe = await fetch(r.customer_url.split('?')[0] + 'healthz', {
      signal: ctrl.signal,
      redirect: 'manual',
    });
    clearTimeout(timer);
    res.json({ reachable: probe.ok || probe.status === 200, status: probe.status });
  } catch (err) {
    res.json({ reachable: false, reason: err.name || err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`OpenClaw signup backend listening on http://${HOST}:${PORT}`);
  if (RECAPTCHA_SECRET) {
    console.log(`reCAPTCHA enabled (min score: ${RECAPTCHA_MIN_SCORE})`);
  } else {
    console.log('reCAPTCHA disabled (set RECAPTCHA_SITE_KEY + RECAPTCHA_SECRET to enable)');
  }
  if (ADMIN_ENABLED) {
    console.log(`Admin enabled at /admin (user: ${ADMIN_USER})`);
  } else {
    console.log('Admin dashboard disabled (set ADMIN_PASSWORD to enable)');
  }
});
