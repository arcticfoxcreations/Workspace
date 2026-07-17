const App = {
  currentSessionId: null,
  manualTarget: null, // null = auto mode

  async init() {
    await Settings.init();
    this.wireSidebar();
    this.wireComposer();
    this.wireHeaderChip();

    let sessions = await DB.listSessions();
    if (sessions.length === 0) {
      const s = await DB.createSession('New session');
      sessions = [s];
    }
    await this.renderSessionList(sessions);
    await this.openSession(sessions[0].id);

    renderIcons();
  },

  wireSidebar() {
    const sidebar = document.getElementById('sidebar');
    const star = document.getElementById('starBtn');
    const starCollapsed = document.getElementById('starBtnCollapsed');
    const headerRow = document.getElementById('headerRow');

    star.addEventListener('click', () => {
      sidebar.classList.add('collapsed');
      starCollapsed.style.display = 'flex';
      headerRow.style.paddingLeft = '40px';
    });
    starCollapsed.addEventListener('click', () => {
      sidebar.classList.remove('collapsed');
      starCollapsed.style.display = 'none';
      headerRow.style.paddingLeft = '16px';
    });

    document.getElementById('newSessionBtn').addEventListener('click', async () => {
      const s = await DB.createSession('New session');
      const sessions = await DB.listSessions();
      await this.renderSessionList(sessions);
      await this.openSession(s.id);
    });
  },

  wireHeaderChip() {
    const chipsWrap = document.getElementById('modeChips');
    chipsWrap.addEventListener('click', async (e) => {
      if (!e.target.classList.contains('chip')) return;
      const providerDefs = await Providers.list();
      const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
      const options = ['Auto', ...Object.keys(providerDefs).map(id => nicknames[id] || providerDefs[id].label)];
      const choice = prompt('Respond with:\n' + options.map((o, i) => `${i}: ${o}`).join('\n') + '\n\nType a number:');
      const idx = parseInt(choice, 10);
      if (Number.isNaN(idx) || idx === 0) {
        this.manualTarget = null;
      } else {
        const ids = Object.keys(providerDefs);
        this.manualTarget = ids[idx - 1] || null;
      }
      this.refreshHeaderChips();
    });
  },

  async refreshHeaderChips() {
    const chipsWrap = document.getElementById('modeChips');
    const nicknames = await DB.getSetting('nicknames', DEFAULT_NICKNAMES);
    const label = this.manualTarget ? (nicknames[this.manualTarget] || this.manualTarget) : 'Auto';
    chipsWrap.innerHTML = `<button class="chip chip-active" data-mode="current">${label}</button>`;
  },

  async renderSessionList(sessions) {
    const listEl = document.getElementById('sessionList');
    listEl.innerHTML = sessions.map(s => `
      <div class="session-item ${s.id === this.currentSessionId ? 'active' : ''}" data-id="${s.id}">
        ${s.title}
      </div>`).join('');
    listEl.querySelectorAll('.session-item').forEach(el => {
      el.addEventListener('click', () => this.openSession(el.dataset.id));
    });
  },

  async openSession(id) {
    this.currentSessionId = id;
    const sessions = await DB.listSessions();
    await this.renderSessionList(sessions);
    const messages = await DB.listMessages(id);
    const logEl = document.getElementById('chatLog');
    logEl.innerHTML = '';
    for (const m of messages) this.renderMessage(m);
    logEl.scrollTop = logEl.scrollHeight;
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
      wrap.innerHTML = `<div class="msg-label"></div><div class="bubble"></div>`;
      wrap.querySelector('.msg-label').textContent = m.nickname || 'AI';
      wrap.querySelector('.bubble').textContent = m.content;
    }
    logEl.appendChild(wrap);
    logEl.scrollTop = logEl.scrollHeight;
    return wrap;
  },

  renderAgreementRow(match) {
    const logEl = document.getElementById('chatLog');
    const row = document.createElement('div');
    row.className = 'agree-row ' + (match ? 'match' : 'mismatch');
    row.innerHTML = `<i class="icon" data-icon="check"></i><span></span>`;
    row.querySelector('span').textContent = match ? 'Responses seem to agree' : 'Responses differ - worth a closer look';
    logEl.appendChild(row);
    renderIcons(row);
    logEl.scrollTop = logEl.scrollHeight;
  },

  wireComposer() {
    const form = document.getElementById('composer');
    const input = document.getElementById('messageInput');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await this.handleSend(text);
    });

    document.getElementById('fileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const note = { role: 'system', content: `Attached: ${file.name} (${Math.round(file.size / 1024)}KB) - file extraction pipeline lands in the next build pass.` };
      const saved = await DB.addMessage(this.currentSessionId, note);
      this.renderMessage(saved);
      e.target.value = '';
    });
  },

  async handleSend(text) {
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

    const userMsg = await DB.addMessage(this.currentSessionId, { role: 'user', content: text });
    this.renderMessage(userMsg);

    const mode = this.manualTarget ? 'manual' : 'auto';
    const autoProviders = this.manualTarget ? [this.manualTarget] : DEFAULT_AUTO_PROVIDERS;
    const { targets } = Router.resolveTargets(text, { nicknames, mode, autoProviders });

    // build shared context: every AI sees the whole conversation, prefixed with who said what
    const history = await DB.listMessages(this.currentSessionId);
    const sharedMessages = history.map(m => {
      if (m.role === 'user') return { role: 'user', content: m.content };
      if (m.role === 'system') return null;
      return { role: 'assistant', content: `[${m.nickname}]: ${m.content}` };
    }).filter(Boolean);
    sharedMessages.unshift({
      role: 'system',
      content: 'You are one voice in a multi-AI workspace. Other AIs may also respond in this thread under their own names, shown as [Name]: message. Answer directly and concisely.'
    });

    const responses = [];
    for (const providerId of targets) {
      const nickname = nicknames[providerId] || providerId;
      const thinkingEl = this.renderMessage({ role: 'ai', nickname, content: 'thinking...' });
      const result = await Providers.chat(providerId, sharedMessages);
      const finalText = result.error ? `(${nickname} error: ${result.message})` : result.text;
      thinkingEl.querySelector('.bubble').textContent = finalText;
      const saved = await DB.addMessage(this.currentSessionId, { role: 'ai', nickname, content: finalText });
      responses.push(finalText);
    }

    if (responses.length > 1) {
      const match = this.roughlyAgree(responses[0], responses[1]);
      this.renderAgreementRow(match);
    }

    await this.renameSessionIfNeeded(text);
    renderIcons();
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
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
