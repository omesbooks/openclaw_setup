// public/app.js — frontend logic for the signup form.
(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  const $ = (id) => document.getElementById(id);
  const screens = ['form-screen', 'progress-screen', 'success-screen', 'error-screen'];

  let recaptchaSiteKey = null;
  let lastFormValues = null;

  function show(id) {
    screens.forEach((s) => {
      const el = $(s);
      if (el) el.hidden = (s !== id);
    });
  }

  function showError(msg, allowRetry) {
    $('error-message').textContent = msg || 'Unknown error';
    $('retry-btn').hidden = !allowRetry;
    show('error-screen');
  }

  function showSuccess(url) {
    $('open-url').href = url;
    show('success-screen');
  }

  function showProgress(detail) {
    if (detail) $('progress-detail').textContent = detail;
    show('progress-screen');
  }

  function showForm() {
    show('form-screen');
    const btn = $('submit-btn');
    btn.disabled = false;
    btn.textContent = 'Set up my OpenClaw →';
  }

  if (!token) {
    showError('This signup link is missing a token. Please check with your operator.', false);
    return;
  }

  // Load config + token info on page load.
  Promise.all([
    fetch('/api/config').then((r) => r.json()).catch(() => ({})),
    fetch(`/api/token-info?token=${encodeURIComponent(token)}`).then(async (r) => ({ ok: r.ok, body: await r.json() })),
  ]).then(([config, tokenRes]) => {
    if (config.recaptchaSiteKey) {
      recaptchaSiteKey = config.recaptchaSiteKey;
      loadRecaptchaScript(config.recaptchaSiteKey);
      $('recaptcha-notice').hidden = false;
    }

    if (!tokenRes.ok) {
      showError(tokenRes.body.error || 'Invalid signup link', false);
      return;
    }
    const data = tokenRes.body;
    $('domain-display').textContent = data.domain;

    if (data.status === 'ready' && data.customerUrl) {
      showSuccess(data.customerUrl);
    } else if (data.status === 'provisioning') {
      showProgress('Continuing previous setup…');
      pollStatus();
    } else if (data.status === 'failed') {
      showError(data.error || 'Previous attempt failed.', true);
    }
    // else 'pending' — show form (default state)
  }).catch(() => showError('Could not contact server', true));

  function loadRecaptchaScript(siteKey) {
    if (document.getElementById('recaptcha-script')) return;
    const s = document.createElement('script');
    s.id = 'recaptcha-script';
    s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }

  async function getCaptchaToken() {
    if (!recaptchaSiteKey || typeof grecaptcha === 'undefined') return undefined;
    return new Promise((resolve, reject) => {
      grecaptcha.ready(async () => {
        try {
          const t = await grecaptcha.execute(recaptchaSiteKey, { action: 'provision' });
          resolve(t);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  // Submit form.
  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    const values = {
      provider: form.provider.value,
      apiKey: form.apiKey.value,
      email: form.email.value || undefined,
    };
    lastFormValues = values;

    try {
      const captchaToken = await getCaptchaToken();
      const res = await fetch('/api/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...values, captchaToken }),
      });
      const result = await res.json();

      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = 'Set up my OpenClaw →';
        alert('Error: ' + (result.error || 'unknown'));
        return;
      }

      if (result.status === 'ready' && result.url) {
        showSuccess(result.url);
      } else {
        showProgress(
          result.isReprovision
            ? 'Replacing previous setup…'
            : 'Connecting to your container…'
        );
        pollStatus();
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Set up my OpenClaw →';
      alert('Network error: ' + err.message);
    }
  });

  // Reset (success screen) — go back to form, prompt to confirm.
  $('reset-btn').addEventListener('click', () => {
    if (!confirm(
      'Replace your current AI provider configuration?\n\n' +
      'Your existing OpenClaw URL will stop working — a new URL will be issued.'
    )) return;
    if (lastFormValues) {
      const f = $('signup-form');
      f.provider.value = lastFormValues.provider || '';
      f.apiKey.value = '';
      f.email.value = lastFormValues.email || '';
    }
    showForm();
  });

  // Retry (error screen).
  $('retry-btn').addEventListener('click', () => {
    showForm();
  });

  function pollStatus() {
    let attempts = 0;
    const intervalId = setInterval(async () => {
      attempts++;
      if (attempts > 120) {
        clearInterval(intervalId);
        showError('Setup is taking longer than expected. Please contact your operator.', true);
        return;
      }
      try {
        const res = await fetch(`/api/status?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (data.status === 'ready' && data.customerUrl) {
          clearInterval(intervalId);
          showSuccess(data.customerUrl);
        } else if (data.status === 'failed') {
          clearInterval(intervalId);
          showError(data.error || 'Provisioning failed', true);
        } else {
          const messages = [
            'Installing dependencies…',
            'Setting up Caddy + TLS…',
            'Configuring OpenClaw…',
            'Applying your AI provider…',
            'Verifying connection…',
          ];
          $('progress-detail').textContent = messages[Math.min(messages.length - 1, Math.floor(attempts / 6))];
        }
      } catch (_err) {
        // network blip — keep polling
      }
    }, 5000);
  }
})();
