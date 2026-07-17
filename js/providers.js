// Talks to your deployed Cloudflare Worker only. No API keys ever live in
// this file or anywhere in the browser - the Worker holds them.

// Fixed - this is your one deployed Worker. Only change this if you ever
// redeploy to a different URL.
const BACKEND_URL = 'https://workspace.arcticfox-org.workers.dev';

function authHeader() {
  const pin = localStorage.getItem('workspace_pin') || '';
  return { 'X-App-Password': pin };
}

async function apiFetch(path, opts) {
  const res = await fetch(BACKEND_URL + path, {
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
