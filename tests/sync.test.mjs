import assert from 'node:assert/strict';
import { Device, makeWorker, PIN, sleep } from './harness.mjs';

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).split('\n').slice(0, 5).join('\n       ')); }
}
const PASS = 'correct horse battery staple 7';
const mf = await makeWorker();
const kv = await mf.getKVNamespace('WORKSPACE_KV');

const A = await new Device('A', mf, { ip: '10.0.0.1' }).boot(); A.setPin().fastKdf();
let sid, mid1, attId;
const LONG = 'The quick brown fox jumps over the lazy dog. '.repeat(200); // compressible, > 200 chars

console.log('== device A: local data + enable encrypted sync');
await t('scripts load in order with no global-scope errors', async () => {
  assert.equal(A.errors.length, 0, A.errors.join('|'));
  for (const g of ['DB', 'Vault', 'Sync', 'SyncMerge', 'Viewer', 'Backup', 'SyncUI', 'Providers', 'App', 'Settings', 'FileHandler']) assert.equal(A.ev(`typeof ${g}`), 'object', g);
});
await t('local data: session/messages (compressed on disk) + attachment + settings', async () => {
  const r = await A.evAsync(`
    const s = await DB.createSession('Project alpha'); 
    const m1 = await DB.addMessage(s.id, { role: 'user', content: ${JSON.stringify(LONG)}, displayText: 'hello', attachmentMeta: [{ id: 'pending', name: 'notes.txt', type: 'text/plain', size: 10 }] });
    await DB.addMessage(s.id, { role: 'ai', nickname: 'Gemini', content: 'reply one', model: 'gemini-x' });
    const att = await DB.addAttachment(s.id, { messageId: m1.id, name: 'notes.txt', type: 'text/plain', size: 10, text: ${JSON.stringify(LONG)}, base64: 'data:text/plain;base64,AAAA' });
    await DB.setSetting('nicknames', Object.assign({}, DEFAULT_NICKNAMES, { gemini: 'G' }));
    await DB.setSetting('sessionAccent:' + s.id, '#ff0000');
    await DB.setSetting('providerTarget:' + s.id, 'groq');
    await DB.setSetting('bgImage', 'data:image/png;base64,SECRET_BG');
    return { sid: s.id, mid1: m1.id, attId: att.id };`);
  ({ sid, mid1, attId } = r);
  const raw = await A.evAsync(`const st = await tx('messages','readonly'); return await new Promise(res => { const q = st.get(${JSON.stringify(mid1)}); q.onsuccess = () => res({ z: q.result.contentZ, isBytes: ArrayBuffer.isView(q.result.content), len: q.result.content.length }); });`);
  assert.equal(raw.z, true); assert.equal(raw.isBytes, true); assert.ok(raw.len < LONG.length / 5, `stored ${raw.len} of ${LONG.length}`);
});
await t('passphrase rules: too short refused; generator gives 99-bit unambiguous groups', async () => {
  assert.equal(A.ev(`Vault.strength('short').level`), 0);
  assert.equal(A.ev(`Vault.strength('a much longer passphrase here').level`), 2);
  const g = A.ev('Vault.generate()'); assert.match(g, /^([A-HJKMNP-Z2-9]{4}-){4}[A-HJKMNP-Z2-9]{4}$/);
  assert.notEqual(g, A.ev('Vault.generate()'));
  await assert.rejects(A.evAsync(`await Sync.setup('short')`), /too short/);
});
await t('enable sync: vault created on server, first full upload completes', async () => {
  await A.evAsync(`await Sync.setup(${JSON.stringify(PASS)}); await new Promise(r => setTimeout(r, 50));`);
  const r = await A.evAsync(`return await Sync.syncNow({ force: true })`);
  assert.ok(!r.error, JSON.stringify(r)); assert.equal(A.ev('Sync.status'), 'synced');
  const items = (await (await mf.dispatchFetch('http://w.test/api/sync/list', { headers: { 'X-App-Password': PIN } })).json()).items.map(i => i.id).sort();
  assert.deepEqual(items, ['a:' + attId, 'k:settings', 's:' + sid].sort());
});
await t('SERVER SEES ONLY CIPHERTEXT: no chat text, titles, file names, or secrets in any stored value', async () => {
  const listed = await kv.list({ prefix: 'sync:i:' }); assert.ok(listed.keys.length >= 3);
  for (const k of listed.keys) {
    const v = new Uint8Array(await kv.get(k.name, 'arrayBuffer')); const text = Buffer.from(v).toString('latin1');
    for (const needle of ['quick brown fox', 'Project alpha', 'notes.txt', 'reply one', 'Gemini', PIN, 'SECRET_BG', '#ff0000']) assert.ok(!text.includes(needle), `${needle} visible in ${k.name}`);
    assert.equal(v[0], 1); // format byte
    assert.ok(v.length < 5000, 'gzip-before-encrypt keeps blobs small: ' + k.name + ' ' + v.length);
  }
  const vault = await kv.get('sync:vault'); assert.ok(!vault.includes(PASS));
});
await t('synced settings are a whitelist: bgImage / PIN / keys never uploaded; appearance off by default', async () => {
  const blob = await A.evAsync(`return await Sync.buildSettings()`);
  assert.ok(blob.items.nicknames); assert.ok(!('bgImage' in blob.items)); assert.ok(!('accent' in blob.items));
  const all = JSON.stringify(await A.evAsync(`return { s: await Sync.buildSettings(), b: await Sync.buildSession(${JSON.stringify(sid)}) }`));
  assert.ok(!all.includes(PIN) && !all.includes('SECRET_BG') && !/api[_-]?key/i.test(all));
});

