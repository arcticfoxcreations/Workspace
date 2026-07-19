const DEFAULT_KEYBINDS = {
  palette: 'ctrl+k',
  settings: 'ctrl+,',
  colorPalette: 'ctrl+shift+c',
  aiSelect: 'ctrl+shift+a',
  newSession: 'ctrl+shift+n',
  toggleSidebar: 'ctrl+b',
  modeMenu: 'ctrl+m',
  focusComposer: '/',
  toggleAuto: 'ctrl+0',
  regenerateLast: 'alt+r',
  keybindSheet: 'ctrl+/'
};

const KEYBIND_LABELS = {
  palette: 'Open command palette',
  settings: 'Open Settings',
  colorPalette: 'Open color palette',
  aiSelect: 'Open AI-select menu',
  newSession: 'New session',
  toggleSidebar: 'Toggle sidebar',
  modeMenu: 'Open mode menu',
  focusComposer: 'Focus the message box',
  toggleAuto: 'Switch back to Auto',
  regenerateLast: 'Regenerate last reply',
  keybindSheet: 'Show this cheat-sheet'
};

const CHAT_MODES = {
  normal: {
    label: 'Normal', glyph: '💬',
    desc: 'Casual chat - short replies for small talk, longer only when the question needs it.',
    prompt: 'Reply naturally and conversationally, like a normal helpful chat assistant. Match your reply length to the question - a greeting or simple question gets a short, casual reply, not a structured report. Only go into real depth when the question actually calls for it.'
  },
  research: {
    label: 'Research', glyph: '🔎',
    desc: 'Deep, structured, thorough - key points, summary, then full detail. Built for study and research.',
    prompt: 'This is research/study mode. For any substantive question, structure your answer as: key points first (bulleted, scannable), then a short summary paragraph, then full detail (methodology, context, data, nuance). Be thorough and precise - do not artificially shorten. Small talk (greetings, thanks, etc.) can still get a brief, normal reply - only apply the full structure to real questions.'
  },
  quick: {
    label: 'Quick', glyph: '⚡',
    desc: 'As short as possible - one direct answer, no elaboration.',
    prompt: 'Answer in 1-3 sentences maximum. Give the single most direct answer. No preamble, no elaboration, no structure - just the answer, unless the person explicitly asks for more.'
  },
  test: {
    label: 'Test me', glyph: '📝',
    desc: 'Quizzes you on the topic - asks one question at a time and gives feedback.',
    prompt: 'You are quizzing the person on whatever topic they bring up. Ask ONE question at a time related to what they want to study. Wait for their answer. When they answer, tell them clearly if they were right or wrong, give a brief correction/explanation either way, then ask the next question. Keep it interactive - never lecture for multiple paragraphs in a row.'
  }
};

