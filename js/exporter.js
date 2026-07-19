// Turns a message or a whole session into a downloadable file. Everything
// runs in-browser - nothing is uploaded anywhere just to export it.
// PDF uses jsPDF, DOCX uses html-docx-js - both loaded lazily from a CDN,
// same pattern as pdf.js/mammoth in fileHandler.js, so there's no bundler
// and no extra weight until you actually hit "download".

const JSPDF_VERSION = '2.5.2';
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
    s.onerror = () => reject(new Error('Could not load ' + src + ' - check your internet connection.'));
    document.head.appendChild(s);
  });
}

async function ensureJsPdf() {
  if (_jspdfLoaded) return _jspdfLoaded;
  _jspdfLoaded = exporterLoadScript(`https://cdnjs.cloudflare.com/ajax/libs/jspdf/${JSPDF_VERSION}/jspdf.umd.min.js`).then(() => {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library did not load correctly.');
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
