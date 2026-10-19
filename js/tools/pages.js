/* Pdfroo page tools — split / extract pages, images -> PDF, PDF -> images.
 * Self-contained: uses only pdf-lib and pdf.js (already shipped). Everything runs on this device.
 * Entry points: buttons #landingSplitBtn, #landingImg2PdfBtn, #landingPdf2ImgBtn. Public API: window.PdfrooPages. */
(function (root) {
  'use strict';
  const L = () => root.PDFLib;

  /* ---------- pure helpers (exported for tests) ---------- */
  /** "1-3, 5, 8-" -> [[0,1,2],[4],[7..n-1]] (0-based groups). Throws on bad input. */
  function parseRanges(spec, n) {
    const groups = [];
    for (const raw of String(spec || '').split(/[,;]+/)) {
      const s = raw.trim(); if (!s) continue;
      const m = s.match(/^(\d*)\s*[-–]\s*(\d*)$/) || s.match(/^(\d+)$/);
      if (!m) throw new Error('Can’t read “' + s + '”. Use page numbers like 1-3, 5');
      let a, b;
      if (m.length === 2) a = b = +m[1]; else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
      if (a < 1 || b > n || a > b) throw new Error('“' + s + '” is outside pages 1–' + n);
      const g = []; for (let i = a; i <= b; i++) g.push(i - 1); groups.push(g);
    }
    if (!groups.length) throw new Error('Type which pages, like 1-3, 5');
    return groups;
  }
  function everyN(n, k) { const g = []; for (let i = 0; i < n; i += k) { const x = []; for (let j = i; j < Math.min(n, i + k); j++) x.push(j); g.push(x); } return g; }
  function label(g) { return g.length === 1 ? String(g[0] + 1) : (g[0] + 1) + '-' + (g[g.length - 1] + 1); }
  function baseName(name) { return String(name || 'document').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_') || 'document'; }

  /** Copy page groups into new PDFs. Keeps text, fonts, links and form fields as real PDF objects (no re-render). */
  async function splitPdf(bytes, groups) {
    const src = await L().PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    const out = [];
    for (const g of groups) {
      const d = await L().PDFDocument.create();
      const pages = await d.copyPages(src, g);
      pages.forEach((p) => d.addPage(p));
      d.setProducer('Pdfroo (pdf-lib)'); d.setCreator('Pdfroo');
      out.push({ pages: g, bytes: await d.save({ useObjectStreams: true }) });
    }
    return out;
  }
  /** One PDF with the chosen pages only (extract). */
  async function extractPdf(bytes, groups) { const flat = [...new Set(groups.flat())]; return (await splitPdf(bytes, [flat]))[0].bytes; }

  /* page sizes in pt */
  const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
  async function decodeToCanvasBytes(file) {
    // PNG/JPEG embed directly; anything else (WebP, HEIC the browser can show, GIF) is redrawn to PNG first.
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0); bmp.close && bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png' };
  }
  /** Is the JPEG EXIF-rotated? pdf-lib ignores EXIF, so rotated phone photos must be redrawn. */
  function jpegOrientation(u8) {
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return 1;
    let p = 2;
    while (p + 4 < u8.length) {
      if (u8[p] !== 0xFF) return 1;
      const mk = u8[p + 1], len = (u8[p + 2] << 8) | u8[p + 3];
      if (mk === 0xE1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78) {
        const t = p + 10, le = u8[t] === 0x49, r16 = (o) => le ? u8[o] | (u8[o + 1] << 8) : (u8[o] << 8) | u8[o + 1];
        const r32 = (o) => le ? (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0 : ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
        const ifd = t + r32(t + 4), cnt = r16(ifd);
        for (let i = 0; i < cnt; i++) { const e = ifd + 2 + i * 12; if (r16(e) === 0x0112) return r16(e + 8); }
        return 1;
      }
      if (mk === 0xDA) return 1;
      p += 2 + len;
    }
    return 1;
  }
  /** files: File[] (in order). opts: { size: 'fit'|'a4'|'letter', margin: pt }. Original JPEG/PNG bytes are kept, no quality loss. */
  async function imagesToPdf(files, opts) {
    const o = Object.assign({ size: 'fit', margin: 0 }, opts || {}), d = await L().PDFDocument.create();
    for (const f of files) {
      let u8 = new Uint8Array(await f.arrayBuffer()), img;
      const isJpg = u8[0] === 0xFF && u8[1] === 0xD8, isPng = u8[0] === 0x89 && u8[1] === 0x50;
      try {
        if (isJpg && jpegOrientation(u8) === 1) img = await d.embedJpg(u8);
        else if (isPng) img = await d.embedPng(u8);
        else { const r = await decodeToCanvasBytes(f); img = await d.embedPng(r.bytes); }
      } catch (e) { throw new Error('Couldn’t read the image “' + f.name + '”'); }
      let pw, ph;
      if (o.size === 'fit') { pw = img.width * 0.75 + 2 * o.margin; ph = img.height * 0.75 + 2 * o.margin; }   // 96 dpi -> pt
      else { [pw, ph] = SIZES[o.size] || SIZES.a4; if (img.width > img.height) [pw, ph] = [ph, pw]; }
      const page = d.addPage([pw, ph]), aw = pw - 2 * o.margin, ah = ph - 2 * o.margin;
      const s = Math.min(aw / img.width, ah / img.height), w = img.width * s, h = img.height * s;
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
    d.setProducer('Pdfroo (pdf-lib)'); d.setCreator('Pdfroo');
    return d.save({ useObjectStreams: true });
  }
  /** Render pages to PNG/JPEG blobs with pdf.js. dpi 72–300. onProgress(i, n). */
  async function pdfToImages(bytes, opts, onProgress) {
    const o = Object.assign({ dpi: 150, type: 'image/png', quality: 0.92, pages: null }, opts || {});
    const pdf = await root.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise, out = [];
    const list = o.pages || Array.from({ length: pdf.numPages }, (_, i) => i);
    try {
      for (let k = 0; k < list.length; k++) {
        const pg = await pdf.getPage(list[k] + 1), vp = pg.getViewport({ scale: o.dpi / 72 });
        // keep canvases under ~32 MP so phones don't run out of memory
        const cap = Math.min(1, Math.sqrt(32e6 / (vp.width * vp.height))), v = cap < 1 ? pg.getViewport({ scale: (o.dpi / 72) * cap }) : vp;
        const c = document.createElement('canvas'); c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: ctx, viewport: v, annotationMode: root.pdfjsLib.AnnotationMode ? root.pdfjsLib.AnnotationMode.ENABLE_FORMS : undefined }).promise;
        const blob = await new Promise((r) => c.toBlob(r, o.type, o.quality));
        out.push({ page: list[k], bytes: new Uint8Array(await blob.arrayBuffer()) });
        c.width = c.height = 0; pg.cleanup();
        onProgress && onProgress(k + 1, list.length);
      }
    } finally { await pdf.destroy(); }
    return out;
  }

  /* ---------- tiny stored zip (same format as Find & replace export) ---------- */
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (d) => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name); off += 30 + name.length + data.length;
    }
    const csize = central.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]), out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0;
    all.forEach((b) => { out.set(b, p); p += b.length; }); return out;
  }

  root.PdfrooPages = { parseRanges, everyN, label, baseName, splitPdf, extractPdf, imagesToPdf, pdfToImages, makeZip, jpegOrientation };
  if (typeof document === 'undefined') return;

  /* ---------- UI: one small dialog, phone-first, same look as Compress ---------- */
  const el = (t, a, ...kids) => { const n = document.createElement(t); for (const k in a || {}) { if (k.startsWith('on')) n.addEventListener(k.slice(2), a[k]); else if (a[k] !== false && a[k] != null) n.setAttribute(k, a[k] === true ? '' : a[k]); } kids.flat().forEach((c) => c != null && n.append(c)); return n; };
  function save(data, name, type) {
    const url = URL.createObjectURL(new Blob([data], { type })), a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function pick(accept, multiple) {
    return new Promise((res) => { const i = el('input', { type: 'file', accept, multiple: multiple || false, hidden: true }); i.addEventListener('change', () => { res([...i.files]); i.remove(); }); document.body.append(i); i.click(); });
  }
  let dlg;
  function open(title, body) {
    if (!dlg) { dlg = el('dialog', { class: 'dialog pt-dialog', 'aria-labelledby': 'ptTitle' }); document.body.append(dlg); dlg.addEventListener('close', () => dlg.replaceChildren()); }
    const close = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕');
    dlg.replaceChildren(el('div', { class: 'dialog-inner pt-inner' }, el('div', { class: 'dialog-head pt-head' }, el('h2', { id: 'ptTitle' }, title), close), body));
    if (!dlg.open) dlg.showModal();
  }
  const msg = () => el('p', { class: 'pt-msg', role: 'status', 'aria-live': 'polite' });

  async function splitFlow() {
    const [f] = await pick('application/pdf,.pdf'); if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer()); let n;
    try { n = (await L().PDFDocument.load(bytes)).getPageCount(); }
    catch (e) { open('Split or extract pages', el('p', { class: 'pt-msg bad' }, /encrypt/i.test(e.message) ? 'This PDF is password-protected, so its pages can’t be copied.' : 'This file doesn’t look like a PDF Pdfroo can read.')); return; }
    const name = baseName(f.name), out = msg();
    const mode = el('div', { class: 'pt-seg', role: 'radiogroup' });
    const modes = [['extract', 'Extract pages'], ['ranges', 'Split by ranges'], ['every', 'Split every N pages']];
    const range = el('input', { class: 'pt-input', inputmode: 'numeric', placeholder: 'e.g. 1-3, 5', 'aria-label': 'Pages' });
    const nIn = el('input', { class: 'pt-input', type: 'number', min: 1, max: n, value: 1, inputmode: 'numeric', 'aria-label': 'Pages per file' });
    let cur = 'extract';
    const hint = el('p', { class: 'pt-hint' });
    const sync = () => { [...mode.children].forEach((b) => b.setAttribute('aria-checked', b.dataset.v === cur)); range.hidden = cur === 'every'; nIn.hidden = cur !== 'every';
      hint.textContent = cur === 'extract' ? 'One new PDF with only these pages.' : cur === 'ranges' ? 'One PDF for each range, downloaded as a zip.' : 'Cuts the file into equal parts, downloaded as a zip.'; out.textContent = ''; };
    modes.forEach(([v, t]) => mode.append(el('button', { type: 'button', role: 'radio', 'data-v': v, class: 'pt-chip', onclick: () => { cur = v; sync(); } }, t)));
    const go = el('button', { type: 'button', class: 'btn btn-primary pt-go', onclick: async () => {
      out.className = 'pt-msg'; go.disabled = true;
      try {
        const groups = cur === 'every' ? everyN(n, Math.max(1, Math.min(n, +nIn.value | 0))) : parseRanges(range.value, n);
        out.textContent = 'Working…';
        if (cur === 'extract') { save(await extractPdf(bytes, groups), name + '-pages-' + groups.map(label).join('_').slice(0, 60) + '.pdf', 'application/pdf'); out.textContent = 'Downloaded.'; }
        else { const parts = await splitPdf(bytes, groups); save(makeZip(parts.map((p) => ({ name: name + '-p' + label(p.pages) + '.pdf', data: p.bytes }))), name + '-split.zip', 'application/zip'); out.textContent = parts.length + ' PDFs downloaded as a zip.'; }
      } catch (e) { out.className = 'pt-msg bad'; out.textContent = e.message || String(e); }
      finally { go.disabled = false; }
    } }, 'Download');
    range.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    sync();
    open('Split or extract pages', el('div', { class: 'pt-body' }, el('p', { class: 'pt-file' }, f.name + ' · ' + n + (n === 1 ? ' page' : ' pages')), mode, range, nIn, hint, go, out));
  }

  async function img2pdfFlow() {
    const files = await pick('image/jpeg,image/png,image/webp,image/gif,image/*', true); if (!files.length) return;
    const list = el('ol', { class: 'pt-list' }), out = msg();
    const render = () => { list.replaceChildren(...files.map((f, i) => el('li', null, el('span', { class: 'pt-name' }, f.name),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; render(); } }, '↑'),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move down', disabled: i === files.length - 1, onclick: () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; render(); } }, '↓'),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove', onclick: () => { files.splice(i, 1); files.length ? render() : dlg.close(); } }, '✕')))); };
    const size = el('select', { class: 'pt-input', 'aria-label': 'Page size' }, el('option', { value: 'fit' }, 'Page fits each image'), el('option', { value: 'a4' }, 'A4'), el('option', { value: 'letter' }, 'US Letter'));
    const marg = el('label', { class: 'pt-check' }, el('input', { type: 'checkbox' }), ' White margin');
    const go = el('button', { type: 'button', class: 'btn btn-primary pt-go', onclick: async () => {
      go.disabled = true; out.className = 'pt-msg'; out.textContent = 'Working…';
      try { const b = await imagesToPdf(files, { size: size.value, margin: marg.firstChild.checked ? 28 : 0 }); save(b, baseName(files[0].name.replace(/\.[^.]+$/, '')) + (files.length > 1 ? '-and-' + (files.length - 1) + '-more' : '') + '.pdf', 'application/pdf'); out.textContent = 'Downloaded: ' + files.length + (files.length === 1 ? ' page.' : ' pages.'); }
      catch (e) { out.className = 'pt-msg bad'; out.textContent = e.message || String(e); }
      finally { go.disabled = false; }
    } }, 'Make PDF');
    render();
    open('Images to PDF', el('div', { class: 'pt-body' }, el('p', { class: 'pt-hint' }, 'Photos keep their full quality. Use the arrows to change the order.'), list, size, marg, go, out));
  }

  async function pdf2imgFlow() {
    const [f] = await pick('application/pdf,.pdf'); if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer()), name = baseName(f.name), out = msg();
    const fmt = el('select', { class: 'pt-input', 'aria-label': 'Format' }, el('option', { value: 'image/png' }, 'PNG (sharp text)'), el('option', { value: 'image/jpeg' }, 'JPG (smaller files)'));
    const dpi = el('select', { class: 'pt-input', 'aria-label': 'Quality' }, el('option', { value: 96 }, 'Screen (96 dpi)'), el('option', { value: 150, selected: true }, 'Standard (150 dpi)'), el('option', { value: 300 }, 'Print (300 dpi)'));
    const range = el('input', { class: 'pt-input', inputmode: 'numeric', placeholder: 'All pages, or e.g. 1-3, 5', 'aria-label': 'Pages' });
    const go = el('button', { type: 'button', class: 'btn btn-primary pt-go', onclick: async () => {
      go.disabled = true; out.className = 'pt-msg';
      try {
        const pdf = await root.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise, n = pdf.numPages; await pdf.destroy();
        const pages = range.value.trim() ? [...new Set(parseRanges(range.value, n).flat())] : null;
        const ext = fmt.value === 'image/png' ? 'png' : 'jpg';
        const imgs = await pdfToImages(bytes, { dpi: +dpi.value, type: fmt.value, pages }, (i, t) => { out.textContent = 'Page ' + i + ' of ' + t + '…'; });
        if (imgs.length === 1) save(imgs[0].bytes, name + '-page' + (imgs[0].page + 1) + '.' + ext, fmt.value);
        else save(makeZip(imgs.map((x) => ({ name: name + '-page' + String(x.page + 1).padStart(String(n).length, '0') + '.' + ext, data: x.bytes }))), name + '-images.zip', 'application/zip');
        out.textContent = imgs.length === 1 ? 'Downloaded.' : imgs.length + ' images downloaded as a zip.';
      } catch (e) { out.className = 'pt-msg bad'; out.textContent = /password/i.test(e.name + e.message) ? 'This PDF is password-protected.' : (e.message || String(e)); }
      finally { go.disabled = false; }
    } }, 'Download images');
    open('PDF to images', el('div', { class: 'pt-body' }, el('p', { class: 'pt-file' }, f.name), fmt, dpi, range, go, out));
  }

  const bind = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', () => fn().catch((e) => console.error(e))); };
  const init = () => { bind('landingSplitBtn', splitFlow); bind('landingImg2PdfBtn', img2pdfFlow); bind('landingPdf2ImgBtn', pdf2imgFlow); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