console.log('== device B: pair with code + restore');
const B = await new Device('B', mf, { ip: '10.0.0.2' }).boot(); B.fastKdf();
let code;
await t('wrong code refused; owner-only code creation works on A', async () => {
  await assert.rejects(B.evAsync(`return await Sync.pairWithCode('ZZZZ-ZZZZ', 'x')`), /wrong or has expired/);
  code = (await A.evAsync(`return await Providers.createPairCode()`)).code; assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});
await t('pairing with the wrong passphrase: paired (token issued) but NOT unlocked, nothing decrypted', async () => {
  const r = await B.evAsync(`return await Sync.pairWithCode(${JSON.stringify(code)}, 'totally wrong passphrase', 'Phone')`);
  assert.deepEqual([r.paired, r.unlocked], [true, false]);
  assert.equal(B.ev('typeof localStorage.getItem("workspace_device_token")'), 'string'); assert.equal(B.ev('Vault.key'), null);
  assert.equal(B.ev('localStorage.getItem("workspace_pin")'), null, 'paired device holds a token, not the master PIN');
  assert.equal((await B.evAsync(`return await DB.listSessions()`)).length, 0);
});
await t('unlock with the right passphrase restores sessions, messages, settings, per-session target', async () => {
  await B.evAsync(`await Sync.unlock(${JSON.stringify(PASS)})`);
  await B.evAsync(`await Sync.syncNow({ force: true })`);
  const s = await B.evAsync(`return await DB.listSessions()`); assert.equal(s.length, 1); assert.equal(s[0].title, 'Project alpha'); assert.equal(s[0].id, sid);
  const m = await B.evAsync(`return await DB.listMessages(${JSON.stringify(sid)})`); assert.equal(m.length, 2); assert.equal(m[0].content, LONG); assert.equal(m[1].model, 'gemini-x'); assert.equal(m[0].displayText, 'hello');
  assert.equal(await B.evAsync(`return await DB.getSetting('providerTarget:${sid}', null)`), 'groq');
  assert.equal(await B.evAsync(`return await DB.getSetting('sessionAccent:${sid}', null)`), '#ff0000');
  assert.equal((await B.evAsync(`return await DB.getSetting('nicknames', null)`)).gemini, 'G');
  assert.equal(await B.evAsync(`return await DB.getSetting('bgImage', 'none')`), 'none');
});
await t('files: metadata restored immediately, contents downloaded lazily on first open', async () => {
  assert.equal(await B.evAsync(`return await DB.getAttachmentLocal(${JSON.stringify(attId)})`), null);
  const a = await B.evAsync(`return await DB.getAttachment(${JSON.stringify(attId)})`);
  assert.equal(a.name, 'notes.txt'); assert.equal(a.text, LONG); assert.equal(a.base64, 'data:text/plain;base64,AAAA');
  assert.ok(await B.evAsync(`return await DB.getAttachmentLocal(${JSON.stringify(attId)})`), 'cached locally after first open');
});
await t('restored data is NOT echoed back as a local change (no needless upload)', async () => {
  assert.equal(B.ev('Object.keys(Sync.state.dirty).filter(k => k.startsWith("s:")).length'), 0);
  const before = B.calls.filter(c => c.startsWith('PUT')).length; await B.evAsync(`return await Sync.syncNow()`);
  assert.equal(B.calls.filter(c => c.startsWith('PUT')).length, before);
});
await t('device list shows the paired device; token device is not owner', async () => {
  const d = await A.evAsync(`return await Providers.listDevices()`); assert.ok(d.devices.some(x => x.kind === 'paired'));
  assert.equal((await B.evAsync(`return await Providers.whoami()`)).role, 'device');
  await assert.rejects(B.evAsync(`return await Providers.createPairCode()`), /master PIN/);
});

