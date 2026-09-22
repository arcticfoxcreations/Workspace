import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PIN = 'Correct-Horse 42!';            // letters + digits + symbols + space
let upstreamLog = [];
let upstream = async (req) => new Response('{}', { status: 404 });

async function make(withR2) {
  return new Miniflare({
    modules: true,
    script: fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8'),
    kvNamespaces: ['WORKSPACE_KV'],
    r2Buckets: withR2 ? ['WORKSPACE_R2'] : [],
    bindings: { APP_PASSWORD: PIN },
    compatibilityDate: '2026-07-01',
    outboundService: async (req) => { upstreamLog.push(req.method + ' ' + req.url); return upstream(req); }
  });
}
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}

const mf = await make(false);
const call = async (path, { method = 'GET', headers = {}, body, pin = PIN, ip = '1.1.1.1', raw } = {}) => {
  const h = { 'CF-Connecting-IP': ip, 'X-Device-Id': 'dev_test0000aa', ...headers };
  if (pin) h['X-App-Password'] = pin;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await mf.dispatchFetch('http://w.test' + path, { method, headers: h, body: raw ? body : (body !== undefined ? JSON.stringify(body) : undefined) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, json: ct.includes('json') ? await res.json() : null, buf: ct.includes('octet') ? new Uint8Array(await res.arrayBuffer()) : null };
};

console.log('== auth');
await t('version is public and matches build', async () => { const r = await call('/api/version', { pin: '' }); assert.equal(r.status, 200); assert.equal(r.json.build, '2026-09-20.3'); });
await t('no credentials -> 401 without counting as an attempt', async () => { for (let i = 0; i < 15; i++) { const r = await call('/api/whoami', { pin: '', ip: '9.9.9.9' }); assert.equal(r.status, 401); } const ok = await call('/api/whoami', { ip: '9.9.9.9' }); assert.equal(ok.status, 200); });
await t('PIN with letters/digits/symbols/space authenticates as owner', async () => { const r = await call('/api/whoami'); assert.equal(r.status, 200); assert.equal(r.json.role, 'owner'); });
await t('wrong PIN -> 401; 10 wrong -> 429 lockout, even for the right PIN from that IP', async () => {
  for (let i = 0; i < 10; i++) { const r = await call('/api/whoami', { pin: 'nope' + i, ip: '2.2.2.2' }); assert.equal(r.status, 401); }
  const locked = await call('/api/whoami', { pin: 'nope', ip: '2.2.2.2' }); assert.equal(locked.status, 429);
  const stillLocked = await call('/api/whoami', { ip: '2.2.2.2' }); assert.equal(stillLocked.status, 429);
  const other = await call('/api/whoami', { ip: '3.3.3.3' }); assert.equal(other.status, 200);
});

console.log('== pairing + devices');
let dev; // { deviceId, deviceToken }
const asDevice = (p, o = {}) => call(p, { ...o, pin: '', headers: { 'X-Device-Id': dev.deviceId, 'X-Device-Token': dev.deviceToken, ...(o.headers || {}) } });
await t('pair/create is owner-only', async () => { const r = await call('/api/pair/create', { method: 'POST', pin: 'wrong', ip: '4.4.4.4' }); assert.equal(r.status, 401); });
let code;
await t('owner creates 8-char code (XXXX-XXXX, unambiguous alphabet), 5 min TTL', async () => {
  const r = await call('/api/pair/create', { method: 'POST' });
  assert.equal(r.status, 200); code = r.json.code; assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/); assert.equal(r.json.expiresInSeconds, 300);
});
await t('wrong code -> 404 bad_code', async () => { const r = await call('/api/pair/redeem', { method: 'POST', pin: '', body: { code: 'ZZZZ-ZZZZ' }, ip: '5.5.5.5' }); assert.equal(r.status, 404); assert.equal(r.json.code, 'bad_code'); });
await t('right code redeems once; returns token, vault=null; second use fails', async () => {
  const r = await call('/api/pair/redeem', { method: 'POST', pin: '', body: { code: code.toLowerCase().replace('-', ' '), name: 'Phone' }, ip: '6.6.6.6' });
  assert.equal(r.status, 200); assert.match(r.json.deviceId, /^dev_[0-9a-f]{16}$/); assert.ok(r.json.deviceToken.length >= 40); assert.equal(r.json.vault, null);
  dev = r.json;
  const again = await call('/api/pair/redeem', { method: 'POST', pin: '', body: { code }, ip: '6.6.6.6' }); assert.equal(again.status, 404);
});
await t('token is stored only as a hash in KV', async () => {
  const kv = await mf.getKVNamespace('WORKSPACE_KV');
  const rec = JSON.parse(await kv.get('device:' + dev.deviceId));
  assert.ok(!JSON.stringify(rec).includes(dev.deviceToken)); assert.match(rec.tokenHash, /^[0-9a-f]{64}$/);
});
await t('device token can use the app but is not owner', async () => {
  const w = await asDevice('/api/whoami'); assert.equal(w.status, 200); assert.equal(w.json.role, 'device');
  const p = await asDevice('/api/providers'); assert.equal(p.status, 200);
});
await t('device cannot add provider keys, create pairing codes, revoke, or wipe cloud (403 owner_required)', async () => {
  for (const [path, body] of [['/api/keys/add', { providerId: 'groq', key: 'x' }], ['/api/pair/create'], ['/api/devices/revoke', { id: 'dev_abcdefgh12' }], ['/api/sync/reset', { confirm: 'DELETE' }]]) {
    const r = await asDevice(path, { method: 'POST', body: body || {} }); assert.equal(r.status, 403, path); assert.equal(r.json.code, 'owner_required');
  }
});
await t('wrong device token -> 401 and counts toward lockout', async () => {
  const r = await call('/api/whoami', { pin: '', ip: '7.7.7.7', headers: { 'X-Device-Id': dev.deviceId, 'X-Device-Token': 'x'.repeat(43) } }); assert.equal(r.status, 401); assert.equal(r.json.code, 'unauthorized');
});
await t('device list shows paired device; owner revokes; token then rejected as device_revoked', async () => {
  const l = await call('/api/devices'); assert.ok(l.json.devices.some(d => d.id === dev.deviceId && d.kind === 'paired'));
  const rv = await call('/api/devices/revoke', { method: 'POST', body: { id: dev.deviceId } }); assert.equal(rv.status, 200);
  const r = await asDevice('/api/whoami'); assert.equal(r.status, 401); assert.equal(r.json.code, 'device_revoked');
});
await t('global pairing brake: 20 wrong codes from many IPs pauses redemption', async () => {
  const fresh = await call('/api/pair/create', { method: 'POST' });
  let paused = false;
  for (let i = 0; i < 25; i++) { const r = await call('/api/pair/redeem', { method: 'POST', pin: '', body: { code: 'QQQQ-' + String(1000 + i).replace(/[01]/g, '2') }, ip: `10.0.0.${i}` }); if (r.status === 429 && r.json.code === 'pairing_paused') { paused = true; break; } }
  assert.ok(paused, 'expected pairing_paused');
  const r = await call('/api/pair/redeem', { method: 'POST', pin: '', body: { code: fresh.json.code }, ip: '10.9.9.9' }); assert.equal(r.status, 429);
});

