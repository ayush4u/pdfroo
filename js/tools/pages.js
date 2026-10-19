/* Pdfroo page tools — split / extract pages, images -> PDF, PDF -> images.
 * Self-contained: uses only pdf-lib and pdf.js (already shipped). Everything runs on this device.
 * Entry points: buttons #landingSplitBtn, #landingImg2PdfBtn, #landingPdf2ImgBtn. Public API: window.PdfrooPages. */
(function (root) {
  'use strict';
  const L = () => root.PDFLib;
  // same pdf.js setup as js/engine/pdfEngine.js (CMaps for CJK text, standard fonts for non-embedded fonts)
  const BASE = (function () { const s = typeof document !== 'undefined' && document.currentScript && document.currentScript.src; return s ? s.replace(/js\/tools\/pages\.js.*$/, '') : ''; })();
  const pdfjsOpen = (bytes) => root.pdfjsLib.getDocument({ data: bytes.slice(0), cMapUrl: BASE + 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'vendor/pdfjs/standard_fonts/', isEvalSupported: false, verbosity: root.pdfjsLib.VerbosityLevel ? root.pdfjsLib.VerbosityLevel.ERRORS : 0 }).promise;

  /* ---------- pure helpers (exported for tests) ---------- */
  /** "1-3, 5, 8-" or "1 3" -> [[0,1,2],[4],[7..n-1]] (0-based groups). Throws on bad input. */
  function parseRanges(spec, n) {
    const groups = [];
    for (const raw of String(spec || '').replace(/\s*[-–—]\s*/g, '-').split(/[,;\s]+/)) {
      const s = raw.trim(); if (!s) continue;
      const m = s.match(/^(\d*)-(\d*)$/) || s.match(/^(\d+)$/);
      if (!m || (m.length === 3 && !m[1] && !m[2])) throw new Error('Can’t read “' + s + '”. Use page numbers like 1-3, 5');
      let a, b;
      if (m.length === 2) a = b = +m[1]; else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
      if (a > b) throw new Error('In “' + s + '” the first page is after the last. Write it as ' + b + '-' + a);
      if (a < 1 || b > n) throw new Error('“' + s + '” is outside pages 1–' + n);
      const g = []; for (let i = a; i <= b; i++) g.push(i - 1); groups.push(g);
    }
    if (!groups.length) throw new Error('Type which pages, like 1-3, 5');
    return groups;
  }
  function everyN(n, k) { const g = []; for (let i = 0; i < n; i += k) { const x = []; for (let j = i; j < Math.min(n, i + k); j++) x.push(j); g.push(x); } return g; }
  function label(g) { return g.length === 1 ? String(g[0] + 1) : (g[0] + 1) + '-' + (g[g.length - 1] + 1); }
  function baseName(name) { return String(name || 'document').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_') || 'document'; }

  /* ---------- split / extract ---------- */
  /** Finds where internal links point. Returns { pageOf(annot) -> {arr, page} | null } (page -1 = internal but unresolvable). */
  function destResolver(src) {
    const { PDFName, PDFArray, PDFDict, PDFRef, PDFString, PDFHexString } = L(), ctx = src.context, look = (o) => ctx.lookup(o);
    const N = (s) => PDFName.of(s), pageIdx = new Map(src.getPages().map((p, i) => [p.ref.toString(), i]));
    const names = look(src.catalog.get(N('Names'))), tree = names instanceof PDFDict ? names.get(N('Dests')) : undefined, dests = look(src.catalog.get(N('Dests')));
    const inTree = (node, key, depth) => {
      node = look(node); if (!(node instanceof PDFDict) || depth > 32) return undefined;
      const arr = look(node.get(N('Names')));
      if (arr instanceof PDFArray) for (let i = 0; i + 1 < arr.size(); i += 2) { const k = look(arr.get(i)); if (k && k.decodeText && k.decodeText() === key) return arr.get(i + 1); }
      const kids = look(node.get(N('Kids')));
      if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) { const r = inTree(kids.get(i), key, depth + 1); if (r !== undefined) return r; }
      return undefined;
    };
    const explicit = (d) => {
      d = look(d); let v = d;
      if (d instanceof PDFName) { v = dests instanceof PDFDict ? dests.get(d) : undefined; if (v === undefined && tree) v = inTree(tree, d.decodeText(), 0); }
      else if (d instanceof PDFString || d instanceof PDFHexString) { const k = d.decodeText(); v = tree ? inTree(tree, k, 0) : undefined; if (v === undefined && dests instanceof PDFDict) v = dests.get(N(k)); }
      v = look(v); if (v instanceof PDFDict) v = look(v.get(N('D')));
      return v instanceof PDFArray ? v : null;
    };
    return function target(annot) {
      let d = annot.get(N('Dest')), viaAction = false; const act = look(annot.get(N('A')));
      if (d === undefined && act instanceof PDFDict && act.get(N('S')) === N('GoTo')) { d = act.get(N('D')); viaAction = true; }
      if (d === undefined) return null;
      const arr = explicit(d), first = arr && arr.get(0);
      return { arr, viaAction, page: first instanceof PDFRef && pageIdx.has(first.toString()) ? pageIdx.get(first.toString()) : -1 };
    };
  }

  /** Copy page groups into new PDFs. Keeps text, fonts, links, form fields and document info as real PDF objects (no re-render).
   *  Links to pages outside a part are dropped, links inside it are re-pointed, and the form is rebuilt from the fields that survive. */
  async function splitPdf(bytes, groups) {
    const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, PDFPage, PDFObjectCopier } = L(), N = (s) => PDFName.of(s);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    const sctx = src.context, look = (o) => sctx.lookup(o), srcPages = src.getPages(), target = destResolver(src);
    const srcAF = look(src.catalog.get(N('AcroForm')));
    const out = [];
    for (const g of groups) {
      const d = await PDFDocument.create({ updateMetadata: false }), dctx = d.context, copier = PDFObjectCopier.for(sctx, dctx);
      const newIdx = new Map(); g.forEach((p, k) => { if (!newIdx.has(p)) newIdx.set(p, k); });
      const undo = [], metas = [];
      const tmp = (dict, key, val) => { const k = N(key), old = dict.get(k); undo.push(() => (old === undefined ? dict.delete(k) : dict.set(k, old))); if (val === undefined) dict.delete(k); else dict.set(k, val); };
      let pages;
      try {
        // 1. On the source (temporarily): cut every back-reference that would drag other pages along (/P, widget /Parent, beads),
        //    drop links to pages outside this part, and mark links inside it with the new page index.
        for (const si of g) {
          const node = srcPages[si].node, meta = []; metas.push(meta);
          if (node.get(N('B'))) tmp(node, 'B', undefined);
          const annots = look(node.get(N('Annots')));
          if (!(annots instanceof PDFArray)) continue;
          const kept = sctx.obj([]);
          for (let i = 0; i < annots.size(); i++) {
            const entry = annots.get(i), a = look(entry); if (!(a instanceof PDFDict)) continue;
            const sub = a.get(N('Subtype')), m = { hadP: false, link: null, parent: null, root: false };
            if (sub === N('Link')) {
              const t = target(a);
              if (t) {
                if (t.page < 0 || !newIdx.has(t.page)) continue;                 // points outside the part (or nowhere): drop it
                const arr = sctx.obj([PDFNumber.of(newIdx.get(t.page))]); for (let j = 1; j < t.arr.size(); j++) arr.push(t.arr.get(j));
                tmp(a, 'Dest', arr); if (t.viaAction) tmp(a, 'A', undefined); m.link = newIdx.get(t.page);
              }
            }
            if (a.get(N('P')) !== undefined) { m.hadP = true; tmp(a, 'P', undefined); }
            if (sub === N('Widget')) {
              const par = a.get(N('Parent'));
              if (par instanceof PDFRef) { m.parent = par; tmp(a, 'Parent', undefined); }
              else if (a.get(N('FT')) !== undefined || a.get(N('T')) !== undefined) m.root = true;   // widget merged with its field
            }
            kept.push(entry); meta.push(m);
          }
          tmp(node, 'Annots', kept);
        }
        // 2. Copy the pages with one copier (shared fonts/images are copied once).
        pages = g.map((si) => { const c = copier.copy(srcPages[si].node), ref = dctx.register(c), p = PDFPage.of(c, ref, d); d.addPage(p); return p; });
      } finally { for (let i = undo.length - 1; i >= 0; i--) undo[i](); }

      // 3. Re-point links and /P, rebuild the field tree from the widgets that came along.
      const fieldMemo = new Map(), roots = [];
      const field = (srcRef) => {
        const key = srcRef.toString(); if (fieldMemo.has(key)) return fieldMemo.get(key);
        const f = look(srcRef), nd = dctx.obj({});
        if (f instanceof PDFDict) for (const [k, v] of f.entries()) if (k !== N('Kids') && k !== N('Parent') && k !== N('P')) nd.set(k, copier.copy(v));
        nd.set(N('Kids'), dctx.obj([])); const ref = dctx.register(nd); fieldMemo.set(key, ref);
        const par = f instanceof PDFDict ? f.get(N('Parent')) : undefined;
        if (par instanceof PDFRef) { const pr = field(par); nd.set(N('Parent'), pr); dctx.lookup(pr).get(N('Kids')).push(ref); } else roots.push(ref);
        return ref;
      };
      pages.forEach((p, k) => {
        const annots = dctx.lookup(p.node.get(N('Annots'))), meta = metas[k]; if (!(annots instanceof PDFArray)) return;
        for (let i = 0; i < annots.size(); i++) {
          const entry = annots.get(i), a = dctx.lookup(entry), m = meta[i]; if (!m || !(a instanceof PDFDict)) continue;
          if (m.hadP) a.set(N('P'), p.ref);
          if (m.link !== null) dctx.lookup(a.get(N('Dest'))).set(0, pages[m.link].ref);
          if (m.parent && entry instanceof PDFRef) { const fr = field(m.parent); a.set(N('Parent'), fr); dctx.lookup(fr).get(N('Kids')).push(entry); }
          else if (m.root && entry instanceof PDFRef) roots.push(entry);
        }
      });
      if (roots.length) {
        const af = dctx.obj({});
        if (srcAF instanceof PDFDict) for (const [k, v] of srcAF.entries()) {
          if (k === N('Fields') || k === N('XFA')) continue;                         // XFA would no longer match the fields
          if (k === N('CO')) { const co = look(v), keep = dctx.obj([]); if (co instanceof PDFArray) for (let i = 0; i < co.size(); i++) { const r = co.get(i); if (r instanceof PDFRef && fieldMemo.has(r.toString())) keep.push(fieldMemo.get(r.toString())); } if (keep.size()) af.set(k, keep); continue; }
          af.set(k, copier.copy(v));
        }
        af.set(N('Fields'), dctx.obj(roots)); d.catalog.set(N('AcroForm'), dctx.register(af));
      }
      // 4. Document info, XMP metadata and language.
      const info = sctx.trailerInfo.Info;
      if (info instanceof PDFRef && look(info) instanceof PDFDict) dctx.trailerInfo.Info = copier.copy(info);
      else if (info instanceof PDFDict) dctx.trailerInfo.Info = dctx.register(copier.copy(info));
      for (const k of ['Metadata', 'Lang']) { const v = src.catalog.get(N(k)); if (v !== undefined) d.catalog.set(N(k), copier.copy(v)); }
      d.setProducer('Pdfroo (pdf-lib)'); d.setModificationDate(new Date());
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
    const k = Math.min(1, Math.sqrt(16e6 / (bmp.width * bmp.height)));   // iOS Safari canvases fail above ~16.7 MP
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png' };
  }
  /** EXIF orientation (1-8) of a JPEG. pdf-lib ignores EXIF, so imagesToPdf turns the page content instead. */
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
      let ori = 1;
      try {
        if (isJpg) { ori = jpegOrientation(u8); if (!(ori >= 1 && ori <= 8)) ori = 1; img = await d.embedJpg(u8); }   // original bytes, never re-encoded
        else if (isPng) img = await d.embedPng(u8);
        else { const r = await decodeToCanvasBytes(f); img = await d.embedPng(r.bytes); }
      } catch (e) { throw new Error('Couldn’t read the image “' + f.name + '”'); }
      const swap = ori >= 5, iw = swap ? img.height : img.width, ih = swap ? img.width : img.height;   // size as displayed
      let pw, ph;
      if (o.size === 'fit') { pw = iw * 0.75 + 2 * o.margin; ph = ih * 0.75 + 2 * o.margin; }   // 96 dpi -> pt
      else { [pw, ph] = SIZES[o.size] || SIZES.a4; if (iw > ih) [pw, ph] = [ph, pw]; }
      const page = d.addPage([pw, ph]), aw = pw - 2 * o.margin, ah = ph - 2 * o.margin;
      const s = Math.min(aw / iw, ah / ih), w = iw * s, h = ih * s, x = (pw - w) / 2, y = (ph - h) / 2;
      if (ori === 1) page.drawImage(img, { x, y, width: w, height: h });
      else {
        // map the image's unit square onto the box so it shows the way the camera meant (EXIF 2-8: mirror / rotate)
        const M = { 2: [-w, 0, 0, h, x + w, y], 3: [-w, 0, 0, -h, x + w, y + h], 4: [w, 0, 0, -h, x, y + h], 5: [0, -h, -w, 0, x + w, y + h],
          6: [0, -h, w, 0, x, y + h], 7: [0, h, w, 0, x, y], 8: [0, h, -w, 0, x + w, y] }[ori];
        page.pushOperators(L().pushGraphicsState(), L().concatTransformationMatrix(...M));
        page.drawImage(img, { x: 0, y: 0, width: 1, height: 1 });
        page.pushOperators(L().popGraphicsState());
      }
    }
    d.setProducer('Pdfroo (pdf-lib)'); d.setCreator('Pdfroo');
    return d.save({ useObjectStreams: true });
  }
  /** Render pages to PNG/JPEG blobs with pdf.js. dpi 72–300. onProgress(i, n). */
  async function pdfToImages(bytes, opts, onProgress) {
    const o = Object.assign({ dpi: 150, type: 'image/png', quality: 0.92, pages: null }, opts || {});
    const pdf = await pdfjsOpen(bytes), out = [];
    const list = o.pages || Array.from({ length: pdf.numPages }, (_, i) => i);
    try {
      for (let k = 0; k < list.length; k++) {
        const pg = await pdf.getPage(list[k] + 1), vp = pg.getViewport({ scale: o.dpi / 72 });
        // keep canvases under 16 MP: iOS Safari refuses canvases above ~16.7 MP
        const cap = Math.min(1, Math.sqrt(16e6 / (vp.width * vp.height))), v = cap < 1 ? pg.getViewport({ scale: (o.dpi / 72) * cap }) : vp;
        const c = document.createElement('canvas'); c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: ctx, viewport: v, annotationMode: root.pdfjsLib.AnnotationMode ? root.pdfjsLib.AnnotationMode.ENABLE_STORAGE : undefined }).promise;
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
    const enc = new TextEncoder(), parts = [], central = [], used = new Set(); let off = 0;
    for (const f of files) {
      let nm = f.name; for (let k = 2; used.has(nm.toLowerCase()); k++) nm = f.name.replace(/(\.[^./]*)?$/, (ext) => '-' + k + (ext || ''));
      used.add(nm.toLowerCase());
      const name = enc.encode(nm), data = f.data, crc = crc32(data), h = new DataView(new ArrayBuffer(30));
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
  /** Resolves with the chosen files, or [] when the picker is cancelled ('cancel' event, or focus coming back with nothing chosen). */
  function pick(accept, multiple) {
    return new Promise((res) => {
      const i = el('input', { type: 'file', accept, multiple: multiple || false, hidden: true }); let done = false;
      const finish = () => { if (done) return; done = true; window.removeEventListener('focus', onFocus); res([...(i.files || [])]); i.remove(); };
      const onFocus = () => setTimeout(() => { if (!i.files || !i.files.length) finish(); }, 1000);   // older browsers without 'cancel'
      i.addEventListener('change', finish); i.addEventListener('cancel', finish);
      document.body.append(i); i.click(); setTimeout(() => window.addEventListener('focus', onFocus), 0);
    });
  }
  let dlg;
  function open(title, body) {
    if (!dlg) { dlg = el('dialog', { class: 'dialog pt-dialog', 'aria-labelledby': 'ptTitle' }); document.body.append(dlg); dlg.addEventListener('close', () => { if (!dlg.open) dlg.replaceChildren(); }); }   // 'close' fires later; don't wipe a dialog reopened meanwhile
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
        else if (groups.length === 1) { const [p] = await splitPdf(bytes, groups); save(p.bytes, name + '-p' + label(p.pages) + '.pdf', 'application/pdf'); out.textContent = 'Downloaded.'; }
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
        const pdf = await pdfjsOpen(bytes), n = pdf.numPages; await pdf.destroy();
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
