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
  bolt: '<path d="M13 2L3 14h8l-1 8 10-12h-8z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.2 3.6-7 8-7s8 2.8 8 7"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5"/><path d="M4 3h16"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  pin: '<path d="M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6z"/>',
  pinFilled: '<path d="M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6z" fill="currentColor"/>',
  link: '<path d="M9 15l6-6"/><path d="M10 6l1-1a4 4 0 015.7 5.7l-1 1M14 18l-1 1a4 4 0 01-5.7-5.7l1-1"/>',
  sparkles: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15z"/>',
  doc: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'
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

// Small monochrome marks per provider, shaped after each one's real
// logomark (sparkle for Gemini, cloud for Cloudflare, the GitHub mark,
// etc.) rather than a generic dot - simplified single-color line art so
// they sit cleanly in a dark UI, not pixel-traced wordmarks.
const PROVIDER_ICON_SVG = {
  gemini: `<path d="M12 2 14 10 22 12 14 14 12 22 10 14 2 12 10 10Z"/>`,
  groq: `<path d="M13 2L3 14h8l-1 8 10-12h-8z"/>`,
  openrouter: `<g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none">
    <circle cx="5" cy="12" r="2" fill="currentColor" stroke="none"/>
    <circle cx="19" cy="6" r="2" fill="currentColor" stroke="none"/>
    <circle cx="19" cy="18" r="2" fill="currentColor" stroke="none"/>
    <path d="M7 12h3.3L17 6.3M10.3 12H7M10.3 12L17 17.7"/>
  </g>`,
  githubmodels: `<path d="M12 2C6.48 2 2 6.58 2 12.17c0 4.48 2.87 8.28 6.84 9.63.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.9-2.78.62-3.37-1.19-3.37-1.19-.46-1.19-1.11-1.51-1.11-1.51-.91-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.9 1.56 2.34 1.11 2.91.85.09-.67.35-1.11.64-1.37-2.22-.26-4.56-1.13-4.56-5.02 0-1.11.38-2.02 1.02-2.73-.1-.26-.44-1.29.1-2.68 0 0 .84-.27 2.75 1.04a9.3 9.3 0 015 0c1.91-1.31 2.75-1.04 2.75-1.04.54 1.39.2 2.42.1 2.68.64.71 1.02 1.62 1.02 2.73 0 3.9-2.34 4.76-4.57 5.01.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49C19.14 20.44 22 16.65 22 12.17 22 6.58 17.52 2 12 2z"/>`,
  mistral: `<g fill="currentColor"><rect x="2.5" y="10" width="3" height="10"/><rect x="7.5" y="5.5" width="3" height="14.5"/><rect x="12.5" y="8.5" width="3" height="11.5"/><rect x="17.5" y="3" width="3" height="17"/></g>`,
  cerebras: `<g>
    <circle cx="12" cy="12" r="3" fill="currentColor"/>
    <circle cx="4.2" cy="5.5" r="1.6" fill="currentColor"/>
    <circle cx="19.8" cy="5.5" r="1.6" fill="currentColor"/>
    <circle cx="4.2" cy="18.5" r="1.6" fill="currentColor"/>
    <circle cx="19.8" cy="18.5" r="1.6" fill="currentColor"/>
    <g fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M9.7 10.2L5.4 6.6M14.3 10.2l4.3-3.6M9.7 13.8l-4.3 3.6M14.3 13.8l4.3 3.6"/>
    </g>
  </g>`,
  nvidia: `<path d="M2 12c3-5 7-7.5 10-7.5s7 2.5 10 7.5c-3 5-7 7.5-10 7.5S5 17 2 12z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>`,
  cloudflareai: `<path d="M7 18h10.5a4 4 0 000-8 .5.5 0 01-.47-.34A5.5 5.5 0 006.6 10.9 4.5 4.5 0 007 18z"/>`,
  ovhcloud: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5-7M4 12l5 7"/><path d="M20 12l-5-7M20 12l-5 7"/></g>`,
  anthropic: `<g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v5.2M12 15.8V21M4.6 7.4l4.6 2.7M14.8 13.9l4.6 2.7M4.6 16.6l4.6-2.7M14.8 10.1l4.6-2.7"/></g>`,
  openai: `<g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="7.2" r="3"/><circle cx="7.6" cy="14.6" r="3"/><circle cx="16.4" cy="14.6" r="3"/></g>`,
  deepseek: `<path d="M3 13.6c1.7-4.1 5.7-6.3 9.8-5.4 2.7.6 4.6 2.7 5.6 4.8-1 .3-1.9.2-2.8-.2.5.9 1.4 1.5 2.5 1.6-1.1 1.5-3 2.2-4.9 1.8-2 2.6-5.4 3.6-8.2 2.9-.3-1.5-.3-3.2 0-4.6-.8-.2-1.5-.5-2-1z"/>`
};

function providerIconHTML(id, size) {
  const s = size || 16;
  const body = PROVIDER_ICON_SVG[id];
  if (!body) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>`;
  return `<svg class="provider-icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// Kept for any place still wanting a plain-text fallback (e.g. alt text).
const PROVIDER_GLYPHS = {
  gemini: '✦', groq: '⚡', openrouter: '⇄', githubmodels: '◆',
  mistral: '≋', cerebras: '◧', nvidia: '▲', cloudflareai: '☁',
  ovhcloud: '◈', anthropic: '✳', openai: '◎', deepseek: '◐'
};
function providerGlyph(id) {
  return PROVIDER_GLYPHS[id] || '●';
}

// Rough brand-adjacent accent per provider - used for message-label color,
// a thin bubble accent, and menu icon tint, so it's easier to tell at a
// glance who said what without reading the label every time.
const PROVIDER_COLORS = {
  gemini: '#8e7cf5',
  groq: '#f55036',
  openrouter: '#6ee7b7',
  githubmodels: '#c9d1d9',
  mistral: '#fa8256',
  cerebras: '#3fd1c6',
  nvidia: '#76b900',
  cloudflareai: '#f6821f',
  ovhcloud: '#5da4e0',
  anthropic: '#d97757',
  openai: '#10a37f',
  deepseek: '#4d6bfe'
};
function providerColor(id) {
  return PROVIDER_COLORS[id] || 'var(--accent)';
}
