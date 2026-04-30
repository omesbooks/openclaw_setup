// public/admin.js — admin dashboard logic.
(function () {
  const $ = (id) => document.getElementById(id);

  let signupBaseUrl = '';

  function fmtRelative(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime();
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'onClick') e.addEventListener('click', v);
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText;
      throw new Error(msg);
    }
    return data;
  }

  async function load() {
    try {
      const data = await api('GET', '/api/admin/tokens');
      signupBaseUrl = data.signupBaseUrl || '';
      render(data.tokens);
    } catch (err) {
      $('tokens-table').querySelector('tbody').innerHTML =
        `<tr><td colspan="7" class="dim center">Error: ${err.message}</td></tr>`;
    }
  }

  function render(tokens) {
    // Stats
    const statsEl = $('stats');
    statsEl.innerHTML = '';
    const counts = { ready: 0, provisioning: 0, pending: 0, failed: 0 };
    for (const t of tokens) counts[t.status] = (counts[t.status] || 0) + 1;
    for (const [k, v] of Object.entries(counts)) {
      const pill = el('div', { class: `stat-pill ${k}` },
        el('span', { class: 'num' }, String(v)),
        el('span', {}, k)
      );
      statsEl.appendChild(pill);
    }

    // Table
    const tbody = $('tokens-table').querySelector('tbody');
    tbody.innerHTML = '';
    if (tokens.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="dim center">No containers yet. Click "+ Add container".</td></tr>';
      return;
    }
    for (const t of tokens) tbody.appendChild(renderRow(t));
  }

  function renderRow(t) {
    const status = el('span', { class: `status-badge ${t.status}` }, t.status);
    const actions = el('div', { class: 'row-actions' });

    actions.appendChild(el('button', {
      onClick: () => copy(t.signup_url, 'Signup URL copied'),
    }, 'Copy signup URL'));

    if (t.customer_url) {
      actions.appendChild(el('button', {
        onClick: () => copy(t.customer_url, 'Customer URL copied'),
      }, 'Copy customer URL'));
      actions.appendChild(el('button', {
        onClick: () => window.open(t.customer_url, '_blank'),
      }, 'Open'));
    }

    actions.appendChild(el('button', {
      onClick: () => showDetail(t),
    }, 'Details'));

    if (t.status !== 'provisioning') {
      actions.appendChild(el('button', {
        onClick: () => resetToken(t.token),
      }, 'Reset'));
    }

    actions.appendChild(el('button', {
      class: 'danger',
      onClick: () => revokeToken(t.token, t.domain),
    }, 'Revoke'));

    return el('tr', {},
      el('td', {}, status),
      el('td', { html: `<code>${escapeHtml(t.domain)}</code>` }),
      el('td', {}, t.container_ip),
      el('td', {}, t.provider || '—'),
      el('td', {}, t.customer_email || '—'),
      el('td', {}, fmtRelative(t.created_at)),
      el('td', {}, actions)
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function copy(text, toast) {
    try {
      await navigator.clipboard.writeText(text);
      flash(toast || 'Copied');
    } catch {
      prompt('Copy this:', text);
    }
  }

  function flash(msg) {
    const t = el('div', { class: 'toast' }, msg);
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', left: '50%',
      transform: 'translateX(-50%)',
      background: '#222', color: '#fff', padding: '10px 16px',
      borderRadius: '8px', zIndex: 100, fontSize: '14px',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1500);
  }

  async function revokeToken(token, domain) {
    if (!confirm(`Revoke signup token for ${domain}?\n\nThe signup URL will stop working. The LXC itself is NOT touched.`)) return;
    try {
      await api('DELETE', `/api/admin/tokens/${token}`);
      load();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function resetToken(token) {
    if (!confirm('Reset this token back to "pending"?\n\nThe customer can submit the signup form again.')) return;
    try {
      await api('POST', `/api/admin/tokens/${token}/reset`);
      load();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function showDetail(t) {
    $('dd-domain').textContent = t.domain;
    const fields = [
      ['Token', t.token],
      ['Container', `${t.container_user}@${t.container_ip}`],
      ['Status', t.status],
      ['Provider', t.provider || '—'],
      ['Customer email', t.customer_email || '—'],
      ['Customer URL', t.customer_url || '—'],
      ['Signup URL', t.signup_url],
      ['Created', t.created_at],
      ['Last update', t.updated_at || '—'],
      ['Error', t.error_message || '—'],
    ];
    const wrap = $('dd-fields');
    wrap.innerHTML = '';
    for (const [k, v] of fields) {
      wrap.appendChild(el('span', {}, k));
      wrap.appendChild(el('code', {}, v));
    }
    $('detail-dialog').showModal();
  }

  $('dd-close').addEventListener('click', () => $('detail-dialog').close());

  // Add form
  $('add-btn').addEventListener('click', () => {
    $('add-form-wrap').hidden = false;
    $('add-result').hidden = true;
  });
  $('cancel-add').addEventListener('click', () => {
    $('add-form-wrap').hidden = true;
  });
  $('back-list').addEventListener('click', () => {
    $('add-result').hidden = true;
    load();
  });
  $('copy-url').addEventListener('click', () => {
    copy($('ar-url').textContent, 'Signup URL copied');
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      const res = await api('POST', '/api/admin/tokens', {
        domain: form.domain.value.trim(),
        containerIp: form.containerIp.value.trim(),
        containerUser: form.containerUser.value.trim() || 'root',
      });
      $('ar-domain').textContent = res.domain;
      $('ar-ip').textContent = res.container_ip;
      $('ar-url').textContent = res.signup_url;
      $('add-form-wrap').hidden = true;
      $('add-result').hidden = false;
      form.reset();
      form.containerUser.value = 'root';
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  load();
  // Auto-refresh every 15s.
  setInterval(load, 15000);
})();
