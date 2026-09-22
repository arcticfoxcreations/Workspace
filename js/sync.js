// ============================================================================
// sync.js - encrypted cross-device sync, encrypted backups, live shared-chat
// push + the read-only shared-chat viewer.
//
// HOW SYNC WORKS (one paragraph):
//   IndexedDB stays the primary store. DB (js/db.js) announces local changes;
//   Sync marks the affected items dirty and, after a short debounce, pushes
//   each dirty item to the Worker as ONE encrypted blob (a session + its
//   messages = one item, each attachment = one item, whitelisted settings =
//   one item). Everything is encrypted in the browser with AES-256-GCM using a
//   key derived (PBKDF2) from your sync passphrase - the Worker only stores
//   ciphertext. Pulling merges remote items into local data (union of messages
//   by id, tombstones for deletes, newest-wins for renames/settings) so two
//   devices editing at once never silently overwrite each other.
//
// WHAT IS NEVER SYNCED: provider API keys (they only exist in the Worker), your
// master PIN, device tokens, the sync key itself, the console log, the
// background image. See SYNC_SETTING_KEYS below - it is a whitelist.
// ============================================================================

// ---- what may leave this device ----------------------------------------------
const SYNC_SETTING_KEYS = ['nicknames', 'profile', 'autoProviders', 'customGreeting', 'shareLinks', 'customKeybinds'];
const SYNC_APPEARANCE_KEYS = ['accent', 'fontSize', 'fontFamily', 'lineHeight', 'density', 'chatWidth', 'bgDim',
  'bubbleOpacity', 'bubbleBlur', 'sidebarBlur', 'sidebarOpacity', 'bubbleShape', 'bubbleFill', 'ultraCompact'];
// Stored in the generic kv table keyed by session id; they travel INSIDE that
// session's blob (so they can't be applied to a session that doesn't exist).
const SESSION_KV_PREFIXES = ['compiledContext:', 'branchParent:', 'sessionAccent:', 'providerTarget:'];
// Belt and braces: even if someone adds a key to a whitelist by mistake, anything
// that looks like a credential is refused.
const SECRET_KEY_RE = /pin|token|secret|password|passphrase|api[_-]?key|sync:key|sync:state/i;

const SYNC_SOFT_WRITE_LIMIT = 850;          // stay under KV's 1,000 writes/day (the Worker uses some too)
const SYNC_MAX_ATTACHMENT_CHARS = 18 * 1024 * 1024; // larger originals sync as text-only
const SYNC_MAX_PER_RUN = 60;                 // items pushed per sync run
const SYNC_DEBOUNCE_MS = 20000;              // wait this long after the last change before pushing

const b64 = {
  enc(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); },
  dec(str) { const s = atob(str); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
};

// ============================================================================
// Vault: passphrase -> AES-GCM key, and sealing/opening blobs
// ============================================================================
// Blob layout: [0]=format(1) [1]=flags(bit0: gzip) [2..13]=IV(12) [14..]=ciphertext+tag.
// The item id (or a fixed label) is bound in as AES-GCM "additional data", so a
// ciphertext copied onto a different item id fails to decrypt.
const Vault = {
  ITERATIONS: 600000,   // PBKDF2-HMAC-SHA256 - OWASP's current minimum for this construction
  key: null,

  _norm(pass) { return new TextEncoder().encode(String(pass).normalize('NFKC')); },
  async derive(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', Vault._norm(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  },
  _aad(label) { return new TextEncoder().encode('aw1|' + label); },

  async sealBytes(key, bytes, label, gzip) {
    const flags = gzip && Compression.SUPPORTED ? 1 : 0;
    const body = flags ? await Compression.gzipBytes(bytes) : bytes;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Vault._aad(label) }, key, body));
    const out = new Uint8Array(14 + ct.length);
    out[0] = 1; out[1] = flags; out.set(iv, 2); out.set(ct, 14);
    return out;
  },
  async openBytes(key, blob, label) {
    if (!blob || blob.length < 31 || blob[0] !== 1) throw new Error('Unrecognised encrypted data format.');
    const flags = blob[1];
    const iv = blob.subarray(2, 14);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: Vault._aad(label) }, key, blob.subarray(14)));
    return (flags & 1) ? Compression.gunzipBytes(pt) : pt;
  },
  async seal(obj, label) {
    return Vault.sealBytes(Vault.key, new TextEncoder().encode(JSON.stringify(obj)), label, true);
  },
  async open(blob, label) {
    return JSON.parse(new TextDecoder().decode(await Vault.openBytes(Vault.key, blob, label)));
  },

  // New vault: random salt + a small encrypted "verifier" so a wrong passphrase
  // is detected immediately (and locally) instead of failing on real data.
  async create(passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await Vault.derive(passphrase, salt, Vault.ITERATIONS);
    const verifier = await Vault.sealBytes(key, new TextEncoder().encode('{"ok":"aw-vault-v1"}'), 'verifier', false);
    Vault.key = key;
    return { kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: Vault.ITERATIONS, salt: b64.enc(salt) }, verifier: b64.enc(verifier) };
  },
  async unlock(passphrase, vault) {
    try {
      const key = await Vault.derive(passphrase, b64.dec(vault.kdf.salt), vault.kdf.iterations);
      const pt = await Vault.openBytes(key, b64.dec(vault.verifier), 'verifier');
      if (JSON.parse(new TextDecoder().decode(pt)).ok !== 'aw-vault-v1') return false;
      Vault.key = key;
      return true;
    } catch (e) { return false; }
  },
  // The derived key is stored NON-EXTRACTABLE in IndexedDB so you don't retype
  // the passphrase on every visit. Scripts on this origin could still USE it,
  // they just can't read the raw key bits. "Lock this device" deletes it.
  async persist() { try { await DB.setSettingRaw('sync:key', Vault.key, Date.now()); return true; } catch (e) { return false; } },
  async restore() {
    try { const k = await DB.getSetting('sync:key', null); if (k && k.type === 'secret') { Vault.key = k; return true; } } catch (e) {}
    return false;
  },
  async forget() { Vault.key = null; try { await DB.deleteSetting('sync:key'); } catch (e) {} },

  // Rough strength check - length is what matters against offline guessing.
  strength(pass) {
    const p = String(pass || '');
    let classes = 0;
    if (/[a-z]/.test(p)) classes++; if (/[A-Z]/.test(p)) classes++; if (/\d/.test(p)) classes++; if (/[^A-Za-z0-9]/.test(p)) classes++;
    if (p.length < 10) return { level: 0, label: 'too short (need 10+ characters)' };
    if (p.length >= 16 || (p.length >= 12 && classes >= 3)) return { level: 2, label: 'strong' };
    return { level: 1, label: 'okay - longer is better' };
  },
  // 20 random characters from an unambiguous 31-symbol alphabet = ~99 bits,
  // shown in groups of four.
  generate() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const limit = 256 - (256 % A.length);
    let chars = '';
    while (chars.length < 20) {
      for (const b of crypto.getRandomValues(new Uint8Array(32))) {
        if (b < limit && chars.length < 20) chars += A[b % A.length];
      }
    }
    return chars.match(/.{4}/g).join('-');
  }
};

