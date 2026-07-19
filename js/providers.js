// Talks to your deployed Cloudflare Worker only. No API keys ever live in
// this file or anywhere in the browser - the Worker holds them.

// Fixed - this is your one deployed Worker. Only change this if you ever
// redeploy to a different URL.
const BACKEND_URL = 'https://workspace.arcticfox-org.workers.dev';

function authHeader() {
  const pin = localStorage.getItem('workspace_pin') || '';
  return { 'X-App-Password': pin };
}

async function apiFetch(path, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
  let res;
  try {
    res = await fetch(BACKEND_URL + path, {
      ...opts,
      headers: { ...(opts && opts.headers), ...authHeader() },
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('That took too long and timed out. Try again in a moment.');
    throw new Error('Could not reach the backend - check your connection.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.message) msg = body.message;
    } catch (e) { /* body wasn't JSON, keep generic message */ }
    throw new Error(msg);
  }
  return res;
}

const Providers = {
  async list() {
    const res = await apiFetch('/api/providers');
    return res.json();
  },
  async getKeyInfo() {
    const res = await apiFetch('/api/keys');
    return res.json();
  },
  async addKey(providerId, label, key) {
    const res = await apiFetch('/api/keys/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, label, key })
    });
    return res.json();
  },
  async removeKey(providerId, index) {
    const res = await apiFetch('/api/keys/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, index })
    });
    return res.json();
  },
  async setModel(providerId, model) {
    const res = await apiFetch('/api/keys/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, model })
    });
    return res.json();
  },
  async refreshModels(providerId) {
    const res = await apiFetch(`/api/models?providerId=${encodeURIComponent(providerId)}`);
    return res.json();
  },
  async chat(providerId, messages, model) {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, messages, model })
    }, 100000); // long allowance - the Worker may be trying a 2nd/3rd key
    return res.json(); // { error, text } or { error: true, message }
  },

  // ---- session sharing (cross-device continuation) ----
  async shareSession(title, messages) {
    const res = await apiFetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, messages })
    });
    return res.json(); // { ok, token }
  },
  async revokeShare(token) {
    const res = await apiFetch('/api/share/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    return res.json();
  },
  // Public read - no PIN needed, works even on a brand-new device.
  async getSharedSession(token) {
    const res = await fetch(`${BACKEND_URL}/api/share/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error('This link has expired or is invalid.');
    return res.json(); // { error, session: { title, messages, createdAt } }
  }
};
