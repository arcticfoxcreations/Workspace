// Two-device integration harness: real worker code in workerd (Miniflare), real
// browser-side scripts (js/*.js as shipped) in jsdom, fake IndexedDB per device,
// Node's WebCrypto + CompressionStream. Everything except the actual browser
// engine, real IndexedDB, and real AI providers is genuine.
import { JSDOM } from 'jsdom';
import { Miniflare } from 'miniflare';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PIN = 'Correct-Horse 42!';
export const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const BACKEND = 'https://workspace.arcticfox-org.workers.dev';
export const SCRIPTS = ['core', 'db', 'providers', 'router', 'files', 'sync', 'settings', 'app', 'console'];

export async function makeWorker(extraBindings = {}) {
  const mf = new Miniflare({
    modules: true, script: fs.readFileSync(path.join(OUT, 'worker.js'), 'utf8'),
    kvNamespaces: ['WORKSPACE_KV'], bindings: { APP_PASSWORD: PIN, ...extraBindings }, compatibilityDate: '2026-07-01',
    outboundService: async (req) => new Response(JSON.stringify({ error: { message: 'upstream not mocked' } }), { status: 502 })
  });
  return mf;
}

export class Device {
  constructor(name, mf, { idb, ip } = {}) {
    this.name = name; this.mf = mf; this.idb = idb || new IDBFactory(); this.offline = false; this.ip = ip || '10.1.1.1';
    this.calls = [];
  }
  async boot({ html = true, init = true, url = 'https://arcticfoxcreations.github.io/Workspace/', localStorage: ls = {} } = {}) {
    const dom = new JSDOM(fs.readFileSync(path.join(OUT, 'index.html'), 'utf8').replace(/<script src="js\/[^"]+"><\/script>/g, '').replace(/<link[^>]+>/g, ''),
      { url, runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window; this.dom = dom; this.w = w;
    if (w.document.readyState !== 'complete') await new Promise(r => w.addEventListener('load', r));
    w.indexedDB = this.idb; w.IDBKeyRange = IDBKeyRange;
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
    for (const k of ['CompressionStream', 'DecompressionStream', 'Response', 'TextEncoder', 'TextDecoder', 'AbortController', 'structuredClone', 'Blob', 'URL']) {
      try { Object.defineProperty(w, k, { value: globalThis[k], configurable: true, writable: true }); } catch (e) {}
    }
    w.Element.prototype.scrollIntoView = () => {};
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    w.navigator.clipboard = { writeText: async (t) => { this.clipboard = t; } };
    for (const [k, v] of Object.entries(ls)) w.localStorage.setItem(k, v);
    w.fetch = async (u, init = {}) => {
      if (this.offline) throw new TypeError('Failed to fetch');
      const url = String(u).replace(BACKEND, 'http://w.test');
      const headers = { ...(init.headers || {}), 'CF-Connecting-IP': this.ip };
      this.calls.push((init.method || 'GET') + ' ' + url.replace('http://w.test', ''));
      const { signal, ...rest } = init;
      return this.mf.dispatchFetch(url, { ...rest, headers });
    };
    w.alert = () => {}; w.confirm = () => true; w.prompt = () => 'DELETE';
    if (html) {
      for (const s of SCRIPTS) {
        const el = w.document.createElement('script');
        el.textContent = fs.readFileSync(path.join(OUT, 'js', s + '.js'), 'utf8');
        w.document.body.appendChild(el);
      }
    }
    this.errors = [];
    w.addEventListener('error', (e) => this.errors.push(String(e.error || e.message)));
    if (html && init) await this.evAsync('await Sync.init()');
    return this;
  }
  // Results are JSON-normalised so objects from the jsdom realm compare cleanly (different Array/Object prototypes otherwise).
  ev(code) { const r = this.w.eval(code); return (r && typeof r === 'object') ? JSON.parse(JSON.stringify(r)) : r; }
  async evAsync(code) { const r = await this.w.eval(`(async()=>{ ${code} })()`); return (r && typeof r === 'object') ? JSON.parse(JSON.stringify(r)) : r; }
  async settle() { for (let i = 0; i < 200; i++) { if (!this.ev('Sync._running || Sync._again')) return; await sleep(25); } }
  setPin() { this.w.localStorage.setItem('workspace_pin', PIN); return this; }
  fastKdf() { this.ev('Vault.ITERATIONS = 100000'); return this; }
  close() { this.dom.window.close(); }
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