// ============================================================================
// Merge logic (pure functions - no DB, no network)
// ============================================================================
const SyncMerge = {
  stamp(m) { return m.patchedAt || m.timestamp || 0; },
  sameMsg(a, b) {
    return a.content === b.content && (a.patchedAt || 0) === (b.patchedAt || 0) && !!a.pinned === !!b.pinned &&
      (a.displayText || '') === (b.displayText || '') && JSON.stringify(a.attachmentMeta || null) === JSON.stringify(b.attachmentMeta || null);
  },
  hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); },
  // A compact fingerprint used to decide "did the merge change anything on
  // this side?" without deep-comparing whole blobs.
  sig(blob) {
    const s = blob.session;
    const dead = Object.keys(s.deletedMsgs || {}).sort().map(k => k + ':' + s.deletedMsgs[k]).join(',');
    const msgs = blob.messages.map(m => [m.id, SyncMerge.stamp(m), m.pinned ? 1 : 0, (m.content || '').length, SyncMerge.hash(m.content || ''), (m.displayText || '').length].join('|')).join(';');
    const kv = Object.keys(blob.kv || {}).sort().map(k => k + ':' + (blob.kv[k].t || 0)).join(',');
    return [s.title, s.pinned ? 1 : 0, s.metaAt || 0, s.updatedAt || 0, dead, msgs, kv].join('#');
  },

  // Merge two versions of one session. L may be null (session unknown locally).
  session(L, R) {
    if (!L) return { blob: { v: 1, session: R.session, messages: R.messages, kv: R.kv || {} }, changedLocal: true, needsPush: false };
    const ls = L.session, rs = R.session;
    const dead = {};
    for (const src of [ls.deletedMsgs || {}, rs.deletedMsgs || {}]) for (const [id, t] of Object.entries(src)) dead[id] = Math.max(dead[id] || 0, t);

    const remoteMeta = (rs.metaAt || rs.updatedAt || 0) > (ls.metaAt || ls.updatedAt || 0);
    const session = Object.assign({}, ls, remoteMeta ? { title: rs.title, pinned: rs.pinned, metaAt: rs.metaAt || rs.updatedAt } : {}, {
      createdAt: Math.min(ls.createdAt || Infinity, rs.createdAt || Infinity),
      updatedAt: Math.max(ls.updatedAt || 0, rs.updatedAt || 0),
      deletedMsgs: dead
    });
    if (!Number.isFinite(session.createdAt)) session.createdAt = session.updatedAt;
    // cap tombstones so the item can't grow forever
    const deadIds = Object.keys(dead);
    if (deadIds.length > 500) deadIds.sort((a, b) => dead[a] - dead[b]).slice(0, deadIds.length - 500).forEach(k => delete dead[k]);

    const lm = new Map(L.messages.map(m => [m.id, m])), rm = new Map(R.messages.map(m => [m.id, m]));
    const out = [];
    for (const id of new Set([...lm.keys(), ...rm.keys()])) {
      const a = lm.get(id), b = rm.get(id);
      let pick, copy = null;
      if (a && b) {
        if (SyncMerge.sameMsg(a, b)) pick = a;
        else {
          const remoteWins = SyncMerge.stamp(b) > SyncMerge.stamp(a);
          pick = remoteWins ? b : a;
          const lose = remoteWins ? a : b;
          // Both sides edited this message differently: keep the winner in
          // place and preserve the other version as a visible copy (its id is
          // derived from its content, so every device creates the same copy).
          if (a.content !== b.content && a.patchedAt && b.patchedAt) {
            copy = Object.assign({}, lose, { id: id + '~c' + SyncMerge.hash(lose.content || ''), conflictOf: id, nickname: ((lose.nickname || '') + ' (other version)').trim(), timestamp: (pick.timestamp || 0) + 1 });
          }
        }
      } else pick = a || b;
      if (dead[id] && dead[id] >= SyncMerge.stamp(pick)) continue; // deleted somewhere, not edited since
      out.push(pick);
      if (copy) out.push(copy);
    }
    out.sort((x, y) => (x.timestamp - y.timestamp) || (x.id < y.id ? -1 : 1));

    const kv = Object.assign({}, L.kv || {});
    for (const [k, v] of Object.entries(R.kv || {})) if (!kv[k] || (v.t || 0) > (kv[k].t || 0)) kv[k] = v;

    const blob = { v: 1, session, messages: out, kv };
    const sm = SyncMerge.sig(blob);
    return { blob, changedLocal: sm !== SyncMerge.sig(L), needsPush: sm !== SyncMerge.sig(R) };
  },

  // Settings: { items: { key: { value, t } } } - newest write per key wins.
  settings(L, R, allowedKeys) {
    const items = Object.assign({}, L.items);
    let changedLocal = false;
    for (const [k, v] of Object.entries(R.items || {})) {
      if (!allowedKeys.includes(k) || SECRET_KEY_RE.test(k)) continue;
      if (!items[k] || (v.t || 0) > (items[k].t || 0)) { items[k] = v; changedLocal = true; }
    }
    let needsPush = false;
    for (const [k, v] of Object.entries(items)) { if (!R.items || !R.items[k] || (R.items[k].t || 0) < (v.t || 0)) needsPush = true; }
    return { items, changedLocal, needsPush };
  }
};

