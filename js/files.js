// ===== fileHandler.js =====
// Everything here runs entirely in the browser. Nothing is ever uploaded to
// the Worker - files are read, extracted, and (for the small ones) stored
// locally in IndexedDB. Nothing leaves your device except the extracted TEXT
// (or, for images, the image itself) which gets sent to whichever AI you're
// chatting with, same as typed text.

const AUTO_DELETE_RAW_ABOVE_BYTES = 10 * 1024 * 1024; // 10MB
const SOFT_WARN_ABOVE_BYTES = 60 * 1024 * 1024; // 50-80MB range, picked 60MB
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500MB
const MAX_FILES_HEAVY = 20;
const MAX_FILES_LIGHT = 30;
const LIGHT_FILE_THRESHOLD = 2 * 1024 * 1024; // under this = "small" (images etc.)

// A single extraction is only allowed to run this long before we treat it
// as stuck and bail out, rather than let a malformed file freeze the tab.
const EXTRACTION_TIMEOUT_MS = 20000;

// Definitely-binary/executable formats - always rejected regardless of what
// the browser reports as the MIME type, since these are exactly the "no
// exe" case that matters.
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'msi', 'bat', 'cmd', 'com', 'scr', 'apk', 'ipa', 'dmg',
  'iso', 'bin', 'so', 'dylib', 'deb', 'rpm', 'jar', 'class', 'o', 'obj',
  'node', 'sys', 'drv', 'app', 'run', 'out', 'elf'
]);
// Everything on this list is treated as readable without even needing to
// sniff the content - covers documents, images, and essentially all plain
// text / code / config formats a real project or research workflow uses.
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'docx', 'doc', 'txt', 'md', 'csv', 'json', 'xlsx', 'xls',
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'html', 'htm', 'css', 'scss',
  'sass', 'less', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'log', 'rtf', 'tsv', 'sh', 'bash', 'zsh', 'sql', 'go', 'rb', 'php', 'java',
  'c', 'cpp', 'h', 'hpp', 'cs', 'rs', 'swift', 'kt', 'gradle', 'lock',
  'gitignore', 'dockerfile', 'r', 'jl', 'pl', 'lua', 'vue', 'graphql',
  'proto', 'http', 'svelte', 'astro', 'bib', 'tex',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'
]);
const ALLOWED_MIME_PREFIXES = ['text/', 'image/', 'application/pdf', 'application/json',
  'application/vnd.openxmlformats', 'application/msword', 'application/vnd.ms-excel',
  'application/rtf', 'application/xml', 'application/toml', 'application/x-yaml'];
// Read this many bytes to decide if an unrecognized file "looks like" text
// (used only when extension/MIME didn't already give a clear answer, e.g.
// a config file with no extension, or a MIME type the browser left blank).
const SNIFF_BYTES = 512;

// Pinned to versions confirmed to expose a classic global (window.pdfjsLib /
// window.mammoth) rather than an ES-module-only build - that mismatch was
// the actual cause of the earlier "Could not read file: undefined" errors.
const PDFJS_VERSION = '2.16.105';
const MAMMOTH_VERSION = '1.11.0';

let _pdfjsLoaded = null;
let _mammothLoaded = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && existing.dataset.loaded) { resolve(); return; }
    if (existing) { existing.addEventListener('load', resolve); existing.addEventListener('error', () => reject(new Error('Failed to load ' + src))); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('Could not load ' + src + ' - check your internet connection.'));
    document.head.appendChild(s);
  });
}

async function ensurePdfJs() {
  if (_pdfjsLoaded) return _pdfjsLoaded;
  _pdfjsLoaded = loadScript(`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`).then(() => {
    if (!window.pdfjsLib) throw new Error('PDF reader library did not load correctly.');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
  }).catch(err => { _pdfjsLoaded = null; throw err; });
  return _pdfjsLoaded;
}
async function ensureMammoth() {
  if (_mammothLoaded) return _mammothLoaded;
  _mammothLoaded = loadScript(`https://cdnjs.cloudflare.com/ajax/libs/mammoth/${MAMMOTH_VERSION}/mammoth.browser.min.js`).then(() => {
    if (!window.mammoth) throw new Error('Word document reader library did not load correctly.');
  }).catch(err => { _mammothLoaded = null; throw err; });
  return _mammothLoaded;
}

