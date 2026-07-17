// Everything the user can change lives in this panel, rendered from live
// data (providers.js + db.js) - nothing here is hardcoded into the UI.

const Settings = {
  panelEl: null,
  bodyEl: null,
  providerDefs: {},
  keyInfo: {},

  async init() {
    this.panelEl = document.getElementById('settingsPanel');
    this.bodyEl = document.getElementById('settingsBody');
    document.getElementById('openSettingsBtn').addEventListener('click', () => Settings.open());
    document.getElementById('settingsIconBtn').addEventListener('click', () => Settings.open());
    document.getElementById('closeSettingsBtn').addEventListener('click', () => Settings.close());
    document.getElementById('overlay').addEventListener('click', () => Settings.close());

    await this.applyStoredAppearance();
  },

  async applyStoredAppearance() {
    const accent = await DB.getSetting('accent', '#7f77dd');
    const fontSize = await DB.getSetting('fontSize', 15);
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--app-font-size', fontSize + 'px');
  },

  async open() {
    document.getElementById('overlay').classList.remove('hidden');
    this.panelEl.classList.remove('hidden');
    await this.render();
  },

  close() {
    document.getElementById('overlay').classList.add('hidden');
    this.panelEl.classList.add('hidden');
  },

  async render() {
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
        <button class="small-btn" id="copyLinkBtn">copy setup link for other devices</button>
      </div>`;

    // ---- Appearance ----
    html += `
      <div class="settings-group">
        <div class="settings-group-title">Appearance</div>
        <div class="settings-row">
          <label>Accent</label>
          <input type="color" id="accentInput" value="${accent}" />
        </div>
        <div class="settings-row">
          <label>Font size</label>
          <input type="text" id="fontSizeInput" value="${fontSize}" style="max-width:60px" />
          <span style="font-size:11px;color:var(--text-muted)">px</span>
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

      html += `<div class="provider-block" data-provider="${id}">
        <div class="provider-block-head">
          <span class="provider-name">${def.label} (nickname: ${nicknames[id] || def.label})</span>
          ${badge}
        </div>
        <div class="key-list" data-role="key-list">
          ${info.keys.map((k, i) => `
            <div class="key-slot">
              <span class="key-status active"></span>
              <input type="text" value="${k.label}" disabled />
              <button class="small-btn" data-action="remove-key" data-provider="${id}" data-index="${i}">remove</button>
            </div>`).join('')}
        </div>
        <div class="key-slot">
          <input type="text" placeholder="label (e.g. acc 2)" class="add-label" style="max-width:100px" />
          <input type="password" placeholder="paste API key" class="add-key" />
          <button class="small-btn" data-action="add-key" data-provider="${id}">add</button>
        </div>
        <div class="key-slot">
          <input type="text" class="model-input" placeholder="model (default: ${def.defaultModel})" value="${info.activeModel || ''}" />
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
            ${nicknames[id] || def.label}
          </label>`).join('')}
      </div>`;

    this.bodyEl.innerHTML = html;
    this.wireEvents();
  },

  wireEvents() {
    document.getElementById('copyLinkBtn').addEventListener('click', async () => {
      const pin = localStorage.getItem('workspace_pin');
      if (!pin) {
        Toast.show('Unlock with your PIN here first, then copy the link', true);
        return;
      }
      const link = `${window.location.origin}${window.location.pathname}?pin=${encodeURIComponent(pin)}`;
      try {
        await navigator.clipboard.writeText(link);
        Toast.show('Setup link copied - open it on your other device once');
      } catch (e) {
        Toast.show('Could not copy automatically - link: ' + link, true);
      }
    });

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
        const model = block.querySelector('.model-input').value.trim();
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
            `<div class="model-pick" data-provider="${btn.dataset.provider}" style="padding:2px 0;cursor:pointer">${m}</div>`
          ).join('');
          listEl.querySelectorAll('.model-pick').forEach(row => {
            row.addEventListener('click', async () => {
              const modelInput = block.querySelector('.model-input');
              modelInput.value = row.textContent;
              await Providers.setModel(row.dataset.provider, row.textContent);
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
  }
};