// ============================================================================
// Sync engine
// ============================================================================
const Sync = {
  state: null,          // persisted: { enabled, head, items, dirty, quota, lastSync, lastError, appearance, vault, r2 }
  status: 'local',      // local | locked | syncing | synced | pending | offline | error | paused
  statusDetail: '',
  _running: false,
  _again: false,
  _timer: null,
  _saveTimer: null,
  _poll: null,
  _shareTimers: {},
  _shareSigs: {},

  _fresh() {
    return { v: 1, enabled: false, head: null, items: {}, dirty: {}, quota: { day: '', writes: 0 }, lastSync: 0, lastError: null, appearance: false, vault: null, r2: false, pulled: false };
  },

  // ---- lifecycle -----------------------------------------------------------
  async init() {
    if (this._inited) return;
    this._inited = true;
    this.state = Object.assign(this._fresh(), await DB.getSetting('sync:state', null) || {});
    DB.on((evt) => this.onDbEvent(evt));
    DB.remoteAttachmentLoader = (id) => this.fetchAttachment(id);
    await Vault.restore();
    if (this.state.enabled && !Vault.key) this.setStatus('locked');
    else if (this.state.enabled) this.setStatus(this.hasDirty() ? 'pending' : 'idle');
    else this.setStatus('local');

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.scheduleSync(1500); });
      window.addEventListener('online', () => this.scheduleSync(1000));
      window.addEventListener('offline', () => this.setStatus('offline'));
      // Foreground check for changes from your other devices: one tiny "did
      // the head change?" request per minute while the tab is visible.
      this._poll = setInterval(() => { if (document.visibilityState === 'visible' && this.canSync()) this.syncNow(); }, 60000);
      const chip = document.getElementById('syncChip');
      if (chip) chip.addEventListener('click', () => { if (typeof Settings !== 'undefined') Settings.open(); });
      // ?pair=CODE link -> open Settings so the pair form (pre-filled) is visible
      let pending = null;
      try { pending = sessionStorage.getItem('workspace_pending_pair'); } catch (e) {}
      if (pending && typeof Settings !== 'undefined') setTimeout(() => Settings.open(), 400);
    }
    if (this.canSync()) this.scheduleSync(2000);
  },

  hasCredentials() { return !!(localStorage.getItem('workspace_pin') || localStorage.getItem('workspace_device_token')); },
  isConfigured() { return !!(this.state && this.state.enabled); },
  canSync() { return this.isConfigured() && !!Vault.key && this.hasCredentials(); },
  hasDirty() { return this.state && Object.keys(this.state.dirty).length > 0; },
  deviceId() { return localStorage.getItem('workspace_device_id') || 'dev_local'; },

  setStatus(s, detail) {
    this.status = s; this.statusDetail = detail || '';
    this.renderChip();
  },
  renderChip() {
    if (typeof document === 'undefined') return;
    const chip = document.getElementById('syncChip');
    if (!chip) return;
    const map = {
      local: ['Local only', 'off'], locked: ['Sync locked', 'warn'], idle: ['Sync on', 'ok'], syncing: ['Syncing…', 'busy'],
      synced: ['Synced', 'ok'], pending: ['Changes waiting', 'busy'], offline: ['Offline', 'off'], error: ['Sync error', 'bad'], paused: ['Sync paused', 'warn']
    };
    const [label, cls] = map[this.status] || map.local;
    chip.className = 'sync-chip sync-' + cls;
    chip.textContent = label;
    chip.title = this.statusDetail || (this.state && this.state.lastSync ? 'Last synced ' + new Date(this.state.lastSync).toLocaleString() : 'Click to open Sync & backup');
  },

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => { this._saveTimer = null; await this.saveState(); }, 400);
  },
  async saveState() { try { await DB.setSettingRaw('sync:state', this.state, Date.now()); } catch (e) {} },
  scheduleSync(delay) {
    if (!this.canSync()) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.syncNow(); }, delay == null ? SYNC_DEBOUNCE_MS : delay);
  },

  // ---- change tracking (from DB events) --------------------------------------
  markDirty(id, del) {
    if (!this.isConfigured()) return;
    this.state.dirty[id] = del ? { del: true } : true;
    this.scheduleSave();
    if (this.status === 'idle' || this.status === 'synced') this.setStatus('pending');
    this.scheduleSync();
  },
  isSyncedSettingKey(key) {
    if (SECRET_KEY_RE.test(key)) return false;
    return SYNC_SETTING_KEYS.includes(key) || (this.state && this.state.appearance && SYNC_APPEARANCE_KEYS.includes(key));
  },
  onDbEvent(evt) {
    if (evt.type === 'session') {
      this.markDirty('s:' + evt.sessionId);
      this.scheduleSharePush(evt.sessionId);
    } else if (evt.type === 'session-deleted') {
      this.markDirty('s:' + evt.sessionId, true);
      (evt.attachmentIds || []).forEach(id => this.markDirty('a:' + id, true));
    } else if (evt.type === 'attachment') {
      this.markDirty('a:' + evt.id);
    } else if (evt.type === 'attachment-deleted') {
      this.markDirty('a:' + evt.id, true);
    } else if (evt.type === 'setting') {
      const pre = SESSION_KV_PREFIXES.find(p => evt.key.startsWith(p));
      if (pre) this.markDirty('s:' + evt.key.slice(pre.length));
      else if (this.isSyncedSettingKey(evt.key)) this.markDirty('k:settings');
    }
  },
  // On startup/first sync: catch anything that changed while we weren't
  // watching (crash before the dirty list was saved, data from before sync
  // was turned on, etc).
  async reconcileLocal() {
    const items = this.state.items;
    const sessions = await DB.listSessions();
    const seen = new Set();
    for (const s of sessions) {
      seen.add('s:' + s.id);
      const it = items['s:' + s.id];
      if (!it || it.localT !== s.updatedAt) this.state.dirty['s:' + s.id] = this.state.dirty['s:' + s.id] || true;
    }
    for (const id of Object.keys(items)) {
      if (id.startsWith('s:') && !seen.has(id) && !items[id].d) this.state.dirty[id] = { del: true };
    }
    for (const a of await DB.listAllAttachmentMeta()) {
      if (!items['a:' + a.id]) this.state.dirty['a:' + a.id] = this.state.dirty['a:' + a.id] || true;
    }
    if (!items['k:settings']) this.state.dirty['k:settings'] = true;
  },

  // ---- quota bookkeeping (KV free tier: 1,000 writes/day) ----------------------
  _today() { return new Date().toISOString().slice(0, 10); },
  writesToday() { const q = this.state.quota; return q.day === this._today() ? q.writes : 0; },
  countWrite(n) {
    const q = this.state.quota, d = this._today();
    if (q.day !== d) { q.day = d; q.writes = 0; }
    q.writes += (n || 1);
  },
  quotaOk() { return this.writesToday() < SYNC_SOFT_WRITE_LIMIT; },

  // ---- building items ------------------------------------------------------------
  async buildSession(sid) {
    const session = await DB.getSessionRaw(sid);
    if (!session) return null;
    const messages = await DB.listMessages(sid);
    const kv = {};
    for (const p of SESSION_KV_PREFIXES) {
      const rec = await DB.getSettingRecord(p + sid);
      if (rec) kv[p.slice(0, -1)] = { value: rec.value, t: rec.t || 0 };
    }
    return { v: 1, session, messages, kv };
  },
  async buildSettings() {
    const keys = SYNC_SETTING_KEYS.concat(this.state.appearance ? SYNC_APPEARANCE_KEYS : []);
    const items = {};
    for (const k of keys) {
      if (SECRET_KEY_RE.test(k)) continue;
      const rec = await DB.getSettingRecord(k);
      if (rec) items[k] = { value: rec.value, t: rec.t || 1 };
    }
    return { v: 1, items };
  },
  async buildAttachment(id) {
    const rec = await DB.getAttachmentLocal(id);
    if (!rec) return null;
    const out = Object.assign({}, rec);
    if (out.base64 && out.base64.length > SYNC_MAX_ATTACHMENT_CHARS) { out.base64 = null; out.rawOmitted = true; }
    if (out.imageBase64 && out.imageBase64.length > SYNC_MAX_ATTACHMENT_CHARS) { out.imageBase64 = null; out.rawOmitted = true; }
    return { v: 1, att: out };
  },

  // ---- applying remote items -----------------------------------------------------
  async applySession(remote) {
    const sid = remote.session.id;
    const local = await this.buildSession(sid);
    const m = SyncMerge.session(local, remote);
    const blob = m.blob;
    await DB.quietly(async () => {
      await DB.putSessionRaw(blob.session);
      const localById = new Map((local ? local.messages : []).map(x => [x.id, x]));
      const mergedIds = new Set(blob.messages.map(x => x.id));
      for (const msg of blob.messages) {
        const prev = localById.get(msg.id);
        if (!prev || !SyncMerge.sameMsg(prev, msg)) await DB.putMessageRaw(msg);
      }
      for (const id of localById.keys()) if (!mergedIds.has(id)) await DB.deleteMessageRaw(id);
      for (const [k, v] of Object.entries(blob.kv || {})) {
        const cur = await DB.getSettingRecord(k + ':' + sid);
        if (!cur || (v.t || 0) > (cur.t || 0)) await DB.setSettingRaw(k + ':' + sid, v.value, v.t);
      }
    });
    return { changedLocal: m.changedLocal, needsPush: m.needsPush, localT: blob.session.updatedAt, sessionId: sid };
  },
  async applySettings(remote) {
    const local = await this.buildSettings();
    const allowed = SYNC_SETTING_KEYS.concat(this.state.appearance ? SYNC_APPEARANCE_KEYS : []);
    const m = SyncMerge.settings(local, remote, allowed);
    await DB.quietly(async () => {
      for (const [k, v] of Object.entries(m.items)) {
        const cur = await DB.getSettingRecord(k);
        if (!cur || (v.t || 0) > (cur.t || 0)) await DB.setSettingRaw(k, v.value, v.t);
      }
    });
    return { changedLocal: m.changedLocal, needsPush: m.needsPush };
  },
  async applyRemoteDelete(r) {
    if (r.id.startsWith('a:')) { await DB.quietly(() => DB.deleteAttachmentRaw(r.id.slice(2))); return { kept: false }; }
    const sid = r.id.slice(2);
    const local = await DB.getSessionRaw(sid);
    if (!local) return { kept: false };
    // Someone deleted it, but it was changed here afterwards: keep it (and
    // push it back) rather than silently destroying newer work.
    if ((local.updatedAt || 0) > r.t) return { kept: true };
    await DB.quietly(() => DB.deleteSession(sid, { silent: true }));
    return { kept: false, removed: true };
  },

  // ---- pull -----------------------------------------------------------------------
  async pull(force) {
    const { head, salt } = await Providers.syncHead();
    if (this.state.vault && salt !== this.state.vault.kdf.salt) {
      const err = new Error(salt ? 'The sync vault was reset on another device. Unlock again with its (new) passphrase.' : 'The cloud sync data was deleted from another device. Set sync up again to re-upload.');
      err.code = 'vault_changed';
      throw err;
    }
    if (!force && this.state.pulled && head === this.state.head) return { applied: 0, sessions: [] };
    const remote = [];
    let cursor = '';
    do { const r = await Providers.syncList(cursor); remote.push(...r.items); cursor = r.cursor; } while (cursor);

    let applied = 0, skipped = 0, settingsChanged = false;
    const changedSessions = [];
    for (const r of remote) {
      const known = this.state.items[r.id];
      if (known && known.v === r.v) continue;
      if (r.d) {
        const res = await this.applyRemoteDelete(r);
        if (res.kept) { this.state.dirty[r.id] = true; this.state.items[r.id] = { v: r.v, d: 1 }; }
        else { this.state.items[r.id] = { v: r.v, d: 1 }; delete this.state.dirty[r.id]; if (res.removed) changedSessions.push(r.id.slice(2)); }
        continue;
      }
      if (r.id.startsWith('a:')) { this.state.items[r.id] = { v: r.v }; continue; } // downloaded lazily, on first open
      let blob;
      try { blob = await Vault.open(await Providers.syncGetItem(r.id), r.id); }
      catch (e) {
        // A damaged item must not block everything else. Network/auth errors
        // (they carry a status/code) still abort the run and retry later.
        if (e.status || e.code || e.offline) throw e;
        skipped++; this.state.items[r.id] = { v: r.v, bad: 1 };
        if (typeof Logger !== 'undefined') Logger.warn('sync', `could not decrypt ${r.id} - skipped`);
        continue;
      }
      if (r.id === 'k:settings') {
        const res = await this.applySettings(blob);
        this.state.items[r.id] = { v: r.v };
        if (res.needsPush) this.state.dirty[r.id] = true;
        if (res.changedLocal) settingsChanged = true;
      } else {
        const res = await this.applySession(blob);
        this.state.items[r.id] = { v: r.v, localT: res.localT };
        if (res.needsPush) this.state.dirty[r.id] = true; else delete this.state.dirty[r.id];
        if (res.changedLocal) changedSessions.push(res.sessionId);
      }
      applied++;
    }
    this.state.head = head;
    this.state.pulled = true;
    return { applied, skipped, sessions: changedSessions, settingsChanged };
  },

  // ---- push -----------------------------------------------------------------------
  _rev(v) { const n = parseInt(String(v || '0'), 10); return Number.isFinite(n) ? n : 0; },
  async push() {
    let pushed = 0;
    const ids = Object.keys(this.state.dirty).slice(0, SYNC_MAX_PER_RUN);
    for (const id of ids) {
      const useKv = !(this.state.r2 && id.startsWith('a:'));
      if (useKv && !this.quotaOk()) { this.setStatus('paused', 'Cloudflare free tier allows ~1,000 writes/day; sync resumes after 00:00 UTC.'); return { pushed, paused: true }; }
      const flag = this.state.dirty[id];
      delete this.state.dirty[id]; // anything that changes from here on re-marks it
      try {
        let bytes = null, deleted = !!(flag && flag.del), localT;
        if (!deleted) {
          let built = null;
          if (id.startsWith('s:')) { built = await this.buildSession(id.slice(2)); if (built) localT = built.session.updatedAt; }
          else if (id.startsWith('a:')) built = await this.buildAttachment(id.slice(2));
          else if (id === 'k:settings') built = await this.buildSettings();
          if (!built) {
            // vanished locally: tombstone if the server knows it, otherwise nothing to do
            if (this.state.items[id] && !this.state.items[id].d && id.startsWith('s:')) deleted = true;
            else continue;
          } else bytes = await Vault.seal(built, id);
        }
        const v = `${this._rev(this.state.items[id] && this.state.items[id].v) + 1}.${this.deviceId()}`;
        await Providers.syncPutItem(id, v, deleted ? new Uint8Array([0]) : bytes, deleted);
        if (useKv) this.countWrite();
        this.state.items[id] = { v, localT, d: deleted ? 1 : 0 };
        pushed++;
      } catch (e) {
        this.state.dirty[id] = flag || true; // retry next run
        throw e;
      }
    }
    if (pushed) {
      const { head } = await Providers.syncCommit();
      this.countWrite();
      this.state.head = head;
    }
    return { pushed };
  },

  // ---- one full cycle ---------------------------------------------------------------
  async syncNow(opts) {
    opts = opts || {};
    if (!this.isConfigured()) return { skipped: 'not configured' };
    if (!Vault.key) { this.setStatus('locked'); return { skipped: 'locked' }; }
    if (!this.hasCredentials()) { this.setStatus('local'); return { skipped: 'no credentials' }; }
    if (this._running) { this._again = true; return { skipped: 'busy' }; }
    this._running = true;
    this.setStatus('syncing');
    let result = {};
    try {
      await this.reconcileLocal();
      const pulled = await this.pull(!!opts.force);
      const pushRes = await this.push();
      this.state.lastSync = Date.now();
      this.state.lastError = pulled.skipped ? `${pulled.skipped} item(s) could not be decrypted and were skipped` : null;
      result = { pulled, pushed: pushRes.pushed, paused: pushRes.paused };
      if (!pushRes.paused) this.setStatus(this.hasDirty() ? 'pending' : 'synced');
      if (typeof Logger !== 'undefined') Logger.info('sync', `sync ok - pulled ${pulled.applied}, pushed ${pushRes.pushed}`);
      if ((pulled.sessions && pulled.sessions.length) || pulled.settingsChanged) await this.afterApply(pulled);
      if (this.hasDirty() && !pushRes.paused) this._again = true; // more than one batch waiting
    } catch (e) {
      this.state.lastError = e.message;
      if (e.offline) this.setStatus('offline', e.message);
      else if (e.code === 'quota') { this.state.quota = { day: this._today(), writes: 1000 }; this.setStatus('paused', e.message); }
      else if (e.code === 'device_revoked') { /* handleRevoked already ran */ }
      else if (e.code === 'vault_changed') { await Vault.forget(); this.setStatus('locked', e.message); }
      else this.setStatus('error', e.message);
      if (typeof Logger !== 'undefined') Logger.warn('sync', 'sync failed: ' + e.message);
      result = { error: e.message };
    } finally {
      this._running = false;
      await this.saveState();
      if (this._again) { this._again = false; this.scheduleSync(2500); }
    }
    return result;
  },

  // UI refresh after remote data landed. Never yanks the chat out from under an
  // in-flight reply.
  async afterApply(pulled) {
    if (typeof App === 'undefined' || !App.renderSessionList) return;
    try {
      if (pulled.settingsChanged && typeof Settings !== 'undefined') { await Settings.applyStoredAppearance?.(); await App.refreshHeaderChips?.(); }
      await App.renderSessionList();
      const busy = document.querySelector('#chatLog .typing-dots');
      if (App.currentSessionId && pulled.sessions.includes(App.currentSessionId) && !busy) await App.openSession(App.currentSessionId);
    } catch (e) { if (typeof Logger !== 'undefined') Logger.warn('sync', 'UI refresh failed: ' + e.message); }
  },

  // Lazy attachment download (files added on another device).
  async fetchAttachment(id) {
    if (!this.canSync()) return null;
    const blob = await Vault.open(await Providers.syncGetItem('a:' + id), 'a:' + id);
    if (!blob || !blob.att) return null;
    await DB.quietly(() => DB.putAttachmentRaw(blob.att));
    return DB.getAttachmentLocal(id);
  },

  // ---- setup / pairing / lock -------------------------------------------------------
  async setup(passphrase) {
    const s = Vault.strength(passphrase);
    if (s.level < 1) throw new Error('Passphrase ' + s.label + '.');
    const vault = await Vault.create(passphrase);
    let res;
    try { res = await Providers.syncCreateVault(vault); }
    catch (e) { Vault.key = null; if (e.code === 'vault_exists') throw new Error('This workspace already has an encrypted vault - unlock it with its passphrase instead.'); throw e; }
    await Vault.persist();
    this.state = Object.assign(this._fresh(), { enabled: true, vault: res.vault, appearance: !!(this.state && this.state.appearance) });
    await this.saveState();
    this.setStatus('idle');
    return this.syncNow({ force: true }); // first full upload; errors land in the status chip
  },
  async unlock(passphrase, vault) {
    vault = vault || (await Providers.syncStatus()).vault;
    if (!vault) throw new Error('No vault exists yet - set up sync first.');
    if (!(await Vault.unlock(passphrase, vault))) throw new Error('That passphrase did not unlock the vault.');
    await Vault.persist();
    // Keep old bookkeeping only for the SAME vault; a reset/new vault means the
    // remembered remote versions are meaningless (and could wrongly match).
    const sameVault = !!(this.state && this.state.enabled && this.state.vault && this.state.vault.kdf.salt === vault.kdf.salt);
    this.state = Object.assign(this._fresh(), sameVault ? this.state : {}, { enabled: true, vault, appearance: !!(this.state && this.state.appearance) });
    await this.saveState();
    this.setStatus('idle');
    return this.syncNow({ force: true }); // restores your workspace before returning
  },
  // New device: redeem the one-time code -> per-device token, then unlock.
  async pairWithCode(code, passphrase, deviceName) {
    const res = await Providers.redeemPairCode(code, deviceName || describeDevice(), describeDevice());
    localStorage.setItem('workspace_device_id', res.deviceId);
    localStorage.setItem('workspace_device_token', res.deviceToken);
    localStorage.removeItem('workspace_pin'); // a paired device authenticates with its own revocable token
    _authRejectedSig = null;
    if (!res.vault) return { paired: true, vault: false };
    let sync;
    try { sync = await this.unlock(passphrase, res.vault); }
    catch (e) { return { paired: true, vault: true, unlocked: false, error: e.message }; }
    return { paired: true, vault: true, unlocked: true, sync };
  },
  handleRevoked() {
    localStorage.removeItem('workspace_device_token');
    if (this.state) { this.state.enabled = false; this.saveState(); }
    Vault.forget();
    this.setStatus('local', 'This device was removed from the workspace.');
    if (typeof Toast !== 'undefined') Toast.show('This device was removed from the workspace. Pair it again or enter your PIN.', true);
  },
  async lock() { await Vault.forget(); this.setStatus(this.isConfigured() ? 'locked' : 'local'); },
  // Disconnect: keep your local chats, forget credentials + sync bookkeeping.
  async disconnect() {
    await Vault.forget();
    localStorage.removeItem('workspace_device_token');
    this.state = Object.assign(this._fresh(), { appearance: this.state ? this.state.appearance : false });
    await this.saveState();
    this.setStatus('local');
  },
  // "Clear everything" wipes THIS device only; forgetting the bookkeeping makes
  // the next sync re-download from the cloud instead of treating it as deletions.
  async resetLocalState() {
    if (!this.state) return;
    this.state.items = {}; this.state.dirty = {}; this.state.head = null; this.state.pulled = false;
    await this.saveState();
  },
  async wipeCloud() {
    let guard = 0, res;
    do { res = await Providers.syncReset(); guard++; } while (!res.done && guard < 50);
    if (!res.done) throw new Error('Cloud wipe is still in progress - run it again in a moment (Cloudflare limits deletes per day).');
    await this.disconnect();
  },
  async setAppearanceSync(on) {
    this.state.appearance = !!on;
    if (on) this.markDirty('k:settings');
    await this.saveState();
  }
};