const FileHandler = {
  // Extension/MIME check first (fast, no read needed). Only for the
  // genuinely ambiguous case - no known extension, no useful MIME - do we
  // fall back to actually peeking at the bytes.
  async isReadable(file) {
    const n = (file.name || '').toLowerCase();
    const ext = n.includes('.') ? n.split('.').pop() : '';
    const type = (file.type || '').toLowerCase();

    if (BLOCKED_EXTENSIONS.has(ext)) return false;
    if (ALLOWED_EXTENSIONS.has(ext)) return true;
    if (type && ALLOWED_MIME_PREFIXES.some(p => type.startsWith(p))) return true;
    // Unknown extension AND unhelpful/blank MIME (common for config-style
    // files like .toml in some browsers, or extension-less files like
    // "Dockerfile") - sniff the actual bytes instead of guessing.
    return FileHandler.sniffLooksLikeText(file);
  },

  // Reads the first SNIFF_BYTES bytes and checks whether they look like
  // real text (mostly printable, no null bytes) rather than binary data.
  sniffLooksLikeText(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const buf = new Uint8Array(reader.result);
          if (buf.length === 0) { resolve(true); return; } // empty file, harmless
          let suspicious = 0;
          for (let i = 0; i < buf.length; i++) {
            const b = buf[i];
            if (b === 0) { resolve(false); return; } // null byte - binary, bail immediately
            if (b < 9 || (b > 13 && b < 32)) suspicious++;
          }
          resolve(suspicious / buf.length < 0.02); // allow a tiny bit of noise, not much
        } catch (e) { resolve(false); }
      };
      reader.onerror = () => resolve(false);
      reader.readAsArrayBuffer(file.slice(0, SNIFF_BYTES));
    });
  },

  validateBatch(files, existingTotalBytes) {
    const arr = Array.from(files);

    const allSmall = arr.every(f => f.size <= LIGHT_FILE_THRESHOLD);
    const capCount = allSmall ? MAX_FILES_LIGHT : MAX_FILES_HEAVY;
    if (arr.length > capCount) {
      return { ok: false, message: `Too many files at once - max ${capCount} for ${allSmall ? 'small' : 'this size of'} files.` };
    }
    const totalBytes = arr.reduce((s, f) => s + f.size, 0) + (existingTotalBytes || 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, message: `That's over the 500MB upload limit for this batch.` };
    }
    const oversizedForParsing = arr.filter(f => f.size > SOFT_WARN_ABOVE_BYTES && FileHandler.isTextExtractable(f));
    return { ok: true, warnFiles: oversizedForParsing.map(f => f.name) };
  },

  // Separate async pass, run per-file, so a slow sniff on one file doesn't
  // block validating the size/count of the whole batch first.
  async filterUnreadable(files) {
    const arr = Array.from(files);
    const checked = await Promise.all(arr.map(async f => ({ file: f, ok: await FileHandler.isReadable(f) })));
    return {
      readable: checked.filter(c => c.ok).map(c => c.file),
      rejected: checked.filter(c => !c.ok).map(c => c.file.name)
    };
  },

  isTextExtractable(file) {
    const t = (file.type || '').toLowerCase();
    const n = file.name.toLowerCase();
    return t === 'application/pdf' || n.endsWith('.pdf')
      || t.includes('wordprocessingml') || n.endsWith('.docx')
      || t.startsWith('text/') || n.endsWith('.md') || n.endsWith('.csv') || n.endsWith('.json');
  },

  isImage(file) {
    return (file.type || '').startsWith('image/');
  },
  // Same idea as isImage() but for a plain mime string (attachment records
  // loaded from DB aren't File objects).
  isImageType(mime) {
    return (mime || '').startsWith('image/');
  },

  // Extracts text (or image data) from a file, calling onProgress(0..1) as
  // it goes. Returns { text, imageBase64 (data URL), keepRaw, base64 }.
  // Races against EXTRACTION_TIMEOUT_MS so a malformed/huge file can't
  // freeze the tab - the caller (fileHandler wiring in app.js) drops the
  // file and shows a toast when this rejects.
  async extract(file, onProgress) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Reading "${file.name}" is taking too long - it may be corrupted or too complex to parse. It's been removed so it doesn't lock up the workspace.`)), EXTRACTION_TIMEOUT_MS);
    });
    try {
      return await Promise.race([FileHandler._extractInner(file, onProgress), timeout]);
    } finally {
      clearTimeout(timer);
    }
  },

  async _extractInner(file, onProgress) {
    onProgress && onProgress(0);

    if (FileHandler.isImage(file)) {
      const raw = await FileHandler.readAsBase64(file, onProgress);
      // Big photos are shrunk before they're stored/synced/sent (see below) -
      // this is the largest single storage saving for image-heavy chats.
      const base64 = await FileHandler.downscaleImage(raw);
      onProgress && onProgress(1);
      return { text: '', imageBase64: base64, keepRaw: true, base64 };
    }

    const n = file.name.toLowerCase();
    const type = (file.type || '').toLowerCase();
    let text = '';

    try {
      if (type === 'application/pdf' || n.endsWith('.pdf')) {
        await ensurePdfJs();
        const buf = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pages.push(content.items.map(it => it.str).join(' '));
          onProgress && onProgress(i / pdf.numPages);
        }
        text = pages.join('\n\n');
        if (!text.trim()) text = '(This PDF has no selectable text - it may be a scanned image. Text extraction only works on real text, not scans.)';
      } else if (type.includes('wordprocessingml') || n.endsWith('.docx')) {
        await ensureMammoth();
        const buf = await file.arrayBuffer();
        const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
        text = result.value;
        onProgress && onProgress(1);
      } else {
        text = await FileHandler.readTextInChunks(file, onProgress);
      }
    } catch (err) {
      throw new Error(err && err.message ? err.message : 'Could not extract text from this file.');
    }

    const keepRaw = file.size <= AUTO_DELETE_RAW_ABOVE_BYTES;
    let base64 = null;
    if (keepRaw) base64 = await FileHandler.readAsBase64(file, null);

    return { text, keepRaw, base64 };
  },

  readTextInChunks(file, onProgress) {
    return new Promise((resolve, reject) => {
      const chunkSize = 1 * 1024 * 1024; // 1MB chunks
      const total = file.size || 1;
      let offset = 0;
      let out = '';
      const reader = new FileReader();
      const readNext = () => {
        const slice = file.slice(offset, offset + chunkSize);
        reader.readAsText(slice);
      };
      reader.onload = () => {
        out += reader.result;
        offset += chunkSize;
        onProgress && onProgress(Math.min(offset / total, 1));
        if (offset < file.size) readNext();
        else resolve(out);
      };
      reader.onerror = () => reject(new Error('Could not read this file as text.'));
      readNext();
    });
  },

  // Re-encodes large JPEG/PNG/WebP images so the longest side is at most
  // MAX_IMAGE_DIM px (still plenty for vision models). Small images, GIFs
  // (animation) and SVGs are left alone, and the original is kept if the
  // re-encode isn't actually smaller. Falls back to the original on any error.
  MAX_IMAGE_DIM: 2000,
  IMAGE_QUALITY: 0.85,
  IMAGE_SKIP_CHARS: 600 * 1024, // data-URL length below which we don't bother (~450 KB image)
  downscaleImage(dataUrl) {
    return new Promise((resolve) => {
      if (!/^data:image\/(jpeg|png|webp);/.test(dataUrl) || dataUrl.length < FileHandler.IMAGE_SKIP_CHARS) return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        try {
          const longest = Math.max(img.naturalWidth, img.naturalHeight);
          const scale = Math.min(1, FileHandler.MAX_IMAGE_DIM / longest);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const isPng = /^data:image\/png;/.test(dataUrl); // keep PNG as PNG so transparency survives
          const out = canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', FileHandler.IMAGE_QUALITY);
          resolve(out.length < dataUrl.length * 0.9 ? out : dataUrl);
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  },

  readAsBase64(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read this file.'));
      reader.readAsDataURL(file);
    });
  },

  // Samples pixels on an offscreen canvas and buckets them into rough
  // colors, then returns the most common ones as hex - all local, nothing
  // sent anywhere just to get a palette.
  extractDominantColors(imageDataUrl, count) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const size = 48; // downscale hard - we only need a rough palette
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, size, size);
          const { data } = ctx.getImageData(0, 0, size, size);
          const buckets = {};
          for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 100) continue; // skip near-transparent pixels
            // quantize to reduce near-identical shades into one bucket
            const r = Math.round(data[i] / 24) * 24;
            const g = Math.round(data[i + 1] / 24) * 24;
            const b = Math.round(data[i + 2] / 24) * 24;
            const key = `${r},${g},${b}`;
            buckets[key] = (buckets[key] || 0) + 1;
          }
          const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, count || 5);
          const toHex = (n) => Math.min(255, n).toString(16).padStart(2, '0');
          const colors = sorted.map(([key]) => {
            const [r, g, b] = key.split(',').map(Number);
            return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
          });
          resolve(colors);
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('Could not analyze this image.'));
      img.src = imageDataUrl;
    });
  }
};

// ===== fileViewer.js =====
// Split-panel viewer for attached files - opened by clicking a file chip in
// chat. Left side is the extracted text version, right side is the original
// (rendered for images/PDF/text, or a "no preview" note for formats that
// don't preview well in-browser like .docx/.xlsx). Has a real close (X and
// backdrop click) and a back button that returns to the chat without losing
// scroll position, same convention as the command palette / keybind sheet.

const FileViewer = {
  _lastFocus: null,

  async open(attachmentId) {
    const att = await DB.getAttachment(attachmentId);
    if (!att) { Toast.show('This attachment is no longer available.', true); return; }

    this._lastFocus = document.activeElement;
    const overlay = document.getElementById('overlay');
    overlay.classList.remove('hidden');

    let modal = document.getElementById('fileViewerModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'fileViewerModal';
      modal.className = 'file-viewer-modal';
      document.getElementById('app').appendChild(modal);
    }

    const isImg = FileHandler.isImageType(att.type);
    const sizeLabel = FileViewer.formatBytes(att.size);

    modal.innerHTML = `
      <div class="file-viewer-head">
        <i class="icon-btn" data-icon="arrowDown" style="transform:rotate(90deg)" id="fvBackBtn" title="Back to chat"></i>
        <span class="file-viewer-title">${FileViewer.escape(att.name)}</span>
        <span class="file-viewer-sub">${sizeLabel}${att.type ? ' · ' + FileViewer.escape(att.type) : ''}</span>
        <i class="icon-btn" data-icon="x" id="fvCloseBtn" title="Close"></i>
      </div>
      <div class="file-viewer-body">
        <div class="file-viewer-pane">
          <div class="file-viewer-pane-label">Extracted text</div>
          <div class="file-viewer-pane-content" id="fvTextPane"></div>
        </div>
        <div class="file-viewer-pane">
          <div class="file-viewer-pane-label">Original</div>
          <div class="file-viewer-pane-content file-viewer-preview" id="fvPreviewPane"></div>
        </div>
      </div>
    `;
    modal.classList.remove('hidden');
    renderIcons(modal);

    const textPane = modal.querySelector('#fvTextPane');
    if (isImg) {
      textPane.innerHTML = `<div class="file-viewer-empty">Images don't have extracted text - the AI sees the picture itself.</div>`;
    } else if (att.text && att.text.trim()) {
      textPane.textContent = att.text;
    } else {
      textPane.innerHTML = `<div class="file-viewer-empty">No text could be extracted from this file (it may be a scan, or an unsupported layout).</div>`;
    }

    const previewPane = modal.querySelector('#fvPreviewPane');
    FileViewer.renderPreview(previewPane, att);

    const close = () => FileViewer.close();
    modal.querySelector('#fvCloseBtn').addEventListener('click', close);
    modal.querySelector('#fvBackBtn').addEventListener('click', close);
    overlay.onclick = close;
  },

  renderPreview(container, att) {
    const isImg = FileHandler.isImageType(att.type);
    if (isImg && att.base64) {
      container.innerHTML = `<img src="${att.base64}" alt="${FileViewer.escape(att.name)}" class="file-viewer-img" />`;
      return;
    }
    if (att.type === 'application/pdf' && att.base64) {
      container.innerHTML = `<embed src="${att.base64}" type="application/pdf" class="file-viewer-pdf" />`;
      return;
    }
    if ((att.type || '').startsWith('text/') || /\.(txt|md|csv|json|js|ts|jsx|tsx|py|html|htm|css|xml|yaml|yml|toml|ini|cfg|conf|env|log|sh|bash|sql|go|rb|php|java|c|cpp|h|hpp|cs|rs|swift|kt|lua|vue)$/i.test(att.name || '')) {
      // Genuinely show it, not just a note claiming it's the same - the
      // whole complaint was "why isn't the original shown".
      container.style.display = 'block';
      container.style.textAlign = 'left';
      container.style.whiteSpace = 'pre-wrap';
      container.style.wordBreak = 'break-word';
      container.style.padding = '14px';
      container.textContent = att.text || '(empty file)';
      return;
    }
    container.innerHTML = `<div class="file-viewer-empty">No inline preview for this file type - the extracted text on the left is what the AI reads.</div>`;
  },

  close() {
    const modal = document.getElementById('fileViewerModal');
    const overlay = document.getElementById('overlay');
    if (modal) modal.classList.add('hidden');
    overlay.classList.add('hidden');
    overlay.onclick = null;
    if (this._lastFocus && this._lastFocus.focus) this._lastFocus.focus();
  },

  formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  },

  escape(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
};