console.log('== concurrent edits, deletes, conflicts');
const syncBoth = async () => { await A.evAsync(`await Sync.syncNow({force:true})`); await B.evAsync(`await Sync.syncNow({force:true})`); await A.evAsync(`await Sync.syncNow({force:true})`); };
const titles = async (d) => (await d.evAsync(`return (await DB.listMessages(${JSON.stringify(sid)})).map(m => m.content.length > 60 ? m.content.slice(0, 12) + '…' : m.content)`));
await t('both devices add messages while apart -> union, same order, no duplicates', async () => {
  await A.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'user', content: 'from A' })`); await sleep(5);
  await B.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'user', content: 'from B' })`);
  await syncBoth();
  const a = await titles(A), b = await titles(B); assert.deepEqual(a, b); assert.equal(a.length, 4); assert.ok(a.includes('from A') && a.includes('from B'));
  assert.equal(new Set(await A.evAsync(`return (await DB.listMessages(${JSON.stringify(sid)})).map(m => m.id)`)).size, 4);
});
await t('rename conflict: the later rename wins on both, nothing lost', async () => {
  await A.evAsync(`await DB.renameSession(${JSON.stringify(sid)}, 'Renamed on A')`); await sleep(10);
  await B.evAsync(`await DB.renameSession(${JSON.stringify(sid)}, 'Renamed on B')`);
  await syncBoth();
  for (const d of [A, B]) assert.equal((await d.evAsync(`return await DB.listSessions()`))[0].title, 'Renamed on B');
});
await t('message delete on A propagates to B and does not resurrect', async () => {
  const fromA = (await A.evAsync(`return await DB.listMessages(${JSON.stringify(sid)})`)).find(m => m.content === 'from A');
  await A.evAsync(`await DB.deleteMessage(${JSON.stringify(fromA.id)})`);
  await syncBoth(); await syncBoth();
  for (const d of [A, B]) assert.ok(!(await titles(d)).includes('from A'));
  assert.equal((await titles(A)).length, 3);
});
await t('edit-vs-edit of the SAME message: winner stays, loser preserved as a visible copy on both devices', async () => {
  const ms = await A.evAsync(`return await DB.listMessages(${JSON.stringify(sid)})`); const target = ms.find(m => m.content === 'reply one');
  await A.evAsync(`await DB.patchMessage(${JSON.stringify(target.id)}, { content: 'edited on A' })`); await sleep(10);
  await B.evAsync(`await DB.patchMessage(${JSON.stringify(target.id)}, { content: 'edited on B' })`);
  await syncBoth();
  const a = await titles(A), b = await titles(B); assert.deepEqual(a, b);
  assert.ok(a.includes('edited on B') && a.includes('edited on A'), a.join('|')); assert.ok(!a.includes('reply one'));
});
await t('per-session setting conflict: newest write wins (providerTarget)', async () => {
  await A.evAsync(`await DB.setSetting('providerTarget:${sid}', 'gemini')`); await sleep(10);
  await B.evAsync(`await DB.setSetting('providerTarget:${sid}', 'omniroute')`);
  await syncBoth();
  for (const d of [A, B]) assert.equal(await d.evAsync(`return await DB.getSetting('providerTarget:${sid}', null)`), 'omniroute');
});
await t('new file added on B appears on A (lazy) and its bytes match', async () => {
  const att = await B.evAsync(`return await DB.addAttachment(${JSON.stringify(sid)}, { messageId: 'x', name: 'pic.png', type: 'image/png', size: 5, text: '', base64: 'data:image/png;base64,QUJDREVGRw==' })`);
  await syncBoth();
  const got = await A.evAsync(`return await DB.getAttachment(${JSON.stringify(att.id)})`); assert.equal(got.base64, 'data:image/png;base64,QUJDREVGRw==');
});
await t('session delete on A removes it (and its files) on B', async () => {
  const s2 = await A.evAsync(`const s = await DB.createSession('Doomed'); const m = await DB.addMessage(s.id, {role:'user', content:'x'}); await DB.addAttachment(s.id, { messageId: m.id, name:'d.txt', type:'text/plain', size:1, text:'d', base64:null }); return s.id`);
  await syncBoth(); assert.ok((await B.evAsync(`return await DB.listSessions()`)).some(s => s.id === s2));
  await A.evAsync(`await DB.deleteSession(${JSON.stringify(s2)})`); await syncBoth();
  assert.ok(!(await B.evAsync(`return await DB.listSessions()`)).some(s => s.id === s2));
  assert.deepEqual(await B.evAsync(`return await DB.listAttachments(${JSON.stringify(s2)})`), []);
});
await t('deleted on A but EDITED on B afterwards -> kept (never silently destroy newer work)', async () => {
  const s3 = await A.evAsync(`return (await DB.createSession('Contested')).id`); await syncBoth();
  await A.evAsync(`await DB.deleteSession(${JSON.stringify(s3)})`); await A.evAsync(`await Sync.syncNow({force:true})`); await sleep(1100);
  await B.evAsync(`await DB.addMessage(${JSON.stringify(s3)}, { role: 'user', content: 'still here' })`);
  await B.evAsync(`await Sync.syncNow({force:true})`); await syncBoth();
  for (const d of [A, B]) assert.ok((await d.evAsync(`return await DB.listSessions()`)).some(s => s.id === s3), d.name);
});
await t('"clear everything" on B is local-only: A keeps its data; B re-downloads on next sync', async () => {
  await B.evAsync(`for (const s of await DB.listSessions()) await DB.deleteSession(s.id, { silent: true }); await Sync.resetLocalState();`);
  const aCount = (await A.evAsync(`return await DB.listSessions()`)).length;
  await B.evAsync(`await Sync.syncNow({force:true})`); await A.evAsync(`await Sync.syncNow({force:true})`);
  assert.equal((await A.evAsync(`return await DB.listSessions()`)).length, aCount);
  assert.equal((await B.evAsync(`return await DB.listSessions()`)).length, aCount);
});