// ============================================================================
// Live shared chats - owner side: push new messages to the SAME link
// ============================================================================
Object.assign(Sync, {
  // Any change to a session that has a live link schedules one debounced push.
  async scheduleSharePush(sessionId) {
    let links;
    try { links = await DB.getSetting('shareLinks', []); } catch (e) { return; }
    if (!links.some(l => l.sessionId === sessionId)) return;
    clearTimeout(this._shareTimers[sessionId]);
    this._shareTimers[sessionId] = setTimeout(() => this.pushShare(sessionId), 6000);
  },
  async pushShare(sessionId) {
    const links = await DB.getSetting('shareLinks', []);
    const mine = links.filter(l => l.sessionId === sessionId);
    if (!mine.length || !Sync.hasCredentials()) return;
    const session = await DB.getSessionRaw(sessionId);
    if (!session) return;
    const messages = await DB.exportSessionForShare(sessionId);
    const sig = SyncMerge.hash(session.title + '\u0000' + JSON.stringify(messages));
    if (this._shareSigs[sessionId] === sig) return; // nothing a viewer could see changed
    let gone = [];
    for (const l of mine) {
      try {
        await Providers.updateShare(l.token, session.title, messages);
        if (this.state) this.countWrite();
      } catch (e) {
        if (e.code === 'gone') gone.push(l.token);
        else { if (typeof Logger !== 'undefined') Logger.warn('share', 'live share update failed: ' + e.message); return; }
      }
    }
    this._shareSigs[sessionId] = sig;
    if (gone.length) {
      const remaining = (await DB.getSetting('shareLinks', [])).filter(l => !gone.includes(l.token));
      await DB.setSetting('shareLinks', remaining);
    }
  }
});

