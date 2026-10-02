/* ==========================================================================
   Pdfroo — PDF engine boundary
   --------------------------------------------------------------------------
   The ONLY place that talks to pdf.js (rendering) and pdf-lib (writing).
   UI code (app.js) calls window.PdfEngine exclusively, so the engine can be
   swapped later (e.g. for MuPDF.js to support in-place text editing) without
   touching the UI.

   Data model — a plain, JSON-serializable "document state" object:
     {
       version: 1,
       name: "file.pdf",
       pages: [ { id, src, index, w, h, baseRot, rot, annots: [ ... ] } ],
       assets: { [assetId]: { dataUrl, kind: "png"|"jpg" } }   // images/signatures
     }
   - src/index point at an original PDF source (bytes live inside the engine,
     keyed by src id, never inside the state) — src:null means a blank page.
   - w/h are the unrotated page size in PDF points; baseRot is the file's own
     /Rotate, rot is the user's extra rotation.
   - annots use "displayed page" coordinates in points (origin top-left,
     after rotation), e.g. {id,type:"rect",x,y,w,h,color,width}.
   The state can be saved anywhere (localStorage, Supabase, …) as JSON; the
   original PDF bytes can be persisted separately via getSourceBytes(src).
   ========================================================================== */
(function (root) {
  'use strict';

  const pdfjsLib = root.pdfjsLib;
  const BASE = (function () {
    const s = document.currentScript && document.currentScript.src;
    return s ? s.replace(/js\/engine\/pdfEngine\.js.*$/, '') : '';
  })();
  if (pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'vendor/pdfjs/pdf.worker.min.js';
  }

  const sources = {};          // srcId -> { id, name, bytes: Uint8Array, pdf: PDFDocumentProxy }
  let seq = 0;
  const uid = (p) => (p || 'id') + '_' + Date.now().toString(36) + '_' + (seq++).toString(36);

  /* ---------------- Loading ---------------- */

  /** Load PDF bytes; returns { src, name, pageCount, pages:[pageModel] } (pages not yet in any state). */
  async function load(bytes, name) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const keep = data.slice(0);                       // pdf.js may detach the buffer it gets
    const task = pdfjsLib.getDocument({
      data: data.slice(0),
      cMapUrl: BASE + 'vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: BASE + 'vendor/pdfjs/standard_fonts/',
      isEvalSupported: false,
      fontExtraProperties: true,                        // font flags/widths/toUnicode for text editing
      verbosity: pdfjsLib.VerbosityLevel ? pdfjsLib.VerbosityLevel.ERRORS : 0,   // keep the console clean
    });
    let pdf;
    try { pdf = await task.promise; }
    catch (err) {
      if (err && err.name === 'PasswordException') {
        throw userError(`“${name || 'This PDF'}” is password-protected, so Pdfroo can’t open it. Remove the password in your PDF app (or ask the sender for an unprotected copy) and try again.`, 'password');
      }
      throw userError(`“${name || 'This file'}” couldn’t be read — it may be damaged or not a real PDF.`, 'invalid');
    }
    // pdf.js happily renders PDFs that only have an *owner* password (permissions lock),
    // but pdf-lib cannot decrypt them, so exporting would produce scrambled pages.
    // Detect encryption up front and refuse clearly instead of exporting garbage.
    let libDoc = null;
    try {
      // Cheap pre-check (the /Encrypt entry lives in the trailer / xref-stream dictionary, which
      // is never compressed) so we don't make pdf-lib parse encrypted object streams.
      if (hasEncryptEntry(keep)) throw new root.PDFLib.EncryptedPDFError();
      libDoc = await root.PDFLib.PDFDocument.load(keep, { updateMetadata: false });
    } catch (err) {
      const encrypted = (root.PDFLib.EncryptedPDFError && err instanceof root.PDFLib.EncryptedPDFError) || /encrypt/i.test(String(err && err.message));
      if (encrypted) {
        try { pdf.destroy(); } catch (e) { /* ignore */ }
        throw userError(`“${name || 'This PDF'}” is encrypted (protected with edit/print restrictions), so Pdfroo can’t edit it yet. Open it in a PDF viewer, save or “Print to PDF” an unprotected copy, and try again.`, 'encrypted');
      }
      libDoc = null; // pdf-lib couldn't parse it; pdf.js could — let the user view it, export will report errors
    }
    const id = uid('src');
    let signature = null;
    try { signature = detectSignature(libDoc, keep); } catch (e) { signature = null; }
    sources[id] = { id, name: name || 'document.pdf', bytes: keep, pdf, libDoc, signature };
    const pages = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      pages.push(newPage({ src: id, index: i, w: vp.width, h: vp.height, baseRot: page.rotate || 0 }));
    }
    return { src: id, name: sources[id].name, pageCount: pdf.numPages, pages, signature };
  }

  /**
   * Digital signatures. Returns null for an unsigned file, otherwise
   * { signed, certified, docMdpP, usageRights, fields:[{name, signer, date, reason, certification}] }.
   * Signed = an AcroForm field with /FT /Sig that carries a /V signature dictionary; certified =
   * a DocMDP signature (/Perms /DocMDP or a /Reference with TransformMethod DocMDP). /Perms /UR3
   * (Reader usage rights) is also reported — any change breaks those too.
   */
  function detectSignature(libDoc, bytes) {
    if (!libDoc) {                                   // pdf-lib couldn't parse: fall back to a byte scan
      const head = latin1Sample(bytes);
      return /\/ByteRange\s*\[/.test(head) && /\/Type\s*\/Sig\b|\/FT\s*\/Sig\b/.test(head) ? { signed: true, certified: /\/DocMDP/.test(head), docMdpP: null, usageRights: false, fields: [] } : null;
    }
    const L = root.PDFLib, N = (n) => L.PDFName.of(n), ctx = libDoc.context;
    const str = (o) => { try { if (!o) return ''; if (o.decodeText) return o.decodeText(); return String(o).replace(/^\//, ''); } catch (e) { return ''; } };
    const cat = libDoc.catalog;
    const fields = [];
    let certified = false, docMdpP = null;
    const af = cat.lookupMaybe(N('AcroForm'), L.PDFDict);
    const walk = (arr, prefix, inhFT, depth) => {
      if (!arr || depth > 20) return;
      for (let i = 0; i < arr.size(); i++) {
        const f = ctx.lookupMaybe(arr.get(i), L.PDFDict); if (!f) continue;
        const t = str(f.lookup(N('T')));
        const name = t ? (prefix ? prefix + '.' + t : t) : prefix;
        const ft = f.get(N('FT')) ? String(f.get(N('FT'))) : inhFT;
        const kids = f.lookupMaybe(N('Kids'), L.PDFArray);
        if (ft === '/Sig') {
          const v = f.lookupMaybe(N('V'), L.PDFDict);
          if (v) {
            let cert = false;
            const refs = v.lookupMaybe(N('Reference'), L.PDFArray);
            if (refs) for (let k = 0; k < refs.size(); k++) {
              const r = ctx.lookupMaybe(refs.get(k), L.PDFDict);
              if (r && String(r.get(N('TransformMethod'))) === '/DocMDP') {
                cert = true;
                const tp = r.lookupMaybe(N('TransformParams'), L.PDFDict);
                const pv = tp && tp.lookup(N('P'));
                if (pv && pv.asNumber) docMdpP = pv.asNumber();
              }
            }
            if (cert) certified = true;
            fields.push({ name: name || 'Signature', signer: str(v.lookup(N('Name'))), date: str(v.lookup(N('M'))), reason: str(v.lookup(N('Reason'))), certification: cert });
          }
        }
        if (kids) walk(kids, name, ft, depth + 1);
      }
    };
    if (af) walk(af.lookupMaybe(N('Fields'), L.PDFArray), '', null, 0);
    const perms = cat.lookupMaybe(N('Perms'), L.PDFDict);
    const usageRights = !!(perms && perms.get(N('UR3')));
    if (perms && perms.get(N('DocMDP'))) {
      certified = true;
      if (docMdpP == null) {
        const d = perms.lookupMaybe(N('DocMDP'), L.PDFDict);
        const refs = d && d.lookupMaybe(N('Reference'), L.PDFArray);
        const r = refs && ctx.lookupMaybe(refs.get(0), L.PDFDict);
        const tp = r && r.lookupMaybe(N('TransformParams'), L.PDFDict);
        const pv = tp && tp.lookup(N('P'));
        if (pv && pv.asNumber) docMdpP = pv.asNumber();
      }
    }
    if (!fields.length && !certified && !usageRights) return null;
    return { signed: fields.length > 0 || certified, certified, docMdpP, usageRights, fields };
  }
  function latin1Sample(bytes) {
    let out = '';
    for (let j = 0; j < bytes.length; j += 8192) out += String.fromCharCode.apply(null, bytes.subarray(j, Math.min(bytes.length, j + 8192)));
    return out;
  }
  function getSignatureInfo(src) { return sources[src] ? sources[src].signature : null; }

  function hasEncryptEntry(bytes) {
    // Latin-1 decode in chunks (fast, no allocation of a giant string for huge files).
    const re = /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/;
    const CH = 1 << 20, OV = 64;
    for (let i = 0; i < bytes.length; i += CH) {
      const end = Math.min(bytes.length, i + CH + OV);
      let str = '';
      for (let j = i; j < end; j += 8192) str += String.fromCharCode.apply(null, bytes.subarray(j, Math.min(end, j + 8192)));
      if (re.test(str)) return true;
    }
    return false;
  }

  function userError(message, code) { const e = new Error(message); e.userFacing = true; e.code = code; return e; }

  function getPageCount(src) { return sources[src] ? sources[src].pdf.numPages : 0; }
  function getSourceBytes(src) { return sources[src] ? sources[src].bytes : null; }
  function hasSource(src) { return !!sources[src]; }
  function closeAll() {
    Object.keys(sources).forEach((k) => { try { sources[k].pdf.destroy(); } catch (e) { /* ignore */ } delete sources[k]; });
    analysisCache.clear();
    previewCache.forEach((v) => v.then((p) => p.destroy()).catch(() => {})); previewCache.clear();
  }

  function newPage(o) {
    return { id: uid('pg'), src: o.src == null ? null : o.src, index: o.index == null ? null : o.index, w: o.w, h: o.h, baseRot: o.baseRot || 0, rot: o.rot || 0, annots: o.annots || [], textEdits: o.textEdits || [] };
  }

  /** Create an empty document state. */
  function createState(name) { return { version: 1, name: name || 'document.pdf', pages: [], assets: {}, glyphMaps: {} }; }

  /* ---------------- Geometry helpers ---------------- */

  function totalRotation(pg) { return (((pg.baseRot || 0) + (pg.rot || 0)) % 360 + 360) % 360; }
  function displaySize(pg) {
    const r = totalRotation(pg);
    return (r === 90 || r === 270) ? { w: pg.h, h: pg.w } : { w: pg.w, h: pg.h };
  }

  /* ---------------- Rendering ---------------- */

  /** Render a page into `canvas` at `scale` CSS-px-per-point × `pixelRatio`.
      Returns a handle with .promise and .cancel(). Blank pages are painted white. */
  function renderPage(pg, canvas, scale, pixelRatio) {
    pixelRatio = pixelRatio || 1;
    const ds = displaySize(pg);
    let s = scale * pixelRatio;
    const MAX_PIXELS = 16e6;                                   // iOS canvas limit safety
    if (ds.w * s * ds.h * s > MAX_PIXELS) s = Math.sqrt(MAX_PIXELS / (ds.w * ds.h));
    let cancelled = false, task = null;
    const promise = (async () => {
      const ctx = canvas.getContext('2d');
      if (pg.src == null || !sources[pg.src]) {
        canvas.width = Math.max(1, Math.floor(ds.w * s)); canvas.height = Math.max(1, Math.floor(ds.h * s));
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }
      const edited = ((pg.textEdits && pg.textEdits.length) || (pg.shifts && pg.shifts.length)) && sources[pg.src].libDoc;
      const page = edited ? await (await getEditedProxy(pg)).getPage(1) : await sources[pg.src].pdf.getPage(pg.index + 1);
      if (cancelled) return;
      const vp = page.getViewport({ scale: s, rotation: totalRotation(pg) });
      canvas.width = Math.max(1, Math.floor(vp.width)); canvas.height = Math.max(1, Math.floor(vp.height));
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      task = page.render({ canvasContext: ctx, viewport: vp, background: 'rgba(255,255,255,1)' });
      try { await task.promise; }
      catch (e) { if (!(e && e.name === 'RenderingCancelledException')) throw e; }
    })();
    return { promise, cancel() { cancelled = true; if (task) task.cancel(); } };
  }

  /** Render a small thumbnail and return it as a data URL (cached by page content + rotation). */
  const thumbCache = new Map();
  async function renderThumbnail(pg, cssWidth, pixelRatio) {
    const key = [pg.src, pg.index, totalRotation(pg), pg.w, pg.h, cssWidth, editsKey(pg)].join(':');
    if (thumbCache.has(key)) return thumbCache.get(key);
    const ds = displaySize(pg);
    const c = document.createElement('canvas');
    await renderPage(pg, c, cssWidth / ds.w, Math.min(2, pixelRatio || 1)).promise;
    const url = c.toDataURL('image/png');
    thumbCache.set(key, url);
    return url;
  }

  /* ---------------- Page operations (pure state transforms) ---------------- */

  function mapPointCW(x, y, Dh) { return [Dh - y, x]; }
  function mapPointCCW(x, y, Dw) { return [y, Dw - x]; }

  /** Rotate page `i` by ±90; annotations are carried along with the page content
      (shapes/strokes rotate; text & images keep upright and move with their centre). */
  function rotatePage(state, i, delta, measure) {
    const pg = state.pages[i];
    if (!pg) return;
    const steps = ((delta / 90) % 4 + 4) % 4;
    for (let k = 0; k < steps; k++) rotate90(pg, measure);
  }
  function rotate90(pg, measure) {
    const ds = displaySize(pg);
    const map = (x, y) => mapPointCW(x, y, ds.h);
    pg.annots.forEach((a) => {
      switch (a.type) {
        case 'pen': case 'highlight':
          a.points = a.points.map((p) => map(p[0], p[1])); break;
        case 'line': case 'arrow': {
          const p1 = map(a.x1, a.y1), p2 = map(a.x2, a.y2);
          a.x1 = p1[0]; a.y1 = p1[1]; a.x2 = p2[0]; a.y2 = p2[1]; break;
        }
        case 'rect': case 'ellipse': case 'whiteout': {
          const nx = ds.h - (a.y + a.h), ny = a.x; const w = a.w;
          a.x = nx; a.y = ny; a.w = a.h; a.h = w; break;
        }
        default: { // text / image: move centre, keep orientation
          const bb = measure ? measure(a) : { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 };
          const c = map(bb.x + bb.w / 2, bb.y + bb.h / 2);
          a.x = c[0] - bb.w / 2; a.y = c[1] - bb.h / 2;
        }
      }
    });
    pg.rot = ((pg.rot || 0) + 90) % 360;
  }

  function deletePage(state, i) { if (state.pages.length > 1) state.pages.splice(i, 1); }

  function duplicatePage(state, i) {
    const pg = state.pages[i];
    const copy = JSON.parse(JSON.stringify(pg));
    copy.id = uid('pg');
    copy.annots.forEach((a) => { a.id = uid('an'); });
    state.pages.splice(i + 1, 0, copy);
    return i + 1;
  }

  function reorderPages(state, from, to) {
    if (from === to || from < 0 || to < 0 || from >= state.pages.length || to >= state.pages.length) return;
    const [pg] = state.pages.splice(from, 1);
    state.pages.splice(to, 0, pg);
  }

  function addBlankPage(state, afterIndex, size) {
    const ref = state.pages[afterIndex];
    const ds = size || (ref ? displaySize(ref) : { w: 595.28, h: 841.89 });
    const pg = newPage({ src: null, index: null, w: ds.w, h: ds.h });
    state.pages.splice(afterIndex + 1, 0, pg);
    return afterIndex + 1;
  }

  /** Load another PDF and append all its pages to the state. Returns number of pages added. */
  async function merge(state, bytes, name) {
    const res = await load(bytes, name);
    state.pages.push(...res.pages);
    return res.pageCount;
  }

  /* ---------------- Editing existing text ----------------
     Font-matching tiers (see README):
       1. reuse the page's own font resource when every glyph needed is known to exist in it
          (all characters already used with that font on the page, or any encodable
          character for non-embedded standard fonts);
       2. otherwise a metric-compatible substitute for the whole line (Liberation Sans/Serif/Mono,
          Carlito, Caladea, or the exact Google font — Roboto, Open Sans, Lato) with character
          spacing adjusted so the original line width is kept;
       3. else Noto Sans / Serif / Sans Mono by serif-vs-sans, weight and italic.
     The original glyphs are removed from the page's content stream (see textEdit.js); if that
     isn't possible (text inside a form XObject, a text run shared with other lines…) the line is
     covered with a box in the sampled background colour instead and the edit says so. */
  const TI = () => root.FolioTextInternals;
  const analysisCache = new Map();

  const SUBSTITUTES = [
    [/arial|helvetica|arimo|liberationsans|nimbussans|freesans|helv|swiss/, 'LiberationSans', 'Liberation Sans', 'Arial/Helvetica'],
    [/timesnewroman|times|tinos|liberationserif|nimbusrom|freeserif|tmsrmn|tiroman/, 'LiberationSerif', 'Liberation Serif', 'Times'],
    [/couriernew|courier|cousine|liberationmono|nimbusmon|freemono/, 'LiberationMono', 'Liberation Mono', 'Courier'],
    [/calibri|carlito/, 'Carlito', 'Carlito', 'Calibri'],
    [/cambria|caladea/, 'Caladea', 'Caladea', 'Cambria'],
    [/roboto(?!mono|slab|condensed|flex|serif)/, 'Roboto', 'Roboto', null],
    [/opensans/, 'OpenSans', 'Open Sans', null],
    [/lato/, 'Lato', 'Lato', null],
  ];
  const STYLE_NAMES = { Regular: '', Bold: ' Bold', Italic: ' Italic', BoldItalic: ' Bold Italic' };

  function fontTraits(fo, rawName) {
    const n = TI().cleanName(rawName).toLowerCase();
    const bold = !!(fo && (fo.bold || fo.black)) || /bold|black|heavy|semibold|demi/.test(n);
    const italic = !!(fo && fo.italic) || /italic|oblique|-it$|,it$/.test(n);
    const mono = !!(fo && fo.isMonospace) || /mono|courier|consol|menlo|typewriter/.test(n);
    const serif = !mono && (!!(fo && fo.isSerifFont) || /serif|times|roman|georgia|garamond|minion|cambria|palatino|book/.test(n)) && !/sans/.test(n);
    return { bold, italic, mono, serif };
  }

  /** Pick tier-2 and tier-3 substitute font keys for a font name + traits. */
  function substituteFor(rawName, tr) {
    const norm = TI().normName(rawName);
    const style = (tr.bold ? 'Bold' : '') + (tr.italic ? 'Italic' : '') || 'Regular';
    let t2 = null;
    for (const [re, key, label, compat] of SUBSTITUTES) {
      if (re.test(norm)) { t2 = { key: key + '-' + style, label: label + STYLE_NAMES[style], compat, tier: 2 }; break; }
    }
    let fam = tr.mono ? 'NotoSansMono' : tr.serif ? 'NotoSerif' : 'NotoSans';
    let st3 = style;
    if (fam === 'NotoSansMono') st3 = tr.bold ? 'Bold' : 'Regular';
    const famLabel = { NotoSansMono: 'Noto Sans Mono', NotoSerif: 'Noto Serif', NotoSans: 'Noto Sans' }[fam];
    const t3 = { key: fam + '-' + st3, label: famLabel + STYLE_NAMES[st3], compat: null, tier: 3 };
    return { t2, t3 };
  }

  const editFontCache = {};
  /** Lazily load a bundled substitute font: { bytes, fk, family } (family = CSS name for preview). */
  function getEditFont(key) {
    if (editFontCache[key]) return editFontCache[key];
    editFontCache[key] = (async () => {
      await ensureFontkit();
      if (!(root.FolioFontData && root.FolioFontData[key])) await loadScript(BASE + 'vendor/fonts/edit/' + key + '.js');
      const bytes = b64ToBytes(root.FolioFontData[key]);
      delete root.FolioFontData[key];
      const family = 'FolioEdit ' + key;
      try {
        const ff = new FontFace(family, bytes.slice(0).buffer);
        await ff.load(); document.fonts.add(ff);
      } catch (e) { /* preview falls back to generic family */ }
      return { bytes, fk: root.fontkit.create(bytes), family };
    })();
    editFontCache[key].catch(() => { delete editFontCache[key]; });
    return editFontCache[key];
  }

  /* ---- Indic scripts: shaped with HarfBuzz + Noto Sans <Script> (js/engine/indic.js, lazy) ---- */
  const INDIC_RE = /[\u0900-\u0D7F\uA8E0-\uA8FF\u1CD0-\u1CFF]/;
  const INDIC_STRIP_RE = /[\u0900-\u0D7F\uA8E0-\uA8FF\u1CD0-\u1CFF\u200B-\u200D\u25CC]/g;
  const INDIC_FAMILIES = ['Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam'].map((x) => `"FolioIndic ${x}"`).join(', ');
  const hasIndic = (t) => INDIC_RE.test(String(t));
  const INDIC_NAMES = ['Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam'];
  function indicScript(t) {
    const m = String(t).match(INDIC_RE); if (!m) return null;
    const cp = m[0].codePointAt(0);
    return cp >= 0x900 && cp <= 0xD7F ? INDIC_NAMES[(cp - 0x900) >> 7] : 'Devanagari';
  }
  let indicP = null;
  function indicEngine() {
    if (indicP) return indicP;
    indicP = (async () => {
      if (!root.FolioIndic) await loadScript(BASE + 'js/engine/indic.js');
      return root.FolioIndic.create({ BASE, loadScript, b64ToBytes, ensureFontkit, getLatinFont: getFont });
    })();
    indicP.catch(() => { indicP = null; });
    return indicP;
  }
  /** Load HarfBuzz and the fonts `text` needs so the on-screen preview uses them (no-op without Indic text). */
  async function ensureScriptFonts(text, bold) {
    if (!hasIndic(text)) return false;
    await (await indicEngine()).prepare(String(text), !!bold);
    return true;
  }
  // Broken Indic text layers: extracted text in display order (a pre-base matra starting a word) or with glyphs
  // mapped to the wrong characters (common with Word + Kokila/Mangal exports). Editing such a line would
  // re-render the wrong text, so it is refused. The nine Brahmic blocks U+0900–U+0D7F share the ISCII
  // layout, so one syllable-structure check covers them all: a vowel sign or virama must follow a consonant
  // (or nukta), a nukta must follow a consonant, and anusvara/visarga must follow a letter or vowel sign.
  // Word's CID subsets also map conjuncts/matras onto Latin-Extended, IPA, Greek, Cyrillic, CJK or private-use
  // code points (`Ǒहंदȣ` = हिंदी, `Ĥͧश¢ण` = प्रशिक्षण); an Indic line containing any of them is broken too.
  const INDIC_MIXED_RE = /[\u00A2-\u00A6\u00A8\u00AA\u00AC\u00AF\u00B2-\u00B6\u00B8-\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u036F\u0370-\u03FF\u0400-\u052F\u2E80-\u9FFF\uAC00-\uD7AF\uE000-\uF8FF\uF900-\uFAFF]/;
  function indicMalformed(text) {
    if (INDIC_MIXED_RE.test(text) && /[\u0900-\u0D7F]/.test(text)) return true;
    let prev = 'X';
    for (const ch of text.normalize('NFC')) {
      const cp = ch.codePointAt(0);
      if (cp === 0x200C || cp === 0x200D) continue;
      let k = 'X';
      if (cp >= 0x0900 && cp <= 0x0D7F) {
        const blk = cp & 0xFF80, o = cp & 0x7F;
        if ((o >= 0x15 && o <= 0x39) || (o >= 0x58 && o <= 0x5F) || (blk === 0x0D00 && ((o >= 0x54 && o <= 0x56) || o >= 0x7A)) ||
            ((blk === 0x0980 || blk === 0x0B00) && (o === 0x70 || o === 0x71))) k = 'C';
        else if (o === 0x3C) k = 'N';
        else if ((o >= 0x3E && o <= 0x4C) || (o >= 0x62 && o <= 0x63) || o === 0x57 || (blk !== 0x0D00 && (o === 0x55 || o === 0x56))) k = 'V';
        else if (o === 0x4D) k = 'H';
        else if (o >= 0x01 && o <= 0x03) k = 'A';
        else if ((o >= 0x04 && o <= 0x14) || o === 0x60 || o === 0x61) k = 'I';
        else if (blk === 0x0A00 && (o === 0x70 || o === 0x71)) k = 'M';
        else k = 'L';
        if ((k === 'V' || k === 'H') && prev !== 'C' && prev !== 'N') return true;
        if (k === 'N' && prev !== 'C') return true;
        if ((k === 'A' || k === 'M') && !'CNVIAL'.includes(prev) && !(k === 'M' && prev === 'H')) return true;
      }
      prev = k;
    }
    return false;
  }

  const BAD_TEXT_RE = /[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000E-\u001F]/;
  // Indic, Southeast-Asian, Tibetan, Hebrew and Arabic scripts need a shaping engine (conjuncts, reordering, joining, RTL)
  // Legacy (pre-Unicode) Hindi fonts: the text is stored as ASCII/Latin-1 codes that the font draws as
  // Devanagari glyphs ("jftLVªh" = रजिस्ट्री), so the extracted text is gibberish and re-typing it would
  // need the font's private layout. Matched on the font name with any subset prefix removed.
  // (names are lower-cased with separators removed first, so "Devnagari-ChanakyaNormalA", "KRUTI_DEV_010",
  // "Kruti Dev 011" all match; "devnagari" without the second a is a legacy-font spelling, unlike Unicode "Devanagari")
  const LEGACY_HINDI_FONTS = [
    [/kru?tidev|kritidev/, 'Kruti Dev', 'kruti'], [/devlys/, 'DevLys', 'kruti'], [/walkmanchanakya/, 'Walkman-Chanakya', 'chanakya'],
    [/chanakya/, 'Chanakya', 'chanakya'], [/devnagari(?!.*unicode)/, 'Devnagari (legacy)', 'chanakya'],
    [/shivaji/, 'Shivaji', null], [/^apsc?dv/, 'APS-DV', null], [/^(dv|dvb|dvo|dvbo)tt/, 'C-DAC DV-TT', null],
  ];
  const LEGACY_VARIANT = {};
  function legacyHindiFont(...names) {
    for (const n of names) {
      if (!n) continue;
      const k = String(n).replace(/^\/?[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const [re, label, variant] of LEGACY_HINDI_FONTS) if (re.test(k)) { LEGACY_VARIANT[label] = variant; return label; }
    }
    return null;
  }
  const SHAPING_SCRIPT_RE = /[\u0590-\u08FF\u0900-\u0DFF\u0E00-\u0FFF\u1000-\u109F\u1780-\u17FF\uA8E0-\uA8FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

  /** Analyse a source page once: text lines, fonts, content-stream mapping, sampled colours. */
  function analyzePage(src, index) {
    const key = src + ':' + index;
    if (analysisCache.has(key)) return analysisCache.get(key);
    const pr = doAnalyze(src, index);
    analysisCache.set(key, pr);
    pr.catch(() => analysisCache.delete(key));
    return pr;
  }

  async function doAnalyze(src, index) {
    const L = root.PDFLib, T = TI();
    const s = sources[src];
    const page = await s.pdf.getPage(index + 1);
    const base = page.getViewport({ scale: 1, rotation: 0 });
    const S = Math.min(2, 2200 / Math.max(base.width, base.height));
    const vp0 = page.getViewport({ scale: S, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp0.width); canvas.height = Math.ceil(vp0.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp0 }).promise;   // also loads font objects
    const tc = await page.getTextContent();

    // pdf.js font objects
    const pfonts = {};
    for (const it of tc.items) {
      if (!it.fontName || pfonts[it.fontName]) continue;
      let fo = null;
      try { fo = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null; } catch (e) { fo = null; }
      const style = tc.styles[it.fontName] || {};
      pfonts[it.fontName] = {
        fo, name: fo ? fo.name : (style.fontFamily || ''), type3: !!(fo && fo.isType3Font),
        widths: (fo && fo.widths) || {}, defaultWidth: (fo && fo.defaultWidth) || 0,
        toUnicode: fo && fo.toUnicode && fo.toUnicode._map ? fo.toUnicode._map : null,
        composite: !!(fo && fo.composite), missingFile: !!(fo && fo.missingFile),
        ascent: style.ascent || 0.8, descent: style.descent || -0.2, seen: new Set(),
      };
    }

    // content stream + resources (pdf-lib, read-only on the cached parse)
    let libFonts = {}, shows = [], keyFor = {}, streamError = null;
    const libByShow = {}, simByShow = {};   // show font key (incl. Form XObject prefix) -> font resource / simulation font
    const usedCodes = {};             // resource key -> char codes actually shown with it on this page
    if (s.libDoc) {
      try {
        const lp = s.libDoc.getPage(index);
        libFonts = T.pageFonts(L, lp);
        const pageOps = T.parseOps(T.contentString(L, lp));
        const byName = {};
        for (const [fname, pf] of Object.entries(pfonts)) { const nn = T.normName(pf.name); (byName[nn] = byName[nn] || []).push(fname); }
        const simFonts = {};
        const claimed = {};
        // 1) resource key <-> pdf.js font by aligning the page's Tf operators with pdf.js's setFont
        //    operators (same order). This is exact, even when several fonts share one name — e.g.
        //    Word's embedded CID "ArialMT" next to a non-embedded WinAnsi "ArialMT", or iText's
        //    several "ArialUnicodeMS" subsets.
        const tfMap = await tfFontMap(page, pageOps);
        if (tfMap) {
          for (const [k, fname] of Object.entries(tfMap)) {
            if (!libFonts[k] || !pfonts[fname]) continue;
            (claimed[fname] = claimed[fname] || []).push(k); libFonts[k].pdfjs = fname;
          }
        } else {
          // 2) fallback: by (unprefixed) name; ambiguous names are not mapped
          for (const [k, f] of Object.entries(libFonts)) {
            const hits = new Set(); f.norms.forEach((nn) => (byName[nn] || []).forEach((x) => hits.add(x)));
            if (hits.size !== 1) continue;
            const fname = [...hits][0];
            (claimed[fname] = claimed[fname] || []).push(k);
            f.pdfjs = fname;
          }
        }
        for (const [fname, keys] of Object.entries(claimed)) {
          // several resource keys may point at the very same font object (pdf-lib does this) — fine;
          // with name matching, different font objects sharing one name are ambiguous and left unmapped
          // (with the Tf alignment, pdf.js itself merged them — it only does that for equivalent fonts)
          const refs = new Set(keys.map((k) => String(libFonts[k].ref)));
          if (!tfMap && refs.size !== 1) { keys.forEach((k) => { libFonts[k].pdfjs = null; }); continue; }
          keyFor[fname] = keys;
          const pf = pfonts[fname];
          keys.forEach((k) => { simFonts[k] = { composite: libFonts[k].composite, widths: pf.widths, defaultWidth: pf.defaultWidth, toUnicode: pf.toUnicode }; });
        }
        // Form XObjects are followed too (OCR tools such as OCRmyPDF put the invisible text layer in one),
        // so hidden text can be recognised wherever it lives; form text is never removed surgically.
        const formFontsFor = (resDict, prefix) => {
          const sf = {};
          let lf = {}; try { lf = T.pageFonts(L, lp, resDict); } catch (e) { lf = {}; }
          for (const [k, f] of Object.entries(lf)) {
            libByShow[prefix + k] = f;
            const hits = new Set(); f.norms.forEach((nn) => (byName[nn] || []).forEach((x) => hits.add(x)));
            // unmatched: still tell the simulation the code width (2-byte CIDs) so its codes are right
            if (hits.size !== 1) { sf[k] = { composite: f.composite, widths: {}, defaultWidth: 0, toUnicode: null, unknown: true }; continue; }
            const pf = pfonts[[...hits][0]];
            sf[k] = { composite: f.composite, widths: pf.widths, defaultWidth: pf.defaultWidth, toUnicode: pf.toUnicode };
            simByShow[prefix + k] = sf[k];
          }
          return sf;
        };
        let formN = 0;
        const N = (n) => L.PDFName.of(n);
        const makeOnDo = (resDict) => (name) => {
          try {
            const xd = resDict && resDict.lookupMaybe(N('XObject'), L.PDFDict);
            const st = xd && xd.lookup(N(name));
            if (!st || !st.dict) return null;
            const sub = String(st.dict.get(N('Subtype')));
            if (sub === '/Image') {
              const d = st.dict;
              return { type: 'image', opaque: !d.get(N('SMask')) && !d.get(N('Mask')) && String(d.get(N('ImageMask'))) !== 'true' };
            }
            if (sub !== '/Form') return null;
            const ops = T.parseOps(T.bytesToLatin1(T.decodeStreamBytes(L, st)));
            const m = st.dict.lookupMaybe(N('Matrix'), L.PDFArray);
            const matrix = m && m.size() === 6 ? m.asArray().map((v) => (v.asNumber ? v.asNumber() : 0)) : [1, 0, 0, 1, 0, 0];
            const fr = st.dict.lookupMaybe(N('Resources'), L.PDFDict) || resDict;
            const prefix = 'xo' + (formN++) + ':';
            return { type: 'form', ops, fonts: formFontsFor(fr, prefix), matrix, onDo: makeOnDo(fr), prefix };
          } catch (e) { return null; }
        };
        for (const k of Object.keys(simFonts)) { libByShow[k] = libFonts[k]; simByShow[k] = simFonts[k]; }
        shows = T.simulate(pageOps, simFonts, { onDo: makeOnDo(lp.node.Resources()) });
        shows.forEach((sh) => { const u = usedCodes[sh.font] || (usedCodes[sh.font] = new Set()); sh.codes.forEach((c) => u.add(c)); });
        s.simFonts = s.simFonts || {}; s.simFonts[index] = simFonts;
      } catch (e) { streamError = e; shows = []; }
    }

    // group text items into lines
    const raw = [];
    let cur = null, wideFrom = null;
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const t = it.transform;
      const size = Math.hypot(t[2], t[3]);
      if (!it.str || size < 1) { if (it.hasEOL) { cur = null; wideFrom = null; } continue; }
      const pf = pfonts[it.fontName];
      if (pf) Array.from(it.str).forEach((ch) => pf.seen.add(ch));
      const dir = [t[0], t[1]].map((v) => v / (Math.hypot(t[0], t[1]) || 1));
      // pdf.js bridges big horizontal jumps (table cells, tab stops) with a synthetic wide space item;
      // a whitespace run wider than 1 em is a column gap, not a word space — start a new line there
      if (!it.str.trim() && it.width > 1.0 * size) { if (cur) wideFrom = cur; cur = null; continue; }
      if (cur) {
        const dx = t[4] - cur.t[4], dy = t[5] - cur.t[5];
        const along = dx * cur.dir[0] + dy * cur.dir[1];
        const perp = -dx * cur.dir[1] + dy * cur.dir[0];
        const same = it.fontName === cur.fontName && Math.abs(size - cur.size) < 0.02 * size &&
          Math.abs(t[1] - cur.t[1]) < 0.02 * size && Math.abs(t[2] - cur.t[2]) < 0.02 * size &&
          Math.abs(perp) < 0.2 * size && along >= cur.width - 0.35 * size && along - cur.width <= 1.1 * size;
        if (same) {
          const gap = along - cur.width;
          if (gap > 0.12 * size && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
          cur.text += it.str; cur.width = Math.max(cur.width, along + it.width);
          if (it.hasEOL) cur = null;
          continue;
        }
      }
      if (!it.str.trim()) { if (it.hasEOL) { cur = null; wideFrom = null; } continue; }
      cur = { fontName: it.fontName, t: t.slice(), size, dir, text: it.str, width: it.width, vertical: it.dir === 'ttb' };
      if (wideFrom) {   // remember a same-font continuation after a wide gap (justified text or a table row?)
        const w = wideFrom, dx = t[4] - w.t[4], dy = t[5] - w.t[5];
        const along = dx * w.dir[0] + dy * w.dir[1], perp = -dx * w.dir[1] + dy * w.dir[0];
        if (it.fontName === w.fontName && Math.abs(size - w.size) < 0.02 * size && Math.abs(perp) < 0.2 * size &&
          Math.abs(t[1] - w.t[1]) < 0.02 * size && Math.abs(t[2] - w.t[2]) < 0.02 * size && along > w.width) cur.chainPrev = w;
        wideFrom = null;
      }
      raw.push(cur);
      if (it.hasEOL) cur = null;
    }
    // Re-join chains split at wide gaps when they look like one justified line: every gap about the same
    // width and no wider than 3 em (1.5 em for a single gap). Table cells (uneven gaps, or very wide ones) stay separate lines.
    for (let n = raw.length - 1; n >= 0; n--) {
      const r = raw[n];
      if (!r || r.chainPrev === undefined || r.joined) continue;
      if (raw.some((q) => q && q.chainPrev === r)) continue;          // start from the last link of a chain
      const chain = [r]; let q = r;
      while (q.chainPrev && raw.includes(q.chainPrev)) { q = q.chainPrev; chain.unshift(q); }
      const gaps = [];
      for (let k = 1; k < chain.length; k++) {
        const a = chain[k - 1], b = chain[k];
        gaps.push((b.t[4] - a.t[4]) * a.dir[0] + (b.t[5] - a.t[5]) * a.dir[1] - a.width);
      }
      const mx = Math.max(...gaps), mn = Math.min(...gaps), size = chain[0].size;
      const justified = mx <= (gaps.length > 1 ? 3 : 1.5) * size && mx - mn <= Math.max(0.6, 0.12 * mx);   // one lone gap: likely a tab stop
      if (!justified) continue;
      const head = chain[0];
      for (let k = 1; k < chain.length; k++) {
        const b = chain[k];
        head.text = head.text.replace(/\s+$/, '') + ' ' + b.text.replace(/^\s+/, '');
        head.width = (b.t[4] - head.t[4]) * head.dir[0] + (b.t[5] - head.t[5]) * head.dir[1] + b.width;
        b.joined = true;
      }
    }
    for (let n = raw.length - 1; n >= 0; n--) if (raw[n].joined) raw.splice(n, 1);
    // Word switches fonts in the middle of Indic words (`यथोͬ` + `चत`); join adjacent same-baseline runs with
    // Indic text into one visual line so it is read, checked and edited as a whole
    const isType3 = (fn) => !!(pfonts[fn] && pfonts[fn].type3);
    for (let n = 0; n + 1 < raw.length; n++) {
      const a = raw[n], b = raw[n + 1];
      if (a.vertical || b.vertical || isType3(a.fontName) || isType3(b.fontName)) continue;
      const ai = hasIndic(a.text), bi = hasIndic(b.text);
      if (!(ai || bi) || (!ai && /[A-Za-z]/.test(a.text)) || (!bi && /[A-Za-z]/.test(b.text))) continue;
      const sz = a.size;
      if (Math.abs(b.size - sz) > 0.05 * sz || Math.abs(b.t[5] - a.t[5]) > 0.05 * sz || Math.abs(a.t[1]) > 0.02 * sz || Math.abs(a.t[2]) > 0.02 * sz ||
          Math.abs(b.t[1]) > 0.02 * sz || Math.abs(b.t[2]) > 0.02 * sz) continue;
      const gap = b.t[4] - (a.t[4] + a.width);
      if (gap < -0.2 * sz || gap > 0.35 * sz) continue;
      if (gap > 0.12 * sz && !/\s$/.test(a.text) && !/^\s/.test(b.text)) a.text += ' ';
      a.text += b.text; a.width = Math.max(a.width, b.t[4] + b.width - a.t[4]);
      a.fonts = (a.fonts || [a.fontName]).concat(b.fonts || [b.fontName]);
      raw.splice(n + 1, 1); n--;
    }

    const lines = [];
    raw.forEach((r, n) => {
      const text = r.text.replace(/\s+$/, '');
      if (!text.trim()) return;
      const pf = pfonts[r.fontName] || { name: '', ascent: 0.8, descent: -0.2 };
      const fontNames = r.fonts ? [...new Set(r.fonts)] : [r.fontName];
      const t = r.t;
      const hs = Math.hypot(t[0], t[1]) / r.size;
      const ln = { id: 'L' + n, fontName: r.fontName, text, x: t[4], y: t[5], size: r.size, hs, width: r.width,
        a: t[0], b: t[1], c: t[2], d: t[3], asc: Math.min(1.2, Math.max(0.5, pf.ascent)), desc: Math.max(-0.6, Math.min(-0.05, pf.descent)),
        fontLabel: T.cleanName(pf.name) || 'Unknown font', editable: true, reason: '' };
      const tr = fontTraits(pf.fo, pf.name);
      Object.assign(ln, tr);
      if (r.vertical) { ln.editable = false; ln.reason = 'Vertical text can’t be edited yet.'; }
      else if (Math.abs(t[1]) > 0.02 * r.size || Math.abs(t[2]) > 0.02 * r.size || t[0] <= 0 || t[3] <= 0) { ln.editable = false; ln.reason = 'Rotated or skewed text can’t be edited yet — use the Text tool to add a new line instead.'; }
      else if (pf.type3) { ln.editable = false; ln.reason = 'This line uses a Type 3 (drawn) font, so it can’t be edited as text.'; }
      else if ((ln.legacyFont = legacyHindiFont(...fontNames.flatMap((fn) => [pfonts[fn] && pfonts[fn].name, ...(keyFor[fn] || []).map((k) => libFonts[k] && libFonts[k].baseName)])))) {
        ln.legacyVariant = LEGACY_VARIANT[ln.legacyFont];
        if (ln.legacyVariant) {       // Kruti Dev / Chanakya: decoded + OCR cross-check, always confirmed, saved as Unicode
          ln.verify = 'legacy';
          ln.verifyReason = `This line uses an older Hindi font (${ln.legacyFont}) that stores Devanagari as Latin letters.`;
        } else {
          ln.editable = false;
          ln.reason = `This line uses an older Hindi font (${ln.legacyFont}) that stores text in a non-standard way; editing isn’t supported yet. Use White-out + Text to replace it.`;
        }
      }
      else if (SHAPING_SCRIPT_RE.test(text.replace(INDIC_STRIP_RE, ''))) { ln.editable = false; ln.reason = 'This line uses a script Pdfroo can’t typeset into an existing line yet (e.g. Arabic, Hebrew, Thai, Sinhala) — use White-out + Text instead.'; }
      else if (hasIndic(text) && indicMalformed(text)) { ln.verify = 'garbled'; ln.verifyReason = 'The text layer copies out scrambled (display order or wrong characters).'; }
      else if (/^[\uE000-\uF8FF\s]+$/.test(text) && text.trim().length <= 3) { ln.editable = false; ln.symbol = true; ln.reason = 'This is a symbol (such as a bullet) from a symbol font, so it can’t be edited as text — but it can be moved (arrow keys or the nudge buttons).'; }
      else if (BAD_TEXT_RE.test(text)) { ln.editable = false; ln.reason = 'This text has no reliable character mapping (it copies out as gibberish), so it can’t be edited safely.'; }
      // content-stream mapping (for removing the old glyphs)
      ln.fontKeys = fontNames.every((fn) => keyFor[fn]) ? [...new Set(fontNames.flatMap((fn) => keyFor[fn]))] : null;
      if (fontNames.length > 1) ln.fontNames = fontNames;
      ln.fontKey = ln.fontKeys ? ln.fontKeys[0] : null;
      ln.removal = 'cover'; ln.removalReason = streamError ? 'stream' : 'font-unmapped';
      if (ln.fontKey) {
        const m = T.matchLine(shows, { x: ln.x, y: ln.y, end: ln.x + ln.width, size: ln.size, text: ln.text, fontKeys: ln.fontKeys });
        if (m.ok && m.shows.every((x) => x.Tr === 3 || x.Tr === 7)) {
          ln.editable = false; ln.reason = 'This is an invisible text layer (e.g. OCR text behind a scanned image), so there’s no visible text to edit here.';
        } else if (m.ok) {
          ln.removal = 'stream'; ln.removalReason = '';
          const fills = [...new Set(m.shows.map((x) => x.fill).filter(Boolean))];
          if (fills.length === 1) ln.color = fills[0];
        } else ln.removalReason = m.reason;
      }
      // hidden text: invisible render mode (OCR layers, anywhere incl. Form XObjects) or painted over by an opaque image
      if (ln.editable || /^Rotated/.test(ln.reason)) {
        const hid = hiddenText(shows, ln);
        if (hid) { ln.editable = false; ln.reason = hid; }
      }
      // fill colour + synthetic bold (iText & co. fake bold with fill+stroke text, Tr 2, and a line width)
      if (ln.editable) {
        const ls = lineShows(shows, ln).filter((x) => x.Tr !== 3 && x.Tr !== 7);
        if (ls.length) {
          const fills = [...new Set(ls.map((x) => x.fill).filter(Boolean))];
          if (!ln.color && fills.length === 1) ln.color = fills[0];
          if (ls.every((x) => (x.Tr === 2 || x.Tr === 6) && x.lw > 0.005 * ln.size)) ln.fakeBold = Math.round(Math.min(...ls.map((x) => x.lw)) * 1e4) / 1e4;
        }
      }
      // Indic (and legacy Hindi) lines: pdf.js often reports ~0.6 em, which clips the matras above the headline and
      // the marks below; use >= 1 em (0.95 up, 0.35 down) without reaching into the lines above/below
      if ((hasIndic(text) || ln.legacyFont) && !r.vertical) {
        let top = Math.max(ln.asc, 0.95), bot = Math.min(ln.desc, -0.35);
        for (const q of raw) {
          if (q === r || q.vertical || q.t[4] > ln.x + ln.width || q.t[4] + q.width < ln.x) continue;
          const dy = q.t[5] - ln.y;
          if (dy > 0.3 * ln.size && dy < 3 * ln.size) top = Math.min(top, Math.max(ln.asc, (dy - 0.3 * q.size) / ln.size));
          else if (dy < -0.3 * ln.size && dy > -3 * ln.size) bot = Math.max(bot, Math.min(ln.desc, (dy + 0.78 * q.size) / ln.size));
        }
        ln.asc = top; ln.desc = bot;
      }
      // colours sampled from the rendered page
      const box = [ln.x, ln.y + ln.desc * ln.size, ln.x + ln.width, ln.y + ln.asc * ln.size];
      const sc = sampleColors(ctx, canvas, vp0, box);
      ln.bg = sc.bg;
      if (!ln.color) ln.color = sc.fg;
      // underlines / table rules touching the line's box: a cover rectangle must stop short of them
      try { Object.assign(ln, ruleLimits(ctx, canvas, vp0, ln, sc.bg)); } catch (e) { /* advisory */ }
      ln.sub = substituteFor(pf.name, tr);
      if (hasIndic(text)) {
        ln.indic = true;
        const sc = indicScript(text);
        ln.sub = { t2: null, t3: { key: 'shaped', label: 'Noto Sans ' + sc + (ln.bold && !ln.fakeBold ? ' Bold' : ''), compat: null, tier: 3, indic: true } };
      }
      lines.push(ln);
    });
    // A font whose Indic lines are often malformed has an unreliable ToUnicode map (wrong characters also show
    // up in lines that happen to look well-formed), so none of its Indic lines on this page are editable.
    const indicByFont = {};
    for (const ln of lines) if (hasIndic(ln.text)) {
      const f = indicByFont[ln.fontName] || (indicByFont[ln.fontName] = { n: 0, bad: 0 });
      f.n++; if (indicMalformed(ln.text)) f.bad++;
    }
    for (const ln of lines) {
      const f = indicByFont[ln.fontName];
      if (ln.editable && !ln.verify && f && hasIndic(ln.text) && f.bad >= 2 && f.bad >= 0.25 * f.n) {
        ln.verify = 'font';
        ln.verifyReason = 'This font’s text layer is unreliable (many of its Indic lines on this page copy out with wrong characters).';
      }
    }

    // runs that can be moved in the content stream (editable text, and symbol-font bullets)
    for (const ln of lines) ln.movable = !!(ln.editable || (ln.symbol && ln.removal === 'stream'));
    markStrayBullets(lines);
    // page-level refusal
    let refusal = null;
    const hiddenN = lines.filter((l) => /invisible text layer|hidden underneath an image/.test(l.reason)).length;
    if (lines.length && hiddenN >= 0.8 * lines.length) {
      refusal = { code: 'ocr', message: 'This page is a scanned image with an invisible OCR text layer — the text you see is part of the picture, so it can’t be edited as text. Use White-out + Text to change it.' };
    } else if (!lines.length) {
      let images = 0, paths = 0;
      try {
        const ol = await page.getOperatorList();
        const O = pdfjsLib.OPS;
        ol.fnArray.forEach((fn) => {
          if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject || fn === O.paintJpegXObject || fn === O.paintImageXObjectRepeat || fn === O.paintInlineImageXObjectGroup) images++;
          else if (fn === O.constructPath) paths++;
        });
      } catch (e) { /* ignore */ }
      if (images && paths < 40) refusal = { code: 'scanned', message: 'This page looks scanned — it’s a picture of text with no text layer, so there’s nothing to edit. Use the Text tool to add new text, or run OCR first.' };
      else if (paths >= 40) refusal = { code: 'outlines', message: 'The text on this page has been converted to outlines (vector shapes), so it can’t be edited as text. Use White-out + Text to replace it.' };
      else refusal = { code: 'empty', message: 'There’s no editable text on this page.' };
    }
    const libFontsPlain = {};
    for (const [k, f] of Object.entries(libFonts)) libFontsPlain[k] = { composite: f.composite, identity: f.identity, type3: f.type3, fsType: f.fsType, embedded: f.embedded, baseName: f.baseName, norm: f.norms[0], pdfjs: f.pdfjs || null, encExplicit: f.encExplicit };
    const allText = tc.items.map((i) => i.str || '').join('').replace(/\s+/g, '');
    return { lines, refusal, pfonts, libFonts: libFontsPlain, page, streamError, allText, usedCodes, shows, libByShow, simByShow, src, index };
  }

  /** {resourceKey: pdf.js loadedName} from the page-level Tf / setFont sequences, or null if they don't line up. */
  async function tfFontMap(page, pageOps) {
    try {
      const ol = await page.getOperatorList();
      const O = pdfjsLib.OPS; const seq = []; let form = 0, ann = 0;
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i];
        if (fn === O.paintFormXObjectBegin) form++;
        else if (fn === O.paintFormXObjectEnd) form--;
        else if (fn === O.beginAnnotation) ann++;
        else if (fn === O.endAnnotation) ann--;
        else if (fn === O.setFont && !form && !ann) seq.push(ol.argsArray[i][0]);
      }
      const keys = pageOps.filter((o) => o.op === 'Tf').map((o) => o.args[0] && o.args[0].v);
      if (!keys.length || keys.length !== seq.length) return null;
      const map = {}, back = {};
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], f = seq[i];
        if (!k || !f) return null;
        if ((map[k] && map[k] !== f)) return null;     // inconsistent — don't trust the alignment
        map[k] = f; (back[f] = back[f] || new Set()).add(k);
      }
      return map;
    } catch (e) { return null; }
  }

  /** Content-stream shows (page or Form XObject) that draw this line. */
  function lineShows(shows, ln) {
    const sz = ln.size;
    return shows.filter((x) => x.Tfs && Math.abs(x.m[1]) < 0.1 * Math.abs(x.m[0] || 1) && Math.abs(x.m[2]) < 0.1 * Math.abs(x.m[3] || 1) &&
      Math.abs(x.start[1] - ln.y) <= 0.3 * sz && x.start[0] >= ln.x - 0.3 * sz && x.start[0] <= ln.x + ln.width - 0.05 * sz && x.codes.length);
  }

  function hiddenText(shows, ln) {
    const sz = ln.size;
    const cands = lineShows(shows, ln);
    if (!cands.length) return null;
    if (cands.every((x) => x.Tr === 3 || x.Tr === 7)) return 'This is an invisible text layer (e.g. OCR text behind a scanned image), so there’s no visible text to edit here.';
    const last = Math.max(...cands.map((x) => x.seq));
    const x0 = ln.x, x1 = ln.x + ln.width, y0 = ln.y + ln.desc * sz, y1 = ln.y + ln.asc * sz;
    const imgs = shows.images || [];
    if (imgs.some((im) => im.opaque && im.seq > last && im.bbox[0] <= x0 + 1 && im.bbox[2] >= x1 - 1 && im.bbox[1] <= y0 + 1 && im.bbox[3] >= y1 - 1)) {
      return 'This text is hidden underneath an image (e.g. an OCR layer behind a scanned page), so there’s no visible text to edit here.';
    }
    return null;
  }

  function sampleColors(ctx, canvas, vp0, box) {
    const p1 = vp0.convertToViewportPoint(box[0], box[1]), p2 = vp0.convertToViewportPoint(box[2], box[3]);
    const x0 = Math.max(0, Math.floor(Math.min(p1[0], p2[0]))), x1 = Math.min(canvas.width, Math.ceil(Math.max(p1[0], p2[0])));
    const y0 = Math.max(0, Math.floor(Math.min(p1[1], p2[1]))), y1 = Math.min(canvas.height, Math.ceil(Math.max(p1[1], p2[1])));
    const pad = 4;
    const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(canvas.width, x1 + pad), Y1 = Math.min(canvas.height, y1 + pad);
    if (X1 - X0 < 2 || Y1 - Y0 < 2) return { bg: '#ffffff', fg: '#000000' };
    const img = ctx.getImageData(X0, Y0, X1 - X0, Y1 - Y0).data, W = X1 - X0;
    const buckets = new Map();
    const inner = [];
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const o = ((y - Y0) * W + (x - X0)) * 4;
      const px = [img[o], img[o + 1], img[o + 2]];
      const ring = x < x0 || x >= x1 || y < y0 || y >= y1;
      if (ring) {
        const k = (px[0] >> 4) + ',' + (px[1] >> 4) + ',' + (px[2] >> 4);
        const b = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += px[0]; b.g += px[1]; b.b += px[2]; buckets.set(k, b);
      } else inner.push(px);
    }
    let best = null; buckets.forEach((b) => { if (!best || b.n > best.n) best = b; });
    const bg = best ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
    const dist = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
    const ink = inner.filter((p) => dist(p) > 90).sort((a, b) => dist(b) - dist(a));
    const top = ink.slice(0, Math.max(1, Math.ceil(ink.length * 0.3)));
    const fg = top.length && ink.length ? top.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / top.length) : [0, 0, 0];
    const h = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    return { bg: h(bg), fg: h(fg) };
  }

  /** Rows (in PDF y) of full-width horizontal rules just below the baseline / above the cap height
   *  inside the area a cover rectangle would paint: { coverBottom, coverTop } (either may be absent). */
  function ruleLimits(ctx, canvas, vp0, ln, bgHex) {
    const sz = ln.size, pad = 0.06 * sz;
    const yLo = ln.y + ln.desc * sz - pad - 0.5, yHi = ln.y + ln.asc * sz + pad + 0.5;
    const pA = vp0.convertToViewportPoint(ln.x, yHi), pB = vp0.convertToViewportPoint(ln.x + ln.width, yLo);
    const x0 = Math.max(0, Math.floor(Math.min(pA[0], pB[0]))), x1 = Math.min(canvas.width, Math.ceil(Math.max(pA[0], pB[0])));
    const r0 = Math.max(0, Math.floor(Math.min(pA[1], pB[1]))), r1 = Math.min(canvas.height, Math.ceil(Math.max(pA[1], pB[1])));
    if (x1 - x0 < 8 || r1 - r0 < 2) return {};
    const bg = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
    const img = ctx.getImageData(x0, r0, x1 - x0, r1 - r0).data, W = x1 - x0;
    const scale = (r1 - r0) / (yHi - yLo);
    const rowY = (r) => yHi - (r - r0 + 0.5) / scale;      // PDF y of a canvas row's centre
    const out = {};
    for (let r = r0; r < r1; r++) {
      const y = rowY(r);
      const below = y < ln.y - 0.02 * sz, above = y > ln.y + 0.78 * sz;
      if (!below && !above) continue;
      let ink = 0;
      for (let x = 0; x < W; x++) {
        const o = ((r - r0) * W + x) * 4;
        if (Math.abs(img[o] - bg[0]) + Math.abs(img[o + 1] - bg[1]) + Math.abs(img[o + 2] - bg[2]) > 90) ink++;
      }
      if (ink < 0.92 * W) continue;
      if (below) { const edge = y + 0.5 / scale; out.coverBottom = Math.max(out.coverBottom == null ? -Infinity : out.coverBottom, edge); }
      else { const edge = y - 0.5 / scale; out.coverTop = Math.min(out.coverTop == null ? Infinity : out.coverTop, edge); }
    }
    return out;
  }

  /** Estimated width (user units) of `text` drawn for an edit. */
  function editWidth(e, fk) {
    if (e.newW != null && !e.moveOnly) return e.newW;
    if (e.tier === 1 && e.t1) return e.t1.width;
    if (!fk) return e.geo.width;
    const run = fk.layout(e.text);
    return (run.advanceWidth / fk.unitsPerEm * e.geo.size + (e.sub.tc || 0) * Array.from(e.text).length) * e.geo.hs;
  }

  // ---------- garbled Indic text layers: a font-derived reading + line OCR (see indicVerify.js) ----------
  let verifyLibP = null, ocrEngine = null;
  function verifyLib() {
    if (!verifyLibP) {
      verifyLibP = (async () => { if (!root.FolioIndicVerify) await loadScript(BASE + 'js/engine/indicVerify.js'); return root.FolioIndicVerify; })();
      verifyLibP.catch(() => { verifyLibP = null; });
    }
    return verifyLibP;
  }
  /** Glyph reader for an embedded Type0/Identity-H font program (cached per source + font object). */
  function fontProgramReader(src, lf, V) {
    const s = sources[src];
    s.glyphReaders = s.glyphReaders || new Map();
    const key = String(lf.ref);
    if (s.glyphReaders.has(key)) return s.glyphReaders.get(key);
    let out = null;
    try {
      const L = root.PDFLib, T = TI(), N = (n) => L.PDFName.of(n);
      const arr = lf.dict.lookupMaybe(N('DescendantFonts'), L.PDFArray);
      const d = arr && arr.lookupMaybe(0, L.PDFDict);
      const fd = d && d.lookupMaybe(N('FontDescriptor'), L.PDFDict);
      const ff = fd && fd.lookup(N('FontFile2'));
      if (ff) {
        const bytes = T.decodeStreamBytes(L, ff);
        const fk = root.fontkit.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        const c2g = d.lookup(N('CIDToGIDMap'));
        let gid = (cid) => cid;
        if (c2g && c2g.dict) { const b = T.decodeStreamBytes(L, c2g); gid = (cid) => (cid * 2 + 1 < b.length ? (b[cid * 2] << 8) | b[cid * 2 + 1] : 0); }
        out = { reader: V.glyphReader(fk), gid, adv: (g) => { try { return fk.getGlyph(g).advanceWidth / fk.unitsPerEm * 1000; } catch (e) { return 0; } } };
      }
    } catch (e) { out = null; }
    s.glyphReaders.set(key, out);
    return out;
  }
  /** Read a line back from the glyphs it draws: embedded cmap + reversed GSUB, then logical order. */
  let fontDbg = null;
  async function fontReadingFor(an, ln, maps) {
    const V = await verifyLib();
    await ensureFontkit();
    // the line's shows, plus shows that start further left (pdf.js may place the line start inside a show) but run
    // into it; glyphs are clipped to the line below
    const inLine = new Set(lineShows(an.shows || [], ln));
    let ls = (an.shows || []).filter((x) => inLine.has(x) || (x.Tfs && x.codes.length && Math.abs(x.m[1]) < 0.1 * Math.abs(x.m[0] || 1) &&
      Math.abs(x.m[2]) < 0.1 * Math.abs(x.m[3] || 1) && Math.abs(x.start[1] - ln.y) <= 0.3 * ln.size && x.start[0] < ln.x - 0.3 * ln.size && x.end[0] > ln.x + 0.3 * ln.size))
      .filter((x) => x.Tr !== 3 && x.Tr !== 7);
    // the line's own font: its resource keys, or (Form XObjects) the font resources with the same name
    const T = TI();
    const pfs = (ln.fontNames || [ln.fontName]).map((fn) => an.pfonts[fn]).filter(Boolean).map((p) => ({ p, norm: T.normName(p.name) }));
    const pfFor = (lf) => { const h = lf && pfs.find((x) => lf.norms.includes(x.norm)); return h ? h.p : null; };
    const own = ls.filter((x) => (ln.fontKeys && ln.fontKeys.includes(x.font)) || pfFor(an.libByShow[x.font]));
    if (own.length) ls = own;
    // drawing order (Word draws glyphs in visual order; marks may be shifted sideways, so x order is wrong for
    // them) unless the stream jumps backwards by more than half an em
    ls.sort((a, b) => a.seq - b.seq);
    if (ls.some((x, i) => i && x.start[0] < ls[i - 1].start[0] - 0.5 * ln.size)) ls.sort((a, b) => a.start[0] - b.start[0]);
    if (!ls.length) return null;
    const units = []; let prevEnd = null, fromFont = 0, total = 0, xMax = -Infinity;
    let stopped = false;
    const recs = [];                 // per glyph (drawing order): { k: font object, g: glyph id, t: font's own reading, v, tu } | { space }
    for (const sh of ls) {
      const lf = an.libByShow[sh.font];
      // simulation font unknown (ambiguous name inside a form): use the pdf.js font of this line
      const pf = pfFor(lf);
      const sf = an.simByShow[sh.font] || (pf ? { toUnicode: pf.toUnicode, widths: pf.widths, defaultWidth: pf.defaultWidth, guessed: true } : null);
      const fr = lf && lf.composite && lf.identity ? fontProgramReader(an.src, lf, V) : null;
      // glyph pen positions (device x); with unknown widths (ambiguous font inside a form) use the font program's
      const k = sh.Tfs ? sh.m[0] / sh.Tfs : 0;
      const wOf = (c) => (sf && sf.widths && sf.widths[c] != null && !sf.guessed && !sf.unknown ? sf.widths[c] : fr && fr.gid(c) ? fr.adv(fr.gid(c)) : sf && sf.widths && sf.widths[c] != null ? sf.widths[c] : (sf && sf.defaultWidth) || 0) / 1000 * sh.m[0];
      const xs = []; let acc = sh.start[0];
      const known = sh.gx && sh.gx.length === sh.codes.length && sf && !sf.guessed && !sf.unknown && k;
      for (let ci = 0; ci < sh.codes.length; ci++) { xs.push(known ? sh.start[0] + sh.gx[ci] * k : acc); acc += wOf(sh.codes[ci]); }
      const xe = (ci) => (ci + 1 < xs.length ? xs[ci + 1] : known ? sh.end[0] : acc);
      if (fontDbg) fontDbg.push({ font: sh.font, known: !!known, sf: sf ? { guessed: !!sf.guessed, unknown: !!sf.unknown, nw: sf.widths ? Object.keys(sf.widths).length : -1 } : null, fr: !!fr, xs: xs.map((v) => Math.round(v * 10) / 10), x0: ln.x - 0.3 * ln.size, end: ln.x + ln.width, size: ln.size });
      // only glyphs that start inside this line: one show can run on across a column gap that pdf.js splits
      // pdf.js widths are unreliable at the end (too short for many Word fonts, or including a trailing space):
      // near / past the end only glyphs that continue the last word are kept, up to the first word gap
      const lnEnd = ln.x + ln.width, x0 = ln.x - 0.3 * ln.size, soft = Math.max(ln.x + 0.01, lnEnd - 0.35 * ln.size);
      for (let ci = 0; ci < sh.codes.length; ci++) {
        const gap = prevEnd != null && xs[ci] - prevEnd > 0.15 * ln.size;
        if (xs[ci] < x0 || (stopped && xs[ci] > soft)) continue;
        if (xs[ci] > soft && (prevEnd == null ? xs[ci] > Math.max(lnEnd, ln.x + 0.01) : gap || xs[ci] > lnEnd + 3 * ln.size)) { if (prevEnd != null) stopped = true; continue; }
        const code = sh.codes[ci];
        if (gap && units.length && !/\s$/.test(units[units.length - 1].t)) { units.push({ t: ' ', v: true }); recs.push({ space: true }); }
        const tu = sf && sf.toUnicode ? (sf.toUnicode[code] || '') : '';
        let t = null;
        if (fr) { const g = fr.gid(code); if (g) t = fr.reader.read(g, tu || null); }
        total++;
        if ((t || tu) && /^\s+$/.test(t || tu)) {                         // a space glyph: a word break (at the end: the end)
          if (xs[ci] > soft) { stopped = true; total--; continue; }
          if (units.length && !/\s$/.test(units[units.length - 1].t)) { units.push({ t: ' ', v: true }); recs.push({ space: true }); }
          if (t) fromFont++;
          prevEnd = xe(ci); continue;
        }
        if (t) { units.push({ t, v: true }); fromFont++; } else if (tu) units.push({ t: tu, v: false });
        recs.push({ k: fr ? String(lf.ref) : null, g: fr ? fr.gid(code) : null, t, v: !!t, tu, noGsub: !!(fr && !fr.reader.hasGSUB), name: lf ? String(lf.baseName || '').replace(/^\/?[A-Z]{6}\+/, '') : '', u: t || tu ? units.length - 1 : -1 });
        prevEnd = xe(ci); xMax = Math.max(xMax, prevEnd);
      }
    }
    if (!total) return null;
    // learned glyph map (this document only): glyphs the font can't explain, read from lines accepted earlier
    let learned = 0, lunits = units;
    if (maps) {
      lunits = [];
      const ok = (m) => m && !m.conflict;
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (r.space) { lunits.push({ t: ' ', v: true }); continue; }
        if (r.u < 0) continue;
        let hit = null;
        if (r.k && maps[r.k]) {
          const fm = maps[r.k].maps;
          for (let n = Math.min(8, recs.length - i); n >= 2 && !hit; n--) {
            const seq = recs.slice(i, i + n);
            if (seq.some((x) => x.space || x.k !== r.k || x.u < 0) || seq.every((x) => x.v)) continue;
            const m = fm['c:' + seq.map((x) => x.g).join(',')];
            if (ok(m)) hit = { t: m.t, n };
          }
          if (!hit && !r.v && ok(fm['g:' + r.g])) hit = { t: fm['g:' + r.g].t, n: 1 };
        }
        if (hit) { lunits.push({ t: hit.t, v: true, learned: true }); learned++; i += hit.n - 1; }
        else lunits.push(units[r.u]);
      }
      if (!learned) lunits = units;
    }
    const r = V.reorder(lunits);
    r.xMax = xMax;
    r.coverage = total ? fromFont / total : 0;
    r.learned = learned;
    Object.defineProperty(r, 'recs', { value: recs, enumerable: false });
    return r;
  }
  /**
   * Per-document learned glyph map (Word subsets without GSUB): after a line's reading is accepted (auto-accepted
   * or confirmed), line its glyphs up with the accepted text and record glyph-sequence -> text for that font.
   * Kept in state.glyphMaps[src][fontObject] = { name, maps: { 'c:g1,g2': {t, n} | 'g:g': {t, n} | {conflict} } }
   * (plain JSON, part of the app state, never shared across documents). Only unambiguous alignments are used:
   * same number of words; per word, the glyph count equals the HarfBuzz/Noto glyph count of the accepted text and
   * the clusters partition the glyphs one-to-one; every glyph the font does explain agrees with Noto's glyph at the
   * same position. A differing observation cancels a mapping for good.
   */
  const notoReaders = new Map();
  const learnStats = {};
  const stat = (k, x) => { learnStats[k] = (learnStats[k] || 0) + 1; if (x && learnStats.samples && learnStats.samples.length < 400) learnStats.samples.push(Object.assign({ k }, x)); };
  async function learnGlyphs(state, src, font, text) {
    if (!state || !font || !font.recs || !text) return 0;
    const recs = font.recs;
    if (!recs.some((r) => r.k && r.noGsub && !r.v)) { stat(recs.some((r) => r.k && !r.v) ? 'gsubFont' : 'nothingUnknown'); return 0; }
    const V = await verifyLib(), I = await indicEngine();
    const words = [[]]; for (const r of recs) { if (r.space) { if (words[words.length - 1].length) words.push([]); } else if (r.u >= 0) words[words.length - 1].push(r); }
    if (!words[words.length - 1].length) words.pop();
    const tw = V.norm(text).split(' ').filter(Boolean);
    if (tw.length !== words.length) { stat('wordCount', { tw, fw: words.map((w) => w.map((r) => r.t || '?' + (r.tu || '')).join('|')) }); return 0; }
    const canon = (x) => (x == null ? null : x[0] === '\uE000' ? x[1] : x.normalize('NFC'));
    const VIR = /[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D]/;
    const cons = (x, c) => { const q = Array.from(x.normalize('NFC')); return q.length === 2 && q.includes(c) && q.some((ch) => VIR.test(ch)); };
    const agree = (a, b) => {
      if (a === b || canon(a) === canon(b)) return true;
      if (a[0] === '\uE000') return cons(b, a[1]);
      if (b[0] === '\uE000') return cons(a, b[1]);
      return false;
    };
    const obs = [];
    for (let w = 0; w < words.length; w++) {
      const gl = words[w];
      let cl; try { cl = await I.clusters(tw[w]); } catch (e) { return 0; }
      if (cl.reduce((n, c) => n + c.n, 0) !== gl.length) { stat('glyphCount', { w: tw[w], noto: cl.map((c) => c.text + ':' + c.n).join(' '), pdf: gl.map((r) => r.t || '?' + (r.tu || '')).join('|') }); continue; }
      let pos = 0, bad = false; const wobs = [];
      for (const c of cl) {
        const part = gl.slice(pos, pos + c.n); pos += c.n;
        let rd = notoReaders.get(c.font);
        if (!rd) { const nf = await I.font(c.font); rd = V.glyphReader(nf.fk); notoReaders.set(c.font, rd); }
        const nt = c.gids.map((g) => rd.read(g, null));
        const ctext = c.text.normalize('NFC');
        for (let j = 0; j < part.length; j++) {
          const r = part[j];
          if (!r.v) continue;
          if (nt[j] == null || !agree(r.t, nt[j])) { bad = true; stat('glyphDisagree', { w: tw[w], at: j, pdf: r.t, noto: nt[j], cl: c.text }); break; }
          if (!Array.from(canon(r.t).replace(/\s/g, '')).every((ch) => ctext.includes(ch))) { bad = true; stat('notInCluster', { w: tw[w], pdf: r.t, cl: c.text }); break; }
        }
        if (bad) break;
        const unk = part.filter((r) => !r.v);
        if (!unk.length) continue;
        if (!part.every((r) => r.k && r.k === part[0].k && r.noGsub)) continue;
        wobs.push({ k: part[0].k, name: part[0].name, key: part.length > 1 ? 'c:' + part.map((r) => r.g).join(',') : 'g:' + part[0].g, t: ctext });
        if (unk.length === 1 && part.length > 1) {
          const j = part.indexOf(unk[0]);
          if (nt[j] != null && nt[j][0] !== '\uE000' && /[\u0900-\u0D7F]/.test(nt[j])) wobs.push({ k: unk[0].k, name: unk[0].name, key: 'g:' + unk[0].g, t: nt[j].normalize('NFC') });
        }
      }
      if (!bad && pos === gl.length) { obs.push(...wobs); stat(wobs.length ? 'wordLearned' : 'wordNoUnknown'); }
    }
    if (!obs.length) return 0;
    state.glyphMaps = state.glyphMaps || {};
    const dm = state.glyphMaps[src] = state.glyphMaps[src] || {};
    let added = 0;
    for (const o of obs) {
      const f = dm[o.k] = dm[o.k] || { name: o.name, maps: {} };
      const m = f.maps[o.key];
      if (!m) { f.maps[o.key] = { t: o.t, n: 1 }; added++; }
      else if (m.conflict) continue;
      else if (m.t === o.t) m.n++;
      else f.maps[o.key] = { conflict: true, t: [m.t, o.t] };
    }
    return added;
  }
  /** The user confirmed the true reading of a flagged line: learn its glyphs (this document only). */
  async function confirmIndicReading(state, pageIndex, lineId, text) {
    const pg = state && state.pages[pageIndex];
    if (!pg || pg.src == null) return { ok: false, learned: 0 };
    const an = await analyzePage(pg.src, pg.index);
    const ln = an.lines.find((l) => l.id === lineId);
    if (!ln || ln.verify === 'legacy') return { ok: !!ln, learned: 0 };
    let font = null;
    try { font = await fontReadingFor(an, ln, null); } catch (e) { font = null; }
    const learned = await learnGlyphs(state, pg.src, font, text);
    return { ok: true, learned };
  }
  /** The original rendering of a line (source page, unedited) on a white canvas at `dpi`. */
  async function lineImage(an, ln, dpi, xEnd) {
    const sz = ln.size;
    let scale = (dpi || 300) / 72;
    const x0 = ln.x - 0.12 * sz, xNom = Math.max(ln.x + ln.width, Math.min(xEnd || -Infinity, ln.x + 3 * ln.width)) + 0.12 * sz;
    const x1 = xNom + 3 * sz, yTop = ln.y + 1.05 * sz, yBot = ln.y - 0.45 * sz;     // rendered 3 em wider, then trimmed by ink
    scale = Math.min(scale, 6000 / Math.max(1, x1 - x0), 1200 / Math.max(1, yTop - yBot));
    const vb = an.page.getViewport({ scale, rotation: 0 });
    const p = vb.convertToViewportPoint(x0, yTop), q = vb.convertToViewportPoint(x1, yBot);
    const W = Math.max(8, Math.ceil(q[0] - p[0])), H = Math.max(8, Math.ceil(q[1] - p[1]));
    const vp = an.page.getViewport({ scale, rotation: 0, offsetX: -p[0], offsetY: -p[1] });
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    await an.page.render({ canvasContext: ctx, viewport: vp, background: 'rgba(255,255,255,1)' }).promise;
    // right edge: pdf.js widths of Word's Indic fonts are sometimes short (जाएगा। -> जाए), so grow the crop
    // through ink that continues within 0.15 em of the nominal end (at most 3 em)
    const nomPx = Math.min(W, Math.ceil((xNom - x0) * scale)), gapPx = Math.max(2, 0.15 * sz * scale);
    const img = ctx.getImageData(0, 0, W, H).data;
    const dark = (x, y) => { const o = (y * W + x) * 4; return img[o] + img[o + 1] + img[o + 2] < 3 * 150; };
    // rows that are mostly ink across the extension area are rules / underlines / cell borders, not text
    const rule = new Uint8Array(H);
    if (W - nomPx > 4) for (let y = 0; y < H; y++) { let n = 0; for (let x = nomPx; x < W; x++) if (dark(x, y)) n++; rule[y] = n > 0.6 * (W - nomPx) ? 1 : 0; }
    const inkCol = (c) => { for (let y = 0; y < H; y++) if (!rule[y] && dark(c, y)) return true; return false; };
    let last = nomPx - 1;
    for (let c = Math.max(0, nomPx - Math.ceil(gapPx)); c < W; c++) { if (inkCol(c)) last = Math.max(last, c); else if (c - last > gapPx && c >= nomPx) break; }
    const cut = Math.min(W, Math.max(nomPx, last + Math.ceil(0.1 * sz * scale)));
    if (cut < W) {
      const out = document.createElement('canvas'); out.width = cut; out.height = H;
      out.getContext('2d').drawImage(canvas, 0, 0);
      return out;
    }
    return canvas;
  }
  /**
   * Check the reading of an Indic line before it is edited.
   * -> { ok, decision: 'text'|'silent'|'confirm', best, why, textLayer, font, ocr, marks, image, ms, rule }
   * 'text': the text layer is right (font reading agrees); 'silent': font reading and OCR agree (per
   * INDIC_AUTOACCEPT) and the text layer was wrong; 'confirm': the user must check the prefilled best guess.
   */
  async function verifyIndicLine(pg, lineId, opts) {
    opts = opts || {};
    const t0 = performance.now();
    const an = await analyzePage(pg.src, pg.index);
    const ln = an.lines.find((l) => l.id === lineId);
    if (!ln) {
      // a line added with "Add like this": retype it in the same font plan; empty text removes it
      const ie = (pg.textEdits || []).find((x) => x.lineId === lineId && x.insert && x.kind === 'text');
      if (!ie) return { ok: false, message: 'That line could not be found.' };
      const text = String(newText).replace(/[\r\n\t]+/g, ' ').replace(/\s+$/, '');
      if (!text.trim()) { pg.textEdits = pg.textEdits.filter((x) => x !== ie); return { ok: true, edit: null, message: 'Added line removed.' }; }
      const src = an.lines.find((l) => l.id === ie.srcLineId);
      const fp = src && await fontPlanFor(an, src, text);
      if (!fp) return { ok: false, message: 'Some of these characters aren’t available in the matching fonts.' };
      Object.assign(ie, { text, tier: fp.tier, label: fp.label, t1: fp.t1, sub: fp.sub, newW: Math.round(fp.w * 1000) / 1000 });
      const over = await columnOverflow(state, pageIndex, lineId);
      return { ok: true, edit: ie, message: 'Text replaced.', overflow: over };
    }
    if (!ln.editable) return { ok: false, message: ln.reason };
    const V = await verifyLib();
    let font = null;
    const legacy = ln.verify === 'legacy';
    const maps = opts.state && opts.state.glyphMaps ? opts.state.glyphMaps[pg.src] || null : null;
    if (legacy) font = { text: V.legacyToUnicode(ln.text, ln.legacyVariant), graphemes: [], complete: false, unverified: 0, legacy: true };
    else try { font = await fontReadingFor(an, ln, maps); } catch (e) { console.warn(e); font = null; }
    const ms = { font: Math.round(performance.now() - t0) };
    const flagged = !!ln.verify;
    const base = { ok: true, lineId, flagged, legacy, legacyFont: ln.legacyFont || null, reason: ln.verifyReason || '', rule: V.INDIC_AUTOACCEPT };
    // clean-looking line: no OCR unless the glyphs themselves say something else
    if (!flagged && !legacy && !opts.forceOcr && font && font.complete && !font.learned && V.cmpKey(font.text) === V.cmpKey(ln.text)) {
      return Object.assign(base, { decision: 'text', source: 'font', best: ln.text, why: 'every glyph read back from the font matches the text layer', textLayer: V.norm(ln.text), font: font && font.text, ocr: null, ms });
    }
    const canvas = await lineImage(an, ln, 300, font && font.xMax);
    ms.render = Math.round(performance.now() - t0 - ms.font);
    let ocr = null, ocrError = null;
    if (opts.ocr !== false) {
      try {
        if (!ocrEngine) ocrEngine = V.create({ BASE, loadScript });
        ocr = await ocrEngine.ocr(canvas, V.langsFor((font && font.text) || ln.text), opts.onStatus);
        ocr.raw = ocr.text; ocr.text = V.trimEdges(ocr.text, [(font && font.text) || '', ln.text]);
        ms.ocrLoad = ocr.loadMs; ms.ocr = ocr.ms;
      } catch (e) {
        ocrError = e && e.code === 'file' ? 'OCR needs Pdfroo to be opened over http(s), so only the font reading is available.' : 'OCR couldn’t run here, so only the font reading is available.';
        if (!(e && e.code === 'file')) console.warn(e);
      }
    }
    // a clean-looking line whose glyphs can't be read back and OCR can't run (file://): nothing contradicts it
    if (!flagged && !legacy && !font && !ocr) return Object.assign(base, { decision: 'text', source: 'text layer', best: ln.text, why: 'text layer is well-formed (no readable font program, OCR unavailable)', textLayer: V.norm(ln.text), font: null, ocr: null, ms });
    const d = V.decide({ textLayer: ln.text, flagged, font, ocr, legacy, rule: V.INDIC_AUTOACCEPT });
    const learnedGlyphs = font && !legacy ? font.learned || 0 : 0;
    // an accepted reading teaches this document's glyph map
    if (opts.state && !legacy && d.decision !== 'confirm' && font) { try { await learnGlyphs(opts.state, pg.src, font, d.best); } catch (e) { console.warn(e); } }
    if (d.decision === 'text') { ms.total = Math.round(performance.now() - t0); return Object.assign(base, d, { ocrConf: ocr && ocr.conf, ms, learnedGlyphs }); }
    ln.verifiedText = d.best;
    const mk = (t) => (t == null ? null : V.marks(t, d.best));
    ms.total = Math.round(performance.now() - t0);
    return Object.assign(base, d, {
      ocrConf: ocr ? ocr.conf : null, ocrError, langs: ocr ? ocr.langs : V.langsFor(ln.text), learnedGlyphs,
      unverified: font ? font.unverified : null,
      marks: { textLayer: mk(d.textLayer), font: mk(d.font), ocr: mk(d.ocr) },
      image: opts.image === false ? null : canvas.toDataURL('image/png'), imageSize: [canvas.width, canvas.height], ms,
    });
  }

  /* ---------- bullets ---------- */
  const BULLET_CHARS = /^[\u2022\u2023\u2043\u2219\u00B7\u25CF\u25CB\u25AA\u25AB\u25A0\u25A1\u25E6\u25BA\u25B8\u25B6\u27A2\u2794\u2713\u2714\u2666\u2756\u2605\u2013\u2014\-*>\uE000-\uF8FF]$/;
  const SYMBOL_FONT_RE = /symbol|dingbat|wingding|webding/i;
  /** A run that is only a list marker (•, ●, ▪, , –, a one-character symbol-font glyph …). */
  function isBulletRun(ln) {
    const t = String(ln.text || '').trim();
    if (!t || Array.from(t).length > 1) return false;
    return BULLET_CHARS.test(t) || SYMBOL_FONT_RE.test(ln.fontLabel || '') || SYMBOL_FONT_RE.test(ln.fontName || '');
  }
  /** The text line a bullet belongs to: the nearest line starting just right of it (first line of its paragraph);
   *  lines that already have a bullet on their own baseline belong to that one. pos(l) -> {x, y} (current position). */
  function bulletTarget(b, lines, pos) {
    const P = pos || ((l) => ({ x: l.x, y: l.y }));
    const pb = P(b);
    const cands = lines.filter((c) => c !== b && !isBulletRun(c) && String(c.text).trim() && Math.abs(c.b) < 0.02 * c.size && (() => {
      const pc = P(c), gap = pc.x - pb.x;
      return gap > 0.25 * c.size && gap < 3 * Math.max(c.size, b.size) && Math.abs(pc.y - pb.y) <= 1.8 * c.size;
    })());
    if (!cands.length) return null;
    const bullets = lines.filter((x) => x !== b && isBulletRun(x));
    const owned = (c) => bullets.some((o) => { const po = P(o), pc = P(c); return Math.abs(po.y - pc.y) <= 0.5 * c.size && pc.x - po.x > 0.25 * c.size && pc.x - po.x < 3 * c.size; });
    let best = null, bs = Infinity;
    for (const c of cands) {
      const dy = P(c).y - pb.y;
      if (Math.abs(dy) > 0.12 * c.size && owned(c)) continue;
      const sc = Math.abs(dy) * (dy > 0 ? 1.5 : 1);           // a bullet usually floats ABOVE its line: prefer the line below
      if (sc < bs) { bs = sc; best = c; }
    }
    return best;
  }
  function markStrayBullets(lines) {
    for (const b of lines) {
      if (!isBulletRun(b) || !b.movable) continue;
      b.bullet = true;
      const t = bulletTarget(b, lines);
      if (!t) continue;
      const dy = t.y - b.y;
      if (Math.abs(dy) > 0.12 * t.size) b.strayBullet = { target: t.id, dy: Math.round(dy * 1000) / 1000 };
    }
  }

  /** Lines on a page for the UI, in displayed-page coordinates (points, top-left origin). */
  async function getTextLines(pg) {
    if (pg.src == null || !sources[pg.src]) return { refusal: { code: 'blank', message: 'This page has no text to edit (it’s a blank page you added).' }, lines: [] };
    if (!sources[pg.src].libDoc) return { refusal: { code: 'unsupported', message: 'Pdfroo couldn’t read this PDF’s structure, so its text can’t be edited.' }, lines: [] };
    const an = await analyzePage(pg.src, pg.index);
    const vp = an.page.getViewport({ scale: 1, rotation: totalRotation(pg) });
    const edits = pg.textEdits || [];
    const out = [];
    for (const ln of an.lines) {
      const e = edits.find((x) => x.lineId === ln.id);
      const mv = e && e.move ? e.move : { dx: 0, dy: e ? 0 : lineShift(pg, ln) };
      let w = ln.width;
      if (e) { const f = e.sub && editFontCache[e.sub.key] ? await editFontCache[e.sub.key] : null; w = e.newW != null && !e.moveOnly ? Math.max(1, e.newW) : Math.max(w, editWidth(e, f && f.fk)); }
      // outline polygon along the text direction (rotated lines get a rotated outline)
      const len = Math.hypot(ln.a, ln.b) || 1, ux = ln.a / len, uy = ln.b / len;
      const plen = Math.hypot(ln.c, ln.d) || 1, vx = ln.c / plen, vy = ln.d / plen;
      const ax = e && e.alignDx && !e.moveOnly ? e.alignDx : 0, S = (e && e.style && e.style.size) || ln.size;
      const corner = (u, v) => vp.convertToViewportPoint(ln.x + mv.dx + ax + ux * u + vx * v, ln.y + mv.dy + uy * u + vy * v);
      const poly = [corner(0, ln.desc * S), corner(w, ln.desc * S), corner(w, ln.asc * S), corner(0, ln.asc * S)];
      // the box also covers where the original text was (it is removed there), e.g. a shortened or re-aligned line
      const cornerO = (u, v) => vp.convertToViewportPoint(ln.x + mv.dx + ux * u + vx * v, ln.y + mv.dy + uy * u + vy * v);
      const span = e && !e.moveOnly ? poly.concat([cornerO(0, ln.desc * ln.size), cornerO(ln.width, ln.desc * ln.size), cornerO(ln.width, ln.asc * ln.size), cornerO(0, ln.asc * ln.size)]) : poly;
      const xs = span.map((q) => q[0]), ys = span.map((q) => q[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      out.push({
        id: ln.id, x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0, poly: poly.map((q) => [+q[0].toFixed(2), +q[1].toFixed(2)]),
        text: e ? e.text : ln.text, original: ln.text, edited: !!e, editable: ln.editable, reason: ln.reason,
        fontLabel: ln.fontLabel, size: S, origSize: ln.size, color: (e && e.color) || ln.color, bg: ln.bg,
        bold: e && e.style && e.style.bold != null ? e.style.bold : ln.bold, italic: e && e.style && e.style.italic != null ? e.style.italic : ln.italic,
        style: e && e.style ? Object.assign({}, e.style) : null, align: e ? e.align || null : null,
        label: e ? e.label : null, tier: e ? e.tier : null, rotation: totalRotation(pg),
        indic: !!ln.indic, verify: ln.verify || null, verified: !!(e && e.verified),
        movable: !!ln.movable, moved: !!(e && e.move && (e.move.dx || e.move.dy)), move: e && e.move ? Object.assign({}, e.move) : null, moveOnly: !!(e && e.moveOnly),
        bullet: !!ln.bullet, strayBullet: null, pdf: { x: ln.x + mv.dx, y: ln.y + mv.dy, size: ln.size, width: ln.width },
      });
    }
    // lines added with "Add like this" are editable too
    for (const e of edits) {
      if (!e.insert || e.kind !== 'text') continue;
      const src = an.lines.find((l) => l.id === e.srcLineId) || {};
      const mv = e.move || { dx: 0, dy: 0 }, g = e.geo, w = Math.max(e.newW || 0, 0.3 * g.size);
      const c = (u, v) => vp.convertToViewportPoint(g.x + mv.dx + u, g.y + mv.dy + v);
      const poly = [c(0, g.desc * g.size), c(w, g.desc * g.size), c(w, g.asc * g.size), c(0, g.asc * g.size)];
      const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]), x0 = Math.min(...xs), y0 = Math.min(...ys);
      out.push({ id: e.lineId, x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0, poly: poly.map((q) => [+q[0].toFixed(2), +q[1].toFixed(2)]),
        text: e.text, original: '', edited: true, editable: true, reason: null, fontLabel: src.fontLabel, size: g.size, origSize: g.size, color: e.color, bg: e.bg,
        bold: !!src.bold, italic: !!src.italic, style: null, align: null, label: e.label, tier: e.tier, rotation: totalRotation(pg), indic: false, verify: null, verified: true,
        movable: false, moved: false, move: null, moveOnly: false, bullet: false, strayBullet: null, inserted: true, group: e.group, pdf: { x: g.x + mv.dx, y: g.y + mv.dy, size: g.size, width: e.newW || 0 } });
    }
    // stray bullets, with the current (moved) positions
    const pos = (l) => { const e = edits.find((x) => x.lineId === l.id); return { x: l.x + (e && e.move ? e.move.dx : 0), y: l.y + (e ? (e.move ? e.move.dy : 0) : lineShift(pg, l)) }; };
    for (const o of out) {
      const ln = an.lines.find((l) => l.id === o.id);
      if (!ln || !ln.bullet) continue;
      const t = bulletTarget(ln, an.lines, pos);
      if (!t) continue;
      const dy = pos(t).y - pos(ln).y;
      if (Math.abs(dy) > 0.12 * t.size) o.strayBullet = { target: t.id, dy: Math.round(dy * 1000) / 1000 };
    }
    return { refusal: an.refusal, lines: out };
  }

  /** Convert a displayed-page offset (points, y down, after page rotation) to a PDF user-space offset (y up). */
  function displayDeltaToPdf(pg, ddx, ddy) {
    const r = ((totalRotation(pg) % 360) + 360) % 360;
    const v = r === 0 ? [ddx, -ddy] : r === 90 ? [ddy, ddx] : r === 180 ? [-ddx, ddy] : [-ddy, -ddx];
    return { dx: v[0] + 0, dy: v[1] + 0 };
  }
  /* ---------------- Find & replace (across one or many documents) ---------------- */
  const escRe = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function findRegex(query, opts) {
    opts = opts || {};
    let src = escRe(String(query || ''));
    if (!src) return null;
    if (opts.wholeWord) src = '(?<![\\p{L}\\p{N}_])' + src + '(?![\\p{L}\\p{N}_])';
    return new RegExp(src, 'gu' + (opts.matchCase ? '' : 'i'));
  }
  let findMeasureCtx = null;
  /** Fractions (0..1) of a line's width where text[a..b] starts / ends (canvas measure in a similar generic face). */
  function spanFractions(text, a, b, serif) {
    if (!findMeasureCtx) { try { findMeasureCtx = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas')).getContext('2d'); } catch (e) { findMeasureCtx = null; } }
    const n = text.length || 1;
    if (!findMeasureCtx) return [a / n, b / n];
    findMeasureCtx.font = '100px ' + (serif ? 'serif' : 'sans-serif');
    const W = findMeasureCtx.measureText(text).width || 1;
    return [findMeasureCtx.measureText(text.slice(0, a)).width / W, findMeasureCtx.measureText(text.slice(0, b)).width / W];
  }
  /**
   * Find `query` in every page of `state`. Returns { hits, notes } — hits carry the line, the match offsets, whether
   * the line can be edited (and why not), and a highlight polygon in displayed-page points; notes list pages that
   * can't be searched (scans without a text layer, blank pages).
   */
  async function findText(state, query, opts) {
    const re = findRegex(query, opts);
    const hits = [], notes = [];
    if (!re) return { hits, notes };
    for (let pi = 0; pi < state.pages.length; pi++) {
      const pg = state.pages[pi];
      if (pg.src == null) continue;
      let data;
      try { data = await getTextLines(pg); } catch (err) { notes.push({ pageIndex: pi, message: 'Pdfroo couldn’t read the text on this page.' }); continue; }
      if (!data.lines.length) {
        if (data.refusal) notes.push({ pageIndex: pi, code: data.refusal.code, message: data.refusal.message });
        continue;
      }
      const an = await analyzePage(pg.src, pg.index);
      for (const ln of data.lines) {
        const text = String(ln.text || '');
        re.lastIndex = 0; let m;
        while ((m = re.exec(text))) {
          if (!m[0].length) { re.lastIndex++; continue; }
          const a = m.index, b = a + m[0].length;
          const L = an.lines.find((x) => x.id === ln.id) || {};
          const [f0, f1] = spanFractions(text, a, b, L.serif);
          const P = ln.poly || [[ln.x, ln.y + ln.h], [ln.x + ln.w, ln.y + ln.h], [ln.x + ln.w, ln.y], [ln.x, ln.y]];
          const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
          let reason = null;
          if (!ln.editable) reason = ln.reason || 'This text can’t be edited.';
          else if (ln.verify && !ln.verified) reason = 'This line’s copied text doesn’t match what’s printed — open it in the editor to check it first.';
          hits.push({
            id: pi + ':' + ln.id + ':' + a, pageIndex: pi, lineId: ln.id, start: a, end: b, match: m[0], lineText: text,
            editable: !reason, reason, fontLabel: ln.fontLabel, edited: !!ln.edited,
            poly: [lerp(P[0], P[1], f0), lerp(P[0], P[1], f1), lerp(P[3], P[2], f1), lerp(P[3], P[2], f0)].map((q) => [+q[0].toFixed(2), +q[1].toFixed(2)]),
          });
        }
      }
    }
    return { hits, notes };
  }
  /**
   * Replace the given hits (from findText on this state) with `replacement` ('' deletes the match). Each line is
   * rewritten once through editTextLine, so the edit-text font tiers apply (original font first). Returns one
   * result per hit: { id, ok, message, tier?, label? } — hits that can't be edited come back with the reason.
   */
  async function replaceHits(state, hits, replacement, opts) {
    const rep = String(replacement == null ? '' : replacement);
    const byLine = new Map();
    for (const h of hits) { const k = h.pageIndex + ':' + h.lineId; if (!byLine.has(k)) byLine.set(k, []); byLine.get(k).push(h); }
    const results = [];
    for (const [, hs] of byLine) {
      const { pageIndex, lineId } = hs[0];
      const pg = state.pages[pageIndex];
      const done = (ok, message, extra) => hs.forEach((h) => results.push(Object.assign({ id: h.id, ok, message }, extra || {})));
      if (!pg) { done(false, 'That page is no longer in the document.'); continue; }
      const blocked = hs.find((h) => !h.editable);
      if (blocked) { done(false, blocked.reason); continue; }
      const data = await getTextLines(pg);
      const ln = data.lines.find((l) => l.id === lineId);
      if (!ln) { done(false, 'That line could not be found.'); continue; }
      if (ln.text !== hs[0].lineText) { done(false, 'This line changed since the search — search again.'); continue; }
      let text = ln.text;
      for (const h of hs.slice().sort((a, b) => b.start - a.start)) {
        let a = h.start, b = h.end;
        if (!rep) {                                               // deleting: don't leave a double space behind
          if (text[b] === ' ' && (a === 0 || text[a - 1] === ' ')) b++;
          else if (text[a - 1] === ' ' && (b === text.length || /[\s.,;:!?)]/.test(text[b]))) a--;
        }
        text = text.slice(0, a) + rep + text.slice(b);
      }
      let r;
      try { r = await editTextLine(state, pageIndex, lineId, text, Object.assign({}, ln.verified ? { verified: true } : {}, opts || {})); }
      catch (err) { r = { ok: false, message: 'Something went wrong while editing this line.' }; }
      done(!!r.ok, r.message, r.edit ? { tier: r.edit.tier, label: r.edit.label, newText: text } : { newText: text });
    }
    return results;
  }

  /** CSS font info to style the inline editor like the line (loads the substitute font lazily). */
  async function getLineEditorFont(pg, lineId) {
    const an = await analyzePage(pg.src, pg.index);
    const ln = an.lines.find((l) => l.id === lineId);
    if (!ln) return null;
    const cand = ln.sub.t2 || ln.sub.t3;
    let family = ln.serif ? 'serif' : ln.mono ? 'monospace' : 'sans-serif';
    if (cand.indic) {
      try { await ensureScriptFonts(ln.text, ln.bold && !ln.fakeBold); } catch (e) { /* preview falls back */ }
      family = `"Folio Noto Sans", ${INDIC_FAMILIES}, ${family}`;
      return { family, size: ln.size, color: ln.color, weight: ln.bold || ln.fakeBold ? 700 : 400, style: 'normal', hs: ln.hs, ascent: ln.asc, descent: ln.desc, indic: true };
    }
    try { const f = await getEditFont(cand.key); family = `"${f.family}", ${INDIC_FAMILIES}, ${family}`; } catch (e) { /* generic */ }
    return { family, size: ln.size, color: ln.color, weight: (ln.bold || ln.fakeBold) && !/Bold/.test(cand.key) ? 700 : 400, style: 'normal', hs: ln.hs, ascent: ln.asc, descent: ln.desc };
  }

  // Which char codes of a pdf.js font have a real (non-empty) glyph in the embedded font program?
  const glyphCache = new WeakMap();
  function glyphCodes(pf) {
    const fo = pf && pf.fo;
    if (!fo || !fo.data || !fo.toFontChar || !root.fontkit) return null;
    if (glyphCache.has(fo)) return glyphCache.get(fo);
    let set = null;
    try {
      const f = root.fontkit.create(fo.data instanceof Uint8Array ? fo.data : new Uint8Array(fo.data));
      set = new Set();
      for (const [code, fc] of Object.entries(fo.toFontChar)) {
        const cp = typeof fc === 'number' ? fc : (typeof fc === 'string' ? fc.codePointAt(0) : null);
        if (cp == null) continue;
        const g = f.glyphForCodePoint(cp);
        if (g && g.id && g.path && g.path.commands.length) set.add(+code);
      }
    } catch (e) { set = null; }
    glyphCache.set(fo, set);
    return set;
  }

  function tier1Plan(an, ln, text, useProgram, extraSpace) {
    if (!ln.fontKey || ln.removal !== 'stream') return null;
    const lf0 = an.libFonts[ln.fontKey];
    if (!lf0) return null;
    const usable = (lf, pf) => lf && pf && !lf.type3 && lf.identity && pf.toUnicode &&
      !(lf.fsType != null && ((lf.fsType & 0x000F) === 0x0002 || (lf.fsType & 0x0200)));   // restricted licence / bitmap only
    // Candidate fonts: the line's own font first, then "siblings" — other font objects on the page with
    // the same family and style (Word, for example, splits one font into a CID and a WinAnsi subset,
    // each holding different glyphs). Switching between them inside the line keeps the original face.
    const cands = [];
    const add = (keys, pfName) => {
      const lf = an.libFonts[keys[0]], pf = an.pfonts[pfName];
      if (!usable(lf, pf) || cands.some((c) => c.pfName === pfName)) return;
      // For embedded (usually subset) fonts only use codes that this page already shows with the
      // font — those glyphs are guaranteed to exist. Non-embedded fonts are supplied by the viewer.
      const used = new Set(); keys.forEach((k) => (an.usedCodes[k] || []).forEach((c) => used.add(c)));
      const prog = useProgram && lf.embedded ? glyphCodes(pf) : null;
      const hasW = (code) => (pf.widths[code] != null ? pf.widths[code] : pf.defaultWidth) > 0;
      const explicit = (code) => lf.encExplicit === 'all' || (Array.isArray(lf.encExplicit) && lf.encExplicit.includes(code));
      const rev = new Map();
      // codes the page already shows always win; then (second chance) codes whose glyph exists in the
      // embedded program AND whose encoding is spelled out in the PDF (so every viewer agrees on it)
      pf.toUnicode.forEach((u, code) => {
        if (typeof u === 'string' && u && !rev.has(u) && (!lf.embedded || used.has(code))) rev.set(u, code);
      });
      if (prog) pf.toUnicode.forEach((u, code) => {
        if (typeof u === 'string' && u && !rev.has(u) && prog.has(code) && hasW(code) && explicit(code)) rev.set(u, code);
      });
      // a sibling must be the same face: variable-font instances (Typst) share one name across weights, so compare the
      // advance widths of characters both objects show
      if (cands.length) {
        const m = cands[0]; let n = 0, bad = 0;
        rev.forEach((code, u) => { const mc = m.rev.get(u); if (mc == null || u === ' ') return; const w1 = m.pf.widths[mc], w2 = pf.widths[code]; if (!(w1 > 0 && w2 > 0)) return; n++; if (Math.abs(w1 - w2) > 0.015 * Math.max(w1, w2) + 1) bad++; });
        if (bad > 0 && bad >= 0.1 * n) return;
      }
      cands.push({ key: keys[0], pfName, pf, lf, rev });
    };
    add(ln.fontKeys || [ln.fontKey], ln.fontName);
    if (!cands.length) return null;
    const groups = {};
    for (const [k, lf] of Object.entries(an.libFonts)) {
      if (!lf.pdfjs || lf.pdfjs === ln.fontName || lf.norm !== lf0.norm || lf.embedded !== lf0.embedded) continue;
      (groups[lf.pdfjs] = groups[lf.pdfjs] || []).push(k);
    }
    Object.entries(groups).forEach(([pfName, keys]) => add(keys, pfName));
    const main = cands[0];
    const spaceCode = main.rev.get(' ');
    const spaceW = spaceCode != null && main.pf.widths[spaceCode] ? main.pf.widths[spaceCode] : 250;
    const segs = []; let units = 0, cur = null;
    for (const ch of Array.from(text)) {
      if (ch === ' ') { segs.push({ space: true }); units += spaceW; continue; }
      const c = cands.find((x) => x.rev.has(ch));
      if (!c) return null;
      const code = c.rev.get(ch);
      if (!cur || cur.c !== c || segs[segs.length - 1] !== cur) { cur = { c, hex: '' }; segs.push(cur); }
      cur.hex += code.toString(16).toUpperCase().padStart(c.lf.composite ? 4 : 2, '0');
      units += c.pf.widths[code] != null ? c.pf.widths[code] : c.pf.defaultWidth;
    }
    // emit: TJ arrays per font run, spaces as kerning (font-size relative, so font-independent)
    let out = '', arr = [], font = main;
    const flush = () => { if (arr.length) { out += '[' + arr.join(' ') + '] TJ '; arr = []; } };
    for (const sg of segs) {
      if (sg.space) { arr.push(String(Math.round((-spaceW - (extraSpace || 0)) * 1000) / 1000)); continue; }
      if (sg.c !== font) { flush(); out += '/' + sg.c.key + ' 1 Tf '; font = sg.c; }
      arr.push('<' + sg.hex + '>');
    }
    flush();
    const keys = [...new Set(segs.filter((x) => !x.space).map((x) => x.c.key).concat([main.key]))];
    const nsp = segs.filter((x) => x.space).length;
    return { key: main.key, keys, tj: out.trim(), width: (units + nsp * (extraSpace || 0)) / 1000 * ln.size * ln.hs, natural: units / 1000 * ln.size * ln.hs, spaces: nsp, spaceW, mixed: keys.length > 1 };
  }


  /** How a line sits in its block: 'right' (dates, amounts), 'center', 'justify' (full-width paragraph line) or 'left'. */
  function lineAlignment(an, ln) {
    const view = an.page && an.page.view; if (!view) return 'left';
    const pw = view[2] - view[0], r = ln.x + ln.width, sz = ln.size;
    const others = an.lines.filter((o) => o !== ln && String(o.text).trim() && Math.abs(o.b) < 0.02 * o.size && Math.abs(ln.b) < 0.02 * sz);
    const sameRow = others.filter((o) => Math.abs(o.y - ln.y) < 0.3 * sz);
    const rightM = others.filter((o) => Math.abs(o.y - ln.y) >= 0.3 * sz && Math.abs(o.x + o.width - r) < 1.5);
    const near = rightM.filter((o) => Math.abs(o.x - ln.x) < 1 && Math.abs(o.y - ln.y) < 4 * sz);
    const spaces = (String(ln.text).trim().match(/ /g) || []).length;
    if (near.length && spaces >= 3 && ln.width > 0.5 * pw) return 'justify';
    const leftOfMe = sameRow.some((o) => o.x < ln.x);
    if (r > pw * 0.55 && ln.x > pw * 0.4) {
      if (rightM.some((o) => Math.abs(o.x - ln.x) > 1)) return 'right';
      const maxR = Math.max(...others.map((o) => o.x + o.width), 0);
      if (!rightM.length && r >= maxR - 1.5 && !sameRow.some((o) => o.x > ln.x)) return 'right';
      if (leftOfMe && sameRow.every((o) => o.x < ln.x)) {           // table column: right-aligned numbers
        const col = others.filter((o) => Math.abs(o.x + o.width - r) < 1).length;
        if (col) return 'right';
      }
    }
    if (!sameRow.length && Math.abs(ln.x + ln.width / 2 - (view[0] + pw / 2)) < 2 && ln.x > pw * 0.15) return 'center';
    return 'left';
  }
  const famOf = (norm) => { let f = String(norm || ''), prev; do { prev = f; f = f.replace(/(bold|italic|oblique|semibold|demibold|demi|regular|medium|book|roman|black|heavy|light|it|mt|ps|bd|bi)$/, ''); } while (f !== prev && f); return f; };
  /** A font resource on the page from the same family in the wanted weight/style (e.g. Carlito-Bold next to Carlito-Regular). */
  function styledSibling(an, ln, bold, italic) {
    const lf0 = an.libFonts[ln.fontKey]; if (!lf0) return null;
    const fam = famOf(lf0.norm);
    for (const [k, lf] of Object.entries(an.libFonts)) {
      if (!lf.pdfjs || famOf(lf.norm) !== fam || lf.embedded !== lf0.embedded) continue;
      const tr = fontTraits(null, lf.baseName);
      if (tr.bold === bold && tr.italic === italic) return Object.assign({}, ln, { fontKey: k, fontKeys: [k], fontName: lf.pdfjs, fontLabel: TI().cleanName(lf.baseName) });
    }
    return null;
  }
  const STYLE_SUFFIX = /-(Regular|Bold|Italic|BoldItalic)$/;
  function restyleSub(cand, bold, italic) {
    if (!cand || cand.indic) return cand;
    let st = (bold ? 'Bold' : '') + (italic ? 'Italic' : '') || 'Regular';
    if (/^NotoSansMono/.test(cand.key) && italic) st = bold ? 'Bold' : 'Regular';
    const base = cand.label.replace(/ (Bold Italic|Bold|Italic)$/, '');
    return Object.assign({}, cand, { key: cand.key.replace(STYLE_SUFFIX, '-' + st), label: base + STYLE_NAMES[st] });
  }
  /** What the text toolbar can offer for a line: bold / italic availability (same family on the page, or a bundled face). */
  async function getLineStyleInfo(pg, lineId) {
    const an = await analyzePage(pg.src, pg.index);
    const ln = an.lines.find((l) => l.id === lineId);
    if (!ln) return null;
    const e = (pg.textEdits || []).find((x) => x.lineId === lineId);
    const st = (e && e.style) || {};
    const bold = st.bold != null ? st.bold : !!ln.bold, italic = st.italic != null ? st.italic : !!ln.italic;
    const canSub = !ln.indic && !!(ln.sub && (ln.sub.t2 || ln.sub.t3) && !(ln.sub.t3 && ln.sub.t3.indic));
    const sib = (b, i) => !!styledSibling(an, ln, b, i);
    const monoNoItalic = ln.sub && !ln.sub.t2 && ln.sub.t3 && /^NotoSansMono/.test(ln.sub.t3.key);
    return {
      bold, italic, size: st.size || ln.size, origSize: ln.size, color: (e && e.color) || ln.color || '#000000', origColor: ln.color || '#000000',
      align: (e && e.align) || lineAlignment(an, ln), alignAuto: !(st.align),
      canBold: canSub || sib(!bold, italic), canItalic: (canSub && !monoNoItalic) || sib(bold, !italic),
      boldSameFont: sib(!bold, italic), italicSameFont: sib(bold, !italic),
    };
  }

  /**
   * Plan + apply an edit of line `lineId` on page `pageIndex` to `newText`.
   * Mutates state.pages[pageIndex].textEdits; returns { ok, edit?, message? }.
   * (Callers snapshot state first for undo; the edit record is plain JSON.)
   */
  async function editTextLine(state, pageIndex, lineId, newText, opts) {
    const pg = state.pages[pageIndex];
    if (!pg || pg.src == null) return { ok: false, message: 'This page has no editable text.' };
    const an = await analyzePage(pg.src, pg.index);
    const ln = an.lines.find((l) => l.id === lineId);
    if (!ln) return { ok: false, message: 'That line could not be found.' };
    if (!ln.editable) return { ok: false, message: ln.reason };
    if (ln.verify && !(opts && opts.verified)) return { ok: false, message: 'This line’s text layer doesn’t match what’s printed, so its reading needs checking first — click the line to check it.' };
    const text = String(newText).replace(/[\r\n\t]+/g, ' ').replace(/\s+$/, '');
    const prevEdits = pg.textEdits || [];
    const prevE = prevEdits.find((x) => x.lineId === lineId) || null;
    // text styling (toolbar): size / bold / italic / colour / alignment; kept across later edits of the line
    const style = Object.assign({}, (prevE && prevE.style) || {}, (opts && opts.style) || {});
    Object.keys(style).forEach((k) => { if (style[k] == null) delete style[k]; });
    if (style.size != null && Math.abs(style.size - ln.size) < 0.01) delete style.size;
    if (style.bold != null && style.bold === !!ln.bold) delete style.bold;
    if (style.italic != null && style.italic === !!ln.italic) delete style.italic;
    if (style.color && ln.color && style.color.toLowerCase() === String(ln.color).toLowerCase()) delete style.color;
    const styled = Object.keys(style).some((k) => k !== 'align');
    const moveOnly = !!(opts && opts.moveOnly);
    const base0 = lineShift(pg, ln);
    const keepMove = (prevEdits.find((x) => x.lineId === lineId) || {}).move || (prevE ? null : base0 ? { dx: 0, dy: base0 } : null);
    if (!moveOnly && keepMove && text === ln.text) {        // text put back on a moved line: keep just the move
      pg.textEdits = prevEdits.filter((e) => e.lineId !== lineId);
      return moveTextLine(state, pageIndex, lineId, keepMove.dx, keepMove.dy - base0);
    }
    if (moveOnly || styled) { /* same text, new position or style */ } else if (text === ln.text || (ln.verify && ln.verifiedText && text === ln.verifiedText && !(opts && opts.repair))) { pg.textEdits = prevEdits.filter((e) => e.lineId !== lineId); return { ok: true, edit: null, message: 'Line restored to the original text.' }; }
    const fail = (message) => { pg.textEdits = prevEdits; return { ok: false, message }; };
    if (styled && ln.indic && (style.bold != null || style.italic != null)) return fail('Bold / italic can’t be changed on this line yet.');
    if (COMPLEX_SCRIPT_RE.test(text.replace(INDIC_STRIP_RE, ''))) return fail('Pdfroo can’t typeset this script into an existing line yet (e.g. Arabic, Hebrew, Thai, emoji). Use the Text tool instead.');
    const shapedPath = ln.indic || hasIndic(text);

    const e = {
      id: uid('te'), lineId, original: ln.text, text, tier: 0, label: '', verified: !!(opts && opts.verified), reading: ln.verifiedText || null, readingSource: (opts && opts.readingSource) || null, prefillSource: (opts && opts.prefillSource) || null,
      geo: { x: ln.x, y: ln.y, size: ln.size, hs: ln.hs, width: ln.width, asc: ln.asc, desc: ln.desc, cb: ln.coverBottom, ct: ln.coverTop, fb: ln.fakeBold || 0 },
      match: { x: ln.x, y: ln.y, end: ln.x + ln.width, size: ln.size, text: ln.text, fontKeys: ln.fontKeys },
      removal: ln.removal, color: style.color || ln.color || '#000000', bg: ln.bg || '#ffffff', t1: null, sub: null,
    };
    if (Object.keys(style).length) e.style = style;
    const S = style.size || ln.size, kS = S / ln.size;                 // drawn size
    const wantBold = style.bold != null ? style.bold : !!ln.bold, wantItalic = style.italic != null ? style.italic : !!ln.italic;
    const restyled = style.bold != null || style.italic != null;
    if (restyled && style.bold === false) e.geo.fb = 0;
    const lnT1 = restyled ? styledSibling(an, ln, wantBold, wantItalic) : ln;   // tier 1 in the same family's other face
    const mvv = moveOnly ? opts.move : (opts && opts.move) || keepMove;
    if (mvv && (mvv.dx || mvv.dy)) e.move = { dx: mvv.dx, dy: mvv.dy };
    if (moveOnly) e.moveOnly = true;
    let shapedW = 0;
    if (shapedPath) {
      // Indic: shaped with HarfBuzz in Noto Sans <Script> (the original font can't be reused: subset
      // fonts in PDFs have lost the GSUB/GPOS tables shaping needs); width-fitted to the original line
      let I, sh, orig;
      try {
        I = await indicEngine();
        const bold = !!(ln.bold && !ln.fakeBold);
        sh = await I.shape(text, { bold });
        if (sh.missing.length) return fail('Some of these characters aren’t available in the bundled fonts: ' + [...new Set(sh.missing)].join(' '));
        orig = await I.shape(ln.verifiedText || ln.text, { bold });
        let fit = orig.width > 0 ? ln.width / (orig.width / 1000 * ln.size * ln.hs) : 1;
        fit = Math.max(0.85, Math.min(1.15, fit));
        if (Math.abs(fit - 1) < 0.01) fit = 1;
        const isInd = (l) => INDIC_NAMES.some((n) => l.includes(n));
        const labels = sh.fonts.slice().sort((a, b) => (isInd(a) ? 0 : 1) - (isInd(b) ? 0 : 1));
        e.sub = { key: 'shaped', indic: true, bold, label: labels.join(' + '), tier: 3, tc: 0, tz: Math.round(ln.hs * fit * 10000) / 100 };
        e.tier = 3; e.label = 'Substituted font: ' + e.sub.label + (fit !== 1 ? ' (width-fitted to the original line)' : '');
        shapedW = sh.width / 1000 * ln.size * e.sub.tz / 100;
      } catch (err) {
        console.warn(err);
        return fail('Pdfroo couldn’t load its Indic text engine, so this line wasn’t changed.');
      }
    }
    // tier 1
    let t1 = text.trim() && !shapedPath && lnT1 ? tier1Plan(an, lnT1, text) : null;
    if (!t1 && lnT1 && text.trim() && ln.removal === 'stream' && !shapedPath) {
      // second chance: also allow glyphs the page doesn't show yet but that really exist in the
      // embedded font program (checked on pdf.js's converted font data with fontkit)
      try { await ensureFontkit(); t1 = tier1Plan(an, lnT1, text, true); } catch (err) { t1 = null; }
    }
    if (t1) { e.tier = 1; e.t1 = t1; e.label = (lnT1 !== ln ? 'Original font family: ' : 'Original font: ') + lnT1.fontLabel; if (lnT1 !== ln) e.t1ln = { fontKey: lnT1.fontKey }; }
    // tiers 2/3 (also computed for tier 1 as a fallback if the page font can't be used at export)
    const cps = Array.from(text.replace(/\s/g, ''), (ch) => ch.codePointAt(0));
    for (const cand0 of (shapedPath ? [] : [ln.sub.t2, ln.sub.t3])) {
      if (!cand0) continue;
      const cand = restyled ? restyleSub(cand0, wantBold, wantItalic) : cand0;
      let f;
      try { f = await getEditFont(cand.key); } catch (err) { continue; }
      if (!cps.every((cp) => f.fk.hasGlyphForCodePoint(cp))) continue;
      const natural = f.fk.layout(ln.text).advanceWidth / f.fk.unitsPerEm * ln.size * ln.hs;
      const n = Array.from(ln.text).length;
      let tc = n && !restyled ? (ln.width - natural) / (n * ln.hs) : 0;   // a new weight/style keeps its own spacing
      tc = Math.max(-0.08 * ln.size, Math.min(0.08 * ln.size, tc)) * kS;
      if (Math.abs(tc) < 0.002 * S) tc = 0;
      e.sub = { key: cand.key, label: cand.label, tier: cand.tier, tc: Math.round(tc * 10000) / 10000, tz: Math.round(ln.hs * 10000) / 100 };
      break;
    }
    if (!e.t1 && !e.sub && !shapedPath) {
      if (text.trim()) return fail('Some of these characters aren’t available in the matching fonts Pdfroo bundles.');
    }
    if (!e.t1 && !shapedPath) {
      e.tier = e.sub ? e.sub.tier : 0;
      const sameFace = e.sub && e.sub.tier === 2 && famOf(TI().normName(e.sub.key)) === famOf(TI().normName(ln.fontLabel));
      e.label = e.sub ? (sameFace ? 'Same typeface: ' + e.sub.label + ' (bundled copy)' : 'Substituted font: ' + e.sub.label + (e.sub.tier === 2 && ln.sub.t2 && ln.sub.t2.compat && !restyled ? ` (metric-compatible with ${ln.sub.t2.compat})` : '')) : '';
    }
    // room: does the new text run into the next text on the same baseline (e.g. a dotted leader or a
    // table cell)? Condense slightly (≤ 12%) to fit, otherwise warn.
    let fitNote = '';
    try {
      let newW = e.t1 ? e.t1.width * kS : shapedW * kS;
      if (!e.t1 && e.sub && !e.sub.indic) {
        const f = await getEditFont(e.sub.key);
        newW = (f.fk.layout(text).advanceWidth / f.fk.unitsPerEm * S + e.sub.tc * Array.from(text).length) * e.sub.tz / 100;
      }
      // alignment: keep the line's anchor (right-aligned dates/amounts grow to the left, justified lines keep their width)
      const align = style.align || lineAlignment(an, ln);
      e.align = align; if (!style.align) e.alignAuto = true;
      const nsp = (text.match(/ /g) || []).length;
      if (align === 'justify' && nsp && !moveOnly && text !== ln.text) {
        const per = (ln.width - newW) / nsp;                          // points per space
        const spaceUnitsPt = e.t1 ? e.t1.spaceW / 1000 * S * ln.hs : 0.25 * S;
        if (per > -0.3 * spaceUnitsPt && per < 2.5 * spaceUnitsPt) {
          if (e.t1) {
            const units = per / (S * ln.hs) * 1000;
            const t1j = tier1Plan(an, lnT1 || ln, text, !!e.t1.prog, units) || tier1Plan(an, lnT1 || ln, text, true, units);
            if (t1j) { e.t1 = t1j; newW = t1j.width * kS; }
          } else if (e.sub && !e.sub.indic) { e.justify = Math.round(per * 10000) / 10000; newW += per * nsp; }
        }
      } else if (align === 'right' || align === 'center') {
        const d = ln.width * kS - newW;
        e.alignDx = Math.round((align === 'right' ? d : d / 2) * 1000) / 1000 + (align === 'right' ? ln.width * (1 - kS) : ln.width * (1 - kS) / 2);
        if (Math.abs(e.alignDx) < 0.001) delete e.alignDx;
      }
      const x0 = ln.x + (e.alignDx || 0);
      let room = Infinity;
      for (const o of an.lines) {
        if (o === ln || Math.abs(o.y - ln.y) > 0.3 * ln.size || !String(o.text).trim()) continue;
        if (align === 'right') { if (o.x + o.width <= ln.x + 1) room = Math.min(room, ln.x + ln.width - (o.x + o.width) - 0.5 * ln.size); }
        else if (o.x >= ln.x + ln.width - 1) room = Math.min(room, o.x - x0);
      }
      const view = an.page && an.page.view;
      if (room === Infinity && view) room = align === 'right' ? ln.x + ln.width - view[0] : view[2] - x0;
      if (newW > room + 0.5 && room > 0) {
        const fit = room / newW;
        if (fit >= 0.88) {
          e.fit = Math.floor(fit * 1000) / 1000; fitNote = ` · condensed ${Math.round((1 - e.fit) * 100)}% to fit before the next text`;
          if (align === 'right' || align === 'center') { const d = ln.width * kS - newW * e.fit; e.alignDx = Math.round((align === 'right' ? d : d / 2) * 1000) / 1000 + (align === 'right' ? ln.width * (1 - kS) : ln.width * (1 - kS) / 2); }
          newW *= e.fit;
        }
        else fitNote = ' · ⚠ the new text is longer than the space available and overlaps the text after it';
      }
      if (e.alignDx != null) { e.alignDx = Math.round(e.alignDx * 1000) / 1000; if (Math.abs(e.alignDx) < 0.001) delete e.alignDx; }
      e.newW = Math.round(newW * 1000) / 1000;
      if (align !== 'left' && e.alignAuto && (e.alignDx || e.justify || (e.t1 && align === 'justify'))) fitNote += align === 'right' ? ' · kept right-aligned' : align === 'center' ? ' · kept centred' : ' · kept justified';
    } catch (err) { /* width check is advisory */ }
    pg.textEdits = prevEdits.filter((x) => x.lineId !== lineId).concat([e]);

    // verify with a real round-trip: new text present, old text gone (if it was removed from the stream)
    let v = await verifyEdit(pg, e, ln, an);
    if (!v.ok && e.tier === 1 && e.sub) {
      e.tier = e.sub.tier; e.t1 = null;
      e.label = 'Substituted font: ' + e.sub.label;
      v = await verifyEdit(pg, e, ln, an);
    }
    if (!v.ok && e.removal === 'stream') { e.removal = 'cover'; v = await verifyEdit(pg, e, ln, an); }
    if (!v.ok) return fail('Pdfroo couldn’t apply this edit cleanly, so it was not made.');
    let message = (moveOnly ? 'Moved · redrawn in ' : '') + e.label + fitNote;
    if (e.removal === 'cover') message += ' · original text covered (it stays in the file underneath)';
    return { ok: true, edit: e, message };
  }

  /**
   * Move line `lineId` by (dx, dy) points in page space (cumulative with an earlier move). The run's own show ops
   * get a shifted text matrix in the content stream, so it stays the same real, searchable text in its own font and
   * nothing else on the page changes. Runs that can't be rewritten in place (inside a Form XObject, unmatched) are
   * covered and redrawn at the new spot instead (editable text only). A text edit on the line just moves along.
   */
  async function moveTextLine(state, pageIndex, lineId, dx, dy) {
    const pg = state.pages[pageIndex];
    if (!pg || pg.src == null) return { ok: false, message: 'This page has no text to move.' };
    const an = await analyzePage(pg.src, pg.index);
    const ln = an.lines.find((l) => l.id === lineId);
    if (!ln) return { ok: false, message: 'That line could not be found.' };
    if (!ln.movable) return { ok: false, message: ln.reason || 'This text can’t be moved.' };
    const prev = pg.textEdits || [];
    const ex = prev.find((e) => e.lineId === lineId);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const base = ex ? 0 : lineShift(pg, ln);                // a line already moved down by "Add like this"
    const mv = { dx: r3((ex && ex.move ? ex.move.dx : 0) + (dx || 0)), dy: r3((ex && ex.move ? ex.move.dy : base) + (dy || 0)) };
    const shiftNow = lineShift(pg, ln);
    const zero = Math.abs(mv.dx) < 1e-3 && Math.abs(mv.dy - (!ex || ex.moveOnly ? shiftNow : 0)) < 1e-3;
    if (ex && !ex.moveOnly) {                                  // edited text: redraw it at the new spot
      const e2 = Object.assign({}, ex, { move: zero ? undefined : mv });
      if (zero) delete e2.move;
      pg.textEdits = prev.map((e) => (e === ex ? e2 : e));
      const v = await verifyEdit(pg, e2, ln, an);
      if (!v.ok) { pg.textEdits = prev; return { ok: false, message: 'Pdfroo couldn’t move this line cleanly, so it was left where it was.' }; }
      return { ok: true, edit: e2, message: 'Moved the edited line' };
    }
    if (zero) { pg.textEdits = prev.filter((e) => e.lineId !== lineId); return { ok: true, edit: null, message: 'Back in its original position' }; }
    if (ln.removal === 'stream') {
      const e = {
        id: ex ? ex.id : uid('te'), lineId, original: ln.text, text: ln.text, moveOnly: true, move: mv, tier: 0,
        label: 'Moved in place · same font, still real text', verified: true, reading: null,
        geo: { x: ln.x, y: ln.y, size: ln.size, hs: ln.hs, width: ln.width, asc: ln.asc, desc: ln.desc, cb: ln.coverBottom, ct: ln.coverTop, fb: ln.fakeBold || 0 },
        match: { x: ln.x, y: ln.y, end: ln.x + ln.width, size: ln.size, text: ln.text, fontKeys: ln.fontKeys },
        removal: 'stream', color: ln.color || '#000000', bg: ln.bg || '#ffffff', t1: null, sub: null,
      };
      pg.textEdits = prev.filter((x) => x.lineId !== lineId).concat([e]);
      const v = await verifyMove(pg, e, ln);
      if (v.ok) return { ok: true, edit: e, message: e.label };
      pg.textEdits = prev;
    }
    // white-out fallback: cover the old spot, redraw the same text at the new one
    if (!ln.editable || ln.verify) return { ok: false, message: 'This text sits inside a reusable block (Form XObject) that can’t be rewritten, so it can’t be moved.' };
    pg.textEdits = prev.filter((x) => x.lineId !== lineId);
    const r = await editTextLine(state, pageIndex, lineId, ln.text, { verified: true, moveOnly: true, move: mv });
    if (!r.ok) pg.textEdits = prev;
    return r;
  }
  /** Moved run: the edited page still has the text, now starting at the new position. */
  async function verifyMove(pg, e, ln) {
    try {
      const proxy = await getEditedProxy(pg);
      const page = await proxy.getPage(1);
      const tc = await page.getTextContent();
      const want = ln.text.replace(/\s+/g, '').normalize('NFKC');
      const nx = ln.x + e.move.dx, ny = ln.y + e.move.dy, sz = ln.size;
      const hit = tc.items.some((i) => {
        const t = String(i.str || '').replace(/\s+/g, '').normalize('NFKC');
        if (!t || !(t.startsWith(want) || want.startsWith(t) || t.includes(want))) return false;
        return Math.abs(i.transform[4] - nx) < 0.5 * sz && Math.abs(i.transform[5] - ny) < 0.35 * sz;
      });
      return { ok: hit || !want };
    } catch (err) { return { ok: false, err }; }
  }

  async function verifyEdit(pg, e, ln, an) {
    try {
      const proxy = await getEditedProxy(pg);
      const page = await proxy.getPage(1);
      const tc = await page.getTextContent();
      const all = tc.items.map((i) => i.str || '').join('').replace(/\s+/g, '').normalize('NFC');
      const want = e.text.replace(/\s+/g, '').normalize('NFC');
      const hasNew = !want || all.includes(want);
      const occ = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
      const oldN = ln.text.replace(/\s+/g, '').normalize('NFC');
      const others = pg.textEdits.filter((x) => x !== e && x.original.replace(/\s+/g, '') === oldN).length;
      const newTexts = pg.textEdits.map((x) => x.text.replace(/\s+/g, '')).join('\u0001');
      const oldGone = e.moveOnly || e.removal !== 'stream' || !oldN || occ(all, oldN) <= Math.max(0, occ(an.allText, oldN) - 1 - others) + occ(newTexts, oldN);
      return { ok: hasNew && oldGone, hasNew, oldGone };
    } catch (err) { return { ok: false, err }; }
  }

  /** Apply text edits to a pdf-lib page (must run before any other drawing on that page). */
  let lastDroppedReps = [];
  async function applyTextEditsToPage(doc, page, edits, srcSim, fontsForDoc, shifts, showBoxes) {
    lastDroppedReps = [];
    const L = root.PDFLib, T = TI();
    const removed = new Set(), movedInStream = new Set();
    const streamEdits = edits.filter((e) => e.removal === 'stream');
    shifts = shifts && shifts.length ? shifts : null;
    if ((streamEdits.length && srcSim) || shifts) {
      const str = T.contentString(L, page);
      const ops = T.parseOps(str);
      const shows = T.simulate(ops, srcSim);
      const reps = [];
      const consumed = new Set();
      for (const e of streamEdits) {
        const m = T.matchLine(shows, e.match);
        if (!m.ok) continue;
        m.shows.forEach((x) => consumed.add(x.i));
        if (e.moveOnly && e.move) {                // shift the run's own text matrix: same glyphs, still real text
          const mv = m.shows.map((s) => T.movedFor(s, ops[s.i], e.move.dx, e.move.dy, str.slice(s.s, s.e)));
          if (mv.every(Boolean)) { m.shows.forEach((s, k) => reps.push({ s: s.s, e: s.e, text: mv[k] })); removed.add(e.id); movedInStream.add(e.id); continue; }
          if (!e.t1 && !e.sub) continue;
        }
        m.shows.forEach((s) => reps.push({ s: s.s, e: s.e, text: T.replacementFor(s, ops[s.i]) }));
        removed.add(e.id);
      }
      if (shifts) {
        // "Add like this": vector paths, images and forms below the insertion point move with the text
        for (const sh of shows) {
          if (consumed.has(sh.i) || !sh.start || !sh.m || showRotated(sh)) continue;
          const d = RF().shiftFor((showBoxes && showBoxes[sh.i]) || showBox(sh), shifts); if (!d) continue;
          const mv = T.movedFor(sh, ops[sh.i], 0, d, str.slice(sh.s, sh.e));
          if (mv) reps.push({ s: sh.s, e: sh.e, text: mv });
        }
        const scan = RF().scanGeometry(ops, xinfoFor(L, page.node.Resources()));
        RF().shiftReps(str, scan, (it) => RF().shiftFor(it.bbox, shifts)).forEach((r) => reps.push(r));
        for (const a of annotRects(L, page.node)) {
          const d = RF().shiftFor(a.bbox, shifts); if (!d) continue;
          const r = a.dict.lookup(L.PDFName.of('Rect'), L.PDFArray).asArray().map((x) => (x.asNumber ? x.asNumber() : 0));
          a.dict.set(L.PDFName.of('Rect'), doc.context.obj([r[0], r[1] + d, r[2], r[3] + d]));
          const qp = a.dict.lookupMaybe(L.PDFName.of('QuadPoints'), L.PDFArray);
          if (qp) a.dict.set(L.PDFName.of('QuadPoints'), doc.context.obj(qp.asArray().map((x, k) => (x.asNumber ? x.asNumber() : 0) + (k % 2 ? d : 0))));
        }
      }
      if (reps.length) {
        reps.sort((a, b) => b.s - a.s);
        let out = str, lastStart = Infinity;
        for (const r of reps) { if (r.e > lastStart) { lastDroppedReps.push({ s: r.s, e: r.e, text: r.text.slice(0, 80), orig: str.slice(r.s, Math.min(r.e, r.s + 80)) }); continue; } out = out.slice(0, r.s) + r.text + out.slice(r.e); lastStart = r.s; }
        const ref = doc.context.register(doc.context.flateStream(T.latin1ToBytes(out)));
        page.node.set(L.PDFName.of('Contents'), ref);
      }
    }
    const f = T.fmt;
    const rgb = (hex) => { const c = hexToRgb(hex); return `${f(c.red)} ${f(c.green)} ${f(c.blue)}`; };
    let content = '';
    const res = page.node.Resources();
    const pageFontDict = res && res.lookupMaybe(L.PDFName.of('Font'), L.PDFDict);
    const subKeys = {};
    for (const e of edits) {
      if (movedInStream.has(e.id) || (e.moveOnly && !e.t1 && !e.sub)) continue;
      const g0 = e.geo, mv = e.move || { dx: 0, dy: 0 };
      if (e.insert && e.kind === 'path') { content += mv.dx || mv.dy ? `q 1 0 0 1 ${f(mv.dx)} ${f(mv.dy)} cm\n${e.path}Q\n` : e.path; continue; }
      if (e.insert && e.kind === 'clone') {
        if (!pageFontDict || !pageFontDict.has(L.PDFName.of(e.clone.key))) continue;
        const t = e.clone.tm;
        content += `q BT ${rgb(e.clone.color)} rg /${e.clone.key} ${f(e.clone.Tfs)} Tf 0 Tc 0 Tw ${f(e.clone.Th * 100)} Tz 0 Ts 0 Tr ${f(t[0])} ${f(t[1])} ${f(t[2])} ${f(t[3])} ${f(t[4] + mv.dx)} ${f(t[5] + mv.dy)} Tm <${e.clone.hex}> Tj ET Q\n`;
        continue;
      }
      const g = Object.assign({}, g0, { x: g0.x + mv.dx + (e.alignDx || 0), y: g0.y + mv.dy, size: (e.style && e.style.size) || g0.size });
      if (!removed.has(e.id) && !e.insert) {
        const pad = 0.06 * g0.size;
        let y0 = g0.y + g0.desc * g0.size - pad, y1 = g0.y + g0.asc * g0.size + pad;
        if (g0.cb != null) y0 = Math.max(y0, g0.cb + 0.15);      // leave underlines / table rules alone
        if (g0.ct != null) y1 = Math.min(y1, g0.ct - 0.15);
        const x0 = g0.x - pad, w = g0.width + 2 * pad, h = y1 - y0;
        content += `q ${rgb(e.bg)} rg ${f(x0)} ${f(y0)} ${f(w)} ${f(h)} re f Q\n`;
      }
      if (!e.text.trim()) continue;
      const useT1 = e.tier === 1 && e.t1 && pageFontDict && (e.t1.keys || [e.t1.key]).every((k) => pageFontDict.has(L.PDFName.of(k)));
      if (useT1) {
        const trm = g.fb ? `${rgb(e.color)} RG ${f(g.fb)} w 2 Tr` : '0 Tr';
        content += `q BT ${rgb(e.color)} rg /${e.t1.key} 1 Tf 0 Tc 0 Tw 100 Tz 0 Ts ${trm} ${f(g.size * g.hs * (e.fit || 1))} 0 0 ${f(g.size)} ${f(g.x)} ${f(g.y)} Tm ${e.t1.tj} ET Q\n`;
      } else if (e.sub && e.sub.indic) {
        const I = await indicEngine();
        const sh = await I.shape(e.text, { bold: e.sub.bold });
        content += I.writer(doc).draw(page, sh, { x: g.x, y: g.y, size: g.size, hs: e.sub.tz / 100 * (e.fit || 1), rgb: rgb(e.color), fakeBold: g.fb });
      } else if (e.sub) {
        const font = await fontsForDoc(e.sub.key);
        const key = subKeys[e.sub.key] || (subKeys[e.sub.key] = page.node.newFontDictionary(font.name, font.ref));
        let show;
        if (e.justify) {                       // justified line: widen each word space (Tw doesn't apply to 2-byte fonts)
          const adj = f(-e.justify / (g.size * e.sub.tz / 100 * (e.fit || 1)) * 1000);
          const parts = e.text.split(/(?<= )/);
          show = '[' + parts.map((w, i) => font.encodeText(w).toString() + (i < parts.length - 1 && / $/.test(w) ? ' ' + adj : '')).join(' ') + '] TJ';
        } else show = font.encodeText(e.text).toString() + ' Tj';
        const trm = g.fb ? `${rgb(e.color)} RG ${f(g.fb)} w 2 Tr` : '0 Tr';
        content += `q BT ${rgb(e.color)} rg ${key} ${f(g.size)} Tf ${f(e.sub.tc)} Tc 0 Tw ${f(e.sub.tz * (e.fit || 1))} Tz 0 Ts ${trm} 1 0 0 1 ${f(g.x)} ${f(g.y)} Tm ${show} ET Q\n`;
      }
    }
    if (content) page.node.addContentStream(doc.context.register(doc.context.flateStream(T.latin1ToBytes(content))));
  }

  function docFontLoader(doc) {
    const cache = {};
    return (key) => cache[key] || (cache[key] = (async () => {
      await ensureFontkit();
      if (!doc.__fk) { doc.registerFontkit(root.fontkit); doc.__fk = true; }
      const f = await getEditFont(key);
      return doc.embedFont(f.bytes, { subset: false });
    })());
  }

  const editsKey = (pg) => (pg.shifts && pg.shifts.length ? JSON.stringify(pg.shifts) : '') + (pg.textEdits && pg.textEdits.length ? JSON.stringify(pg.textEdits.map((e) => [e.lineId, e.text, e.tier, e.removal, e.sub && e.sub.key, e.color, e.bg, e.fit || 1, e.move ? [e.move.dx, e.move.dy] : 0, !!e.moveOnly, e.style || 0, e.alignDx || 0, e.justify || 0, e.t1 && e.t1.tj, e.insert ? [e.kind, e.geo.x, e.geo.y, e.newW] : 0])) : '');
  const previewCache = new Map();
  /** A pdf.js document holding just this page with its text edits applied (for on-screen rendering). */
  function getEditedProxy(pg) {
    const key = pg.src + ':' + pg.index + ':' + editsKey(pg);
    if (previewCache.has(key)) { const v = previewCache.get(key); previewCache.delete(key); previewCache.set(key, v); return v; }
    const edits = JSON.parse(JSON.stringify(pg.textEdits || []));
    const pr = (async () => {
      const L = root.PDFLib; const s = sources[pg.src];
      await analyzePage(pg.src, pg.index);
      const d = await L.PDFDocument.create();
      const [cp] = await d.copyPages(s.libDoc, [pg.index]);
      const page = d.addPage(cp);
      await applyTextEditsToPage(d, page, edits, s.simFonts && s.simFonts[pg.index], docFontLoader(d), pg.shifts, pg.shifts && pg.shifts.length ? (await pageGeometry(pg.src, pg.index)).boxes : null);
      if (d.__folioIndic) d.__folioIndic.finalize();
      const bytes = await d.save();
      return pdfjsLib.getDocument({ data: bytes, cMapUrl: BASE + 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'vendor/pdfjs/standard_fonts/', isEvalSupported: false, verbosity: pdfjsLib.VerbosityLevel ? pdfjsLib.VerbosityLevel.ERRORS : 0 }).promise;
    })();
    previewCache.set(key, pr);
    pr.catch(() => previewCache.delete(key));
    while (previewCache.size > 8) {
      const [k, v] = previewCache.entries().next().value;
      previewCache.delete(k); v.then((p) => p.destroy()).catch(() => {});
    }
    return pr;
  }


  /** Cut every reference to deleted pages (link/outline destinations, widget /P, structure /Pg)
      and drop their form fields, so the pages become unreachable and are pruned from the file. */
  function detachRemovedPages(doc, removedPages) {
    const L = root.PDFLib; const ctx = doc.context;
    const gone = new Set(removedPages.map((p) => p.ref.tag || p.ref.toString()));
    const tagOf = (r) => r.tag || r.toString();
    const widgetRefs = new Set();
    removedPages.forEach((p) => {
      const annots = p.node.lookupMaybe(L.PDFName.of('Annots'), L.PDFArray);
      if (annots) annots.asArray().forEach((r) => { if (r instanceof L.PDFRef) widgetRefs.add(tagOf(r)); });
    });
    // form fields whose widgets lived only on deleted pages
    const acro = doc.catalog.lookupMaybe(L.PDFName.of('AcroForm'), L.PDFDict);
    const prune = (arr) => {
      for (let i = arr.size() - 1; i >= 0; i--) {
        const r = arr.get(i);
        const d = ctx.lookupMaybe(r, L.PDFDict);
        const kids = d && d.lookupMaybe(L.PDFName.of('Kids'), L.PDFArray);
        if (kids) { prune(kids); if (!kids.size()) arr.remove(i); }
        else if (r instanceof L.PDFRef && widgetRefs.has(tagOf(r))) arr.remove(i);
      }
    };
    const fields = acro && acro.lookupMaybe(L.PDFName.of('Fields'), L.PDFArray);
    if (fields) prune(fields);
    // links / outline items that jump to a deleted page: drop the link, keep the outline title
    const destGone = (d) => {
      const arr = ctx.lookupMaybe(d, L.PDFArray);
      const first = arr && arr.size() ? arr.get(0) : null;
      return first instanceof L.PDFRef && gone.has(tagOf(first));
    };
    const actionGone = (a) => { const ad = ctx.lookupMaybe(a, L.PDFDict); return !!(ad && ad.get(L.PDFName.of('D')) && destGone(ad.get(L.PDFName.of('D')))); };
    doc.getPages().forEach((pg) => {
      const annots = pg.node.lookupMaybe(L.PDFName.of('Annots'), L.PDFArray);
      if (!annots) return;
      for (let i = annots.size() - 1; i >= 0; i--) {
        const an = ctx.lookupMaybe(annots.get(i), L.PDFDict);
        if (!an || String(an.get(L.PDFName.of('Subtype'))) !== '/Link') continue;
        if ((an.get(L.PDFName.of('Dest')) && destGone(an.get(L.PDFName.of('Dest')))) || (an.get(L.PDFName.of('A')) && actionGone(an.get(L.PDFName.of('A'))))) annots.remove(i);
      }
    });
    // null out any remaining references
    const visited = new Set();
    const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean);
    while (stack.length) {
      let o = stack.pop();
      if (o instanceof L.PDFRef) { const k = tagOf(o); if (visited.has(k) || gone.has(k)) continue; visited.add(k); o = ctx.lookup(o); }
      if (o instanceof L.PDFStream) o = o.dict;
      if (o instanceof L.PDFDict) {
        if (o.get(L.PDFName.of('Dest')) && destGone(o.get(L.PDFName.of('Dest')))) o.delete(L.PDFName.of('Dest'));
        if (o.get(L.PDFName.of('A')) && actionGone(o.get(L.PDFName.of('A')))) o.delete(L.PDFName.of('A'));
        for (const [k, v] of o.entries()) {
          if (v instanceof L.PDFRef && gone.has(tagOf(v))) {
            const name = k.decodeText ? k.decodeText() : String(k).slice(1);
            if (name === 'P' || name === 'Pg' || name === 'Parent') o.delete(k); else o.set(k, L.PDFNull);
          } else stack.push(v);
        }
      } else if (o instanceof L.PDFArray) {
        for (let i = 0; i < o.size(); i++) {
          const v = o.get(i);
          if (v instanceof L.PDFRef && gone.has(tagOf(v))) o.set(i, L.PDFNull); else stack.push(v);
        }
      }
    }
  }

  /** Remove objects no longer reachable from the trailer (e.g. replaced content streams, deleted
      pages) so edited-away text and removed pages don't linger in the saved file. */
  function pruneUnreachable(doc) {
    const L = root.PDFLib; const ctx = doc.context;
    const seen = new Set();
    const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter(Boolean);
    while (stack.length) {
      let o = stack.pop();
      if (o instanceof L.PDFRef) { const k = o.tag || o.toString(); if (seen.has(k)) continue; seen.add(k); o = ctx.lookup(o); }
      if (!o) continue;
      if (o instanceof L.PDFDict) o.entries().forEach(([, v]) => stack.push(v));
      else if (o instanceof L.PDFArray) o.asArray().forEach((v) => stack.push(v));
      else if (o instanceof L.PDFStream) o.dict.entries().forEach(([, v]) => stack.push(v));
    }
    let removed = 0;
    for (const [ref] of ctx.enumerateIndirectObjects()) {
      if (!seen.has(ref.tag || ref.toString())) { ctx.delete(ref); removed++; }
    }
    return removed;
  }

  /* ---------------- Export ---------------- */

  /** Flatten every page + annotation of `state` into a new PDF. Returns Uint8Array. */
  async function exportWithAnnotations(state) {
    return exportPdf({ pages: state.pages, assets: state.assets, title: (state.name || 'document').replace(/\.pdf$/i, ''), sources });
  }

  /** Smooth SVG path through freehand points (shared by on-screen rendering and export). */
  function penPath(points) {
    if (!points || !points.length) return '';
    const f = (n) => Math.round(n * 100) / 100;
    if (points.length === 1) { const [x, y] = points[0]; return `M${f(x)} ${f(y)}L${f(x + 0.01)} ${f(y + 0.01)}`; }
    if (points.length === 2) return `M${f(points[0][0])} ${f(points[0][1])}L${f(points[1][0])} ${f(points[1][1])}`;
    let d = `M${f(points[0][0])} ${f(points[0][1])}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i], [nx, ny] = points[i + 1];
      d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
    }
    const last = points[points.length - 1];
    d += `L${f(last[0])} ${f(last[1])}`;
    return d;
  }

  // Added text uses the bundled Noto Sans subset both on screen (CSS @font-face) and in the
  // exported PDF (embedded via fontkit), so the preview matches the output.
  const FONT_STACK = `"Folio Noto Sans", ${INDIC_FAMILIES}, "Noto Sans", sans-serif`;
  const measureCtx = document.createElement('canvas').getContext('2d');
  function measureText(a) {
    measureCtx.font = `${a.bold ? 'bold ' : ''}${a.size}px ${FONT_STACK}`;
    const lines = String(a.text).split('\n');
    let w = 0;
    lines.forEach((ln) => { w = Math.max(w, measureCtx.measureText(ln).width); });
    return { w: Math.max(w, a.size * 0.5), h: lines.length * a.size * LINE_HEIGHT, lines };
  }
  function textRaster(a) {
    const m = measureText(a);
    const S = 4;
    const c = document.createElement('canvas');
    c.width = Math.ceil(m.w * S) + 4; c.height = Math.ceil(m.h * S) + 4;
    const ctx = c.getContext('2d');
    ctx.scale(S, S);
    ctx.font = `${a.bold ? 'bold ' : ''}${a.size}px ${FONT_STACK}`;
    ctx.fillStyle = a.color; ctx.textBaseline = 'alphabetic';
    m.lines.forEach((ln, k) => ctx.fillText(ln, 0, a.size * TEXT_ASCENT + k * a.size * LINE_HEIGHT));
    return { dataUrl: c.toDataURL('image/png'), w: c.width / S, h: c.height / S };
  }

  // Baseline of the first line (× font size) for a 1.2 line-height box using Noto Sans
  // metrics (ascent 1.069, descent 0.293): (1.2 − 1.362) / 2 + 1.069 ≈ 0.988.
  const TEXT_ASCENT = 0.988;
  const LINE_HEIGHT = 1.2;

  function hexToRgb(hex) {
    const { rgb } = root.PDFLib;
    let h = String(hex || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  function dataUrlToBytes(dataUrl) {
    const b64 = dataUrl.split(',')[1];
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Matrix mapping "displayed" page space (origin bottom-left, y up, after rotation)
      to the page's unrotated user space. */
  function displayToUserMatrix(rot, box) {
    const W = box.width, H = box.height, bx = box.x, by = box.y;
    switch (rot) {
      case 90: return [0, 1, -1, 0, W + bx, by];
      case 180: return [-1, 0, 0, -1, W + bx, H + by];
      case 270: return [0, -1, 1, 0, bx, H + by];
      default: return [1, 0, 0, 1, bx, by];
    }
  }

  function arrowHead(a) {
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const L = Math.max(10, a.width * 3.5);
    return [
      [a.x2 - L * Math.cos(ang - Math.PI / 6), a.y2 - L * Math.sin(ang - Math.PI / 6)],
      [a.x2 - L * Math.cos(ang + Math.PI / 6), a.y2 - L * Math.sin(ang + Math.PI / 6)],
    ];
  }

  /* ---- Text font loading (lazy: only needed at export time) ---- */
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  // pdf-lib/fontkit's own subsetter corrupts glyph outlines of this font (text extracts fine
  // but most glyphs don't draw), so we ship PRE-SUBSETTED files and embed them whole:
  //   FolioNotoSans-{Regular,Bold}-Basic.ttf  ~11 KB  printable ASCII + common punctuation
  //   FolioNotoSans-{Regular,Bold}.ttf        ~225 KB Latin/Greek/Cyrillic/currency (also the preview font)
  // Both come from the same Noto Sans source with identical settings, so glyphs are identical.
  // Kerning and ligatures are stripped from all files: pdf-lib positions ligature glyphs
  // incorrectly and ignores kerning, so removing them keeps preview == export.
  const SUBSET_FONTS = false;
  const FONT_SCRIPTS = { 'Regular-Basic': 'noto-sans-basic-data.js', 'Bold-Basic': 'noto-sans-basic-data.js', Regular: 'noto-sans-data.js', Bold: 'noto-sans-data.js' };
  const fontCache = {};
  async function ensureFontkit() { if (!root.fontkit) await loadScript(BASE + 'vendor/fontkit.umd.min.js'); }
  /** Returns { bytes, fk } for a font key; `fk` (fontkit instance) is created lazily for coverage checks. */
  function getFont(key) {
    if (fontCache[key]) return fontCache[key];
    fontCache[key] = (async () => {
      let bytes;
      if (location.protocol !== 'file:') {
        try {
          const r = await fetch(BASE + 'vendor/fonts/FolioNotoSans-' + key + '.ttf');
          if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
        } catch (e) { /* fall through to script copy */ }
      }
      if (!bytes) {
        // file:// pages can't fetch(); the same TTFs are shipped as base64 in small JS files.
        if (!(root.FolioFontData && root.FolioFontData[key])) await loadScript(BASE + 'vendor/fonts/' + FONT_SCRIPTS[key]);
        bytes = b64ToBytes(root.FolioFontData[key]);
      }
      let fk = null;
      return { bytes, get fk() { return fk || (fk = root.fontkit.create(bytes)); } };
    })();
    fontCache[key].catch(() => { delete fontCache[key]; });
    return fontCache[key];
  }

  /** Decide, for every text annotation, vector vs raster, and pick the smallest font file per
      weight that covers all characters used in that weight. Only used weights are embedded. */
  async function planTextFonts(annots, out) {
    await ensureFontkit();
    const basic = await getFont('Regular-Basic');       // Bold-Basic has the same character set
    let ext = null;
    const mode = new Map();
    const used = { Regular: new Set(), Bold: new Set() };
    for (const a of annots) {
      const text = String(a.text);
      const cps = Array.from(text, (ch) => ch.codePointAt(0)).filter((cp) => cp !== 10 && cp !== 13);
      if (hasIndic(text) && !COMPLEX_SCRIPT_RE.test(text.replace(INDIC_STRIP_RE, '')) && cps.every((cp) => cp >= 32)) { mode.set(a, 'shaped'); continue; }
      let vector = !COMPLEX_SCRIPT_RE.test(text) && cps.every((cp) => cp >= 32);
      if (vector && !cps.every((cp) => basic.fk.hasGlyphForCodePoint(cp))) {
        ext = ext || await getFont('Regular');           // Bold has the same character set
        vector = cps.every((cp) => ext.fk.hasGlyphForCodePoint(cp));
      }
      mode.set(a, vector ? 'vector' : 'raster');
      if (vector) cps.forEach((cp) => used[a.bold ? 'Bold' : 'Regular'].add(cp));
    }
    const fonts = {}, files = {};
    for (const w of ['Regular', 'Bold']) {
      if (!used[w].size) continue;
      const key = [...used[w]].every((cp) => basic.fk.hasGlyphForCodePoint(cp)) ? w + '-Basic' : w;
      if (!out.__fk) { out.registerFontkit(root.fontkit); out.__fk = true; }
      fonts[w] = await out.embedFont((await getFont(key)).bytes, { subset: SUBSET_FONTS });
      files[w] = key;
    }
    lastExportFonts = files;
    return { mode, fonts };
  }
  let lastExportFonts = {};

  // Scripts that need complex shaping (reordering, conjuncts, joining, bidi) which pdf-lib
  // does not perform, plus emoji and CJK/Hangul. Text containing any of these is rasterized.
  const COMPLEX_SCRIPT_RE = new RegExp('[' + [
    '\\u0590-\\u08FF',        // Hebrew, Arabic, Syriac, Arabic Supplement, Thaana, NKo, Samaritan, Mandaic, Arabic Ext
    '\\u0900-\\u0DFF',        // Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala
    '\\u0E00-\\u0FFF',        // Thai, Lao, Tibetan
    '\\u1000-\\u109F',        // Myanmar
    '\\u1780-\\u17FF',        // Khmer
    '\\u1800-\\u18AF',        // Mongolian
    '\\uA8E0-\\uA8FF',        // Devanagari Extended
    '\\u2600-\\u27BF',        // misc symbols & dingbats (emoji-style)
    '\\u2E80-\\u9FFF',        // CJK radicals, kana, CJK ideographs
    '\\uAC00-\\uD7AF',        // Hangul
    '\\uF900-\\uFAFF',        // CJK compatibility
    '\\uFB1D-\\uFDFF\\uFE70-\\uFEFC', // Hebrew/Arabic presentation forms
    '\\uFE00-\\uFE0F\\u200D',  // variation selectors / ZWJ (emoji sequences)
  ].join('') + ']|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]');  // astral plane (emoji, historic scripts, CJK ext)

  /** Internal: flatten a document model into PDF bytes.
   *  p = { pages, assets, title, sources: {id: {bytes}} } */
  /** True when the pages are exactly one source file, untouched (so the original bytes can be returned). */
  function isUntouched(p) {
    const src = p.pages.length && p.pages[0].src;
    if (src == null || !p.sources[src]) return false;
    if (p.pages.length !== p.sources[src].pdf.numPages) return false;
    return p.pages.every((pg, i) => pg.src === src && pg.index === i && !(((pg.rot || 0) % 360 + 360) % 360) &&
      !(pg.annots && pg.annots.length) && !(pg.textEdits && pg.textEdits.length) && !(pg.shifts && pg.shifts.length));
  }

  async function exportPdf(p) {
    const L = root.PDFLib;
    // Nothing changed: hand back the original file byte-for-byte (keeps digital signatures valid,
    // incremental-update history, and everything else exactly as it was).
    if (isUntouched(p)) return p.sources[p.pages[0].src].bytes.slice(0);
    const { PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, LineCapStyle, BlendMode } = L;
    // Build on top of the FIRST source document (loaded fresh) instead of copying pages into an
    // empty file: this keeps its document-level structure — AcroForm fields stay fillable, link
    // destinations, outlines and named destinations stay valid. Pages from other files (merge) and
    // duplicated pages are copied in; the page tree is then rebuilt in the edited order.
    const baseSrc = (p.pages.find((pg) => pg.src != null && p.sources[pg.src]) || {}).src;
    let out = null;
    if (baseSrc != null) {
      try { out = await PDFDocument.load(p.sources[baseSrc].bytes, { updateMetadata: false }); } catch (e) { out = null; }
    }
    const reuseBase = !!out;
    if (!out) out = await PDFDocument.create();
    if (reuseBase) {
      // Adobe "Reader extensions" (/Perms /UR3) are a usage-rights signature over the original bytes;
      // after any change Reader would report the document as altered and disable its features, so drop
      // them (as Acrobat's "Save a Copy" does). DocMDP / approval signatures are kept — broken, visibly.
      try {
        const perms = out.catalog.lookupMaybe(L.PDFName.of('Perms'), L.PDFDict);
        if (perms && perms.has(L.PDFName.of('UR3'))) {
          perms.delete(L.PDFName.of('UR3'));
          if (!perms.keys().length) out.catalog.delete(L.PDFName.of('Perms'));
        }
      } catch (e) { /* ignore */ }
    }
    const libDocs = {};
    for (const pg of p.pages) {
      if (pg.src != null && !libDocs[pg.src]) {
        const s = p.sources[pg.src];
        libDocs[pg.src] = s.libDoc || await PDFDocument.load(s.bytes, { updateMetadata: false });
      }
    }
    const basePages = reuseBase ? out.getPages() : [];
    const copied = new Array(p.pages.length);
    const usedBase = new Set();
    const seen = new Set();
    const batches = {};
    const dupes = [];
    p.pages.forEach((pg, i) => {
      if (pg.src == null) return;
      if (reuseBase && pg.src === baseSrc && !usedBase.has(pg.index)) { usedBase.add(pg.index); copied[i] = basePages[pg.index]; return; }
      const key = pg.src + ':' + pg.index;
      if (seen.has(key) || pg.src === baseSrc) dupes.push(i);
      else { seen.add(key); (batches[pg.src] = batches[pg.src] || []).push(i); }
    });
    for (const src of Object.keys(batches)) {
      const idxs = batches[src];
      const cps = await out.copyPages(libDocs[src], idxs.map((i) => p.pages[i].index));
      idxs.forEach((i, k) => { copied[i] = cps[k]; });
    }
    for (const i of dupes) {
      const pg = p.pages[i];
      const [cp] = await out.copyPages(libDocs[pg.src], [pg.index]);
      copied[i] = cp;
    }
    if (reuseBase) {
      // push inheritable attributes down so pages survive re-parenting, then empty the page tree
      const INH = ['Resources', 'MediaBox', 'CropBox', 'Rotate'].map((n) => L.PDFName.of(n));
      basePages.forEach((bp) => INH.forEach((k) => { if (!bp.node.get(k)) { const v = bp.node.getInheritableAttribute(k); if (v) bp.node.set(k, v); } }));
      for (let k = basePages.length - 1; k >= 0; k--) out.removePage(k);
      const removed = basePages.filter((bp, k) => !usedBase.has(k));
      if (removed.length) detachRemovedPages(out, removed);
    }

    lastExportFonts = {};
    const textAnnots = [];
    p.pages.forEach((pg) => (pg.annots || []).forEach((a) => { if (a.type === 'text' && String(a.text).trim()) textAnnots.push(a); }));
    const textPlan = textAnnots.length ? await planTextFonts(textAnnots, out) : null;
    const editFonts = docFontLoader(out);
    const imgCache = {};
    async function getImage(assetId) {
      if (imgCache[assetId]) return imgCache[assetId];
      const a = p.assets[assetId];
      const bytes = dataUrlToBytes(a.dataUrl);
      const img = a.kind === 'jpg' ? await out.embedJpg(bytes) : await out.embedPng(bytes);
      imgCache[assetId] = img;
      return img;
    }

    for (let i = 0; i < p.pages.length; i++) {
      const pg = p.pages[i];
      const total = ((pg.baseRot || 0) + (pg.rot || 0)) % 360;
      const swap = total === 90 || total === 270;
      const Dw = swap ? pg.h : pg.w, Dh = swap ? pg.w : pg.h;
      let page, box, rotForMatrix;
      if (copied[i]) {
        page = out.addPage(copied[i]);
        page.setRotation(degrees(total));
        box = page.getCropBox();
        rotForMatrix = total;
        if (((pg.textEdits && pg.textEdits.length) || (pg.shifts && pg.shifts.length)) && p.sources[pg.src].libDoc) {
          await analyzePage(pg.src, pg.index);
          await applyTextEditsToPage(out, page, pg.textEdits || [], p.sources[pg.src].simFonts && p.sources[pg.src].simFonts[pg.index], editFonts, pg.shifts, pg.shifts && pg.shifts.length ? (await pageGeometry(pg.src, pg.index)).boxes : null);
        }
      } else {
        page = out.addPage([Dw, Dh]);
        box = { x: 0, y: 0, width: Dw, height: Dh };
        rotForMatrix = 0;
      }
      if (!pg.annots || !pg.annots.length) continue;

      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...displayToUserMatrix(rotForMatrix, box)));
      const Y = (y) => Dh - y;

      for (const a of pg.annots) {
        const color = hexToRgb(a.color);
        switch (a.type) {
          case 'pen':
          case 'highlight': {
            const d = penPath(a.points);
            if (!d) break;
            const opts = { x: 0, y: Dh, borderColor: color, borderWidth: a.width, borderLineCap: LineCapStyle.Round };
            if (a.type === 'highlight') { opts.borderOpacity = a.opacity != null ? a.opacity : 0.4; opts.blendMode = BlendMode.Multiply; }
            page.drawSvgPath(d, opts);
            break;
          }
          case 'rect':
            page.drawRectangle({ x: a.x, y: Y(a.y + a.h), width: a.w, height: a.h, borderColor: color, borderWidth: a.width });
            break;
          case 'ellipse':
            page.drawEllipse({ x: a.x + a.w / 2, y: Y(a.y + a.h / 2), xScale: Math.max(0.1, a.w / 2), yScale: Math.max(0.1, a.h / 2), borderColor: color, borderWidth: a.width });
            break;
          case 'whiteout':
            page.drawRectangle({ x: a.x, y: Y(a.y + a.h), width: a.w, height: a.h, color: L.rgb(1, 1, 1) });
            break;
          case 'line':
          case 'arrow': {
            const common = { thickness: a.width, color, lineCap: LineCapStyle.Round };
            page.drawLine({ start: { x: a.x1, y: Y(a.y1) }, end: { x: a.x2, y: Y(a.y2) }, ...common });
            if (a.type === 'arrow') {
              for (const h of arrowHead(a)) page.drawLine({ start: { x: h[0], y: Y(h[1]) }, end: { x: a.x2, y: Y(a.y2) }, ...common });
            }
            break;
          }
          case 'image': {
            const img = await getImage(a.asset);
            page.drawImage(img, { x: a.x, y: Y(a.y + a.h), width: a.w, height: a.h });
            break;
          }
          case 'text': {
            if (!String(a.text).trim()) break;
            const lines = String(a.text).split('\n');
            const vector = textPlan && textPlan.mode.get(a) === 'vector';
            let shapedDone = false;
            if (textPlan && textPlan.mode.get(a) === 'shaped') {
              // Indic: real, searchable shaped text (HarfBuzz + Noto Sans <Script>, CID font + ToUnicode + ActualText)
              try {
                const I = await indicEngine(); const W = I.writer(out);
                const shaped = [];
                for (const ln of lines) shaped.push(ln ? await I.shape(ln, { bold: !!a.bold }) : null);
                if (shaped.every((s) => !s || !s.missing.length)) {
                  let c = '';
                  shaped.forEach((s, k) => {
                    if (s) c += W.draw(page, s, { x: a.x, y: Y(a.y + a.size * TEXT_ASCENT + k * a.size * LINE_HEIGHT), size: a.size, rgb: `${color.red} ${color.green} ${color.blue}` });
                  });
                  page.pushOperators(L.PDFOperator.of('', [c]));
                  shapedDone = true;
                }
              } catch (err) { console.warn('Shaped text failed, using an image instead', err); }
            }
            if (shapedDone) { /* drawn */ } else if (vector) {
              const font = textPlan.fonts[a.bold ? 'Bold' : 'Regular'];
              lines.forEach((ln, k) => {
                if (!ln) return;
                page.drawText(ln, { x: a.x, y: Y(a.y + a.size * TEXT_ASCENT + k * a.size * LINE_HEIGHT), size: a.size, font, color });
              });
            } else {
              // Scripts pdf-lib can't shape (Indic, Arabic/Hebrew, emoji, CJK…) or glyphs missing
              // from the bundled font: embed a crisp, transparent raster of the text instead.
              const r = textRaster(a);
              const img = await out.embedPng(dataUrlToBytes(r.dataUrl));
              page.drawImage(img, { x: a.x, y: Y(a.y + r.h), width: r.w, height: r.h });
            }
            break;
          }
        }
      }
      page.pushOperators(popGraphicsState());
    }

    out.setTitle(p.title || 'Edited document');
    out.setProducer('Pdfroo PDF editor (pdf-lib)');
    out.setCreator('Pdfroo');
    out.setModificationDate(new Date());
    if (out.__folioIndic) out.__folioIndic.finalize();   // shaped-text fonts (CIDs are allocated while drawing)
    if (reuseBase) pruneUnreachable(out);          // drop replaced content streams / deleted pages
    return await out.save();
  }


  /* ---------------- "Add like this" + reflow (Phase 1: same page) ---------------- */
  const RF = () => root.FolioReflow;
  const geoCache = new Map();
  /** Probe box used to decide whether text is inside a moved region: same rule for a show op and for a whole line. */
  const showBox = (sh) => { const sz = Math.abs(sh.m[3]) || sh.Tfs || 10; const a = sh.start[0], b = (sh.inkEnd || sh.end || sh.start)[0]; return [Math.min(a, b), sh.start[1] - 0.25 * sz, Math.max(a, b), sh.start[1] + 0.8 * sz]; };
  const showRotated = (sh) => Math.abs(sh.m[1]) > 0.02 * Math.abs(sh.m[0] || 1) || Math.abs(sh.m[2]) > 0.02 * Math.abs(sh.m[3] || 1) || (sh.m[0] || 0) <= 0 || (sh.m[3] || 0) <= 0;
  const probeBox = (l) => [l.x, l.y - 0.25 * l.size, l.x + Math.max(l.width, 0.3 * l.size), l.y + 0.8 * l.size];
  /** How far an untouched line has been moved by "Add like this" shifts. */
  const lineShift = (pg, ln) => (pg.shifts && pg.shifts.length ? RF().shiftFor(probeBox(ln), pg.shifts) : 0);
  function xinfoFor(L, resDict) {
    const N = (n) => L.PDFName.of(n);
    const cache = {};
    return (name) => {
      if (name in cache) return cache[name];
      let r = null;
      try {
        const xd = resDict && resDict.lookupMaybe(N('XObject'), L.PDFDict);
        const st = xd && xd.lookup(N(name));
        if (st && st.dict) {
          const sub = String(st.dict.get(N('Subtype')));
          if (sub === '/Image') r = { type: 'image' };
          else if (sub === '/Form') {
            const arr = (k) => { const a = st.dict.lookupMaybe(N(k), L.PDFArray); return a ? a.asArray().map((v) => (v.asNumber ? v.asNumber() : 0)) : null; };
            const m = arr('Matrix');
            r = { type: 'form', bbox: arr('BBox') || [0, 0, 1, 1], matrix: m && m.length === 6 ? m : [1, 0, 0, 1, 0, 0] };
          }
        }
      } catch (e) { r = null; }
      return (cache[name] = r);
    };
  }
  function annotRects(L, pageNode) {
    const out = [];
    try {
      const arr = pageNode.lookupMaybe(L.PDFName.of('Annots'), L.PDFArray);
      if (!arr) return out;
      for (let i = 0; i < arr.size(); i++) {
        const d = arr.lookupMaybe(i, L.PDFDict); if (!d) continue;
        const r = d.lookupMaybe(L.PDFName.of('Rect'), L.PDFArray); if (!r || r.size() !== 4) continue;
        const v = r.asArray().map((x) => (x.asNumber ? x.asNumber() : 0));
        out.push({ i, dict: d, sub: String(d.get(L.PDFName.of('Subtype')) || ''), bbox: [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])] });
      }
    } catch (e) { /* no annots */ }
    return out;
  }
  async function pageGeometry(src, index) {
    const key = src + ':' + index;
    if (geoCache.has(key)) return geoCache.get(key);
    const an = await analyzePage(src, index);     // simulated widths come from the analysed fonts
    const L = root.PDFLib, T = TI();
    const lp = sources[src].libDoc.getPage(index);
    const str = T.contentString(L, lp), ops = T.parseOps(str);
    const scan = RF().scanGeometry(ops, xinfoFor(L, lp.node.Resources()));
    const g = { scan, annots: annotRects(L, lp.node).map((a) => ({ i: a.i, sub: a.sub, bbox: a.bbox })) };
    // text show ops on the page (not inside forms): moved by geometry like paths
    // pdf.js reports widths in the font's own units: a font whose FontMatrix isn't 1/1000 (an OpenType CFF font with
    // 2048 or 2000 units per em, a Type 3 font) needs them scaled, or a run's box comes out twice as long
    const sim0 = sources[src].simFonts && sources[src].simFonts[index];
    let sim = sim0;
    if (sim0) {
      sim = {};
      for (const [k, f] of Object.entries(sim0)) {
        const lf = an.libFonts[k], pf = lf && lf.pdfjs && an.pfonts[lf.pdfjs];
        const fm = pf && pf.fo && pf.fo.fontMatrix;
        const sc = fm ? Math.hypot(fm[0], fm[1]) * 1000 : 1;
        if (!fm || !isFinite(sc) || sc <= 0 || Math.abs(sc - 1) < 1e-3) { sim[k] = f; continue; }
        const w = {}; for (const c in f.widths) w[c] = f.widths[c] * sc;
        sim[k] = Object.assign({}, f, { widths: w, defaultWidth: (f.defaultWidth || 0) * sc });
      }
    }
    g.texts = [];
    try {
      g.boxes = {};
      for (const sh of T.simulate(ops, sim)) {
        if (!sh.start || !sh.m) continue;
        const box = showBox(sh);
        g.boxes[sh.i] = box;
        g.texts.push({ i: sh.i, box, rot: showRotated(sh), movable: !showRotated(sh) && !!T.movedFor(sh, ops[sh.i], 0, -1, str.slice(sh.s, sh.e)), text: sh.text || '' });
      }
    } catch (e) { g.textError = e.message; }
    geoCache.set(key, g);
    return g;
  }
  /** Font plan for NEW text in the style of line ln: original font (tier 1) when every glyph is there, else the line's tier 2/3 substitute. */
  async function fontPlanFor(an, ln, text) {
    if (!text.trim()) return { w: 0, tier: 0, label: '' };
    if (hasIndic(text) || COMPLEX_SCRIPT_RE.test(text.replace(INDIC_STRIP_RE, ''))) return null;
    let t1 = ln.removal === 'stream' ? tier1Plan(an, ln, text) : null;
    if (!t1 && ln.removal === 'stream') { try { await ensureFontkit(); t1 = tier1Plan(an, ln, text, true); } catch (e) { t1 = null; } }
    let sub = null, w = t1 ? t1.width : 0;
    const cps = Array.from(text.replace(/\s/g, ''), (ch) => ch.codePointAt(0));
    // a Hindi / Indic line's own substitute is a shaping font; Latin text typed under it uses Noto Sans
    const latinFallback = ln.indic ? { key: 'NotoSans-' + (ln.bold ? 'Bold' : 'Regular'), label: 'Noto Sans' + (ln.bold ? ' Bold' : ''), tier: 3, plain: true } : null;
    for (const cand of [ln.sub && ln.sub.t2, ln.sub && ln.sub.t3, latinFallback]) {
      if (!cand || cand.indic) continue;
      let f; try { f = await getEditFont(cand.key); } catch (e) { continue; }
      if (!cps.every((cp) => f.fk.hasGlyphForCodePoint(cp))) continue;
      const natural = f.fk.layout(ln.text).advanceWidth / f.fk.unitsPerEm * ln.size * ln.hs;
      const n = Array.from(ln.text).length;
      let tc = n && !cand.plain ? (ln.width - natural) / (n * ln.hs) : 0;
      tc = Math.max(-0.08 * ln.size, Math.min(0.08 * ln.size, tc)); if (Math.abs(tc) < 0.002 * ln.size) tc = 0;
      sub = { key: cand.key, label: cand.label, tier: cand.tier, tc: Math.round(tc * 10000) / 10000, tz: Math.round(ln.hs * 10000) / 100 };
      if (!t1) w = (f.fk.layout(text).advanceWidth / f.fk.unitsPerEm * ln.size + sub.tc * Array.from(text).length) * sub.tz / 100;
      break;
    }
    if (!t1 && !sub) return null;
    return { t1, sub, w, tier: t1 ? 1 : sub.tier, label: t1 ? 'Original font: ' + ln.fontLabel : 'Substituted font: ' + sub.label };
  }
  /** Greedy word wrap: widths[k] is the room for line k (the last value repeats). */
  async function wrapText(an, ln, text, widths) {
    const words = text.replace(/\s+/g, ' ').trim().split(' ');
    const out = []; let cur = '';
    const room = (k) => widths[Math.min(k, widths.length - 1)];
    for (const w of words) {
      const cand = cur ? cur + ' ' + w : w;
      const p = await fontPlanFor(an, ln, cand);
      if (!p) return null;
      if (!cur || p.w <= room(out.length) + 0.25) cur = cand;
      else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** The page's lines where they are NOW (moves, edits, inserted lines), in PDF space. */
  function currentLines(an, pg) {
    const edits = pg.textEdits || [];
    const out = [];
    for (const ln of an.lines) {
      const e = edits.find((x) => x.lineId === ln.id);
      const mv = e && e.move ? e.move : { dx: 0, dy: e ? 0 : lineShift(pg, ln) };
      const w = e && !e.moveOnly && e.newW != null ? Math.max(1, e.newW) : ln.width;
      out.push(Object.assign({}, ln, { x: ln.x + mv.dx + (e && e.alignDx && !e.moveOnly ? e.alignDx : 0), y: ln.y + mv.dy, width: w, text: e ? e.text : ln.text, orig: ln, edit: e || null }));
    }
    for (const e of edits) {
      if (!e.insert || e.kind === 'path') continue;
      const mv = e.move || { dx: 0, dy: 0 }, src = an.lines.find((l) => l.id === e.srcLineId) || {};
      out.push(Object.assign({}, src, { id: e.lineId, x: e.geo.x + mv.dx, y: e.geo.y + mv.dy, width: e.newW || 0, size: e.geo.size, asc: e.geo.asc, desc: e.geo.desc, text: e.kind === 'clone' ? (src.text || '•') : e.text,
        bullet: e.kind === 'clone', inserted: true, edit: e, orig: null, movable: false, editable: e.kind !== 'clone' }));
    }
    return out;
  }
  const lineBox = (l) => [l.x, l.y + (l.desc != null ? l.desc : -0.22) * l.size, l.x + Math.max(l.width, 0.3 * l.size), l.y + (l.asc != null ? l.asc : 0.78) * l.size];
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  /** App annotations (display points, top-left origin) -> PDF-space bbox. */
  function appAnnotBox(a, view) {
    let x0, y0, x1, y1;
    if (a.points) { const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]); const p = (a.width || 0) / 2; x0 = Math.min(...xs) - p; x1 = Math.max(...xs) + p; y0 = Math.min(...ys) - p; y1 = Math.max(...ys) + p; }
    else if (a.x1 != null) { const p = (a.width || 0) / 2; x0 = Math.min(a.x1, a.x2) - p; x1 = Math.max(a.x1, a.x2) + p; y0 = Math.min(a.y1, a.y2) - p; y1 = Math.max(a.y1, a.y2) + p; }
    else if (a.type === 'text') { const m = measureText(a); x0 = a.x; y0 = a.y; x1 = a.x + m.w; y1 = a.y + m.h; }
    else { x0 = a.x; y0 = a.y; x1 = a.x + (a.w || 0); y1 = a.y + (a.h || 0); }
    return [view[0] + x0, view[3] - y1, view[0] + x1, view[3] - y0];
  }
  function moveAppAnnot(a, ddy) {
    if (a.points) a.points = a.points.map(([x, y]) => [x, y + ddy]);
    else if (a.x1 != null) { a.y1 += ddy; a.y2 += ddy; }
    else a.y += ddy;
  }

  /** Which kinds of "Add like this" fit the selected line: { line, bullet, section }. */
  async function getAddOptions(pg, lineId) {
    if (pg.src == null || !sources[pg.src] || !sources[pg.src].libDoc || totalRotation(pg)) return { line: false, bullet: false, section: false };
    const an = await analyzePage(pg.src, pg.index);
    const la = layoutAround(an, currentLines(an, pg), lineId, null, await pageGeometry(pg.src, pg.index));
    if (!la) return { line: false, bullet: false, section: false };
    const st = la.st;
    return { line: true, bullet: !!st.item, section: !!st.heading };
  }

  /**
   * Rows for the page with lines kept apart across column gutters, the anchor's row and the structure around it.
   * Gutters come from tight rows (lines merged only across word gaps) so a narrow table gutter isn't bridged.
   */
  function layoutAround(an, cur, anchorId, regionX, geo) {
    const tight = RF().buildRows(cur, 0.9);
    const trow = tight.find((r) => r.lines.some((l) => l.id === anchorId));
    if (!trow) return null;
    const sz = trow.size, view = an.page.view;
    const yLo = Math.max(view[1], trow.y - 45 * sz), yHi = trow.y + 15 * sz;
    let gut = RF().columnGutters(tight, yLo, yHi, Math.max(8, 0.9 * sz));
    // a strip that single text runs cross (a LaTeX "title …… date" line is one TJ) is a tab gap, not a column gutter
    if (geo && geo.texts) gut = gut.filter((g) => geo.texts.filter((t) => !t.rot && t.box[1] <= yHi && t.box[3] >= yLo && t.box[0] < g.a - 0.5 && t.box[2] > g.b + 0.5).length < 2);
    const splits = gut.map((g) => g.mid).concat(regionX ? [regionX.x0, regionX.x1] : []);
    const rows = RF().buildRows(cur, 2.2, splits);
    const row = rows.find((r) => r.lines.some((l) => l.id === anchorId));
    if (!row) return null;
    const st = structureFor(rows, row, an, regionX, gut);
    return { rows, row, st };
  }
  /** Column, rows, leading, bullet item and heading around a row. */
  function structureFor(rows, row, an, regionX, gut) {
    const view = an.page.view;
    const sz = row.size;
    const cx0 = Math.min(...rows.map((r) => r.x0)), cx1 = Math.max(...rows.map((r) => r.x1));
    gut = gut || [];
    // with no gutter on a side the column runs to the page edge (rules and boxes often reach past the text)
    let x0 = Math.min(cx0 - 2, view[0] - 2), x1 = Math.max(cx1 + 2, view[2] + 2); const notes = []; let uncertain = false;
    for (const gp of gut) {
      if (gp.b <= row.x0 + 0.5) x0 = Math.max(x0, gp.mid);
      else if (gp.a >= row.x1 - 0.5) x1 = Math.min(x1, gp.mid);
      else continue;
      if (gp.b - gp.a < 1.4 * sz) { uncertain = true; notes.push('The gap between the columns is narrow, so the column edge is a guess — drag it if it’s wrong.'); }
    }
    // text to the side with no clear gutter found: the column edge can't be trusted
    if (!gut.length && rows.some((r) => r !== row && Math.abs(r.y - row.y) < 0.3 * sz && (r.x0 > row.x1 + 0.5 || r.x1 < row.x0 - 0.5))) { uncertain = true; notes.push('Pdfroo couldn’t find a clear column edge here — check the outlined area and drag its edges if needed.'); }
    const g = { gaps: gut.map((q) => [q.a, q.b]) };
    if (regionX) { x0 = regionX.x0; x1 = regionX.x1; uncertain = false; notes.length = 0; }
    const inCol = (r) => r.x0 >= x0 - 1 && r.x1 <= x1 + 1;
    const col = rows.filter(inCol).sort((p, q) => q.y - p.y);
    const i = col.indexOf(row);
    // leading: baseline steps between same-size neighbours
    const steps = [];
    for (let k = 1; k < col.length; k++) { const a = col[k - 1], b = col[k]; const d = a.y - b.y; if (Math.abs(a.size - b.size) < 0.1 * a.size && d > 0.6 * a.size && d < 1.7 * a.size) steps.push(d); }
    const lead = median(steps.filter((d) => Math.abs(d - (median(steps) || d)) < 0.25 * sz)) || 1.2 * sz;
    const isStart = (r) => !!(r.bulletRun || r.inlineBullet);
    const gap = (a, b) => a.y - b.y;
    // bullet item containing the row
    let item = null;
    if (i >= 0) {
      let s = i;
      while (s >= 0 && !isStart(col[s]) && s > 0 && gap(col[s - 1], col[s]) <= 1.3 * lead && Math.abs(col[s].size - sz) < 0.1 * sz) s--;
      if (s >= 0 && isStart(col[s])) {
        const tx = col[s].textX; let e = s;
        while (e + 1 < col.length && !isStart(col[e + 1]) && gap(col[e], col[e + 1]) <= 1.3 * lead && Math.abs(col[e + 1].x0 - tx) < 2.5 && Math.abs(col[e + 1].size - col[s].size) < 0.1 * sz) e++;
        // a real list: the item wraps, or a neighbouring item with the same marker at the same x sits close by
        // (an icon before "Location" or a phone number is a marker too, but it has no list neighbours)
        const mk = (r) => (r.bulletRun ? String(r.bulletRun.text).trim() + '@' + Math.round(r.bulletRun.x) : r.inlineBullet ? r.inlineBullet + '@' + Math.round(r.x0) : null);
        const m0 = mk(col[s]);
        let nb = false;
        for (let k = s - 1; k >= 0 && gap(col[k], col[s]) <= 2.6 * lead * (s - k); k--) if (isStart(col[k])) { nb = mk(col[k]) === m0 && gap(col[k], col[s]) <= Math.max(2.6 * lead, (s - k + 1) * 1.4 * lead); break; }
        if (!nb && e + 1 < col.length && isStart(col[e + 1]) && mk(col[e + 1]) === m0 && gap(col[e], col[e + 1]) <= 2.2 * lead) nb = true;
        if (i <= e && (e > s || nb)) item = { start: s, end: e, rows: col.slice(s, e + 1) };
      }
    }
    // heading: bold / caps / bigger than the body text, short, followed by body rows
    const bodySize = median(col.map((r) => r.size)) || sz;
    const headingLike = (r) => (r.bold || r.caps || r.size > 1.1 * bodySize) && !isStart(r) && (r.x1 - r.x0) < 0.85 * (x1 - x0);
    let heading = null;
    if (i >= 0 && headingLike(row) && (row.caps || row.size > 1.1 * bodySize || (row.bold && i + 1 < col.length && !col[i + 1].bold))) {
      const same = (r) => Math.abs(r.size - row.size) < 0.6 && !!r.caps === !!row.caps && !!r.bold === !!row.bold && headingLike(r);
      let e = i; while (e + 1 < col.length && !same(col[e + 1])) e++;
      let p = i - 1; while (p >= 0 && !same(col[p])) p--;
      heading = { index: i, end: e, next: e + 1 < col.length ? e + 1 : null, prev: p >= 0 ? p : null };
    }
    return { x0, x1, col, i, lead, item, heading, gutters: g.gaps, uncertain, notes, bodySize };
  }

  /**
   * Plan "Add like this" without changing anything. mode: 'line' | 'bullet' | 'section'.
   * opts: { body (section's first line), region: { x0, x1 } (user-dragged column bounds, PDF x), wrapOf: lineId (wrap an edited line) }
   */
  async function planInsert(state, pageIndex, anchorId, mode, text, opts) {
    opts = opts || {};
    const pg = state.pages[pageIndex];
    const no = (message, extra) => Object.assign({ ok: false, message }, extra || {});
    if (!pg || pg.src == null || !sources[pg.src] || !sources[pg.src].libDoc) return no('This page has no text to add to.');
    if (totalRotation(pg)) return no('Rotate the page back to upright first — adding lines works on upright pages.');
    const an = await analyzePage(pg.src, pg.index);
    if (!an.lines.length || (an.refusal && an.refusal.code === 'ocr')) return no('Adding lines needs real text, and this page has none: ' + ((an.refusal && an.refusal.message) || 'there’s no text layer.'), { refused: an.refusal ? an.refusal.code : 'empty' });
    const geo = await pageGeometry(pg.src, pg.index);
    const view = an.page.view;
    const cur = currentLines(an, pg);
    const la = layoutAround(an, cur, anchorId, opts.region, geo);
    if (!la) return no('That line could not be found.');
    const { rows, row, st } = la;
    const { col, lead } = st;
    // "line below" a right-hand date / place that sits in its own strip: the line goes under the title next to it
    if (mode === 'line' && !opts._redir && !opts.region && !st.item && String(row.text).length <= 40 && row.x0 > (view[0] + view[2]) / 2) {
      const left = rows.filter((r) => r !== row && !col.includes(r) && Math.abs(r.y - row.y) < 0.4 * row.size && r.x1 < row.x0 - row.size && r.lines.some((l) => !l.bullet)).sort((p, q) => p.x0 - q.x0)[0];
      if (left) return planInsert(state, pageIndex, left.lines.find((l) => !l.bullet).id, mode, text, Object.assign({}, opts, { _redir: true }));
    }
    const notes = st.notes.slice(), conflicts = [];
    let uncertain = st.uncertain;
    // what is inserted, where
    let anchorRow = row, firstGap = lead, srcRow = row, x = row.x0, xCont = row.x0;
    let headRow = null, bodyRow = null, prefix = '', cloneBullet = null, inlineMarker = null;
    const isStartRow = (r) => !!(r.bulletRun || r.inlineBullet);
    // rows on one baseline (a title and its right-aligned date) are separate rows; "the row below" skips them
    const bl = (k) => 0.4 * (col[k] ? col[k].size : row.size);
    const nextBelow = (k) => { if (k < 0 || k >= col.length) return null; for (let j = k + 1; j < col.length; j++) if (col[k].y - col[j].y > bl(k)) return j; return null; };
    const prevAbove = (k) => { if (k < 0 || k >= col.length) return null; for (let j = k - 1; j >= 0; j--) if (col[j].y - col[k].y > bl(k)) return j; return null; };
    if (mode === 'bullet') {
      if (!st.item) return no('This line isn’t part of a bulleted list. Use “Add line below” instead.');
      const it = st.item; anchorRow = it.rows[it.rows.length - 1]; srcRow = it.rows[0];
      const nxt = col[nextBelow(it.end)];
      if (nxt && (nxt.bulletRun || nxt.inlineBullet)) firstGap = anchorRow.y - nxt.y;
      else {
        // gap before this item, from the previous bullet item (if any)
        const prev = col[prevAbove(it.start)];
        firstGap = prev && it.start > 0 && (prev.y - srcRow.y) < 2.2 * lead ? prev.y - srcRow.y : lead;
      }
      x = srcRow.textX; xCont = it.rows[1] ? it.rows[1].x0 : srcRow.textX;
      if (srcRow.bulletRun) cloneBullet = srcRow.bulletRun;
      else {
        const l0 = srcRow.lines[0], m = String(l0.text).match(/^(\S)(\s*)(.*)$/);
        prefix = m ? m[1] + (m[2] || ' ') : ''; x = srcRow.x0;
        // "•  text" in one run: put the marker where it is and the text where the item's text starts (measured from the run's
        // own width), so the new bullet's indent matches instead of using a plain space
        if (m && m[3] && m[2]) {
          const fr = await fontPlanFor(an, l0, m[3]).catch(() => null);
          const tx = fr && fr.t1 && fr.w > 0 ? l0.x + l0.width - fr.w : NaN;     // only measured with the run's own font
          if (tx > l0.x + 0.3 * l0.size && tx < l0.x + 2.5 * l0.size) {
            inlineMarker = { text: m[1], x: l0.x, src: l0 }; prefix = ''; x = tx;
            if (!it.rows[1]) xCont = tx;
          }
        }
      }
    } else if (mode === 'section') {
      if (!st.heading) return no('Select a section heading to add a section like it.');
      const h = st.heading; headRow = col[h.index];
      let he = h.end; if (h.next != null) while (he > h.index && col[he].y - col[h.next].y < bl(he)) he--;
      anchorRow = col[he];
      bodyRow = null; for (let k = h.index + 1; k <= he; k++) if (headRow.y - col[k].y > bl(h.index)) { bodyRow = col[k]; break; }
      const pa = prevAbove(h.index);
      if (h.next != null && col[h.next].y < anchorRow.y - bl(he)) firstGap = anchorRow.y - col[h.next].y;
      else if (pa != null) firstGap = col[pa].y - headRow.y;
      else firstGap = 2.2 * lead;
      srcRow = headRow; x = headRow.x0; xCont = headRow.x0;
      // "Languages / भाषाएँ" in two runs far apart: the copy starts where the whole heading does
      const hl = col.filter((r) => r !== headRow && Math.abs(r.y - headRow.y) < 0.4 * headRow.size && r.x0 < headRow.x0 - 0.5 * headRow.size && r.x1 < headRow.x0 + 2 && Math.abs(r.size - headRow.size) < 0.6).sort((p, q) => p.x0 - q.x0)[0];
      if (hl) { srcRow = hl; x = hl.x0; xCont = hl.x0; }
    } else if (mode === 'line' || mode === 'wrap') {
      x = row.textX; xCont = row.textX;
      if (mode === 'line' && !st.item) {
        // tapped a right-hand date / place next to a title: the new line starts where the title does, not in the date's strip
        const left = col.filter((r) => r !== row && Math.abs(r.y - row.y) < 0.4 * row.size && r.x1 < row.x0 - 0.5).sort((p, q) => p.x0 - q.x0)[0];
        const ls = row.lines.slice().sort((p, q) => p.x - q.x);
        if (left && String(row.text).length <= 40) { x = left.x0; xCont = left.x0; }
        // a hanging label ("2015–2017   MBA, …" or "Product   Roadmapping, …"): the new line lines up with the text after it
        else if (ls.length >= 2 && String(ls[0].text).trim().length <= 14 && !/:\s*$/.test(String(ls[0].text)) && ls[1].x - ls[0].x >= 3 * row.size &&
          col.some((r) => r !== row && Math.abs(r.x0 - ls[1].x) < 1.5)) { x = ls[1].x; xCont = ls[1].x; }
      }
      if (st.item) { const it = st.item; xCont = it.rows[1] ? it.rows[1].x0 : col[it.start].textX; }
      if (mode === 'wrap') { x = xCont; srcRow = row; }
      else if (!st.item) {
        // a paragraph that wraps (e.g. "Cloud & Tools: …" + its second line): the new line goes after its last line,
        // and a paragraph gap (if the next paragraph has one) is kept
        const i0 = col.indexOf(row);
        let e = i0;
        const labelStart = (r) => { const ls = r.lines.filter((l) => !l.bullet); return ls.length >= 2 && !!ls[0].bold && !ls[1].bold && /:\s*$/.test(String(ls[0].text)); };
        const maxR = Math.max(...col.filter((r) => Math.abs(r.size - row.size) < 0.15 * row.size).map((r) => r.x1));
        const contX = (q) => Math.abs(q.x0 - row.x0) < 1.5 || Math.abs(q.x0 - row.textX) < 1.5 || (labelStart(row) && q.x0 > row.x0 && q.x0 < row.lines[1].x + 1.5);
        while (e + 1 < col.length) {
          const q = col[e + 1], g = col[e].y - q.y;
          if (isStartRow(q) || labelStart(q) || !!q.bold !== !!row.lines[row.lines.length - 1].bold || g > 1.25 * lead || g < 0.5 * lead || Math.abs(q.size - row.size) >= 0.1 * row.size || !contX(q) || col[e].x1 < maxR - 8 * row.size) break;
          e++;
        }
        anchorRow = col[e]; if (e > i0) xCont = col[i0 + 1].x0;
        const nx = col[nextBelow(e)];
        if (nx && Math.abs(nx.size - row.size) < 0.1 * row.size && nx.x0 <= row.x0 + 1.5 && nx.x0 >= row.x0 - 1.5) { const g = anchorRow.y - nx.y; if (g > 1.08 * lead && g < 2.6 * lead) firstGap = g; }
        if (labelStart(row)) xCont = e > i0 ? col[i0 + 1].x0 : row.x0;
      }
    } else return no('Unknown kind of line.');
    const pickSrc = (r) => r.lines.filter((l) => !l.bullet && String(l.text).trim()).sort((p, q) => q.width - p.width)[0] || r.lines[0];
    // column right edge for wrapping: the longest same-size rows in the column
    const colRFor = (r) => {
      const isHead = (q) => st.heading && (q.bold || q.caps) && q.size >= r.size && (q === headRow || (q.caps && !/[a-z]/.test(q.text)));
      const body = col.filter((q) => !isHead(q));
      const same = body.filter((q) => Math.abs(q.size - r.size) < 0.15 * r.size);
      let v = Math.max(...((same.length >= 2 && r !== headRow ? same : body.length ? body : col).map((q) => q.x1)));
      v = Math.min(v, st.x1 - 1);
      if (v - r.x0 < 4 * r.size) v = Math.min(st.x1 - 1, r.x0 + 30 * r.size);
      return v;
    };
    let colR = colRFor(srcRow);
    // build the new rows (text wrapped to the column)
    const newRows = [];   // { lines: [{ text, x, src }], y }
    const labelSplit = (r, t) => {
      // "Label: text" rows (bold label + regular text) keep both fonts
      const ls = r.lines.filter((l) => !l.bullet);
      if (ls.length >= 2 && /:\s*$/.test(String(ls[0].text)) && !!ls[0].bold !== !!ls[1].bold) {
        const m = t.match(/^([^:]{1,40}:)\s*(.*)$/);
        if (m) return { label: m[1], rest: m[2], labelSrc: ls[0], restSrc: ls[1] };
      }
      return null;
    };
    const layoutPara = async (r, t, y0, xFirst, xNext, first) => {
      const ls = mode === 'wrap' ? null : labelSplit(r, t);
      const src = mode === 'wrap' && opts.srcLineId ? (((l) => (l && l.inserted ? an.lines.find((o) => o.id === l.edit.srcLineId) : l))(cur.find((l) => l.id === opts.srcLineId)) || pickSrc(r)) : pickSrc(r);
      if (ls) {
        const lw = (await fontPlanFor(an, ls.labelSrc, ls.label)) || { w: 0 };
        const lsw = (await fontPlanFor(an, ls.labelSrc, String(ls.labelSrc.text).replace(/\s+$/, ''))) || { w: ls.labelSrc.width };
        const gapLR = Math.max(0.22 * ls.restSrc.size, ls.restSrc.x - (ls.labelSrc.x + lsw.w));
        const xr = xFirst + lw.w + gapLR;
        const cr = mode === 'section' ? colRFor(r) : colR;
        const parts = ls.rest ? await wrapText(an, ls.restSrc, ls.rest, [cr - xr, cr - xNext]) : [];
        if (!parts) return null;
        newRows.push({ y: y0, lines: [{ text: ls.label, x: xFirst, src: ls.labelSrc }].concat(parts.length ? [{ text: parts[0], x: xr, src: ls.restSrc }] : []) });
        parts.slice(1).forEach((p, k) => newRows.push({ y: y0 - (k + 1) * lead, lines: [{ text: p, x: xNext, src: ls.restSrc }] }));
        return parts.length || 1;
      }
      const full = (first ? prefix : '') + t;
      const cr = mode === 'section' ? colRFor(r) : colR;
      const parts = await wrapText(an, src, full, [cr - xFirst, cr - xNext]);
      if (!parts) return null;
      parts.forEach((p, k) => newRows.push({ y: y0 - k * lead, lines: [{ text: p, x: k ? xNext : xFirst, src }] }));
      return parts.length;
    };
    const typed = String(text || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!typed) return no('Type the text to add first.');
    if (mode === 'section') {
      // white / very light heading text sits on a coloured band; the band isn't copied, so the new heading would be invisible
      const hc = String(pickSrc(srcRow).color || '#000000').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
      const lum = hc ? (0.2126 * parseInt(hc[1], 16) + 0.7152 * parseInt(hc[2], 16) + 0.0722 * parseInt(hc[3], 16)) / 255 : 0;
      // behind it: a big fill (sidebar / page background) is fine, the copy lands on it too; a short band is not copied
      const hb = lineBox(pickSrc(srcRow)), PH = view[3] - view[1];
      const pageBgDark = (geo.scan.items || []).some((it) => (it.kind === 'path' && it.painted && /f|F|B|b/.test(String(it.paint || '')) || it.kind === 'image') &&
        it.bbox[0] <= hb[0] + 1 && it.bbox[2] >= hb[2] - 1 && it.bbox[1] <= hb[1] - 3 * lead && it.bbox[3] >= hb[3] && (it.bbox[3] - it.bbox[1]) > 0.25 * PH);
      if (lum > 0.8 && !pageBgDark) return no('This heading is light text on a coloured band, and copying the band isn’t supported yet — use “Add line below” under the heading instead.', { refused: 'band' });
    }
    const noFontMsg = hasIndic(typed + ' ' + (opts.body || '')) || COMPLEX_SCRIPT_RE.test((typed + ' ' + (opts.body || '')).replace(INDIC_STRIP_RE, ''))
      ? 'Adding new lines in Hindi or other Indic / complex scripts isn’t supported yet — use the Text tool for those.'
      : 'Some of these characters aren’t available in the matching fonts.';
    const y1 = anchorRow.y - firstGap;
    let height = firstGap, n;
    if (mode === 'section') {
      n = await layoutPara(headRow, typed, y1, x, x, true);
      if (n == null) return no(noFontMsg);
      height += (n - 1) * lead;
      const body = String(opts.body || '').replace(/[\r\n\t]+/g, ' ').trim();
      if (body && bodyRow) {
        const hb = headRow.y - bodyRow.y;
        const yb = y1 - (n - 1) * lead - hb;
        // continuation lines align with the body text (not with a date / label column to its left)
        const nb = await layoutPara(bodyRow, body, yb, bodyRow.textX, bodyRow.bulletRun || bodyRow.inlineBullet ? bodyRow.textX : (labelSplit(bodyRow, body) ? bodyRow.x0 : bodyRow.textX), true);
        if (nb == null) return no(noFontMsg);
        height += hb + (nb - 1) * lead;
        if (bodyRow.bulletRun) newRows[newRows.length - nb].clone = { src: bodyRow.bulletRun, x: bodyRow.bulletRun.x };
      }
    } else {
      n = await layoutPara(srcRow, typed, y1, x, xCont, true);
      if (n == null) return no(noFontMsg);
      height += (n - 1) * lead;
      if (cloneBullet) newRows[0].clone = { src: cloneBullet, x: cloneBullet.x };
      if (inlineMarker) newRows[0].lines.unshift(inlineMarker);
    }
    const dy = -Math.round(height * 1000) / 1000;
    // the cut: halfway between the anchor and the next row in the column
    const ai = col.indexOf(anchorRow), nextRow = col[nextBelow(ai)];
    let yCut = nextRow ? anchorRow.y - Math.min(anchorRow.y - nextRow.y, 3 * lead) / 2 : anchorRow.y - 0.6 * lead;
    // under body text the cut sits right below the line, so a divider between it and the next item moves with what's below;
    // under a heading it stays halfway (the heading's own underline stays with the heading)
    const headingAnchor = anchorRow.bold || anchorRow.caps || anchorRow.size > 1.1 * st.bodySize;
    if (!headingAnchor && mode !== 'section') yCut = Math.max(yCut, anchorRow.bottom - 0.3);
    const rects = [{ x0: st.x0, x1: st.x1, yTop: yCut, yBot: view[1] - 2 }];
    // spanners: rows / paths below the cut that cross the column edges -> everything below them moves too
    const crosses = (bb) => (bb[0] < st.x0 - 1 && bb[2] > st.x0 + 1) || (bb[0] < st.x1 - 1 && bb[2] > st.x1 + 1);
    const W = view[2] - view[0], H = view[3] - view[1];
    const geoItems = geo.scan.items.map((it, k) => { const d = RF().shiftFor(it.bbox, pg.shifts); return { k, it, bb: [it.bbox[0], it.bbox[1] + d, it.bbox[2], it.bbox[3] + d] }; });
    // backgrounds / containers never move: page-size fills, full-height column or sidebar boxes (also one that only
    // holds this column's text, or a neighbouring sidebar that pokes a few points into this column)
    const isBackground = (bb) => {
      if ((bb[3] - bb[1]) <= 0.4 * H) return false;
      if ((bb[2] - bb[0]) > 0.5 * W || (bb[0] <= st.x0 + 2 && bb[2] >= st.x1 - 2)) return true;
      if (bb[0] <= row.x0 + 2 && bb[2] >= row.x1 - 2) return true;
      const ov = Math.min(bb[2], st.x1) - Math.max(bb[0], st.x0);
      return ov < Math.max(8, 0.1 * (bb[2] - bb[0]));
    };
    let spanTop = null;
    for (const r of rows) if (r.y < yCut && crosses([r.x0, 0, r.x1, 0])) spanTop = Math.max(spanTop == null ? -Infinity : spanTop, r.top + 0.5);
    for (const g of geoItems) {
      if (g.it.kind === 'shading' || (g.it.kind === 'path' && !g.it.painted) || isBackground(g.bb)) continue;
      if (g.bb[3] < yCut && crosses(g.bb) && g.bb[2] - g.bb[0] < 0.98 * W) spanTop = Math.max(spanTop == null ? -Infinity : spanTop, g.bb[3] + 0.5);
    }
    if (spanTop != null && st.x0 > view[0] + 4 || spanTop != null && st.x1 < view[2] - 4) {
      rects.push({ x0: view[0] - 2, x1: view[2] + 2, yTop: spanTop, yBot: view[1] - 2 });
      uncertain = true; notes.push('Something below crosses the column edge, so everything under it moves down too.');
    }
    // a big empty gap (e.g. above a footer) absorbs the shift: what's below it stays put
    if (spanTop == null) {
      const below = col.slice(ai + 1);
      let maxGap = 2 * lead;
      for (let k = 1; k < below.length; k++) {
        const g = below[k - 1].bottom - below[k].top;
        if (g - height >= Math.max(24, 2 * maxGap)) {
          rects[0].yBot = below[k].top + 1;
          uncertain = true; notes.push('There’s a large gap lower down; the content under it stays where it is.');
          break;
        }
        maxGap = Math.max(maxGap, below[k - 1].y - below[k].y);
      }
    }
    const inR = (bb) => RF().inRegion(bb, rects, 1);
    // what moves
    // rotated / vertical text (margin labels, diagonal badges) is decoration: it stays where it is
    const rotLine = (l) => !l.inserted && (l.vertical || Math.abs(l.b || 0) > 0.02 * l.size || Math.abs(l.c || 0) > 0.02 * l.size);
    const moveLines = cur.filter((l) => !row.lines.includes(l) && !rotLine(l) && l.y < yCut && inR(probeBox(l)));
    const moveGeo = geoItems.filter((g) => g.it.kind !== 'shading' && inR(g.bb));
    const moveAnn = geo.annots.map((a) => { const d = RF().shiftFor(a.bbox, pg.shifts); return Object.assign({}, a, { bb: [a.bbox[0], a.bbox[1] + d, a.bbox[2], a.bbox[3] + d] }); }).filter((a) => inR(a.bb));
    const moveApp = (pg.annots || []).filter((a) => inR(appAnnotBox(a, view)));
    // safety: boxes / rules cut by the insertion point, locked text, clipping
    for (const g of geoItems) {
      // clip-only paths are not boxes: whether moved content would leave its clip is checked separately
      if (g.it.kind === 'shading' || (g.it.kind === 'path' && !g.it.painted) || isBackground(g.bb)) continue;
      const ov = Math.min(g.bb[2], st.x1) - Math.max(g.bb[0], st.x0);
      if (ov > 2 && g.bb[3] > yCut + 0.3 * lead && g.bb[1] < yCut - 0.3 * lead && g.bb[1] > view[1] + 2) conflicts.push({ kind: 'cut', bbox: g.bb, message: 'A box or table crosses the place where the new line goes, so it can’t be moved safely.' });
    }
    // text drawn inside a Form XObject (e.g. a whole page wrapped by pdfpages) can't be shifted from the page stream;
    // every other run (incl. Type 3 / per-glyph text) is checked run by run below
    {
      // every line that should move must be drawn by a page-stream run that moves with it
      const formShows = an.shows.filter((x) => x.form);
      const runs = (geo.texts || []).filter((t) => !t.rot).map((t) => { const d0 = RF().shiftFor(t.box, pg.shifts); return [t.box[0], t.box[1] + d0, t.box[2], t.box[3] + d0]; });
      for (const l of moveLines) {
        if (l.inserted || l.edit || !l.orig || !String(l.text).trim()) continue;
        const pb = probeBox(l), cy = (pb[1] + pb[3]) / 2;
        const covered = runs.some((bb) => Math.abs((bb[1] + bb[3]) / 2 - cy) < 0.45 * l.size && Math.min(bb[2], pb[2]) - Math.max(bb[0], pb[0]) > -0.2 * l.size && inR(bb));
        if (covered) continue;
        if (formShows.length && lineShows(formShows, l.orig).length) conflicts.push({ kind: 'form', bbox: lineBox(l), message: 'The text below is drawn inside an embedded block (a Form XObject — e.g. a page imported whole from another PDF), so it can’t be moved line by line.' });
        else conflicts.push({ kind: 'locked', bbox: lineBox(l), message: 'Some text below couldn’t be traced to the page’s drawing commands, so it can’t be moved safely.' });
        break;
      }
    }
    const movedGeoKeys = new Set(moveGeo.map((g) => g.k));
    for (const g of moveGeo) {
      const c = g.it.clipAt; if (!c) continue;
      const clipItem = geoItems.find((h) => h.it.clip && h.it.i1 < g.it.i0 && Math.abs(h.it.bbox[0] - c[0]) < 0.5 && Math.abs(h.it.bbox[3] - c[3]) < 0.5);
      if (clipItem && movedGeoKeys.has(clipItem.k)) continue;
      if (g.bb[1] + dy < c[1] - 1) conflicts.push({ kind: 'clip', bbox: g.bb, message: 'Part of the page below is clipped; moving it would hide it.' });
    }
    // text runs: those in the region move in the content stream; a run that is only partly in it (e.g. a LaTeX line whose
    // left text and right-aligned date are one TJ across the column edge) can't, nor can one that would leave its clip
    {
      const editedBoxes = cur.filter((l) => l.edit && l.orig && !l.inserted).map((l) => probeBox(l.orig));
      const owned = (bb) => editedBoxes.some((e) => bb[0] >= e[0] - 1 && bb[2] <= e[2] + 1 && Math.abs(bb[1] - e[1]) < 1);
      const clipMoves = (c) => geoItems.some((h) => h.it.clip && movedGeoKeys.has(h.k) && Math.abs(h.it.bbox[0] - c[0]) < 0.5 && Math.abs(h.it.bbox[1] - c[1]) < 0.5 && Math.abs(h.it.bbox[3] - c[3]) < 0.5);
      let shared = null, stuck = null, clipped = null;
      for (const t of geo.texts || []) {
        if (t.rot || owned(t.box)) continue;
        const d0 = RF().shiftFor(t.box, pg.shifts), bb = [t.box[0], t.box[1] + d0, t.box[2], t.box[3] + d0];
        const cy = (bb[1] + bb[3]) / 2;
        if (inR(bb)) {
          if (!t.movable) stuck = stuck || bb;
          const c = geo.scan.textClip[t.i];
          if (c && bb[1] + dy < c[1] - 1 && c[3] - c[1] < 0.95 * H && !clipMoves(c)) clipped = clipped || bb;
        } else if (rects.some((r) => cy <= r.yTop && cy >= r.yBot && bb[2] > r.x0 + 1 && bb[0] < r.x1 - 1 && ((bb[0] < r.x0 - 1) || (bb[2] > r.x1 + 1)))) shared = shared || bb;
      }
      if (shared) conflicts.push({ kind: 'shared', bbox: shared, message: 'A line below runs across the column edge (its text is one piece), so it can’t be moved safely. Drag the column edges to include all of it, or add this lower down.' });
      if (stuck) conflicts.push({ kind: 'locked', bbox: stuck, message: 'Some text below can’t be moved cleanly, so nothing would be changed.' });
      if (clipped) conflicts.push({ kind: 'clip', bbox: clipped, message: 'Some text below sits in a clipped area; moving it would hide it.' });
    }
    // room on the page
    const topMargin = view[3] - Math.max(...rows.map((r) => r.top));
    const lowest = Math.min(...rows.map((r) => r.bottom), ...geoItems.filter((g) => g.it.painted !== false && g.it.kind !== 'shading' && !isBackground(g.bb)).map((g) => g.bb[1]));
    let bottomLimit = Math.min(view[1] + Math.max(18, Math.min(72, topMargin)), lowest);
    // a container box (sidebar background, frame) around this text: what moves must stay inside it
    for (const g of geoItems) {
      const bb = g.bb;
      if (g.it.kind !== 'path' || !g.it.painted || (bb[3] - bb[1]) <= 0.4 * H || !(bb[0] <= row.x0 + 2 && bb[2] >= row.x1 - 2 && bb[3] >= row.top && bb[1] <= row.bottom)) continue;
      if (bb[1] > view[1] + 4) bottomLimit = Math.max(bottomLimit, Math.min(bb[1] + 4, row.bottom));
    }
    const newBottom = Math.min(...newRows.map((r) => r.y - 0.25 * srcRow.size), ...moveLines.map((l) => lineBox(l)[1] + dy), ...moveGeo.map((g) => g.bb[1] + dy));
    const overflow = newBottom < bottomLimit - 0.5 ? Math.round((bottomLimit - newBottom) * 10) / 10 : 0;
    // preview geometry (display points)
    const disp = (bb) => ({ x: bb[0] - view[0], y: view[3] - bb[3], w: bb[2] - bb[0], h: bb[3] - bb[1] });
    const newLines = [];
    for (const r of newRows) {
      if (r.clone) newLines.push({ clone: true, srcId: r.clone.src.id, x: r.clone.x, y: r.y, size: r.clone.src.size, w: r.clone.src.width, text: r.clone.src.text });
      for (const l of r.lines) {
        const fp = await fontPlanFor(an, l.src, l.text);
        newLines.push({ text: l.text, x: l.x, y: r.y, size: l.src.size, srcId: l.src.id, w: fp ? fp.w : 0, label: fp ? fp.label : '', color: l.src.color, bold: !!l.src.bold, italic: !!l.src.italic });
      }
    }
    // the landing spot must be clear: no border, rule or box edge that stays put (e.g. the bottom of a table cell)
    {
      const land = newLines.map((l) => [l.x, l.y - 0.25 * l.size, l.x + Math.max(l.w, 0.3 * l.size), l.y + 0.8 * l.size]);
      for (const g of geoItems) {
        if (movedGeoKeys.has(g.k) || g.it.kind === 'shading' || (g.it.kind === 'path' && !g.it.painted) || isBackground(g.bb)) continue;
        for (const b of land) {
          const ox = Math.min(b[2], g.bb[2]) - Math.max(b[0], g.bb[0]), oy = Math.min(b[3], g.bb[3]) - Math.max(b[1], g.bb[1]);
          if (ox <= 0.5 || oy <= -0.2) continue;
          const contains = g.bb[0] <= b[0] + 0.5 && g.bb[2] >= b[2] - 0.5 && g.bb[1] <= b[1] + 0.5 && g.bb[3] >= b[3] - 0.5;
          if (contains && !g.it.stroke) continue;          // a fill behind the text (cell / sidebar background)
          if (contains && g.it.stroke && (g.bb[3] - g.bb[1]) > 3 && b[1] - g.bb[1] > 1 && g.bb[3] - b[3] > 1) continue;   // inside a stroked box with room
          conflicts.push({ kind: 'landing', bbox: g.bb, message: 'The new line would run into a border or box below it (e.g. the bottom of a table cell). Growing tables and boxes isn’t supported yet.' });
          break;
        }
      }
    }
    // the heading's own divider comes along with a new section
    const pathClones = [];
    if (mode === 'section' && headRow) {
      const lim = bodyRow ? bodyRow.top : headRow.y - 1.6 * headRow.size;
      for (const g of geoItems) if (g.it.kind === 'path' && g.it.painted && !g.it.clip && g.bb[3] < headRow.y && g.bb[1] > lim - 0.5 && g.bb[0] >= st.x0 - 1 && g.bb[2] <= st.x1 + 1) if (!pathClones.some((q) => q.bb.every((v, k) => Math.abs(v - g.bb[k]) < 0.3))) pathClones.push({ bb: g.bb, k: g.k, dy: y1 - headRow.y, bbox: [g.bb[0], g.bb[1] + y1 - headRow.y, g.bb[2], g.bb[3] + y1 - headRow.y] });
    }
    const counts = { lines: moveLines.filter((l) => !l.bullet).length, bullets: moveLines.filter((l) => l.bullet).length, paths: moveGeo.filter((g) => g.it.kind === 'path' && g.it.painted).length, images: moveGeo.filter((g) => g.it.kind !== 'path').length, links: moveAnn.length, annots: moveApp.length };
    { const seen = new Set(); for (let k = conflicts.length - 1; k >= 0; k--) { const key = conflicts[k].kind + conflicts[k].bbox.map((v) => v.toFixed(1)).join(','); if (seen.has(key)) conflicts.splice(k, 1); else seen.add(key); } }
    const uniq = (boxes) => { const seen = new Set(); return boxes.filter((b) => { const key = [b.x, b.y, b.w, b.h].map((v) => v.toFixed(1)).join(','); if (seen.has(key)) return false; seen.add(key); return true; }); };
    const ok = !conflicts.length && !overflow;
    return {
      ok, mode, pageIndex, anchorId, text: typed, body: opts.body || '', region: { x0: st.x0, x1: st.x1, yCut, rects, dyn: !!opts.region }, dy,
      lead, colRight: colR, uncertain, notes, conflicts: conflicts.slice(0, 6), overflow, bottomLimit,
      newLines, pathClones, counts, moving: { lines: moveLines.map((l) => l.id), geo: moveGeo.map((g) => g.k), annots: moveAnn.map((a) => a.i), app: moveApp.map((a) => a.id) },
      preview: {
        moved: uniq(moveLines.map((l) => disp(lineBox(l))).concat(moveGeo.map((g) => disp(g.bb)), moveAnn.map((a) => disp(a.bb)), moveApp.map((a) => disp(appAnnotBox(a, view))))),
        ddy: -dy, region: { x0: st.x0 - view[0], x1: st.x1 - view[0], yTop: view[3] - yCut, yBot: view[3] - rects[0].yBot, extra: rects.slice(1).map((r) => ({ x0: r.x0 - view[0], x1: r.x1 - view[0], yTop: view[3] - r.yTop })) },
        added: newLines.map((l) => disp([l.x, l.y - 0.22 * l.size, l.x + Math.max(l.w, l.size * 0.4), l.y + 0.78 * l.size])).concat(pathClones.map((p) => disp(p.bbox))),
        conflicts: conflicts.map((c) => disp(c.bbox)), gutters: st.gutters.map((g) => [g[0] - view[0], g[1] - view[0]]), page: { w: W, h: H },
      },
      message: conflicts.length ? conflicts[0].message : overflow ? `There isn’t room for this on the page — it would push content ${Math.ceil(overflow)} pt past the bottom margin.` : '',
    };
  }

  /** Apply a plan (re-planned from its inputs so it matches the page right now). One call = one undo step for the app. */
  async function applyInsert(state, pageIndex, planIn) {
    const plan = await planInsert(state, pageIndex, planIn.anchorId, planIn.mode, planIn.text, { body: planIn.body, region: planIn.region && planIn.region.dyn ? { x0: planIn.region.x0, x1: planIn.region.x1 } : null });
    if (!plan.ok) return { ok: false, message: plan.message || 'This can’t be added safely.' };
    const pg = state.pages[pageIndex];
    const before = JSON.stringify({ textEdits: pg.textEdits || [], shifts: pg.shifts || [], annots: pg.annots || [] });
    const revert = () => { const b = JSON.parse(before); pg.textEdits = b.textEdits; pg.shifts = b.shifts; pg.annots = b.annots; };
    const an = await analyzePage(pg.src, pg.index);
    const geo = await pageGeometry(pg.src, pg.index);
    const view = an.page.view;
    const dy = plan.dy;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    pg.textEdits = (pg.textEdits || []).slice();
    // 1. text below: untouched runs move with the page shift (content stream); edited / added lines move their edit
    for (const id of plan.moving.lines) {
      const e = pg.textEdits.find((x) => x.lineId === id);
      if (e) { const ne = Object.assign({}, e, { move: { dx: (e.move ? e.move.dx : 0), dy: r3((e.move ? e.move.dy : 0) + dy) } }); pg.textEdits[pg.textEdits.indexOf(e)] = ne; }
    }
    // 2. vector paths, images, links: recorded as a page shift, applied to the content stream at render / export
    pg.shifts = (pg.shifts || []).concat([{ rects: plan.region.rects, dy: r3(dy), tol: 1 }]);
    // 3. annotations added in Pdfroo
    const ids = new Set(plan.moving.app);
    pg.annots = (pg.annots || []).map((a) => { if (!ids.has(a.id)) return a; const c = JSON.parse(JSON.stringify(a)); moveAppAnnot(c, -dy); return c; });
    // 4. the new lines
    const groupId = uid('ins');
    for (const nl of plan.newLines) {
      const src = an.lines.find((l) => l.id === nl.srcId) || currentLines(an, pg).find((l) => l.id === nl.srcId);
      if (!src) continue;
      const base = { id: uid('te'), lineId: uid('ins'), insert: true, group: groupId, srcLineId: src.id, original: '', verified: true, reading: null, removal: 'none', bg: src.bg || '#ffffff', color: src.color || '#000000',
        geo: { x: r3(nl.x), y: r3(nl.y), size: src.size, hs: src.hs, width: 0, asc: src.asc, desc: src.desc, fb: src.fakeBold || 0 }, match: null };
      if (nl.clone) {
        const sh = lineShows(an.shows.filter((x) => !x.form), src)[0];
        if (!sh || !sh.codes.length) continue;
        const lf = an.libFonts[sh.font];
        const hex = sh.codes.map((c) => c.toString(16).toUpperCase().padStart(lf && lf.composite ? 4 : 2, '0')).join('');
        const m = TI().fmt;
        const M = [sh.m[0] / (sh.Tfs * sh.Th), sh.m[1] / (sh.Tfs * sh.Th), sh.m[2] / sh.Tfs, sh.m[3] / sh.Tfs, sh.m[4], sh.m[5]];
        pg.textEdits.push(Object.assign(base, { kind: 'clone', text: '', tier: 1, label: 'Bullet copied', newW: src.width,
          clone: { key: sh.font, hex, Tfs: sh.Tfs, Th: sh.Th, tm: [M[0], M[1], M[2], M[3], r3(M[4] + nl.x - src.x), r3(M[5] + nl.y - src.y)].map((v) => +m(v)), color: sh.fill || src.color || '#000000' } }));
        continue;
      }
      const fp = await fontPlanFor(an, src, nl.text);
      if (!fp) { revert(); return { ok: false, message: 'Some of these characters aren’t available in the matching fonts.' }; }
      pg.textEdits.push(Object.assign(base, { kind: 'text', text: nl.text, tier: fp.tier, label: fp.label, t1: fp.t1, sub: fp.sub, newW: r3(fp.w) }));
    }
    for (const pc of plan.pathClones) {
      const txt = RF().clonePath(geo.scan.items[pc.k], 0, pc.dy);
      if (txt) pg.textEdits.push({ id: uid('te'), lineId: uid('ins'), insert: true, group: groupId, kind: 'path', path: txt, bbox: pc.bbox, text: '', original: '', removal: 'none', tier: 0, label: '', geo: { x: pc.bbox[0], y: pc.bbox[1], size: 1 }, match: null, verified: true });
    }
    // verify once: every new line is there and moved lines are found at their new place
    try {
      const proxy = await getEditedProxy(pg);
      const page = await proxy.getPage(1);
      const tc = await page.getTextContent();
      const all = tc.items.map((i) => i.str || '').join('').replace(/\s+/g, '').normalize('NFC');
      const missing = plan.newLines.filter((l) => !l.clone && l.text.trim() && !all.includes(l.text.replace(/\s+/g, '').normalize('NFC')));
      if (missing.length) { revert(); return { ok: false, message: 'Pdfroo couldn’t add this cleanly, so nothing was changed.' }; }
      for (const id of plan.moving.lines.slice(0, 40)) {
        const l = currentLines(an, pg).find((x) => x.id === id);
        if (!l || !String(l.text).trim() || l.inserted) continue;
        const want = String(l.text).replace(/\s+/g, '').normalize('NFKC').slice(0, 12);
        const hit = tc.items.some((i) => String(i.str || '').replace(/\s+/g, '').normalize('NFKC').includes(want.slice(0, Math.min(want.length, String(i.str || '').replace(/\s+/g, '').length))) && Math.abs(i.transform[5] - l.y) < 0.4 * l.size && i.transform[4] > l.x - 0.6 * l.size && i.transform[4] < l.x + Math.max(l.width, l.size));
        if (!hit) { revert(); return { ok: false, message: 'Pdfroo couldn’t move the text below cleanly, so nothing was changed.' }; }
      }
    } catch (err) { console.warn(err); revert(); return { ok: false, message: 'Pdfroo couldn’t add this cleanly, so nothing was changed.' }; }
    const c = plan.counts, parts = [];
    if (c.lines) parts.push(`${c.lines} line${c.lines === 1 ? '' : 's'}`);
    if (c.paths) parts.push(`${c.paths} divider${c.paths === 1 ? '' : 's'}`);
    if (c.images) parts.push(`${c.images} image${c.images === 1 ? '' : 's'}`);
    if (c.links) parts.push(`${c.links} link${c.links === 1 ? '' : 's'}`);
    const lbl = (plan.newLines.find((l) => !l.clone) || {}).label || '';
    const nRows = new Set(plan.newLines.filter((l) => !l.clone).map((l) => l.y.toFixed(1))).size;
    return { ok: true, message: `Added ${nRows} line${nRows === 1 ? '' : 's'} · ${lbl}` + (parts.length ? ` · moved ${parts.join(', ')} down ${Math.abs(dy).toFixed(1)} pt` : ''), plan };
  }

  /** An edited line that now runs past its column: plan to keep what fits and wrap the rest onto new lines below. */
  async function planWrapEdit(state, pageIndex, lineId, opts) {
    const pg = state.pages[pageIndex];
    if (!pg || pg.src == null || totalRotation(pg)) return { ok: false, message: '' };
    const e = (pg.textEdits || []).find((x) => x.lineId === lineId && !x.moveOnly && (!x.insert || x.kind === 'text'));
    if (!e || e.sub && e.sub.indic) return { ok: false, message: '' };
    const an = await analyzePage(pg.src, pg.index);
    const ln = e.insert ? an.lines.find((l) => l.id === e.srcLineId) : an.lines.find((l) => l.id === lineId); if (!ln) return { ok: false, message: '' };
    const lnX = e.insert ? e.geo.x : ln.x;
    // column found with the line at its old length (the long edit itself would bridge the gutter)
    const cur0 = currentLines(an, pg).map((l) => (l.id === lineId ? Object.assign({}, l, { width: l.orig ? Math.min(l.width, l.orig.width) : Math.min(l.width, l.size) }) : l));
    const la = layoutAround(an, cur0, lineId, opts && opts.region, await pageGeometry(pg.src, pg.index));
    if (!la) return { ok: false, message: '' };
    const { row, st } = la;
    const sameSize = st.col.filter((r) => Math.abs(r.size - row.size) < 0.15 * row.size && r !== row);
    let colR = sameSize.length ? Math.max(...sameSize.map((r) => r.x1)) : st.x1 - 1;
    colR = Math.min(colR, st.x1 - 1);
    const x = lnX + (e.move ? e.move.dx : 0);
    const right = x + (e.newW || 0) * (1 / (e.fit || 1));
    if (right <= colR + 1.5 || (e.align && e.align !== 'left' && e.align !== 'justify')) return { ok: false, message: '', fits: true };
    const parts = await wrapText(an, ln, e.text, [colR - x]);
    if (!parts || parts.length < 2) return { ok: false, message: '' };
    const keep = parts[0], rest = e.text.slice(keep.length).trim();
    return { ok: true, lineId, keep, rest, colRight: colR, over: right - colR };
  }

  /** How far (pt) a line now runs past the right edge of its column, or 0. */
  async function columnOverflow(state, pageIndex, lineId) {
    try { const w = await planWrapEdit(state, pageIndex, lineId); return w && w.ok ? Math.max(0.01, w.over || 0.01) : 0; } catch (e) { return 0; }
  }
  /** Edited line past its column: keep what fits, wrap the rest onto new line(s) below, moving the content under it. */
  async function applyWrapEdit(state, pageIndex, lineId, opts) {
    const w = await planWrapEdit(state, pageIndex, lineId, opts);
    if (!w.ok) return { ok: false, message: w.fits ? 'The line already fits its column.' : 'This line can’t be wrapped.' };
    const pg = state.pages[pageIndex];
    const before = JSON.stringify({ textEdits: pg.textEdits || [], shifts: pg.shifts || [], annots: pg.annots || [] });
    const revert = () => { const b = JSON.parse(before); pg.textEdits = b.textEdits; pg.shifts = b.shifts; pg.annots = b.annots; };
    const e0 = pg.textEdits.find((x) => x.lineId === lineId);
    const r1 = await editTextLine(state, pageIndex, lineId, w.keep, { verified: true, style: e0 && e0.style ? Object.assign({}, e0.style) : undefined });
    if (!r1.ok) { revert(); return r1; }
    const plan = await planInsert(state, pageIndex, lineId, 'wrap', w.rest, { srcLineId: lineId, region: opts && opts.region });
    if (!plan.ok) { revert(); return { ok: false, message: plan.message, plan }; }
    const r2 = await applyInsert(state, pageIndex, plan);
    if (!r2.ok) { revert(); return r2; }
    return { ok: true, message: 'Wrapped onto the next line · ' + r2.message.replace(/^Added [^·]*· /, ''), plan: r2.plan };
  }
  /** Preview for wrapping an edited line (nothing changes): the plan of the insert after the line is cut down to what fits. */
  async function previewWrapEdit(state, pageIndex, lineId, opts) {
    const w = await planWrapEdit(state, pageIndex, lineId, opts);
    if (!w.ok) return Object.assign({ ok: false }, w);
    const pg = state.pages[pageIndex];
    const saved = JSON.stringify(pg.textEdits || []);
    try {
      const e0 = pg.textEdits.find((x) => x.lineId === lineId);
      const r1 = await editTextLine(state, pageIndex, lineId, w.keep, { verified: true, style: e0 && e0.style ? Object.assign({}, e0.style) : undefined });
      if (!r1.ok) return { ok: false, message: r1.message };
      const plan = await planInsert(state, pageIndex, lineId, 'wrap', w.rest, { srcLineId: lineId, region: opts && opts.region });
      plan.wrap = w;
      return plan;
    } finally { pg.textEdits = JSON.parse(saved); }
  }

  root.PdfEngine = {
    // lifecycle / loading
    load, getPageCount, getSourceBytes, getSignatureInfo, hasSource, closeAll, createState, newPage, uid,
    // rendering
    renderPage, renderThumbnail,
    // page operations on the serializable state
    rotatePage, deletePage, duplicatePage, reorderPages, addBlankPage, merge,
    // export
    // existing-text editing (tiers 1–3; see README)
    _droppedReps: () => lastDroppedReps.slice(), _pageGeometry: pageGeometry,
    getTextLines, editTextLine, moveTextLine, getAddOptions, planInsert, applyInsert, planWrapEdit, previewWrapEdit, applyWrapEdit, displayDeltaToPdf, getLineStyleInfo, findText, replaceHits, getLineEditorFont, verifyIndicLine, confirmIndicReading, _analyzePage: analyzePage, _learnStats: learnStats,
    _fontReading: async (src, index, lineId, dbg) => { const an = await analyzePage(src, index); const ln = an.lines.find((l) => l.id === lineId); fontDbg = dbg || null; try { return ln && await fontReadingFor(an, ln, null); } finally { fontDbg = null; } },
    exportWithAnnotations, getLastExportFonts: () => Object.assign({}, lastExportFonts), isComplexScript: (t) => COMPLEX_SCRIPT_RE.test(String(t).replace(INDIC_STRIP_RE, '')), hasIndic, ensureScriptFonts, indicMalformed,
    // geometry shared with the UI
    totalRotation, displaySize, penPath, measureText, arrowHead,
    TEXT_ASCENT, LINE_HEIGHT, FONT_STACK,
  };
})(window);
