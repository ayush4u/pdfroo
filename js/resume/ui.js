/* Pdfroo Resume Rebuild: UI (home option, "looks like a resume" card, check screen, rebuild editor, recruiter check). MIT. */
(function (root) {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const M = root.ResumeModel, X = root.ResumeExtract, RR = root.ResumeRender;
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const k in attrs || {}) { const v = attrs[k]; if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'text') el.textContent = v; else el.setAttribute(k, v === true ? '' : v); }
    for (const c of kids.flat()) if (c != null && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  };
  const S = { R: null, photo: null, conf: {}, src: null, srcBytes: null, srcName: '', screen: null, tab: 'form', thumbs: {}, built: null };
  const toast = (m, kind) => { if (root.PdfrooApp && root.PdfrooApp.toast) root.PdfrooApp.toast(m, kind); };
  const isPhone = () => matchMedia('(max-width: 760px)').matches;

  /* ---------- shell ---------- */
  let view;
  function ensureView() {
    if (view) return view;
    view = h('div', { id: 'rzView', class: 'rz', hidden: true, role: 'region', 'aria-label': 'Resume' },
      h('header', { class: 'rz-top' },
        h('button', { class: 'rz-logo', type: 'button', 'aria-label': 'Back to Pdfroo home', onclick: closeView }, h('img', { src: 'assets/roo-head.svg', alt: '', width: 28, height: 34 }), h('span', null, 'Pdfroo')),
        h('div', { class: 'rz-ticks' }, h('span', null, '✓ Free'), h('span', null, '✓ No sign-up'), h('span', null, '✓ No watermark'), h('span', null, '✓ Stays on your device'))),
      h('main', { class: 'rz-main', id: 'rzMain' }));
    document.body.appendChild(view);
    return view;
  }
  function show(screen) {
    ensureView(); view.hidden = false; document.body.classList.add('rz-open'); S.screen = screen;
    const main = $('#rzMain'); main.innerHTML = ''; main.className = 'rz-main rz-s-' + screen; window.scrollTo(0, 0); return main;
  }
  function closeView() { if (view) view.hidden = true; document.body.classList.remove('rz-open'); S.screen = null; }

  /* ---------- home chooser ---------- */
  function openChooser() {
    const saved = M.load();
    const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true, onchange: () => { const f = input.files[0]; input.value = ''; if (f) { close(); fromFile(f); } } });
    const drop = h('div', { class: 'rz-drop', role: 'button', tabindex: '0', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
      h('div', { class: 'rz-drop-ic' }, '📄'), h('strong', null, 'Drop your old resume here'), h('span', null, 'or tap to upload a PDF · read on your device'));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) { close(); fromFile(f); } });
    const dlg = h('div', { class: 'rz-scrim', id: 'rzChooser', onclick: (e) => { if (e.target === dlg) close(); } },
      h('div', { class: 'rz-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rzChooserT' },
        h('span', { class: 'rz-chip' }, 'Resume · free'),
        h('h2', { id: 'rzChooserT' }, 'Make a clean, ATS-friendly resume'),
        h('p', { class: 'rz-sub' }, 'Bring your old resume and we’ll pour it into a fresh template, or start from a blank one.'),
        drop, input,
        h('button', { class: 'rz-option', type: 'button', onclick: () => { close(); startBlank(); } }, h('b', null, '✨ Start from scratch'), h('span', null, 'A blank template with the usual sections')),
        saved && saved.basics.name ? h('button', { class: 'rz-option', type: 'button', onclick: () => { close(); S.R = saved; S.photo = photoFromModel(saved); S.conf = {}; editorScreen(); } }, h('b', null, '↺ Continue ' + saved.basics.name + '’s resume'), h('span', null, 'Saved on this device')) : null,
        h('div', { class: 'rz-row' }, h('button', { class: 'rz-btn', type: 'button', onclick: close }, 'Cancel')),
        h('p', { class: 'rz-fine' }, '🔒︎ Read on your device. Nothing is uploaded.')));
    function close() { dlg.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc);
    document.body.appendChild(dlg); drop.focus();
  }
  function startBlank() { S.R = M.blank(); S.photo = null; S.lowAll = false; S.conf = {}; S.srcBytes = null; editorScreen(); }
  async function fromFile(f) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    await fromBytes(bytes, f.name);
  }
  async function fromBytes(bytes, name, src) {
    const A = root.PdfrooApp; A && A.busy(true, 'Reading your resume…');
    try {
      if (src == null) { const res = await root.PdfEngine.load(bytes.slice(0), name); src = res.src; }
      const out = await X.extract(src, bytes, { onStatus: (m) => { if (A && m && m.status) A.busy(true, 'Reading a scanned resume… ' + (m.progress ? Math.round(m.progress * 100) + '%' : '')); } });
      if (out.refusal) { toast(out.message, 'error'); return; }
      if (out.nSections < 3) { notResume(bytes, name, out); return; }
      take(out, bytes, name);
      checkScreen();
    } catch (e) {
      const msg = /password|encrypt/i.test(e.message || '') ? 'This PDF is password-protected — this doesn’t look like a resume we can read. Edit it as a PDF instead.' : (e.message || 'Could not read this PDF');
      toast(msg, 'error');
    } finally { A && A.busy(false); }
  }
  function notResume(bytes, name, out) {
    const card = h('div', { class: 'rz-scrim' }, h('div', { class: 'rz-dialog' },
      h('h2', null, 'This doesn’t look like a resume'), h('p', { class: 'rz-sub' }, 'We found ' + out.nSections + ' resume section' + (out.nSections === 1 ? '' : 's') + '. You can edit it as a PDF instead, or still try a rebuild.'),
      h('div', { class: 'rz-row' },
        h('button', { class: 'rz-btn', type: 'button', onclick: () => { card.remove(); take(out, bytes, name); checkScreen(); } }, 'Try anyway'),
        h('button', { class: 'rz-btn rz-primary', type: 'button', onclick: () => { card.remove(); closeView(); if (!(root.PdfrooApp.hasDoc && root.PdfrooApp.hasDoc())) root.PdfrooApp.openPdf(bytes, name); } }, 'Edit as PDF'))));
    document.body.appendChild(card);
  }
  function take(out, bytes, name) {
    S.R = out.resume; S.conf = out.conf || {}; S.lowAll = !!out.ocr; S.srcBytes = bytes; S.srcName = name;
    S.photo = out.photo ? { bytes: out.photo.bytes, type: out.photo.type } : null;
    S.R.meta.pdfroo.photoShape = S.photo ? 'round' : 'skip';
    syncPhotoToModel(); M.save(S.R);
  }
  /* photo kept in basics.image as a data: URL so the autosave keeps it */
  function syncPhotoToModel() {
    if (!S.photo) { S.R.basics.image = ''; return; }
    let s = ''; const b = S.photo.bytes; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    S.R.basics.image = 'data:' + S.photo.type + ';base64,' + btoa(s);
  }
  function photoFromModel(r) {
    const m = /^data:(image\/(?:jpeg|png));base64,(.*)$/.exec(r.basics.image || ''); if (!m) return null;
    const bin = atob(m[2]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return { bytes: u, type: m[1] };
  }

  /* ---------- "Looks like a resume" card (non-blocking) ---------- */
  async function onOpened(ev) {
    S.detected = null; const eb = $('#rzEdBtn'); if (eb) { eb.classList.remove('rz-hint'); eb.querySelector('.rz-ed-lbl').textContent = 'Rebuild as resume'; }
    const d = ev.detail || {}; if (!d.bytes || (d.pages || 1) > 2) return;
    let out; try { out = await X.extract(d.src, d.bytes, { maxPages: 2, ocr: false }); } catch (e) { return; }
    if (!out || out.refusal || out.isResume !== 'high' || out.nSections < 3) return;   // unsure: show nothing
    if (root.PdfrooApp.currentSrc && root.PdfrooApp.currentSrc() !== d.src) return;
    // non-blocking: nothing covers the page; the top-bar button turns into a "Looks like a resume" pill that opens the card
    const b = $('#rzEdBtn'); if (!b) return;
    S.detected = { out, d };
    b.classList.add('rz-hint'); b.title = 'This looks like a resume — rebuild it in a clean template';
  }
  function showCard(out, d) {
    const old = $('#rzCard'); if (old) old.remove();
    let pick = 'rebuild';
    const opt = (id, title, sub, badge) => h('button', { type: 'button', class: 'rz-choice' + (id === pick ? ' on' : ''), 'data-id': id, 'aria-pressed': String(id === pick), onclick: (e) => { pick = id; card.querySelectorAll('.rz-choice').forEach((b) => { b.classList.toggle('on', b.dataset.id === id); b.setAttribute('aria-pressed', String(b.dataset.id === id)); }); go.textContent = id === 'rebuild' ? 'Rebuild my resume →' : 'Edit as it is →'; e.currentTarget.focus(); } },
      h('b', null, title), badge ? h('span', { class: 'rz-new' }, badge) : null, h('span', null, sub));
    const go = h('button', { type: 'button', class: 'rz-btn rz-strong', onclick: () => { card.remove(); if (pick === 'rebuild') { take(out, d.bytes, d.name); checkScreen(); } } }, 'Rebuild my resume →');
    const kb = Math.max(1, Math.round(d.bytes.length / 1024));
    const card = h('div', { id: 'rzCard', class: 'rz-card', role: 'dialog', 'aria-label': 'Looks like a resume' },
      h('button', { type: 'button', class: 'rz-x', 'aria-label': 'Close', onclick: () => card.remove() }, '×'),
      h('div', { class: 'rz-card-head' }, h('div', { class: 'rz-doc' }, h('i'), h('i'), h('i')), h('div', null, h('span', { class: 'rz-chip' }, 'Looks like a resume'), h('h3', null, d.name || 'resume.pdf'), h('small', null, out.pages + ' page' + (out.pages > 1 ? 's' : '') + ' · ' + kb + ' KB'))),
      h('p', null, 'How would you like to work on it?'),
      opt('edit', '✏️ Edit as it is', 'Fix text, swap the photo, sign. Keeps the original layout.'),
      opt('rebuild', '✨ Rebuild as a fresh resume', 'We read your details and pour them into a clean, ATS-friendly template.', 'New'),
      h('div', { class: 'rz-row' }, h('button', { type: 'button', class: 'rz-btn', onclick: () => card.remove() }, 'Cancel'), go),
      h('p', { class: 'rz-fine' }, '🔒︎ Read on your device. Nothing is uploaded.'));
    document.body.appendChild(card); card.querySelector('.rz-choice.on').focus();
    const esc = (e) => { if (e.key === 'Escape') { card.remove(); document.removeEventListener('keydown', esc); } }; document.addEventListener('keydown', esc);
  }

  /* ---------- Check what we found ---------- */
  const weak = (k, v) => S.lowAll ? true : !String(v || '').trim() ? ['basics.name', 'basics.email', 'basics.phone'].includes(k) : (S.conf[k] != null && S.conf[k] < 0.6);
  function joinParts(...a) { return a.filter((x) => String(x || '').trim()).join(' · '); }
  function checkScreen() {
    const main = show('check'), R = S.R, b = R.basics, P = R.meta.pdfroo;
    const rows = [];
    const fld = (label, key, get, set, opts) => { rows.push({ label, key, get, set, opts: opts || {} }); };
    fld('Full name', 'basics.name', () => b.name, (v) => { b.name = v; }, { half: true });
    fld('Job title', 'basics.label', () => b.label, (v) => { b.label = v; }, { half: true });
    fld('Email', 'basics.email', () => b.email, (v) => { b.email = v; }, { half: true, type: 'email' });
    fld('Phone', 'basics.phone', () => b.phone, (v) => { b.phone = v; }, { half: true, type: 'tel' });
    fld('Location', 'basics.location', () => joinParts(b.location.city, b.location.region).replace(' · ', ', '), (v) => { const p = v.split(/\s*,\s*/); b.location = { city: p[0] || '', region: p.slice(1).join(', ') }; });
    if (b.summary) fld('Summary', 'basics.summary', () => b.summary, (v) => { b.summary = v; }, { area: true });
    R.work.forEach((w, i) => fld('Experience ' + (i + 1), 'work.' + i, () => joinParts(w.position, w.name, RR.range(w.startDate, w.endDate)), (v) => { const p = v.split(/\s*·\s*/); w.position = p[0] || ''; w.name = p[1] || ''; }));
    R.education.forEach((e, i) => fld('Education' + (R.education.length > 1 ? ' ' + (i + 1) : ''), 'education.' + i, () => joinParts([e.studyType, e.area].filter(Boolean).join(' '), e.institution, e.score, RR.range(e.startDate, e.endDate)), (v) => { const p = v.split(/\s*·\s*/); e.studyType = p[0] || ''; e.area = ''; e.institution = p[1] || ''; if (p[2] && !/\d{4}/.test(p[2])) e.score = p[2]; }));
    fld('Skills', 'skills', () => R.skills.map((s) => s.name).join(', '), (v) => { R.skills = v.split(/\s*,\s*/).filter(Boolean).map((n) => ({ name: n })); }, { area: true });
    (P.custom || []).forEach((c, i) => fld(c.unmapped ? 'Other (we couldn’t place this)' : c.title, 'custom.' + i, () => c.text, (v) => { c.text = v; }, { area: true, forceWeak: !!c.unmapped, remove: () => { P.custom.splice(P.custom.indexOf(c), 1); M.save(S.R); checkScreen(); } }));
    const nWeak = rows.filter((r) => r.opts.forceWeak || weak(r.key, r.get())).length;
    const form = h('div', { class: 'rz-panel rz-fields' });
    for (const r of rows) {
      const w = r.opts.forceWeak || weak(r.key, r.get());
      const inp = r.opts.area ? h('textarea', { rows: 2, class: 'rz-in' }) : h('input', { class: 'rz-in', type: r.opts.type || 'text' });
      inp.value = r.get() || '';
      inp.addEventListener('input', () => { r.set(inp.value); wrap.classList.remove('weak'); M.save(S.R); });
      const id = 'rzf-' + r.key.replace(/\W/g, '-'); inp.id = id;
      const wrap = h('div', { class: 'rz-f' + (w ? ' weak' : '') + (r.opts.half ? ' half' : '') }, h('label', { for: id }, r.label, r.opts.remove ? h('button', { type: 'button', class: 'rz-x rz-x-in', 'aria-label': 'Remove section', title: 'Remove section', onclick: (e) => { e.preventDefault(); r.opts.remove(); } }, '×') : null), h('div', { class: 'rz-inwrap' }, inp, w ? h('span', { class: 'rz-check' }, 'check this') : null));
      form.appendChild(wrap);
    }
    if (P.personal || P.declaration) {
      const what = [P.personal && 'Personal details', P.declaration && 'Declaration'].filter(Boolean).join(' & ');
      const note = h('div', { class: 'rz-note' }, h('span', null, h('b', null, '“' + what + '”'), ' found. Keep it? ', h('small', null, 'Recruiters’ software doesn’t need it.')),
        h('button', { type: 'button', class: 'rz-link' + (!P.keepPersonal ? ' on' : ''), onclick: (e) => { P.keepPersonal = P.keepDeclaration = false; M.save(S.R); mark(e); } }, 'Remove'),
        h('button', { type: 'button', class: 'rz-link' + (P.keepPersonal ? ' on' : ''), onclick: (e) => { P.keepPersonal = !!P.personal; P.keepDeclaration = !!P.declaration; M.save(S.R); mark(e); } }, 'Keep'));
      const mark = (e) => { note.querySelectorAll('.rz-link').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); };
      form.appendChild(note);
    }
    if (S.photo) form.appendChild(h('div', { class: 'rz-f' }, h('label', null, 'Photo'), h('div', { class: 'rz-photo-row' }, photoEl('round'), h('span', { class: 'rz-muted' }, 'Taken from your PDF at full quality. You can crop or skip it next.'))));
    form.appendChild(h('div', { class: 'rz-row rz-foot' }, h('span', { class: 'rz-muted' }, 'You can edit everything later'), h('button', { type: 'button', class: 'rz-btn rz-strong', id: 'rzContinue', onclick: editorScreen }, 'Continue →')));
    const orig = h('div', { class: 'rz-orig', 'aria-label': 'Your original PDF' });
    main.append(h('div', { class: 'rz-wrap' },
      h('span', { class: 'rz-chip' }, 'Step 1 of 2'), h('h1', null, 'Check what we found'),
      S.lowAll ? h('p', { class: 'rz-note' }, 'This PDF is a scan, so we read it with text recognition. Every field is low confidence — please check each one.') : null,
      h('p', { class: 'rz-sub' }, 'We filled these in from your PDF. ', nWeak ? h('b', { class: 'rz-amb' }, nWeak + ' field' + (nWeak > 1 ? 's' : '')) : 'All fields', nWeak ? (nWeak > 1 ? ' in amber need a quick look.' : ' in amber needs a quick look.') : ' look fine.'),
      h('div', { class: 'rz-checkgrid' }, orig, form)));
    if (S.srcBytes) renderPdfInto(S.srcBytes, orig, 1, 1.4).catch(() => {});
  }
  function photoEl(shape) {
    const el = h('div', { class: 'rz-avatar ' + (shape || 'round') });
    if (S.photo) { const url = URL.createObjectURL(new Blob([S.photo.bytes], { type: S.photo.type })); el.style.backgroundImage = 'url(' + url + ')'; el.classList.add('has'); }
    return el;
  }

  /* ---------- render a PDF (bytes) into a container with pdf.js ---------- */
  async function renderPdfInto(bytes, box, maxPages, scale, token) {
    const pdf = await root.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const cvs = [];
    for (let i = 1; i <= Math.min(pdf.numPages, maxPages || 9); i++) {
      const pg = await pdf.getPage(i), vp = pg.getViewport({ scale: scale || 1.5 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.className = 'rz-pg';
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; cvs.push(c);
    }
    await pdf.destroy();
    if (token && token !== S.renderToken) return;
    box.querySelectorAll('canvas.rz-pg').forEach((c) => c.remove());
    cvs.forEach((c) => box.appendChild(c));
  }

  /* ---------- Rebuild editor ---------- */
  let pvTimer = null;
  function schedule() { M.save(S.R); const s = $('#rzSaved'); if (s) s.textContent = '● Saved on this device'; clearTimeout(pvTimer); pvTimer = setTimeout(preview, 300); }
  /* the PDF we show, check and download: fitted to one page when "Fit to one page" is on (remembered in meta.pdfroo.fit) */
  const buildOut = (o) => (S.R.meta.pdfroo.fit ? RR.fitOnePage : RR.build)(S.R, Object.assign({ photo: S.photo }, o || {}));
  async function preview() {
    const box = $('#rzPreview'); if (!box) return;
    const tok = S.renderToken = {};
    try {
      const out = await buildOut(); if (tok !== S.renderToken) return;
      S.built = out.bytes; S.lastOut = out; renderFit(out);
      await renderPdfInto(out.bytes, box, 4, 1.6, tok);
      atsBadge(out.bytes, tok);
    } catch (e) { console.warn('Resume preview failed:', e.message); }
  }
  /* ATS score of exactly the PDF in the preview (so it follows Fit to one page) */
  async function atsBadge(bytes, tok) {
    const AT = root.ResumeATS; if (!AT) return;
    try { const r = AT.analyze(await AT.read(root.pdfjsLib, bytes), { jd: S.jd || '' }); if (tok !== S.renderToken) return; S.atsScore = r.score; document.querySelectorAll('.rz-atsw-btn').forEach((b) => { b.textContent = 'ATS check · ' + r.score; }); } catch (e) { /* badge only */ }
  }
  function renderFit(out) {
    const bar = $('#rzFit'); if (!bar) return; const P = S.R.meta.pdfroo; bar.innerHTML = '';
    const T = RR.TEMPLATES[P.template] || RR.TEMPLATES.modern;
    const n = out.pages, close = n === 2 && out.overflow > 0 && out.overflow < 0.2;
    if (!P.fit && n < 2) { bar.hidden = true; return; }
    // the button is always offered when it runs over: a long spill may still fit; if not, Fit keeps the pages and says so
    bar.hidden = false;
    const lines = Math.max(1, Math.round(out.overflow * (841.89 - 2 * T.m) / (T.body * 1.32)));
    const msg = !P.fit ? (close ? 'Spills onto page 2 by ' + (lines <= 6 ? lines + ' line' + (lines > 1 ? 's' : '') : 'a few lines') + ' –' : (n === 2 ? 'Runs onto page 2 –' : 'Runs to ' + n + ' pages –'))
      : out.fitted === 'no' ? 'Too long to fit on one page, even with tighter spacing — kept ' + n + ' pages.'
      : out.fitted === 'yes' ? 'Tightened spacing' + (out.fit && out.fit.body ? ' and text size (' + out.fit.body + 'pt)' : '') + ' to fit.' : 'Already fits on one page.';
    bar.append(h('span', { class: 'rz-fit-msg', role: 'status' }, msg),
      h('button', { type: 'button', class: 'rz-pill rz-fit-btn' + (P.fit ? ' on' : ''), id: 'rzFitBtn', 'aria-pressed': String(!!P.fit), onclick: () => { P.fit = !P.fit; schedule(); } }, (P.fit ? '✓ ' : '') + 'Fit to one page'),
      h('span', { class: 'rz-fit-n' }, n === 1 ? '1 page' : n + ' pages'));
  }
  function editorScreen() {
    const main = show('editor'); const R = S.R, P = R.meta.pdfroo;
    const formP = h('section', { class: 'rz-form', id: 'rzForm', 'aria-label': 'Form' });
    const pvP = h('section', { class: 'rz-pv', 'aria-label': 'Preview' },
      h('div', { class: 'rz-pv-top' }, h('span', { class: 'rz-chip' }, 'Live preview · A4'), h('div', { class: 'rz-pv-acts' }, h('button', { type: 'button', class: 'rz-btn rz-ghost rz-atsw-btn', id: 'rzAtsBtn', onclick: () => atswScreen() }, 'ATS check'), h('button', { type: 'button', class: 'rz-btn rz-dl hide-phone', onclick: atsScreen }, '⬇ Download PDF, free'))),
      h('div', { class: 'rz-fit', id: 'rzFit', hidden: true }),
      h('div', { class: 'rz-preview', id: 'rzPreview' }),
      h('div', { class: 'rz-strip', id: 'rzStrip', role: 'radiogroup', 'aria-label': 'Template' }),
      h('div', { class: 'rz-colors', id: 'rzColors' }));
    const tabs = h('div', { class: 'rz-tabs', role: 'tablist' },
      ['form', 'preview'].map((t) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === t), class: S.tab === t ? 'on' : '', onclick: () => { S.tab = t; grid.dataset.tab = t; tabs.querySelectorAll('button').forEach((b, i) => { const on = ['form', 'preview'][i] === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }); window.scrollTo(0, 0); } }, t === 'form' ? 'Form' : 'Preview')));
    const grid = h('div', { class: 'rz-ed', 'data-tab': S.tab }, formP, pvP);
    const sticky = h('div', { class: 'rz-sticky' }, h('button', { type: 'button', class: 'rz-btn rz-ghost rz-atsw-btn', onclick: () => atswScreen() }, 'ATS check'), h('button', { type: 'button', class: 'rz-btn rz-dl', id: 'rzDownload', onclick: atsScreen }, '⬇ Download PDF, free'), h('small', null, 'No sign-up · no watermark · stays on your device'));
    main.append(tabs, grid, sticky);
    renderForm();
    renderStrip();
    renderColors();
    preview();
  }
  function card(title, key, body, ctl) {
    return h('div', { class: 'rz-sec', 'data-key': key || '' }, h('div', { class: 'rz-sec-h' }, h('h3', null, title), ctl || null), body);
  }
  function inField(label, obj, k, o) {
    o = o || {};
    const id = 'rzi-' + Math.random().toString(36).slice(2, 8);
    const el = o.area ? h('textarea', { id, class: 'rz-in', rows: o.rows || 3, placeholder: o.ph || '' }) : h('input', { id, class: 'rz-in', type: o.type || 'text', placeholder: o.ph || '' });
    el.value = o.get ? o.get() : (obj[k] || '');
    el.addEventListener('input', () => { if (o.set) o.set(el.value); else obj[k] = el.value; schedule(); });
    return h('div', { class: 'rz-f' + (o.half ? ' half' : '') }, h('label', { for: id }, label), el);
  }
  function secCtl(key) {
    const P = S.R.meta.pdfroo, i = P.order.indexOf(key);
    const mv = (d) => { const j = i + d; if (j < 0 || j >= P.order.length) return; [P.order[i], P.order[j]] = [P.order[j], P.order[i]]; schedule(); renderForm(); };
    return h('div', { class: 'rz-ctl' },
      h('button', { type: 'button', 'aria-label': 'Move section up', title: 'Move up', onclick: () => mv(-1) }, '↑'),
      h('button', { type: 'button', 'aria-label': 'Move section down', title: 'Move down', onclick: () => mv(1) }, '↓'),
      h('button', { type: 'button', 'aria-label': 'Remove section', title: 'Remove section', onclick: () => { P.order.splice(i, 1); schedule(); renderForm(); } }, '×'));
  }
  function itemCtl(arr, i) {
    const mv = (d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; schedule(); renderForm(); };
    return h('div', { class: 'rz-ctl' }, h('button', { type: 'button', 'aria-label': 'Move up', onclick: () => mv(-1) }, '↑'), h('button', { type: 'button', 'aria-label': 'Move down', onclick: () => mv(1) }, '↓'), h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { arr.splice(i, 1); schedule(); renderForm(); } }, '×'));
  }
  function entryList(arr, mk, fields, addLabel, summary) {
    const box = h('div', { class: 'rz-entries' });
    arr.forEach((it, i) => {
      const det = h('details', { class: 'rz-entry' + (S.conf[summary.key + '.' + i] != null && S.conf[summary.key + '.' + i] < 0.6 ? ' weak' : '') },
        h('summary', null, h('span', null, h('b', null, summary.title(it) || 'New entry'), ' ', h('small', null, summary.sub(it))), itemCtl(arr, i)),
        h('div', { class: 'rz-grid2' }, fields(it)));
      box.appendChild(det);
    });
    box.appendChild(h('button', { type: 'button', class: 'rz-add', onclick: () => { arr.push(mk()); schedule(); renderForm(); const all = document.querySelectorAll('#rzForm details'); if (all.length) all[all.length - 1].open = true; } }, '+ ' + addLabel));
    return box;
  }
  const lines = (arr) => ({ get: () => (arr || []).join('\n'), area: true, rows: 3 });
  function renderForm() {
    const f = $('#rzForm'); if (!f) return; const R = S.R, b = R.basics, P = R.meta.pdfroo;
    const openKeys = [...f.querySelectorAll('details[open]')].map((d) => [...f.querySelectorAll('details')].indexOf(d));
    f.innerHTML = '';
    f.appendChild(h('div', { class: 'rz-form-h' }, h('h2', null, 'Your resume'), h('span', { id: 'rzSaved', class: 'rz-saved' }, '● Saved on this device')));
    // photo
    const fileIn = h('input', { type: 'file', accept: 'image/jpeg,image/png', hidden: true, onchange: async () => { const fl = fileIn.files[0]; if (!fl) return; S.photo = { bytes: new Uint8Array(await fl.arrayBuffer()), type: fl.type === 'image/png' ? 'image/png' : 'image/jpeg' }; if (P.photoShape === 'skip') P.photoShape = 'round'; syncPhotoToModel(); schedule(); renderForm(); } });
    const shapeBtn = (v, l) => h('button', { type: 'button', class: 'rz-pill' + (P.photoShape === v ? ' on' : ''), 'aria-pressed': String(P.photoShape === v), onclick: () => { P.photoShape = v; schedule(); renderForm(); } }, l);
    f.appendChild(card('Photo', 'photo', h('div', { class: 'rz-photo-row' }, photoEl(P.photoShape === 'square' ? 'square' : 'round'),
      h('div', null, h('div', { class: 'rz-pills' }, shapeBtn('round', '● Round'), shapeBtn('square', '■ Square'), shapeBtn('skip', 'Skip')),
        h('div', { class: 'rz-muted rz-links' }, h('button', { type: 'button', class: 'rz-link', onclick: () => fileIn.click() }, S.photo ? 'Change' : 'Add photo'), ' · ', h('button', { type: 'button', class: 'rz-link', onclick: () => { S.photo = null; syncPhotoToModel(); schedule(); renderForm(); } }, 'Remove'), ' · ', h('span', null, 'Skip for ATS'))), fileIn)));
    // contact
    f.appendChild(card('Contact', 'contact', h('div', { class: 'rz-grid2' },
      inField('Full name', b, 'name', { half: true, ph: 'Ananya Iyer' }), inField('Job title', b, 'label', { half: true, ph: 'Product Designer' }),
      inField('Email', b, 'email', { half: true, type: 'email' }), inField('Phone', b, 'phone', { half: true, type: 'tel' }),
      inField('City', b.location, 'city', { half: true }), inField('State / country', b.location, 'region', { half: true }),
      inField('Website or LinkedIn', b, 'url', { get: () => b.url || ((b.profiles || [])[0] || {}).url || '', set: (v) => { b.url = v; b.profiles = []; } }))));
    for (const k of P.order) {
      const name = M.SECTION_NAMES[k];
      if (k === 'summary') f.appendChild(card(name, k, inField('Summary', b, 'summary', { area: true, rows: 3, ph: 'Two lines about you' }), secCtl(k)));
      else if (k === 'work') f.appendChild(card(name, k, entryList(R.work, () => ({ position: '', name: '', startDate: '', endDate: '', highlights: [] }), (w) => [
        inField('Role', w, 'position', { half: true }), inField('Company', w, 'name', { half: true }),
        inField('Start (YYYY-MM)', w, 'startDate', { half: true }), inField('End (blank = Present)', w, 'endDate', { half: true }),
        inField('Bullets (one per line)', w, 'highlights', Object.assign(lines(w.highlights), { set: (v) => { w.highlights = v.split('\n'); } }))], 'Add role', { key: 'work', title: (w) => w.position, sub: (w) => [w.name, RR.range(w.startDate, w.endDate), (w.highlights || []).filter(Boolean).length + ' bullets'].filter(Boolean).join(' · ') }), secCtl(k)));
      else if (k === 'education') f.appendChild(card(name, k, entryList(R.education, () => ({ institution: '', studyType: '', area: '', score: '', startDate: '', endDate: '' }), (e) => [
        inField('Degree', e, 'studyType', { half: true }), inField('Subject', e, 'area', { half: true }), inField('College / school', e, 'institution'),
        inField('Score (CGPA / %)', e, 'score', { half: true }), inField('Year', e, 'endDate', { half: true })], 'Add education', { key: 'education', title: (e) => [e.studyType, e.area].filter(Boolean).join(' ') || e.institution, sub: (e) => [e.institution, e.score].filter(Boolean).join(' · ') }), secCtl(k)));
      else if (k === 'skills') {
        const chips = h('div', { class: 'rz-chips' }, R.skills.map((s, i) => h('span', { class: 'rz-skill' }, s.name, h('button', { type: 'button', 'aria-label': 'Remove ' + s.name, onclick: () => { R.skills.splice(i, 1); schedule(); renderForm(); } }, '×'))));
        const add = h('input', { class: 'rz-in', placeholder: 'Add a skill and press Enter', 'aria-label': 'Add a skill', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const v = add.value.trim(); if (v) { v.split(/\s*,\s*/).forEach((n) => n && R.skills.push({ name: n })); schedule(); renderForm(); setTimeout(() => { const n = document.querySelector('#rzForm [aria-label="Add a skill"]'); if (n) n.focus(); }); } } } });
        f.appendChild(card(name, k, h('div', null, chips, add), secCtl(k)));
      } else if (k === 'projects') f.appendChild(card(name, k, entryList(R.projects, () => ({ name: '', description: '', highlights: [] }), (p) => [
        inField('Project', p, 'name'), inField('Description', p, 'description', { area: true, rows: 2 }), inField('Bullets (one per line)', p, 'highlights', Object.assign(lines(p.highlights), { set: (v) => { p.highlights = v.split('\n'); } }))], 'Add project', { key: 'projects', title: (p) => p.name, sub: (p) => (p.highlights || []).filter(Boolean).length ? (p.highlights || []).filter(Boolean).length + ' bullets' : (p.description ? 'description' : '') }), secCtl(k)));
      else if (k === 'awards') f.appendChild(card(name, k, inField('One per line', null, null, { area: true, get: () => R.awards.map((a) => a.title).join('\n'), set: (v) => { R.awards = v.split('\n').map((t) => ({ title: t })); } }), secCtl(k)));
      else if (k === 'languages') f.appendChild(card(name, k, inField('Comma separated', null, null, { get: () => R.languages.map((a) => a.language).join(', '), set: (v) => { R.languages = v.split(/\s*,\s*/).filter(Boolean).map((t) => ({ language: t })); } }), secCtl(k)));
      else if (k === 'interests') f.appendChild(card(name, k, inField('Comma separated', null, null, { get: () => R.interests.map((a) => a.name).join(', '), set: (v) => { R.interests = v.split(/\s*,\s*/).filter(Boolean).map((t) => ({ name: t })); } }), secCtl(k)));
    }
    (P.custom || []).forEach((c, i) => f.appendChild(card(c.title || 'Other', 'custom', h('div', null, inField('Section name', c, 'title'), inField('Text (one bullet per line)', c, 'text', { area: true, rows: 3 })),
      h('div', { class: 'rz-ctl' }, h('button', { type: 'button', 'aria-label': 'Remove section', onclick: () => { P.custom.splice(i, 1); schedule(); renderForm(); } }, '×')))));
    if (P.personal || P.declaration) {
      const tg = (k, l) => h('label', { class: 'rz-toggle' }, h('input', { type: 'checkbox', checked: P[k] ? true : null, onchange: (e) => { P[k] = e.target.checked; schedule(); } }), ' ' + l);
      f.appendChild(card('Personal details & Declaration', 'india', h('div', null, P.personal ? tg('keepPersonal', 'Include Personal details') : null, P.declaration ? tg('keepDeclaration', 'Include Declaration') : null, h('p', { class: 'rz-muted' }, 'Off by default: recruiters’ software doesn’t need your date of birth, father’s name or a declaration.'))));
    }
    const hidden = M.DEFAULT_ORDER.filter((k) => !P.order.includes(k));
    const sel = h('select', { class: 'rz-in', 'aria-label': 'Add a section', onchange: () => { const v = sel.value; if (!v) return; if (v === 'custom') P.custom.push({ title: 'Additional Information', text: '' }); else P.order.push(v); schedule(); renderForm(); } },
      h('option', { value: '' }, '+ Add a section…'), hidden.map((k) => h('option', { value: k }, M.SECTION_NAMES[k])), h('option', { value: 'custom' }, 'Custom section'));
    f.appendChild(h('div', { class: 'rz-sec rz-addsec' }, sel));
    const ds = [...f.querySelectorAll('details')]; openKeys.forEach((i) => { if (ds[i]) ds[i].open = true; });
  }
  let stripTimer = null;
  function renderColors() {
    const box = $('#rzColors'); if (!box) return; const P = S.R.meta.pdfroo; box.innerHTML = '';
    const cur = (P.accent || '').toLowerCase();
    const set = (hex) => { P.accent = hex; schedule(); renderColors(); clearTimeout(stripTimer); stripTimer = setTimeout(renderStrip, 400); };
    const row = h('div', { class: 'rz-sw-row', role: 'radiogroup', 'aria-label': 'Accent colour' },
      RR.ACCENTS.map(([n, hex]) => { const on = cur === hex || (!cur && hex === '#a85a1f'); return h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-label': n, title: n, class: 'rz-sw' + (on ? ' on' : ''), style: 'background:' + hex, onclick: () => set(hex) }); }),
      h('label', { class: 'rz-sw rz-sw-custom' + (cur && !RR.ACCENTS.some((x) => x[1] === cur) ? ' on' : ''), title: 'Custom colour' }, h('span', { 'aria-hidden': 'true' }, '+'),
        h('input', { type: 'color', 'aria-label': 'Custom accent colour', value: cur || '#a85a1f', onchange: (e) => set(e.target.value.toLowerCase()) })));
    const A = cur ? RR.safeAccent(cur) : null;
    box.append(h('span', { class: 'rz-sw-lbl' }, 'Accent'), row);
    if (A && A.darkened) box.append(h('small', { class: 'rz-sw-note', role: 'status' }, 'Darkened to ' + A.hex + ' so text stays readable (4.5:1).'));
  }
  async function renderStrip() {
    const st = $('#rzStrip'); if (!st) return; st.innerHTML = '';
    for (const id of Object.keys(RR.TEMPLATES)) {
      const on = S.R.meta.pdfroo.template === id;
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: 'rz-tpl' + (on ? ' on' : ''), 'data-tpl': id, onclick: () => { S.R.meta.pdfroo.template = id; st.querySelectorAll('.rz-tpl').forEach((x) => { const o = x.dataset.tpl === id; x.classList.toggle('on', o); x.setAttribute('aria-checked', String(o)); }); schedule(); } },
        h('div', { class: 'rz-thumb' }), h('span', null, RR.TEMPLATES[id].label), RR.TEMPLATES[id].ats === false ? h('em', { class: 'rz-tpl-ats bad', title: RR.TEMPLATES[id].atsNote }, 'Not ATS-safe') : h('em', { class: 'rz-tpl-ats' }, 'ATS-safe'));
      st.appendChild(b);
      RR.build(S.R, { template: id, photo: S.photo }).then((o) => renderPdfInto(o.bytes, b.firstChild, 1, 0.35)).catch(() => {});
    }
  }

  /* ---------- See what recruiters' software sees ---------- */
  async function atsScreen() {
    const A = root.PdfrooApp; A && A.busy(true, 'Making your PDF…');
    let out, chk;
    try { out = await buildOut(); chk = await RR.atsCheck(out.bytes, S.R, out.order); }
    catch (e) { toast('Could not make the PDF: ' + e.message, 'error'); return; }
    finally { A && A.busy(false); }
    const main = show('ats'); const ok = chk.checks.every((c) => c.ok);
    const pv = h('div', { class: 'rz-orig rz-out' });
    main.append(h('div', { class: 'rz-wrap' },
      h('span', { class: 'rz-chip' }, 'Before you download'), h('h1', null, 'See what recruiters’ software sees'),
      h('p', { class: 'rz-sub' }, 'This is the plain text an ATS pulls from your PDF, in reading order.'),
      h('div', { class: 'rz-atsgrid' }, pv,
        h('pre', { class: 'rz-panel rz-text', id: 'rzAtsText', tabindex: '0', 'aria-label': 'Extracted text' }, chk.text),
        h('div', { class: 'rz-panel rz-checks' },
          h('h3', null, ok ? 'All ' + chk.checks.length + ' checks passed' : chk.checks.filter((c) => c.ok).length + ' of ' + chk.checks.length + ' checks passed'),
          h('ul', null, chk.checks.map((c) => h('li', { class: c.ok ? 'ok' : 'bad' }, h('i', null, c.ok ? '✓' : '!'), c.label))),
          ok ? null : h('p', { class: 'rz-warn' }, 'Something is missing or out of order — go back and check the fields marked above, or download anyway.'),
          h('button', { type: 'button', class: 'rz-btn rz-dl', id: 'rzSave', onclick: () => saveFile(out.bytes) }, ok ? 'Looks good, download ⬇' : 'Download anyway ⬇'),
          h('button', { type: 'button', class: 'rz-link rz-back', onclick: editorScreen }, '← Back to editing'))),
      h('p', { class: 'rz-fine' }, 'Free · no sign-up · no watermark · stays on your device')));
    renderPdfInto(out.bytes, pv, 1, 1.2).catch(() => {});
  }

  /* ---------- ATS check (Workday-style parsing), all on this device ---------- */
  async function atswScreen(which, jd) {
    const A = root.PdfrooApp, AT = root.ResumeATS; which = which || 'built'; if (jd == null) jd = S.jd || ''; S.jd = jd;
    A && A.busy(true, 'Reading it like an ATS…');
    let bytes, r, tpl = RR.TEMPLATES[S.R.meta.pdfroo.template] || RR.TEMPLATES.modern;
    try { bytes = which === 'orig' && S.srcBytes ? S.srcBytes : (await buildOut()).bytes; r = AT.analyze(await AT.read(root.pdfjsLib, bytes), { jd }); }
    catch (e) { toast('Could not read the PDF: ' + e.message, 'error'); return; }
    finally { A && A.busy(false); }
    const main = show('atsw'), lv = { high: 'High', med: 'Medium', low: 'Low' };
    const seg = (id, label) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(which === id), class: 'rz-seg' + (which === id ? ' on' : ''), onclick: () => atswScreen(id, S.jd) }, label);
    const ta = h('textarea', { class: 'rz-in rz-jd', id: 'rzJd', rows: '5', placeholder: 'Paste a job description to match its keywords (stays on your device). Leave empty to use the default list.', 'aria-label': 'Job description' });
    ta.value = jd;
    const band = r.score >= 75 ? 'good' : r.score >= 50 ? 'ok' : 'low';
    main.append(h('div', { class: 'rz-wrap rz-atsw' },
      h('span', { class: 'rz-chip' }, 'ATS check · Workday-style'), h('h1', null, 'How an ATS parser reads your resume'),
      h('p', { class: 'rz-sub' }, 'Checked on your device — nothing is uploaded.'),
      h('div', { class: 'rz-atsw-bar' },
        h('div', { class: 'rz-segs', role: 'radiogroup', 'aria-label': 'Which PDF' }, seg('built', 'Rebuilt PDF · ' + tpl.label), S.srcBytes ? seg('orig', 'Original PDF') : null),
        which === 'built' ? h('span', { class: 'rz-tpl-ats big' + (tpl.ats === false ? ' bad' : ''), title: tpl.atsNote || '' }, tpl.ats === false ? 'Not ATS-safe template' : 'ATS-safe template') : null),
      which === 'built' && tpl.ats === false ? h('p', { class: 'rz-warn' }, tpl.atsNote) : null,
      h('div', { class: 'rz-atsw-grid' },
        h('section', { class: 'rz-panel rz-atsw-score', 'aria-label': 'Score' },
          h('div', { class: 'rz-score ' + band }, h('b', null, String(r.score)), h('small', null, '/100')),
          h('p', { class: 'rz-explain' }, r.explain),
          h('h3', null, 'Keywords (' + r.keywords.source + ')'),
          h('div', { class: 'rz-kw' }, r.keywords.found.map((k) => h('span', { class: 'rz-kwc ok' }, '✓ ' + k)), r.keywords.missing.map((k) => h('span', { class: 'rz-kwc miss' }, '✗ ' + k))),
          ta, h('button', { type: 'button', class: 'rz-btn rz-strong', id: 'rzJdGo', onclick: () => atswScreen(which, ta.value) }, 'Match keywords')),
        h('section', { class: 'rz-panel rz-atsw-risks', 'aria-label': 'Parser risks' },
          h('h3', null, r.risks.length ? r.risks.length + ' parser risk' + (r.risks.length > 1 ? 's' : '') : 'No parser risks found'),
          h('ul', null, r.risks.map((k) => h('li', { class: 'rz-risk ' + k.level }, h('span', { class: 'rz-lv' }, lv[k.level]), h('div', null, h('b', null, k.label), h('p', null, k.detail), k.examples.length ? h('ul', { class: 'rz-ex' }, k.examples.map((e) => h('li', null, e.slice(0, 140)))) : null))))),
        h('section', { class: 'rz-panel rz-atsw-text', 'aria-label': 'Parser text' },
          h('h3', null, 'Plain text, in the order a parser reads it'),
          h('pre', { class: 'rz-text', tabindex: '0' }, r.text))),
      h('div', { class: 'rz-atsw-foot' }, h('button', { type: 'button', class: 'rz-btn rz-ghost', onclick: editorScreen }, '← Back to editing'), h('button', { type: 'button', class: 'rz-btn rz-dl', onclick: atsScreen }, '⬇ Download PDF, free'))));
    return r;
  }
  function saveFile(bytes) {
    const name = ((S.R.basics.name || 'My').trim().replace(/[^\w\u0900-\u0D7F]+/g, '_') || 'My') + '_Resume.pdf';
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Saved ' + name, 'ok');
  }

  function docIcon() {   // inline SVG document icon, 16 px, stroke = currentColor
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'rz-ed-ic' })) svg.setAttribute(k, v);
    for (const d of ['M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8']) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); }
    return svg;
  }
  /* ---------- wiring ---------- */
  function init() {
    const ctas = $('.roo-ctas');
    if (ctas && !$('#rzHomeBtn')) {
      const btn = h('button', { id: 'rzHomeBtn', class: 'roo-pill rz-home-btn', type: 'button', onclick: openChooser }, '📄 Resume', h('span', { class: 'rz-new' }, 'New'));
      ctas.insertBefore(btn, ctas.children[1] || null);
    }
    const acts = $('.ed-top-actions');
    if (acts && !$('#rzEdBtn')) {
      const b = h('button', { id: 'rzEdBtn', class: 'icon-btn rz-ed-btn', type: 'button', 'aria-label': 'Rebuild as resume', title: 'Rebuild as resume — pour this PDF into a clean resume template', onclick: () => {
        const A = root.PdfrooApp, src = A.currentSrc && A.currentSrc(); const bytes = src != null && root.PdfEngine.getSourceBytes(src);
        if (S.detected && S.detected.d.src === src) { showCard(S.detected.out, S.detected.d); return; }
        if (bytes) fromBytes(new Uint8Array(bytes), A.docName ? A.docName() : 'resume.pdf', src);
      } }, docIcon(), h('span', { class: 'rz-ed-lbl' }, 'Rebuild as resume'), h('span', { class: 'rz-ed-short' }, 'Resume'));
      acts.insertBefore(b, acts.firstChild);
    }
    document.addEventListener('pdfroo:opened', onOpened);
    addEventListener('popstate', () => { if (S.screen) closeView(); });
  }
  root.ResumeUI = { openChooser, fromBytes, startBlank, checkScreen, editorScreen, atsScreen, atswScreen, state: S, showCard };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