// ============================================================================
// Read-only live viewer for ?share=<token> links
// ============================================================================
// No PIN, no workspace data: it only ever talks to GET /api/share/<token>.
// Polls with the last revision it has, so an unchanged chat costs one tiny
// request; backs off when idle, pauses while the tab is hidden.
const Viewer = {
  token: null, rev: 0, session: null, timer: null, failures: 0, lastChangeAt: Date.now(), stopped: false, renderedIds: [],

  async start(token) {
    this.token = token;
    document.body.classList.add('viewer-mode');
    const root = document.createElement('div');
    root.id = 'viewerRoot';
    root.innerHTML = `
      <header class="viewer-head">
        <div class="viewer-title" id="viewerTitle">Loading shared chat…</div>
        <span class="viewer-pill" id="viewerPill">connecting</span>
        <button class="small-btn" id="viewerCopyBtn" hidden>Save a copy to my workspace</button>
        <a class="small-btn" id="viewerOpenBtn" href="${window.location.pathname}">Open workspace</a>
      </header>
      <main class="viewer-log" id="viewerLog" aria-live="polite"></main>
      <footer class="viewer-foot">Read-only live view. It updates automatically while the owner keeps chatting.</footer>`;
    document.body.appendChild(root);
    document.getElementById('viewerCopyBtn').addEventListener('click', () => this.saveCopy());
    document.addEventListener('visibilitychange', () => {
      if (this.stopped) return;
      if (document.visibilityState === 'visible') this.poll(); else clearTimeout(this.timer);
    });
    await this.poll();
  },

  setPill(text, cls) {
    const p = document.getElementById('viewerPill');
    if (p) { p.textContent = text; p.className = 'viewer-pill ' + (cls || ''); }
  },
  nextDelay() {
    if (this.failures) return Math.min(60000, 5000 * Math.pow(2, this.failures));
    const idle = Date.now() - this.lastChangeAt;
    if (idle < 2 * 60000) return 8000;
    if (idle < 10 * 60000) return 20000;
    if (idle < 30 * 60000) return 45000;
    return 90000;
  },

  async poll() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    try {
      const res = await Providers.getSharedSession(this.token, this.rev);
      this.failures = 0;
      if (!res.unchanged && res.session) {
        this.session = res.session;
        this.rev = res.session.rev || 1;
        this.lastChangeAt = Date.now();
        this.render();
      }
      const t = this.session ? new Date(this.session.updatedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      this.setPill(t ? `live · updated ${t}` : 'live', 'ok');
    } catch (e) {
      if (e.code === 'gone') {
        this.stopped = true;
        this.setPill(this.session ? 'sharing stopped' : 'link invalid', 'bad');
        const t = document.getElementById('viewerTitle');
        if (t && !this.session) t.textContent = 'This link has expired or was revoked';
        return;
      }
      this.failures = Math.min(this.failures + 1, 4);
      this.setPill('reconnecting…', 'warn');
    }
    if (document.visibilityState !== 'hidden') this.timer = setTimeout(() => this.poll(), this.nextDelay());
  },

  render() {
    const s = this.session;
    document.title = (s.title || 'Shared chat') + ' - shared';
    document.getElementById('viewerTitle').textContent = s.title || 'Shared chat';
    document.getElementById('viewerCopyBtn').hidden = false;
    const log = document.getElementById('viewerLog');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    const ids = s.messages.map(m => m.id || '');
    // Append-only fast path (the common case); otherwise re-render everything
    // (an edit or delete happened).
    const canAppend = this.renderedIds.length > 0 && this.renderedIds.length <= ids.length && this.renderedIds.every((id, i) => id && id === ids[i]);
    if (!canAppend) { log.innerHTML = ''; this.renderedIds = []; }
    for (let i = this.renderedIds.length; i < s.messages.length; i++) log.appendChild(this.renderMessage(s.messages[i]));
    this.renderedIds = ids;
    if (nearBottom || !canAppend) log.scrollTop = log.scrollHeight;
  },
  renderMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'viewer-msg ' + (m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'ai');
    const label = document.createElement('div');
    label.className = 'viewer-label';
    label.textContent = m.role === 'user' ? 'You' : (m.nickname || 'AI');
    if (m.role !== 'user' && m.nickname) {
      const pid = App.findProviderIdByNickname ? App.findProviderIdByNickname(m.nickname, DEFAULT_NICKNAMES) : null;
      if (pid && typeof providerColor === 'function') wrap.style.setProperty('--msg-accent', providerColor(pid));
    }
    const body = document.createElement('div');
    body.className = 'viewer-body';
    // AI text goes through the app's markdown renderer, which HTML-escapes first;
    // user text is set as plain text.
    if (m.role === 'user') body.textContent = m.content; else body.innerHTML = App.renderMarkdown(m.content || '');
    wrap.append(label, body);
    if (m.files && m.files.length) {
      const f = document.createElement('div');
      f.className = 'viewer-files';
      m.files.forEach(n => { const c = document.createElement('span'); c.textContent = n; f.appendChild(c); });
      wrap.appendChild(f);
    }
    return wrap;
  },

  async saveCopy() {
    if (!this.session) return;
    try {
      await DB.importSharedSession(this.session.title, this.session.messages);
      window.location.href = window.location.pathname;
    } catch (e) { alert('Could not save a copy: ' + e.message); }
  }
};

