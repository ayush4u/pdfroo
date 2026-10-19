/* Pdfroo form filler: fill in the fields of an existing PDF form (AcroForm), on this device.
 * Uses only pdf.js (to find and show the fields) and pdf-lib (to write the answers), both already shipped.
 * Entry point: button #landingFormBtn. Public API: window.PdfrooForms (pure helpers are used by tests). */
(function (root) {
  'use strict';
  const L = () => root.PDFLib;

  /* ---------- read: list the fillable fields, grouped by name ---------- */
  /** Returns { pages:[{w,h,widgets:[...]}], fields: Map<name,{type,...}> } from pdf.js annotations. */
  async function readFields(pdf) {
    const pages = [], fields = new Map();
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p), vp = pg.getViewport({ scale: 1 }), anns = await pg.getAnnotations({ intent: 'display' });
      const widgets = [];
      for (const a of anns) {
        if (a.subtype !== 'Widget' || !a.fieldName || a.pushButton) continue;
        const kind = a.fieldType === 'Tx' ? (a.multiLine ? 'textarea' : 'text')
          : a.fieldType === 'Btn' ? (a.radioButton ? 'radio' : a.checkBox ? 'checkbox' : null)
          : a.fieldType === 'Ch' ? (a.combo ? 'select' : 'list') : null;
        if (!kind) continue;
        const [x1, y1, x2, y2] = pdfjsLibRect(a.rect);
        const w = { page: p - 1, name: a.fieldName, kind, x: x1, y: vp.height - y2 + (vp.viewBox[1] || 0), w: x2 - x1, h: y2 - y1,
          on: a.radioButton ? a.buttonValue : a.exportValue, readOnly: !!a.readOnly, maxLen: a.maxLen || 0, multi: !!a.multiSelect,
          tip: a.alternativeText || '', options: (a.options || []).map((o) => ({ v: o.exportValue, t: o.displayValue })) };
        w.x -= vp.viewBox[0] || 0;
        widgets.push(w);
        if (!fields.has(a.fieldName)) fields.set(a.fieldName, { name: a.fieldName, kind, readOnly: w.readOnly, options: w.options, multi: w.multi, value: initial(a), widgets: [] });
        const f = fields.get(a.fieldName); f.widgets.push(w);
        if (kind === 'radio' && a.fieldValue && a.fieldValue !== 'Off') f.value = a.fieldValue;
      }
      pages.push({ w: vp.width, h: vp.height, widgets }); pg.cleanup();
    }
    return { pages, fields };
  }
  /** pdf.js reports a radio button's on-state name (often "0", "1"…); pdf-lib selects by export value (/Opt).
   *  Rewrite each radio widget's `on` (and the field's value) to the export value pdf-lib understands. */
  async function mapRadios(bytes, fields) {
    let form; try { form = (await L().PDFDocument.load(bytes, { updateMetadata: false })).getForm(); } catch (e) { return; }
    for (const f of fields.values()) {
      if (f.kind !== 'radio') continue;
      let rg; try { rg = form.getRadioGroup(f.name); } catch (e) { continue; }
      const opts = rg.getOptions(), ws = rg.acroField.getWidgets(), map = {};
      ws.forEach((w, i) => { const on = w.getOnValue(); if (on && opts[i] != null) map[on.decodeText()] = opts[i]; });
      f.widgets.forEach((w) => { if (map[w.on] != null) w.on = map[w.on]; });
      if (f.value && map[f.value] != null) f.value = map[f.value];
      else { const sel = rg.getSelected(); f.value = sel || ''; }
    }
  }
  const SELF = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : '';
  const BASE = SELF ? SELF.replace(/js\/tools\/forms\.js.*$/, '') : '';
  function ensureFontkit() { return root.fontkit ? Promise.resolve() : new Promise((res, rej) => { const t = document.createElement('script'); t.src = BASE + 'vendor/fontkit.umd.min.js'; t.onload = res; t.onerror = rej; document.head.append(t); }); }
  /** True if the file carries a real digital signature (a /Sig field with a value) or a DocMDP certification.
   *  pdf-lib rewrites the whole file on save, so any change breaks those. */
  function isSigned(libDoc) {
    try {
      const N = (n) => L().PDFName.of(n);
      // /Perms /UR3 (Reader usage rights, common on government forms) is not a signature anyone cares about; DocMDP is
      const perms = libDoc.catalog.lookup(N('Perms')); if (perms && perms.get && perms.get(N('DocMDP'))) return true;
      return libDoc.getForm().getFields().some((f) => { const d = f.acroField.dict, ft = d.get(N('FT')); return ft && String(ft) === '/Sig' && !!d.get(N('V')); });
    } catch (e) { return false; }
  }
  function pdfjsLibRect(r) { return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]; }
  function initial(a) {
    if (a.fieldType === 'Btn') return a.checkBox ? (a.fieldValue && a.fieldValue !== 'Off' && a.fieldValue === a.exportValue) : (a.fieldValue && a.fieldValue !== 'Off' ? a.fieldValue : '');
    if (a.fieldType === 'Ch') return Array.isArray(a.fieldValue) ? (a.multiSelect ? a.fieldValue : a.fieldValue[0] || '') : (a.fieldValue || '');
    return a.fieldValue == null ? '' : String(a.fieldValue);
  }

  /* ---------- write: put the answers into the real PDF form ---------- */
  /** values: { name: string | boolean | string[] }. Returns { bytes, filled, skipped:[names] }. */
  async function fillPdf(bytes, values, opt) {
    opt = opt || {};
    const doc = await L().PDFDocument.load(bytes, { updateMetadata: false }), form = doc.getForm(), skipped = []; let filled = 0;
    let font = null;
    for (const [name, val] of Object.entries(values)) {
      let f; try { f = form.getField(name); } catch (e) { skipped.push(name); continue; }
      try {
        if (f instanceof L().PDFTextField) { const s = String(val ?? ''); const ml = f.getMaxLength(); f.setText(ml ? s.slice(0, ml) : s); }
        else if (f instanceof L().PDFCheckBox) { val ? f.check() : f.uncheck(); }
        else if (f instanceof L().PDFRadioGroup) { if (val) f.select(String(val)); else f.clear(); }
        else if (f instanceof L().PDFDropdown) { if (val === '' || val == null) f.clear(); else { const o = f.getOptions(); if (!o.includes(String(val))) { if (f.isEditable && f.isEditable()) f.select(String(val), true); else { skipped.push(name); continue; } } else f.select(String(val)); } }
        else if (f instanceof L().PDFOptionList) { const arr = (Array.isArray(val) ? val : [val]).filter((x) => x !== '' && x != null).map(String); if (arr.length) f.select(arr.length > 1 ? arr : arr[0]); else f.clear(); }
        else { skipped.push(name); continue; }
        filled++;
      } catch (e) { skipped.push(name); }
    }
    // Non-Latin answers (Hindi, ₹ etc.) need a real font in the appearance; fall back gracefully.
    try { form.updateFieldAppearances(); }
    catch (e) {
      const fb = opt.fontBytes || (opt.loadFont ? await opt.loadFont().catch(() => null) : null);
      const bad = 'Some answers use letters Pdfroo can’t write into this form yet (for example Hindi or other Indian scripts). English, ₹, € and most European letters work.';
      if (fb && !root.fontkit && typeof document !== 'undefined') await ensureFontkit().catch(() => {});
      if (!fb || !root.fontkit) throw new Error(bad);
      doc.registerFontkit(root.fontkit); font = await doc.embedFont(fb, { subset: false });
      // fontkit quietly draws empty boxes for letters the font lacks; refuse instead of saving blanks
      const have = new Set(font.getCharacterSet()), texts = Object.values(values).flat().filter((x) => typeof x === 'string');
      if (texts.some((t) => [...t].some((ch) => ch > ' ' && !have.has(ch.codePointAt(0))))) throw new Error(bad);
      try { form.updateFieldAppearances(font); } catch (e2) { throw new Error(bad); }
    }
    if (opt.flatten) form.flatten();
    return { bytes: await doc.save({ useObjectStreams: true, updateFieldAppearances: false }), filled, skipped, usedFont: !!font };
  }
  /** For tests: read back every field's value with pdf-lib. */
  async function readBack(bytes) {
    const form = (await L().PDFDocument.load(bytes)).getForm(), out = {};
    for (const f of form.getFields()) {
      const n = f.getName();
      if (f instanceof L().PDFTextField) out[n] = f.getText() || '';
      else if (f instanceof L().PDFCheckBox) out[n] = f.isChecked();
      else if (f instanceof L().PDFRadioGroup) out[n] = f.getSelected() || '';
      else if (f instanceof L().PDFDropdown) out[n] = (f.getSelected() || [])[0] || '';
      else if (f instanceof L().PDFOptionList) out[n] = f.getSelected() || [];
    }
    return out;
  }
  function baseName(name) { return String(name || 'form').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_') || 'form'; }

  root.PdfrooForms = { readFields, mapRadios, isSigned, fillPdf, readBack, baseName };
  if (typeof document === 'undefined') return;

  /* ---------- UI: full-screen filler, fields drawn on top of the real pages ---------- */
  const el = (t, a, ...kids) => { const n = document.createElement(t); for (const k in a || {}) { if (k.startsWith('on')) n.addEventListener(k.slice(2), a[k]); else if (a[k] !== false && a[k] != null) n.setAttribute(k, a[k] === true ? '' : a[k]); } kids.flat().forEach((c) => c != null && n.append(c)); return n; };
  // resolves with the file, or null if the picker is cancelled (so nothing is left waiting)
  function pick() { return new Promise((res) => { const i = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true }); const done = (f) => { res(f || null); i.remove(); }; i.addEventListener('change', () => done(i.files[0])); i.addEventListener('cancel', () => done(null)); document.body.append(i); i.click(); }); }
  function save(data, name) { const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' })), a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }

  const FONT_URL = BASE + 'vendor/fonts/FolioNotoSans-Regular.ttf';
  const loadFont = async () => {
    return new Uint8Array(await (await fetch(FONT_URL)).arrayBuffer());
  };
  let shell = null;
  function close() { if (shell) { shell.remove(); shell = null; document.documentElement.classList.remove('ff-lock'); } }

  async function openFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let pdf;
    try { pdf = await root.pdfjsLib.getDocument({ data: bytes.slice(0), cMapUrl: BASE + 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'vendor/pdfjs/standard_fonts/', isEvalSupported: false }).promise; }
    catch (e) { return notice(/password/i.test(e.name + e.message) ? 'This PDF is password-protected, so its form can’t be filled here.' : 'This file doesn’t look like a PDF Pdfroo can read.'); }
    const { pages, fields } = await readFields(pdf);
    await mapRadios(bytes, fields);
    if (!fields.size) { await pdf.destroy(); return notice('This PDF has no fillable fields. To type on it anyway, open it in the editor and use Text.'); }
    let signed = false;
    try { signed = isSigned(await L().PDFDocument.load(bytes, { updateMetadata: false })); } catch (e) { await pdf.destroy(); return notice('This form is locked against changes, so it can’t be filled here.'); }

    const vals = {}; fields.forEach((f, n) => { vals[n] = f.value; });
    const order = [...fields.values()].filter((f) => !f.readOnly);
    const status = el('span', { class: 'ff-count', role: 'status', 'aria-live': 'polite' });
    const flat = el('input', { type: 'checkbox', id: 'ffFlat' });
    const msg = el('p', { class: 'ff-msg', role: 'status' });
    const filledCount = () => order.filter((f) => { const v = vals[f.name]; return Array.isArray(v) ? v.length : v === true || (typeof v === 'string' && v.trim() !== ''); }).length;
    const upd = () => { status.textContent = filledCount() + ' of ' + order.length + ' filled'; };
    const inputs = new Map(); // name -> [elements]
    let cur = -1;
    const focusField = (i) => { if (!order.length) return; cur = (i + order.length) % order.length; const e = (inputs.get(order[cur].name) || [])[0]; if (e) { e.scrollIntoView({ block: 'center' }); e.focus({ preventScroll: true }); } };
    let armed = !signed;
    const download = el('button', { type: 'button', class: 'btn btn-primary ff-dl', onclick: async () => {
      if (!armed) { armed = true; download.textContent = 'Download anyway'; download.classList.add('ff-danger'); msg.className = 'ff-msg warn'; msg.textContent = 'Saving will break the digital signature on this PDF. Tap “Download anyway” to go ahead.'; return; }
      download.disabled = true; msg.className = 'ff-msg'; msg.textContent = 'Saving…';
      try {
        const r = await fillPdf(bytes, vals, { flatten: flat.checked, loadFont: loadFont });
        save(r.bytes, baseName(file.name) + (flat.checked ? '-filled-locked' : '-filled') + '.pdf');
        msg.textContent = 'Downloaded' + (flat.checked ? ', answers locked in.' : '. It’s still a fillable form.') + (r.skipped.length ? ' ' + r.skipped.length + ' field(s) couldn’t be saved: ' + r.skipped.slice(0, 3).join(', ') : '');
      } catch (e) { msg.className = 'ff-msg bad'; msg.textContent = e.message || String(e); }
      finally { download.disabled = false; }
    } }, 'Download');
    const bar = el('div', { class: 'ff-bar' },
      el('button', { type: 'button', class: 'icon-btn ff-x', 'aria-label': 'Close form', onclick: () => { pdf.destroy(); close(); } }, '✕'),
      el('div', { class: 'ff-title' }, el('b', null, file.name), status),
      el('button', { type: 'button', class: 'btn ff-nav', onclick: () => focusField(cur - 1), 'aria-label': 'Previous field' }, '‹ Prev'),
      el('button', { type: 'button', class: 'btn ff-nav', onclick: () => focusField(cur + 1), 'aria-label': 'Next field' }, 'Next ›'),
      el('label', { class: 'ff-flat', for: 'ffFlat', title: 'Turns the answers into plain page content, so they can’t be changed' }, flat, ' Lock answers'),
      download);
    const scroller = el('div', { class: 'ff-pages' });
    const sig = signed ? el('p', { class: 'ff-sig', role: 'note' }, 'This PDF is digitally signed. You can fill it in, but saving your answers will break the signature, so the person who signed it may need to sign again.') : null;
    close(); shell = el('div', { class: 'ff-shell', role: 'dialog', 'aria-label': 'Fill in form' }, bar, sig, scroller, msg);
    document.body.append(shell); document.documentElement.classList.add('ff-lock');

    const set = (name, v) => { vals[name] = v; (inputs.get(name) || []).forEach((e) => syncEl(e, v)); upd(); };
    const syncEl = (e, v) => {
      if (e.type === 'checkbox') e.checked = !!v;
      else if (e.type === 'radio') e.checked = e.value === v;
      else if (e.multiple) [...e.options].forEach((o) => { o.selected = (v || []).includes(o.value); });
      else if (e.value !== v) e.value = v ?? '';
    };
    for (let p = 0; p < pages.length; p++) {
      const P = pages[p], wrap = el('div', { class: 'ff-page', 'data-page': p + 1 }), cv = el('canvas', { 'aria-hidden': 'true' }), layer = el('div', { class: 'ff-layer' });
      wrap.append(cv, layer); scroller.append(wrap);
      wrap.style.aspectRatio = P.w + ' / ' + P.h;
      for (const w of P.widgets) {
        const f = fields.get(w.name), pct = (a, b) => (a / b * 100) + '%';
        const box = { left: pct(w.x, P.w), top: pct(w.y, P.h), width: pct(w.w, P.w), height: pct(w.h, P.h) };
        let e;
        const label = (w.tip && w.tip.trim().slice(0, 80)) || w.name.replace(/[_.\[\]0-9]+/g, ' ').trim() || 'Field';
        if (w.kind === 'text') e = el('input', { type: 'text', maxlength: w.maxLen || null, 'aria-label': label, autocomplete: 'off' });
        else if (w.kind === 'textarea') e = el('textarea', { 'aria-label': label, maxlength: w.maxLen || null });
        else if (w.kind === 'checkbox') e = el('input', { type: 'checkbox', 'aria-label': label });
        else if (w.kind === 'radio') e = el('input', { type: 'radio', name: 'ff_' + w.name, value: w.on, 'aria-label': label + ' ' + w.on });
        else { e = el('select', { 'aria-label': label, multiple: w.kind === 'list' && w.multi }); if (w.kind === 'select') e.append(el('option', { value: '' }, '')); w.options.forEach((o) => e.append(el('option', { value: o.v }, o.t || o.v))); }
        e.classList.add('ff-f', 'ff-' + w.kind); Object.assign(e.style, box);
        if (w.h > 0) e.style.setProperty('--fs', Math.max(8, Math.min(w.h * 0.62, 14)) + 'px');
        if (f.readOnly) e.disabled = true;
        syncEl(e, vals[w.name]);
        const ev = w.kind === 'text' || w.kind === 'textarea' ? 'input' : 'change';
        e.addEventListener(ev, () => {
          if (e.type === 'checkbox') set(w.name, e.checked);
          else if (e.type === 'radio') { if (e.checked) set(w.name, e.value); }
          else if (e.multiple) set(w.name, [...e.selectedOptions].map((o) => o.value));
          else set(w.name, e.value);
        });
        e.addEventListener('focus', () => {
          cur = order.indexOf(f);
          if ((w.kind === 'text' || w.kind === 'textarea') && coarse()) { e.blur(); sheetFor(e, label, () => vals[w.name], (v) => set(w.name, v), (d) => focusField(cur + d)); }
        });
        e.addEventListener('keydown', (k) => { if (k.key === 'Enter' && e.tagName === 'INPUT') { k.preventDefault(); focusField(cur + 1); } });
        layer.append(e); if (!inputs.has(w.name)) inputs.set(w.name, []); inputs.get(w.name).push(e);
      }
      renderPage(pdf, p, cv, wrap);
    }
    upd();
  }
  /* On phones a form's boxes are tiny: edit text in a big sheet above the keyboard, with Prev / Next. */
  const coarse = () => root.matchMedia && root.matchMedia('(pointer: coarse)').matches;
  function sheetFor(e, label, getVal, setVal, step) {
    const multi = e.tagName === 'TEXTAREA';
    const box = el(multi ? 'textarea' : 'input', { class: 'ff-sheet-in', 'aria-label': label, maxlength: e.getAttribute('maxlength'), enterkeyhint: multi ? null : 'next', autocomplete: 'off' });
    box.value = getVal() || '';
    const done = (dir) => { setVal(box.value); sheet.remove(); if (dir) step(dir); };
    const sheet = el('div', { class: 'ff-sheet', role: 'group', 'aria-label': 'Editing ' + label },
      el('div', { class: 'ff-sheet-label' }, label), box,
      el('div', { class: 'ff-sheet-row' },
        el('button', { type: 'button', class: 'btn ff-nav', onclick: () => done(-1) }, '‹ Prev'),
        el('button', { type: 'button', class: 'btn ff-nav', onclick: () => done(1) }, 'Next ›'),
        el('button', { type: 'button', class: 'btn btn-primary ff-nav', onclick: () => done(0) }, 'Done')));
    box.addEventListener('input', () => setVal(box.value));
    box.addEventListener('keydown', (k) => { if (k.key === 'Enter' && !multi) { k.preventDefault(); done(1); } });
    shell.querySelectorAll('.ff-sheet').forEach((x) => x.remove());
    shell.append(sheet); box.focus();
    setTimeout(() => e.scrollIntoView({ block: 'center' }), 50);
    return sheet;
  }
  async function renderPage(pdf, p, cv, wrap) {
    const pg = await pdf.getPage(p + 1), w = Math.max(320, wrap.clientWidth || 800), vp1 = pg.getViewport({ scale: 1 });
    const scale = Math.min(3, (w * (root.devicePixelRatio || 1)) / vp1.width), vp = pg.getViewport({ scale });
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const AM = root.pdfjsLib.AnnotationMode;
    // draw the page without the form's own field boxes; our live fields sit on top
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp, annotationMode: AM ? AM.DISABLE : undefined }).promise;
  }
  function notice(text) {
    close(); shell = el('div', { class: 'ff-shell ff-notice', role: 'dialog', 'aria-label': 'Fill in form' },
      el('div', { class: 'ff-bar' }, el('button', { type: 'button', class: 'icon-btn ff-x', 'aria-label': 'Close', onclick: close }, '✕'), el('div', { class: 'ff-title' }, el('b', null, 'Fill in a form'))),
      el('p', { class: 'ff-msg bad' }, text));
    document.body.append(shell);
  }
  async function flow() { const f = await pick(); if (f) await openFile(f); }
  root.PdfrooForms.open = openFile;
  const init = () => { const b = document.getElementById('landingFormBtn'); if (b) b.addEventListener('click', () => flow().catch((e) => { console.error(e); notice(e.message || String(e)); })); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
