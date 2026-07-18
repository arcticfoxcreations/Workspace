// Everything here runs entirely in the browser. Nothing is ever uploaded to
// the Worker - files are read, extracted, and (for the small ones) stored
// locally in IndexedDB. Nothing leaves your device except the extracted TEXT,
// which gets sent to whichever AI you're chatting with, same as typed text.

const AUTO_DELETE_RAW_ABOVE_BYTES = 10 * 1024 * 1024; // 10MB
const SOFT_WARN_ABOVE_BYTES = 60 * 1024 * 1024; // 50-80MB range, picked 60MB
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500MB
const MAX_FILES_HEAVY = 20;
const MAX_FILES_LIGHT = 30;
const LIGHT_FILE_THRESHOLD = 2 * 1024 * 1024; // under this = "small" (images etc.)

let _pdfjsLoaded = null;
let _mammothLoaded = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { existing.addEventListener('load', resolve); if (existing.dataset.loaded) resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ensurePdfJs() {
  if (_pdfjsLoaded) return _pdfjsLoaded;
  _pdfjsLoaded = loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.js').then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js';
  });
  return _pdfjsLoaded;
}
async function ensureMammoth() {
  if (_mammothLoaded) return _mammothLoaded;
  _mammothLoaded = loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.7.0/mammoth.browser.min.js');
  return _mammothLoaded;
}

const FileHandler = {
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

  // Extracts text from a file, calling onProgress(0..1) as it goes.
  // Returns { text, keepRaw, base64 (if keepRaw) }.
  async extract(file, onProgress) {
    onProgress && onProgress(0);
    let text = '';

    if (FileHandler.isImage(file)) {
      // Images aren't text-extracted - vision-capable providers get the
      // base64 directly instead.
      const base64 = await FileHandler.readAsBase64(file, onProgress);
      onProgress && onProgress(1);
      return { text: '', imageBase64: base64, keepRaw: true };
    }

    const n = file.name.toLowerCase();
    const type = (file.type || '').toLowerCase();

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
    } else if (type.includes('wordprocessingml') || n.endsWith('.docx')) {
      await ensureMammoth();
      const buf = await file.arrayBuffer();
      const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
      text = result.value;
      onProgress && onProgress(1);
    } else {
      // plain text, markdown, csv, json, code files, etc. - read in chunks
      // so large text files don't block the UI thread all at once.
      text = await FileHandler.readTextInChunks(file, onProgress);
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
      reader.onerror = () => reject(reader.error);
      readNext();
    });
  },

  readAsBase64(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
};