// ============================================================================
// Encrypted backup file (.awbackup) - independent of cloud sync
// ============================================================================
// Layout: "AWB1" | iterations (u32 BE) | salt (16) | sealed blob. The sealed blob
// is gzip(JSON) encrypted with AES-256-GCM under a PBKDF2-derived key. Restoring
// MERGES into what's on the device (same merge rules as sync), so importing the
// same file twice, or into a device that already has some of the data, never
// duplicates or overwrites newer work.
const Backup = {
  MAGIC: [0x41, 0x57, 0x42, 0x31],

  async collect() {
    const sessions = [], attachments = [];
    for (const s of await DB.listSessions()) sessions.push(await Sync.buildSession(s.id));
    for (const a of await DB.listAllAttachmentMeta()) { const rec = await DB.getAttachmentLocal(a.id); if (rec) attachments.push(rec); }
    const items = {};
    for (const k of SYNC_SETTING_KEYS.concat(SYNC_APPEARANCE_KEYS)) {
      const rec = await DB.getSettingRecord(k);
      if (rec) items[k] = { value: rec.value, t: rec.t || 1 };
    }
    return { format: 'ai-workspace-backup', v: 1, exportedAt: Date.now(), sessions: sessions.filter(Boolean), attachments, settings: { v: 1, items } };
  },
  async exportEncrypted(passphrase) {
    if (Vault.strength(passphrase).level < 1) throw new Error('Choose a backup passphrase of at least 10 characters.');
    const data = await Backup.collect();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await Vault.derive(passphrase, salt, Vault.ITERATIONS);
    const sealed = await Vault.sealBytes(key, new TextEncoder().encode(JSON.stringify(data)), 'backup', true);
    const head = new Uint8Array(4 + 4 + 16);
    head.set(Backup.MAGIC, 0);
    new DataView(head.buffer).setUint32(4, Vault.ITERATIONS, false);
    head.set(salt, 8);
    const out = new Uint8Array(head.length + sealed.length);
    out.set(head, 0); out.set(sealed, head.length);
    return { bytes: out, sessions: data.sessions.length, attachments: data.attachments.length };
  },
  async importEncrypted(bytes, passphrase) {
    if (bytes.length < 50 || Backup.MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('This is not an AI Workspace backup file.');
    const iterations = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, false);
    if (iterations < 100000 || iterations > 5000000) throw new Error('Backup file looks corrupted.');
    const key = await Vault.derive(passphrase, bytes.slice(8, 24), iterations);
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await Vault.openBytes(key, bytes.slice(24), 'backup'))); }
    catch (e) { throw new Error('Wrong passphrase, or the file is damaged.'); }
    if (!data || data.format !== 'ai-workspace-backup') throw new Error('Unrecognised backup contents.');

    let sessions = 0, attachments = 0;
    for (const blob of data.sessions || []) { if (blob && blob.session && blob.session.id) { await Sync.applySession(blob); sessions++; } }
    for (const rec of data.attachments || []) {
      if (rec && rec.id && !(await DB.getAttachmentLocal(rec.id))) { await DB.quietly(() => DB.putAttachmentRaw(rec)); attachments++; }
    }
    const items = (data.settings && data.settings.items) || {};
    await DB.quietly(async () => {
      for (const [k, v] of Object.entries(items)) {
        if (SECRET_KEY_RE.test(k) || !(SYNC_SETTING_KEYS.includes(k) || SYNC_APPEARANCE_KEYS.includes(k))) continue;
        const cur = await DB.getSettingRecord(k);
        if (!cur || (v.t || 0) > (cur.t || 0)) await DB.setSettingRaw(k, v.value, v.t);
      }
    });
    if (Sync.isConfigured()) { await Sync.reconcileLocal(); Sync.scheduleSave(); Sync.scheduleSync(3000); }
    return { sessions, attachments };
  }
};

// ============================================================================
// Storage helpers
// ============================================================================
const StorageTools = {
  fmt(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(2) + ' GB'; },
  async report() {
    const out = { breakdown: await DB.storageBreakdown(), usage: null, quota: null, persisted: null };
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; } } catch (e) {}
    try { if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch (e) {}
    return out;
  },
  async persist() { try { return !!(navigator.storage && navigator.storage.persist && await navigator.storage.persist()); } catch (e) { return false; } }
};

