const DEFAULT_KEYBINDS = {
  palette: 'ctrl+k',
  settings: 'ctrl+,',
  colorPalette: 'ctrl+shift+c',
  aiSelect: 'ctrl+shift+a',
  newSession: 'ctrl+shift+n',
  toggleSidebar: 'ctrl+b',
  modeMenu: 'ctrl+m',
  focusComposer: '/',
  toggleAuto: 'ctrl+shift+0',
  regenerateLast: 'alt+r',
  keybindSheet: 'ctrl+/',
  search: 'ctrl+shift+f',
  pinnedView: 'ctrl+shift+p'
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
  keybindSheet: 'Show this cheat-sheet',
  search: 'Search all sessions',
  pinnedView: 'Open pinned messages'
};

// Conservative, provider-aware ceilings for what we'll send in one request.
// Groq's oss-120b model hard-caps at 8000 tokens-per-minute on the free
// tier, which is what was actually breaking - these numbers leave headroom
// under each provider's real limit rather than trusting one global guess.
const PROVIDER_TOKEN_CEILING = {
  // Groq's 8000 TPM cap counts prompt + completion together, and the
  // Worker now always reserves 2200 of that for the reply. So the prompt
  // itself has to stay under 8000 - 2200 - a safety margin, not 7200 -
  // the old number let prompts through that would still blow the total
  // budget once the reply's own token cost was added on top.
  groq: 5400,
  gemini: 200000,
  openrouter: 6000,
  githubmodels: 7000,
  mistral: 26000,
  cerebras: 7200,
  nvidia: 26000,
  cloudflareai: 2600,
  ovhcloud: 6500,
  anthropic: 150000,
  openai: 100000,
  deepseek: 50000,
  default: 6000
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
  },
  outline: {
    label: 'Outline', glyph: '🗂️',
    desc: 'Turns the topic into a structured, hierarchical study outline - headers, subpoints, ready to expand on.',
    prompt: 'This is outline mode. Structure your answer as a clean hierarchical outline (numbered/lettered sections and sub-points), covering the topic\'s major areas and the key facts under each - not full prose paragraphs. Keep each point dense but short, like real study notes. If the person then asks to expand a specific point, answer that one in full prose.'
  },
  compare: {
    label: 'Compare', glyph: '⚖️',
    desc: 'Lays out multiple sides, approaches, or sources side by side - built for argument-mapping and lit-review style questions.',
    prompt: 'This is compare mode. For the question asked, identify the distinct positions, approaches, or sources relevant to it, and lay each one out with its core claim, its strongest supporting reasoning, and its main weakness or counterargument. End with a short neutral note on where genuine disagreement remains. Do not just pick a side - the point is mapping the landscape.'
  },
  explain: {
    label: 'Explain simply', glyph: '💡',
    desc: 'Plain-language explanation with a concrete analogy - for building intuition before the technical detail.',
    prompt: 'This is plain-explanation mode. Explain the concept in plain, everyday language, using one concrete analogy or example to build intuition first. Avoid jargon; if a technical term is unavoidable, define it in one clause inline. Keep it to a few short paragraphs - the goal is a solid mental model, not full technical completeness.'
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
    const repaired = this.sanitizeKeybinds(this.keybinds);
    if (repaired) {
      await DB.setSetting('customKeybinds', this.keybinds);
      Toast.show('Reset a keybind that had accidentally been bound to a plain typing key (e.g. an arrow key or Backspace) - that was breaking normal editing everywhere.');
      Logger.warn('keybinds', 'auto-repaired an unsafe binding on load');
    }

    this.wireSidebar();
    this.wireComposer();
    this.wireHeaderChip();
    this.wireScrollButton();
    this.wireGlobalKeys();
    this.wireProfileButton();
    this.wireMic();
    Providers.pingDevice();
    this.wireSidebarTools();
    await this.refreshHeaderChips();

    let sessions = await DB.listSessions();
    if (sessions.length === 0) {
      const s = await DB.createSession('New session');
      sessions = [s];
    }
    await this.renderSessionList(sessions);
    await this.openSession(sessions[0].id);

    await this.checkForSharedLink();
    this.checkDeploySync();

    renderIcons();
  },

  // Runs once per launch, doesn't block anything else. A stale Worker has
  // been the actual root cause behind several "the fix isn't working"
  // reports in this project - this turns that into something checkable
  // instead of guessable.
  async checkDeploySync() {
    const warning = await Providers.checkDeploySync();
    if (!warning) return;
    if (sessionStorage.getItem('deploySyncDismissed') === warning) return; // already acknowledged this exact mismatch this session
    const banner = document.createElement('div');
    banner.className = 'deploy-sync-banner';
    banner.innerHTML = `<span>${svgIcon('bolt')} ${this.escapeHtml(warning)}</span><i class="icon-btn" data-icon="x" title="Dismiss"></i>`;
    document.body.appendChild(banner);
    renderIcons(banner);
    banner.querySelector('[data-icon="x"]').addEventListener('click', () => {
      sessionStorage.setItem('deploySyncDismissed', warning);
      banner.remove();
    });
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

    // hover-to-peek while collapsed - doesn't un-pin, just previews.
    // The floating collapsed-star sits at nearly the same spot the real
    // sidebar star ends up once it peeks open on top of it - without
    // hiding it here, both rendered at once, which is exactly the
    // "stars overlap and get stuck" glitch.
    if (hoverZone) {
      hoverZone.addEventListener('mouseenter', () => {
        if (sidebar.classList.contains('collapsed')) {
          sidebar.classList.add('peek');
          starCollapsed.style.opacity = '0';
          starCollapsed.style.pointerEvents = 'none';
        }
      });
      sidebar.addEventListener('mouseleave', () => {
        sidebar.classList.remove('peek');
        if (sidebar.classList.contains('collapsed')) {
          starCollapsed.style.opacity = '1';
          starCollapsed.style.pointerEvents = 'auto';
        }
      });
    }

    document.getElementById('newSessionBtn').addEventListener('click', async () => {
      const s = await DB.createSession('New session');
      const sessions = await DB.listSessions();
      await this.renderSessionList(sessions);
      await this.openSession(s.id);
    });
    document.getElementById('openConsoleBtn').addEventListener('click', () => Console_.toggle());
  },

  wireProfileButton() {
    document.getElementById('profileBtn').addEventListener('click', () => this.openProfilePanel());
  },

  // ---- dedicated Profile panel (separate from Settings, like a chat app's
  // own profile screen) ----
  async openProfilePanel() {
    Settings.close();
    document.getElementById('overlay').classList.remove('hidden');
    document.getElementById('profilePanel').classList.remove('hidden');
    await this.renderProfilePanel();
  },
  closeProfilePanel() {
    const panel = document.getElementById('profilePanel');
    if (!panel) return;
    document.getElementById('overlay').classList.add('hidden');
    panel.classList.add('hidden');
  },
  async renderProfilePanel() {
    const profile = await DB.getSetting('profile', { name: '', profession: '', about: '' });
    const initials = (profile.name || 'You').trim().split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'Y';
    const panel = document.getElementById('profilePanel');
    panel.innerHTML = `
      <div class="settings-header">
        <span>Profile</span>
        <i class="icon-btn" data-icon="x" id="closeProfileBtn"></i>
      </div>
      <div class="settings-body">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar">${initials}</div>
          <div class="profile-avatar-name">${profile.name || 'Add your name'}</div>
          <div class="profile-avatar-sub">${profile.profession || 'no profession set'}</div>
        </div>
        <div class="settings-group">
          <div class="settings-row"><label>Name</label><input type="text" id="profileNameInput" value="${profile.name || ''}" placeholder="what should AIs call you?" /></div>
          <div class="settings-row"><label>Profession</label><input type="text" id="profileProfessionInput" value="${profile.profession || ''}" placeholder="e.g. college student, CS major" /></div>
          <div class="settings-row" style="align-items:flex-start">
            <label style="padding-top:6px">About</label>
            <textarea id="profileAboutInput" style="flex:1;min-height:80px;background:var(--bg-2);border:0.5px solid var(--line-strong);border-radius:8px;padding:8px 9px;font-size:13px;resize:vertical;font-family:inherit" placeholder="interests, current focus, how you like answers - anything worth an AI knowing">${profile.about || ''}</textarea>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin:2px 0 12px">Shared quietly with every AI you talk to here, so you never have to re-introduce yourself.</div>
          <button class="btn-primary-sm" id="saveProfileBtn">Save</button>
        </div>
        <button class="small-btn" id="openFullSettingsBtn">Open full Settings</button>
      </div>`;
    renderIcons(panel);
    document.getElementById('closeProfileBtn').addEventListener('click', () => this.closeProfilePanel());
    document.getElementById('openFullSettingsBtn').addEventListener('click', () => { this.closeProfilePanel(); Settings.open(); });
    document.getElementById('saveProfileBtn').addEventListener('click', async () => {
      const newProfile = {
        name: document.getElementById('profileNameInput').value.trim(),
        profession: document.getElementById('profileProfessionInput').value.trim(),
        about: document.getElementById('profileAboutInput').value.trim()
      };
      await DB.setSetting('profile', newProfile);
      Toast.show('Profile saved - every AI here will know this from now on.');
      this.renderProfilePanel();
    });
  },

  // ---- sidebar search + pinned-messages entry points ----
  wireSidebarTools() {
    const searchBtn = document.getElementById('sidebarSearchBtn');
    const pinnedBtn = document.getElementById('sidebarPinnedBtn');
    if (searchBtn) searchBtn.addEventListener('click', () => this.openSearch());
    if (pinnedBtn) pinnedBtn.addEventListener('click', () => this.openPinnedView());
  },

  escapeHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // ---- generic reusable modal box (search, pinned, format picker, the
  // context-compile warning) - reuses the command-palette's overlay/box
  // styling so no new chrome is needed for every little dialog ----
  openBox(innerHtml, opts) {
    const el = document.getElementById('genericModal');
    el.classList.remove('hidden');
    el.innerHTML = `<div class="palette-box ${opts && opts.wide ? 'wide' : ''}">${innerHtml}</div>`;
    if (!el.dataset.wired) {
      el.addEventListener('click', (ev) => {
        if (ev.target === el) { this.closeBox(); return; }
        const closeBtn = ev.target.closest('[data-close]');
        if (closeBtn) this.closeBox();
      });
      el.dataset.wired = '1';
    }
    return el.querySelector('.palette-box');
  },
  closeBox() {
    const el = document.getElementById('genericModal');
    el.classList.add('hidden');
    el.innerHTML = '';
    if (this._boxOnClose) {
      const cb = this._boxOnClose;
      this._boxOnClose = null;
      cb();
    }
  },

  async openSearch() {
    this.openBox(`
      <div class="palette-box-head"><span>Search all sessions</span><i class="icon-btn" data-icon="x" data-close></i></div>
      <input type="text" id="searchInput" placeholder="search your chats..." class="modal-search-input" />
      <div id="searchResults" class="modal-scroll-list"></div>
    `, { wide: true });
    renderIcons(document.getElementById('genericModal'));
    const input = document.getElementById('searchInput');
    input.focus();
    let debounce;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const hits = await DB.searchMessages(input.value);
        this.renderResultList('searchResults', hits, 'No matches yet.');
      }, 200);
    });
  },

  async openPinnedView() {
    this.openBox(`
      <div class="palette-box-head"><span>Pinned messages</span><i class="icon-btn" data-icon="x" data-close></i></div>
      <div id="pinnedList" class="modal-scroll-list"></div>
    `, { wide: true });
    renderIcons(document.getElementById('genericModal'));
    const pinned = await DB.listPinnedMessages();
    const sessions = await DB.listSessions();
    const titleById = {};
    sessions.forEach(s => titleById[s.id] = s.title);
    this.renderResultList('pinnedList', pinned.map(m => ({ ...m, sessionTitle: titleById[m.sessionId] || 'Session' })), 'Nothing pinned yet - hover a message and click the pin icon.');
  },

  renderResultList(elId, hits, emptyMsg) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!hits.length) { el.innerHTML = `<div class="modal-empty">${emptyMsg}</div>`; return; }
    el.innerHTML = hits.map(h => `
      <div class="palette-item" data-session="${h.sessionId}" data-msg="${h.id}" style="align-items:flex-start">
        <span style="display:block;min-width:0">
          <span style="display:block;font-size:11px;color:var(--text-muted)">${this.escapeHtml(h.sessionTitle)} &middot; ${this.escapeHtml(h.nickname || (h.role === 'user' ? 'You' : ''))}</span>
          <span style="display:block;font-size:12.5px;white-space:normal;overflow-wrap:anywhere">${this.escapeHtml((h.content || '').slice(0, 160))}</span>
        </span>
      </div>`).join('');
    el.querySelectorAll('.palette-item').forEach(row => {
      row.addEventListener('click', async () => {
        this.closeBox();
        await this.openSession(row.dataset.session);
        setTimeout(() => {
          const target = document.querySelector(`[data-message-id="${row.dataset.msg}"]`);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('flash-highlight');
            setTimeout(() => target.classList.remove('flash-highlight'), 1600);
          }
        }, 150);
      });
    });
  },

  openFormatPicker(onPick) {
    this.openBox(`
      <div class="palette-box-head"><span>Export as</span><i class="icon-btn" data-icon="x" data-close></i></div>
      ${['txt', 'md', 'pdf', 'docx'].map(f => `<div class="palette-item" data-fmt="${f}">${svgIcon('doc')} <span>.${f}</span></div>`).join('')}
    `);
    const el = document.getElementById('genericModal');
    renderIcons(el);
    el.querySelectorAll('[data-fmt]').forEach(row => {
      row.addEventListener('click', () => { this.closeBox(); onPick(row.dataset.fmt); });
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
      starCollapsed.style.opacity = '1';
      starCollapsed.style.pointerEvents = 'auto';
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
      row.innerHTML = `<span style="opacity:0.95;display:inline-flex;color:${providerColor(id)}">${providerIconHTML(id, 15)}</span><span>${nicknames[id] || providerDefs[id].label}</span><span style="margin-left:auto;font-size:10px;color:var(--text-muted)">${i < 9 ? 'Ctrl+' + (i + 1) : ''}</span>`;
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
      ? `<span style="margin-right:5px;display:inline-flex;vertical-align:-2px;color:${providerColor(this.manualTarget)}">${providerIconHTML(this.manualTarget, 13)}</span>`
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
        const genericModal = document.getElementById('genericModal');
        const fileViewerModal = document.getElementById('fileViewerModal');
        const anyMenu = document.getElementById('modeDropdown') || document.getElementById('modeSelectDropdown') || document.getElementById('sessionMenu') || document.getElementById('verifyMenu');
        if (fileViewerModal && !fileViewerModal.classList.contains('hidden')) { FileViewer.close(); return; }
        if (genericModal && !genericModal.classList.contains('hidden')) { this.closeBox(); return; }
        if (palette && !palette.classList.contains('hidden')) { this.closeCommandPalette(); return; }
        if (anyMenu) { anyMenu.remove(); return; }
        const settingsPanel = document.getElementById('settingsPanel');
        if (settingsPanel && !settingsPanel.classList.contains('hidden')) { Settings.close(); return; }
        const profilePanel = document.getElementById('profilePanel');
        if (profilePanel && !profilePanel.classList.contains('hidden')) { this.closeProfilePanel(); return; }
        return;
      }

      // Ctrl/Cmd +, -, 0 - font-size zoom, same convention as every browser.
      // Works everywhere, not just in Settings, and keeps Settings' own
      // font-size buttons in sync if that panel happens to be open.
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+' || e.code === 'Equal')) {
        e.preventDefault(); this.zoomFont(1); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.code === 'Minus')) {
        e.preventDefault(); this.zoomFont(-1); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault(); this.zoomFont(0, true); return;
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
      if (combo === this.keybinds.search) { e.preventDefault(); this.openSearch(); return; }
      if (combo === this.keybinds.pinnedView) { e.preventDefault(); this.openPinnedView(); return; }
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

  // Ctrl+Plus/Minus/0 handler - reads the live CSS var so it stacks correctly
  // no matter what size Settings last saved, clamps to a sane range, and
  // keeps Settings' own font-size buttons showing the right state if open.
  async zoomFont(step, reset) {
    const DEFAULT_SIZE = 15;
    const MIN_SIZE = 12, MAX_SIZE = 26;
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--app-font-size'), 10) || DEFAULT_SIZE;
    const next = reset ? DEFAULT_SIZE : Math.max(MIN_SIZE, Math.min(MAX_SIZE, current + step));
    document.documentElement.style.setProperty('--app-font-size', next + 'px');
    await DB.setSetting('fontSize', next);
    Toast.show(reset ? `Font size reset to ${next}px` : `Font size: ${next}px`);
    const settingsPanel = document.getElementById('settingsPanel');
    if (settingsPanel && !settingsPanel.classList.contains('hidden')) Settings.render();
  },

  // Deletes a single message: gone from the DOM, gone from IndexedDB, gone
  // from attachments, and therefore gone from context on the next send
  // (buildSharedContext reads straight from DB - nothing to separately
  // scrub, there's no other copy anywhere since the Worker never stores
  // chat content). No confirm dialog for a single message - same as most
  // chat apps - but it's an instant, real delete, not a soft-hide.
  async confirmDeleteMessage(id, wrapEl) {
    if (!id) return;
    await DB.deleteMessage(id);
    wrapEl.style.transition = 'opacity 0.15s ease';
    wrapEl.style.opacity = '0';
    setTimeout(() => wrapEl.remove(), 150);
    Toast.show('Message deleted');
  },

  // Keys that must never be bound WITHOUT a modifier held - these are core
  // editing keys. A bare binding on any of these (which could previously
  // happen by accident mid-rebind) would silently eat that key everywhere,
  // including while typing in the composer - that was the "arrow keys /
  // backspace / select-all stopped working" bug. focusComposer's default
  // ("/") is the one deliberate exception, since it's guarded separately
  // to only fire when you're NOT already typing.
  RESERVED_NO_MODIFIER_KEYS: new Set([
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace', 'delete',
    'tab', 'enter', 'escape', 'pageup', 'pagedown', 'home', 'end', ' ', 'capslock'
  ]),

  isUnsafeCombo(combo, allowBareSlash) {
    if (!combo) return true;
    const hasModifier = /(^|\+)(ctrl|alt|shift)(\+|$)/.test(combo);
    if (hasModifier) return false;
    if (allowBareSlash && combo === '/') return false;
    const key = combo.split('+').pop();
    return this.RESERVED_NO_MODIFIER_KEYS.has(key) || /^[a-z0-9]$/.test(key);
  },

  // Returns true if anything was fixed (caller persists + notifies).
  sanitizeKeybinds(keybinds) {
    let fixed = false;
    for (const action of Object.keys(DEFAULT_KEYBINDS)) {
      const allowBare = action === 'focusComposer';
      if (this.isUnsafeCombo(keybinds[action], allowBare)) {
        keybinds[action] = DEFAULT_KEYBINDS[action];
        fixed = true;
      }
    }
    return fixed;
  },

  // Loose heuristic, not a classifier - false positives just show a hint
  // you can ignore, false negatives just mean no hint. Good enough for
  // "should I offer to help rephrase" without needing another API call.
  looksLikeRefusal(text) {
    if (!text || text.length > 900) return false; // long substantive answers are never refusals
    const t = text.toLowerCase();
    const signals = [
      "i can't help with that", "i cannot help with that", "i'm not able to help",
      "i won't be able to", "i can't provide", "i cannot provide", "i can't assist",
      "against my guidelines", "i'm not comfortable", "i must decline", "i have to decline",
      "i'm unable to", "i am unable to", "as an ai, i cannot", "i don't feel comfortable",
      "i can't write", "i cannot write", "i can't generate", "i cannot generate"
    ];
    return signals.some(s => t.includes(s));
  },

  // Not a bypass: this never resends automatically, never wraps your
  // message in anything, and never argues with the model. It just prefills
  // the composer with your same question restructured to be more specific
  // and better-contextualized - which is genuinely what usually turns a
  // vague refusal into a real answer for legitimate research questions.
  // If a refusal is about something that's actually restricted, being more
  // specific won't change that, and this doesn't try to make it.
  attachAskDifferentWayHint(msgEl, originalText) {
    const bubble = msgEl.querySelector('.bubble');
    if (!bubble || msgEl.querySelector('.ask-different-hint')) return;
    const hint = document.createElement('div');
    hint.className = 'ask-different-hint';
    hint.innerHTML = `${svgIcon('sparkles')} <span>That reads like a refusal - <button type="button" class="link-btn" id="askDiffBtn">ask a different way</button></span>`;
    bubble.after(hint);
    hint.querySelector('#askDiffBtn').addEventListener('click', () => this.openAskDifferentWayMenu(originalText));
  },

  openAskDifferentWayMenu(originalText) {
    const options = [
      { label: 'Add why you\'re asking', build: (t) => `For a research/study purpose - ${t}` },
      { label: 'Ask for the general mechanism, not a specific case', build: (t) => `What's the general principle or mechanism behind: ${t}` },
      { label: 'Narrow it to the exact sub-question', build: (t) => `${t}\n\n(Specifically, I'm asking about the underlying concept, not asking you to do anything harmful with it.)` }
    ];
    const box = this.openBox(`
      <div class="palette-box-head">
        <span>Ask a different way</span>
        <i class="icon-btn" data-icon="x" data-close></i>
      </div>
      <div style="font-size:12px;color:var(--text-muted);padding:6px 10px 10px">
        This rewrites your question to be clearer about intent and more specific - it doesn't try to trick the model, and a genuine safety refusal will still hold. Pick one to load it into the composer, then edit before sending.
      </div>
      ${options.map((o, i) => `<div class="palette-item" data-idx="${i}">${svgIcon('edit')} <span>${o.label}</span></div>`).join('')}
    `);
    renderIcons(box);
    box.querySelectorAll('[data-idx]').forEach(item => {
      item.addEventListener('click', () => {
        const opt = options[Number(item.dataset.idx)];
        const input = document.getElementById('messageInput');
        input.value = opt.build(originalText || '');
        input.focus();
        this.autoResizeComposer && this.autoResizeComposer();
        this.closeBox();
      });
    });
  },

  // The composer grows to fit multi-line text, up to the CSS max-height
  // (160px) then scrolls internally. This is a real shared method (used
  // to just be inlined in the 'input' listener) specifically so code that
  // fills the box programmatically - "ask a different way", renames, etc -
  // can trigger the same resize instead of leaving a cramped single line.
  autoResizeComposer() {
    const input = document.getElementById('messageInput');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
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
        <div class="palette-item" data-action="search">${svgIcon('search')} <span>Search all sessions</span></div>
        <div class="palette-item" data-action="pinned">${svgIcon('pin')} <span>Pinned messages</span></div>
        <div class="palette-item" data-action="keybinds">${svgIcon('key')} <span>Keybinds cheat-sheet</span></div>
      </div>`;
    el.querySelectorAll('.palette-item').forEach(item => {
      item.addEventListener('click', () => {
        const a = item.dataset.action;
        this.closeCommandPalette();
        if (a === 'settings') Settings.open();
        if (a === 'ai') this.openAiSelectMenu();
        if (a === 'palette') { Settings.open(); }
        if (a === 'search') this.openSearch();
        if (a === 'pinned') this.openPinnedView();
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
          if (this.isUnsafeCombo(combo, key === 'focusComposer')) {
            Toast.show('That needs Ctrl, Alt, or Shift held with it - plain letters, arrows, Backspace, Tab, etc. have to stay free for normal typing.', true);
            document.removeEventListener('keydown', capture, true);
            this.openKeybindSheet();
            return;
          }
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
        ${s.pinned ? `<i class="session-pin-badge">${svgIcon('pinFilled', 11)}</i>` : ''}
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

    const sessions = await DB.listSessions();
    const session = sessions.find(s => s.id === sessionId);

    const menu = document.createElement('div');
    menu.id = 'sessionMenu';
    menu.className = 'floating-menu';
    menu.innerHTML = `
      <div class="palette-item" data-act="rename">${svgIcon('edit')} <span>Rename</span></div>
      <div class="palette-item" data-act="pin">${svgIcon(session && session.pinned ? 'pinFilled' : 'pin')} <span>${session && session.pinned ? 'Unpin' : 'Pin'} session</span></div>
      <div class="palette-item" data-act="branch">${svgIcon('share')} <span>Branch from here</span></div>
      <div class="palette-item" data-act="export">${svgIcon('doc')} <span>Export as study notes</span></div>
      <div class="palette-item" data-act="share">${svgIcon('share')} <span>Share (continue on another device)</span></div>
      <div class="palette-item" data-act="delete" style="color:#d98a5f">${svgIcon('trash')} <span>Delete</span></div>
    `;
    document.body.appendChild(menu);
    renderIcons(menu);
    this.positionFloatingMenu(menu, anchorEl);

    menu.querySelector('[data-act="rename"]').addEventListener('click', async () => {
      menu.remove();
      const current = sessions.find(s => s.id === sessionId);
      this.startInlineRename(sessionId, current ? current.title : '');
    });
    menu.querySelector('[data-act="pin"]').addEventListener('click', async () => {
      menu.remove();
      await DB.togglePinSession(sessionId);
      await this.renderSessionList(await DB.listSessions());
    });
    menu.querySelector('[data-act="export"]').addEventListener('click', async () => {
      menu.remove();
      const messages = await DB.listMessages(sessionId);
      this.openFormatPicker(async (fmt) => {
        try {
          await Exporter.downloadSession(session ? session.title : 'session', messages, fmt);
          Toast.show(`Exported .${fmt}`);
        } catch (err) {
          Toast.show('Could not export: ' + err.message, true);
        }
      });
    });
    menu.querySelector('[data-act="branch"]').addEventListener('click', async () => {
      menu.remove();
      await this.branchSession(sessionId);
    });
    menu.querySelector('[data-act="share"]').addEventListener('click', async () => {
      menu.remove();
      await this.shareSession(sessionId);
    });
    menu.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      menu.remove();
      await DB.deleteSession(sessionId);
      const remaining = await DB.listSessions();
      if (remaining.length === 0) { const s = await DB.createSession('New session'); remaining.push(s); }
      await this.renderSessionList(remaining);
      if (sessionId === this.currentSessionId) await this.openSession(remaining[0].id);
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
      wrap.dataset.messageId = m.id || '';
      wrap.innerHTML = `
        <div class="bubble"></div>
        <div class="msg-actions">
          <i class="icon-btn" data-icon="copy" title="Copy" data-act="copy"></i>
          <i class="icon-btn" data-icon="${m.pinned ? 'pinFilled' : 'pin'}" title="${m.pinned ? 'Unpin' : 'Pin'}" data-act="pin"></i>
          <i class="icon-btn" data-icon="trash" title="Delete" data-act="delete"></i>
        </div>`;
      // displayText is what actually shows - older messages saved before
      // this existed fall back to full content so nothing goes blank.
      const shown = m.displayText != null ? m.displayText : m.content;
      const bubbleEl = wrap.querySelector('.bubble');
      if (shown) bubbleEl.textContent = shown;
      if (m.attachmentMeta && m.attachmentMeta.length) {
        const chipRow = document.createElement('div');
        chipRow.className = 'msg-file-chips';
        m.attachmentMeta.forEach(att => {
          const chip = document.createElement('div');
          chip.className = 'msg-file-chip';
          chip.innerHTML = `${svgIcon(FileHandler.isImageType(att.type) ? 'image' : 'doc')} <span>${att.name}</span>`;
          chip.title = 'Click to view';
          chip.addEventListener('click', () => FileViewer.open(att.id));
          chipRow.appendChild(chip);
        });
        bubbleEl.after(chipRow);
      }
      wrap.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(shown || m.content); Toast.show('Copied'); }
        catch (e) { Toast.show('Could not copy', true); }
      });
      const pinBtn = wrap.querySelector('[data-act="pin"]');
      pinBtn.addEventListener('click', async () => {
        if (!m.id) return;
        const nowPinned = await DB.togglePinMessage(m.id);
        m.pinned = nowPinned;
        pinBtn.dataset.icon = nowPinned ? 'pinFilled' : 'pin';
        pinBtn.title = nowPinned ? 'Unpin' : 'Pin';
        pinBtn.innerHTML = svgIcon(nowPinned ? 'pinFilled' : 'pin');
        Toast.show(nowPinned ? 'Pinned' : 'Unpinned');
      });
      wrap.querySelector('[data-act="delete"]').addEventListener('click', () => this.confirmDeleteMessage(m.id, wrap));
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
          <i class="icon-btn" data-icon="${m.pinned ? 'pinFilled' : 'pin'}" title="${m.pinned ? 'Unpin' : 'Pin'}" data-act="pin"></i>
          <i class="icon-btn" data-icon="download" title="Download" data-act="download"></i>
          <i class="icon-btn" data-icon="trash" title="Delete" data-act="delete"></i>
        </div>`;
      wrap.querySelector('.msg-label').textContent = m.nickname || 'AI';
      wrap.querySelector('.bubble').innerHTML = m.thinking
        ? `<span class="typing-dots"><span></span><span></span><span></span></span>`
        : this.renderMarkdown(m.content || '');
      wrap.dataset.messageId = m.id || '';
      wrap.dataset.providerNickname = m.nickname || '';

      // per-provider color accent, so it's easier to tell at a glance who
      // said what without reading the label every time
      const pid = this.findProviderIdByNickname((m.nickname || '').replace(/\s*\(verifying\)$/, ''));
      if (pid && typeof providerColor === 'function') {
        wrap.style.setProperty('--msg-accent', providerColor(pid));
        wrap.classList.add('has-accent');
      }

      wrap.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(m.content); Toast.show('Copied'); }
        catch (e) { Toast.show('Could not copy', true); }
      });
      wrap.querySelector('[data-act="regen"]').addEventListener('click', () => this.regenerate(m));
      wrap.querySelector('[data-act="verify"]').addEventListener('click', (e) => this.openVerifyMenu(m, e.target));
      const pinBtn = wrap.querySelector('[data-act="pin"]');
      pinBtn.addEventListener('click', async () => {
        if (!m.id) return;
        const nowPinned = await DB.togglePinMessage(m.id);
        m.pinned = nowPinned;
        pinBtn.dataset.icon = nowPinned ? 'pinFilled' : 'pin';
        pinBtn.title = nowPinned ? 'Unpin' : 'Pin';
        pinBtn.innerHTML = svgIcon(nowPinned ? 'pinFilled' : 'pin');
        Toast.show(nowPinned ? 'Pinned' : 'Unpinned');
      });
      wrap.querySelector('[data-act="download"]').addEventListener('click', (e) => this.openMessageDownloadMenu(m, e.target));
      wrap.querySelector('[data-act="delete"]').addEventListener('click', () => this.confirmDeleteMessage(m.id, wrap));
    }
    logEl.appendChild(wrap);
    if (!this.scrollLocked) logEl.scrollTop = logEl.scrollHeight;
    renderIcons(wrap);
    return wrap;
  },

  // Shared by every floating menu (AI-select, mode, session ⋯, download,
  // verify) - measures the menu after it's in the DOM, then clamps so it
  // can never render partway off any edge of the screen. Previously each
  // menu positioned itself with plain rect.left/rect.bottom and no clamping
  // at all, which is what made the download menu run off-screen.
  positionFloatingMenu(menu, anchorEl, opts) {
    const rect = anchorEl.getBoundingClientRect();
    const margin = 8;
    const alignRight = opts && opts.alignRight;
    menu.style.position = 'fixed';
    menu.style.visibility = 'hidden';
    if (!menu.parentElement) document.body.appendChild(menu);
    const menuW = menu.offsetWidth;
    const menuH = menu.offsetHeight;
    let left = alignRight ? rect.right - menuW : rect.left;
    let top = rect.bottom + 4;
    // The composer bar sits inside the normal document flow, not as an
    // overlay - so "does this fit in window.innerHeight" isn't the real
    // question near the bottom of a chat. A menu could fit the raw
    // viewport and still land right under the composer, covering it.
    // Use whichever boundary is actually closer: the window edge, or the
    // composer's own top edge.
    const composerEl = document.getElementById('composer');
    const composerTop = composerEl ? composerEl.getBoundingClientRect().top : window.innerHeight;
    const effectiveFloor = Math.min(window.innerHeight, composerTop) - margin;
    if (left + menuW > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - menuW - margin);
    if (left < margin) left = margin;
    if (top + menuH > effectiveFloor) top = Math.max(margin, rect.top - menuH - 4);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.visibility = 'visible';
  },

  openMessageDownloadMenu(msg, anchorEl) {
    const menu = document.createElement('div');
    menu.className = 'floating-menu';
    ['txt', 'md', 'pdf', 'docx'].forEach(fmt => {
      const row = document.createElement('div');
      row.className = 'palette-item';
      row.innerHTML = `${svgIcon('doc')} <span>Download .${fmt}</span>`;
      row.addEventListener('click', async () => {
        menu.remove();
        try { await Exporter.downloadMessage(msg, fmt); Toast.show(`Downloaded .${fmt}`); }
        catch (e) { Toast.show('Could not export: ' + e.message, true); }
      });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    renderIcons(menu);
    this.positionFloatingMenu(menu, anchorEl);

    setTimeout(() => {
      document.addEventListener('click', function closeOnce(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closeOnce); }
      });
    }, 0);
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
    Object.keys(providerDefs).forEach(id => {
      if (nicknames[id] === originalMsg.nickname) return;
      const row = document.createElement('div');
      row.className = 'palette-item';
      row.innerHTML = `<span style="display:inline-flex">${providerIconHTML(id, 14)}</span><span>Ask ${nicknames[id] || providerDefs[id].label} to verify</span>`;
      row.addEventListener('click', () => { menu.remove(); this.verifyWith(id, originalMsg); });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    this.positionFloatingMenu(menu, anchorEl);
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
    const msgObj = { role: 'ai', nickname: verifierLabel, thinking: true };
    const thinkingEl = this.renderMessage(msgObj);
    const prompt = [
      { role: 'system', content: 'You are fact-checking another AI\'s answer. Say clearly whether it looks correct, and note any mistakes or missing context. Be concise.' },
      { role: 'user', content: `Here is an AI's answer to review:\n\n[${originalMsg.nickname}]: ${originalMsg.content}\n\nIs this correct? Point out anything wrong or missing.` }
    ];
    let finalText, isError = false;
    try {
      const result = await Providers.chat(providerId, prompt);
      if (result.error) { isError = true; finalText = `(verification failed: ${result.message})`; }
      else finalText = result.text;
    } catch (err) {
      isError = true;
      finalText = `(verification failed: ${err.message || 'Something went wrong - try again.'})`;
    }
    thinkingEl.querySelector('.bubble').innerHTML = this.renderMarkdown(finalText);
    const saved = await DB.addMessage(this.currentSessionId, { role: 'ai', nickname: verifierLabel, content: finalText, isError });
    msgObj.content = finalText; msgObj.id = saved.id; msgObj.isError = isError; msgObj.thinking = false;
    thinkingEl.dataset.messageId = saved.id;
  },

  async regenerate(originalMsg) {
    const providerId = this.findProviderIdByNickname(originalMsg.nickname);
    if (!providerId) { Toast.show('Could not tell which AI this was', true); return; }
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const sharedMessages = await this.buildSharedContext();
    const msgObj = { role: 'ai', nickname: originalMsg.nickname, thinking: true };
    const thinkingEl = this.renderMessage(msgObj);
    let finalText, isError = false;
    try {
      const result = await Providers.chat(providerId, sharedMessages);
      if (result.error) { isError = true; finalText = `(${originalMsg.nickname} error: ${result.message})`; }
      else finalText = this.stripNamePrefix(result.text);
    } catch (err) {
      isError = true;
      finalText = `(${originalMsg.nickname} error: ${err.message || 'Something went wrong - try again.'})`;
    }
    thinkingEl.querySelector('.bubble').innerHTML = this.renderMarkdown(finalText);
    const saved = await DB.addMessage(this.currentSessionId, { role: 'ai', nickname: originalMsg.nickname, content: finalText, isError });
    msgObj.content = finalText; msgObj.id = saved.id; msgObj.isError = isError; msgObj.thinking = false;
    thinkingEl.dataset.messageId = saved.id;
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

    input.addEventListener('input', () => this.autoResizeComposer());
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
      this.autoResizeComposer();
      await this.handleSend(text);
    });

    document.getElementById('fileInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length === 0) return;

      const { readable, rejected } = await FileHandler.filterUnreadable(files);
      if (rejected.length) {
        Toast.show(`Can't attach ${rejected.join(', ')} - looks like a binary/executable format, not readable text or a document.`, true);
        Logger.warn('files', `rejected unreadable file(s): ${rejected.join(', ')}`);
      }
      if (!readable.length) return;

      const existingBytes = this.pendingAttachments.reduce((s, a) => s + (a.size || 0), 0);
      const check = FileHandler.validateBatch(readable, existingBytes);
      if (!check.ok) { Toast.show(check.message, true); return; }
      if (check.warnFiles && check.warnFiles.length) {
        Toast.show(`Heads up - ${check.warnFiles.join(', ')} ${check.warnFiles.length > 1 ? 'are' : 'is'} large and may take a moment to extract.`);
      }

      for (const file of readable) {
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
      if (readable.some(f => FileHandler.isImage(f))) {
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
    // failed replies (the Groq-style error bubbles) are kept visible in the
    // log but never resent as context - that's what was making every retry
    // bigger than the last
    const visibleHistory = history.filter(m => !m.isError);

    // if this session's been compiled, only the turns AFTER the compile
    // point go in raw - everything before is replaced by the dense recap.
    // Nothing is deleted: the full original history is still what's on
    // screen and what exports/search see.
    const compiled = await DB.getSetting(`compiledContext:${this.currentSessionId}`, null);
    let usable = visibleHistory;
    let recapMessage = null;
    if (compiled && compiled.recap) {
      // Normal in-place compile: only cut everything up to the compiled
      // point, keep newer turns raw. A branch seed has no uptoMessageId
      // (the branch has no "old" messages of its own yet) - in that case
      // the recap still applies, just without slicing anything away.
      if (compiled.uptoMessageId) {
        const cutIdx = visibleHistory.findIndex(m => m.id === compiled.uptoMessageId);
        if (cutIdx > -1) usable = visibleHistory.slice(cutIdx + 1);
      }
      recapMessage = {
        role: 'system',
        content: `Compact recap of earlier conversation (older turns condensed to save space - every fact/name/number was kept, only filler was cut):\n${compiled.recap}`
      };
    }

    const sharedMessages = usable.map(m => {
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
    if (recapMessage) sharedMessages.splice(1, 0, recapMessage);
    return sharedMessages;
  },

  // Rough token estimate for a full outgoing request. Chars/3.3 tracks real
  // tokenizers noticeably closer than the old chars/4 guess (which is why
  // the usage bar used to read ~3.8k while the actual request was 12k+),
  // plus a flat per-image allowance and a little structural overhead.
  estimateMessagesTokens(messages, imageCount) {
    let chars = 0;
    for (const m of messages) chars += (m.content || '').length;
    let tokens = Math.ceil(chars / 3.3);
    tokens += (imageCount || 0) * 300;
    tokens += 60;
    return tokens;
  },

  // Picks who compiles an oversized session: first provider in priority
  // order (skipping whichever provider is the one that's over its limit)
  // that actually has a healthy key right now - or no key needed at all,
  // for Cloudflare AI.
  // minContentTokens (optional): if given, prefers a candidate whose
  // ceiling comfortably fits the content, ranked by ceiling size - not
  // just "first one in a fixed list with a working key". That fixed-order
  // approach is exactly what was sending compile jobs to Groq (the
  // SMALLEST ceiling of any provider) whenever it happened to be the only
  // other key configured, guaranteeing a "request too large" failure on
  // anything but a tiny conversation. If nothing fits, still returns the
  // biggest-ceiling option available so the caller can chunk it instead.
  async pickCompilerProvider(excludeId, minContentTokens) {
    let providerDefs, keyInfo;
    try {
      providerDefs = await Providers.list();
      keyInfo = await Providers.getKeyInfo();
    } catch (e) { return null; }
    const candidates = [];
    for (const id of COMPILE_PROVIDER_PRIORITY) {
      if (id === excludeId || !providerDefs[id]) continue;
      const isCf = providerDefs[id].kind === 'cloudflare-ai';
      const hasKey = isCf || (keyInfo[id] && keyInfo[id].keys && keyInfo[id].keys.some(k => !k.resting));
      if (!hasKey) continue;
      candidates.push({ id, ceiling: PROVIDER_TOKEN_CEILING[id] || PROVIDER_TOKEN_CEILING.default });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.ceiling - a.ceiling);
    if (minContentTokens) {
      const fits = candidates.find(c => c.ceiling > minContentTokens + 900);
      if (fits) return fits.id;
    }
    return candidates[0].id;
  },

  // Shared by compileContext and branchSession - actually respects the
  // chosen provider's own ceiling instead of firing one giant prompt and
  // hoping. If the content is too big for a single pass, it chunks the
  // conversation, compiles each piece, then merges the partial recaps
  // (recursing once more if even the merged summaries are still too big).
  async compileFlattenedText(providerId, flattenedText) {
    const ceiling = PROVIDER_TOKEN_CEILING[providerId] || PROVIDER_TOKEN_CEILING.default;
    const systemPrompt = 'You compress conversation history for reuse as context. Preserve every fact, name, number, date, decision, and specific detail - never summarize away anything concrete. Only strip conversational filler, repeated pleasantries, and back-and-forth phrasing. Output dense prose or tight bullet points, no preamble like "here is a summary".';
    // leave headroom for the instructions themselves + the reply budget
    const budgetForContent = Math.max(600, ceiling - 900);
    const approxCharsPerChunk = Math.floor(budgetForContent * 3.3);

    const runOne = async (text, isPartial) => {
      const prompt = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${isPartial ? 'Compile this PART of a longer conversation (it will be merged with other parts after)' : 'Compile this conversation'} into a complete, lossless-but-compact recap:\n\n${text}` }
      ];
      const result = await Providers.chat(providerId, prompt);
      if (result.error) throw new Error(result.message);
      return result.text;
    };

    if (flattenedText.length <= approxCharsPerChunk) {
      return await runOne(flattenedText, false);
    }

    const chunks = [];
    for (let i = 0; i < flattenedText.length; i += approxCharsPerChunk) {
      chunks.push(flattenedText.slice(i, i + approxCharsPerChunk));
    }
    const partials = [];
    for (const chunk of chunks) partials.push(await runOne(chunk, true));
    const combined = partials.join('\n\n---\n\n');
    if (combined.length > approxCharsPerChunk) {
      return await this.compileFlattenedText(providerId, combined); // compress the summaries themselves
    }
    return await runOne(combined, false);
  },

  // A branch shares compiled context with its parent up to the moment of
  // branching (compiled, not verbatim - see compileContext's comment on
  // why "every word, fewer tokens" can't both be literally true for what
  // gets SENT to an AI; what's stored locally is untouched either way,
  // full original session stays exactly where it was, still exportable).
  // After that point the two sessions are completely independent - a wall,
  // same as any two unrelated sessions.
  async branchSession(sessionId) {
    const history = await DB.listMessages(sessionId);
    const visible = history.filter(m => !m.isError && m.role !== 'system');
    if (!visible.length) { Toast.show('Nothing to branch yet - this session is empty.'); return; }

    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const flattened = visible.map(m => `${m.role === 'user' ? 'User' : (m.nickname || 'AI')}: ${m.content}`).join('\n\n');
    const estimate = this.estimateMessagesTokens([{ content: flattened }], 0);

    const compilerId = await this.pickCompilerProvider(null, estimate);
    if (!compilerId) {
      Toast.show('No AI has a working key free right now to compile the branch context.', true);
      return;
    }
    const compilerCeiling = PROVIDER_TOKEN_CEILING[compilerId] || PROVIDER_TOKEN_CEILING.default;
    const willChunk = estimate > compilerCeiling - 900;
    Toast.show(willChunk
      ? `Branching - compiling with ${nicknames[compilerId] || compilerId} in pieces, this'll take a couple passes...`
      : `Branching - compiling shared context with ${nicknames[compilerId] || compilerId}...`);
    let recap;
    try {
      recap = await this.compileFlattenedText(compilerId, flattened);
    } catch (e) {
      Toast.show('Branch failed: ' + (e.message || 'unknown error'), true);
      return;
    }
    const reviewed = await this.reviewRecap(recap, visible.length);
    if (reviewed === null) { Toast.show('Branch cancelled - nothing changed.'); return; }

    const sessions = await DB.listSessions();
    const origSession = sessions.find(s => s.id === sessionId);
    const branch = await DB.createSession((origSession ? origSession.title : 'Session') + ' (branch)');
    await DB.setSetting(`branchParent:${branch.id}`, sessionId);
    await DB.addMessage(branch.id, {
      role: 'system',
      content: `Branched from "${origSession ? origSession.title : 'a previous session'}". Shared context up to this point is compiled below - the two sessions evolve independently from here on, nothing further crosses over either way.`
    });
    await DB.setSetting(`compiledContext:${branch.id}`, { uptoMessageId: null, recap: reviewed, compiledAt: Date.now(), compiledBy: compilerId, isBranchSeed: true });
    await this.renderSessionList(await DB.listSessions());
    await this.openSession(branch.id);
    Toast.show('Branch created - shares everything up to now, independent from here.');
  },

  async compileContext(excludeProviderId) {
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const history = await DB.listMessages(this.currentSessionId);
    const visible = history.filter(m => !m.isError && m.role !== 'system');
    const keepTailCount = 6; // most recent turns stay verbatim, only older ones get compiled
    const older = visible.slice(0, Math.max(0, visible.length - keepTailCount));
    if (!older.length) {
      Toast.show('Not enough history yet to compile.');
      return false;
    }
    const flattened = older.map(m => `${m.role === 'user' ? 'User' : (m.nickname || 'AI')}: ${m.content}`).join('\n\n');
    const estimate = this.estimateMessagesTokens([{ content: flattened }], 0);

    const compilerId = await this.pickCompilerProvider(excludeProviderId, estimate);
    if (!compilerId) {
      Toast.show('No other AI has a working key free right now to compile with - starting a new session might be quicker.', true);
      return false;
    }
    const compilerCeiling = PROVIDER_TOKEN_CEILING[compilerId] || PROVIDER_TOKEN_CEILING.default;
    const willChunk = estimate > compilerCeiling - 900;
    Toast.show(willChunk
      ? `Compiling with ${nicknames[compilerId] || compilerId} in pieces - this session's grown large enough that it needs a couple of passes...`
      : `Compiling with ${nicknames[compilerId] || compilerId}...`);
    let recap;
    try {
      recap = await this.compileFlattenedText(compilerId, flattened);
    } catch (e) {
      Toast.show('Compile failed: ' + (e.message || 'unknown error'), true);
      return false;
    }
    const reviewed = await this.reviewRecap(recap, older.length);
    if (reviewed === null) { Toast.show('Compile cancelled - nothing changed.'); return false; }
    const lastKeptId = older[older.length - 1].id;
    await DB.setSetting(`compiledContext:${this.currentSessionId}`, { uptoMessageId: lastKeptId, recap: reviewed, compiledAt: Date.now(), compiledBy: compilerId });
    Toast.show('Compiled - older context condensed, nothing deleted from what you see or can export.');
    Logger.info('compile', `compiled ${older.length} older turns with ${compilerId}${willChunk ? ' (chunked)' : ''}`);
    return true;
  },

  // The actual answer to "what if the compile drops something" - you see
  // exactly what's about to replace the older turns in the AI's context,
  // and can fix or add back anything before it's used. Returns the
  // (possibly edited) recap text, or null if cancelled.
  reviewRecap(recap, turnCount) {
    return new Promise((resolve) => {
      const box = this.openBox(`
        <div class="palette-box-head">
          <span>Review compiled recap</span>
          <i class="icon-btn" data-icon="x" data-close></i>
        </div>
        <div style="font-size:12px;color:var(--text-muted);padding:6px 10px 10px">
          This condensed ${turnCount} older turn${turnCount === 1 ? '' : 's'} into what the AI will see from now on instead of the full text. If anything important got dropped, fix it here before it's used - this is your one chance to catch that, since this replaces those turns in what gets sent going forward.
        </div>
        <textarea id="recapReviewText" style="width:100%;min-height:220px;background:var(--bg-1);border:0.5px solid var(--line-strong);border-radius:8px;padding:10px;color:var(--text-primary);font-size:12.5px;line-height:1.6;font-family:var(--font-mono);resize:vertical;box-sizing:border-box">${recap.replace(/</g, '&lt;')}</textarea>
        <div style="display:flex;gap:8px;padding:10px 0 2px;justify-content:flex-end">
          <button type="button" class="small-btn" id="recapCancelBtn">cancel compile</button>
          <button type="button" class="btn-primary-sm" id="recapUseBtn">use this</button>
        </div>
      `);
      const textarea = box.querySelector('#recapReviewText');
      let resolved = false;
      // closeBox's onClose hook fires on EVERY dismiss path - backdrop
      // click, Escape, the X button, or our own buttons below - so the
      // promise always resolves, never hangs waiting for a specific button.
      this._boxOnClose = () => { if (!resolved) { resolved = true; resolve(null); } };
      box.querySelector('#recapUseBtn').addEventListener('click', () => {
        resolved = true; // set first so the resulting closeBox() call's onClose is a no-op
        const val = textarea.value;
        this.closeBox();
        resolve(val);
      });
      box.querySelector('#recapCancelBtn').addEventListener('click', () => this.closeBox());
    });
  },

  // Blocks the send until the person picks compile / new session / send
  // anyway / cancel. Dismissing (X, backdrop, Escape) counts as cancel.
  showCompileModal(providerId, estimate, ceiling) {
    return new Promise(async (resolve) => {
      const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
      const label = nicknames[providerId] || providerId;
      this.openBox(`
        <div class="palette-box-head"><span>Session's gotten big</span><i class="icon-btn" data-icon="x" data-close></i></div>
        <div class="modal-body-text">
          This conversation is running to roughly <b style="color:var(--text-primary)">${estimate.toLocaleString()}</b> tokens, over ${this.escapeHtml(label)}'s
          ~${ceiling.toLocaleString()}-token limit per request. Compile the older parts into a compact recap (nothing is lost -
          it stays right here, still readable above) and keep going, or start a clean session.
        </div>
        <div class="modal-choice-list">
          <button type="button" class="btn-ghost btn-block" id="compileChoiceBtn">${svgIcon('sparkles')}&nbsp; Compile &amp; continue here</button>
          <button type="button" class="btn-ghost btn-block" id="newSessionChoiceBtn">${svgIcon('plus')}&nbsp; Start a new session</button>
          <button type="button" class="small-btn" id="sendAnywayBtn">send anyway, just this once</button>
        </div>
      `, { wide: true });
      const el = document.getElementById('genericModal');
      renderIcons(el);
      let resolved = false;
      const finish = (val) => { if (resolved) return; resolved = true; this.closeBox(); resolve(val); };
      document.getElementById('compileChoiceBtn').addEventListener('click', () => finish('compile'));
      document.getElementById('newSessionChoiceBtn').addEventListener('click', () => finish('new'));
      document.getElementById('sendAnywayBtn').addEventListener('click', () => finish('send'));
      const observer = new MutationObserver(() => {
        if (el.classList.contains('hidden') && !resolved) { resolved = true; observer.disconnect(); resolve('cancel'); }
      });
      observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  },

  async handleSend(text) {
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);

    // rename command check first - doesn't go to any AI
    const rename = Router.detectRename(text, nicknames);
    if (rename) {
      const emptyState = document.getElementById('emptyState');
      if (emptyState) emptyState.remove();
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

    // fold any pending attachment text into the outgoing message (computed
    // only, nothing committed to DB yet - so a cancel below leaves
    // everything exactly as it was). composedText is what the AI receives;
    // it should NEVER be what renders in the chat bubble - that's the
    // "screen fills with PDF text" problem. The bubble instead shows just
    // what you typed, plus file chips (wired up after DB.addMessage below).
    let composedText = text;
    const attachmentsToSave = this.pendingAttachments.slice();
    if (attachmentsToSave.length) {
      const extra = attachmentsToSave.map(a => a.text
        ? `\n\n[Attached: ${a.name}]\n${a.text}`
        : `\n\n[Attached image: ${a.name}]`).join('');
      composedText = (text ? text : `Here's what I attached - take a look.`) + extra;
    }

    const mode = this.manualTarget ? 'manual' : 'auto';
    const autoProviders = this.manualTarget ? [this.manualTarget] : await DB.getSetting('autoProviders', DEFAULT_AUTO_PROVIDERS);
    const { targets, isManualMention } = Router.resolveTargets(text, { nicknames, mode, autoProviders });

    // ---- context-size check, BEFORE committing anything to this session ----
    const priorContext = await this.buildSharedContext();
    const wouldBeContext = [...priorContext, { role: 'user', content: composedText }];
    const imageCountForEstimate = attachmentsToSave.filter(a => a.imageBase64).length;
    const targetCeilings = targets.map(id => PROVIDER_TOKEN_CEILING[id] || PROVIDER_TOKEN_CEILING.default);
    const tightestCeiling = Math.min(...targetCeilings);
    const tightestProvider = targets[targetCeilings.indexOf(tightestCeiling)];
    const estimate = this.estimateMessagesTokens(wouldBeContext, imageCountForEstimate);

    if (estimate > tightestCeiling) {
      const decision = await this.showCompileModal(tightestProvider, estimate, tightestCeiling);
      if (decision === 'cancel') return;
      if (decision === 'new') {
        const s = await DB.createSession('New session');
        await this.renderSessionList(await DB.listSessions());
        await this.openSession(s.id);
      } else if (decision === 'compile') {
        await this.compileContext(tightestProvider);
      }
      // 'send' falls through unchanged - proceed anyway, just this once
    }

    // ---- now actually commit: clear attachments, save + render user turn ----
    const emptyState = document.getElementById('emptyState');
    if (emptyState) emptyState.remove();
    this.pendingAttachments = [];
    document.getElementById('attachmentBar').innerHTML = '';
    document.getElementById('attachmentBar').classList.add('hidden');

    const userMsg = await DB.addMessage(this.currentSessionId, {
      role: 'user',
      content: composedText, // full text incl. extracted file content - what the AI sees
      displayText: text || (attachmentsToSave.length ? '' : composedText) // what the bubble shows
    });
    const savedAttachments = [];
    for (const a of attachmentsToSave) {
      const rec = await DB.addAttachment(this.currentSessionId, {
        messageId: userMsg.id, name: a.name, size: a.size, type: a.type,
        text: a.text || null, base64: a.keepRaw ? a.base64 : (a.imageBase64 || null)
      });
      savedAttachments.push(rec);
    }
    userMsg.attachmentMeta = savedAttachments.map(a => ({ id: a.id, name: a.name, type: a.type, size: a.size }));
    if (userMsg.attachmentMeta.length) await DB.patchMessage(userMsg.id, { attachmentMeta: userMsg.attachmentMeta, displayText: userMsg.displayText });
    this.renderMessage(userMsg);

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

    // rebuild fresh - picks up the just-saved user turn, and reflects a
    // fresh/compiled session if the ceiling check changed anything above
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
      const msgObj = { role: 'ai', nickname, thinking: true };
      const thinkingEl = this.renderMessage(msgObj);
      let finalText, isError = false;
      try {
        const result = await Providers.chat(providerId, sharedMessages);
        if (result.error) { isError = true; finalText = `(${nickname} error: ${result.message})`; }
        else finalText = this.stripNamePrefix(result.text);
      } catch (err) {
        isError = true;
        finalText = `(${nickname} error: ${err.message || 'Something went wrong - try again.'})`;
      }
      thinkingEl.querySelector('.bubble').innerHTML = this.renderMarkdown(finalText);
      const saved = await DB.addMessage(this.currentSessionId, { role: 'ai', nickname, content: finalText, isError });
      Logger.log(isError ? 'error' : 'info', 'provider', `${nickname} ${isError ? 'failed' : 'replied'}`, isError ? finalText.slice(0, 200) : undefined);
      // keep the rendered message's own closures (copy/pin/download/verify)
      // in sync with the final saved state, not the transient "thinking" one
      msgObj.content = finalText;
      msgObj.id = saved.id;
      msgObj.isError = isError;
      msgObj.thinking = false;
      thinkingEl.dataset.messageId = saved.id;
      responses.push(finalText);

      if (!isError && this.looksLikeRefusal(finalText)) {
        this.attachAskDifferentWayHint(thinkingEl, text || composedText);
      }
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
    const bar = document.getElementById('usageBar');
    if (!messages.length) { bar.classList.remove('visible'); return; }
    const shared = await this.buildSharedContext();
    const roughTokens = this.estimateMessagesTokens(shared, 0);
    const ceiling = this.manualTarget ? (PROVIDER_TOKEN_CEILING[this.manualTarget] || PROVIDER_TOKEN_CEILING.default) : null;
    bar.innerHTML = `<span class="usage-count">~${roughTokens.toLocaleString()} tokens</span>` +
      (ceiling ? `<span class="usage-limit"> / ${ceiling.toLocaleString()} (${this.manualTarget})</span>` : '<span class="usage-limit"> this session</span>');
    bar.title = `Rough token estimate for this session${ceiling ? ` - ${this.manualTarget}'s limit is ${ceiling.toLocaleString()}` : ''}`;
    bar.classList.add('visible');
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
// `const App` doesn't auto-attach to window, but several places (existing
// and new) check `window.App` before calling into it - without this line
// those checks were silently always false.
window.App = App;
