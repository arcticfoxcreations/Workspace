// Talks to your deployed Cloudflare Worker only. No API keys ever live in
// this file or anywhere in the browser - the Worker holds them.

function getBackendUrl() {
  return localStorage.getItem('workspace_backend_url') || 'http://localhost:5175';
}

function authHeader() {
  const pw = sessionStorage.getItem('workspace_password') || '';
  return { 'X-App-Password': pw };
}

async function apiFetch(path, opts) {
  const res = await fetch(getBackendUrl() + path, {
    ...opts,
    headers: { ...(opts && opts.headers), ...authHeader() }
  });
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
    });
    return res.json(); // { error, text } or { error: true, message }
  }
};
