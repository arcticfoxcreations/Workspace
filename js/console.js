// Extra console commands added on top of the original fixed set in
// console.js. Kept in their own file on purpose - console.js only gets one
// small delegate call added to its switch's default case, so this round
// can't accidentally break the original commands.
//
// Same philosophy as the rest of the console: real actions on real state,
// nothing decorative, nothing that executes arbitrary code (see the
// comment at the top of console.js for why).

// Settings this workspace knows how to reset to default, one key at a
// time - so a single broken setting can be fixed without wiping everything
// via Data & Privacy -> clear.
const RESETTABLE_SETTINGS = {
  accent: '#7f77dd',
  fontSize: 15,
  fontFamily: (typeof FONT_PRESETS !== 'undefined' && FONT_PRESETS[0]) ? FONT_PRESETS[0].stack : null,
  lineHeight: 1.5,
  density: 'comfortable',
  chatWidth: '100%',
  bgImage: null,
  bgDim: 0.35,
  bubbleOpacity: 1,
  bubbleBlur: 0,
  sidebarBlur: 0,
  sidebarOpacity: 1,
  bubbleShape: 'rounded',
  bubbleFill: 'solid',
  ultraCompact: false,
  customGreeting: ''
};

const ConsoleCommands = {
  // Returns true if it handled the command, false if console.js should
  // fall through to its own "unknown command" message.
  async run(cmd, arg) {
    switch (cmd) {
      case 'storage': {
        if (navigator.storage && navigator.storage.estimate) {
          const { usage, quota } = await navigator.storage.estimate();
          const mb = (n) => (n / (1024 * 1024)).toFixed(1) + ' MB';
          const pct = quota ? ((usage / quota) * 100).toFixed(1) : '?';
          Logger.info('console', `using ${mb(usage || 0)} of ${mb(quota || 0)} available (${pct}%)`);
        } else {
          Logger.warn('console', 'this browser does not expose a storage estimate API');
        }
        return true;
      }
      case 'sync': {
        const sub = (arg || 'status').toLowerCase();
        if (sub === 'now') { const r = await Sync.syncNow({ force: true }); Logger.info('console', 'sync: ' + JSON.stringify(r)); return true; }
        if (sub === 'lock') { await Sync.lock(); Logger.info('console', 'sync key forgotten on this device'); return true; }
        const st = Sync.state || {};
        Logger.info('console', `sync: ${Sync.status}${Sync.statusDetail ? ' (' + Sync.statusDetail + ')' : ''} | enabled=${!!st.enabled} unlocked=${!!Vault.key} | waiting=${Object.keys(st.dirty || {}).length} | KV writes today=${Sync.writesToday()} | last=${st.lastSync ? new Date(st.lastSync).toLocaleString() : 'never'}`);
        return true;
      }
      case 'logs': {
        const [sub, val] = (arg || '').split(/\s+/);
        if (sub === 'persist' && (val === 'on' || val === 'off')) { await Logger.setPersist(val === 'on'); Logger.info('console', `console history ${val === 'on' ? 'will be kept across reloads (last 200 entries)' : 'is no longer saved'}`); return true; }
        if (sub === 'clear') { Logger.clear(); return true; }
        Logger.info('console', `usage: /logs persist on|off  ·  /logs clear  (persist is ${Logger.persistEnabled ? 'on' : 'off'})`);
        return true;
      }
      case 'reset': {
        if (!arg || !(arg in RESETTABLE_SETTINGS)) {
          Logger.info('console', `usage: /reset <setting> - known settings: ${Object.keys(RESETTABLE_SETTINGS).join(', ')}`);
          return true;
        }
        await DB.setSetting(arg, RESETTABLE_SETTINGS[arg]);
        if (typeof Settings !== 'undefined' && Settings.applyStoredAppearance) await Settings.applyStoredAppearance();
        Logger.info('console', `${arg} reset to default`);
        return true;
      }
      case 'theme': {
        if (!arg) {
          const names = (typeof PALETTE_PRESETS !== 'undefined') ? PALETTE_PRESETS.map(p => p.name).join(', ') : '';
          Logger.info('console', `usage: /theme <name> - one of: ${names}`);
          return true;
        }
        const match = (typeof PALETTE_PRESETS !== 'undefined')
          ? PALETTE_PRESETS.find(p => p.name.toLowerCase() === arg.toLowerCase())
          : null;
        if (!match) { Logger.warn('console', `no palette named "${arg}"`); return true; }
        document.documentElement.style.setProperty('--accent', match.accent);
        await DB.setSetting('accent', match.accent);
        Logger.info('console', `accent set to ${match.name} (${match.accent})`);
        return true;
      }
      case 'whoami': {
        const profile = await DB.getSetting('profile', {});
        if (!profile || !profile.name) {
          Logger.info('console', 'no profile saved yet - open Settings > Profile');
          return true;
        }
        Logger.info('console', `${profile.name}${profile.profession ? ' - ' + profile.profession : ''}`);
        if (profile.about) Logger.info('console', `about: ${profile.about}`);
        return true;
      }
      case 'ping': {
        if (arg !== 'all') {
          Logger.info('console', 'usage: /ping all  (to test one provider only, use /test <providerId>)');
          return true;
        }
        {
          const defs = await Providers.list();
          Logger.info('console', `pinging ${Object.keys(defs).length} providers...`);
          for (const id of Object.keys(defs)) {
            const started = Date.now();
            try {
              const result = await Providers.chat(id, [{ role: 'user', content: 'Reply with just the word "pong".' }]);
              const ms = Date.now() - started;
              if (result.error) Logger.error('console', `${id} failed after ${ms}ms`, result.message);
              else Logger.info('console', `${id} responded in ${ms}ms`);
            } catch (e) {
              Logger.error('console', `${id} failed`, e.message);
            }
          }
        }
        return true;
      }
      default:
        return false;
    }
  }
};

