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
    if ((att.type || '').startsWith('text/') || /\.(txt|md|csv|json|js|ts|jsx|tsx|py|html|css|xml|yaml|yml|log)$/i.test(att.name || '')) {
      container.innerHTML = `<div class="file-viewer-empty">This is a plain text file - extracted text (left) is the original, unmodified.</div>`;
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