console.log('== offline, quota, revoke');
await t('offline: status offline, changes stay queued, no duplicates after reconnect', async () => {
  B.offline = true; await B.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'user', content: 'written offline' })`);
  const r = await B.evAsync(`return await Sync.syncNow({force:true})`); assert.ok(r.error); assert.equal(B.ev('Sync.status'), 'offline');
  assert.ok(B.ev(`Object.keys(Sync.state.dirty).includes("s:${sid}")`));
  B.offline = false; await syncBoth();
  const a = await titles(A); assert.equal(a.filter(x => x === 'written offline').length, 1); assert.deepEqual(a, await titles(B));
});
await t('local dirty list survives a reload (persisted), and reconcile catches un-flagged changes', async () => {
  await B.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'user', content: 'edit then crash' }); await Sync.saveState();`);
  const B2 = await new Device('B2', mf, { idb: B.idb, ip: '10.0.0.2' }).boot({ localStorage: Object.fromEntries(['workspace_device_id', 'workspace_device_token'].map(k => [k, B.w.localStorage.getItem(k)])) });
  await B2.evAsync(`await Sync.init();`);
  assert.equal(B2.ev('Vault.key && Vault.key.type'), 'secret', 'non-extractable key restored from IndexedDB');
  assert.equal(B2.ev('Vault.key.extractable'), false);
  await B2.evAsync(`await Sync.syncNow({force:true})`); await A.evAsync(`await Sync.syncNow({force:true})`);
  assert.ok((await titles(A)).includes('edit then crash')); B2.close();
});
await t('daily write budget: sync pauses instead of blowing the free KV quota, resumes next day', async () => {
  A.ev('Sync.state.quota = { day: new Date().toISOString().slice(0,10), writes: 850 }');
  await A.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'user', content: 'quota test' })`);
  const r = await A.evAsync(`return await Sync.syncNow({force:true})`); assert.equal(r.paused, true); assert.equal(A.ev('Sync.status'), 'paused');
  A.ev('Sync.state.quota = { day: "1999-01-01", writes: 999 }'); await A.evAsync(`await Sync.syncNow({force:true})`);
  assert.equal(A.ev('Sync.status'), 'synced'); assert.equal(A.ev('Sync.writesToday() > 0'), true);
});
await t('owner revokes B: B is rejected, signs itself out cleanly, keeps local chats', async () => {
  const bid = B.w.localStorage.getItem('workspace_device_id');
  await A.evAsync(`return await Providers.revokeDevice(${JSON.stringify(bid)})`);
  await B.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'user', content: 'after revoke' })`);
  const r = await B.evAsync(`return await Sync.syncNow({force:true})`);
  assert.ok(r.error); assert.equal(B.w.localStorage.getItem('workspace_device_token'), null); assert.equal(B.ev('Sync.state.enabled'), false);
  assert.ok((await titles(B)).includes('after revoke'));
  assert.ok(!(await titles(A)).includes('after revoke'), 'revoked device could not push');
});

console.log('== encrypted backup file');
let backup;
await t('export -> ciphertext only; wrong passphrase / corrupt file / foreign file rejected', async () => {
  const r = await A.evAsync(`const r = await Backup.exportEncrypted('backup pass phrase 99'); return { bytes: Array.from(r.bytes), sessions: r.sessions, attachments: r.attachments }`);
  backup = new Uint8Array(r.bytes); assert.ok(r.sessions >= 2 && r.attachments >= 2);
  const text = Buffer.from(backup).toString('latin1'); for (const n of ['Project alpha', 'quick brown', 'notes.txt', 'Renamed on B']) assert.ok(!text.includes(n));
  assert.deepEqual([...backup.slice(0, 4)], [0x41, 0x57, 0x42, 0x31]);
  await assert.rejects(A.evAsync(`return await Backup.exportEncrypted('short')`), /at least 10/);
  const C = await new Device('C', mf, { ip: '10.0.0.3' }).boot(); C.fastKdf();
  await assert.rejects(C.evAsync(`return await Backup.importEncrypted(new Uint8Array(${JSON.stringify([...backup])}), 'not the passphrase')`), /Wrong passphrase/);
  const bad = new Uint8Array(backup); bad[bad.length - 5] ^= 0xff;
  await assert.rejects(C.evAsync(`return await Backup.importEncrypted(new Uint8Array(${JSON.stringify([...bad])}), 'backup pass phrase 99')`), /Wrong passphrase|damaged/);
  await assert.rejects(C.evAsync(`return await Backup.importEncrypted(new Uint8Array(100), 'x')`), /not an AI Workspace backup/);
  C.close();
});
await t('restore into a brand-new empty device recreates everything; restoring twice adds no duplicates', async () => {
  const C = await new Device('C2', mf, { ip: '10.0.0.3' }).boot(); C.fastKdf();
  const arr = JSON.stringify([...backup]);
  const r = await C.evAsync(`return await Backup.importEncrypted(new Uint8Array(${arr}), 'backup pass phrase 99')`); assert.ok(r.sessions >= 2);
  const before = { s: (await C.evAsync(`return await DB.listSessions()`)).length, m: (await C.evAsync(`return await DB.listMessages(${JSON.stringify(sid)})`)).length };
  await C.evAsync(`return await Backup.importEncrypted(new Uint8Array(${arr}), 'backup pass phrase 99')`);
  const after = { s: (await C.evAsync(`return await DB.listSessions()`)).length, m: (await C.evAsync(`return await DB.listMessages(${JSON.stringify(sid)})`)).length };
  assert.deepEqual(after, before); assert.equal(before.s, (await A.evAsync(`return await DB.listSessions()`)).length);
  assert.deepEqual(await titles(C), await titles(A));
  const a = await C.evAsync(`return await DB.getAttachmentLocal(${JSON.stringify(attId)})`); assert.equal(a.text, LONG);
  assert.equal((await C.evAsync(`return await DB.getSetting('nicknames', null)`)).gemini, 'G');
  C.close();
});

