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
