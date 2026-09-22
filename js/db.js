// Transparent gzip compression for text stored in IndexedDB (messages,
// extracted file text). Uses the browser's native CompressionStream/
// DecompressionStream ('gzip') - no external library, no bundle to fetch.
//
// Supported everywhere that matters for this app: Chrome/Edge 80+, Safari
// 16.4+, Firefox 113+. If it's missing (very old browser), everything falls
// back to storing plain text - nothing breaks, you just don't get the size
// win on that browser.
//
// Only compresses when it's actually worth it: gzip has ~20 bytes of framing
// overhead, so short strings (chat "ok", short filenames) would get BIGGER.
// Below MIN_LEN we skip compression entirely.

const Compression = {
  MIN_LEN: 200, // chars - below this, compression overhead isn't worth it
  SUPPORTED: (typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'),

  // Compresses a string to gzip bytes (Uint8Array). Caller decides whether
  // to call this based on length - this always compresses if supported.
  async toGzip(str) {
    const bytes = new TextEncoder().encode(str);
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const compressed = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(compressed);
  },

  async fromGzip(bytesLike) {
    // IndexedDB can hand back the stored value as Uint8Array, ArrayBuffer,
    // or (rarely, on some browsers' structured-clone paths) a plain array -
    // normalize before feeding the stream.
    const bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike);
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const decompressed = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(decompressed);
  },

  // Raw-bytes variants, used by the encrypted sync/backup code (gzip first,
  // then encrypt - encrypted data can't be compressed afterwards).
  async gzipBytes(u8) {
    if (!Compression.SUPPORTED) return u8;
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    w.write(u8); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  },
  async gunzipBytes(u8) {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(u8); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  },

  // Takes a plain string, returns { value, compressed } ready to spread
  // into a record. `value` is either the original string or gzip bytes.
  async pack(str) {
    if (str == null) return { value: str, compressed: false };
    if (!Compression.SUPPORTED || str.length < Compression.MIN_LEN) {
      return { value: str, compressed: false };
    }
    try {
      const gz = await Compression.toGzip(str);
      // Rare edge case: for text that's already dense (e.g. base64) gzip
      // can lose to the overhead. Only keep it if it actually won.
      if (gz.byteLength < str.length) {
        return { value: gz, compressed: true };
      }
      return { value: str, compressed: false };
    } catch (e) {
      // Never let a compression failure lose data - store it plain.
      return { value: str, compressed: false };
    }
  },

  // Inverse of pack(): given the stored value + its compressed flag,
  // returns the original string.
  async unpack(value, compressed) {
    if (!compressed) return value;
    try {
      return await Compression.fromGzip(value);
    } catch (e) {
      // If a compressed record somehow can't be read back, don't crash the
      // whole message list over it - surface something visible instead.
      return '[compressed content could not be read]';
    }
  }
};

// Local-first storage. Everything lives in IndexedDB on-device; the sync layer
// (js/sync.js) watches this file's change events and mirrors an ENCRYPTED copy
// to the Worker - it never reads IndexedDB behind this file's back.
//
// What was added for sync (public shape unchanged - old records still load):
//   - every setting record carries `t` (last-change time) so two devices can
//     merge per-setting instead of overwriting each other
//   - sessions carry `metaAt` (last rename/pin) and `deletedMsgs` (tombstones,
//     so a message deleted on one device doesn't come back from another)
//   - messages carry `patchedAt` (last edit/pin)
//   - DB.on(fn) change events, and *Raw helpers the sync engine uses to apply
//     remote data without echoing it back as a local change

