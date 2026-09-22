// Cloudflare Worker - your always-on, free, publicly reachable backend.
//
// What it does:
//   1. Holds your AI provider API keys (in Workers KV - never in the browser)
//      and relays chat requests to each provider.
//   2. Authenticates callers: the owner PIN (APP_PASSWORD secret), or a
//      per-device token issued through a one-time pairing code.
//   3. Stores ENCRYPTED workspace sync data (the browser encrypts before
//      upload - this Worker only ever sees ciphertext for sessions/files).
//   4. Serves live shared-chat links.
//
// WORKER_BUILD - bump this any time worker.js changes. The frontend checks it
// against EXPECTED_WORKER_BUILD (js/providers.js) and warns you if they don't
// match, i.e. if you forgot the "paste into Cloudflare -> Save and deploy" step.
const WORKER_BUILD = '2026-09-20.3';

// ---- timeouts -------------------------------------------------------------
// Quick chat gets 30s per key; Research/Test/Outline/Compare modes and compile
// jobs (client sends longRunning:true) get 58s per key. If a key stalls the
// Worker moves on to the next key instead of hanging forever.
const QUICK_TIMEOUT_MS = 30000;
const LONG_TIMEOUT_MS = 58000;
const KEY_COOLDOWN_MS = 3 * 60 * 1000;

