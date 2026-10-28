function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

// Receives only local object URLs created after checking file signatures.
// The iframe/image never contacts USPTO, including when zooming or scrolling.
export class FileViewer {
  constructor(root) {
    this.root = root; this.asset = null; this.zoom = 1; this.rotation = 0;
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.layoutImage()) : null;
    this.observer?.observe(root);
  }
  clear() { this.asset = null; this.image = null; this.stage = null; this.scroller = null; this.root.classList.remove('is-expanded'); this.root.replaceChildren(); }
  show(asset, { title, description = '', date = '', onSave } = {}) {
    this.clear(); this.asset = asset; this.zoom = 1; this.rotation = 0;
    const header = node('div', 'viewer-heading');
    header.append(node('h3', '', title || 'Document preview'));
    if (description) header.append(node('p', 'document-description', description));
    if (date) header.append(node('p', 'small', 'Document date: ' + date));
    header.append(node('p', 'small', 'Retrieved ' + asset.retrievedAt.toLocaleString()));
    this.root.append(header);
    if (asset.kind === 'unsupported' || !asset.url) {
      this.root.append(node('p', 'notice', ['tiff', 'zip'].includes(asset.extension)
        ? 'This original is a ' + asset.extension.toUpperCase() + ' file. In-app preview is unavailable for this format.'
        : 'This file is not a supported PDF or image. Open official TSDR to inspect the original.'));
      if (asset.url && onSave) { const save = node('button', 'secondary', 'Save original'); save.type = 'button'; save.onclick = onSave; this.root.append(save); }
      return;
    }
    const toolbar = node('div', 'reader-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Reader controls');
    const button = (text, handler) => { const b = node('button', 'secondary', text); b.type = 'button'; b.onclick = handler; toolbar.append(b); return b; };
    const expand = button('Expand reader', () => {
      const expanded = this.root.classList.toggle('is-expanded');
      expand.textContent = expanded ? 'Compact reader' : 'Expand reader'; expand.setAttribute('aria-pressed', String(expanded));
      this.layoutImage();
    });
    expand.setAttribute('aria-pressed', 'false');
    const scroller = node('div', 'reader-scroller'); this.scroller = scroller;
    if (asset.kind === 'pdf') {
      toolbar.append(node('span', 'small', 'Scroll, zoom and search using the PDF toolbar.'));
      const frame = node('iframe', 'pdf-frame'); frame.title = title || 'Official PDF reader';
      frame.referrerPolicy = 'no-referrer'; frame.src = asset.url + '#view=FitH';
      scroller.append(frame);
      if (navigator.pdfViewerEnabled === false) {
        this.root.append(node('p', 'notice', 'This browser may not support embedded PDFs. Use Open official TSDR above to view the file.'));
      }
    } else {
      const minus = button('−', () => { this.zoom = Math.max(0.25, this.zoom - 0.25); this.layoutImage(); }); minus.setAttribute('aria-label', 'Zoom out');
      const plus = button('+', () => { this.zoom = Math.min(4, this.zoom + 0.25); this.layoutImage(); }); plus.setAttribute('aria-label', 'Zoom in');
      button('Fit width', () => { this.zoom = 1; this.layoutImage(); });
      button('Rotate', () => { this.rotation = (this.rotation + 90) % 360; this.layoutImage(); });
      const stage = node('div', 'image-stage'), image = node('img', 'document-image');
      this.stage = stage; this.image = image;
      image.alt = description || title || 'USPTO document image'; image.decoding = 'async';
      image.onload = () => this.layoutImage();
      image.onerror = () => { scroller.replaceChildren(node('p', 'notice error', 'The browser could not display this image. Open official TSDR for the original.')); };
      image.src = asset.url; stage.append(image); scroller.append(stage);
    }
    this.root.append(toolbar, scroller);
  }
  layoutImage() {
    if (!this.image?.naturalWidth || !this.scroller || !this.stage) return;
    const rotated = this.rotation % 180 !== 0;
    const available = Math.max(100, this.scroller.clientWidth - 32);
    const ratio = available / (rotated ? this.image.naturalHeight : this.image.naturalWidth) * this.zoom;
    const width = this.image.naturalWidth * ratio, height = this.image.naturalHeight * ratio;
    this.stage.style.width = (rotated ? height : width) + 'px'; this.stage.style.height = (rotated ? width : height) + 'px';
    this.image.style.width = width + 'px'; this.image.style.height = height + 'px';
    this.image.style.transform = 'translate(-50%, -50%) rotate(' + this.rotation + 'deg)';
  }
}