// ===== exporter.js =====
// Turns a message or a whole session into a downloadable file. Everything
// runs in-browser - nothing is uploaded anywhere just to export it.
// PDF uses jsPDF, DOCX uses html-docx-js - both loaded lazily from a CDN,
// same pattern as pdf.js/mammoth in fileHandler.js, so there's no bundler
// and no extra weight until you actually hit "download".

const JSPDF_VERSION = '2.5.1';
const HTML_DOCX_URL = 'https://cdn.jsdelivr.net/npm/html-docx-js/dist/html-docx.js';

let _jspdfLoaded = null;
let _htmlDocxLoaded = null;

function exporterLoadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && existing.dataset.loaded) { resolve(); return; }
    if (existing) { existing.addEventListener('load', resolve); existing.addEventListener('error', () => reject(new Error('Failed to load ' + src))); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
}

// Tries each URL in order, only failing for real (with a clear combined
// message) if every source fails - one CDN having a bad path, a hiccup, or
// being blocked on a given network shouldn't take the whole feature down.
async function exporterLoadFirstAvailable(urls) {
  const errors = [];
  for (const url of urls) {
    try { await exporterLoadScript(url); return; } catch (e) { errors.push(e.message); }
  }
  throw new Error(`Could not load the PDF library from any source - check your internet connection. (${errors.join('; ')})`);
}