console.log('== live shared chat (owner -> viewer)');
let token; const V = await new Device('V', mf, { ip: '10.0.0.9' }).boot({ url: 'https://arcticfoxcreations.github.io/Workspace/?share=x' });
await t('share link is created for a session and the payload hides file text, errors and thinking stubs', async () => {
  await A.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'ai', nickname: 'Gemini', content: '(Gemini error: boom)', isError: true })`);
  await A.evAsync(`await App.shareSession(${JSON.stringify(sid)})`);
  const links = await A.evAsync(`return await DB.getSetting('shareLinks', [])`); assert.equal(links.length, 1); assert.equal(links[0].sessionId, sid); token = links[0].token;
  assert.match(A.clipboard, /\?share=[A-Za-z0-9_-]{43}$/);
  const pub = (await (await mf.dispatchFetch('http://w.test/api/share/' + token)).json()).session;
  const txt = JSON.stringify(pub); assert.ok(!txt.includes('quick brown fox'), 'attachment text must not leak'); assert.ok(!txt.includes('boom'));
  assert.ok(pub.messages.some(m => m.content === 'hello') && pub.messages.some(m => (m.files || []).includes('notes.txt')));
  assert.ok(!txt.includes(PIN));
});
await t('viewer needs no PIN, renders read-only, and shows the current messages', async () => {
  V.ev(`localStorage.clear()`);
  await V.evAsync(`Viewer.token = ${JSON.stringify(token)}; document.body.classList.add('viewer-mode'); document.body.insertAdjacentHTML('beforeend', '<div id="viewerRoot"><div id="viewerTitle"></div><span id="viewerPill"></span><button id="viewerCopyBtn" hidden></button><div id="viewerLog"></div></div>'); await Viewer.poll(); clearTimeout(Viewer.timer);`);
  const html = V.ev(`document.getElementById('viewerLog').textContent`); assert.ok(html.includes('hello') && html.includes('from B'));
  assert.equal(V.ev(`document.getElementById('viewerTitle').textContent`), 'Renamed on B'); assert.equal(V.ev(`document.querySelector('#viewerRoot textarea, #viewerRoot input') === null`), true);
  assert.equal(V.ev('localStorage.getItem("workspace_pin")'), null);
});
await t('owner sends new messages -> ONE push per burst -> viewer receives them on next poll; unchanged poll is tiny', async () => {
  const revBefore = V.ev('Viewer.rev');
  await A.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'user', content: 'live message 1', displayText: 'live message 1' }); await DB.addMessage(${JSON.stringify(sid)}, { role: 'ai', nickname: 'Groq', content: 'live **reply** 2' });`);
  A.calls.length = 0; await A.evAsync(`await Sync.pushShare(${JSON.stringify(sid)})`);
  assert.equal(A.calls.filter(c => c.includes('/api/share/update')).length, 1);
  await A.evAsync(`await Sync.pushShare(${JSON.stringify(sid)})`); assert.equal(A.calls.filter(c => c.includes('/api/share/update')).length, 1, 'unchanged content is not re-pushed');
  await V.evAsync(`await Viewer.poll(); clearTimeout(Viewer.timer);`);
  assert.ok(V.ev('Viewer.rev') > revBefore); const log = V.ev(`document.getElementById('viewerLog').innerHTML`);
  assert.ok(log.includes('live message 1') && log.includes('<strong>reply</strong>'));
  const n = V.ev(`document.querySelectorAll('.viewer-msg').length`); await V.evAsync(`await Viewer.poll(); clearTimeout(Viewer.timer);`); assert.equal(V.ev(`document.querySelectorAll('.viewer-msg').length`), n, 'no duplicate rows on an unchanged poll');
});
await t('viewer poll backoff: fast when active, slower when idle, exponential on failure', async () => {
  V.ev('Viewer.failures = 0; Viewer.lastChangeAt = Date.now()'); assert.equal(V.ev('Viewer.nextDelay()'), 8000);
  V.ev('Viewer.lastChangeAt = Date.now() - 5*60000'); assert.equal(V.ev('Viewer.nextDelay()'), 20000);
  V.ev('Viewer.lastChangeAt = Date.now() - 3600000'); assert.equal(V.ev('Viewer.nextDelay()'), 90000);
  V.ev('Viewer.failures = 3'); assert.equal(V.ev('Viewer.nextDelay()'), 40000); V.ev('Viewer.failures = 0');
});
await t('viewer reconnects after a network drop (shows reconnecting, then recovers)', async () => {
  V.offline = true; await V.evAsync(`await Viewer.poll(); clearTimeout(Viewer.timer);`); assert.equal(V.ev(`document.getElementById('viewerPill').textContent`), 'reconnecting…');
  V.offline = false; await V.evAsync(`await Viewer.poll(); clearTimeout(Viewer.timer);`); assert.match(V.ev(`document.getElementById('viewerPill').textContent`), /^live/);
});
await t('owner deletes a message -> viewer re-renders without it (edits/deletes propagate)', async () => {
  const m = (await A.evAsync(`return await DB.listMessages(${JSON.stringify(sid)})`)).find(x => x.content === 'live message 1');
  await A.evAsync(`await DB.deleteMessage(${JSON.stringify(m.id)}); await Sync.pushShare(${JSON.stringify(sid)})`);
  await V.evAsync(`await Viewer.poll(); clearTimeout(Viewer.timer);`); assert.ok(!V.ev(`document.getElementById('viewerLog').textContent`).includes('live message 1'));
});
await t('viewer "save a copy" imports the visible chat as a normal local session', async () => {
  await V.evAsync(`await DB.importSharedSession(Viewer.session.title, Viewer.session.messages)`);
  const s = await V.evAsync(`return await DB.listSessions()`); assert.equal(s.length, 1); assert.ok((await V.evAsync(`return await DB.listMessages(${JSON.stringify(s[0].id)})`)).length >= 4);
});
await t('revoked share: viewer stops with "sharing stopped"; old link 404s; owner list cleans up', async () => {
  await A.evAsync(`await Providers.revokeShare(${JSON.stringify(token)})`);
  await V.evAsync(`await Viewer.poll();`); assert.equal(V.ev(`document.getElementById('viewerPill').textContent`), 'sharing stopped'); assert.equal(V.ev('Viewer.stopped'), true);
  await A.evAsync(`await DB.addMessage(${JSON.stringify(sid)}, { role: 'user', content: 'after revoke' }); await Sync.pushShare(${JSON.stringify(sid)})`);
  assert.equal((await A.evAsync(`return await DB.getSetting('shareLinks', [])`)).length, 0, 'link removed after the server says gone');
});

