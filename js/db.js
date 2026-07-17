// Local-first storage. Everything lives in IndexedDB on-device.
// Filen cloud sync hooks into the same read/write points later without
// changing this file's public shape.

const DB_NAME = 'ai-workspace';
const DB_VERSION = 1;

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

const DB = {
  // ---- key/value settings ----
  async getSetting(key, fallback) {
    const store = await tx('kv', 'readonly');
    return new Promise((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = () => resolve(fallback);
    });
  },
  async setSetting(key, value) {
    const store = await tx('kv', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  // ---- sessions ----
  async createSession(title) {
    const session = {
      id: 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title || 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const store = await tx('sessions', 'readwrite');
    store.put(session);
    return session;
  },
  async listSessions() {
    const store = await tx('sessions', 'readonly');
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.updatedAt - a.updatedAt));
      req.onerror = () => resolve([]);
    });
  },
  async touchSession(id) {
    const store = await tx('sessions', 'readwrite');
    const req = store.get(id);
    req.onsuccess = () => {
      const s = req.result;
      if (s) { s.updatedAt = Date.now(); store.put(s); }
    };
  },
  async renameSession(id, title) {
    const store = await tx('sessions', 'readwrite');
    const req = store.get(id);
    req.onsuccess = () => {
      const s = req.result;
      if (s) { s.title = title; store.put(s); }
    };
  },

  // ---- messages ----
  async addMessage(sessionId, msg) {
    const record = Object.assign({
      id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sessionId,
      timestamp: Date.now()
    }, msg);
    const store = await tx('messages', 'readwrite');
    store.put(record);
    await DB.touchSession(sessionId);
    return record;
  },
  async listMessages(sessionId) {
    const store = await tx('messages', 'readonly');
    return new Promise((resolve) => {
      const idx = store.index('sessionId');
      const req = idx.getAll(sessionId);
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.timestamp - b.timestamp));
      req.onerror = () => resolve([]);
    });
  }
};
