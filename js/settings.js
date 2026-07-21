// Everything the user can change lives in this panel, rendered from live
// data (providers.js + db.js) - nothing here is hardcoded into the UI.

const PALETTE_PRESETS = [
  { name: 'Violet', accent: '#7f77dd' },
  { name: 'Teal', accent: '#4fb8a6' },
  { name: 'Rose', accent: '#d97b96' },
  { name: 'Amber', accent: '#d9a441' },
  { name: 'Mono', accent: '#c9c9c6' }
];

// Rounded/Compact/Easy-read used to name OS fonts (Segoe UI Rounded, Comic
// Sans MS, Arial Narrow) that most devices don't actually have installed,
// so they silently fell back to the same default sans as everyone else -
// that's why only Reading/Mono ever looked different. Now backed by real
// webfonts (loaded via the Google Fonts <link> in index.html) so every
// option is guaranteed to render as its own distinct look everywhere.
const FONT_PRESETS = [
  { name: 'Default', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif' },
  { name: 'Reading', stack: 'Georgia, "Times New Roman", serif' },
  { name: 'Rounded', stack: '"Quicksand", "Comfortaa", sans-serif' },
  { name: 'Mono', stack: '"SF Mono", Menlo, Consolas, monospace' },
  { name: 'Compact', stack: '"Roboto Condensed", Arial Narrow, sans-serif' },
  { name: 'Easy-read', stack: '"Atkinson Hyperlegible", Verdana, Tahoma, sans-serif' }
];

const FONT_SIZE_PRESETS = [
  { name: 'S', size: 13 },
  { name: 'M', size: 15 },
  { name: 'L', size: 17 },
  { name: 'XL', size: 19 }
];

const LINE_HEIGHT_PRESETS = [
  { name: 'Compact', value: 1.35 },
  { name: 'Comfortable', value: 1.5 },
  { name: 'Relaxed', value: 1.75 }
];

const Settings = {
  panelEl: null,
  bodyEl: null,
  providerDefs: {},
  keyInfo: {},

  async init() {
    this.panelEl = document.getElementById('settingsPanel');
    this.bodyEl = document.getElementById('settingsBody');
    document.getElementById('openSettingsBtn').addEventListener('click', () => Settings.open());
    document.getElementById('closeSettingsBtn').addEventListener('click', () => Settings.close());
    document.getElementById('overlay').addEventListener('click', () => {
      Settings.close();
      if (window.App) App.closeProfilePanel();
    });

    await this.applyStoredAppearance();
  },

  async applyStoredAppearance() {
    const accent = await DB.getSetting('accent', '#7f77dd');
    const fontSize = await DB.getSetting('fontSize', 15);
    const fontFamily = await DB.getSetting('fontFamily', FONT_PRESETS[0].stack);
    const lineHeight = await DB.getSetting('lineHeight', 1.5);
    const density = await DB.getSetting('density', 'comfortable');
    const chatWidth = await DB.getSetting('chatWidth', '100%');
    const bgImage = await DB.getSetting('bgImage', null);
    const bgDim = await DB.getSetting('bgDim', 0.35);
    const bubbleOpacity = await DB.getSetting('bubbleOpacity', 1);
    const bubbleBlur = await DB.getSetting('bubbleBlur', 0);
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--app-font-size', fontSize + 'px');
    document.documentElement.style.setProperty('--chat-max-width', chatWidth);
    document.documentElement.style.setProperty('--font-sans', fontFamily);
    document.documentElement.style.setProperty('--msg-line-height', lineHeight);
    document.documentElement.style.setProperty('--bg-dim', bgDim);
    document.documentElement.style.setProperty('--bubble-opacity', bubbleOpacity);
    document.documentElement.style.setProperty('--bubble-blur', bubbleBlur + 'px');
    document.getElementById('app').classList.toggle('density-compact', density === 'compact');
    const appEl = document.getElementById('app');
    if (bgImage) {
      appEl.style.backgroundImage = `url(${bgImage})`;
      appEl.classList.add('has-bg-image');
    } else {
      appEl.style.backgroundImage = '';
      appEl.classList.remove('has-bg-image');
    }
    this.checkFontActuallyLoaded(fontFamily);
  },

  // Only Quicksand/Comfortaa/Roboto Condensed/Atkinson Hyperlegible are
  // actual webfonts loaded via the <link> in index.html - Default/Reading/
  // Mono are OS fonts where falling back is expected, normal behavior, not
  // a bug. Checking those too would produce false "didn't load" warnings
  // on any system that doesn't happen to have SF Mono/Segoe UI installed.
  WEBFONT_NAMES: new Set(['Quicksand', 'Comfortaa', 'Roboto Condensed', 'Atkinson Hyperlegible']),

  async checkFontActuallyLoaded(stack) {
    const match = stack.match(/^"([^"]+)"/) || stack.match(/^'([^']+)'/);
    const fontName = match ? match[1] : null;
    if (!fontName || !this.WEBFONT_NAMES.has(fontName)) return;
    if (!document.fonts || !document.fonts.load) return; // older browser, skip silently
    try {
      await document.fonts.load(`16px "${fontName}"`);
      if (!document.fonts.check(`16px "${fontName}"`)) {
        Toast.show(`"${fontName}" didn't actually load - your network, school/office wifi, or an ad-blocker may be blocking fonts.googleapis.com. It's silently falling back to a system font until that's reachable.`, true);
      }
    } catch (e) {
      Toast.show(`Couldn't load "${fontName}" - check your network/ad-blocker for fonts.googleapis.com.`, true);
    }
  },

  scrollToAppearance() {
    const el = document.getElementById('appearanceGroup');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async open() {
    if (window.App) App.closeProfilePanel();
    document.getElementById('overlay').classList.remove('hidden');
    this.panelEl.classList.remove('hidden');
    await this.render();
  },

  close() {
    document.getElementById('overlay').classList.add('hidden');
    this.panelEl.classList.add('hidden');
  },

  // A rendering crash used to mean a completely blank Settings panel with
  // no clue why (that's exactly what an undeclared-variable bug did last
  // round). This wrapper means that can never happen silently again - any
  // future bug shows a real error message with a retry, instead of nothing.
  async render() {
    try {
      await this._renderInner();
    } catch (e) {
      Logger.error('settings', 'render crashed: ' + (e.message || e));
      this.bodyEl.innerHTML = `
        <div style="padding:20px;text-align:center;color:var(--text-secondary)">
          <div style="font-size:13px;margin-bottom:10px">Settings hit an error and couldn't render.</div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:14px;font-family:var(--font-mono)">${(e.message || String(e)).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div>
          <button class="small-btn" id="settingsRetryBtn">try again</button>
        </div>`;
      const retryBtn = document.getElementById('settingsRetryBtn');
      if (retryBtn) retryBtn.addEventListener('click', () => Settings.render());
    }
  },

  async _renderInner() {
    let connectionError = null;
    try {
      this.providerDefs = await Providers.list();
      this.keyInfo = await Providers.getKeyInfo();
    } catch (e) {
      this.providerDefs = {};
      this.keyInfo = {};
      connectionError = e.message || 'Enter your PIN below to unlock.';
    }
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const accent = await DB.getSetting('accent', '#7f77dd');
    const fontSize = await DB.getSetting('fontSize', 15);
    const fontFamily = await DB.getSetting('fontFamily', FONT_PRESETS[0].stack);
    const lineHeight = await DB.getSetting('lineHeight', 1.5);
    const density = await DB.getSetting('density', 'comfortable');
    const bgImage = await DB.getSetting('bgImage', null);
    const bgDim = await DB.getSetting('bgDim', 0.35);
    const bubbleOpacity = await DB.getSetting('bubbleOpacity', 1);
    const bubbleBlur = await DB.getSetting('bubbleBlur', 0);
    const chatWidth = await DB.getSetting('chatWidth', '100%');
    const shareLinks = await DB.getSetting('shareLinks', []);

    let html = '';

    // ---- Connection ----
    html += `
      <div class="settings-group">
        <div class="settings-group-title">Connection</div>
        ${connectionError ? `<div style="font-size:12px;color:#d98a5f;margin-bottom:8px">${connectionError}</div>` : ''}
        <div class="settings-row">
          <label>PIN</label>
          <input type="password" id="pinInput" placeholder="your PIN" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="numeric" />
          <button type="button" class="small-btn" id="togglePwBtn">show</button>
        </div>
        <button class="small-btn" id="saveConnectionBtn">unlock</button>
        <div style="margin-top:14px;padding-top:12px;border-top:0.5px dashed var(--line)">
          <div style="font-size:12px;font-weight:500;margin-bottom:4px;display:flex;align-items:center;gap:6px">${svgIcon('link', 13)} Full workspace access link</div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
            Opens the workspace already unlocked, no PIN typing. <b style="color:#d98a5f">Anyone with this link gets everything</b> - your chats, your provider keys' usage, same as your PIN. Only hand it to a device you trust, like your own phone.
          </div>
          <button class="small-btn" id="genAccessLinkBtn">generate &amp; copy link</button>
        </div>
      </div>`;

    // ---- Appearance ----
    html += `
      <div class="settings-group" id="appearanceGroup">
        <div class="settings-group-title">Appearance</div>

        <div class="settings-card">
          <div class="settings-subhead">Color</div>
          <div class="settings-row">
            <label>Palette</label>
            <div style="display:flex;gap:8px;align-items:center">
              ${PALETTE_PRESETS.map(p => `
                <div class="palette-swatch ${p.accent === accent ? 'active' : ''}" data-accent="${p.accent}" style="background:${p.accent}" title="${p.name}"></div>
              `).join('')}
              <input type="color" id="accentInput" value="${accent}" title="Custom" />
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-subhead">Typography</div>
          <div class="settings-row">
            <label>Size</label>
            <div style="display:flex;gap:6px;align-items:center;flex:1">
              ${FONT_SIZE_PRESETS.map(p => `
                <button type="button" class="small-btn font-size-btn ${p.size === fontSize ? 'active' : ''}" data-size="${p.size}">${p.name}</button>
              `).join('')}
              <input type="text" id="fontSizeInput" value="${fontSize}" style="max-width:44px;margin-left:4px" />
              <span style="font-size:11px;color:var(--text-muted)">px</span>
              <span style="font-size:10.5px;color:var(--text-muted);margin-left:auto">Ctrl +/&minus;/0</span>
            </div>
          </div>
          <div class="settings-row">
            <label>Style</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${FONT_PRESETS.map(f => `
                <button type="button" class="font-swatch ${f.stack === fontFamily ? 'active' : ''}" data-stack="${f.stack}" style="font-family:${f.stack}" title="${f.name}">Aa</button>
              `).join('')}
            </div>
          </div>
          <div class="settings-row">
            <label>Line spacing</label>
            <div style="display:flex;gap:6px">
              ${LINE_HEIGHT_PRESETS.map(p => `
                <button type="button" class="small-btn line-height-btn ${p.value === lineHeight ? 'active' : ''}" data-value="${p.value}">${p.name}</button>
              `).join('')}
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-subhead">Layout</div>
          <div class="settings-row">
            <label>Density</label>
            <div style="display:flex;gap:6px">
              <button type="button" class="small-btn density-btn ${density === 'comfortable' ? 'active' : ''}" data-density="comfortable">comfortable</button>
              <button type="button" class="small-btn density-btn ${density === 'compact' ? 'active' : ''}" data-density="compact">compact</button>
            </div>
          </div>
          <div class="settings-row">
            <label>Chat width</label>
            <div style="display:flex;gap:6px">
              ${[['narrow', '720px', 'Narrow'], ['medium', '960px', 'Medium'], ['wide', '1280px', 'Wide'], ['full', '100%', 'Full']].map(([key, val, name]) =>
                `<button type="button" class="small-btn chat-width-btn ${chatWidth === val ? 'active' : ''}" data-width="${val}">${name}</button>`
              ).join('')}
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-subhead">Backdrop</div>
          <div class="settings-row settings-row-top">
            <label>Background</label>
            <div style="flex:1;display:flex;flex-direction:column;gap:6px">
              <div style="display:flex;gap:6px;align-items:center">
                <label class="small-btn" style="cursor:pointer">choose image<input type="file" id="bgImageInput" accept="image/*" hidden /></label>
                ${bgImage ? `<button type="button" class="small-btn" id="removeBgBtn">remove</button>` : ''}
              </div>
              ${bgImage ? `
              <div style="display:flex;align-items:center;gap:8px">
                <span class="settings-inline-label">dim</span>
                <input type="range" id="bgDimInput" min="0" max="0.8" step="0.05" value="${bgDim}" style="flex:1" />
              </div>` : `<div class="settings-hint">None set - the workspace stays plain and distraction-free by default.</div>`}
            </div>
          </div>
          <div class="settings-row settings-row-top">
            <label>Chat bubbles</label>
            <div style="flex:1;display:flex;flex-direction:column;gap:8px">
              <div style="display:flex;align-items:center;gap:8px">
                <span class="settings-inline-label">transparency</span>
                <input type="range" id="bubbleOpacityInput" min="0.35" max="1" step="0.05" value="${bubbleOpacity}" style="flex:1" />
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <span class="settings-inline-label">blur</span>
                <input type="range" id="bubbleBlurInput" min="0" max="16" step="1" value="${bubbleBlur}" style="flex:1" />
              </div>
              <div class="settings-hint">Most visible with a background image set - makes bubbles glassy instead of solid.</div>
            </div>
          </div>
      </div>`;

    // ---- Providers ----
    html += `<div class="settings-group"><div class="settings-group-title">AI providers</div>`;
    if (Object.keys(this.providerDefs).length === 0) {
      html += `<div style="font-size:12px;color:var(--text-muted)">Connect your backend above to manage AI keys here.</div>`;
    }
    for (const [id, def] of Object.entries(this.providerDefs)) {
      const info = this.keyInfo[id] || { keys: [], activeModel: null };
      const badge = def.refill === 'recurring'
        ? '<span style="color:#7ec98f;font-size:10px">recurring free</span>'
        : '<span style="color:#d98a5f;font-size:10px">one-time credit</span>';
      const noKeyNeeded = def.kind === 'cloudflare-ai';

      html += `<div class="provider-block" data-provider="${id}">
        <div class="provider-block-head">
          <span class="provider-name"><span class="provider-glyph">${providerIconHTML(id, 15)}</span>${def.label} (nickname: ${nicknames[id] || def.label})</span>
          ${badge}
        </div>
        ${noKeyNeeded ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Uses your Cloudflare account's built-in AI - no key needed.</div>` : `
        <div class="key-list" data-role="key-list">
          ${info.keys.map((k, i) => `
            <div class="key-slot">
              <span class="key-status ${k.resting ? 'resting' : 'active'}" title="${k.resting ? `Cooling down - back in ~${Math.ceil((k.restingForMs || 0) / 60000)}m` : 'Active'}"></span>
              <input type="text" value="${k.label}${k.resting ? ' (resting)' : ''}" disabled />
              <button class="small-btn" data-action="remove-key" data-provider="${id}" data-index="${i}">remove</button>
            </div>`).join('')}
        </div>
        <div class="key-slot">
          <input type="text" placeholder="label (e.g. acc 2)" class="add-label" style="max-width:100px" />
          <input type="password" placeholder="paste API key" class="add-key" />
          <button class="small-btn" data-action="add-key" data-provider="${id}">add</button>
        </div>
        ${info.keys.length > 1 ? `<div style="font-size:10.5px;color:var(--text-muted);margin:2px 0 6px">If one key hits its limit it's parked for a few minutes and the next one takes over automatically - order above is the fallback order, and a parked key gets rechecked and slotted back in on its own once it cools down.</div>` : ''}`}
        <div class="key-slot">
          <input type="text" class="model-input" placeholder="model (default: ${Router.prettifyModelName(def.defaultModel)})" value="${info.activeModel ? Router.prettifyModelName(info.activeModel) : ''}" data-raw="${info.activeModel || ''}" />
          <button class="small-btn" data-action="save-model" data-provider="${id}">save</button>
          <button class="small-btn" data-action="refresh-models" data-provider="${id}">refresh list</button>
        </div>
        <div class="key-slot">
          <input type="text" class="nickname-input" placeholder="nickname" value="${nicknames[id] || def.label}" />
          <button class="small-btn" data-action="save-nickname" data-provider="${id}">save name</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          Get a key: <a href="${def.signupUrl}" target="_blank" style="color:var(--accent)">${def.signupUrl}</a>
        </div>
      </div>`;
    }
    html += `</div>`;

    // ---- Auto mode lineup ----
    const autoProviders = await DB.getSetting('autoProviders', DEFAULT_AUTO_PROVIDERS);
    html += `
      <div class="settings-group">
        <div class="settings-group-title">Auto mode lineup</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
          Which AIs can answer automatically when you don't @mention or manually pick one. Keep this to your recurring-free AIs - one-time-credit ones (Claude, GPT, DeepSeek) are best left off here and called by name instead.
        </div>
        ${Object.entries(this.providerDefs).map(([id, def]) => `
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;cursor:pointer">
            <input type="checkbox" class="auto-provider-check" value="${id}" ${autoProviders.includes(id) ? 'checked' : ''} />
            <span class="provider-glyph">${providerIconHTML(id, 15)}</span> ${nicknames[id] || def.label}
          </label>`).join('')}
      </div>`;

    // ---- Shared links ----
    html += `
      <div class="settings-group">
        <div class="settings-group-title">Shared links</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
          Anyone with one of these links can open that session's history and continue chatting - no PIN needed on their end. Revoke a link any time without touching your PIN.
        </div>
        ${shareLinks.length === 0 ? `<div style="font-size:12px;color:var(--text-muted)">No active share links yet.</div>` : shareLinks.map(l => `
          <div class="key-slot">
            <input type="text" value="${l.title}" disabled />
            <button class="small-btn" data-action="revoke-share" data-token="${l.token}">revoke</button>
          </div>`).join('')}
      </div>`;

    // ---- Keyboard & shortcuts ----
    html += `
      <div class="settings-group">
        <div class="settings-group-title">Keyboard &amp; shortcuts</div>
        <button class="small-btn" id="openKeybindsBtn" style="margin-bottom:8px">open full cheat-sheet / rebind (Ctrl+/)</button>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${Object.keys(DEFAULT_KEYBINDS).map(k => `
            <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-secondary)">
              <span>${KEYBIND_LABELS[k] || k}</span>
              <span class="keybind-tag">${((window.App && App.keybinds ? App.keybinds[k] : DEFAULT_KEYBINDS[k]) || '').replace(/\bctrl\b/i, 'Ctrl').replace(/\bshift\b/i, 'Shift').replace(/\balt\b/i, 'Alt')}</span>
            </div>`).join('')}
        </div>
      </div>`;

    // ---- Data & privacy ----
    const allSessions = await DB.listSessions();
    html += `
      <div class="settings-group">
        <div class="settings-group-title">Data &amp; privacy</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
          Everything lives on this device (IndexedDB) unless you make a share link. Nothing is sent anywhere except the messages/files you send to whichever AI you're talking to.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <button class="small-btn" id="exportDataBtn">export all data (.json)</button>
          <label class="small-btn" style="cursor:pointer">import<input type="file" id="importDataInput" accept="application/json" hidden /></label>
          <button class="small-btn" id="clearDataBtn" style="color:#d98a5f;border-color:#5a3a2a">clear everything</button>
        </div>
      </div>`;

    // ---- Workspace health ----
    let totalMessages = 0;
    for (const s of allSessions) totalMessages += (await DB.listMessages(s.id)).length;
    let workerBuildLine = '<span style="color:var(--text-muted)">checking Worker version...</span>';
    try {
      const { build } = await Providers.getVersion();
      const inSync = build === EXPECTED_WORKER_BUILD;
      workerBuildLine = inSync
        ? `<span style="color:#7ec98f">Worker in sync</span> <span style="color:var(--text-muted)">(build ${build})</span>`
        : `<span style="color:#d98a5f">Worker is OUT OF DATE</span> <span style="color:var(--text-muted)">- live: ${build || 'unknown'}, expected: ${EXPECTED_WORKER_BUILD}. Redeploy worker.js.</span>`;
    } catch (e) { workerBuildLine = '<span style="color:var(--text-muted)">could not reach Worker to check</span>'; }
    html += `
      <div class="settings-group">
        <div class="settings-group-title">Workspace health</div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--text-secondary);margin-bottom:10px">
          <div><b style="color:var(--text-primary)">${allSessions.length}</b> sessions</div>
          <div><b style="color:var(--text-primary)">${totalMessages}</b> messages stored</div>
          <div><b style="color:var(--text-primary)">${Object.keys(this.providerDefs).length}</b> providers wired up</div>
        </div>
        <div style="font-size:12px;margin-bottom:10px">${workerBuildLine}</div>
        ${Object.entries(this.providerDefs).map(([id, def]) => {
          const info = this.keyInfo[id] || { keys: [] };
          const total = info.keys.length;
          const resting = info.keys.filter(k => k.resting).length;
          const noKeyNeeded = def.kind === 'cloudflare-ai';
          const dotClass = noKeyNeeded ? 'active' : (total === 0 ? '' : (resting === total ? 'resting' : 'active'));
          const statusText = noKeyNeeded ? 'always on' : (total === 0 ? 'no key set' : `${total - resting}/${total} keys ready${resting ? `, ${resting} resting` : ''}`);
          return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);padding:3px 0">
            <span class="key-status ${dotClass}"></span>
            <span style="display:inline-flex">${providerIconHTML(id, 14)}</span>
            <span style="min-width:90px">${nicknames[id] || def.label}</span>
            <span style="color:var(--text-muted);font-size:11px">${statusText}</span>
          </div>`;
        }).join('')}
      </div>`;

    this.bodyEl.innerHTML = html;
    this.wireEvents();
  },

  wireEvents() {
    document.getElementById('togglePwBtn').addEventListener('click', () => {
      const input = document.getElementById('pinInput');
      const btn = document.getElementById('togglePwBtn');
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'show' : 'hide';
    });

    document.getElementById('saveConnectionBtn').addEventListener('click', () => {
      const pin = document.getElementById('pinInput').value.trim();
      if (!pin) { Toast.show('Type your PIN first', true); return; }
      localStorage.setItem('workspace_pin', pin);
      Toast.show('Unlocked - staying signed in on this device');
      Settings.render();
    });

    document.getElementById('openKeybindsBtn').addEventListener('click', () => App.openKeybindSheet());

    const genLinkBtn = document.getElementById('genAccessLinkBtn');
    if (genLinkBtn) {
      genLinkBtn.addEventListener('click', async () => {
        const pin = localStorage.getItem('workspace_pin') || (document.getElementById('pinInput') || {}).value || '';
        if (!pin.trim()) { Toast.show('Set/unlock your PIN first, then generate the link.', true); return; }
        const link = `${window.location.origin}${window.location.pathname}?pin=${encodeURIComponent(pin.trim())}`;
        try {
          await navigator.clipboard.writeText(link);
          Toast.show('Access link copied - remember, it unlocks everything, share carefully.');
        } catch (e) {
          Toast.show('Link ready (copy failed): ' + link);
        }
      });
    }

    const bgImageInput = document.getElementById('bgImageInput');
    if (bgImageInput) {
      bgImageInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 6 * 1024 * 1024) { Toast.show('Pick something under 6MB for a background.', true); return; }
        const dataUrl = await FileHandler.readAsBase64(file, null);
        await DB.setSetting('bgImage', dataUrl);
        await Settings.applyStoredAppearance();
        Settings.render();
      });
    }
    const removeBgBtn = document.getElementById('removeBgBtn');
    if (removeBgBtn) {
      removeBgBtn.addEventListener('click', async () => {
        await DB.setSetting('bgImage', null);
        await Settings.applyStoredAppearance();
        Settings.render();
      });
    }
    const bgDimInput = document.getElementById('bgDimInput');
    if (bgDimInput) {
      bgDimInput.addEventListener('input', async (e) => {
        document.documentElement.style.setProperty('--bg-dim', e.target.value);
        await DB.setSetting('bgDim', parseFloat(e.target.value));
      });
    }
    const bubbleOpacityInput = document.getElementById('bubbleOpacityInput');
    if (bubbleOpacityInput) {
      bubbleOpacityInput.addEventListener('input', async (e) => {
        document.documentElement.style.setProperty('--bubble-opacity', e.target.value);
        await DB.setSetting('bubbleOpacity', parseFloat(e.target.value));
      });
    }
    const bubbleBlurInput = document.getElementById('bubbleBlurInput');
    if (bubbleBlurInput) {
      bubbleBlurInput.addEventListener('input', async (e) => {
        document.documentElement.style.setProperty('--bubble-blur', e.target.value + 'px');
        await DB.setSetting('bubbleBlur', parseFloat(e.target.value));
      });
    }

    document.getElementById('exportDataBtn').addEventListener('click', async () => {
      const sessions = await DB.listSessions();
      const payload = { exportedAt: Date.now(), sessions: [] };
      for (const s of sessions) {
        payload.sessions.push({ session: s, messages: await DB.listMessages(s.id) });
      }
      payload.settings = {
        nicknames: await DB.getSetting('nicknames', DEFAULT_NICKNAMES),
        profile: await DB.getSetting('profile', {}),
        accent: await DB.getSetting('accent', '#7f77dd'),
        autoProviders: await DB.getSetting('autoProviders', DEFAULT_AUTO_PROVIDERS)
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workspace-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Toast.show('Exported - API keys are never included, those only ever live on the Worker.');
    });

    const importInput = document.getElementById('importDataInput');
    if (importInput) {
      importInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          const text = await file.text();
          const payload = JSON.parse(text);
          for (const entry of (payload.sessions || [])) {
            const s = await DB.createSession(entry.session.title);
            for (const m of entry.messages) {
              await DB.addMessage(s.id, { role: m.role, nickname: m.nickname, content: m.content });
            }
          }
          Toast.show(`Imported ${(payload.sessions || []).length} session(s).`);
          if (window.App) { await App.renderSessionList(await DB.listSessions()); }
        } catch (err) {
          Toast.show('Could not read that file - is it a workspace export?', true);
        }
      });
    }

    const clearBtn = document.getElementById('clearDataBtn');
    if (clearBtn) {
      let confirmArmed = false;
      clearBtn.addEventListener('click', async () => {
        if (!confirmArmed) {
          confirmArmed = true;
          clearBtn.textContent = 'click again to confirm - this can\'t be undone';
          setTimeout(() => { confirmArmed = false; clearBtn.textContent = 'clear everything'; }, 4000);
          return;
        }
        const sessions = await DB.listSessions();
        for (const s of sessions) await DB.deleteSession(s.id);
        Toast.show('All local data cleared.');
        window.location.reload();
      });
    }

    this.bodyEl.querySelectorAll('.palette-swatch').forEach(sw => {
      sw.addEventListener('click', async () => {
        const accent = sw.dataset.accent;
        document.documentElement.style.setProperty('--accent', accent);
        await DB.setSetting('accent', accent);
        Settings.render();
      });
    });

    this.bodyEl.querySelectorAll('.font-size-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = parseInt(btn.dataset.size, 10);
        document.documentElement.style.setProperty('--app-font-size', v + 'px');
        await DB.setSetting('fontSize', v);
        Settings.render();
      });
    });

    this.bodyEl.querySelectorAll('.line-height-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = parseFloat(btn.dataset.value);
        document.documentElement.style.setProperty('--msg-line-height', v);
        await DB.setSetting('lineHeight', v);
        Settings.render();
      });
    });

    this.bodyEl.querySelectorAll('.font-swatch').forEach(btn => {
      btn.addEventListener('click', async () => {
        const stack = btn.dataset.stack;
        document.documentElement.style.setProperty('--font-sans', stack);
        await DB.setSetting('fontFamily', stack);
        Settings.render();
        Settings.checkFontActuallyLoaded(stack);
      });
    });

    this.bodyEl.querySelectorAll('.density-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const density = btn.dataset.density;
        document.getElementById('app').classList.toggle('density-compact', density === 'compact');
        await DB.setSetting('density', density);
        Settings.render();
      });
    });

    this.bodyEl.querySelectorAll('.chat-width-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const width = btn.dataset.width;
        document.documentElement.style.setProperty('--chat-max-width', width);
        await DB.setSetting('chatWidth', width);
        Settings.render();
      });
    });

    this.bodyEl.querySelectorAll('.auto-provider-check').forEach(cb => {
      cb.addEventListener('change', async () => {
        const checked = Array.from(this.bodyEl.querySelectorAll('.auto-provider-check:checked')).map(c => c.value);
        await DB.setSetting('autoProviders', checked);
        Toast.show('Auto mode lineup updated');
      });
    });

    const accentInput = document.getElementById('accentInput');
    accentInput.addEventListener('input', async (e) => {
      document.documentElement.style.setProperty('--accent', e.target.value);
      await DB.setSetting('accent', e.target.value);
    });

    const fontInput = document.getElementById('fontSizeInput');
    fontInput.addEventListener('change', async (e) => {
      const v = parseInt(e.target.value, 10) || 15;
      document.documentElement.style.setProperty('--app-font-size', v + 'px');
      await DB.setSetting('fontSize', v);
    });

    this.bodyEl.querySelectorAll('[data-action="add-key"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const block = btn.closest('.provider-block');
        const providerId = btn.dataset.provider;
        const label = block.querySelector('.add-label').value.trim();
        const key = block.querySelector('.add-key').value.trim();
        if (!key) return;
        try {
          await Providers.addKey(providerId, label, key);
          await Settings.render();
        } catch (e) {
          Toast.show('Could not save key: ' + e.message, true);
        }
      });
    });

    this.bodyEl.querySelectorAll('[data-action="remove-key"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await Providers.removeKey(btn.dataset.provider, parseInt(btn.dataset.index, 10));
          await Settings.render();
        } catch (e) {
          Toast.show('Could not remove key: ' + e.message, true);
        }
      });
    });

    this.bodyEl.querySelectorAll('[data-action="save-model"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const block = btn.closest('.provider-block');
        const modelInput = block.querySelector('.model-input');
        const model = modelInput.dataset.raw || modelInput.value.trim();
        try {
          await Providers.setModel(btn.dataset.provider, model);
          await Settings.render();
        } catch (e) {
          Toast.show('Could not save model: ' + e.message, true);
        }
      });
    });

    this.bodyEl.querySelectorAll('[data-action="refresh-models"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const block = btn.closest('.provider-block');
        let listEl = block.querySelector('.model-list-result');
        try {
          const result = await Providers.refreshModels(btn.dataset.provider);
          if (result.error) { Toast.show(result.message || 'Could not fetch model list.', true); return; }
          if (!listEl) {
            listEl = document.createElement('div');
            listEl.className = 'model-list-result';
            listEl.style.cssText = 'max-height:120px;overflow-y:auto;font-size:11px;color:var(--text-secondary);margin-top:6px;border:0.5px solid var(--line);border-radius:8px;padding:6px 8px';
            block.appendChild(listEl);
          }
          listEl.innerHTML = result.models.slice(0, 30).map(m =>
            `<div class="model-pick" data-provider="${btn.dataset.provider}" data-raw="${m}" style="padding:2px 0;cursor:pointer">${Router.prettifyModelName(m)}</div>`
          ).join('');
          listEl.querySelectorAll('.model-pick').forEach(row => {
            row.addEventListener('click', async () => {
              const modelInput = block.querySelector('.model-input');
              modelInput.value = row.textContent;
              modelInput.dataset.raw = row.dataset.raw;
              await Providers.setModel(row.dataset.provider, row.dataset.raw);
              Toast.show('Model set to ' + row.textContent);
              await Settings.render();
            });
          });
        } catch (e) {
          Toast.show('Could not fetch models: ' + e.message, true);
        }
      });
    });

    this.bodyEl.querySelectorAll('[data-action="save-nickname"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const block = btn.closest('.provider-block');
        const providerId = btn.dataset.provider;
        const newName = block.querySelector('.nickname-input').value.trim();
        if (!newName) return;
        const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
        nicknames[providerId] = newName;
        await DB.setSetting('nicknames', nicknames);
        await Settings.render();
        if (window.App) App.refreshHeaderChips();
      });
    });

    this.bodyEl.querySelectorAll('[data-action="revoke-share"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const token = btn.dataset.token;
        try {
          await Providers.revokeShare(token);
          const links = await DB.getSetting('shareLinks', []);
          await DB.setSetting('shareLinks', links.filter(l => l.token !== token));
          Toast.show('Link revoked');
          await Settings.render();
        } catch (e) {
          Toast.show('Could not revoke: ' + e.message, true);
        }
      });
    });
  }
};