const App = {
  currentSessionId: null,
  manualTarget: null, // null = auto mode
  pendingAttachments: [], // [{name, text, imageBase64}] waiting to be sent
  keybinds: DEFAULT_KEYBINDS,
  scrollLocked: false,

  async init() {
    await Settings.init();
    const storedKeybinds = await DB.getSetting('customKeybinds', null);
    this.keybinds = Object.assign({}, DEFAULT_KEYBINDS, storedKeybinds || {});

    this.wireSidebar();
    this.wireComposer();
    this.wireHeaderChip();
    this.wireScrollButton();
    this.wireGlobalKeys();
    this.wireProfileButton();
    this.wireMic();
    await this.refreshHeaderChips();

    let sessions = await DB.listSessions();
    if (sessions.length === 0) {
      const s = await DB.createSession('New session');
      sessions = [s];
    }
    await this.renderSessionList(sessions);
    await this.openSession(sessions[0].id);

    await this.checkForSharedLink();

    renderIcons();
  },

  // ---- cross-device share: opening a ?share=<token> link ----
  async checkForSharedLink() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('share');
    if (!token) return;
    window.history.replaceState({}, '', window.location.pathname);
    try {
      const result = await Providers.getSharedSession(token);
      if (result.error || !result.session) { Toast.show('That share link is invalid or expired.', true); return; }
      const s = await DB.importSharedSession(result.session.title, result.session.messages);
      Toast.show(`Added shared session "${s.title}" - you can continue it here.`);
      await this.renderSessionList(await DB.listSessions());
      await this.openSession(s.id);
    } catch (e) {
      Toast.show('Could not open shared session: ' + e.message, true);
    }
  },

  // ---- sidebar: collapse/pin + hover-to-peek ----
  wireSidebar() {
    const sidebar = document.getElementById('sidebar');
    const star = document.getElementById('starBtn');
    const starCollapsed = document.getElementById('starBtnCollapsed');
    const headerRow = document.getElementById('headerRow');
    const hoverZone = document.getElementById('sidebarHoverZone');

    star.addEventListener('click', () => this.toggleSidebar());
    starCollapsed.addEventListener('click', () => this.toggleSidebar());

    // hover-to-peek while collapsed - doesn't un-pin, just previews
    if (hoverZone) {
      hoverZone.addEventListener('mouseenter', () => {
        if (sidebar.classList.contains('collapsed')) sidebar.classList.add('peek');
      });
      sidebar.addEventListener('mouseleave', () => {
        sidebar.classList.remove('peek');
      });
    }

    document.getElementById('newSessionBtn').addEventListener('click', async () => {
      const s = await DB.createSession('New session');
      const sessions = await DB.listSessions();
      await this.renderSessionList(sessions);
      await this.openSession(s.id);
    });
  },

  wireProfileButton() {
    document.getElementById('profileBtn').addEventListener('click', async () => {
      await Settings.open();
      Settings.scrollToProfile && Settings.scrollToProfile();
    });
  },

  // Browser-native speech-to-text (Web Speech API). No server round-trip,
  // nothing leaves the device except the transcribed text once you send it -
  // same as if you'd typed it. Not supported in every browser (Chrome/Edge
  // yes, Firefox no) so we degrade quietly if it's missing.
  wireMic() {
    const btn = document.getElementById('micBtn');
    const input = document.getElementById('messageInput');
    const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) {
      btn.title = 'Voice input not supported in this browser';
      btn.style.opacity = '0.35';
      btn.addEventListener('click', () => Toast.show('Voice input needs Chrome or Edge - not supported here.', true));
      return;
    }
    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    let listening = false;
    let baseText = '';

    recognition.onresult = (e) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalChunk += chunk;
        else interimChunk += chunk;
      }
      if (finalChunk) baseText += finalChunk;
      input.value = (baseText + interimChunk).trim();
      input.dispatchEvent(new Event('input'));
    };
    recognition.onerror = () => {
      Toast.show('Voice input stopped - try again.', true);
      listening = false;
      btn.classList.remove('mic-active');
    };
    recognition.onend = () => {
      listening = false;
      btn.classList.remove('mic-active');
    };

    btn.addEventListener('click', () => {
      if (listening) {
        recognition.stop();
        return;
      }
      baseText = input.value ? input.value + ' ' : '';
      try {
        recognition.start();
        listening = true;
        btn.classList.add('mic-active');
        Toast.show('Listening...');
      } catch (e) { /* already started */ }
    });
  },

  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const starCollapsed = document.getElementById('starBtnCollapsed');
    const headerRow = document.getElementById('headerRow');
    const collapsed = sidebar.classList.contains('collapsed');
    if (collapsed) {
      sidebar.classList.remove('collapsed');
      starCollapsed.style.display = 'none';
      headerRow.style.paddingLeft = '16px';
    } else {
      sidebar.classList.add('collapsed');
      starCollapsed.style.display = 'flex';
      headerRow.style.paddingLeft = '40px';
    }
  },

  // ---- header AI-select chip + mode chip ----
  wireHeaderChip() {
    const chipsWrap = document.getElementById('modeChips');
    chipsWrap.addEventListener('click', async (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      if (chip.dataset.role === 'mode') { await this.openModeMenu(); return; }
      await this.openAiSelectMenu();
    });
  },

  async openModeMenu() {
    const existing = document.getElementById('modeSelectDropdown');
    if (existing) { existing.remove(); return; }
    const current = await DB.getSetting('chatMode', 'normal');

    const dropdown = document.createElement('div');
    dropdown.id = 'modeSelectDropdown';
    dropdown.className = 'floating-menu';
    dropdown.style.minWidth = '220px';

    Object.entries(CHAT_MODES).forEach(([key, m]) => {
      const row = document.createElement('div');
      row.className = 'palette-item';
      row.style.alignItems = 'flex-start';
      row.innerHTML = `<span>${m.glyph}</span><span><span style="display:block;font-weight:${key === current ? '600' : '400'}">${m.label}</span><span style="display:block;font-size:11px;color:var(--text-muted);white-space:normal">${m.desc}</span></span>`;
      row.addEventListener('click', async () => {
        await DB.setSetting('chatMode', key);
        dropdown.remove();
        this.refreshHeaderChips();
        Toast.show(`Switched to ${m.label} mode`);
      });
      dropdown.appendChild(row);
    });

    document.getElementById('headerRow').appendChild(dropdown);
    setTimeout(() => {
      document.addEventListener('click', function closeOnce(ev) {
        if (!dropdown.contains(ev.target)) {
          dropdown.remove();
          document.removeEventListener('click', closeOnce);
        }
      });
    }, 0);
  },

  async openAiSelectMenu() {
    const existing = document.getElementById('modeDropdown');
    if (existing) { existing.remove(); return; }

    let providerDefs;
    try {
      providerDefs = await Providers.list();
    } catch (err) {
      Toast.show('Connect your backend in Settings first', true);
      return;
    }
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);

    const dropdown = document.createElement('div');
    dropdown.id = 'modeDropdown';
    dropdown.className = 'floating-menu';
    const rowStyle = 'padding:7px 10px;border-radius:7px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;';

    const autoRow = document.createElement('div');
    autoRow.innerHTML = `<span>Auto</span>`;
    autoRow.style.cssText = rowStyle;
    autoRow.addEventListener('mouseenter', () => autoRow.style.background = 'var(--line)');
    autoRow.addEventListener('mouseleave', () => autoRow.style.background = 'transparent');
    autoRow.addEventListener('click', () => { this.manualTarget = null; this.refreshHeaderChips(); dropdown.remove(); });
    dropdown.appendChild(autoRow);

    Object.keys(providerDefs).forEach((id, i) => {
      const row = document.createElement('div');
      row.innerHTML = `<span style="opacity:0.8;display:inline-flex">${providerIconHTML(id, 15)}</span><span>${nicknames[id] || providerDefs[id].label}</span><span style="margin-left:auto;font-size:10px;color:var(--text-muted)">${i < 9 ? 'Ctrl+' + (i + 1) : ''}</span>`;
      row.style.cssText = rowStyle;
      row.addEventListener('mouseenter', () => row.style.background = 'var(--line)');
      row.addEventListener('mouseleave', () => row.style.background = 'transparent');
      row.addEventListener('click', () => { this.manualTarget = id; this.refreshHeaderChips(); dropdown.remove(); });
      dropdown.appendChild(row);
    });

    document.getElementById('headerRow').appendChild(dropdown);
    setTimeout(() => {
      document.addEventListener('click', function closeOnce(ev) {
        if (!dropdown.contains(ev.target)) {
          dropdown.remove();
          document.removeEventListener('click', closeOnce);
        }
      });
    }, 0);
  },

  async refreshHeaderChips() {
    const chipsWrap = document.getElementById('modeChips');
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const label = this.manualTarget ? (nicknames[this.manualTarget] || this.manualTarget) : 'Auto';
    const glyph = this.manualTarget
      ? `<span style="margin-right:5px;display:inline-flex;vertical-align:-2px">${providerIconHTML(this.manualTarget, 13)}</span>`
      : `<span class="auto-live-dot" style="margin-right:6px"></span>`;
    const modeKey = await DB.getSetting('chatMode', 'normal');
    const modeInfo = CHAT_MODES[modeKey] || CHAT_MODES.normal;
    chipsWrap.innerHTML = `
      <button class="chip chip-active" data-role="target">${glyph}${label}</button>
      <button class="chip" data-role="mode" title="${modeInfo.desc}"><span style="margin-right:5px">${modeInfo.glyph}</span>${modeInfo.label}</button>`;
  },

  // ---- command palette (Ctrl+K) + keybinds ----
  wireGlobalKeys() {
    document.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        const palette = document.getElementById('commandPalette');
        const anyMenu = document.getElementById('modeDropdown') || document.getElementById('modeSelectDropdown') || document.getElementById('sessionMenu') || document.getElementById('verifyMenu');
        if (palette && !palette.classList.contains('hidden')) { this.closeCommandPalette(); return; }
        if (anyMenu) { anyMenu.remove(); return; }
        const settingsPanel = document.getElementById('settingsPanel');
        if (settingsPanel && !settingsPanel.classList.contains('hidden')) { Settings.close(); return; }
        return;
      }

      const combo = this.comboFromEvent(e);

      if (combo === this.keybinds.palette) { e.preventDefault(); this.toggleCommandPalette(); return; }
      if (combo === this.keybinds.settings) { e.preventDefault(); Settings.open(); return; }
      if (combo === this.keybinds.colorPalette) { e.preventDefault(); Settings.open(); Settings.scrollToAppearance && Settings.scrollToAppearance(); return; }
      if (combo === this.keybinds.aiSelect) { e.preventDefault(); this.openAiSelectMenu(); return; }
      if (combo === this.keybinds.newSession) { e.preventDefault(); document.getElementById('newSessionBtn').click(); return; }
      if (combo === this.keybinds.toggleSidebar) { e.preventDefault(); this.toggleSidebar(); return; }
      if (combo === this.keybinds.modeMenu) { e.preventDefault(); this.openModeMenu(); return; }
      if (combo === this.keybinds.toggleAuto) { e.preventDefault(); this.manualTarget = null; this.refreshHeaderChips(); Toast.show('Back to Auto'); return; }
      if (combo === this.keybinds.regenerateLast) { e.preventDefault(); this.regenerateLastMessage(); return; }
      if (combo === this.keybinds.keybindSheet) { e.preventDefault(); this.openKeybindSheet(); return; }
      if (combo === this.keybinds.focusComposer && !this.isTypingTarget(e.target)) {
        e.preventDefault();
        document.getElementById('messageInput').focus();
        return;
      }

      // Ctrl+1..9 - jump straight to provider N
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const providerDefs = await Providers.list().catch(() => null);
        if (!providerDefs) return;
        const ids = Object.keys(providerDefs);
        const idx = parseInt(e.key, 10) - 1;
        if (ids[idx]) {
          e.preventDefault();
          this.manualTarget = ids[idx];
          this.refreshHeaderChips();
          document.getElementById('messageInput').focus();
        }
      }
    });
  },

  isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  },

  async regenerateLastMessage() {
    const messages = await DB.listMessages(this.currentSessionId);
    const lastAi = [...messages].reverse().find(m => m.role === 'ai');
    if (!lastAi) { Toast.show('No AI reply yet to regenerate', true); return; }
    await this.regenerate(lastAi);
  },

  comboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    let key = e.key.toLowerCase();
    if (key === ',') key = ',';
    parts.push(key);
    return parts.join('+');
  },

  toggleCommandPalette() {
    let el = document.getElementById('commandPalette');
    if (!el.classList.contains('hidden')) { this.closeCommandPalette(); return; }
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="palette-box">
        <div class="palette-box-head">
          <span>Command palette</span>
          <i class="icon-btn" data-icon="x" data-close></i>
        </div>
        <div class="palette-item" data-action="settings">${svgIcon('settings')} <span>Open Settings</span></div>
        <div class="palette-item" data-action="ai">${svgIcon('command')} <span>Switch AI</span></div>
        <div class="palette-item" data-action="palette">${svgIcon('palette')} <span>Color palette</span></div>
        <div class="palette-item" data-action="keybinds">${svgIcon('key')} <span>Keybinds cheat-sheet</span></div>
      </div>`;
    el.querySelectorAll('.palette-item').forEach(item => {
      item.addEventListener('click', () => {
        const a = item.dataset.action;
        this.closeCommandPalette();
        if (a === 'settings') Settings.open();
        if (a === 'ai') this.openAiSelectMenu();
        if (a === 'palette') { Settings.open(); }
        if (a === 'keybinds') this.openKeybindSheet();
      });
    });
    this.wirePaletteDismiss(el);
    renderIcons(el);
  },

  // Every way to close an overlay: the X button, clicking the dark backdrop,
  // and Escape - wired once per open() call so it works no matter which
  // function last filled the palette's contents.
  wirePaletteDismiss(el) {
    const closeBtn = el.querySelector('[data-close]');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeCommandPalette());
    el.addEventListener('click', (ev) => { if (ev.target === el) this.closeCommandPalette(); });
  },

  closeCommandPalette() {
    document.getElementById('commandPalette').classList.add('hidden');
  },

  openKeybindSheet() {
    let el = document.getElementById('commandPalette');
    el.classList.remove('hidden');
    const rows = Object.keys(DEFAULT_KEYBINDS).map(k => [k, KEYBIND_LABELS[k] || k]);
    el.innerHTML = `<div class="palette-box">
      <div class="palette-box-head">
        <span>Keybinds</span>
        <i class="icon-btn" data-icon="x" data-close></i>
      </div>
      <div style="font-size:12px;color:var(--text-muted);padding:6px 10px">click "change" then press a new combo</div>
      ${rows.map(([k, label]) => `
        <div class="palette-item" style="cursor:default">
          <span style="flex:1">${label}</span>
          <span class="keybind-tag" data-key="${k}">${(this.keybinds[k] || '').toUpperCase()}</span>
          <button class="small-btn" data-rebind="${k}">change</button>
        </div>`).join('')}
      <div class="palette-item" style="cursor:default;opacity:0.7">
        <span style="flex:1">Send to AI #1-9 directly</span>
        <span class="keybind-tag">CTRL+1..9</span>
      </div>
    </div>`;
    this.wirePaletteDismiss(el);
    renderIcons(el);
    el.querySelectorAll('[data-rebind]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.rebind;
        btn.textContent = 'press keys...';
        const capture = async (ev) => {
          ev.preventDefault();
          const combo = this.comboFromEvent(ev);
          this.keybinds[key] = combo;
          await DB.setSetting('customKeybinds', this.keybinds);
          document.removeEventListener('keydown', capture, true);
          this.openKeybindSheet();
        };
        document.addEventListener('keydown', capture, true);
      });
    });
  },

  // ---- session list ----
  async renderSessionList(sessions) {
    const listEl = document.getElementById('sessionList');
    listEl.innerHTML = sessions.map(s => `
      <div class="session-item ${s.id === this.currentSessionId ? 'active' : ''}" data-id="${s.id}">
        <span class="session-title">${s.title}</span>
        <span class="session-time">${this.relativeTime(s.updatedAt)}</span>
        <i class="icon-btn session-menu-btn" data-icon="more" data-id="${s.id}" title="Options"></i>
      </div>`).join('');
    listEl.querySelectorAll('.session-title').forEach(el => {
      el.addEventListener('click', () => this.openSession(el.closest('.session-item').dataset.id));
    });
    listEl.querySelectorAll('.session-menu-btn').forEach(el => {
      el.addEventListener('click', (e) => { e.stopPropagation(); this.openSessionMenu(el.dataset.id, el); });
    });
    renderIcons(listEl);
  },

  relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return min + 'm';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h';
    const day = Math.floor(hr / 24);
    if (day < 7) return day + 'd';
    return Math.floor(day / 7) + 'w';
  },

  async openSessionMenu(sessionId, anchorEl) {
    const existing = document.getElementById('sessionMenu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'sessionMenu';
    menu.className = 'floating-menu';
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left - 100 + 'px';
    menu.innerHTML = `
      <div class="palette-item" data-act="rename">${svgIcon('edit')} <span>Rename</span></div>
      <div class="palette-item" data-act="share">${svgIcon('share')} <span>Share (continue on another device)</span></div>
      <div class="palette-item" data-act="delete" style="color:#d98a5f">${svgIcon('trash')} <span>Delete</span></div>
    `;
    document.body.appendChild(menu);

    menu.querySelector('[data-act="rename"]').addEventListener('click', async () => {
      menu.remove();
      const wrap = document.createElement('div');
      wrap.className = 'inline-rename';
      const sessions = await DB.listSessions();
      const current = sessions.find(s => s.id === sessionId);
      const newTitle = window.prompt ? null : null; // placeholder, replaced below
      this.startInlineRename(sessionId, current ? current.title : '');
    });
    menu.querySelector('[data-act="share"]').addEventListener('click', async () => {
      menu.remove();
      await this.shareSession(sessionId);
    });
    menu.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      menu.remove();
      await DB.deleteSession(sessionId);
      const sessions = await DB.listSessions();
      if (sessions.length === 0) { const s = await DB.createSession('New session'); sessions.push(s); }
      await this.renderSessionList(sessions);
      if (sessionId === this.currentSessionId) await this.openSession(sessions[0].id);
      Toast.show('Session deleted');
    });

    setTimeout(() => {
      document.addEventListener('click', function closeOnce(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closeOnce); }
      });
    }, 0);
  },

  startInlineRename(sessionId, currentTitle) {
    const itemEl = document.querySelector(`.session-item[data-id="${sessionId}"] .session-title`);
    if (!itemEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.style.cssText = 'width:100%;background:var(--bg-2);border:0.5px solid var(--accent);border-radius:6px;padding:3px 6px;font-size:13px;color:var(--text-primary)';
    itemEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = async () => {
      const v = input.value.trim() || currentTitle;
      await DB.renameSession(sessionId, v);
      await this.renderSessionList(await DB.listSessions());
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  },

  async shareSession(sessionId) {
    try {
      const sessions = await DB.listSessions();
      const s = sessions.find(x => x.id === sessionId);
      const messages = await DB.exportSessionForShare(sessionId);
      const result = await Providers.shareSession(s ? s.title : 'Shared session', messages);
      if (result.error || !result.token) { Toast.show('Could not create share link', true); return; }
      const link = `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(result.token)}`;
      try {
        await navigator.clipboard.writeText(link);
        Toast.show('Share link copied - open it on your other device, no PIN needed');
      } catch (e) {
        Toast.show('Link ready (copy failed): ' + link);
      }
      const links = await DB.getSetting('shareLinks', []);
      links.push({ token: result.token, title: s ? s.title : 'Shared session', createdAt: Date.now() });
      await DB.setSetting('shareLinks', links);
    } catch (e) {
      Toast.show('Could not share: ' + e.message, true);
    }
  },

  // ---- opening a session ----
  async openSession(id) {
    this.currentSessionId = id;
    const sessions = await DB.listSessions();
    await this.renderSessionList(sessions);
    const messages = await DB.listMessages(id);
    const logEl = document.getElementById('chatLog');
    logEl.innerHTML = '';
    if (messages.length === 0) {
      this.renderEmptyState();
    } else {
      for (const m of messages) this.renderMessage(m);
    }
    logEl.scrollTop = logEl.scrollHeight;
    await this.refreshUsageBar();
  },

  // ---- empty-state greeting with quick-start chips ----
  renderEmptyState() {
    const greetings = [
      'What are we digging into today?',
      'Ask anything, or pick a starting point.',
      'Ready when you are.',
      'One workspace, every AI - what\'s first?'
    ];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const starters = [
      { label: 'Explain something', text: 'Explain ', mode: null },
      { label: 'Debug my code', text: 'Help me debug this: ', mode: null },
      { label: 'Research a topic', text: 'Research ', mode: 'research' },
      { label: 'Quiz me', text: 'Quiz me on ', mode: 'test' }
    ];
    const logEl = document.getElementById('chatLog');
    const wrap = document.createElement('div');
    wrap.id = 'emptyState';
    wrap.className = 'empty-state';
    wrap.innerHTML = `
      <div class="empty-state-glyph"></div>
      <div class="empty-state-greeting">${greeting}</div>
      <div class="empty-state-starters">
        ${starters.map((s, i) => `<button type="button" class="starter-chip" data-idx="${i}">${s.label}</button>`).join('')}
      </div>`;
    wrap.querySelectorAll('.starter-chip').forEach((btn, i) => {
      btn.addEventListener('click', async () => {
        const s = starters[i];
        if (s.mode) {
          await DB.setSetting('chatMode', s.mode);
          this.refreshHeaderChips();
        }
        const input = document.getElementById('messageInput');
        input.value = s.text;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input'));
      });
    });
    logEl.appendChild(wrap);
  },

  // ---- markdown-lite renderer (no external lib, keeps copyright/safety simple) ----
  renderMarkdown(raw) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let text = esc(raw);

    // fenced code blocks
    text = text.replace(/```([\s\S]*?)```/g, (m, code) => `<pre><code>${code.trim()}</code></pre>`);
    // inline code
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    // bold / italic
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    // headers
    text = text.replace(/^### (.*)$/gm, '<strong class="md-h">$1</strong>');
    text = text.replace(/^## (.*)$/gm, '<strong class="md-h">$1</strong>');
    text = text.replace(/^# (.*)$/gm, '<strong class="md-h">$1</strong>');
    // unordered lists
    text = text.replace(/(^|\n)([-*] .*(\n[-*] .*)*)/g, (m, lead, block) => {
      const items = block.split('\n').map(l => `<li>${l.replace(/^[-*]\s+/, '')}</li>`).join('');
      return `${lead}<ul class="md-list">${items}</ul>`;
    });
    // ordered lists
    text = text.replace(/(^|\n)(\d+\. .*(\n\d+\. .*)*)/g, (m, lead, block) => {
      const items = block.split('\n').map(l => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('');
      return `${lead}<ol class="md-list">${items}</ol>`;
    });
    // remaining newlines -> line breaks
    text = text.replace(/\n(?!<)/g, '<br>');
    return text;
  },

  renderMessage(m) {
    const logEl = document.getElementById('chatLog');
    const wrap = document.createElement('div');
    if (m.role === 'user') {
      wrap.className = 'msg user';
      wrap.innerHTML = `<div class="bubble"></div>`;
      wrap.querySelector('.bubble').textContent = m.content;
    } else if (m.role === 'system') {
      wrap.className = 'msg system';
      wrap.innerHTML = `<div class="bubble"></div>`;
      wrap.querySelector('.bubble').textContent = m.content;
    } else {
      wrap.className = 'msg ai';
      wrap.innerHTML = `
        <div class="msg-label"></div>
        <div class="bubble"></div>
        <div class="msg-actions">
          <i class="icon-btn" data-icon="copy" title="Copy" data-act="copy"></i>
          <i class="icon-btn" data-icon="refresh" title="Regenerate" data-act="regen"></i>
          <i class="icon-btn" data-icon="shieldCheck" title="Verify with another AI" data-act="verify"></i>
        </div>`;
      wrap.querySelector('.msg-label').textContent = m.nickname || 'AI';
      wrap.querySelector('.bubble').innerHTML = m.thinking
        ? `<span class="typing-dots"><span></span><span></span><span></span></span>`
        : this.renderMarkdown(m.content || '');
      wrap.dataset.messageId = m.id || '';
      wrap.dataset.providerNickname = m.nickname || '';

      wrap.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(m.content); Toast.show('Copied'); }
        catch (e) { Toast.show('Could not copy', true); }
      });
      wrap.querySelector('[data-act="regen"]').addEventListener('click', () => this.regenerate(m));
      wrap.querySelector('[data-act="verify"]').addEventListener('click', (e) => this.openVerifyMenu(m, e.target));
    }
    logEl.appendChild(wrap);
    if (!this.scrollLocked) logEl.scrollTop = logEl.scrollHeight;
    renderIcons(wrap);
    return wrap;
  },

  async openVerifyMenu(originalMsg, anchorEl) {
    const existing = document.getElementById('verifyMenu');
    if (existing) { existing.remove(); return; }
    let providerDefs;
    try { providerDefs = await Providers.list(); } catch (e) { Toast.show('Connect backend first', true); return; }
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const menu = document.createElement('div');
    menu.id = 'verifyMenu';
    menu.className = 'floating-menu';
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';
    Object.keys(providerDefs).forEach(id => {
      if (nicknames[id] === originalMsg.nickname) return;
      const row = document.createElement('div');
      row.className = 'palette-item';
      row.innerHTML = `<span style="display:inline-flex">${providerIconHTML(id, 14)}</span><span>Ask ${nicknames[id] || providerDefs[id].label} to verify</span>`;
      row.addEventListener('click', () => { menu.remove(); this.verifyWith(id, originalMsg); });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    setTimeout(() => {
      document.addEventListener('click', function closeOnce(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closeOnce); }
      });
    }, 0);
  },

  async verifyWith(providerId, originalMsg) {
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const nickname = nicknames[providerId] || providerId;
    const verifierLabel = `${nickname} (verifying)`;
    const thinkingEl = this.renderMessage({ role: 'ai', nickname: verifierLabel, thinking: true });
    const prompt = [
      { role: 'system', content: 'You are fact-checking another AI\'s answer. Say clearly whether it looks correct, and note any mistakes or missing context. Be concise.' },
      { role: 'user', content: `Here is an AI's answer to review:\n\n[${originalMsg.nickname}]: ${originalMsg.content}\n\nIs this correct? Point out anything wrong or missing.` }
    ];
    let finalText;
    try {
      const result = await Providers.chat(providerId, prompt);
      finalText = result.error ? `(verification failed: ${result.message})` : result.text;
    } catch (err) {
      finalText = `(verification failed: ${err.message || 'Something went wrong - try again.'})`;
    }
    thinkingEl.querySelector('.bubble').innerHTML = this.renderMarkdown(finalText);
    await DB.addMessage(this.currentSessionId, { role: 'ai', nickname: verifierLabel, content: finalText });
  },

  async regenerate(originalMsg) {
    const providerId = this.findProviderIdByNickname(originalMsg.nickname);
    if (!providerId) { Toast.show('Could not tell which AI this was', true); return; }
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const sharedMessages = await this.buildSharedContext();
    const thinkingEl = this.renderMessage({ role: 'ai', nickname: originalMsg.nickname, thinking: true });
    const result = await Providers.chat(providerId, sharedMessages);
    const finalText = result.error ? `(${originalMsg.nickname} error: ${result.message})` : this.stripNamePrefix(result.text);
    thinkingEl.querySelector('.bubble').innerHTML = this.renderMarkdown(finalText);
    await DB.addMessage(this.currentSessionId, { role: 'ai', nickname: originalMsg.nickname, content: finalText });
  },

  findProviderIdByNickname(nickname) {
    // best-effort: nicknames map is providerId -> nickname, reverse lookup
    // via DEFAULT_NICKNAMES keys since this is a client-only convenience.
    for (const id of Object.keys(DEFAULT_NICKNAMES)) {
      if (DEFAULT_NICKNAMES[id] === nickname) return id;
    }
    return null;
  },

  // ---- scroll-to-bottom arrow (replaces auto-scroll-lock) ----
  wireScrollButton() {
    const logEl = document.getElementById('chatLog');
    const btn = document.getElementById('scrollBottomBtn');
    logEl.addEventListener('scroll', () => {
      const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
      this.scrollLocked = !atBottom;
      btn.classList.toggle('hidden', atBottom);
    });
    btn.addEventListener('click', () => {
      logEl.scrollTo({ top: logEl.scrollHeight, behavior: 'smooth' });
      this.scrollLocked = false;
      btn.classList.add('hidden');
    });
  },

  // ---- composer: auto-grow, enter-to-send, file attach ----
  wireComposer() {
    const form = document.getElementById('composer');
    const input = document.getElementById('messageInput');

    const tips = [
      'hmm, say something...',
      'try: "gemini go into research mode and explain..."',
      'type @groq to ask a specific AI',
      'attach a PDF, doc, or image with the clip icon',
      'say "hey Claude, from now call you Nova" to rename it',
      'press / to jump here, Ctrl+/ for all shortcuts'
    ];
    let tipIndex = 0;
    setInterval(() => {
      if (document.activeElement !== input) {
        tipIndex = (tipIndex + 1) % tips.length;
        input.placeholder = tips[tipIndex];
      }
    }, 6000);

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text && this.pendingAttachments.length === 0) return;
      input.value = '';
      input.style.height = 'auto';
      await this.handleSend(text);
    });

    document.getElementById('fileInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length === 0) return;

      const existingBytes = this.pendingAttachments.reduce((s, a) => s + (a.size || 0), 0);
      const check = FileHandler.validateBatch(files, existingBytes);
      if (!check.ok) { Toast.show(check.message, true); return; }
      if (check.warnFiles && check.warnFiles.length) {
        Toast.show(`Heads up - ${check.warnFiles.join(', ')} ${check.warnFiles.length > 1 ? 'are' : 'is'} large and may take a moment to extract.`);
      }

      for (const file of files) {
        const chip = this.addAttachmentChip(file.name, 0);
        try {
          const result = await FileHandler.extract(file, (p) => this.updateAttachmentChip(chip, p));
          this.pendingAttachments.push({
            name: file.name, size: file.size, type: file.type,
            text: result.text, imageBase64: result.imageBase64 || null,
            keepRaw: result.keepRaw, base64: result.base64 || null
          });
          this.updateAttachmentChip(chip, 1, true);
          if (result.imageBase64) {
            FileHandler.extractDominantColors(result.imageBase64, 5).then(colors => {
              this.renderColorSwatches(chip, colors);
            }).catch(() => {});
          }
        } catch (err) {
          chip.remove();
          Toast.show(`Could not read ${file.name}: ${err.message}`, true);
        }
      }
      if (files.some(f => FileHandler.isImage(f))) {
        Toast.show('Image attached - works best with Gemini/Claude/GPT; some free models can\'t see images yet.');
      }
    });
  },

  addAttachmentChip(name, progress) {
    const bar = document.getElementById('attachmentBar');
    bar.classList.remove('hidden');
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `${svgIcon('file')} <span class="file-chip-name">${name}</span> <span class="file-chip-progress">0%</span> <i class="icon-btn" data-icon="x"></i>`;
    chip.querySelector('[data-icon="x"]').addEventListener('click', () => {
      const idx = Array.from(bar.children).indexOf(chip);
      if (idx > -1) this.pendingAttachments.splice(idx, 1);
      chip.remove();
      if (bar.children.length === 0) bar.classList.add('hidden');
    });
    bar.appendChild(chip);
    renderIcons(chip);
    return chip;
  },
  updateAttachmentChip(chip, progress, done) {
    const p = chip.querySelector('.file-chip-progress');
    p.textContent = done ? 'ready' : Math.round(progress * 100) + '%';
  },
  renderColorSwatches(chip, colors) {
    if (!colors || !colors.length) return;
    const wrap = document.createElement('span');
    wrap.className = 'color-swatches';
    wrap.title = colors.join(', ') + ' (click to copy a hex code)';
    wrap.innerHTML = colors.map(c => `<i style="background:${c}" data-hex="${c}"></i>`).join('');
    wrap.querySelectorAll('i').forEach(sw => {
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard && navigator.clipboard.writeText(sw.dataset.hex).catch(() => {});
        Toast.show(`Copied ${sw.dataset.hex}`);
      });
    });
    chip.insertBefore(wrap, chip.querySelector('.icon-btn'));
  },

  stripNamePrefix(text) {
    return (text || '').replace(/^\s*\[[^\]]{1,40}\]:\s*/, '');
  },

  async buildSharedContext() {
    const history = await DB.listMessages(this.currentSessionId);
    const sharedMessages = history.map(m => {
      if (m.role === 'user') return { role: 'user', content: m.content };
      if (m.role === 'system') return null;
      return { role: 'assistant', content: `[${m.nickname}]: ${m.content}` };
    }).filter(Boolean);
    const modeKey = await DB.getSetting('chatMode', 'normal');
    const modeInfo = CHAT_MODES[modeKey] || CHAT_MODES.normal;
    const profile = await DB.getSetting('profile', null);
    let profileLine = '';
    if (profile && (profile.name || profile.profession || profile.about)) {
      const bits = [];
      if (profile.name) bits.push(`Their name is ${profile.name}.`);
      if (profile.profession) bits.push(`They work as/study: ${profile.profession}.`);
      if (profile.about) bits.push(`Extra context about them: ${profile.about}`);
      profileLine = ' ' + bits.join(' ');
    }
    sharedMessages.unshift({
      role: 'system',
      content: 'You are one voice in a multi-AI workspace. Prior replies from other AIs are shown to you as "[Name]: message" purely as a label so you know who said what - that bracket format is metadata, never something to copy. Never start your own reply with a bracketed name. ' + modeInfo.prompt + profileLine
    });
    return sharedMessages;
  },

  async handleSend(text) {
    const emptyState = document.getElementById('emptyState');
    if (emptyState) emptyState.remove();

    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);

    // rename command check first - doesn't go to any AI
    const rename = Router.detectRename(text, nicknames);
    if (rename) {
      nicknames[rename.providerId] = rename.newNickname;
      await DB.setSetting('nicknames', nicknames);
      const saved = await DB.addMessage(this.currentSessionId, {
        role: 'system', content: `Got it - calling ${rename.providerId} "${rename.newNickname}" from now on.`
      });
      this.renderMessage(saved);
      this.refreshHeaderChips();
      return;
    }

    // mode-switch command check - e.g. "gemini can u go in research mode..."
    // switches the mode chip without needing to click it, and the message
    // still goes on to whichever AI it was addressed to.
    const modeCmd = Router.detectModeCommand(text);
    let modeSwitchedLabel = null;
    if (modeCmd) {
      const prevMode = await DB.getSetting('chatMode', 'normal');
      if (prevMode !== modeCmd) {
        await DB.setSetting('chatMode', modeCmd);
        modeSwitchedLabel = CHAT_MODES[modeCmd].label;
      }
    }

    // fold any pending attachment text into the outgoing message
    let composedText = text;
    const attachmentsToSave = this.pendingAttachments.slice();
    if (attachmentsToSave.length) {
      const extra = attachmentsToSave.map(a => a.text
        ? `\n\n[Attached: ${a.name}]\n${a.text}`
        : `\n\n[Attached image: ${a.name}]`).join('');
      composedText = (text ? text : `Here's what I attached - take a look.`) + extra;
    }
    this.pendingAttachments = [];
    document.getElementById('attachmentBar').innerHTML = '';
    document.getElementById('attachmentBar').classList.add('hidden');

    const userMsg = await DB.addMessage(this.currentSessionId, { role: 'user', content: composedText });
    this.renderMessage(userMsg);
    for (const a of attachmentsToSave) {
      await DB.addAttachment(this.currentSessionId, {
        messageId: userMsg.id, name: a.name, size: a.size, type: a.type,
        text: a.text || null, base64: a.keepRaw ? a.base64 : null
      });
    }

    const mode = this.manualTarget ? 'manual' : 'auto';
    const autoProviders = this.manualTarget ? [this.manualTarget] : await DB.getSetting('autoProviders', DEFAULT_AUTO_PROVIDERS);
    const { targets, isManualMention } = Router.resolveTargets(text, { nicknames, mode, autoProviders });

    // sticky auto-target: an explicit @mention/"hey X" becomes the new
    // default target so you don't have to keep repeating the name
    if (isManualMention) {
      this.manualTarget = targets[0];
    }
    if (isManualMention || modeSwitchedLabel) {
      this.refreshHeaderChips();
    }
    if (modeSwitchedLabel) {
      Toast.show(`Switched to ${modeSwitchedLabel} mode`);
    }

    const sharedMessages = await this.buildSharedContext();

    // attach real image data (not just a text label) to the last turn, for
    // whichever providers can actually see images (Gemini, Claude, and
    // vision-capable OpenAI-compatible models)
    const images = attachmentsToSave
      .filter(a => a.imageBase64)
      .map(a => {
        const [meta, data] = a.imageBase64.split(',');
        const mimeType = (meta.match(/data:(.*?);base64/) || [, 'image/png'])[1];
        return { mimeType, data };
      });
    if (images.length) {
      const lastUser = [...sharedMessages].reverse().find(m => m.role === 'user');
      if (lastUser) lastUser.images = images;
    }

    const targetChip = document.querySelector('[data-role="target"]');
    if (targetChip) targetChip.classList.add('busy');

    const responses = [];
    for (const providerId of targets) {
      const nickname = nicknames[providerId] || providerId;
      const thinkingEl = this.renderMessage({ role: 'ai', nickname, thinking: true });
      let finalText;
      try {
        const result = await Providers.chat(providerId, sharedMessages);
        finalText = result.error ? `(${nickname} error: ${result.message})` : this.stripNamePrefix(result.text);
      } catch (err) {
        finalText = `(${nickname} error: ${err.message || 'Something went wrong - try again.'})`;
      }
      thinkingEl.querySelector('.bubble').innerHTML = this.renderMarkdown(finalText);
      const saved = await DB.addMessage(this.currentSessionId, { role: 'ai', nickname, content: finalText });
      responses.push(finalText);
    }

    if (targetChip) targetChip.classList.remove('busy');

    if (responses.length > 1) {
      const match = this.roughlyAgree(responses[0], responses[1]);
      this.renderAgreementRow(match);
    }

    await this.renameSessionIfNeeded(text || composedText);
    await this.refreshUsageBar();
    renderIcons();
  },

  renderAgreementRow(match) {
    const logEl = document.getElementById('chatLog');
    const row = document.createElement('div');
    row.className = 'agree-row ' + (match ? 'match' : 'mismatch');
    row.innerHTML = `<i class="icon" data-icon="check"></i><span></span>`;
    row.querySelector('span').textContent = match ? 'Responses seem to agree' : 'Responses differ - worth a closer look';
    logEl.appendChild(row);
    renderIcons(row);
    if (!this.scrollLocked) logEl.scrollTop = logEl.scrollHeight;
  },

  roughlyAgree(a, b) {
    const words = s => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 4));
    const wa = words(a), wb = words(b);
    if (wa.size === 0 || wb.size === 0) return true;
    let overlap = 0;
    for (const w of wa) if (wb.has(w)) overlap++;
    return overlap / Math.min(wa.size, wb.size) > 0.25;
  },

  async renameSessionIfNeeded(firstUserText) {
    const sessions = await DB.listSessions();
    const current = sessions.find(s => s.id === this.currentSessionId);
    if (current && current.title === 'New session') {
      const shortTitle = firstUserText.slice(0, 40) + (firstUserText.length > 40 ? '...' : '');
      await DB.renameSession(this.currentSessionId, shortTitle);
      await this.renderSessionList(await DB.listSessions());
    }
  },

  // ---- rough client-side usage counter (not exact, just a heads-up) ----
  async refreshUsageBar() {
    const messages = await DB.listMessages(this.currentSessionId);
    const totalChars = messages.reduce((s, m) => s + (m.content ? m.content.length : 0), 0);
    const roughTokens = Math.round(totalChars / 4);
    const bar = document.getElementById('usageBar');
    bar.textContent = `~${roughTokens.toLocaleString()} tokens in this session (rough estimate)`;
    bar.classList.toggle('visible', roughTokens > 0);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