// ===== console.js =====
// The sidebar Console: a live feed of Logger events, plus a small set of
// REAL commands (not decorative) for checking what's actually going on -
// provider/key health, current session stats, keybinds, a live ping to a
// specific provider. Not a general code REPL - that would mean either
// faking it (useless) or actually eval-ing arbitrary input in an app that
// holds your provider keys' usage and PIN (a real security problem for a
// personal workspace someone might share a link to). This is the honest
// middle ground: transparency into real internal state, and real actions,
// through a fixed, safe set of commands.

const Console_ = {
  unsubscribe: null,
  open: false,

  toggle() {
    this.open ? this.close() : this.openPanel();
  },

  openPanel() {
    this.open = true;
    let panel = document.getElementById('consolePanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'consolePanel';
      panel.className = 'console-panel settings-panel';
      document.getElementById('app').appendChild(panel);
    }
    panel.innerHTML = `
      <div class="settings-header">
        <span>${svgIcon('bolt')} Console</span>
        <span style="display:flex;gap:10px;align-items:center">
          <i class="icon-btn" data-icon="download" id="consoleExportBtn" title="Export log"></i>
          <i class="icon-btn" data-icon="trash" id="consoleClearBtn" title="Clear"></i>
          <i class="icon-btn" data-icon="x" id="consoleCloseBtn"></i>
        </span>
      </div>
      <div class="console-log" id="consoleLog"></div>
      <form class="console-input-row" id="consoleForm">
        <span class="console-prompt">&gt;</span>
        <input type="text" id="consoleInput" placeholder="type a command, or /help" autocomplete="off" />
      </form>
    `;
    panel.classList.remove('hidden');
    document.getElementById('overlay').classList.remove('hidden');
    renderIcons(panel);

    this.renderLog();
    this.unsubscribe = Logger.subscribe((entry) => {
      if (entry === null) { this.renderLog(); return; }
      this.appendLine(entry);
    });

    document.getElementById('consoleCloseBtn').addEventListener('click', () => this.close());
    document.getElementById('consoleClearBtn').addEventListener('click', () => Logger.clear());
    document.getElementById('consoleExportBtn').addEventListener('click', () => {
      const blob = new Blob([Logger.exportText()], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `workspace-console-${Date.now()}.txt`; a.click();
      URL.revokeObjectURL(url);
    });
    document.getElementById('overlay').onclick = () => this.close();

    const form = document.getElementById('consoleForm');
    const input = document.getElementById('consoleInput');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cmd = input.value.trim();
      if (!cmd) return;
      input.value = '';
      Logger.info('console', '> ' + cmd);
      await this.runCommand(cmd);
    });
    setTimeout(() => input.focus(), 0);
  },

  close() {
    this.open = false;
    const panel = document.getElementById('consolePanel');
    if (panel) panel.classList.add('hidden');
    document.getElementById('overlay').classList.add('hidden');
    document.getElementById('overlay').onclick = null;
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
  },

  renderLog() {
    const log = document.getElementById('consoleLog');
    if (!log) return;
    log.innerHTML = '';
    Logger.buffer.forEach(e => this.appendLine(e, true));
    log.scrollTop = log.scrollHeight;
  },

  appendLine(entry, noScroll) {
    const log = document.getElementById('consoleLog');
    if (!log) return;
    const line = document.createElement('div');
    line.className = `console-line console-${entry.level}`;
    const t = new Date(entry.time).toLocaleTimeString([], { hour12: false });
    const extra = entry.data ? ' ' + (typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)) : '';
    line.textContent = `[${t}] ${entry.tag}: ${entry.message}${extra}`;
    log.appendChild(line);
    if (!noScroll) log.scrollTop = log.scrollHeight;
  },

  async runCommand(raw) {
    const [cmd, ...rest] = raw.replace(/^\//, '').split(' ');
    const arg = rest.join(' ').trim();
    try {
      switch (cmd.toLowerCase()) {
        case 'help':
          Logger.info('console', 'commands: /help /providers /keys /test <providerId> /session /keybinds /devices /auth /clear /export /storage /reset <setting> /theme <name> /whoami /ping /sync [now|lock] /logs persist on|off all (and /compile in the chat box)');
          break;
        case 'clear':
          Logger.clear();
          break;
        case 'export': {
          const blob = new Blob([Logger.exportText()], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = `workspace-console-${Date.now()}.txt`; a.click();
          URL.revokeObjectURL(url);
          Logger.info('console', 'exported log');
          break;
        }
        case 'providers': {
          const defs = await Providers.list();
          Logger.info('console', 'providers: ' + Object.keys(defs).join(', '));
          break;
        }
        case 'keys': {
          const info = await Providers.getKeyInfo();
          for (const [id, v] of Object.entries(info)) {
            const active = (v.keys || []).filter(k => !k.resting).length;
            const resting = (v.keys || []).filter(k => k.resting).length;
            Logger.info('console', `${id}: ${active} active, ${resting} resting`);
          }
          break;
        }
        case 'test': {
          if (!arg) { Logger.warn('console', 'usage: /test <providerId>  e.g. /test groq'); break; }
          Logger.info('console', `pinging ${arg}...`);
          const started = Date.now();
          const result = await Providers.chat(arg, [{ role: 'user', content: 'Reply with just the word "pong".' }]);
          const ms = Date.now() - started;
          if (result.error) Logger.error('console', `${arg} failed after ${ms}ms`, result.message);
          else Logger.info('console', `${arg} responded in ${ms}ms`, result.text.slice(0, 120));
          break;
        }
        case 'session': {
          const sid = App.currentSessionId;
          const messages = sid ? await DB.listMessages(sid) : [];
          const compiled = sid ? await DB.getSetting(`compiledContext:${sid}`, null) : null;
          Logger.info('console', `session ${sid || '(none)'}: ${messages.length} messages${compiled ? ', has compiled recap' : ''}`);
          break;
        }
        case 'keybinds':
          Logger.info('console', JSON.stringify(App.keybinds));
          break;
        case 'devices': {
          const { devices } = await Providers.listDevices();
          if (!devices.length) { Logger.info('console', 'no device pings recorded yet'); break; }
          const relTime = (ts) => {
            const mins = Math.round((Date.now() - ts) / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return `${mins}m ago`;
            const hrs = Math.round(mins / 60);
            if (hrs < 24) return `${hrs}h ago`;
            return `${Math.round(hrs / 24)}d ago`;
          };
          devices.forEach(d => {
            Logger.info('console', `${d.description}${d.isThisDevice ? ' (this device)' : ''} - last active ${relTime(d.lastSeen)}`);
          });
          break;
        }
        case 'auth': {
          const pinSet = !!localStorage.getItem('workspace_pin');
          const deviceId = localStorage.getItem('workspace_device_id') || '(none yet)';
          Logger.info('console', `PIN unlocked on this device: ${pinSet ? 'yes' : 'no - open Settings > Connection'}`);
          Logger.info('console', `this device's id: ${deviceId}`);
          break;
        }
        default: {
          const handled = (typeof ConsoleCommands !== 'undefined') ? await ConsoleCommands.run(cmd.toLowerCase(), arg) : false;
          if (!handled) Logger.warn('console', `unknown command "${cmd}" - try /help`);
        }
      }
    } catch (e) {
      Logger.error('console', 'command failed', e.message);
    }
  }
};
