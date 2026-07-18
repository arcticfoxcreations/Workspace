// Minimal inline icon set. No external requests, no font flash.
const ICONS = {
  star: '<path d="M12 2l2.6 6.6L21 10l-5.2 4.3L17.4 21 12 17.3 6.6 21l1.6-6.7L3 10l6.4-1.4L12 2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  paperclip: '<path d="M21.4 11.1l-9.2 9.2a5 5 0 01-7.1-7.1l9.2-9.2a3.5 3.5 0 015 5l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M20.5 9A9 9 0 005.6 5.6L1 10m22 4l-4.6 4.4A9 9 0 013.5 15"/>',
  shieldCheck: '<path d="M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  command: '<path d="M9 3a3 3 0 100 6h6a3 3 0 100-6M9 15a3 3 0 100 6h6a3 3 0 100-6M9 9v6M15 9v6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.6 12.4L20 3M17 6l3 3M14 9l2 2"/>',
  palette: '<circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="8" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 22a2 2 0 01-2-2c0-1.5 1.5-1.5 1.5-3a2 2 0 00-2-2H9a7 7 0 117-7"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>',
  bolt: '<path d="M13 2L3 14h8l-1 8 10-12h-8z"/>'
};

function svgIcon(name, size) {
  const s = size || 16;
  const body = ICONS[name] || '';
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function renderIcons(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.getAttribute('data-icon');
    if (!el.dataset.iconRendered) {
      el.innerHTML = svgIcon(name);
      el.dataset.iconRendered = '1';
    }
  });
}

// Small monochrome glyphs per provider - not the real trademarked logos,
// just enough visual identity to tell providers apart at a glance.
const PROVIDER_GLYPHS = {
  gemini: '✦', groq: '⚡', openrouter: '⇄', githubmodels: '◆',
  mistral: '≋', cerebras: '◧', nvidia: '▲', cloudflareai: '☁',
  ovhcloud: '◈', anthropic: '✳', openai: '◎', deepseek: '◐'
};
function providerGlyph(id) {
  return PROVIDER_GLYPHS[id] || '●';
}
