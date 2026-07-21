// Talks to your deployed Cloudflare Worker only. No API keys ever live in
// this file or anywhere in the browser - the Worker holds them.

// Fixed - this is your one deployed Worker. Only change this if you ever
// redeploy to a different URL.
const BACKEND_URL = 'https://workspace.arcticfox-org.workers.dev';

// Must match WORKER_BUILD in worker.js. Bumped together, on purpose - see
// the comment on WORKER_BUILD for why this exists.
const EXPECTED_WORKER_BUILD = '2026-07-21.1';

function authHeader() {
  const pin = localStorage.getItem('workspace_pin') || '';
  let deviceId = localStorage.getItem('workspace_device_id');
  if (!deviceId) {
    deviceId = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('workspace_device_id', deviceId);
  }
  return { 'X-App-Password': pin, 'X-Device-Id': deviceId };
}

// Rough, honest device description - not a fingerprinting library, just
// enough to tell your devices apart in the /devices list ("Chrome on
// Windows" vs "Safari on iPhone"), from data the browser already exposes.
function describeDevice() {
  const ua = navigator.userAgent || '';
  let os = 'Unknown OS';
  if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = 'Unknown browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  return `${browser} on ${os}`;
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
  // No auth header needed - /api/version is intentionally public.
  async getVersion() {
    const res = await fetch(BACKEND_URL + '/api/version');
    if (!res.ok) throw new Error('Could not reach the Worker to check its version.');
    return res.json(); // { build }
  },
  // Returns null if in sync, or a warning string if the live Worker is
  // running older code than this frontend expects.
  async checkDeploySync() {
    try {
      const { build } = await Providers.getVersion();
      if (build !== EXPECTED_WORKER_BUILD) {
        // Build strings are "YYYY-MM-DD.N" so they sort correctly as plain
        // strings - use that to say which side is actually behind, instead
        // of always claiming the Worker is the old one.
        if (build && build > EXPECTED_WORKER_BUILD) {
          return `The deployed Worker (build ${build}) is newer than this frontend expects (${EXPECTED_WORKER_BUILD}) - the frontend (index.html/js/css on GitHub Pages) is the one that's behind. Redeploy those, not the Worker.`;
        }
        return `Your deployed Worker (build ${build || 'unknown'}) is older than this frontend expects (${EXPECTED_WORKER_BUILD}) - some fixes aren't live yet. Redeploy worker.js in the Cloudflare dashboard.`;
      }
      return null;
    } catch (e) {
      return null; // don't nag if we can't even reach it - a different error will already show that
    }
  },
  async list() {
    const res = await apiFetch('/api/providers');
    return res.json();
  },
  // Registers this device as "currently active" - call on load and every
  // few minutes. Lightweight on purpose (one small KV write), never on
  // every chat call.
  async pingDevice() {
    try {
      await apiFetch('/api/devices/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: describeDevice() })
      });
    } catch (e) { /* silent - this is a nice-to-have, never block on it */ }
  },
  async listDevices() {
    const res = await apiFetch('/api/devices');
    return res.json(); // { devices: [{ id, description, lastSeen, isThisDevice }] }
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