// ---- security / limits ----------------------------------------------------
const AUTH_FAIL_LIMIT = 10;                 // wrong credentials per IP ...
const AUTH_FAIL_WINDOW_S = 15 * 60;         // ... per 15 minutes -> 429
const PAIR_TTL_S = 5 * 60;                  // pairing code lifetime
const PAIR_GLOBAL_FAIL_LIMIT = 20;          // wrong pairing codes (all IPs) per 10 min
const PAIR_GLOBAL_WINDOW_S = 10 * 60;
const MAX_ITEM_BYTES = 24 * 1024 * 1024;    // KV hard limit is 25 MiB per value
const MAX_SHARE_BYTES = 8 * 1024 * 1024;
const PRESENCE_MIN_INTERVAL_MS = 10 * 60 * 1000;
// No I, L, O, 0, 1 - characters people misread. 31 symbols ^ 8 = ~39.6 bits.
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const PROVIDERS = {
  gemini: {
    label: 'Gemini', kind: 'gemini', defaultModel: 'gemini-3.5-flash',
    refill: 'recurring', signupUrl: 'https://aistudio.google.com',
    maxOutputTokens: 8192,
    modelsUrl: (key) => `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
  },
  groq: {
    label: 'Groq', kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b', refill: 'recurring', signupUrl: 'https://console.groq.com',
    // Groq's TPM cap counts prompt + completion together (8000 on the free
    // tier), so the reply budget is kept small to leave room for the prompt.
    maxOutputTokens: 2200
  },
  openrouter: {
    label: 'OpenRouter', kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free', refill: 'recurring', signupUrl: 'https://openrouter.ai',
    maxOutputTokens: 8192,
    // Free-model IDs on OpenRouter rotate. If the chosen/default model is
    // gone (404 / "no endpoints"), the Worker looks up a currently-free one.
    freeFallback: true,
    extraHeaders: { 'X-Title': 'AI Workspace' }
  },
  githubmodels: {
    label: 'GitHub Models', kind: 'openai-compat', baseUrl: 'https://models.inference.ai.azure.com',
    defaultModel: 'gpt-4o', refill: 'recurring', signupUrl: 'https://github.com/marketplace/models',
    maxOutputTokens: 4096
  },
  mistral: {
    label: 'Mistral', kind: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest', refill: 'recurring', signupUrl: 'https://console.mistral.ai',
    maxOutputTokens: 8192
  },
  cerebras: {
    label: 'Cerebras', kind: 'openai-compat', baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b', refill: 'recurring', signupUrl: 'https://cloud.cerebras.ai',
    maxOutputTokens: 8192
  },
  nvidia: {
    label: 'NVIDIA NIM', kind: 'openai-compat', baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.1-70b-instruct', refill: 'recurring', signupUrl: 'https://build.nvidia.com',
    maxOutputTokens: 8192
  },
  cloudflareai: {
    label: 'Cloudflare AI', kind: 'cloudflare-ai',
    defaultModel: '@cf/meta/llama-3.1-8b-instruct', refill: 'recurring',
    signupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    maxOutputTokens: 4096
  },
  ovhcloud: {
    label: 'OVHcloud', kind: 'openai-compat', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    defaultModel: 'Meta-Llama-3_3-70B-Instruct', refill: 'recurring',
    signupUrl: 'https://endpoints.ai.cloud.ovh.net', maxOutputTokens: 4096
  },
  anthropic: {
    label: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5', refill: 'one-time', signupUrl: 'https://console.anthropic.com',
    maxOutputTokens: 8192
  },
  openai: {
    label: 'GPT', kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6', refill: 'one-time', signupUrl: 'https://platform.openai.com',
    maxOutputTokens: 8192
  },
  deepseek: {
    label: 'DeepSeek', kind: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat', refill: 'one-time', signupUrl: 'https://platform.deepseek.com',
    maxOutputTokens: 8192
  },
  // OmniRoute is self-hosted, open-source gateway software
  // (github.com/diegosouzapw/OmniRoute), NOT a cloud service with one fixed
  // URL. You run your own instance; it exposes an OpenAI-compatible API at
  // <your-instance>/v1. So the base URL is per-user and lives in KV
  // (POST /api/keys/baseurl) instead of being hardcoded here.
  omniroute: {
    label: 'OmniRoute', kind: 'openai-compat', baseUrl: null, customBaseUrl: true,
    defaultModel: 'auto', refill: 'recurring',
    signupUrl: 'https://github.com/diegosouzapw/OmniRoute',
    maxOutputTokens: 8192
  }
};

// ============================================================================
// small helpers
// ============================================================================
const ENC = new TextEncoder();

function corsHeaders(origin, env) {
  let allow = origin || '*';
  // Optional hardening: set ALLOWED_ORIGIN (e.g. https://you.github.io) as a
  // Worker variable to only answer browsers from that site.
  if (env && env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) allow = env.ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Password, X-Device-Id, X-Device-Token',
    'Vary': 'Origin'
  };
}

function json(data, status, origin, env, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin, env), ...(extra || {}) }
  });
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function bytesToB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Hex(str) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', ENC.encode(str)));
}
function randomToken(nBytes) {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}
// Constant-time string comparison (compares fixed-length SHA-256 digests, so
// neither length nor the position of the first mismatch leaks through timing).
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', ENC.encode(String(a))),
    crypto.subtle.digest('SHA-256', ENC.encode(String(b)))
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
// Unbiased random pairing code: rejection sampling so no symbol is favoured.
function makePairCode() {
  const n = PAIR_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < 8) out += PAIR_ALPHABET[b % n];
    }
  }
  return out;
}
function normalizePairCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}
function isQuotaError(e) {
  return /limit exceeded|too many requests|quota/i.test((e && e.message) || '');
}

// ============================================================================
// authentication + brute-force protection
// ============================================================================
// Two credential types:
//   owner  - X-App-Password equals the APP_PASSWORD secret. Can do everything.
//   device - X-Device-Id + X-Device-Token from a one-time pairing. Everything
//            except the owner-only actions (provider keys, pairing, revoking,
//            wiping cloud data). Tokens are stored only as SHA-256 hashes, so a
//            KV leak doesn't leak usable tokens.
async function ipKey(request) {
  return 'rl:' + (await sha256Hex(clientIp(request))).slice(0, 24);
}
async function isLockedOut(env, request) {
  const raw = await env.WORKSPACE_KV.get(await ipKey(request));
  return raw ? (JSON.parse(raw).n || 0) >= AUTH_FAIL_LIMIT : false;
}
// Only writes while below the limit, so an attacker hammering us can burn at
// most AUTH_FAIL_LIMIT KV writes per IP per window (KV free tier = 1000
// writes/day - see notes in README-DEPLOY.md).
async function recordAuthFailure(env, request) {
  const key = await ipKey(request);
  const raw = await env.WORKSPACE_KV.get(key);
  const n = raw ? (JSON.parse(raw).n || 0) : 0;
  if (n >= AUTH_FAIL_LIMIT) return;
  await env.WORKSPACE_KV.put(key, JSON.stringify({ n: n + 1 }), { expirationTtl: AUTH_FAIL_WINDOW_S });
}

// Returns { auth } on success or { response } to send back.
async function authenticate(request, env) {
  const pin = request.headers.get('X-App-Password') || '';
  const deviceId = request.headers.get('X-Device-Id') || '';
  const token = request.headers.get('X-Device-Token') || '';
  const supplied = !!(pin || token);

  if (supplied && await isLockedOut(env, request)) {
    return { response: { status: 429, body: { error: true, code: 'locked_out', message: 'Too many wrong attempts from this network. Try again in about 15 minutes.' } } };
  }
  if (pin && env.APP_PASSWORD && await safeEqual(pin, env.APP_PASSWORD)) {
    return { auth: { role: 'owner', deviceId } };
  }
  if (token && /^dev_[A-Za-z0-9]{8,40}$/.test(deviceId)) {
    const raw = await env.WORKSPACE_KV.get(`device:${deviceId}`);
    if (raw) {
      const rec = JSON.parse(raw);
      if (await safeEqual(await sha256Hex(token), rec.tokenHash)) {
        return { auth: { role: 'device', deviceId, name: rec.name } };
      }
    } else {
      // A syntactically valid token for a device that no longer exists =
      // revoked. Tell the client so it can sign itself out cleanly.
      if (!pin) return { response: { status: 401, body: { error: true, code: 'device_revoked', message: 'This device was removed from the workspace. Pair it again or enter your PIN.' } } };
    }
  }
  if (supplied) await recordAuthFailure(env, request);
  return { response: { status: 401, body: { error: true, code: 'unauthorized', message: 'Unauthorized - wrong or missing PIN' } } };
}
function needOwner() {
  return { status: 403, body: { error: true, code: 'owner_required', message: 'This action needs your master PIN. Enter it under Settings -> Connection, then try again.' } };
}

// ============================================================================
// KV-backed provider key store  (unchanged model: "provider:<id>")
// ============================================================================
async function readProviderData(env, providerId) {
  const raw = await env.WORKSPACE_KV.get(`provider:${providerId}`);
  return raw ? JSON.parse(raw) : { keys: [], activeModel: null };
}
async function writeProviderData(env, providerId, data) {
  await env.WORKSPACE_KV.put(`provider:${providerId}`, JSON.stringify(data));
}
function resolveBaseUrl(def, data) {
  if (!def.customBaseUrl) return def.baseUrl;
  return (data && data.baseUrl) ? data.baseUrl.replace(/\/+$/, '') : null;
}
// OmniRoute (and any future self-hosted gateway): https only, no embedded
// credentials, and default the path to /v1 when the user pasted a bare origin.
function normalizeCustomBaseUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return { error: 'That is not a valid URL.' }; }
  if (u.protocol !== 'https:') return { error: 'The URL must start with https:// (the Worker cannot reach plain http or localhost).' };
  if (u.username || u.password) return { error: 'Do not put credentials in the URL - add the API key separately.' };
  u.hash = ''; u.search = '';
  let path = u.pathname.replace(/\/+$/, '');
  if (!path) path = '/v1';
  return { url: u.origin + path };
}

// Any of these means "this key isn't working right now, try the next one".
function isFailoverError(status) {
  return status === 429 || status === 401 || status === 403 || status === 408 || status === 0 || status >= 500;
}

async function fetchJSON(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || QUICK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { ok: res.ok, status: res.status, json: parsed };
  } catch (e) {
    const timedOut = e.name === 'AbortError';
    return {
      ok: false,
      status: timedOut ? 408 : 0,
      json: { error: { message: timedOut ? 'Timed out waiting for a response.' : (e.message || 'Network error reaching the provider.') } }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(key, model, messages, maxTokens, timeoutMs) {
  const contents = messages.filter(m => m.role !== 'system').map(m => {
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    if (m.images && m.images.length) for (const img of m.images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const sys = messages.find(m => m.role === 'system');
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens || 8192 } };
  if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const { ok, status, json: j } = await fetchJSON(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }, timeoutMs);
  if (!ok) return { error: true, status, message: j?.error?.message || 'Gemini request failed' };
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return { error: false, text };
}

async function callOpenAICompat(baseUrl, key, model, messages, maxTokens, timeoutMs, extraHeaders, _fallbackParam) {
  const formatted = messages.map(m => {
    if (m.images && m.images.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const img of m.images) content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });
  // Providers drift between `max_tokens` and `max_completion_tokens` (Groq's
  // reasoning models reject the old name). Try the modern one first, and
  // retry once with the other if the provider complains about it.
  const paramName = _fallbackParam || 'max_completion_tokens';
  const body = { model, messages: formatted };
  body[paramName] = maxTokens || 8192;

  const { ok, status, json: j } = await fetchJSON(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(extraHeaders || {}) },
    body: JSON.stringify(body)
  }, timeoutMs);
  if (!ok) {
    const msg = j?.error?.message || 'Request failed';
    if (status === 400 && !_fallbackParam && /max_tokens|max_completion_tokens/i.test(msg)) {
      return callOpenAICompat(baseUrl, key, model, messages, maxTokens, timeoutMs, extraHeaders, paramName === 'max_completion_tokens' ? 'max_tokens' : 'max_completion_tokens');
    }
    return { error: true, status, message: msg };
  }
  const text = j?.choices?.[0]?.message?.content || '';
  return { error: false, text, model: j?.model };
}

async function callAnthropic(key, model, messages, maxTokens, timeoutMs) {
  const sys = messages.find(m => m.role === 'system');
  const rest = messages.filter(m => m.role !== 'system');
  const formatted = rest.map(m => {
    if (m.images && m.images.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const img of m.images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });
  const { ok, status, json: j } = await fetchJSON('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens || 8192, system: sys ? sys.content : undefined, messages: formatted })
  }, timeoutMs);
  if (!ok) return { error: true, status, message: j?.error?.message || 'Claude request failed' };
  const text = (j?.content || []).map(c => c.text).join('');
  return { error: false, text };
}

async function callCloudflareAI(env, model, messages, maxTokens, timeoutMs) {
  // env.AI only exists if the Workers AI binding was added separately from
  // pasting the code (Worker -> Settings -> Bindings -> Workers AI, name "AI").
  if (!env.AI || typeof env.AI.run !== 'function') {
    return {
      error: true, status: 0,
      message: 'Cloudflare AI has no binding set up on this Worker yet - go to your Worker in the Cloudflare dashboard -> Settings -> Bindings -> Add -> Workers AI, and name it exactly "AI". That binding is separate from pasting the worker.js code.'
    };
  }
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for a response.')), timeoutMs || QUICK_TIMEOUT_MS); });
    const result = await Promise.race([env.AI.run(model, { messages, max_tokens: maxTokens || 4096 }), timeout]);
    const text = result?.response || result?.result?.response || '';
    return { error: false, text };
  } catch (e) {
    return { error: true, status: 0, message: e.message || 'Cloudflare AI request failed' };
  } finally {
    clearTimeout(timer);
  }
}

// OpenRouter free-model helpers ------------------------------------------------
// Free models are the ones priced at $0 for both prompt and completion (their
// IDs normally end in ":free"). The list rotates, so it's read live.
function isFreeOpenRouterModel(m) {
  if (!m || !m.id) return false;
  if (/:free$/.test(m.id)) return true;
  const p = m.pricing || {};
  return p.prompt !== undefined && p.completion !== undefined && Number(p.prompt) === 0 && Number(p.completion) === 0;
}
async function listOpenRouterModels(baseUrl, key) {
  const { ok, json: j } = await fetchJSON(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } }, 15000);
  if (!ok || !Array.isArray(j.data)) return null;
  const textOut = (m) => !m.architecture || !Array.isArray(m.architecture.output_modalities) || m.architecture.output_modalities.includes('text');
  const rows = j.data.filter(textOut).map(m => ({ id: m.id, free: isFreeOpenRouterModel(m), ctx: m.context_length || 0 }));
  rows.sort((a, b) => (b.free - a.free) || (b.ctx - a.ctx) || a.id.localeCompare(b.id));
  return rows;
}
async function pickOpenRouterFreeModel(baseUrl, key, exclude) {
  const rows = await listOpenRouterModels(baseUrl, key);
  if (!rows) return null;
  const free = rows.filter(r => r.free && r.id !== exclude);
  return free.length ? free[0].id : null;
}

async function handleChat(env, providerId, model, messages, longRunning) {
  const def = PROVIDERS[providerId];
  if (!def) return { error: true, message: 'Unknown provider: ' + providerId };
  const timeoutMs = longRunning ? LONG_TIMEOUT_MS : QUICK_TIMEOUT_MS;

  if (def.kind === 'cloudflare-ai') {
    const data = await readProviderData(env, providerId);
    const useModelFinal = data.activeModel || model || def.defaultModel;
    const r = await callCloudflareAI(env, useModelFinal, messages, def.maxOutputTokens, timeoutMs);
    return r.error ? r : { ...r, model: useModelFinal };
  }

  const data = await readProviderData(env, providerId);
  const pool = (data.keys || []).filter(k => k && k.key);
  if (pool.length === 0) return { error: true, message: `No API key set for ${def.label}. Add one in settings.` };
  const baseUrl = resolveBaseUrl(def, data);
  if (def.customBaseUrl && !baseUrl) {
    return { error: true, message: `Set your ${def.label} instance URL in settings before adding a key.` };
  }

  // Healthy keys first, in the order added; keys cooling down from a recent
  // failure only as a last resort (they rejoin automatically once rested).
  const now = Date.now();
  const healthy = pool.filter(k => !k.coolDownUntil || k.coolDownUntil <= now);
  const cooling = pool.filter(k => k.coolDownUntil && k.coolDownUntil > now);
  const orderedPool = [...healthy, ...cooling];

  let useModelFinal = model || data.activeModel || def.defaultModel;
  let lastError = null;
  let dataChanged = false;
  let triedFreeFallback = false;

  for (const entry of orderedPool) {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (def.kind === 'gemini') result = await callGemini(entry.key, useModelFinal, messages, def.maxOutputTokens, timeoutMs);
        else if (def.kind === 'anthropic') result = await callAnthropic(entry.key, useModelFinal, messages, def.maxOutputTokens, timeoutMs);
        else result = await callOpenAICompat(baseUrl, entry.key, useModelFinal, messages, def.maxOutputTokens, timeoutMs, def.extraHeaders);
      } catch (e) {
        result = { error: true, status: 0, message: e.message || 'Unexpected error talking to the provider.' };
      }
      // OpenRouter: the selected free model vanished -> swap in a currently
      // free one, once, instead of failing the whole request.
      const gone = result.error && def.freeFallback && !triedFreeFallback &&
        (result.status === 404 || /no endpoints|not a valid model|no longer available|model.*not found/i.test(result.message || ''));
      if (gone) {
        triedFreeFallback = true;
        const alt = await pickOpenRouterFreeModel(baseUrl, entry.key, useModelFinal);
        if (alt) { useModelFinal = alt; continue; }
      }
      break;
    }

    if (!result.error) {
      if (entry.coolDownUntil) { entry.coolDownUntil = null; dataChanged = true; }
      if (dataChanged) await writeProviderData(env, providerId, data);
      return { error: false, text: result.text, model: result.model || useModelFinal };
    }

    lastError = result;
    if (isFailoverError(result.status)) {
      entry.coolDownUntil = Date.now() + KEY_COOLDOWN_MS;
      dataChanged = true;
      continue;
    }
    break; // a real rejection (bad request etc) - retrying with another key won't help
  }

  if (dataChanged) await writeProviderData(env, providerId, data);
  return { error: true, message: lastError ? lastError.message : `All keys failed for ${def.label}` };
}

async function handleModels(env, providerId) {
  const def = PROVIDERS[providerId];
  if (!def) return { error: true, message: 'Unknown provider' };
  if (def.kind === 'cloudflare-ai') {
    return { error: false, models: ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/qwen/qwen2.5-coder-32b-instruct', '@cf/mistral/mistral-7b-instruct-v0.2'] };
  }
  const data = await readProviderData(env, providerId);
  const pool = (data.keys || []).filter(k => k && k.key);
  if (pool.length === 0) return { error: true, message: 'No key set' };
  const key = pool[0].key;
  const baseUrl = resolveBaseUrl(def, data);
  if (def.customBaseUrl && !baseUrl) return { error: true, message: `Set your ${def.label} instance URL in settings first.` };

  try {
    if (def.kind === 'gemini') {
      const { ok, json: j } = await fetchJSON(def.modelsUrl(key), undefined, 15000);
      if (!ok) return { error: true, message: 'Could not fetch models' };
      const ids = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
      return { error: false, models: ids };
    }
    if (def.freeFallback) { // OpenRouter: free models first, with flags for the UI
      const rows = await listOpenRouterModels(baseUrl, key);
      if (!rows) return { error: true, message: 'Could not fetch models' };
      const meta = {};
      rows.forEach(r => { meta[r.id] = { free: r.free, ctx: r.ctx }; });
      return { error: false, models: rows.map(r => r.id), meta };
    }
    if (def.kind === 'openai-compat') {
      const { ok, json: j } = await fetchJSON(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } }, 15000);
      if (!ok) return { error: true, message: 'Could not fetch models' };
      return { error: false, models: (j.data || []).map(m => m.id) };
    }
    return { error: false, models: [def.defaultModel] };
  } catch (e) {
    return { error: true, message: e.message };
  }
}

// ============================================================================
// shared chats (live)
// ============================================================================
// "share:<token>" = { title, messages, createdAt, updatedAt, rev }.
// The owner pushes updates to the SAME token (POST /api/share/update), each
// bumping `rev`; viewers poll GET /api/share/<token>?rev=<last> and get a tiny
// {unchanged:true} until something changes. Old links (no rev) keep working.
function sanitizeShareMessages(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5000).map(m => ({
    id: typeof m.id === 'string' ? m.id.slice(0, 60) : undefined,
    role: m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'ai'),
    nickname: m.nickname ? String(m.nickname).slice(0, 60) : null,
    content: String(m.content == null ? '' : m.content),
    t: Number(m.t) || undefined,
    files: Array.isArray(m.files) ? m.files.slice(0, 20).map(f => String(f).slice(0, 120)) : undefined
  }));
}

// ============================================================================
// encrypted sync storage
// ============================================================================
// Items are opaque ciphertext blobs the browser encrypted. Each item is one KV
// key "sync:i:<id>" (id like "s:<sessionId>", "a:<attachmentId>", "k:settings")
// with small plaintext metadata {v,d,s,t,dev} (version token, deleted flag,
// size, write time, writer device) so the manifest can be listed WITHOUT
// reading any values. If an R2 bucket is bound as WORKSPACE_R2, attachments
// ("a:" items) go there instead (10 GB free vs KV's 1 GB) - optional.
const ITEM_ID_RE = /^[sak]:[A-Za-z0-9_.-]{1,100}$/;
const useR2 = (env, id) => !!env.WORKSPACE_R2 && id.startsWith('a:');

async function itemPut(env, id, body, meta) {
  if (useR2(env, id)) {
    await env.WORKSPACE_R2.put('sync/' + id, body, { customMetadata: meta });
  } else {
    await env.WORKSPACE_KV.put('sync:i:' + id, body, { metadata: meta });
  }
}
async function itemGet(env, id) {
  if (useR2(env, id)) {
    const o = await env.WORKSPACE_R2.get('sync/' + id);
    return o ? { value: await o.arrayBuffer(), meta: o.customMetadata || {} } : null;
  }
  const r = await env.WORKSPACE_KV.getWithMetadata('sync:i:' + id, 'arrayBuffer');
  return r.value ? { value: r.value, meta: r.metadata || {} } : null;
}
const shapeItem = (id, m) => ({ id, v: m.v || '0', d: m.d === '1' || m.d === 1 ? 1 : 0, s: Number(m.s) || 0, t: Number(m.t) || 0, dev: m.dev || '' });

// Cursor format: "kv:<kvCursor>" then "r2:<r2Cursor>" (only when R2 is bound).
async function itemList(env, cursor) {
  let phase = 'kv', inner;
  if (cursor) { const i = cursor.indexOf(':'); phase = cursor.slice(0, i); inner = cursor.slice(i + 1) || undefined; }
  if (phase === 'kv') {
    const r = await env.WORKSPACE_KV.list({ prefix: 'sync:i:', cursor: inner, limit: 1000 });
    const items = r.keys
      .map(k => ({ id: k.name.slice('sync:i:'.length), m: k.metadata || {} }))
      .filter(x => !env.WORKSPACE_R2 || !x.id.startsWith('a:'))
      .map(x => shapeItem(x.id, x.m));
    if (!r.list_complete) return { items, cursor: 'kv:' + r.cursor };
    return env.WORKSPACE_R2 ? { items, cursor: 'r2:' } : { items, cursor: null };
  }
  const r = await env.WORKSPACE_R2.list({ prefix: 'sync/', cursor: inner || undefined, limit: 1000, include: ['customMetadata'] });
  const items = r.objects.map(o => shapeItem(o.key.slice('sync/'.length), o.customMetadata || {}));
  return { items, cursor: r.truncated ? 'r2:' + r.cursor : null };
}

// ============================================================================
// router
// ============================================================================
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const reply = (data, status, extra) => json(data, status, origin, env, extra);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin, env) });

    try {
      // ---- public: read a shared chat (the token IS the credential) --------
      if (path.startsWith('/api/share/') && request.method === 'GET' && path !== '/api/share/revoke' && path !== '/api/share/update') {
        const token = path.split('/').pop();
        if (!/^[A-Za-z0-9_-]{16,80}$/.test(token)) return reply({ error: true, message: 'This link has expired or is invalid.' }, 404);
        const raw = await env.WORKSPACE_KV.get(`share:${token}`);
        if (!raw) return reply({ error: true, code: 'gone', message: 'This link has expired or is invalid.' }, 404);
        const s = JSON.parse(raw);
        const rev = s.rev || 1;
        if (Number(url.searchParams.get('rev')) === rev) return reply({ error: false, unchanged: true, rev });
        return reply({ error: false, session: { title: s.title, messages: s.messages, createdAt: s.createdAt, updatedAt: s.updatedAt || s.createdAt, rev } });
      }

      // ---- public: build number (so the stale-deploy warning always works) -
      if (path === '/api/version' && request.method === 'GET') return reply({ build: WORKER_BUILD, r2: !!env.WORKSPACE_R2 });

      // ---- public: redeem a one-time pairing code -> device credentials ----
      if (path === '/api/pair/redeem' && request.method === 'POST') {
        if (await isLockedOut(env, request)) return reply({ error: true, code: 'locked_out', message: 'Too many wrong attempts from this network. Try again in about 15 minutes.' }, 429);
        const globalRaw = await env.WORKSPACE_KV.get('pairfail');
        const globalFails = globalRaw ? (JSON.parse(globalRaw).n || 0) : 0;
        if (globalFails >= PAIR_GLOBAL_FAIL_LIMIT) return reply({ error: true, code: 'pairing_paused', message: 'Pairing is paused for a few minutes after too many wrong codes. Generate a fresh code and try again shortly.' }, 429);

        const body = await request.json().catch(() => ({}));
        const code = normalizePairCode(body.code);
        const rec = code.length === 8 ? await env.WORKSPACE_KV.get(`pair:${await sha256Hex('pair:' + code)}`) : null;
        if (!rec) {
          await recordAuthFailure(env, request);
          await env.WORKSPACE_KV.put('pairfail', JSON.stringify({ n: globalFails + 1 }), { expirationTtl: PAIR_GLOBAL_WINDOW_S });
          return reply({ error: true, code: 'bad_code', message: 'That code is wrong or has expired. Codes last 5 minutes and work once.' }, 404);
        }
        await env.WORKSPACE_KV.delete(`pair:${await sha256Hex('pair:' + code)}`); // single use

        const deviceId = 'dev_' + bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
        const deviceToken = randomToken(32); // 256-bit
        const name = String(body.name || 'New device').slice(0, 60);
        await env.WORKSPACE_KV.put(`device:${deviceId}`, JSON.stringify({
          name, description: String(body.description || '').slice(0, 60), tokenHash: await sha256Hex(deviceToken), createdAt: Date.now()
        }));
        const idxRaw = await env.WORKSPACE_KV.get('deviceIndex');
        const idx = idxRaw ? JSON.parse(idxRaw) : [];
        idx.push(deviceId);
        await env.WORKSPACE_KV.put('deviceIndex', JSON.stringify(idx));

        const vaultRaw = await env.WORKSPACE_KV.get('sync:vault');
        return reply({ ok: true, deviceId, deviceToken, name, vault: vaultRaw ? JSON.parse(vaultRaw) : null, build: WORKER_BUILD });
      }

      // ---- everything else under /api/ needs credentials -------------------
      let auth = null;
      if (path.startsWith('/api/')) {
        const r = await authenticate(request, env);
        if (r.response) return reply(r.response.body, r.response.status);
        auth = r.auth;
      }
      const owner = !!(auth && auth.role === 'owner');
      const deny = (d) => reply(d.body, d.status);

      if (path === '/api/whoami' && request.method === 'GET') {
        return reply({ role: auth.role, deviceId: auth.deviceId || null, name: auth.name || null });
      }

      if (path === '/api/providers' && request.method === 'GET') {
        const safe = {};
        for (const [id, def] of Object.entries(PROVIDERS)) {
          safe[id] = { label: def.label, defaultModel: def.defaultModel, refill: def.refill, signupUrl: def.signupUrl, kind: def.kind, customBaseUrl: !!def.customBaseUrl };
        }
        return reply(safe);
      }

      // ---- devices ---------------------------------------------------------
      if (path === '/api/devices/ping' && request.method === 'POST') {
        const deviceId = auth.deviceId || 'unknown';
        const body = await request.json().catch(() => ({}));
        const raw = await env.WORKSPACE_KV.get('devices');
        const devices = raw ? JSON.parse(raw) : {};
        const description = String(body.description || 'Unknown device').slice(0, 60);
        const prev = devices[deviceId];
        if (prev && prev.description === description && Date.now() - prev.lastSeen < PRESENCE_MIN_INTERVAL_MS) return reply({ ok: true, skipped: true });
        devices[deviceId] = { description, lastSeen: Date.now() };
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const id of Object.keys(devices)) if (devices[id].lastSeen < cutoff) delete devices[id];
        await env.WORKSPACE_KV.put('devices', JSON.stringify(devices));
        return reply({ ok: true });
      }
      if (path === '/api/devices' && request.method === 'GET') {
        const presenceRaw = await env.WORKSPACE_KV.get('devices');
        const presence = presenceRaw ? JSON.parse(presenceRaw) : {};
        const idxRaw = await env.WORKSPACE_KV.get('deviceIndex');
        const idx = idxRaw ? JSON.parse(idxRaw) : [];
        const list = [];
        for (const id of idx) {
          const raw = await env.WORKSPACE_KV.get(`device:${id}`);
          if (!raw) continue;
          const d = JSON.parse(raw);
          list.push({ id, kind: 'paired', name: d.name, description: (presence[id] && presence[id].description) || d.description || '', createdAt: d.createdAt, lastSeen: presence[id] ? presence[id].lastSeen : d.createdAt, isThisDevice: id === auth.deviceId });
        }
        for (const [id, p] of Object.entries(presence)) {
          if (idx.includes(id)) continue;
          list.push({ id, kind: 'pin', name: p.description, description: p.description, createdAt: null, lastSeen: p.lastSeen, isThisDevice: id === auth.deviceId });
        }
        list.sort((a, b) => b.lastSeen - a.lastSeen);
        return reply({ devices: list, role: auth.role });
      }
      if (path === '/api/devices/revoke' && request.method === 'POST') {
        if (!owner) return deny(needOwner());
        const body = await request.json().catch(() => ({}));
        const id = String(body.id || '');
        if (!/^dev_[A-Za-z0-9]{8,40}$/.test(id)) return reply({ error: true, message: 'Bad device id' }, 400);
        await env.WORKSPACE_KV.delete(`device:${id}`);
        const idxRaw = await env.WORKSPACE_KV.get('deviceIndex');
        if (idxRaw) await env.WORKSPACE_KV.put('deviceIndex', JSON.stringify(JSON.parse(idxRaw).filter(x => x !== id)));
        const pRaw = await env.WORKSPACE_KV.get('devices');
        if (pRaw) { const p = JSON.parse(pRaw); delete p[id]; await env.WORKSPACE_KV.put('devices', JSON.stringify(p)); }
        return reply({ ok: true });
      }
      if (path === '/api/pair/create' && request.method === 'POST') {
        if (!owner) return deny(needOwner());
        const code = makePairCode();
        await env.WORKSPACE_KV.put(`pair:${await sha256Hex('pair:' + code)}`, JSON.stringify({ createdAt: Date.now() }), { expirationTtl: PAIR_TTL_S });
        return reply({ ok: true, code: code.slice(0, 4) + '-' + code.slice(4), expiresInSeconds: PAIR_TTL_S });
      }

      // ---- provider keys ---------------------------------------------------
      if (path === '/api/keys' && request.method === 'GET') {
        const safe = {};
        const now = Date.now();
        for (const id of Object.keys(PROVIDERS)) {
          const data = await readProviderData(env, id);
          safe[id] = {
            keys: (data.keys || []).map(k => ({ label: k.label || '', resting: !!(k.coolDownUntil && k.coolDownUntil > now), restingForMs: k.coolDownUntil && k.coolDownUntil > now ? k.coolDownUntil - now : 0 })),
            activeModel: data.activeModel || null,
            baseUrl: data.baseUrl || null
          };
        }
        return reply(safe);
      }
      if (path === '/api/keys/add' && request.method === 'POST') {
        if (!owner) return deny(needOwner());
        const body = await request.json();
        if (!PROVIDERS[body.providerId]) return reply({ error: true, message: 'Unknown provider' }, 400);
        const data = await readProviderData(env, body.providerId);
        data.keys = data.keys || [];
        data.keys.push({ label: body.label || `key ${data.keys.length + 1}`, key: body.key || '' });
        await writeProviderData(env, body.providerId, data);
        return reply({ ok: true });
      }
      if (path === '/api/keys/remove' && request.method === 'POST') {
        if (!owner) return deny(needOwner());
        const body = await request.json();
        const data = await readProviderData(env, body.providerId);
        if (data.keys) data.keys.splice(body.index, 1);
        await writeProviderData(env, body.providerId, data);
        return reply({ ok: true });
      }
      if (path === '/api/keys/baseurl' && request.method === 'POST') {
        if (!owner) return deny(needOwner());
        const body = await request.json();
        if (!PROVIDERS[body.providerId] || !PROVIDERS[body.providerId].customBaseUrl) return reply({ error: true, message: 'This provider does not use a custom base URL' }, 400);
        const norm = normalizeCustomBaseUrl(body.baseUrl);
        if (norm.error) return reply({ error: true, message: norm.error }, 400);
        const data = await readProviderData(env, body.providerId);
        data.baseUrl = norm.url;
        await writeProviderData(env, body.providerId, data);
        return reply({ ok: true, baseUrl: norm.url });
      }
      if (path === '/api/keys/model' && request.method === 'POST') {
        const body = await request.json();
        const data = await readProviderData(env, body.providerId);
        data.activeModel = body.model;
        await writeProviderData(env, body.providerId, data);
        return reply({ ok: true });
      }
      if (path === '/api/models' && request.method === 'GET') {
        const result = await handleModels(env, url.searchParams.get('providerId'));
        return reply(result, result.error ? 400 : 200);
      }
      if (path === '/api/chat' && request.method === 'POST') {
        const body = await request.json();
        const result = await handleChat(env, body.providerId, body.model, body.messages || [], !!body.longRunning);
        return reply(result, result.error ? 400 : 200);
      }

      // ---- share management (owner side) ------------------------------------
      if (path === '/api/share' && request.method === 'POST') {
        const text = await request.text();
        if (text.length > MAX_SHARE_BYTES) return reply({ error: true, message: 'That session is too large to share as a link.' }, 413);
        const body = JSON.parse(text || '{}');
        const token = randomToken(32); // 256-bit, unguessable
        const now = Date.now();
        await env.WORKSPACE_KV.put(`share:${token}`, JSON.stringify({ title: String(body.title || 'Shared session').slice(0, 200), messages: sanitizeShareMessages(body.messages), createdAt: now, updatedAt: now, rev: 1 }));
        return reply({ ok: true, token, rev: 1 });
      }
      if (path === '/api/share/update' && request.method === 'POST') {
        const text = await request.text();
        if (text.length > MAX_SHARE_BYTES) return reply({ error: true, message: 'That session is too large to share as a link.' }, 413);
        const body = JSON.parse(text || '{}');
        if (!/^[A-Za-z0-9_-]{16,80}$/.test(String(body.token || ''))) return reply({ error: true, message: 'Bad token' }, 400);
        const raw = await env.WORKSPACE_KV.get(`share:${body.token}`);
        if (!raw) return reply({ error: true, code: 'gone', message: 'That share link no longer exists.' }, 404);
        const s = JSON.parse(raw);
        s.title = String(body.title || s.title).slice(0, 200);
        s.messages = sanitizeShareMessages(body.messages);
        s.updatedAt = Date.now();
        s.rev = (s.rev || 1) + 1;
        await env.WORKSPACE_KV.put(`share:${body.token}`, JSON.stringify(s));
        return reply({ ok: true, rev: s.rev });
      }
      if (path === '/api/share/revoke' && request.method === 'POST') {
        const body = await request.json();
        await env.WORKSPACE_KV.delete(`share:${body.token}`);
        return reply({ ok: true });
      }

      // ---- encrypted sync ---------------------------------------------------
      if (path === '/api/sync/status' && request.method === 'GET') {
        const [vault, head] = await Promise.all([env.WORKSPACE_KV.get('sync:vault'), env.WORKSPACE_KV.get('sync:head')]);
        return reply({ vault: vault ? JSON.parse(vault) : null, head: head || null, r2: !!env.WORKSPACE_R2, build: WORKER_BUILD, role: auth.role });
      }
      if (path === '/api/sync/vault' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const v = body.vault;
        const okShape = v && v.kdf && typeof v.kdf.salt === 'string' && v.kdf.salt.length <= 64 && Number.isInteger(v.kdf.iterations) &&
          v.kdf.iterations >= 100000 && v.kdf.iterations <= 5000000 && typeof v.verifier === 'string' && v.verifier.length <= 400;
        if (!okShape) return reply({ error: true, message: 'Bad vault description' }, 400);
        const existing = await env.WORKSPACE_KV.get('sync:vault');
        if (existing) return reply({ error: true, code: 'vault_exists', message: 'This workspace already has an encrypted vault.', vault: JSON.parse(existing) }, 409);
        const stored = { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: v.kdf.iterations, salt: v.kdf.salt }, verifier: v.verifier, createdAt: Date.now() };
        await env.WORKSPACE_KV.put('sync:vault', JSON.stringify(stored));
        return reply({ ok: true, vault: stored });
      }
      if (path === '/api/sync/head' && request.method === 'GET') {
        // `salt` identifies the vault (it is public, not secret). If another
        // device wipes the cloud data and starts a new vault, clients notice the
        // salt changed instead of writing data encrypted under the old key.
        const [head, vault] = await Promise.all([env.WORKSPACE_KV.get('sync:head'), env.WORKSPACE_KV.get('sync:vault')]);
        return reply({ head: head || null, salt: vault ? JSON.parse(vault).kdf.salt : null });
      }
      if (path === '/api/sync/commit' && request.method === 'POST') {
        const head = randomToken(9);
        await env.WORKSPACE_KV.put('sync:head', head);
        return reply({ ok: true, head });
      }
      if (path === '/api/sync/list' && request.method === 'GET') {
        return reply(await itemList(env, url.searchParams.get('cursor') || ''));
      }
      if (path === '/api/sync/item' && request.method === 'GET') {
        const id = url.searchParams.get('id') || '';
        if (!ITEM_ID_RE.test(id)) return reply({ error: true, message: 'Bad item id' }, 400);
        const item = await itemGet(env, id);
        if (!item) return reply({ error: true, code: 'gone', message: 'No such item' }, 404);
        return new Response(item.value, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Item-Version': item.meta.v || '', ...corsHeaders(origin, env), 'Access-Control-Expose-Headers': 'X-Item-Version' } });
      }
      if (path === '/api/sync/item' && request.method === 'PUT') {
        const id = url.searchParams.get('id') || '';
        const v = (url.searchParams.get('v') || '').slice(0, 80);
        if (!ITEM_ID_RE.test(id) || !/^\d+\.dev_[A-Za-z0-9]{1,40}$|^\d+\.local$/.test(v)) return reply({ error: true, message: 'Bad item id or version' }, 400);
        const body = await request.arrayBuffer();
        if (body.byteLength > MAX_ITEM_BYTES) return reply({ error: true, code: 'too_large', message: 'That item is too large to sync (limit ~24 MB per item).' }, 413);
        const deleted = url.searchParams.get('d') === '1';
        await itemPut(env, id, deleted ? new Uint8Array([0]) : body, { v, d: deleted ? '1' : '0', s: String(deleted ? 0 : body.byteLength), t: String(Date.now()), dev: auth.deviceId || '' });
        return reply({ ok: true, id, v });
      }
      if (path === '/api/sync/reset' && request.method === 'POST') {
        if (!owner) return deny(needOwner());
        const body = await request.json().catch(() => ({}));
        if (body.confirm !== 'DELETE') return reply({ error: true, message: 'Confirmation missing' }, 400);
        // Each KV delete counts against the free 1000 writes/day, so wipe in
        // slices and let the client call again while `done` is false.
        let deleted = 0, cursor = '';
        while (deleted < 800) {
          const page = await itemList(env, cursor);
          if (!page.items.length && !page.cursor) break;
          for (const it of page.items) {
            if (deleted >= 800) break;
            if (useR2(env, it.id)) await env.WORKSPACE_R2.delete('sync/' + it.id);
            else await env.WORKSPACE_KV.delete('sync:i:' + it.id);
            deleted++;
          }
          if (deleted >= 800 || !page.cursor) break;
          cursor = page.cursor;
        }
        // "done" = no item left in ANY store (KV, plus R2 when bound). A page can be
        // empty while more pages/stores remain, so walk cursors until we either
        // find an item or run out.
        let left = false, cur = '';
        do { const pg = await itemList(env, cur); if (pg.items.length) { left = true; break; } cur = pg.cursor; } while (cur);
        const done = !left;
        if (done) { await env.WORKSPACE_KV.delete('sync:vault'); await env.WORKSPACE_KV.delete('sync:head'); }
        return reply({ ok: true, deleted, done });
      }

      if (path.startsWith('/api/')) return reply({ error: true, message: 'not found' }, 404);
      return reply({ error: true, message: 'not found' }, 404);
    } catch (e) {
      if (isQuotaError(e)) return reply({ error: true, code: 'quota', message: 'Cloudflare free-tier daily limit reached (KV allows 1,000 writes/day). Try again after 00:00 UTC.' }, 503);
      return reply({ error: true, message: e.message || 'Unexpected server error' }, 500);
    }
  }
};