const DB_NAME = 'ai-workspace';
const DB_VERSION = 2; // unchanged - no schema change needed, only new optional fields

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('messages')) {
        const m = db.createObjectStore('messages', { keyPath: 'id' });
        m.createIndex('sessionId', 'sessionId');
      }
      if (!db.objectStoreNames.contains('attachments')) {
        const a = db.createObjectStore('attachments', { keyPath: 'id' });
        a.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function tx(storeName, mode) {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

// Resolves when a store's transaction has actually committed - used before
// announcing a change, so listeners never read half-written data.
function txDone(store) {
  return new Promise((resolve) => {
    const t = store.transaction;
    t.addEventListener('complete', () => resolve(true));
    t.addEventListener('abort', () => resolve(false));
    t.addEventListener('error', () => resolve(false));
  });
}

const MAX_TOMBSTONES = 500; // deleted-message markers kept per session

const DB = {
  // ---- change events -------------------------------------------------------
  // Listeners get { type, ... } after each committed local change:
  //   session          { sessionId }                (create/rename/pin/message add/patch/delete)
  //   session-deleted  { sessionId, attachmentIds }
  //   attachment       { id, sessionId }
  //   attachment-deleted { id, sessionId }
  //   setting          { key }
  // Changes made while _quiet > 0 (the sync engine applying remote data) are
  // not announced, so nothing echoes back to the server.
  _listeners: [],
  _quiet: 0,
  on(fn) {
    DB._listeners.push(fn);
    return () => { DB._listeners = DB._listeners.filter(f => f !== fn); };
  },
  _emit(evt) {
    if (DB._quiet > 0) return;
    for (const fn of DB._listeners) { try { fn(evt); } catch (e) { /* a bad listener must never break a write */ } }
  },
  async quietly(fn) {
    DB._quiet++;
    try { return await fn(); } finally { DB._quiet--; }
  },

  // ---- key/value settings ----
  async getSetting(key, fallback) {
    const store = await tx('kv', 'readonly');
    return new Promise((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = () => resolve(fallback);
    });
  },
  async getSettingRecord(key) {
    const store = await tx('kv', 'readonly');
    return new Promise((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  },
  async setSetting(key, value) {
    const store = await tx('kv', 'readwrite');
    const done = txDone(store);
    return new Promise((resolve, reject) => {
      const req = store.put({ key, value, t: Date.now() });
      req.onsuccess = async () => { await done; DB._emit({ type: 'setting', key }); resolve(true); };
      req.onerror = () => reject(req.error);
    });
  },
  // Used by the sync engine: keep the remote timestamp, announce nothing.
  async setSettingRaw(key, value, t) {
    const store = await tx('kv', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put({ key, value, t: t || Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },
  async deleteSetting(key) {
    const store = await tx('kv', 'readwrite');
    return new Promise((resolve) => {
      const req = store.delete(key);
      req.onsuccess = () => { DB._emit({ type: 'setting', key }); resolve(true); };
      req.onerror = () => resolve(false);
    });
  },

  // ---- sessions ----
  async createSession(title) {
    const now = Date.now();
    const session = {
      id: 'sess_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      title: title || 'New session',
      createdAt: now,
      updatedAt: now,
      metaAt: now
    };
    const store = await tx('sessions', 'readwrite');
    const done = txDone(store);
    store.put(session);
    await done;
    DB._emit({ type: 'session', sessionId: session.id });
    return session;
  },
  async getSessionRaw(id) {
    const store = await tx('sessions', 'readonly');
    return new Promise((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  },
  async putSessionRaw(session) {
    const store = await tx('sessions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(session);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },
  async listSessions() {
    const store = await tx('sessions', 'readonly');
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = req.result || [];
        // pinned sessions always float to the top, then newest first
        rows.sort((a, b) => {
          const ap = a.pinned ? 1 : 0, bp = b.pinned ? 1 : 0;
          if (ap !== bp) return bp - ap;
          return b.updatedAt - a.updatedAt;
        });
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    });
  },
  async _mutateSession(id, mutate) {
    const store = await tx('sessions', 'readwrite');
    const done = txDone(store);
    const result = await new Promise((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => {
        const s = req.result;
        if (!s) { resolve({ found: false }); return; }
        const out = mutate(s);
        store.put(s);
        resolve({ found: true, out });
      };
      req.onerror = () => resolve({ found: false });
    });
    await done;
    if (result.found) DB._emit({ type: 'session', sessionId: id });
    return result;
  },
  async togglePinSession(id) {
    const r = await DB._mutateSession(id, (s) => { s.pinned = !s.pinned; s.metaAt = Date.now(); return s.pinned; });
    return r.found ? r.out : false;
  },
  async touchSession(id) {
    await DB._mutateSession(id, (s) => { s.updatedAt = Date.now(); });
  },
  async renameSession(id, title) {
    await DB._mutateSession(id, (s) => { s.title = title; s.metaAt = Date.now(); });
  },
  // opts.silent: don't announce the delete to sync (used by "clear everything",
  // which must stay a LOCAL clear and not wipe your other devices).
  async deleteSession(id, opts) {
    const attachmentIds = [];
    const sessStore = await tx('sessions', 'readwrite');
    sessStore.delete(id);
    const msgs = await DB.listMessages(id);
    const msgStore = await tx('messages', 'readwrite');
    msgs.forEach(m => msgStore.delete(m.id));
    const atts = await DB._listAttachmentRecords(id);
    const attStore = await tx('attachments', 'readwrite');
    atts.forEach(a => { attachmentIds.push(a.id); attStore.delete(a.id); });
    // compiled recap, branch link, per-session accent and provider target
    // live in the generic kv store keyed by session id - remove them too
    const kvStore = await tx('kv', 'readwrite');
    const done = txDone(kvStore);
    kvStore.delete(`compiledContext:${id}`);
    kvStore.delete(`branchParent:${id}`);
    kvStore.delete(`sessionAccent:${id}`);
    kvStore.delete(`providerTarget:${id}`);
    await done;
    if (!(opts && opts.silent)) DB._emit({ type: 'session-deleted', sessionId: id, attachmentIds });
  },

  // ---- messages ----
  // `content` is gzip-compressed on write when long enough to be worth it (see
  // Compression). Every read path decompresses it back to a plain string, so
  // nothing outside this file needs to know.
  async addMessage(sessionId, msg) {
    const packed = await Compression.pack(msg.content);
    const record = Object.assign({
      id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sessionId,
      timestamp: Date.now()
    }, msg, { content: packed.value, contentZ: packed.compressed });
    const store = await tx('messages', 'readwrite');
    const done = txDone(store);
    store.put(record);
    await done;
    await DB.touchSession(sessionId); // also announces the change
    return Object.assign({}, record, { content: msg.content, contentZ: undefined });
  },
  async _decompressMessage(m) {
    if (!m) return m;
    if (m.contentZ) {
      return Object.assign({}, m, { content: await Compression.unpack(m.content, true), contentZ: undefined });
    }
    return m;
  },
  async listMessages(sessionId) {
    const store = await tx('messages', 'readonly');
    const rows = await new Promise((resolve) => {
      const idx = store.index('sessionId');
      const req = idx.getAll(sessionId);
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.timestamp - b.timestamp));
      req.onerror = () => resolve([]);
    });
    return Promise.all(rows.map(m => DB._decompressMessage(m)));
  },
  // Sync applies a merged message straight in (keeps its original ids/stamps).
  async putMessageRaw(m) {
    const packed = await Compression.pack(m.content);
    const record = Object.assign({}, m, { content: packed.value, contentZ: packed.compressed });
    const store = await tx('messages', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },
  async deleteMessageRaw(id) {
    const store = await tx('messages', 'readwrite');
    return new Promise((resolve) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  },
  // Permanent local delete of a single message plus its linked attachments.
  // A tombstone is left on the session so other devices drop it too instead
  // of resurrecting it on the next sync.
  async deleteMessage(id) {
    const store = await tx('messages', 'readwrite');
    const m = await new Promise((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (!m) return false;
    store.delete(id);
    const atts = (await DB._listAttachmentRecords(m.sessionId)).filter(a => a.messageId === id);
    const attStore = await tx('attachments', 'readwrite');
    atts.forEach(a => attStore.delete(a.id));
    atts.forEach(a => DB._emit({ type: 'attachment-deleted', id: a.id, sessionId: m.sessionId }));
    await DB._mutateSession(m.sessionId, (s) => {
      s.deletedMsgs = s.deletedMsgs || {};
      s.deletedMsgs[id] = Date.now();
      const ids = Object.keys(s.deletedMsgs);
      if (ids.length > MAX_TOMBSTONES) {
        ids.sort((a, b) => s.deletedMsgs[a] - s.deletedMsgs[b]).slice(0, ids.length - MAX_TOMBSTONES).forEach(k => delete s.deletedMsgs[k]);
      }
      s.updatedAt = Date.now();
    });
    return true;
  },
  async patchMessage(id, patch) {
    const store = await tx('messages', 'readwrite');
    const done = txDone(store);
    const sessionId = await new Promise((resolve) => {
      const req = store.get(id);
      req.onsuccess = async () => {
        const m = req.result;
        if (!m) { resolve(null); return; }
        Object.assign(m, patch, { patchedAt: Date.now() });
        // same compress-on-write rule as addMessage
        if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
          const packed = await Compression.pack(patch.content);
          m.content = packed.value;
          m.contentZ = packed.compressed;
        }
        store.put(m);
        resolve(m.sessionId);
      };
      req.onerror = () => resolve(null);
    });
    await done;
    if (sessionId) await DB.touchSession(sessionId);
    return !!sessionId;
  },
  async togglePinMessage(id) {
    const store = await tx('messages', 'readwrite');
    const done = txDone(store);
    const r = await new Promise((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => {
        const m = req.result;
        if (m) { m.pinned = !m.pinned; m.patchedAt = Date.now(); store.put(m); resolve({ pinned: m.pinned, sessionId: m.sessionId }); }
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    });
    await done;
    if (!r) return false;
    await DB.touchSession(r.sessionId);
    return r.pinned;
  },
  // All pinned messages across every session, newest first.
  async listPinnedMessages() {
    const store = await tx('messages', 'readonly');
    const rows = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []).filter(m => m.pinned).sort((a, b) => b.timestamp - a.timestamp));
      req.onerror = () => resolve([]);
    });
    return Promise.all(rows.map(m => DB._decompressMessage(m)));
  },
  // Simple client-side search across every message in every session - no
  // server round trip, nothing leaves the device just to search your chats.
  async searchMessages(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const store = await tx('messages', 'readonly');
    const sessions = await DB.listSessions();
    const titleById = {};
    sessions.forEach(s => titleById[s.id] = s.title);
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = async () => {
        const decompressed = await Promise.all((req.result || []).map(m => DB._decompressMessage(m)));
        const hits = decompressed
          .filter(m => m.content && m.content.toLowerCase().includes(q))
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 40)
          .map(m => ({ ...m, sessionTitle: titleById[m.sessionId] || 'Untitled session' }));
        resolve(hits);
      };
      req.onerror = () => resolve([]);
    });
  },

  // ---- attachments (extracted file text, and raw blob if the file was small) ----
  // `text` is gzip-compressed on write. `base64` is left alone: base64 of
  // binary is already dense and gzip on top rarely helps.
  async addAttachment(sessionId, att) {
    const packed = await Compression.pack(att.text);
    const record = Object.assign({
      id: 'att_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sessionId,
      timestamp: Date.now()
    }, att, { text: packed.value, textZ: packed.compressed });
    const store = await tx('attachments', 'readwrite');
    const done = txDone(store);
    store.put(record);
    await done;
    DB._emit({ type: 'attachment', id: record.id, sessionId });
    return Object.assign({}, record, { text: att.text, textZ: undefined });
  },
  async _decompressAttachment(a) {
    if (!a) return a;
    if (a.textZ) {
      return Object.assign({}, a, { text: await Compression.unpack(a.text, true), textZ: undefined });
    }
    return a;
  },
  async _listAttachmentRecords(sessionId) { // raw (still compressed) rows
    const store = await tx('attachments', 'readonly');
    return new Promise((resolve) => {
      const idx = store.index('sessionId');
      const req = idx.getAll(sessionId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  },
  async listAttachments(sessionId) {
    const rows = await DB._listAttachmentRecords(sessionId);
    return Promise.all(rows.map(a => DB._decompressAttachment(a)));
  },
  async listAttachmentsForMessage(sessionId, messageId) {
    const all = await DB.listAttachments(sessionId);
    return all.filter(a => a.messageId === messageId);
  },
  async listAllAttachmentMeta() { // ids + sessionId only, for sync reconciliation
    const store = await tx('attachments', 'readonly');
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []).map(a => ({ id: a.id, sessionId: a.sessionId })));
      req.onerror = () => resolve([]);
    });
  },
  async getAttachmentLocal(id) {
    const store = await tx('attachments', 'readonly');
    const a = await new Promise((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    return DB._decompressAttachment(a);
  },
  // If a file isn't on this device yet (it was added on another one and
  // synced), Sync installs a loader here that downloads + decrypts it on demand.
  remoteAttachmentLoader: null,
  async getAttachment(id) {
    const local = await DB.getAttachmentLocal(id);
    if (local) return local;
    if (DB.remoteAttachmentLoader) {
      try { return await DB.remoteAttachmentLoader(id); } catch (e) { return null; }
    }
    return null;
  },
  async putAttachmentRaw(a) {
    const packed = await Compression.pack(a.text);
    const record = Object.assign({}, a, { text: packed.value, textZ: packed.compressed });
    const store = await tx('attachments', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },
  async deleteAttachmentRaw(id) {
    const store = await tx('attachments', 'readwrite');
    return new Promise((resolve) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  },

  // ---- bulk helpers ----
  async storageBreakdown() { // rough bytes actually held, for the Storage panel
    const sum = async (name, pick) => {
      const store = await tx(name, 'readonly');
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result || []).reduce((n, r) => n + pick(r), 0));
        req.onerror = () => resolve(0);
      });
    };
    const len = (v) => v == null ? 0 : (typeof v === 'string' ? v.length : (v.byteLength || 0));
    return {
      messages: await sum('messages', m => len(m.content) + len(m.displayText)),
      attachmentText: await sum('attachments', a => len(a.text)),
      attachmentFiles: await sum('attachments', a => len(a.base64) + len(a.imageBase64))
    };
  },

  // ---- shared chat helpers ----
  // What a viewer sees: what YOU see in the bubbles. For user turns that
  // means the typed text (not the full extracted file text that was folded
  // into `content` for the AI), plus just the file NAMES. Error replies are
  // skipped. Nothing here is private config - only chat text.
  async exportSessionForShare(sessionId) {
    const messages = await DB.listMessages(sessionId);
    return messages.filter(m => !m.isError && !m.thinking).map(m => ({
      id: m.id,
      role: m.role,
      nickname: m.nickname || null,
      content: m.role === 'user' ? (m.displayText != null ? m.displayText : m.content) : m.content,
      t: m.timestamp,
      files: (m.attachmentMeta || []).map(a => a.name)
    }));
  },
  // Recreates a shared session as a brand-new local session.
  async importSharedSession(title, messages) {
    const session = await DB.createSession(title || 'Shared session');
    for (const m of messages) {
      await DB.addMessage(session.id, { role: m.role, nickname: m.nickname, content: m.content });
    }
    return session;
  }
};
