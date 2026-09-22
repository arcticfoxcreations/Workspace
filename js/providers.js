// Talks to your deployed Cloudflare Worker only. No API keys ever live in
// this file or anywhere in the browser - the Worker holds them.

// Fixed - this is your one deployed Worker. Only change this if you ever
// redeploy to a different URL.
const BACKEND_URL = 'https://workspace.arcticfox-org.workers.dev';

// Must match WORKER_BUILD in worker.js. Bumped together, on purpose - see
// the comment on WORKER_BUILD for why this exists.
const EXPECTED_WORKER_BUILD = '2026-09-20.3';

function authHeader() {
  const pin = localStorage.getItem('workspace_pin') || '';
  const token = localStorage.getItem('workspace_device_token') || '';
  let deviceId = localStorage.getItem('workspace_device_id');
  if (!deviceId) {
    deviceId = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('workspace_device_id', deviceId);
  }
  const h = { 'X-Device-Id': deviceId };
  if (pin) h['X-App-Password'] = pin;
  if (token) h['X-Device-Token'] = token;
  return h;
}
// Signature of the credentials currently saved on this device. After the
// Worker rejects a signature once, we stop resending it (every wrong attempt
// counts toward the Worker's lockout) until the user actually changes it.
function authSignature() {
  return (localStorage.getItem('workspace_pin') || '') + '|' + (localStorage.getItem('workspace_device_token') || '');
}
let _authRejectedSig = null;

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

function apiError(message, extra) {
  const e = new Error(message);
  Object.assign(e, extra || {});
  return e;
}

// opts.public = true skips credentials (pairing code redemption).
async function apiFetch(path, opts, timeoutMs) {
  const isPublic = !!(opts && opts.public);
  if (!isPublic) {
    const sig = authSignature();
    if (sig === '|') throw apiError('Enter your PIN below to unlock, or pair this device with a code from another device.', { code: 'unauthorized', status: 401 });
    if (_authRejectedSig === sig) throw apiError('The PIN saved on this device was rejected. Open Settings and enter it again.', { code: 'unauthorized', status: 401 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
  let res;
  try {
    const { public: _p, ...fetchOpts } = opts || {};
    res = await fetch(BACKEND_URL + path, {
      ...fetchOpts,
      headers: { ...(fetchOpts && fetchOpts.headers), ...(isPublic ? { 'X-Device-Id': authHeader()['X-Device-Id'] } : authHeader()) },
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw apiError('That took too long and timed out. Try again in a moment.', { code: 'timeout' });
    throw apiError('Could not reach the backend - check your connection.', { code: 'offline', offline: true });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let code;
    try {
      const body = await res.json();
      if (body && body.message) msg = body.message;
      if (body && body.code) code = body.code;
    } catch (e) { /* body wasn't JSON, keep generic message */ }
    if (!isPublic && res.status === 401 && code === 'unauthorized') _authRejectedSig = authSignature();
    if (code === 'device_revoked' && typeof Sync !== 'undefined' && Sync.handleRevoked) Sync.handleRevoked();
    throw apiError(msg, { status: res.status, code });
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
      const last = Number(localStorage.getItem('workspace_last_ping') || 0);
      if (Date.now() - last < 30 * 60 * 1000) return;
      localStorage.setItem('workspace_last_ping', String(Date.now()));
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
  async setBaseUrl(providerId, baseUrl) {
    const res = await apiFetch('/api/keys/baseurl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, baseUrl })
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
  // `long` marks requests that are expected to legitimately take a while -
  // Research-mode answers, context-compile jobs - so the Worker gives the
  // provider more time before timing out (see LONG_REQUEST_TIMEOUT_MS in
  // worker.js), and the client itself waits long enough to actually hear
  // back rather than aborting first.
  async chat(providerId, messages, model, opts) {
    const long = !!(opts && opts.long);
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, messages, model, longRunning: long })
    }, long ? 180000 : 100000); // long allowance - the Worker may be trying a 2nd/3rd key
    return res.json(); // { error, text } or { error: true, message }
  },

  // ---- shared chats (live) ----
  async shareSession(title, messages) {
    const res = await apiFetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, messages })
    }, 45000);
    return res.json(); // { ok, token, rev }
  },
  // Owner pushes new content to the SAME link so viewers see it live.
  async updateShare(token, title, messages) {
    const res = await apiFetch('/api/share/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, title, messages })
    }, 45000);
    return res.json(); // { ok, rev }
  },
  async revokeShare(token) {
    const res = await apiFetch('/api/share/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    return res.json();
  },
  // Public read - no PIN needed. Pass the last rev you have; the Worker
  // answers { unchanged: true } (tiny) when nothing new happened.
  async getSharedSession(token, sinceRev) {
    const q = sinceRev ? `?rev=${encodeURIComponent(sinceRev)}` : '';
    let res;
    try {
      res = await fetch(`${BACKEND_URL}/api/share/${encodeURIComponent(token)}${q}`, { cache: 'no-store' });
    } catch (e) {
      throw apiError('Could not reach the server.', { offline: true, code: 'offline' });
    }
    if (res.status === 404) throw apiError('This link has expired or is invalid.', { code: 'gone', status: 404 });
    if (!res.ok) throw apiError(`Server error (${res.status})`, { status: res.status });
    return res.json(); // { error, unchanged } or { error, session: { title, messages, createdAt, updatedAt, rev } }
  },

  // ---- devices & pairing ----
  async whoami() { return (await apiFetch('/api/whoami')).json(); },
  async createPairCode() {
    return (await apiFetch('/api/pair/create', { method: 'POST' })).json(); // { code, expiresInSeconds }
  },
  // Public (the code itself is the credential). Returns the device's own
  // token + the vault description (or null if sync was never set up).
  async redeemPairCode(code, name, description) {
    const res = await apiFetch('/api/pair/redeem', {
      public: true, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, description })
    });
    return res.json();
  },
  async revokeDevice(id) {
    return (await apiFetch('/api/devices/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })).json();
  },

  // ---- encrypted sync transport (the Worker only ever sees ciphertext) ----
  async syncStatus() { return (await apiFetch('/api/sync/status')).json(); },
  async syncCreateVault(vault) {
    return (await apiFetch('/api/sync/vault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vault }) })).json();
  },
  async syncHead() { return (await apiFetch('/api/sync/head')).json(); },
  async syncList(cursor) { return (await apiFetch('/api/sync/list' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''), undefined, 30000)).json(); },
  async syncGetItem(id) {
    const res = await apiFetch(`/api/sync/item?id=${encodeURIComponent(id)}`, undefined, 60000);
    return new Uint8Array(await res.arrayBuffer());
  },
  async syncPutItem(id, version, bytes, deleted) {
    const q = `id=${encodeURIComponent(id)}&v=${encodeURIComponent(version)}${deleted ? '&d=1' : ''}`;
    return (await apiFetch(`/api/sync/item?${q}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }, 120000)).json();
  },
  async syncCommit() { return (await apiFetch('/api/sync/commit', { method: 'POST' })).json(); },
  async syncReset() {
    return (await apiFetch('/api/sync/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) }, 60000)).json();
  }
};