console.log('== encrypted sync storage');
const blob = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = i % 251; return b; };
await t('vault: shape validated, create once, second create -> 409 with existing', async () => {
  const bad = await call('/api/sync/vault', { method: 'POST', body: { vault: { kdf: { salt: 'x', iterations: 10 }, verifier: 'y' } } }); assert.equal(bad.status, 400);
  const v = { kdf: { salt: 'c2FsdHNhbHRzYWx0MTY=', iterations: 600000 }, verifier: 'dmVyaWZpZXI=' };
  const ok = await call('/api/sync/vault', { method: 'POST', body: { vault: v } }); assert.equal(ok.status, 200);
  const dup = await call('/api/sync/vault', { method: 'POST', body: { vault: v } }); assert.equal(dup.status, 409); assert.equal(dup.json.code, 'vault_exists');
  const st = await call('/api/sync/status'); assert.equal(st.json.vault.kdf.iterations, 600000);
});
await t('put/list/get roundtrip is byte-exact, metadata visible in list (no value reads)', async () => {
  const data = blob(5000);
  const p = await call('/api/sync/item?id=' + encodeURIComponent('s:sess_abc') + '&v=1.dev_test0000aa', { method: 'PUT', body: data, raw: true, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(p.status, 200);
  const l = await call('/api/sync/list'); const it = l.json.items.find(i => i.id === 's:sess_abc');
  assert.deepEqual([it.v, it.d, it.s], ['1.dev_test0000aa', 0, 5000]);
  const g = await call('/api/sync/item?id=' + encodeURIComponent('s:sess_abc')); assert.deepEqual([...g.buf], [...data]);
});
await t('tombstone put marks deleted and drops the payload', async () => {
  await call('/api/sync/item?id=' + encodeURIComponent('a:att_1') + '&v=1.dev_test0000aa', { method: 'PUT', body: blob(100), raw: true, headers: { 'Content-Type': 'application/octet-stream' } });
  await call('/api/sync/item?id=' + encodeURIComponent('a:att_1') + '&v=2.dev_test0000aa&d=1', { method: 'PUT', body: new Uint8Array([0]), raw: true, headers: { 'Content-Type': 'application/octet-stream' } });
  const it = (await call('/api/sync/list')).json.items.find(i => i.id === 'a:att_1'); assert.deepEqual([it.d, it.s, it.v], [1, 0, '2.dev_test0000aa']);
});
await t('bad ids / versions rejected; >24MB rejected', async () => {
  for (const q of ['id=x:bad&v=1.dev_test0000aa', 'id=' + encodeURIComponent('s:../../x') + '&v=1.dev_test0000aa', 'id=' + encodeURIComponent('s:ok') + '&v=abc']) {
    const r = await call('/api/sync/item?' + q, { method: 'PUT', body: blob(10), raw: true }); assert.equal(r.status, 400, q);
  }
  const big = await call('/api/sync/item?id=' + encodeURIComponent('s:big') + '&v=1.dev_test0000aa', { method: 'PUT', body: new Uint8Array(24 * 1024 * 1024 + 1), raw: true }); assert.equal(big.status, 413);
});
await t('head changes on commit; unauthenticated sync access refused', async () => {
  const h0 = (await call('/api/sync/head')).json.head; const c = await call('/api/sync/commit', { method: 'POST' }); const h1 = (await call('/api/sync/head')).json.head;
  assert.notEqual(h0, h1); assert.equal(h1, c.json.head); assert.equal((await call('/api/sync/head')).json.salt, 'c2FsdHNhbHRzYWx0MTY=');
  const r = await call('/api/sync/list', { pin: '', ip: '8.8.8.8' }); assert.equal(r.status, 401);
});
await t('paged list (1000+ items) is complete', async () => {
  const kv = await mf.getKVNamespace('WORKSPACE_KV');
  for (let i = 0; i < 1100; i++) await kv.put('sync:i:s:bulk' + i, new Uint8Array([1]), { metadata: { v: '1.dev_x', d: '0', s: '1', t: '1', dev: 'dev_x' } });
  let cursor = '', n = 0, pages = 0; do { const r = await call('/api/sync/list' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')); n += r.json.items.length; cursor = r.json.cursor; pages++; } while (cursor);
  assert.ok(n >= 1100 && pages >= 2, `n=${n} pages=${pages}`);
});
await t('reset (owner, confirm) wipes items + vault + head in slices', async () => {
  const no = await call('/api/sync/reset', { method: 'POST', body: {} }); assert.equal(no.status, 400);
  let done = false, guard = 0; while (!done && guard++ < 10) { const r = await call('/api/sync/reset', { method: 'POST', body: { confirm: 'DELETE' } }); assert.equal(r.status, 200); done = r.json.done; }
  assert.ok(done); const st = await call('/api/sync/status'); assert.equal(st.json.vault, null); assert.equal((await call('/api/sync/list')).json.items.length, 0);
});

console.log('== live shared chats');
let token;
await t('share create returns 256-bit token; public GET needs no auth', async () => {
  const c = await call('/api/share', { method: 'POST', body: { title: 'T', messages: [{ id: 'm1', role: 'user', content: 'hi', t: 1 }, { id: 'm2', role: 'ai', nickname: 'Gemini', content: 'hello' }] } });
  token = c.json.token; assert.ok(token.length >= 43); assert.equal(c.json.rev, 1);
  const g = await call('/api/share/' + token, { pin: '' }); assert.equal(g.status, 200); assert.equal(g.json.session.messages.length, 2); assert.equal(g.json.session.rev, 1);
});
await t('rev polling: unchanged -> tiny reply; owner update bumps rev; viewer sees new message', async () => {
  const same = await call('/api/share/' + token + '?rev=1', { pin: '' }); assert.equal(same.json.unchanged, true); assert.equal(same.json.session, undefined);
  const u = await call('/api/share/update', { method: 'POST', body: { token, title: 'T2', messages: [{ id: 'm1', role: 'user', content: 'hi' }, { id: 'm2', role: 'ai', nickname: 'Gemini', content: 'hello' }, { id: 'm3', role: 'user', content: 'third' }] } });
  assert.equal(u.json.rev, 2);
  const n = await call('/api/share/' + token + '?rev=1', { pin: '' }); assert.equal(n.json.session.messages.length, 3); assert.equal(n.json.session.title, 'T2'); assert.equal(n.json.session.rev, 2);
  const s2 = await call('/api/share/' + token + '?rev=2', { pin: '' }); assert.equal(s2.json.unchanged, true);
});
await t('a device token can update a share; nothing else about the workspace leaks in the payload', async () => {
  const kv = await mf.getKVNamespace('WORKSPACE_KV'); const stored = JSON.parse(await kv.get('share:' + token));
  assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'messages', 'rev', 'title', 'updatedAt']);
});
await t('update of unknown token -> 404 gone; garbage token -> 404; revoke -> viewer gets 404', async () => {
  const u = await call('/api/share/update', { method: 'POST', body: { token: 'A'.repeat(43), messages: [] } }); assert.equal(u.status, 404); assert.equal(u.json.code, 'gone');
  assert.equal((await call('/api/share/short', { pin: '' })).status, 404);
  await call('/api/share/revoke', { method: 'POST', body: { token } });
  const g = await call('/api/share/' + token, { pin: '' }); assert.equal(g.status, 404); assert.equal(g.json.code, 'gone');
});
await t('legacy uuid-style token from the old snapshot design still readable', async () => {
  const kv = await mf.getKVNamespace('WORKSPACE_KV'); const legacy = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
  await kv.put('share:' + legacy, JSON.stringify({ title: 'Old', messages: [{ role: 'user', nickname: null, content: 'x' }], createdAt: 5 }));
  const g = await call('/api/share/' + legacy, { pin: '' }); assert.equal(g.status, 200); assert.equal(g.json.session.rev, 1);
});

console.log('== providers: OpenRouter free models, OmniRoute, timeouts');
const okChat = (model, text = 'pong') => new Response(JSON.stringify({ model, choices: [{ message: { content: text } }] }), { status: 200 });
await t('OmniRoute requires https base URL, rejects creds-in-URL, defaults path to /v1', async () => {
  for (const bad of ['http://x.example', 'ftp://x', 'not a url', 'https://u:p@x.example']) { const r = await call('/api/keys/baseurl', { method: 'POST', body: { providerId: 'omniroute', baseUrl: bad } }); assert.equal(r.status, 400, bad); }
  const r = await call('/api/keys/baseurl', { method: 'POST', body: { providerId: 'omniroute', baseUrl: 'https://omni.example.com/' } }); assert.equal(r.json.baseUrl, 'https://omni.example.com/v1');
  const n = await call('/api/keys/baseurl', { method: 'POST', body: { providerId: 'groq', baseUrl: 'https://x.example' } }); assert.equal(n.status, 400);
});
await t('OmniRoute chat hits <instance>/v1/chat/completions with bearer key and reports the model used', async () => {
  await call('/api/keys/add', { method: 'POST', body: { providerId: 'omniroute', label: 'k', key: 'omni-secret' } });
  let seen; upstream = async (req) => { seen = { url: req.url, auth: req.headers.get('authorization'), body: await req.json() }; return okChat('routed/model-x'); };
  const r = await call('/api/chat', { method: 'POST', body: { providerId: 'omniroute', messages: [{ role: 'user', content: 'ping' }] } });
  assert.equal(r.status, 200); assert.equal(r.json.text, 'pong'); assert.equal(r.json.model, 'routed/model-x');
  assert.equal(seen.url, 'https://omni.example.com/v1/chat/completions'); assert.equal(seen.auth, 'Bearer omni-secret'); assert.equal(seen.body.model, 'auto'); assert.ok(seen.body.max_completion_tokens);
});
await t('key listing never returns key material', async () => { const r = await call('/api/keys'); assert.ok(!JSON.stringify(r.json).includes('omni-secret')); });
await t('max_completion_tokens -> max_tokens fallback when a provider rejects the modern name', async () => {
  let n = 0; const bodies = []; upstream = async (req) => { const b = await req.json(); bodies.push(Object.keys(b)); n++; return n === 1 ? new Response(JSON.stringify({ error: { message: 'Unsupported parameter: max_completion_tokens; use max_tokens' } }), { status: 400 }) : okChat('m'); };
  const r = await call('/api/chat', { method: 'POST', body: { providerId: 'omniroute', messages: [{ role: 'user', content: 'x' }] } }); assert.equal(r.status, 200);
  assert.ok(bodies[0].includes('max_completion_tokens') && bodies[1].includes('max_tokens'));
});
await t('OpenRouter: dead model -> live free-model lookup -> retry, response names the model actually used', async () => {
  await call('/api/keys/add', { method: 'POST', body: { providerId: 'openrouter', label: 'k', key: 'or-secret' } });
  await call('/api/keys/model', { method: 'POST', body: { providerId: 'openrouter', model: 'some/dead-model:free' } });
  const calls = [];
  upstream = async (req) => {
    calls.push(req.url);
    if (req.url.endsWith('/models')) return new Response(JSON.stringify({ data: [
      { id: 'paid/big', context_length: 1000000, pricing: { prompt: '0.001', completion: '0.002' }, architecture: { output_modalities: ['text'] } },
      { id: 'free/small:free', context_length: 8000, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
      { id: 'free/large:free', context_length: 128000, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
      { id: 'img/gen:free', context_length: 999999, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['image'] } }] }), { status: 200 });
    const b = await req.json();
    return b.model === 'some/dead-model:free' ? new Response(JSON.stringify({ error: { message: 'No endpoints found for some/dead-model:free' } }), { status: 404 }) : okChat(b.model, 'alive');
  };
  const r = await call('/api/chat', { method: 'POST', body: { providerId: 'openrouter', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(r.status, 200); assert.equal(r.json.text, 'alive'); assert.equal(r.json.model, 'free/large:free');
});
await t('OpenRouter model list: free first (largest context first), flags in meta, text-output only', async () => {
  const r = await call('/api/models?providerId=openrouter'); assert.deepEqual(r.json.models.slice(0, 2), ['free/large:free', 'free/small:free']);
  assert.equal(r.json.meta['free/large:free'].free, true); assert.equal(r.json.meta['paid/big'].free, false); assert.ok(!r.json.models.includes('img/gen:free'));
});
await t('OpenRouter sends the X-Title attribution header', async () => {
  let h; upstream = async (req) => { h = req.headers.get('x-title'); return okChat('m'); };
  await call('/api/keys/model', { method: 'POST', body: { providerId: 'openrouter', model: 'free/large:free' } });
  await call('/api/chat', { method: 'POST', body: { providerId: 'openrouter', messages: [{ role: 'user', content: 'x' }] } }); assert.equal(h, 'AI Workspace');
});
await t('429 on one key fails over to the next key; the failed key is put on cooldown', async () => {
  await call('/api/keys/add', { method: 'POST', body: { providerId: 'groq', label: 'a', key: 'gk-a' } });
  await call('/api/keys/add', { method: 'POST', body: { providerId: 'groq', label: 'b', key: 'gk-b' } });
  upstream = async (req) => req.headers.get('authorization') === 'Bearer gk-a' ? new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }) : okChat('g');
  const r = await call('/api/chat', { method: 'POST', body: { providerId: 'groq', messages: [{ role: 'user', content: 'x' }] } }); assert.equal(r.status, 200);
  const keys = (await call('/api/keys')).json.groq.keys; assert.equal(keys[0].resting, true); assert.equal(keys[1].resting, false);
});
await t('quick chat times out at ~30s per key, long at ~58s (verified with fake timers is not possible in workerd; check constants instead)', async () => {
  const src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8'); assert.match(src, /QUICK_TIMEOUT_MS = 30000/); assert.match(src, /LONG_TIMEOUT_MS = 58000/); assert.match(src, /longRunning \? LONG_TIMEOUT_MS : QUICK_TIMEOUT_MS/);
});
await t('CORS preflight allows PUT + device headers', async () => {
  const res = await mf.dispatchFetch('http://w.test/api/sync/item', { method: 'OPTIONS', headers: { Origin: 'https://x.github.io' } });
  assert.match(res.headers.get('access-control-allow-methods'), /PUT/); assert.match(res.headers.get('access-control-allow-headers'), /X-Device-Token/);
});
await mf.dispose();

console.log('== R2-backed attachments (optional binding)');
const mf2 = await make(true);
const call2 = async (path, { method = 'GET', body, raw } = {}) => { const res = await mf2.dispatchFetch('http://w.test' + path, { method, headers: { 'X-App-Password': PIN, 'X-Device-Id': 'dev_test0000aa', ...(raw ? {} : { 'Content-Type': 'application/json' }) }, body: raw ? body : (body ? JSON.stringify(body) : undefined) }); const ct = res.headers.get('content-type') || ''; return { status: res.status, json: ct.includes('json') ? await res.json() : null, buf: ct.includes('octet') ? new Uint8Array(await res.arrayBuffer()) : null }; };
await t('a: items go to R2, s: items stay in KV, one merged list, roundtrip exact', async () => {
  const att = blob(3000), ses = blob(700);
  await call2('/api/sync/item?id=' + encodeURIComponent('a:att_r2') + '&v=1.dev_test0000aa', { method: 'PUT', body: att, raw: true });
  await call2('/api/sync/item?id=' + encodeURIComponent('s:sess_kv') + '&v=1.dev_test0000aa', { method: 'PUT', body: ses, raw: true });
  const r2 = await mf2.getR2Bucket('WORKSPACE_R2'); const kv = await mf2.getKVNamespace('WORKSPACE_KV');
  assert.ok(await r2.head('sync/a:att_r2')); assert.equal(await kv.get('sync:i:a:att_r2'), null); assert.notEqual(await kv.get('sync:i:s:sess_kv'), null);
  const l = (await call2('/api/sync/list')); let items = l.json.items, cur = l.json.cursor; while (cur) { const n = await call2('/api/sync/list?cursor=' + encodeURIComponent(cur)); items = items.concat(n.json.items); cur = n.json.cursor; }
  const ids = items.map(i => i.id).sort(); assert.deepEqual(ids, ['a:att_r2', 's:sess_kv']); assert.equal(items.find(i => i.id === 'a:att_r2').s, 3000);
  assert.deepEqual([...(await call2('/api/sync/item?id=' + encodeURIComponent('a:att_r2'))).buf], [...att]);
  const w = await call2('/api/sync/reset', { method: 'POST', body: { confirm: 'DELETE' } }); assert.ok(w.json.done); assert.equal(await r2.head('sync/a:att_r2'), null);
});
await mf2.dispose();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