// ============================================================================
// Settings -> "Sync & backup" panel
// ============================================================================
const SyncUI = {
  _countdown: null,
  esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  ago(t) {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago';
  },

  async html() {
    const st = Sync.state || Sync._fresh();
    const hasCreds = Sync.hasCredentials();
    let server = null, serverErr = null;
    if (hasCreds) { try { server = await Providers.syncStatus(); } catch (e) { serverErr = e; } }
    const vault = server && server.vault;
    const owner = server && server.role === 'owner';
    const active = Sync.isConfigured() && !!Vault.key;
    const nameDefault = this.esc(describeDevice());
    const pending = (() => { try { return sessionStorage.getItem('workspace_pending_pair') || ''; } catch (e) { return ''; } })();

    let body = `
      <div class="settings-hint" style="margin-bottom:10px">
        Your chats are encrypted <b>in this browser</b> (AES-256-GCM, key derived from your passphrase) before upload; the Worker stores only ciphertext.
        Provider API keys are never synced. <b>Caveat:</b> messages still pass through your Worker in plain text to reach the AI providers - the encryption protects the stored copy, not that live request.
        <b>If you forget the passphrase, the cloud copy cannot be recovered</b> (your local chats are unaffected).
      </div>
      <div class="settings-row" style="justify-content:space-between">
        <span>Status: <b id="syStatusText">${this.esc(this.statusLabel())}</b> · last sync ${this.esc(this.ago(st.lastSync))}</span>
        ${active ? '<button type="button" class="small-btn" id="sySyncNowBtn">sync now</button>' : ''}
      </div>
      ${st.lastError ? `<div style="font-size:12px;color:#d98a5f;margin:4px 0">Last error: ${this.esc(st.lastError)}</div>` : ''}`;

    const pairForm = `
      <div class="settings-card">
        <div class="settings-subhead">Pair this device with a code</div>
        <div class="settings-hint">On a device that's already set up: Settings → Sync &amp; backup → "Generate pairing code". Codes work once and expire after 5 minutes.</div>
        <div class="settings-row"><label>Code</label><input type="text" id="syPairCode" value="${this.esc(pending)}" placeholder="XXXX-XXXX" autocapitalize="characters" autocomplete="off" spellcheck="false" style="text-transform:uppercase" /></div>
        <div class="settings-row"><label>Sync passphrase</label><input type="password" id="syPairPass" placeholder="the passphrase you chose when setting up sync" autocomplete="off" /></div>
        <div class="settings-row"><label>Device name</label><input type="text" id="syPairName" value="${nameDefault}" maxlength="60" /></div>
        <button type="button" class="small-btn" id="syPairBtn">pair &amp; restore</button>
        <div class="settings-hint" id="syPairMsg"></div>
      </div>`;

    if (serverErr && serverErr.code !== 'unauthorized') {
      body += `<div class="settings-hint" style="color:#d98a5f">Can't reach the sync service right now (${this.esc(serverErr.message)}). Your local data is safe; sync will retry.</div>`;
    }
    if (!hasCreds || (serverErr && serverErr.code === 'unauthorized')) {
      body += `<div class="settings-hint">Not connected yet. Enter your PIN in <b>Connection</b> above, or pair this device with a code:</div>` + pairForm;
    } else if (server && !vault) {
      body += `
        <div class="settings-card">
          <div class="settings-subhead">Turn on encrypted sync</div>
          <div class="settings-hint">Choose a passphrase. Use the generator for a strong one and store it in a password manager - you'll type it once per new device.</div>
          <div class="settings-row"><label>Passphrase</label><input type="password" id="sySetupPass" autocomplete="new-password" placeholder="10+ characters" /></div>
          <div class="settings-row"><label>Repeat</label><input type="password" id="sySetupPass2" autocomplete="new-password" /></div>
          <div class="settings-hint" id="sySetupStrength"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="small-btn" id="sySetupBtn">enable sync</button><button type="button" class="small-btn" id="syGenBtn">generate strong passphrase</button></div>
          <div class="settings-hint" id="sySetupMsg"></div>
        </div>`;
    } else if (server && vault && !active) {
      body += `
        <div class="settings-card">
          <div class="settings-subhead">Unlock sync on this device</div>
          <div class="settings-row"><label>Passphrase</label><input type="password" id="syUnlockPass" autocomplete="current-password" /></div>
          <button type="button" class="small-btn" id="syUnlockBtn">unlock &amp; sync</button>
          <div class="settings-hint" id="syUnlockMsg"></div>
        </div>`;
    } else if (active) {
      let devices = [];
      try { devices = (await Providers.listDevices()).devices || []; } catch (e) { devices = []; }
      const writes = Sync.writesToday();
      body += `
        <div class="settings-card">
          <div class="settings-subhead">Add another device</div>
          ${owner ? `
            <button type="button" class="small-btn" id="syGenCodeBtn">generate pairing code</button>
            <div id="syCodeBox" style="margin-top:10px"></div>` :
            `<div class="settings-hint">Adding or removing devices needs your master PIN. Enter it in <b>Connection</b> above (this device is signed in with its own token).</div>`}
        </div>
        <div class="settings-card">
          <div class="settings-subhead">Devices</div>
          ${devices.length ? devices.map(d => `
            <div class="settings-row" style="justify-content:space-between;gap:8px">
              <div style="min-width:0"><div style="font-size:13px">${this.esc(d.name || d.description || 'Device')}${d.isThisDevice ? ' <span class="viewer-pill ok">this device</span>' : ''}</div>
              <div class="settings-hint" style="margin:0">${d.kind === 'paired' ? 'paired' : 'PIN sign-in'} · seen ${this.esc(this.ago(d.lastSeen))}</div></div>
              ${d.kind === 'paired' && owner ? `<button type="button" class="small-btn syRevoke" data-id="${this.esc(d.id)}">revoke</button>` : ''}
            </div>`).join('') : '<div class="settings-hint">No devices listed yet.</div>'}
          <div class="settings-hint">Revoking cuts that device off immediately. Devices that sign in with the master PIN can't be revoked individually - change the PIN secret in Cloudflare to cut those off.</div>
        </div>
        <div class="settings-card">
          <div class="settings-subhead">Options</div>
          <label class="settings-row" style="gap:8px"><input type="checkbox" id="syAppearance" ${st.appearance ? 'checked' : ''} /> also sync appearance (theme, fonts, bubbles)</label>
          <div class="settings-hint">Cloudflare free tier allows ~1,000 KV writes/day across everything; sync has used about ${writes} today and pauses near 850. Files count as writes unless you bind an R2 bucket${server && server.r2 ? ' (R2 is bound - files go there)' : ''}.</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <button type="button" class="small-btn" id="syLockBtn">lock this device</button>
            <button type="button" class="small-btn" id="syDisconnectBtn">disconnect this device</button>
            ${owner ? '<button type="button" class="small-btn" id="syWipeBtn" style="color:#d98a5f">delete all cloud data…</button>' : ''}
          </div>
          <div class="settings-hint" id="syOptMsg"></div>
        </div>`;
    }

    // ---- backup + storage (work with or without cloud sync) ----
    const rep = await StorageTools.report();
    const bd = rep.breakdown, f = StorageTools.fmt;
    body += `
      <div class="settings-card">
        <div class="settings-subhead">Encrypted backup file</div>
        <div class="settings-hint">A single <b>.awbackup</b> file with every chat, attachment and setting, encrypted with its own passphrase. Restoring merges - it never duplicates or overwrites newer work. Keep one somewhere safe (not only in the browser).</div>
        <div class="settings-row"><label>Passphrase</label><input type="password" id="syBackupPass" autocomplete="off" /></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button type="button" class="small-btn" id="syBackupExportBtn">export backup</button>
          <button type="button" class="small-btn" id="syBackupImportBtn">restore from file…</button>
          <input type="file" id="syBackupFile" accept=".awbackup" hidden />
        </div>
        <div class="settings-hint" id="syBackupMsg"></div>
      </div>
      <div class="settings-card">
        <div class="settings-subhead">Storage on this device</div>
        <div class="settings-hint" style="margin:0">Chats ${f(bd.messages)} · file text ${f(bd.attachmentText)} · original files ${f(bd.attachmentFiles)} (text is stored gzip-compressed).
          ${rep.usage != null ? `<br>Browser reports ${f(rep.usage)} used of ~${f(rep.quota)} available.` : ''}
          <br>Persistent storage: <b>${rep.persisted == null ? 'unknown' : (rep.persisted ? 'granted - the browser won\'t evict your data' : 'not granted - the browser may clear data under storage pressure')}</b></div>
        ${rep.persisted ? '' : '<button type="button" class="small-btn" id="syPersistBtn" style="margin-top:8px">ask browser to keep my data</button>'}
        <div class="settings-hint" id="syStorageMsg"></div>
      </div>`;

    return `<div class="settings-group" id="syncGroup"><div class="settings-group-title">Sync &amp; backup</div>${body}</div>`;
  },

  statusLabel() {
    return ({ local: 'local only', locked: 'locked - enter passphrase', idle: 'on', syncing: 'syncing…', synced: 'synced', pending: 'changes waiting', offline: 'offline', error: 'error', paused: 'paused (daily limit)' })[Sync.status] || Sync.status;
  },

  async rerender() {
    if (typeof Settings === 'undefined' || !Settings.bodyEl) return;
    const y = Settings.bodyEl.scrollTop;
    await Settings.render();
    Settings.bodyEl.scrollTop = y;
  },
  say(root, id, msg, bad) {
    const el = root.querySelector('#' + id);
    if (el) { el.textContent = msg; el.style.color = bad ? '#d98a5f' : ''; }
  },
  // Disable the button while an async action runs; surface errors in `msgId`.
  async run(root, btn, msgId, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const old = btn.textContent;
    try { await fn(); }
    catch (e) { this.say(root, msgId, e.message || String(e), true); }
    finally { btn.disabled = false; btn.textContent = old; }
  },

  wire(root) {
    const $ = (id) => root.querySelector('#' + id);
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => fn(el)); };

    on('syPairBtn', (btn) => this.run(root, btn, 'syPairMsg', async () => {
      const code = $('syPairCode').value.trim();
      if (!code) throw new Error('Enter the pairing code shown on your other device.');
      btn.textContent = 'pairing…';
      this.say(root, 'syPairMsg', 'Deriving key - this takes a second or two…');
      const r = await Sync.pairWithCode(code, $('syPairPass').value, $('syPairName').value.trim());
      try { sessionStorage.removeItem('workspace_pending_pair'); } catch (e) {}
      if (r.paired && r.unlocked) { Toast.show('Paired. Restoring your workspace…'); await this.rerender(); }
      else if (r.paired && !r.vault) { Toast.show('Paired, but sync has not been set up yet - set it up from your main device.', true); await this.rerender(); }
      else throw new Error('Paired, but that passphrase did not unlock the vault. Enter the passphrase in the unlock form below.');
    }));

    const strength = () => {
      const el = $('sySetupStrength'), p = $('sySetupPass');
      if (el && p) { const s = Vault.strength(p.value); el.textContent = p.value ? 'Strength: ' + s.label : ''; }
    };
    const sp = $('sySetupPass'); if (sp) sp.addEventListener('input', strength);
    on('syGenBtn', () => {
      const g = Vault.generate();
      $('sySetupPass').type = 'text'; $('sySetupPass2').type = 'text';
      $('sySetupPass').value = g; $('sySetupPass2').value = g; strength();
      this.say(root, 'sySetupMsg', 'Save this passphrase in a password manager BEFORE enabling sync.');
    });
    on('sySetupBtn', (btn) => this.run(root, btn, 'sySetupMsg', async () => {
      const a = $('sySetupPass').value, b = $('sySetupPass2').value;
      if (a !== b) throw new Error('The two passphrases do not match.');
      btn.textContent = 'enabling…';
      this.say(root, 'sySetupMsg', 'Deriving key - this takes a second or two…');
      await Sync.setup(a);
      Toast.show('Encrypted sync is on. First upload is running in the background.');
      await this.rerender();
    }));
    on('syUnlockBtn', (btn) => this.run(root, btn, 'syUnlockMsg', async () => {
      btn.textContent = 'unlocking…';
      await Sync.unlock($('syUnlockPass').value);
      await this.rerender();
    }));
    on('sySyncNowBtn', (btn) => this.run(root, btn, 'syOptMsg', async () => {
      btn.textContent = 'syncing…';
      const r = await Sync.syncNow({ force: true });
      Toast.show(r && r.error ? 'Sync failed: ' + r.error : 'Sync complete', !!(r && r.error));
      await this.rerender();
    }));
    on('syGenCodeBtn', (btn) => this.run(root, btn, 'syOptMsg', async () => {
      const r = await Providers.createPairCode();
      const box = $('syCodeBox');
      const link = `${window.location.origin}${window.location.pathname}?pair=${encodeURIComponent(r.code)}`;
      box.innerHTML = `<div style="font-size:26px;letter-spacing:4px;font-family:var(--font-mono,monospace);font-weight:600">${this.esc(r.code)}</div>
        <div class="settings-hint" id="syCodeTimer"></div>
        <button type="button" class="small-btn" id="syCopyCode">copy code</button> <button type="button" class="small-btn" id="syCopyLink">copy pairing link</button>
        <div class="settings-hint">On the new device: open the site → Settings → Sync &amp; backup → enter this code and your sync passphrase. The code works once.</div>`;
      box.querySelector('#syCopyCode').addEventListener('click', () => navigator.clipboard.writeText(r.code).then(() => Toast.show('Code copied')));
      box.querySelector('#syCopyLink').addEventListener('click', () => navigator.clipboard.writeText(link).then(() => Toast.show('Link copied (code inside - single use, 5 min)')));
      let left = r.expiresInSeconds;
      clearInterval(this._countdown);
      this._countdown = setInterval(() => {
        const t = box.querySelector('#syCodeTimer');
        if (!t || !document.body.contains(t)) { clearInterval(this._countdown); return; }
        left--;
        if (left <= 0) { clearInterval(this._countdown); box.innerHTML = '<div class="settings-hint">Code expired. Generate a new one.</div>'; return; }
        t.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      }, 1000);
    }));
    root.querySelectorAll('.syRevoke').forEach(btn => btn.addEventListener('click', () => this.run(root, btn, 'syOptMsg', async () => {
      if (!confirm('Revoke this device? It will lose access immediately.')) return;
      await Providers.revokeDevice(btn.dataset.id);
      Toast.show('Device revoked');
      await this.rerender();
    })));
    const ap = $('syAppearance');
    if (ap) ap.addEventListener('change', async () => { await Sync.setAppearanceSync(ap.checked); Toast.show(ap.checked ? 'Appearance will sync' : 'Appearance stays per-device'); });
    on('syLockBtn', async () => { await Sync.lock(); Toast.show('Locked. Enter the passphrase to sync again.'); await this.rerender(); });
    on('syDisconnectBtn', async () => {
      if (!confirm('Disconnect this device from sync? Your local chats stay. You can pair again later.')) return;
      await Sync.disconnect(); await this.rerender();
    });
    on('syWipeBtn', (btn) => this.run(root, btn, 'syOptMsg', async () => {
      if (prompt('This permanently deletes ALL synced data from the cloud (your chats on other devices are not touched, but they will have nothing to sync with). Type DELETE to confirm.') !== 'DELETE') return;
      btn.textContent = 'deleting…';
      await Sync.wipeCloud();
      Toast.show('Cloud data deleted');
      await this.rerender();
    }));

    on('syBackupExportBtn', (btn) => this.run(root, btn, 'syBackupMsg', async () => {
      btn.textContent = 'encrypting…';
      this.say(root, 'syBackupMsg', 'Building backup - large chats/files can take a moment…');
      const r = await Backup.exportEncrypted($('syBackupPass').value);
      const blob = new Blob([r.bytes], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `workspace-backup-${new Date().toISOString().slice(0, 10)}.awbackup`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      this.say(root, 'syBackupMsg', `Exported ${r.sessions} sessions and ${r.attachments} files (${StorageTools.fmt(r.bytes.length)}). Remember the passphrase - it can't be reset.`);
    }));
    on('syBackupImportBtn', () => $('syBackupFile').click());
    const bf = $('syBackupFile');
    if (bf) bf.addEventListener('change', async () => {
      const file = bf.files[0]; bf.value = '';
      if (!file) return;
      const btn = $('syBackupImportBtn');
      await this.run(root, btn, 'syBackupMsg', async () => {
        if (file.size > 600 * 1024 * 1024) throw new Error('That file is too large to restore in the browser.');
        btn.textContent = 'restoring…';
        this.say(root, 'syBackupMsg', 'Decrypting…');
        const r = await Backup.importEncrypted(new Uint8Array(await file.arrayBuffer()), $('syBackupPass').value);
        this.say(root, 'syBackupMsg', `Restored ${r.sessions} sessions and ${r.attachments} new files.`);
        if (typeof App !== 'undefined' && App.renderSessionList) await App.renderSessionList();
      });
    });
    on('syPersistBtn', async () => {
      const ok = await StorageTools.persist();
      this.say(root, 'syStorageMsg', ok ? 'Granted - the browser will keep your data.' : 'The browser declined (it decides based on usage/installation). Installing the app to your home screen helps.', !ok);
      if (ok) await this.rerender();
    });
  }
};
