// public/app.js — frontend logic for the signup form.
(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  const $ = (id) => document.getElementById(id);
  const screens = ['form-screen', 'progress-screen', 'success-screen', 'error-screen'];

  let recaptchaSiteKey = null;
  let lastFormValues = null;
  let progressSteps = []; // full ordered list from /api/config

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

  function showProgress() {
    show('progress-screen');
    renderChecklist(null);
  }

  function renderChecklist(progress) {
    const list = $('progress-list');
    if (!list || !progressSteps.length) return;

    const completed = new Set((progress && progress.completed) || []);
    const current = (progress && progress.current) || null;

    list.innerHTML = '';
    for (const step of progressSteps) {
      const li = document.createElement('li');
      let cls = 'pending';
      if (completed.has(step)) cls = 'done';
      if (step === current) cls = 'current';
      li.className = cls;
      li.textContent = step;
      list.appendChild(li);
    }
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

  // Provider-conditional fields (NVIDIA + Custom show base URL + model id).
  const NVIDIA_DEFAULTS = {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelId: 'moonshotai/kimi-k2-instruct',
  };
  function refreshProviderFields() {
    const sel = $('provider-select');
    const provider = sel ? sel.value : '';
    const baseField = $('field-custom-base-url');
    const modelField = $('field-custom-model-id');
    const baseInput = baseField ? baseField.querySelector('input') : null;
    const modelInput = modelField ? modelField.querySelector('input') : null;

    if (provider === 'nvidia') {
      if (baseField) baseField.hidden = false;
      if (modelField) modelField.hidden = false;
      if (baseInput) {
        baseInput.required = false;
        if (!baseInput.value) baseInput.value = NVIDIA_DEFAULTS.baseUrl;
      }
      if (modelInput) {
        modelInput.required = false;
        if (!modelInput.value) modelInput.value = NVIDIA_DEFAULTS.modelId;
      }
    } else if (provider === 'custom') {
      if (baseField) baseField.hidden = false;
      if (modelField) modelField.hidden = false;
      if (baseInput) baseInput.required = true;
      if (modelInput) modelInput.required = true;
    } else {
      if (baseField) baseField.hidden = true;
      if (modelField) modelField.hidden = true;
      if (baseInput) { baseInput.required = false; baseInput.value = ''; }
      if (modelInput) { modelInput.required = false; modelInput.value = ''; }
    }
  }
  const providerSel = $('provider-select');
  if (providerSel) providerSel.addEventListener('change', refreshProviderFields);

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
    if (Array.isArray(config.progressSteps)) {
      progressSteps = config.progressSteps;
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
      showProgress();
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
    if (form.customBaseUrl && form.customBaseUrl.value) {
      values.customBaseUrl = form.customBaseUrl.value;
    }
    if (form.customModelId && form.customModelId.value) {
      values.customModelId = form.customModelId.value;
    }
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
        showProgress();
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
      if (f.customBaseUrl) f.customBaseUrl.value = lastFormValues.customBaseUrl || '';
      if (f.customModelId) f.customModelId.value = lastFormValues.customModelId || '';
    }
    refreshProviderFields();
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
          // Render one last time with everything completed.
          if (data.progress) {
            const everything = {
              current: null,
              completed: [...progressSteps],
            };
            renderChecklist(everything);
          }
          showSuccess(data.customerUrl);
        } else if (data.status === 'failed') {
          clearInterval(intervalId);
          showError(data.error || 'Provisioning failed', true);
        } else if (data.progress) {
          renderChecklist(data.progress);
        }
      } catch (_err) {
        // network blip — keep polling
      }
    }, 5000);
  }
})();