async function ensureJsPdf() {
  if (_jspdfLoaded) return _jspdfLoaded;
  _jspdfLoaded = exporterLoadFirstAvailable([
    `https://cdnjs.cloudflare.com/ajax/libs/jspdf/${JSPDF_VERSION}/jspdf.umd.min.js`,
    `https://cdn.jsdelivr.net/npm/jspdf@${JSPDF_VERSION}/dist/jspdf.umd.min.js`
  ]).then(() => {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library loaded but is missing what it should export - try again.');
  }).catch(err => { _jspdfLoaded = null; throw err; });
  return _jspdfLoaded;
}
async function ensureHtmlDocx() {
  if (_htmlDocxLoaded) return _htmlDocxLoaded;
  _htmlDocxLoaded = exporterLoadScript(HTML_DOCX_URL).then(() => {
    if (!window.htmlDocx) throw new Error('Word export library did not load correctly.');
  }).catch(err => { _htmlDocxLoaded = null; throw err; });
  return _htmlDocxLoaded;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeFilename(s) {
  return (s || 'export').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'export';
}

// Very small markdown -> HTML step for PDF/DOCX bodies - reuses the same
// rules App.renderMarkdown already applies for on-screen bubbles, so a
// downloaded doc looks like what you saw in chat.
function markdownToHtml(raw) {
  return window.App ? App.renderMarkdown(raw) : raw.replace(/\n/g, '<br>');
}

const Exporter = {
  downloadText(content, title, ext) {
    const mime = ext === 'md' ? 'text/markdown' : 'text/plain';
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    triggerDownload(blob, `${safeFilename(title)}.${ext}`);
  },

  async downloadPdf(content, title) {
    await ensureJsPdf();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const marginX = 48, marginTop = 56, maxWidth = 500;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text(title || 'Export', marginX, marginTop);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    const plain = content.replace(/```([\s\S]*?)```/g, '$1').replace(/[*_`#]/g, '');
    const lines = doc.splitTextToSize(plain, maxWidth);
    let y = marginTop + 28;
    const lineHeight = 15;
    const pageBottom = 780;
    for (const line of lines) {
      if (y > pageBottom) { doc.addPage(); y = marginTop; }
      doc.text(line, marginX, y);
      y += lineHeight;
    }
    doc.save(`${safeFilename(title)}.pdf`);
  },

  async downloadDocx(content, title) {
    await ensureHtmlDocx();
    const bodyHtml = markdownToHtml(content);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title || 'Export'}</title></head>
      <body><h2>${title || 'Export'}</h2>${bodyHtml}</body></html>`;
    const blob = window.htmlDocx.asBlob(html);
    triggerDownload(blob, `${safeFilename(title)}.docx`);
  },

  // Whole-session study-notes export: every turn, clearly labeled, in one doc.
  buildSessionBody(sessionTitle, messages) {
    const visible = messages.filter(m => !m.isError);
    const parts = visible.map(m => {
      const who = m.role === 'user' ? 'You' : (m.role === 'system' ? 'System' : (m.nickname || 'AI'));
      return `**${who}:**\n${m.content}`;
    });
    return `# ${sessionTitle}\n\n` + parts.join('\n\n---\n\n');
  },

  async downloadSession(sessionTitle, messages, format) {
    const body = Exporter.buildSessionBody(sessionTitle, messages);
    if (format === 'pdf') return Exporter.downloadPdf(body, sessionTitle);
    if (format === 'docx') return Exporter.downloadDocx(body, sessionTitle);
    return Exporter.downloadText(body, sessionTitle, format === 'md' ? 'md' : 'txt');
  },

  async downloadMessage(message, format) {
    const title = (message.nickname || 'reply') + '-' + new Date(message.timestamp || Date.now()).toISOString().slice(0, 10);
    if (format === 'pdf') return Exporter.downloadPdf(message.content, title);
    if (format === 'docx') return Exporter.downloadDocx(message.content, title);
    return Exporter.downloadText(message.content, title, format === 'md' ? 'md' : 'txt');
  }
};

