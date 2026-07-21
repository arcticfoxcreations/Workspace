// In-memory event log other modules push into (provider calls, failovers,
// compiles, rejected files, keybind resets, etc) - this is what actually
// backs the sidebar Console panel. Nothing here is persisted or sent
// anywhere; it's a ring buffer that resets on reload, purely for seeing
// what just happened without guessing.

const Logger = {
  buffer: [],
  MAX_ENTRIES: 500,
  listeners: [],

  log(level, tag, message, data) {
    const entry = {
      time: Date.now(),
      level: level || 'info', // info | warn | error
      tag: tag || 'app',
      message: message || '',
      data: data !== undefined ? data : null
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.MAX_ENTRIES) this.buffer.shift();
    this.listeners.forEach(fn => { try { fn(entry); } catch (e) { /* never let a bad listener break logging */ } });
    return entry;
  },
  info(tag, message, data) { return this.log('info', tag, message, data); },
  warn(tag, message, data) { return this.log('warn', tag, message, data); },
  error(tag, message, data) { return this.log('error', tag, message, data); },

  subscribe(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  },

  clear() {
    this.buffer = [];
    this.listeners.forEach(fn => { try { fn(null); } catch (e) {} }); // null = "cleared, re-render empty"
  },

  exportText() {
    return this.buffer.map(e => {
      const t = new Date(e.time).toLocaleTimeString();
      const extra = e.data ? ' ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : '';
      return `[${t}] ${e.level.toUpperCase()} ${e.tag}: ${e.message}${extra}`;
    }).join('\n');
  }
};