console.log('== app-level behaviour');
await t('/compile is a command: never sent to any AI, uses the existing compile pipeline, optional provider arg', async () => {
  const D = await new Device('D', mf, { ip: '10.0.0.4' }).boot(); D.setPin();
  const r = await D.evAsync(`
    const calls = []; let chatCalls = 0;
    Providers.chat = async () => { chatCalls++; return { text: 'x' }; };
    App.compileContext = async (ex, forced) => { calls.push([ex, forced]); return true; };
    App.refreshUsageBar = async () => {};
    const s = await DB.createSession('c'); App.currentSessionId = s.id; App.pendingAttachments = [];
    await App.handleSend('/compile'); await App.handleSend('/compile gemini'); await App.handleSend('/compile nonsenseai');
    return { calls, chatCalls, msgs: (await DB.listMessages(s.id)).length };`);
  assert.deepEqual(r.calls, [[null, null], [null, 'gemini']]); assert.equal(r.chatCalls, 0); assert.equal(r.msgs, 0, 'command text is not saved as chat');
  D.close();
});
await t('per-session provider target persists across reload; Auto is remembered; unknown provider falls back to Auto', async () => {
  const D = await new Device('D2', mf, { ip: '10.0.0.4' }).boot();
  const sids = await D.evAsync(`const a = await DB.createSession('a'), b = await DB.createSession('b'); return [a.id, b.id]`);
  await D.evAsync(`App.currentSessionId = ${JSON.stringify(sids[0])}; App.refreshHeaderChips = async () => {}; await App.setTarget('gemini')`);
  await D.evAsync(`App.currentSessionId = ${JSON.stringify(sids[1])}; await App.setTarget('omniroute')`);
  const D3 = await new Device('D3', mf, { idb: D.idb }).boot(); // "reload": new page, same IndexedDB
  const got = await D3.evAsync(`App.refreshHeaderChips = async () => {}; App.renderMessages = App.renderMessages; const out = {};
    for (const id of ${JSON.stringify(sids)}) { const t = await DB.getSetting('providerTarget:' + id, null); const known = await DB.getSetting('nicknames', DEFAULT_NICKNAMES); out[id] = (t && (t in known)) ? t : null; } return out;`);
  assert.equal(got[sids[0]], 'gemini'); assert.equal(got[sids[1]], 'omniroute');
  await D3.evAsync(`await DB.setSetting('providerTarget:${sids[0]}', 'gone-provider')`);
  assert.equal(await D3.evAsync(`const t = await DB.getSetting('providerTarget:${sids[0]}', null); const known = await DB.getSetting('nicknames', DEFAULT_NICKNAMES); return (t && (t in known)) ? t : null`), null);
  D.close(); D3.close();
});
await t('OmniRoute is a first-class provider: nickname, @mention routing, ceiling, colour, icon', async () => {
  const D = await new Device('D4', mf).boot();
  assert.equal(D.ev(`DEFAULT_NICKNAMES.omniroute`), 'OmniRoute'); assert.equal(D.ev(`Router.findMentionedProvider('@omniroute hi', DEFAULT_NICKNAMES)`), 'omniroute');
  assert.equal(D.ev('PROVIDER_TOKEN_CEILING.omniroute'), 24000); assert.match(D.ev(`providerColor('omniroute')`), /^#/); assert.ok(D.ev('PROVIDER_ICON_SVG.omniroute').includes('path'));
  assert.ok(D.ev('COMPILE_PROVIDER_PRIORITY.includes("omniroute")'));
  await D.evAsync(`await DB.setSetting('nicknames', { gemini: 'Gemini' }); await App.migrateNicknames();`);
  assert.equal((await D.evAsync(`return await DB.getSetting('nicknames', null)`)).omniroute, 'OmniRoute', 'old stored nickname maps get the new provider');
  D.close();
});
await t('console history persists across reload, is bounded, and can be turned off', async () => {
  const D = await new Device('D5', mf).boot();
  await D.evAsync(`await Logger.restore(); for (let i = 0; i < 300; i++) Logger.info('t', 'entry ' + i); await Logger.persistNow();`);
  const D2 = await new Device('D5b', mf, { idb: D.idb }).boot();
  await D2.evAsync(`await Logger.restore()`); const b = D2.ev('Logger.buffer.map(e => e.message)');
  assert.ok(b.includes('entry 299') && !b.includes('entry 50')); assert.ok(b.some(m => m.startsWith('restored '))); assert.ok(b.length <= 205);
  await D2.evAsync(`await Logger.setPersist(false)`); assert.equal(await D2.evAsync(`return await DB.getSetting('consoleLog', 'gone')`), 'gone');
  D.close(); D2.close();
});
await t('full app boots against restored data; Settings renders the Sync & backup panel; PIN field is not digits-only', async () => {
  const D = await new Device('D6', mf, { ip: '10.0.0.5' }).boot({ init: false }); D.setPin();
  D.ev(`Providers.pingDevice = async () => {}; App.checkDeploySync = () => {};`);
  await D.evAsync(`const s = await DB.createSession('Boot test'); await DB.addMessage(s.id, { role: 'user', content: 'hi' });`);
  await D.evAsync(`await App.init()`);
  assert.ok(D.ev(`document.getElementById('sessionList').textContent`).includes('Boot test'));
  await D.evAsync(`await Settings.open()`);
  const html = D.ev(`document.getElementById('settingsBody').innerHTML`);
  assert.ok(html.includes('Sync &amp; backup') && html.includes('Encrypted backup file') && html.includes('Storage on this device') && html.includes('Master PIN'));
  assert.ok(!/inputmode="numeric"/.test(html), 'PIN field must not force a numeric keypad');
  assert.equal(D.ev(`document.getElementById('syncChip').textContent`).length > 0, true);
  assert.equal(D.errors.length, 0, D.errors.join('|')); D.close();
});
await t('storage report + persistence helper work without throwing', async () => {
  const D = await new Device('D7', mf).boot(); const r = await D.evAsync(`return await StorageTools.report()`);
  assert.ok('messages' in r.breakdown); assert.equal(await D.evAsync(`return await StorageTools.persist()`), false); D.close();
});


console.log('== resilience: vault reset, corrupt items, XSS, session open');
await t('cloud reset on another device: this device locks itself instead of writing under the old key; re-unlock recovers', async () => {
  const mf3 = await makeWorker(); const kv3 = await mf3.getKVNamespace('WORKSPACE_KV');
  const X = await new Device('X', mf3, { ip: '11.0.0.1' }).boot(); X.setPin().fastKdf();
  const Y = await new Device('Y', mf3, { ip: '11.0.0.2' }).boot(); Y.fastKdf();
  await X.evAsync(`const s = await DB.createSession('Shared work'); await DB.addMessage(s.id, { role: 'user', content: 'one' }); await Sync.setup('first passphrase 123')`);
  const code = (await X.evAsync(`return await Providers.createPairCode()`)).code;
  const r = await Y.evAsync(`return await Sync.pairWithCode(${JSON.stringify(code)}, 'first passphrase 123')`); assert.equal(r.unlocked, true);
  assert.equal((await Y.evAsync(`return await DB.listSessions()`)).length, 1);
  await X.evAsync(`await Sync.wipeCloud(); await Sync.setup('second passphrase 456')`);
  await Y.evAsync(`await DB.addMessage((await DB.listSessions())[0].id, { role: 'user', content: 'Y offline work' })`);
  const putsBefore = Y.calls.filter(c => c.startsWith('PUT')).length;
  const res = await Y.evAsync(`return await Sync.syncNow({ force: true })`);
  assert.ok(res.error); assert.equal(Y.ev('Sync.status'), 'locked'); assert.equal(Y.ev('Vault.key'), null);
  assert.equal(Y.calls.filter(c => c.startsWith('PUT')).length, putsBefore, 'must not upload under the stale key');
  await Y.evAsync(`await Sync.unlock('second passphrase 456')`); await X.evAsync(`await Sync.syncNow({force:true})`);
  const xs = await X.evAsync(`const s = (await DB.listSessions())[0]; return (await DB.listMessages(s.id)).map(m => m.content)`);
  assert.deepEqual(xs.sort(), ['Y offline work', 'one']);
  // a damaged item is skipped without blocking the rest
  await kv3.put('sync:i:s:sess_garbage', new Uint8Array(200).fill(7), { metadata: { v: '1.dev_zzzzzzzz', d: '0', s: '200', t: '1', dev: 'dev_zzzzzzzz' } });
  await kv3.put('sync:head', 'changed-head');
  const z = await Y.evAsync(`return await Sync.syncNow({ force: true })`); assert.ok(!z.error, JSON.stringify(z)); assert.equal(z.pulled.skipped, 1);
  assert.match(Y.ev('Sync.state.lastError'), /could not be decrypted/); assert.equal((await Y.evAsync(`return await DB.listSessions()`)).length, 1);
  X.close(); Y.close(); await mf3.dispose();
});
await t('viewer treats shared content as untrusted: no HTML/script/javascript: injection from message text', async () => {
  const D = await new Device('XSS', mf).boot();
  const out = await D.evAsync(`
    const evil = ['<img src=x onerror="window.__pwned=1">', '<script>window.__pwned=1</script>', '[click](javascript:window.__pwned=1)', '**bold** <b onmouseover=1>x</b>'].join('\\n');
    document.body.insertAdjacentHTML('beforeend', '<div id="host"></div>');
    const host = document.getElementById('host');
    host.appendChild(Viewer.renderMessage({ id: 'e1', role: 'ai', nickname: 'Gemini<img src=x onerror=1>', content: evil, files: ['<svg onload=1>.png'] }));
    host.appendChild(Viewer.renderMessage({ id: 'e2', role: 'user', content: '<img src=x onerror=1>' }));
    return { imgs: host.querySelectorAll('img, script, svg, b[onmouseover]').length, jsHref: !!host.querySelector('a[href^="javascript:" i]'), pwned: !!window.__pwned, text: host.textContent.includes('<img src=x') , bold: !!host.querySelector('strong') };`);
  assert.equal(out.imgs, 0); assert.equal(out.jsHref, false); assert.equal(out.pwned, false); assert.equal(out.text, true); assert.equal(out.bold, true);
  D.close();
});
await t('App.openSession restores this session\'s AI target (Auto for sessions without one)', async () => {
  const D = await new Device('OS', mf, { ip: '10.0.0.6' }).boot({ init: false }); D.setPin();
  D.ev(`Providers.pingDevice = async () => {}; App.checkDeploySync = () => {};`);
  const ids = await D.evAsync(`const a = await DB.createSession('has target'), b = await DB.createSession('auto one'); await DB.setSetting('providerTarget:' + a.id, 'omniroute'); return [a.id, b.id]`);
  await D.evAsync(`await App.init()`);
  await D.evAsync(`await App.openSession(${JSON.stringify(ids[0])})`); assert.equal(D.ev('App.manualTarget'), 'omniroute');
  assert.ok(D.ev(`document.getElementById('aiSelectChip') ? document.getElementById('aiSelectChip').textContent.includes('OmniRoute') : true`));
  await D.evAsync(`await App.openSession(${JSON.stringify(ids[1])})`); assert.equal(D.ev('App.manualTarget'), null);
  await D.evAsync(`await App.setTarget('groq')`); assert.equal(await D.evAsync(`return await DB.getSetting('providerTarget:${ids[1]}', null)`), 'groq');
  await D.evAsync(`await App.openSession(${JSON.stringify(ids[0])}); await App.openSession(${JSON.stringify(ids[1])})`); assert.equal(D.ev('App.manualTarget'), 'groq');
  assert.equal(D.errors.length, 0, D.errors.join('|')); D.close();
});

console.log('== cloud wipe');
await t('owner wipes cloud data: vault gone, sync disabled, local chats untouched', async () => {
  const before = (await A.evAsync(`return await DB.listSessions()`)).length;
  await A.evAsync(`await Sync.wipeCloud()`);
  assert.equal((await kv.list({ prefix: 'sync:i:' })).keys.length, 0); assert.equal(await kv.get('sync:vault'), null);
  assert.equal(A.ev('Sync.state.enabled'), false); assert.equal((await A.evAsync(`return await DB.listSessions()`)).length, before);
});

console.log(`\n${passed} passed, ${failed} failed`);
await mf.dispose(); process.exit(failed ? 1 : 0);
