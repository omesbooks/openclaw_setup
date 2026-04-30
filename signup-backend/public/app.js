// public/app.js — frontend logic for the signup form.
(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  const $ = (id) => document.getElementById(id);
  const screens = ['form-screen', 'progress-screen', 'success-screen', 'error-screen'];

  function show(id) {
    screens.forEach((s) => {
      const el = $(s);
      if (el) el.hidden = (s !== id);
    });
  }

  function showError(msg) {
    $('error-message').textContent = msg || 'Unknown error';
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

  if (!token) {
    showError('This signup link is missing a token. Please check with your operator.');
    return;
  }

  // Load token info on page load.
  fetch(`/api/token-info?token=${encodeURIComponent(token)}`)
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Invalid signup link');
        return;
      }
      $('domain-display').textContent = data.domain;

      if (data.status === 'ready' && data.customerUrl) {
        showSuccess(data.customerUrl);
      } else if (data.status === 'provisioning') {
        showProgress('Continuing previous setup…');
        pollStatus();
      } else if (data.status === 'failed') {
        showError(data.error || 'Previous attempt failed. Contact operator.');
      }
      // else 'pending' — show form (default state)
    })
    .catch(() => showError('Could not contact server'));

  // Submit form.
  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    const data = {
      token,
      provider: form.provider.value,
      apiKey: form.apiKey.value,
      email: form.email.value || undefined,
    };

    try {
      const res = await fetch('/api/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
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
        showProgress('Connecting to your container…');
        pollStatus();
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Set up my OpenClaw →';
      alert('Network error: ' + err.message);
    }
  });

  function pollStatus() {
    let attempts = 0;
    const intervalId = setInterval(async () => {
      attempts++;
      // Stop polling after ~10 minutes.
      if (attempts > 120) {
        clearInterval(intervalId);
        showError('Setup is taking longer than expected. Please contact your operator.');
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
          showError(data.error || 'Provisioning failed');
        } else {
          // Update progress message every few polls.
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
        // Network blip — keep polling.
      }
    }, 5000);
  }
})();
