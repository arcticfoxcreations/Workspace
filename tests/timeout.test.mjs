import { Miniflare } from 'miniflare';
import fs from 'node:fs';
const PIN = 'pin';
const mf = new Miniflare({ modules: true, script: fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8'), kvNamespaces: ['WORKSPACE_KV'], bindings: { APP_PASSWORD: PIN }, compatibilityDate: '2026-07-01',
  outboundService: async (req) => { await new Promise(r => setTimeout(r, 33000)); return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: 'late but fine' } }] })); } });
const h = { 'X-App-Password': PIN, 'X-Device-Id': 'dev_test0000aa', 'Content-Type': 'application/json' };
await mf.dispatchFetch('http://w/api/keys/add', { method: 'POST', headers: h, body: JSON.stringify({ providerId: 'groq', key: 'k' }) });
const go = async (long) => { const t0 = Date.now(); const r = await mf.dispatchFetch('http://w/api/chat', { method: 'POST', headers: h, body: JSON.stringify({ providerId: 'groq', longRunning: long, messages: [{ role: 'user', content: 'x' }] }) }); return { long, status: r.status, body: await r.json(), secs: ((Date.now() - t0) / 1000).toFixed(1) }; };
const [quick, long] = await Promise.all([go(false), go(true)]);
console.log('quick :', quick.secs + 's', quick.status, JSON.stringify(quick.body).slice(0, 110));
console.log('long  :', long.secs + 's', long.status, JSON.stringify(long.body).slice(0, 110));
const ok = quick.status === 400 && /Timed out/.test(quick.body.message) && Number(quick.secs) >= 29 && Number(quick.secs) < 33 && long.status === 200 && long.body.text === 'late but fine';
console.log(ok ? 'PASS: quick=30s cut-off, long tolerates 33s' : 'FAIL');
await mf.dispose(); process.exit(ok ? 0 : 1);
