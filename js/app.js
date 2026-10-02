/* ==========================================================================
   Pdfroo — UI layer. Talks to the PDF engine ONLY through window.PdfEngine.
   All document data lives in `doc` (plain JSON-serializable object).
   ========================================================================== */
(function () {
  'use strict';
  const E = window.PdfEngine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const SVGNS = 'http://www.w3.org/2000/svg';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isPhone = () => window.matchMedia('(max-width: 640px)').matches;
  const isOverlayPanel = () => window.matchMedia('(max-width: 1023px)').matches;

  /* ---------------- State ---------------- */
  let doc = null;                 // serializable document state (see pdfEngine.js)
  const ui = {
    current: 0, zoom: 1, fit: true, tool: 'select', selectedId: null,
    history: [], future: [], dirty: false,
    drag: null, editing: null, liveSnap: null, lastTap: null, pinch: null,
    styles: {
      text: { color: '#111827', size: 16, bold: false },
      pen: { color: '#2563eb', width: 3 },
      highlight: { color: '#facc15', width: 14 },
      shape: { color: '#e11d48', width: 3 },
    },
    lastSignature: null,
  };
  const PALETTE = ['#111827', '#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#7c3aed'];
  const HL_PALETTE = ['#facc15', '#4ade80', '#f472b6', '#60a5fa', '#fb923c'];
  const SIG_COLORS = ['#111827', '#1e3a8a', '#2563eb'];

  /* ---------------- DOM ---------------- */
  const landing = $('#landing'), editor = $('#editor');
  const viewport = $('#viewport'), stage = $('#stage'), pageWrap = $('#pageWrap'), overlay = $('#overlay');
  const thumbList = $('#thumbList'), propbar = $('#propbar'), pagesPanel = $('#pagesPanel'), scrim = $('#scrim');
  const fileInput = $('#fileInput'), mergeInput = $('#mergeInput'), imageInput = $('#imageInput');

  /* ---------------- Utilities ---------------- */
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    const icon = type === 'error' ? 'i-x' : type === 'ok' ? 'i-check' : 'i-sparkle';
    el.innerHTML = `<svg class="i"><use href="#${icon}"/></svg><span></span>`;
    el.querySelector('span').textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 7000 : 2600);
  }
  /** "Go enjoy a coffee" — a small treat after a successful download; at most once per browser session. */
  let coffeeShown = false;
  function coffeeToast() {
    try { if (sessionStorage.getItem('pdfroo-coffee')) coffeeShown = true; } catch (e) { /* storage blocked */ }
    if (coffeeShown) return;
    coffeeShown = true;
    try { sessionStorage.setItem('pdfroo-coffee', '1'); } catch (e) { /* storage blocked */ }
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'coffee-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      el.innerHTML = '<img src="assets/roo.svg" alt="" width="46" height="53"><p>Done! Your PDF never left your device. Go enjoy a coffee ☕</p>' +
        '<button class="coffee-close" type="button" aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button>';
      let gone = false;
      const close = () => { if (gone) return; gone = true; el.classList.add('out'); setTimeout(() => el.remove(), 320); };
      el.querySelector('.coffee-close').addEventListener('click', close);
      // inside an open modal dialog (e.g. Compress) so it sits above the backdrop and its close button stays clickable
      const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
      host.appendChild(el);
      setTimeout(close, 6000);
    }, 700);
  }
  function busy(on, text) {
    $('#busy').hidden = !on;
    if (text) $('#busyText').textContent = text;
  }
  function svg(tag, attrs, parent) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }
  function readFile(file, as) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result); r.onerror = () => rej(r.error);
      as === 'url' ? r.readAsDataURL(file) : r.readAsArrayBuffer(file);
    });
  }
  const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const curPage = () => doc && doc.pages[ui.current];
  const findAnnot = (id, pg) => (pg || curPage()).annots.find((a) => a.id === id);
  const selected = () => (ui.selectedId && curPage() ? findAnnot(ui.selectedId) : null);

  /* ---------------- Theme ---------------- */
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('folio-theme', t); } catch (e) { /* private mode */ }
    const m = $('meta[name="theme-color"]'); if (m) m.content = t === 'dark' ? '#0b0d16' : '#5b50f0';
  }
  $$('.theme-toggle').forEach((b) => b.addEventListener('click', () => {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  }));

  /* ---------------- Landing ---------------- */
  const dz = $('#dropzone');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  $$('.open-file-btn').forEach((b) => b.addEventListener('click', () => fileInput.click()));
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; fileInput.value = '';
    if (f) openFile(f);
  });
  $('#sampleBtn').addEventListener('click', async () => {
    busy(true, 'Creating sample PDF…');
    try { const bytes = await window.FolioSample.createSamplePdf(); await openPdf(bytes, 'Sample-proposal.pdf'); }
    catch (e) { console.error(e); toast('Could not create the sample PDF', 'error'); }
    finally { busy(false); }
  });
  $('#year').textContent = new Date().getFullYear();

  // Make sure the annotation font is ready before text is measured / drawn.
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('16px "Folio Noto Sans"'), document.fonts.load('bold 16px "Folio Noto Sans"')])
      .then(() => { if (doc) { renderOverlay(); renderThumbs(); } }).catch(() => {});
  }

  // Drag & drop: landing opens, editor merges.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    dragDepth++;
    (doc ? $('.work') : dz).classList.add('drag');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { dz.classList.remove('drag'); $('.work').classList.remove('drag'); }
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0;
    dz.classList.remove('drag'); $('.work').classList.remove('drag');
    const files = Array.from(e.dataTransfer.files || []).filter(isPdf);
    if (!files.length) { if (e.dataTransfer.files.length) toast('Please drop a PDF file', 'error'); return; }
    if (doc) mergeFiles(files);
    else openFile(files[0]);
  });

  async function openFile(f) {
    if (!isPdf(f)) { toast('That doesn’t look like a PDF', 'error'); return; }
    busy(true, 'Opening ' + f.name + '…');
    try { await openPdf(new Uint8Array(await readFile(f)), f.name); }
    catch (e) { if (!e.userFacing) console.error(e); toast(e.message || 'Could not open this PDF', 'error'); }
    finally { busy(false); }
  }

  async function openPdf(bytes, name) {
    E.closeAll();
    fr.files = []; fr.hits = []; fr.sel.clear(); fr.status = {}; fr.active = null;   // other PDFs' sources were closed too
    const res = await E.load(bytes, name);
    doc = E.createState(res.name);
    doc.pages = res.pages;
    Object.assign(ui, { current: 0, fit: true, selectedId: null, history: [], future: [], dirty: false, editing: null, drag: null });
    ui.signature = res.signature && res.signature.signed ? res.signature : null;
    ui.sigAck = false; ui.sigMin = false;
    showEditor(true);
    setTool('select');
    renderAll();
    renderSigNotice();
  }

  /* ---------------- Digital signatures ---------------- */
  // A signed PDF gets a non-blocking banner; the first edit of any kind asks for confirmation.
  const pdfDate = (d) => {
    const m = /^D:(\d{4})(\d{2})?(\d{2})?/.exec(d || ''); if (!m) return '';
    try { return new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
  };
  function signatureSummary() {
    const sg = ui.signature; if (!sg) return '';
    const f = sg.fields[0] || {};
    const parts = [];
    if (f.signer) parts.push('Signed by ' + f.signer);
    const dt = pdfDate(f.date); if (dt) parts.push((parts.length ? 'on ' : 'Signed on ') + dt);
    let t = parts.join(' ');
    if (sg.fields.length > 1) t += (t ? ' · ' : '') + sg.fields.length + ' signatures';
    if (sg.certified) t += (t ? ' · ' : '') + 'Certified document';
    return t;
  }
  function renderSigNotice() {
    const banner = $('#signedBanner'), chip = $('#signedChip');
    const on = !!(doc && ui.signature);
    banner.hidden = !on || ui.sigMin; chip.hidden = !on || !ui.sigMin;
    if (!on) return;
    const who = signatureSummary();
    banner.classList.toggle('acked', !!ui.sigAck);
    $('#signedBannerTitle').textContent = ui.sigAck
      ? 'Editing a digitally signed PDF'
      : (ui.signature.certified ? 'This PDF is certified with a digital signature' : 'This PDF is digitally signed');
    $('#signedBannerMsg').textContent = (ui.sigAck
      ? 'The signature will be invalid in the file you download. Undo all changes to keep the original signed file.'
      : 'Any change — annotations, page edits or text edits — will invalidate the signature.') + (who ? ' (' + who + ')' : '');
  }
  $('#signedBannerClose').addEventListener('click', () => { ui.sigMin = true; renderSigNotice(); $('#signedChip').focus(); });
  $('#signedChip').addEventListener('click', () => { ui.sigMin = false; renderSigNotice(); });
  const signedDialog = $('#signedDialog');
  let sigPending = null;
  /** Returns true if editing may proceed now. Otherwise asks once; `retry` runs if the user agrees. */
  function sigGate(retry, onCancel) {
    if (!doc || !ui.signature || ui.sigAck) return true;
    if (signedDialog.open) return false;
    sigPending = { retry, onCancel };
    $('#signedDlgWho').textContent = signatureSummary();
    signedDialog.returnValue = '';
    signedDialog.showModal();
    setTimeout(() => { const b = $('#signedDlgEdit'); if (b) b.focus(); }, 30);
    return false;
  }
  signedDialog.addEventListener('close', () => {
    const p = sigPending; sigPending = null;
    if (signedDialog.returnValue === 'edit') {
      ui.sigAck = true; renderSigNotice();
      if (p && p.retry) p.retry();
      else toast('OK — you can edit now. The signature will no longer be valid.');
    } else if (p && p.onCancel) p.onCancel();
  });

  function showEditor(on) {
    landing.hidden = on; editor.hidden = !on;
    document.body.classList.toggle('editor-open', on);
    if (!on) closePanel();
  }

  $('#closeBtn').addEventListener('click', () => {
    commitText();
    if (ui.dirty && !confirm('Leave the editor? Your unsaved changes will be lost.')) return;
    E.closeAll(); doc = null; ui.signature = null; renderSigNotice(); showEditor(false); window.scrollTo(0, 0);
  });

  /* ---------------- History ---------------- */
  const snapshot = () => JSON.stringify({ pages: doc.pages, current: ui.current });
  function pushHistory(snap) {
    ui.history.push(snap); ui.snapLines = null;
    if (ui.history.length > 150) ui.history.shift();
    ui.future = []; ui.dirty = true;
    updateChrome();
  }
  function commit(fn) { const s = snapshot(); const r = fn(); pushHistory(s); return r; }
  function restore(s) {
    const o = JSON.parse(s);
    doc.pages = o.pages; ui.current = clamp(o.current, 0, doc.pages.length - 1); ui.selectedId = null; ui.lastEdit = null;
    renderAll();
  }
  function undo() { cancelLineEdit(); commitText(); if (!ui.history.length) return; ui.future.push(snapshot()); restore(ui.history.pop()); ui.dirty = true; updateChrome(); }
  function redo() { cancelLineEdit(); commitText(); if (!ui.future.length) return; ui.history.push(snapshot()); restore(ui.future.pop()); ui.dirty = true; updateChrome(); }
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);

  /* ---------------- Rendering ---------------- */
  function renderAll() { renderThumbs(); renderPage(); buildPropbar(); updateChrome(); }

  function updateChrome() {
    if (!doc) return;
    const n = doc.pages.length;
    $('#docName').textContent = doc.name;
    $('#docName').title = doc.name;
    $('#docMeta').textContent = `${n} page${n === 1 ? '' : 's'} · processed locally`;
    $('#pageCountBadge').textContent = n;
    $('#pageTotal').textContent = n;
    $('#pageInput').value = ui.current + 1;
    $('#prevBtn').disabled = ui.current <= 0;
    $('#nextBtn').disabled = ui.current >= n - 1;
    $('#undoBtn').disabled = !ui.history.length;
    $('#redoBtn').disabled = !ui.future.length;
    $('#deleteBtn').disabled = !selected();
    $('#zoomVal').textContent = Math.round(ui.zoom * 100) + '%';
    $('[data-page-action="del"]').disabled = n <= 1;
    $$('.thumb', thumbList).forEach((t, i) => {
      t.classList.toggle('current', i === ui.current);
      t.setAttribute('aria-current', i === ui.current ? 'page' : 'false');
    });
  }

  function fitZoom(ds) {
    const cs = getComputedStyle(stage);
    const pw = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const ph = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const w = viewport.clientWidth - pw, h = viewport.clientHeight - ph;
    return clamp(Math.min(w / ds.w, h / ds.h), 0.1, 4);
  }

  function layoutPage() {
    const pg = curPage(); if (!pg) return;
    const ds = E.displaySize(pg);
    if (ui.fit) ui.zoom = fitZoom(ds);
    pageWrap.style.width = Math.round(ds.w * ui.zoom) + 'px';
    pageWrap.style.height = Math.round(ds.h * ui.zoom) + 'px';
    positionTextEditor(); positionLineEditor();
    $('#zoomVal').textContent = Math.round(ui.zoom * 100) + '%';
  }

  let renderHandle = null, renderToken = 0;
  async function renderPage() {
    const pg = curPage(); if (!pg) return;
    layoutPage();
    renderOverlay();
    loadTextLines();
    if (renderHandle) renderHandle.cancel();
    const token = ++renderToken;
    const c = document.createElement('canvas');
    c.setAttribute('aria-label', `Page ${ui.current + 1}`);
    renderHandle = E.renderPage(pg, c, ui.zoom, window.devicePixelRatio || 1);
    try { await renderHandle.promise; }
    catch (e) { console.error(e); if (token === renderToken) toast('Could not render this page', 'error'); return; }
    if (token !== renderToken) return;
    const old = pageWrap.querySelector('canvas');
    c.id = 'pageCanvas';
    old ? old.replaceWith(c) : pageWrap.prepend(c);
  }

  function goTo(i) {
    if (!doc) return;
    i = clamp(i, 0, doc.pages.length - 1);
    if (i === ui.current) return;
    commitText();
    ui.current = i; ui.selectedId = null;
    const pageBlank = pageWrap.querySelector('canvas');
    if (pageBlank) { const ctx = pageBlank.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageBlank.width, pageBlank.height); }
    renderPage(); buildPropbar(); updateChrome();
    viewport.scrollTo({ top: 0 });
    const t = thumbList.children[i]; if (t) t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function setZoom(z, keepFit) {
    commitText();
    const vp = viewport;
    const cx = (vp.scrollLeft + vp.clientWidth / 2) / Math.max(1, vp.scrollWidth);
    const cy = (vp.scrollTop + vp.clientHeight / 2) / Math.max(1, vp.scrollHeight);
    ui.fit = !!keepFit;
    if (!keepFit) ui.zoom = clamp(z, 0.2, 5);
    renderPage();
    vp.scrollLeft = cx * vp.scrollWidth - vp.clientWidth / 2;
    vp.scrollTop = cy * vp.scrollHeight - vp.clientHeight / 2;
    updateChrome();
  }
  $('#zoomInBtn').addEventListener('click', () => setZoom(ui.zoom * 1.25));
  $('#zoomOutBtn').addEventListener('click', () => setZoom(ui.zoom / 1.25));
  $('#zoomVal').addEventListener('click', () => setZoom(0, true));
  $('#prevBtn').addEventListener('click', () => goTo(ui.current - 1));
  $('#nextBtn').addEventListener('click', () => goTo(ui.current + 1));
  $('#pageInput').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) goTo(v - 1); updateChrome(); });
  $('#pageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  viewport.addEventListener('wheel', (e) => {
    if (!doc || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(ui.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // Two-finger pinch zoom on touch screens (layout only while pinching, re-render at the end).
  viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && doc) {
      if (ui.drag) cancelDrag();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      ui.pinch = { d, zoom: ui.zoom };
    }
  }, { passive: true });
  viewport.addEventListener('touchmove', (e) => {
    if (!ui.pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    ui.fit = false; ui.zoom = clamp(ui.pinch.zoom * d / ui.pinch.d, 0.2, 5);
    layoutPage();
  }, { passive: false });
  viewport.addEventListener('touchend', (e) => {
    if (ui.pinch && e.touches.length < 2) { ui.pinch = null; renderPage(); updateChrome(); }
  });

  let resizeT = null;
  new ResizeObserver(() => {
    if (!doc || editor.hidden) return;
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (ui.fit) renderPage(); if (!isOverlayPanel()) closePanel(); }, 120);
  }).observe(viewport);

  /* ---------------- Annotation geometry ---------------- */
  function bbox(a) {
    switch (a.type) {
      case 'text': { const m = E.measureText(a); return { x: a.x, y: a.y, w: m.w, h: m.h }; }
      case 'pen': case 'highlight': {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        a.points.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
        const p = a.width / 2;
        return { x: x0 - p, y: y0 - p, w: x1 - x0 + 2 * p, h: y1 - y0 + 2 * p };
      }
      case 'line': case 'arrow': {
        const p = a.width / 2;
        return { x: Math.min(a.x1, a.x2) - p, y: Math.min(a.y1, a.y2) - p, w: Math.abs(a.x2 - a.x1) + 2 * p, h: Math.abs(a.y2 - a.y1) + 2 * p };
      }
      default: return { x: a.x, y: a.y, w: a.w, h: a.h };
    }
  }
  function translate(a, dx, dy) {
    switch (a.type) {
      case 'pen': case 'highlight': a.points = a.points.map(([x, y]) => [x + dx, y + dy]); break;
      case 'line': case 'arrow': a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy; break;
      default: a.x += dx; a.y += dy;
    }
    return a;
  }
  const styleKey = (t) => (t === 'text' || t === 'pen' || t === 'highlight') ? t : 'shape';

  /* ---------------- SVG annotation rendering ---------------- */
  function annotNode(a, interactive) {
    const g = svg('g', { class: 'annot annot-' + a.type, 'data-aid': a.id });
    const z = ui.zoom;
    switch (a.type) {
      case 'text': {
        const t = svg('text', { 'font-family': E.FONT_STACK, 'font-size': a.size, fill: a.color, 'font-weight': a.bold ? 700 : 400 }, g);
        String(a.text).split('\n').forEach((ln, k) => {
          const ts = svg('tspan', { x: a.x, y: a.y + a.size * E.TEXT_ASCENT + k * a.size * E.LINE_HEIGHT }, t);
          ts.textContent = ln || ' ';
        });
        if (interactive) { const b = bbox(a); svg('rect', { class: 'hit', x: b.x, y: b.y, width: b.w, height: b.h, 'pointer-events': 'all' }, g); }
        break;
      }
      case 'pen': case 'highlight': {
        const d = E.penPath(a.points);
        const attrs = { class: 'vis', d, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        if (a.type === 'highlight') { attrs.opacity = a.opacity; attrs.style = 'mix-blend-mode:multiply'; }
        svg('path', attrs, g);
        if (interactive) svg('path', { class: 'hit', d, fill: 'none', 'stroke-width': Math.max(a.width, 16 / z), 'stroke-linecap': 'round', 'pointer-events': 'stroke' }, g);
        break;
      }
      case 'rect': case 'whiteout':
        svg('rect', { x: a.x, y: a.y, width: Math.max(0, a.w), height: Math.max(0, a.h), fill: a.type === 'whiteout' ? '#ffffff' : 'none', stroke: a.type === 'whiteout' ? 'none' : a.color, 'stroke-width': a.width }, g);
        if (interactive) svg('rect', { class: 'hit' + (a.type === 'whiteout' ? ' wo-outline' : ''), x: a.x, y: a.y, width: Math.max(0, a.w), height: Math.max(0, a.h), 'pointer-events': 'all', 'stroke-width': 1 / z }, g);
        break;
      case 'ellipse':
        svg('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: Math.max(0, a.w / 2), ry: Math.max(0, a.h / 2), fill: 'none', stroke: a.color, 'stroke-width': a.width }, g);
        if (interactive) svg('ellipse', { class: 'hit', cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: Math.max(0, a.w / 2 + 4 / z), ry: Math.max(0, a.h / 2 + 4 / z), 'pointer-events': 'all' }, g);
        break;
      case 'line': case 'arrow': {
        const common = { stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', fill: 'none' };
        svg('line', Object.assign({ x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 }, common), g);
        if (a.type === 'arrow') {
          const h = E.arrowHead(a);
          svg('polyline', Object.assign({ points: `${h[0][0]},${h[0][1]} ${a.x2},${a.y2} ${h[1][0]},${h[1][1]}`, 'stroke-linejoin': 'round' }, common), g);
        }
        if (interactive) svg('line', { class: 'hit', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, 'stroke-width': Math.max(a.width, 16 / z), 'pointer-events': 'stroke' }, g);
        break;
      }
      case 'image': {
        const asset = doc.assets[a.asset];
        const im = svg('image', { x: a.x, y: a.y, width: Math.max(1, a.w), height: Math.max(1, a.h), preserveAspectRatio: 'none' }, g);
        if (asset) im.setAttribute('href', asset.dataUrl);
        if (interactive) svg('rect', { class: 'hit', x: a.x, y: a.y, width: a.w, height: a.h, 'pointer-events': 'all' }, g);
        break;
      }
    }
    return g;
  }

  function handlesFor(a) {
    const b = bbox(a);
    if (a.type === 'line' || a.type === 'arrow') return [['p1', a.x1, a.y1], ['p2', a.x2, a.y2]];
    if (a.type === 'text') return [['se', b.x + b.w, b.y + b.h]];
    return [['nw', b.x, b.y], ['ne', b.x + b.w, b.y], ['sw', b.x, b.y + b.h], ['se', b.x + b.w, b.y + b.h]];
  }

  function renderOverlay() {
    const pg = curPage(); if (!pg) return;
    const ds = E.displaySize(pg);
    overlay.setAttribute('viewBox', `0 0 ${ds.w} ${ds.h}`);
    overlay.setAttribute('preserveAspectRatio', 'none');
    overlay.replaceChildren();
    for (const a of pg.annots) {
      if (ui.editing && ui.editing.annot.id === a.id) continue;
      overlay.appendChild(annotNode(a, ui.tool !== 'edittext'));
    }
    if (ui.tool === 'edittext') drawTextLines(pg);
    if (ui.drag && ui.drag.temp) {
      const n = annotNode(ui.drag.temp, false);
      overlay.appendChild(n);
      ui.drag.node = n.querySelector('.vis');
    }
    if (ui.drag && ui.drag.guides && ui.drag.guides.length) {          // snapping guides
      const z = ui.zoom, gg = svg('g', { class: 'snap-guides', 'pointer-events': 'none' }, overlay);
      ui.drag.guides.forEach((gd) => svg('line', gd.axis === 'x' ? { x1: gd.v, x2: gd.v, y1: 0, y2: ds.h } : { y1: gd.v, y2: gd.v, x1: 0, x2: ds.w }, gg).setAttribute('stroke-width', 1 / z));
    }
    const s = selected();
    if (s && !ui.editing && ui.tool === 'select') {
      const z = ui.zoom, b = bbox(s), pad = 4 / z;
      const g = svg('g', { class: 'sel' }, overlay);
      if (s.type !== 'line' && s.type !== 'arrow') svg('rect', { class: 'sel-box', x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, 'pointer-events': 'none' }, g);
      const hitR = (window.matchMedia('(pointer: coarse)').matches ? 22 : 12) / z;
      handlesFor(s).forEach(([h, x, y]) => {
        const hx = h === 'p1' || h === 'p2' ? x : x + (h.includes('w') ? -pad : pad);
        const hy = h === 'p1' || h === 'p2' ? y : y + (h.includes('n') ? -pad : pad);
        const hg = svg('g', { class: 'handle', 'data-handle': h }, g);
        svg('circle', { class: 'handle-hit', cx: hx, cy: hy, r: hitR }, hg);
        svg('circle', { class: 'handle-dot', cx: hx, cy: hy, r: 5.5 / z }, hg);
      });
    }
  }

  /* ---------------- Thumbnails ---------------- */
  let thumbIO = null;
  function renderThumbs() {
    if (thumbIO) thumbIO.disconnect();
    thumbIO = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        thumbIO.unobserve(en.target);
        loadThumb(en.target);
      });
    }, { root: thumbList, rootMargin: '300px' });
    const frag = document.createDocumentFragment();
    doc.pages.forEach((pg, i) => {
      const ds = E.displaySize(pg);
      const li = document.createElement('li');
      li.className = 'thumb' + (i === ui.current ? ' current' : '');
      li.dataset.id = pg.id;
      li.innerHTML = `
        <div class="thumb-frame" style="aspect-ratio:${ds.w}/${ds.h}">
          <div class="thumb-loading"></div>
          <button class="thumb-btn" type="button" aria-label="Go to page ${i + 1}"></button>
        </div>
        <span class="thumb-num">${i + 1}</span>
        <div class="thumb-actions">
          <button type="button" data-act="rotr" aria-label="Rotate page ${i + 1}" title="Rotate"><svg class="i"><use href="#i-rotate-cw"/></svg></button>
          <button type="button" data-act="dup" aria-label="Duplicate page ${i + 1}" title="Duplicate"><svg class="i"><use href="#i-copy"/></svg></button>
          <button type="button" class="danger" data-act="del" aria-label="Delete page ${i + 1}" title="Delete"><svg class="i"><use href="#i-trash"/></svg></button>
        </div>`;
      const frame = li.firstElementChild;
      const ov = svg('svg', { viewBox: `0 0 ${ds.w} ${ds.h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      frame.insertBefore(ov, frame.querySelector('.thumb-btn'));
      pg.annots.forEach((a) => ov.appendChild(annotNode(a, false)));
      frag.appendChild(li);
      thumbIO.observe(frame);
    });
    thumbList.replaceChildren(frag);
  }
  async function loadThumb(frame) {
    const li = frame.closest('.thumb'); if (!li) return;
    const pg = doc.pages.find((p) => p.id === li.dataset.id); if (!pg) return;
    try {
      const url = await E.renderThumbnail(pg, 168, window.devicePixelRatio || 1);
      if (!frame.isConnected) return;
      const img = new Image(); img.alt = ''; img.src = url; img.draggable = false;
      frame.insertBefore(img, frame.firstChild);
      const l = frame.querySelector('.thumb-loading'); if (l) l.remove();
    } catch (e) { console.error(e); }
  }
  function updateThumbOverlay(i) {
    i = i == null ? ui.current : i;
    const li = thumbList.children[i]; if (!li) return;
    const ov = li.querySelector('.thumb-frame svg'); if (!ov) return;
    ov.replaceChildren();
    doc.pages[i].annots.forEach((a) => ov.appendChild(annotNode(a, false)));
  }

  thumbList.addEventListener('click', (e) => {
    const li = e.target.closest('.thumb'); if (!li) return;
    const i = Array.prototype.indexOf.call(thumbList.children, li);
    const act = e.target.closest('[data-act]');
    if (act) { pageAction(act.dataset.act, i); return; }
    if (e.target.closest('.thumb-btn')) { goTo(i); if (isOverlayPanel()) closePanel(); }
  });

  window.Sortable.create(thumbList, {
    animation: 180, forceFallback: true, fallbackTolerance: 4,
    delay: 220, delayOnTouchOnly: true, touchStartThreshold: 6,
    filter: '.thumb-actions', preventOnFilter: false,
    ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen',
    onEnd(evt) {
      if (evt.oldIndex === evt.newIndex) return;
      if (!sigGate(() => doReorder(evt.oldIndex, evt.newIndex))) { renderThumbs(); return; }   // put the thumbnail back until confirmed
      doReorder(evt.oldIndex, evt.newIndex);
    },
  });
  function doReorder(oldIndex, newIndex) {
    const curId = curPage().id;
    commit(() => E.reorderPages(doc, oldIndex, newIndex));
    ui.current = doc.pages.findIndex((p) => p.id === curId);
    renderThumbs(); updateChrome();
    toast(`Moved page to position ${newIndex + 1}`);
  }

  /* ---------------- Page actions ---------------- */
  function pageAction(act, i) {
    if (!sigGate(() => pageAction(act, i))) return;
    commitText();
    i = i == null ? ui.current : i;
    const curId = curPage().id;
    switch (act) {
      case 'rotl': case 'rotr':
        commit(() => E.rotatePage(doc, i, act === 'rotl' ? -90 : 90, bbox));
        break;
      case 'dup': {
        const ni = commit(() => E.duplicatePage(doc, i));
        renderThumbs(); goToForce(ni); toast('Page duplicated'); return;
      }
      case 'del':
        if (doc.pages.length <= 1) { toast('A document needs at least one page', 'error'); return; }
        commit(() => E.deletePage(doc, i));
        toast(`Page ${i + 1} deleted`);
        break;
    }
    const idx = doc.pages.findIndex((p) => p.id === curId);
    ui.current = idx >= 0 ? idx : clamp(i, 0, doc.pages.length - 1);
    ui.selectedId = null;
    renderAll();
  }
  function goToForce(i) { ui.current = i; ui.selectedId = null; renderPage(); buildPropbar(); updateChrome(); }
  $$('[data-page-action]').forEach((b) => b.addEventListener('click', () => pageAction(b.dataset.pageAction)));

  $('#addBlankBtn').addEventListener('click', function addBlank() {
    if (!sigGate(addBlank)) return;
    commitText();
    const ni = commit(() => E.addBlankPage(doc, ui.current));
    renderThumbs(); goToForce(ni);
    toast('Blank page added');
    if (isOverlayPanel()) closePanel();
  });
  $('#mergeBtn').addEventListener('click', () => mergeInput.click());
  mergeInput.addEventListener('change', () => { const fs = Array.from(mergeInput.files); mergeInput.value = ''; if (fs.length) mergeFiles(fs); });
  async function mergeFiles(files) {
    if (!sigGate(() => mergeFiles(files))) return;
    commitText();
    busy(true, 'Adding pages…');
    const snap = snapshot();
    let added = 0;
    const failures = [];
    for (const f of files) {
      if (!isPdf(f)) continue;
      try { added += await E.merge(doc, new Uint8Array(await readFile(f)), f.name); }
      catch (e) { if (!e.userFacing) console.error(e); failures.push(e.message || `Could not merge “${f.name}”`); }
    }
    busy(false);
    if (added) { pushHistory(snap); renderAll(); toast(`Added ${added} page${added === 1 ? '' : 's'}`, 'ok'); }
    failures.forEach((m) => toast(m, 'error'));
  }

  /* ---------------- Pages panel (drawer / bottom sheet) ---------------- */
  function openPanel() { pagesPanel.classList.add('open'); scrim.hidden = false; $('#pagesToggle').setAttribute('aria-expanded', 'true'); const t = thumbList.children[ui.current]; if (t) setTimeout(() => t.scrollIntoView({ block: 'nearest' }), 300); }
  function closePanel() { pagesPanel.classList.remove('open'); scrim.hidden = true; $('#pagesToggle').setAttribute('aria-expanded', 'false'); }
  $('#pagesToggle').addEventListener('click', () => pagesPanel.classList.contains('open') ? closePanel() : openPanel());
  $('#panelClose').addEventListener('click', closePanel);
  scrim.addEventListener('click', closePanel);

  /* ---------------- Tools ---------------- */
  function setTool(t) {
    commitText();
    ui.tool = t;
    editor.dataset.tool = t;
    if (t !== 'select') ui.selectedId = null;
    $$('.tool[data-tool]').forEach((b) => {
      const on = b.dataset.tool === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on && isPhone()) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
    renderOverlay(); buildPropbar(); updateChrome();
    if (t === 'edittext') loadTextLines();
  }
  $$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('.tool[data-action="image"]').addEventListener('click', () => { commitText(); imageInput.click(); });
  $('.tool[data-action="signature"]').addEventListener('click', openSignature);
  $('#deleteBtn').addEventListener('click', deleteSelected);

  function select(id) {
    ui.selectedId = id;
    renderOverlay(); buildPropbar(); updateChrome();
  }
  function deleteSelected() {
    const s = selected(); if (!s) return;
    commit(() => { const pg = curPage(); pg.annots = pg.annots.filter((a) => a.id !== s.id); });
    ui.selectedId = null;
    renderOverlay(); updateThumbOverlay(); buildPropbar(); updateChrome();
  }
  function duplicateSelected() {
    const s = selected(); if (!s) return;
    const c = translate(clone(s), 12, 12); c.id = E.uid('an');
    commit(() => curPage().annots.push(c));
    select(c.id); updateThumbOverlay();
  }

  /* ---------------- Pointer interaction on the overlay ---------------- */
  function toPage(e) {
    const r = overlay.getBoundingClientRect();
    const ds = E.displaySize(curPage());
    return { x: (e.clientX - r.left) * ds.w / r.width, y: (e.clientY - r.top) * ds.h / r.height };
  }
  function textAt(pt) {
    const pg = curPage();
    for (let i = pg.annots.length - 1; i >= 0; i--) {
      const a = pg.annots[i];
      if (a.type !== 'text') continue;
      const b = bbox(a);
      if (pt.x >= b.x - 3 && pt.x <= b.x + b.w + 3 && pt.y >= b.y - 3 && pt.y <= b.y + b.h + 3) return a;
    }
    return null;
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (!doc || ui.pinch) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (ui.drag) return;                       // ignore extra fingers
    if (ui.editing) { commitText(); e.preventDefault(); return; }
    if (ui.lineEdit) { commitLineEdit(); e.preventDefault(); return; }
    const pt = toPage(e);
    const tool = ui.tool;
    const st = ui.styles[styleKey(tool)];
    let drag = null;

    if (tool === 'select') {
      const h = e.target.closest('[data-handle]');
      const g = e.target.closest('[data-aid]');
      const s = selected();
      if (h && s) {
        drag = { mode: 'resize', handle: h.dataset.handle, orig: clone(s), ob: bbox(s), start: pt };
      } else if (g) {
        const a = findAnnot(g.dataset.aid);
        if (!a) return;
        const now = Date.now();
        if (a.type === 'text' && ui.lastTap && ui.lastTap.id === a.id && now - ui.lastTap.t < 420) {
          ui.lastTap = null; e.preventDefault(); openTextEditor(a, false); return;
        }
        ui.lastTap = { id: a.id, t: now };
        if (ui.selectedId !== a.id) select(a.id);
        drag = { mode: 'move', orig: clone(a), start: pt };
      } else {
        if (ui.selectedId) select(null);
        return;                                // let the browser pan on touch
      }
    } else if (tool === 'edittext') {
      const data = ui.lines && ui.lines.pageId === curPage().id ? ui.lines.data : null;
      const r = e.target.closest('[data-line]');
      if (!data) { toast('Still reading the text on this page…'); return; }
      const fx = e.target.closest('[data-fixbullet]');
      if (fx) { e.preventDefault(); fixBullets([fx.dataset.fixbullet]); return; }
      if (!r) {
        if (runSel().length) { ui.runSel = null; renderOverlay(); buildPropbar(); }
        if (data.refusal) toast(data.refusal.message, 'error');
        return;                                                     // let touch pan
      }
      e.preventDefault();
      const ln = data.lines.find((l) => l.id === r.dataset.line);
      if (!ln) return;
      if (!ln.editable && !ln.movable) { toast(ln.reason, 'error'); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {                   // build a group of runs (nudge / align left edges)
        const ids = runSel().slice(); const k = ids.indexOf(ln.id);
        if (ui.lineEdit && !ids.includes(ui.lineEdit.ln.id)) ids.push(ui.lineEdit.ln.id);
        k >= 0 ? ids.splice(k, 1) : ids.push(ln.id);
        if (ui.lineEdit) commitLineEdit();
        ui.runSel = { pageId: curPage().id, ids }; renderOverlay(); buildPropbar(); return;
      }
      ui.runSel = { pageId: curPage().id, ids: [ln.id] };
      if (!ln.editable) {                                           // e.g. a Symbol-font bullet: can be moved, not retyped
        renderOverlay(); buildPropbar();
        toast(isPhone() ? 'Selected — use the arrows below to nudge it' : 'Selected — use the arrow keys or the arrows in the bar to nudge it');
        return;
      }
      ui.pendingCaret = { id: ln.id, x: pt.x };                    // put the caret where the line was clicked
      if (!sigGate(() => startLineEdit(ln))) return;
      startLineEdit(ln);
      return;
    } else if (tool === 'text') {
      e.preventDefault();
      if (!sigGate()) return;
      const hit = textAt(pt);
      if (hit) { openTextEditor(hit, false); return; }
      const a = { id: E.uid('an'), type: 'text', x: pt.x, y: pt.y - st.size * 0.6, text: '', size: st.size, color: st.color, bold: st.bold };
      openTextEditor(a, true);
      return;
    } else if (!sigGate()) {                   // drawing tools: confirm first, then draw again
      e.preventDefault(); return;
    } else if (tool === 'pen' || tool === 'highlight') {
      const temp = { id: E.uid('an'), type: tool, points: [[pt.x, pt.y]], color: st.color, width: st.width };
      if (tool === 'highlight') temp.opacity = 0.4;
      drag = { mode: 'draw', temp };
    } else if (['rect', 'ellipse', 'whiteout', 'line', 'arrow'].includes(tool)) {
      const temp = (tool === 'line' || tool === 'arrow')
        ? { id: E.uid('an'), type: tool, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color: st.color, width: st.width }
        : { id: E.uid('an'), type: tool, x: pt.x, y: pt.y, w: 0, h: 0, color: st.color, width: st.width };
      drag = { mode: 'shape', temp, start: pt };
    }
    if (!drag) return;
    e.preventDefault();
    drag.pointerId = e.pointerId; drag.moved = false; drag.snap = snapshot();
    ui.drag = drag;
    try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (drag.temp) renderOverlay();
  });

  overlay.addEventListener('pointermove', (e) => {
    const d = ui.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const pt = toPage(e);
    const z = ui.zoom;
    const dist = Math.hypot(pt.x - (d.start ? d.start.x : pt.x), pt.y - (d.start ? d.start.y : pt.y));
    if (!d.moved && d.start && dist * z < 3) return;
    d.moved = true;
    const pg = curPage();

    if (d.mode === 'move') {
      const idx = pg.annots.findIndex((a) => a.id === d.orig.id);
      if (idx < 0) return;
      let dx = pt.x - d.start.x, dy = pt.y - d.start.y;
      d.guides = [];
      if (!e.altKey) {                                     // snap edges / centres to the page, other objects and text lines (Alt: off)
        const sn = snapMove(pg, d.ob || (d.ob = bbox(d.orig)), dx, dy, d.orig.id);
        dx = sn.dx; dy = sn.dy; d.guides = sn.guides;
      }
      pg.annots[idx] = translate(clone(d.orig), dx, dy);
      renderOverlay();
    } else if (d.mode === 'resize') {
      const idx = pg.annots.findIndex((a) => a.id === d.orig.id);
      if (idx < 0) return;
      pg.annots[idx] = resized(d, pt, e.shiftKey);
      renderOverlay();
    } else if (d.mode === 'draw') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const pts = d.temp.points;
      (evs.length ? evs : [e]).forEach((ev) => {
        const p = toPage(ev); const last = pts[pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) * z >= 1.5) pts.push([Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
      });
      if (d.node) d.node.setAttribute('d', E.penPath(pts)); else renderOverlay();
    } else if (d.mode === 'shape') {
      const t = d.temp;
      if (t.type === 'line' || t.type === 'arrow') {
        let x2 = pt.x, y2 = pt.y;
        if (e.shiftKey) { const ang = Math.round(Math.atan2(y2 - t.y1, x2 - t.x1) / (Math.PI / 4)) * Math.PI / 4; const L = Math.hypot(x2 - t.x1, y2 - t.y1); x2 = t.x1 + L * Math.cos(ang); y2 = t.y1 + L * Math.sin(ang); }
        t.x2 = x2; t.y2 = y2;
      } else {
        let w = pt.x - d.start.x, h = pt.y - d.start.y;
        if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        t.x = Math.min(d.start.x, d.start.x + w); t.y = Math.min(d.start.y, d.start.y + h); t.w = Math.abs(w); t.h = Math.abs(h);
      }
      renderOverlay();
    }
  });

  /** Snap targets: page edges + centre, other annotations' edges/centres, text lines' left edges / baselines. */
  function snapTargets(pg, exceptId) {
    const ds = E.displaySize(pg);
    const xs = [0, ds.w / 2, ds.w], ys = [0, ds.h / 2, ds.h];
    pg.annots.forEach((a) => { if (a.id === exceptId) return; const b = bbox(a); xs.push(b.x, b.x + b.w / 2, b.x + b.w); ys.push(b.y, b.y + b.h / 2, b.y + b.h); });
    const tl = ui.snapLines && ui.snapLines.pageId === pg.id ? ui.snapLines.lines : null;
    if (tl) tl.forEach((l) => { xs.push(l.x); ys.push(l.y + l.h); });
    else if (!ui.snapLinesLoading) {
      ui.snapLinesLoading = true;
      E.getTextLines(pg).then((d) => { ui.snapLines = { pageId: pg.id, lines: (d.lines || []).map((l) => ({ x: l.x, y: l.y, h: l.h })) }; }).catch(() => {}).finally(() => { ui.snapLinesLoading = false; });
    }
    return { xs, ys };
  }
  function snapMove(pg, b, dx, dy, id) {
    const T = snapTargets(pg, id), tol = 6 / ui.zoom, guides = [];
    const best = (cands, vals) => { let m = null; for (const c of cands) for (const v of vals) { const d = v - c; if (Math.abs(d) <= tol && (!m || Math.abs(d) < Math.abs(m.d))) m = { d, v }; } return m; };
    const mx = best([b.x + dx, b.x + b.w / 2 + dx, b.x + b.w + dx], T.xs);
    const my = best([b.y + dy, b.y + b.h / 2 + dy, b.y + b.h + dy], T.ys);
    if (mx) { dx += mx.d; guides.push({ axis: 'x', v: mx.v }); }
    if (my) { dy += my.d; guides.push({ axis: 'y', v: my.v }); }
    return { dx, dy, guides };
  }
  function endDrag(e) {
    const d = ui.drag;
    if (!d || (e && e.pointerId !== d.pointerId)) return;
    ui.drag = null;
    const pg = curPage();
    if (d.mode === 'move' || d.mode === 'resize') {
      if (d.moved) { pushHistory(d.snap); updateThumbOverlay(); }
    } else if (d.mode === 'draw') {
      if (d.temp.points.length) { pushHistory(d.snap); pg.annots.push(d.temp); updateThumbOverlay(); }
    } else if (d.mode === 'shape') {
      const t = d.temp;
      if (!d.moved) {                                          // tap → sensible default size
        if (t.type === 'line' || t.type === 'arrow') { t.x1 = d.start.x - 60; t.x2 = d.start.x + 60; t.y1 = t.y2 = d.start.y; }
        else { t.w = t.type === 'whiteout' ? 140 : 140; t.h = t.type === 'whiteout' ? 36 : 90; t.x = d.start.x - t.w / 2; t.y = d.start.y - t.h / 2; }
      }
      const tiny = (t.type === 'line' || t.type === 'arrow') ? Math.hypot(t.x2 - t.x1, t.y2 - t.y1) < 2 : (t.w < 2 || t.h < 2);
      if (!tiny) { pushHistory(d.snap); pg.annots.push(t); updateThumbOverlay(); }
    }
    renderOverlay(); buildPropbar(); updateChrome();
  }
  function cancelDrag() {
    const d = ui.drag; if (!d) return;
    ui.drag = null;
    if ((d.mode === 'move' || d.mode === 'resize') && d.moved) restore(d.snap);
    renderOverlay();
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', (e) => { if (ui.drag && e.pointerId === ui.drag.pointerId) endDrag(e); });
  overlay.addEventListener('dblclick', (e) => {
    if (ui.tool !== 'select') return;
    const g = e.target.closest('[data-aid]'); if (!g) return;
    const a = findAnnot(g.dataset.aid);
    if (a && a.type === 'text') openTextEditor(a, false);
  });

  function resized(d, pt, keepRatio) {
    const a = clone(d.orig), ob = d.ob, h = d.handle;
    if (h === 'p1') { a.x1 = pt.x; a.y1 = pt.y; return a; }
    if (h === 'p2') { a.x2 = pt.x; a.y2 = pt.y; return a; }
    const fx = h.includes('w') ? ob.x + ob.w : ob.x;
    const fy = h.includes('n') ? ob.y + ob.h : ob.y;
    let w = Math.max(8, Math.abs(pt.x - fx)), hh = Math.max(8, Math.abs(pt.y - fy));
    if (keepRatio || a.type === 'image' || a.type === 'text') {
      const r = ob.w / ob.h;
      if (w / hh > r) hh = w / r; else w = hh * r;
    }
    const nb = { x: h.includes('w') ? fx - w : fx, y: h.includes('n') ? fy - hh : fy, w, h: hh };
    switch (a.type) {
      case 'text': a.size = clamp(d.orig.size * nb.h / ob.h, 5, 300); break;
      case 'pen': case 'highlight': {
        const sx = nb.w / ob.w, sy = nb.h / ob.h;
        a.points = d.orig.points.map(([x, y]) => [nb.x + (x - ob.x) * sx, nb.y + (y - ob.y) * sy]);
        break;
      }
      default: a.x = nb.x; a.y = nb.y; a.w = nb.w; a.h = nb.h;
    }
    return a;
  }

  /* ---------------- Text editing ---------------- */
  function openTextEditor(a, isNew) {
    commitText();
    if (ui.tool !== 'text' && ui.tool !== 'select') setTool('select');
    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.value = a.text;
    ta.placeholder = 'Type here…';
    ta.setAttribute('aria-label', 'Annotation text');
    ta.spellcheck = true;
    ui.editing = { annot: a, isNew, ta, pageId: curPage().id, snap: snapshot() };
    ui.selectedId = null;
    pageWrap.appendChild(ta);
    positionTextEditor();
    ta.addEventListener('input', positionTextEditor);
    // Indic text: lazily load HarfBuzz + the Noto script font the export will use, so the preview matches
    ta.addEventListener('input', () => {
      if (!E.hasIndic(ta.value)) return;
      E.ensureScriptFonts(ta.value, a.bold).then(() => { if (ui.editing && ui.editing.ta === ta) positionTextEditor(); renderOverlay(); }).catch((err) => console.warn(err));
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitText(); }
      e.stopPropagation();
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (ui.editing && ui.editing.ta === ta) commitText(); }, 0));
    renderOverlay(); buildPropbar();
    const focusTa = () => { if (ui.editing && ui.editing.ta === ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); } };
    focusTa(); setTimeout(focusTa, 0);
  }
  function positionTextEditor() {
    const ed = ui.editing; if (!ed) return;
    const a = ed.annot, z = ui.zoom, ta = ed.ta;
    const m = E.measureText(Object.assign({}, a, { text: ta.value || 'Type here…' }));
    Object.assign(ta.style, {
      left: a.x * z + 'px', top: a.y * z + 'px',
      fontSize: a.size * z + 'px', fontWeight: a.bold ? '700' : '400', color: a.color,
      width: Math.ceil((m.w + a.size * 0.8) * z) + 'px', height: Math.ceil(m.h * z + 2) + 'px',
    });
  }
  function commitText() {
    if (ui.lineEdit) commitLineEdit();
    const ed = ui.editing; if (!ed) return;
    ui.editing = null;
    const text = ed.ta.value.replace(/\s+$/, '');
    ed.ta.remove();
    const pg = doc && doc.pages.find((p) => p.id === ed.pageId);
    if (!pg) return;
    const a = ed.annot;
    const existing = pg.annots.find((x) => x.id === a.id);
    if (!text.trim()) {
      if (existing) { pushHistory(ed.snap); pg.annots = pg.annots.filter((x) => x.id !== a.id); }
    } else if (!existing) {
      a.text = text; pushHistory(ed.snap); pg.annots.push(a);
      ui.selectedId = a.id;
      if (ui.tool === 'text') { ui.tool = 'select'; setTool('select'); ui.selectedId = a.id; }
    } else if (existing.text !== text || ed.styleChanged) {
      existing.text = text; pushHistory(ed.snap); ui.selectedId = a.id;
    } else ui.selectedId = a.id;
    if (curPage() && curPage().id === pg.id) { renderOverlay(); updateThumbOverlay(); }
    buildPropbar(); updateChrome();
  }

  /* ---------------- Editing existing PDF text ---------------- */
  const linesKey = (pg) => pg.id + '|' + E.totalRotation(pg) + '|' + (pg.textEdits || []).map((e) => e.lineId + '=' + e.text + '/' + e.tier + (e.move ? '@' + e.move.dx + ',' + e.move.dy : '')).join('|');
  async function loadTextLines(force) {
    const pg = curPage();
    if (!pg || ui.tool !== 'edittext') return;
    const key = linesKey(pg);
    if (!force && ui.lines && ui.lines.key === key) return;
    const token = (ui.linesToken = (ui.linesToken || 0) + 1);
    ui.lines = { key, pageId: pg.id, data: null };
    buildPropbar();
    let data;
    try { data = await E.getTextLines(pg); }
    catch (err) { console.error(err); data = { refusal: { code: 'error', message: 'Pdfroo couldn’t read the text on this page.' }, lines: [] }; }
    if (token !== ui.linesToken) return;
    ui.lines.data = data;
    renderOverlay(); buildPropbar();
  }
  function drawTextLines(pg) {
    const data = ui.lines && ui.lines.pageId === pg.id ? ui.lines.data : null;
    if (!data) return;
    const z = ui.zoom, pad = 1.5 / z;
    const g = svg('g', { class: 'tlines' }, overlay);
    const selIds = runSel();
    data.lines.forEach((ln) => {
      if (ui.lineEdit && ui.lineEdit.ln.id === ln.id) return;
      const cls = 'tline' + (ln.edited ? ' edited' : '') + (ln.editable ? '' : ln.movable ? ' movable' : ' locked') + (selIds.includes(ln.id) ? ' run-sel' : '') + (ln.strayBullet ? ' stray' : '');
      const axis = ln.poly && Math.abs(ln.poly[0][1] - ln.poly[1][1]) < 0.5 && Math.abs(ln.poly[0][0] - ln.poly[3][0]) < 0.5;
      const r = axis || !ln.poly
        ? svg('rect', { class: cls, 'data-line': ln.id, x: ln.x - pad, y: ln.y - pad, width: ln.w + 2 * pad, height: ln.h + 2 * pad, rx: 2 / z, 'stroke-width': 1.25 / z }, g)
        : svg('polygon', { class: cls, 'data-line': ln.id, points: ln.poly.map((q) => q.join(',')).join(' '), 'stroke-width': 1.25 / z }, g);
      const t = svg('title', {}, r); t.textContent = ln.editable ? (ln.edited ? ln.label : 'Edit: ' + ln.fontLabel) : ln.reason;
    });
    // "Fix bullet position" suggestions next to bullets that sit off their line
    const placed = [];
    data.lines.filter((ln) => ln.strayBullet && ln.movable).sort((p, q) => p.y - q.y).forEach((ln) => {
      const fs = 10 / z, h = 16 / z, w = 34 / z, gap = 4 / z;
      let x = ln.x - w - gap; const y = ln.y + ln.h / 2 - h / 2;
      while (placed.some((r) => Math.abs(r.y - y) < h + 1 / z && Math.abs(r.x - x) < w)) x -= w + 2 / z;   // don't stack chips
      if (x < 1 / z) x = ln.x + ln.w + gap;
      placed.push({ x, y });
      const cg = svg('g', { class: 'bullet-fix', 'data-fixbullet': ln.id, role: 'button', 'aria-label': 'Fix bullet position' }, g);
      svg('rect', { x, y, width: w, height: h, rx: h / 2 }, cg);
      const tx = svg('text', { x: x + w / 2, y: y + h / 2 + fs * 0.36, 'font-size': fs, 'text-anchor': 'middle' }, cg);
      tx.textContent = 'Fix';
      svg('line', { x1: x + w, y1: y + h / 2, x2: ln.x, y2: ln.y + ln.h / 2, 'stroke-width': 1 / z }, cg);
      const tt = svg('title', {}, cg); tt.textContent = 'Fix bullet position: move it onto the first line of its text';
    });
  }
  /* ---------------- Nudge / align existing text runs ---------------- */
  const runSel = () => (ui.runSel && doc && curPage() && ui.runSel.pageId === curPage().id && ui.tool === 'edittext' ? ui.runSel.ids : []);
  const lineData = () => (ui.lines && doc && curPage() && ui.lines.pageId === curPage().id ? ui.lines.data : null);
  const NUDGE = 0.5, NUDGE_BIG = 5;
  /** Queue a nudge (displayed-page points); presses are accumulated and applied together. */
  function nudgeRuns(ddx, ddy) {
    const ids = runSel().length ? runSel() : (ui.lineEdit ? [ui.lineEdit.ln.id] : []);
    if (!ids.length) return false;
    const n = ui.nudge || (ui.nudge = { pageId: curPage().id, ids: ids.slice(), ddx: 0, ddy: 0, snap: snapshot() });
    n.ddx += ddx; n.ddy += ddy;
    // live feedback: shift the outlines right away
    const z = ui.zoom;
    $$('.overlay .tline.run-sel').forEach((el) => el.setAttribute('transform', `translate(${n.ddx} ${n.ddy})`));
    if (ui.lineEdit && ids.includes(ui.lineEdit.ln.id)) ui.lineEdit.inp.style.transform = `translate(${n.ddx * z}px, ${n.ddy * z}px)`;
    clearTimeout(ui.nudgeTimer);
    ui.nudgeTimer = setTimeout(flushNudge, 220);
    return true;
  }
  async function flushNudge() {
    if (ui.nudgeBusy) { clearTimeout(ui.nudgeTimer); ui.nudgeTimer = setTimeout(flushNudge, 120); return; }
    const n = ui.nudge; ui.nudge = null;
    if (!n || (!n.ddx && !n.ddy)) return;
    const pg = doc.pages.find((p) => p.id === n.pageId); if (!pg) return;
    const d = E.displayDeltaToPdf(pg, n.ddx, n.ddy);
    await moveRuns(pg, n.ids.map((id) => ({ id, dx: d.dx, dy: d.dy })), n.snap);
  }
  /** Move runs in the content stream (same font, still real text). moves: [{id, dx, dy}] in PDF points. */
  async function moveRuns(pg, moves, snap) {
    ui.nudgeBusy = true;
    snap = snap || snapshot();
    if (ui.lineEdit) { const le = ui.lineEdit; if (le.inp.value === le.base || le.inp.value === le.ln.text) closeLineEditor(); else await commitLineEdit(); }
    const pi = doc.pages.indexOf(pg);
    let ok = 0, err = null, last = null;
    try {
      for (const m of moves) {
        if (Math.abs(m.dx) < 1e-4 && Math.abs(m.dy) < 1e-4) continue;
        const r = await E.moveTextLine(doc, pi, m.id, m.dx, m.dy);
        if (r.ok) { ok++; last = r; } else err = r.message;
      }
    } catch (e2) { console.error(e2); err = 'Something went wrong while moving this text.'; }
    ui.nudgeBusy = false;
    if (ok) {
      pushHistory(snap);
      if (last && last.edit) ui.lastEdit = { pageId: pg.id, label: last.edit.label, tier: last.edit.tier };
    }
    if (err) toast(err, 'error');
    if (pi === ui.current) renderPage(); else renderOverlay();
    refreshThumb(pi); buildPropbar(); updateChrome();
    return ok;
  }
  /** Snap each selected run onto its line: a bullet onto the first line of its paragraph, any other run onto the nearest line on its row. */
  async function alignToLine() {
    const data = lineData(); if (!data) return;
    const ids = runSel().length ? runSel() : (ui.lineEdit ? [ui.lineEdit.ln.id] : []);
    const moves = [];
    for (const id of ids) {
      const ln = data.lines.find((l) => l.id === id); if (!ln) continue;
      if (ln.strayBullet) { moves.push({ id, dx: 0, dy: ln.strayBullet.dy }); continue; }
      const tol = 0.6 * ln.size;
      let best = null, bd = Infinity;
      for (const o of data.lines) {
        if (o.id === id || ids.includes(o.id) || !String(o.text).trim()) continue;
        const dy = o.pdf.y - ln.pdf.y;
        if (Math.abs(dy) > tol || Math.abs(dy) < 0.01) continue;
        const gap = Math.max(0, o.pdf.x - (ln.pdf.x + ln.pdf.width), ln.pdf.x - (o.pdf.x + o.pdf.width));
        const sc = gap + Math.abs(dy) * 4;
        if (sc < bd) { bd = sc; best = o; }
      }
      if (best) moves.push({ id, dx: 0, dy: best.pdf.y - ln.pdf.y });
    }
    if (!moves.length) { toast('Already sitting on its line — nothing to align', 'ok'); return; }
    const n = await moveRuns(curPage(), moves);
    if (n) toast(n === 1 ? 'Aligned to the line' : `Aligned ${n} runs to their lines`, 'ok');
  }
  async function alignLeftEdges() {
    const data = lineData(); if (!data) return;
    const sel = runSel().map((id) => data.lines.find((l) => l.id === id)).filter(Boolean);
    if (sel.length < 2) { toast('Shift-click two or more runs first', 'error'); return; }
    const pg = curPage();
    const x0 = Math.min(...sel.map((l) => l.x));
    const moves = sel.map((l) => { const d = E.displayDeltaToPdf(pg, x0 - l.x, 0); return { id: l.id, dx: d.dx, dy: d.dy }; });
    const n = await moveRuns(pg, moves);
    if (n) toast(`Lined up ${sel.length} left edges`, 'ok');
  }
  async function fixBullets(ids) {
    const data = lineData(); if (!data) return;
    const moves = ids.map((id) => data.lines.find((l) => l.id === id)).filter((l) => l && l.strayBullet).map((l) => ({ id: l.id, dx: 0, dy: l.strayBullet.dy }));
    if (!moves.length) return;
    const n = await moveRuns(curPage(), moves);
    if (n) toast(n === 1 ? 'Bullet moved onto its line (still real text)' : `${n} bullets moved onto their lines (still real text)`, 'ok');
  }
  /** On-screen arrows (phone friendly) + align actions. onMove(ddx, ddy) gets displayed-page points. */
  function nudgePad(onMove, label) {
    const g = document.createElement('div'); g.className = 'nudge-pad'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', label || 'Nudge');
    [['up', 0, -1, '↑'], ['left', -1, 0, '←'], ['down', 0, 1, '↓'], ['right', 1, 0, '→']].forEach(([n, x, y, ch]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn nudge-btn nudge-' + n;
      b.setAttribute('aria-label', 'Nudge ' + n); b.title = `Nudge ${n} ${NUDGE} pt (Shift: ${NUDGE_BIG} pt)`; b.textContent = ch;
      b.addEventListener('mousedown', (e) => e.preventDefault());         // keep the line editor focused
      b.addEventListener('click', (e) => { const st = e.shiftKey ? NUDGE_BIG : NUDGE; onMove(x * st, y * st); });
      g.appendChild(b);
    });
    return g;
  }
  /* Indic lines: check the reading first (font-derived reading + line OCR; see indicVerify.js) */
  function startLineEdit(ln) {
    if (!(ln.indic || ln.verify) || ln.edited) { openLineEditor(ln); return; }
    checkIndicLine(ln);
  }
  async function checkIndicLine(ln) {
    const pg = curPage();
    busy(true, 'Checking this line…');
    let res;
    try {
      res = await E.verifyIndicLine(pg, ln.id, {
        state: doc,                         // this document's learned glyph map (read + taught by accepted readings)
        onStatus: (m) => {
          if (!m || !m.status) return;
          if (/loading language/.test(m.status)) {
            busy(true, 'Loading the text reader for this script (once)…' + (m.progress ? ' ' + Math.round(m.progress * 100) + '%' : ''));
          } else if (/loading tesseract core/.test(m.status)) busy(true, 'Loading the text reader (once)…');
          else if (/recognizing/.test(m.status)) busy(true, 'Reading the printed line…');
        },
      });
    } catch (err) { console.error(err); res = { ok: false, message: 'Pdfroo couldn’t check this line.' }; }
    busy(false);
    if (curPage() !== pg) return;
    if (!res.ok) { toast(res.message, 'error'); return; }
    if (res.decision === 'text') openLineEditor(ln);
    else if (res.decision === 'silent') {
      openLineEditor(ln, { prefill: res.best, verified: true, source: res.source });
      if (res.source === 'learned') toast('Pdfroo read this line with glyphs it learned earlier in this document (the printed image agrees).', 'ok');
    }
    else openIndicDialog(ln, res);
  }
  const indicDialog = $('#indicDialog');
  let indicPending = null;
  function readingSpans(spans) {
    const frag = document.createDocumentFragment();
    (spans || []).forEach((sp) => { if (sp.diff) { const m = document.createElement('mark'); m.textContent = sp.t; frag.append(m); } else frag.append(document.createTextNode(sp.t)); });
    return frag;
  }
  function openIndicDialog(ln, res) {
    const pg = curPage();
    indicPending = { ln, res, pageId: pg.id };
    $('#indicDlgImg').src = res.image || '';
    $('#indicDlgImg').closest('figure').hidden = !res.image;
    const why = res.decision === 'confirm' ? ({
      'font reading and OCR disagree': 'The copied text of this line doesn’t match what’s printed, and Pdfroo’s two readings of it (from the font’s glyphs and from the printed image) differ.',
      'font reading and OCR agree, but some glyphs aren’t in the font’s cmap': 'Both of Pdfroo’s readings agree, but some glyphs (conjuncts) could only be read from the PDF’s own, unreliable text map.',
      'OCR isn’t available here': 'Only the font reading is available (reading the printed image needs Pdfroo to be opened over http(s)).',
      'the font can’t be read back': 'The font’s glyphs couldn’t be read back, so this reading comes from the printed image only.',
      'font reading and OCR agree, but the text layer differs': 'The copied text of this line doesn’t match what’s printed. Pdfroo’s two readings of it (from the font’s glyphs and from the printed image) agree.',
      'OCR matches the text layer, but the font’s glyphs say otherwise': 'The printed image matches the copied text, but the font’s own glyphs say something else.',
      'legacy font; converter and OCR agree': `This line uses an older Hindi font (${res.legacyFont}) that stores Devanagari as Latin letters. Pdfroo converted it, and reading the printed image gives the same letters. It will be saved as Unicode text in Noto Sans Devanagari.`,
      'legacy font; converter and OCR disagree': `This line uses an older Hindi font (${res.legacyFont}) that stores Devanagari as Latin letters. Pdfroo converted it; reading the printed image gives something different, so please check. It will be saved as Unicode text in Noto Sans Devanagari.`,
      'legacy font; OCR isn’t available here': `This line uses an older Hindi font (${res.legacyFont}) that stores Devanagari as Latin letters. Pdfroo converted it (reading the printed image needs http(s)). It will be saved as Unicode text in Noto Sans Devanagari.`,
    }[res.why] || res.why) : res.why;
    const anyDiff = res.marks && Object.entries(res.marks).some(([k, m]) => m && !(res.legacy && k === 'textLayer') && m.some((x) => x.diff));
    $('#indicDlgWhy').textContent = why + (anyDiff ? ' Highlighted parts differ from the best reading.' : '');
    const ta = $('#indicDlgText');
    ta.value = res.best || ln.text;
    ta.lang = 'hi';
    const dl = $('#indicDlgReadings'); dl.replaceChildren();
    const row = (label, text, spans, tag) => {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd');
      if (text == null || text === '') { dd.className = 'na'; dd.textContent = tag || 'not available'; }
      else { dd.append(readingSpans(spans)); if (tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = tag; dd.append(t); } }
      dl.append(dt, dd);
    };
    if (res.legacy) {
      row('Copied text', res.textLayer, [{ t: res.textLayer, diff: false }], res.legacyFont);
      row('Converted', res.font, res.marks && res.marks.font, 'from ' + res.legacyFont);
    } else {
      row('Copied text', res.textLayer, res.marks && res.marks.textLayer);
      const lg = res.learnedGlyphs || 0;
      const ftag = [lg ? lg + ' glyph' + (lg > 1 ? 's' : '') + ' learned in this document' : '', res.font && res.unverified ? res.unverified + ' glyph' + (res.unverified > 1 ? 's' : '') + ' unverified' : ''].filter(Boolean).join(' · ');
      row('From the font', res.font, res.marks && res.marks.font, ftag || (res.font ? '' : 'can’t be read'));
      if (lg) dl.lastElementChild.classList.add('learned');
    }
    row('From the image', res.ocr, res.marks && res.marks.ocr, res.ocr ? 'OCR ' + (res.ocrConf != null ? res.ocrConf + '%' : '') : (res.ocrError ? 'needs http(s)' : 'no text found'));
    if (res.legacy || !E.hasIndic(ln.text)) E.ensureScriptFonts(res.best || '').then(() => indicDialog.style.setProperty('--indic-font', '"FolioIndic Devanagari"')).catch(() => {});
    else E.getLineEditorFont(pg, ln.id).then((f) => { if (f) indicDialog.style.setProperty('--indic-font', f.family); }).catch(() => {});
    indicDialog.returnValue = '';
    indicDialog.showModal();
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
  }
  $('#indicDlgText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#indicDlgOk').click(); } });
  indicDialog.addEventListener('close', async () => {
    const p = indicPending; indicPending = null;
    if (!p || indicDialog.returnValue !== 'confirm') return;
    const pg = doc && doc.pages.find((q) => q.id === p.pageId);
    if (!pg) return;
    const text = $('#indicDlgText').value.replace(/[\r\n]+/g, ' ').trim();
    if (!text) { toast('The line can’t be empty — use White-out to remove it.', 'error'); return; }
    const snap = snapshot();
    busy(true, 'Saving the line…');
    let res;
    const pi = doc.pages.indexOf(pg);
    // the confirmed reading teaches this document's glyph map (not for legacy fonts; never kept across documents)
    if (!p.res.legacy) { try { await E.confirmIndicReading(doc, pi, p.ln.id, text); } catch (err) { console.warn(err); } }
    try { res = await E.editTextLine(doc, pi, p.ln.id, text, { verified: true, repair: true, readingSource: 'confirmed', prefillSource: p.res.source || null }); }
    catch (err) { console.error(err); res = { ok: false, message: 'Something went wrong while editing this line.' }; }
    busy(false);
    if (res.ok) {
      pushHistory(snap);
      ui.lastEdit = res.edit ? { pageId: pg.id, label: res.edit.label, tier: res.edit.tier } : null;
      toast(res.message, 'ok');
      const i = doc.pages.indexOf(pg);
      if (i === ui.current) renderPage();
      refreshThumb(i);
    } else toast(res.message, 'error');
    buildPropbar(); updateChrome();
  });
  function openLineEditor(ln, opts) {
    opts = opts || {};
    commitText();
    const pg = curPage();
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'line-editor'; inp.value = opts.prefill || ln.text;
    inp.setAttribute('aria-label', 'Edit this line of text'); inp.spellcheck = true; inp.autocomplete = 'off';
    inp.setAttribute('enterkeyhint', 'done');
    ui.lineEdit = { ln, inp, pageId: pg.id, font: null, base: opts.prefill || ln.text, verified: !!opts.verified || !!ln.edited, source: opts.source || null, style: Object.assign({}, ln.style || {}), style0: JSON.stringify(ln.style || {}), info: null };
    if (!ln.indic) E.getLineStyleInfo(pg, ln.id).then((info) => { if (ui.lineEdit && ui.lineEdit.inp === inp && info) { ui.lineEdit.info = info; buildPropbar(); positionLineEditor(); } }).catch((err) => console.warn(err));
    pageWrap.append(inp);
    positionLineEditor();
    E.getLineEditorFont(pg, ln.id).then((f) => { if (f && ui.lineEdit && ui.lineEdit.inp === inp) { ui.lineEdit.font = f; positionLineEditor(); } }).catch(() => {});
    inp.addEventListener('input', positionLineEditor);
    inp.addEventListener('input', () => {
      if (!E.hasIndic(inp.value)) return;
      E.ensureScriptFonts(inp.value, ln.bold).then(() => { if (ui.lineEdit && ui.lineEdit.inp === inp) positionLineEditor(); }).catch((err) => console.warn(err));
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitLineEdit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelLineEdit(); }
      else if (e.altKey && /^Arrow/.test(e.key) && ln.movable) {
        e.preventDefault();
        const st = e.shiftKey ? NUDGE_BIG : NUDGE;
        nudgeRuns(e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0);
      }
      e.stopPropagation();
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (ui.lineEdit && ui.lineEdit.inp === inp && !ui.lineEdit.busy) commitLineEdit(); }, 0));
    renderOverlay(); buildPropbar();
    inp.focus({ preventScroll: true });
    const pc = ui.pendingCaret; ui.pendingCaret = null;
    const placeCaret = () => {
      if (!pc || pc.id !== ln.id || inp.value !== (opts.prefill || ln.text) || !ui.lineEdit || ui.lineEdit.inp !== inp) return false;
      const rel = (pc.x - ln.x) * ui.zoom; const chars = Array.from(inp.value);
      let best = chars.length, bd = Infinity, acc = '';
      for (let i = 0; i <= chars.length; i++) { const w = lineMeasure.measureText(acc).width; if (Math.abs(w - rel) < bd) { bd = Math.abs(w - rel); best = i; } acc += chars[i] || ''; }
      const off = chars.slice(0, best).join('').length;
      inp.setSelectionRange(off, off); return true;
    };
    if (!placeCaret()) inp.setSelectionRange(inp.value.length, inp.value.length);
    else E.getLineEditorFont(pg, ln.id).then(() => setTimeout(() => { if (document.activeElement === inp && inp.selectionStart === inp.selectionEnd) { positionLineEditor(); placeCaret(); } }, 0)).catch(() => {});
  }
  const lineMeasure = document.createElement('canvas').getContext('2d');
  function positionLineEditor() {
    const le = ui.lineEdit; if (!le) return;
    const z = ui.zoom, ln = le.ln, f = le.font, st = le.style || {};
    const family = f ? f.family : 'sans-serif';
    const origBold = ln.style && ln.style.bold != null ? !ln.style.bold : !!ln.bold;
    const bold = st.bold != null ? st.bold : origBold;
    let weight = f ? f.weight : (bold ? 700 : 400);
    if (st.bold != null) weight = st.bold ? 700 : 400;
    const italic = st.italic != null ? st.italic : (ln.style && ln.style.italic != null ? !ln.style.italic : !!ln.italic);
    const origSize = ln.origSize || ln.size;
    const size = (st.size || origSize) * z;
    lineMeasure.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${family}`;
    const tw = lineMeasure.measureText(le.inp.value || ' ').width;
    const boxW = ln.w * z * (st.size ? st.size / (ln.size || origSize) : 1);
    const w = Math.max(boxW, tw) + size * 0.6 + 6;
    const align = st.align || (le.info && le.info.align) || 'left';
    let left = ln.x * z - 3;
    if (align === 'right') left = (ln.x + ln.w) * z - w - 3;
    else if (align === 'center') left = (ln.x + ln.w / 2) * z - w / 2 - 3;
    const h = Math.max(ln.h * z * (st.size ? st.size / (ln.size || origSize) : 1), 12);
    Object.assign(le.inp.style, {
      left: left + 'px', top: (ln.y + ln.h) * z - h + 'px', width: Math.ceil(w) + 'px', height: h + 'px',
      fontSize: size + 'px', lineHeight: h + 'px', fontFamily: family, fontWeight: String(weight),
      fontStyle: italic ? 'italic' : 'normal', color: st.color || ln.color || '#000', background: ln.bg || '#fff',
      textAlign: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
      fontSynthesis: st.bold != null || st.italic != null ? 'weight style' : '',   // preview a new weight / slant
    });
  }
  function closeLineEditor() {
    const le = ui.lineEdit; if (!le) return;
    ui.lineEdit = null;
    le.inp.remove();
    renderOverlay(); buildPropbar();
  }
  function cancelLineEdit() { if (ui.lineEdit && !ui.lineEdit.busy) closeLineEditor(); }
  async function commitLineEdit() {
    const le = ui.lineEdit; if (!le || le.busy) return;
    const text = le.inp.value;
    const pg = doc && doc.pages.find((p) => p.id === le.pageId);
    const styleChanged = JSON.stringify(le.style || {}) !== le.style0;
    if (!pg || ((text === le.ln.text || text === le.base) && !styleChanged)) { closeLineEditor(); return; }
    le.busy = true; le.inp.readOnly = true;
    const pchip = propbar.querySelector('.font-chip'); if (pchip) pchip.textContent = 'Matching fonts…';
    const snap = snapshot();
    let res;
    const eo = le.verified ? { verified: true, readingSource: le.source } : {};
    if (styleChanged) { eo.style = {}; ['size', 'bold', 'italic', 'color', 'align'].forEach((k) => { eo.style[k] = le.style[k] != null ? le.style[k] : null; }); }
    try { res = await E.editTextLine(doc, doc.pages.indexOf(pg), le.ln.id, text, Object.keys(eo).length ? eo : undefined); }
    catch (err) { console.error(err); res = { ok: false, message: 'Something went wrong while editing this line.' }; }
    closeLineEditor();
    if (res.ok) {
      pushHistory(snap);
      ui.lastEdit = res.edit ? { pageId: pg.id, label: res.edit.label, tier: res.edit.tier } : null;
      toast(res.message, 'ok');
      const i = doc.pages.indexOf(pg);
      if (i === ui.current) renderPage();
      refreshThumb(i);
    } else toast(res.message, 'error');
    buildPropbar(); updateChrome();
  }
  function refreshThumb(i) {
    const li = thumbList.children[i]; if (!li) return;
    const frame = li.querySelector('.thumb-frame'); const old = frame.querySelector('img');
    loadThumb(frame).then(() => { if (old && old.isConnected && frame.querySelectorAll('img').length > 1) old.remove(); });
  }

  /* ---------------- Property bar ---------------- */
  function buildPropbar() {
    propbar.replaceChildren();
    if (!doc) return;
    const s = selected();
    const editingText = ui.editing ? ui.editing.annot : null;
    const target = editingText || s;
    const kind = target ? target.type : ui.tool;
    const inner = document.createElement('div');
    inner.className = 'propbar-inner';
    const key = styleKey(kind);
    const st = ui.styles[key];

    // apply a style change to the target annotation (with history) and to tool defaults
    const apply = (prop, val, live) => {
      if (st && prop in st) st[prop] = val;
      if (editingText) { editingText[prop] = val; ui.editing.styleChanged = true; positionTextEditor(); return; }
      if (!s) return;
      if (live) { if (!ui.liveSnap) ui.liveSnap = snapshot(); }
      else if (!ui.liveSnap) { pushHistory(snapshot()); }
      s[prop] = val;
      if (!live && ui.liveSnap) { pushHistory(ui.liveSnap); ui.liveSnap = null; }
      renderOverlay(); updateThumbOverlay();
    };

    const hint = (icon, text) => {
      const h = document.createElement('span'); h.className = 'prop-hint';
      h.innerHTML = `<svg class="i"><use href="#${icon}"/></svg><span></span>`; h.lastChild.textContent = text; return h;
    };
    const sep = () => { const x = document.createElement('span'); x.className = 'prop-sep'; return x; };

    if (kind === 'edittext') {
      const data = ui.lines && doc && curPage() && ui.lines.pageId === curPage().id ? ui.lines.data : null;
      const sel = runSel();
      const addNudge = () => {
        const ids = sel.length ? sel : (ui.lineEdit ? [ui.lineEdit.ln.id] : []);
        const lns = data ? ids.map((id) => data.lines.find((l) => l.id === id)).filter(Boolean) : [];
        if (!lns.length || !lns.some((l) => l.movable)) return;
        inner.appendChild(sep());
        inner.appendChild(nudgePad((x, y) => nudgeRuns(x, y), 'Nudge the selected text'));
        const al = propBtn('i-line', 'Align to line', alignToLine); al.classList.add('align-line');
        al.addEventListener('mousedown', (e) => e.preventDefault()); inner.appendChild(al);
        if (lns.length > 1) { const ae = propBtn('i-layers', 'Align left edges', alignLeftEdges); ae.classList.add('align-left'); inner.appendChild(ae); }
        if (!isPhone()) inner.appendChild(hint('i-keyboard', ui.lineEdit ? 'Alt+arrows nudge 0.5 pt' : `Arrows nudge ${NUDGE} pt · Shift ${NUDGE_BIG} pt` + (lns.length < 2 ? ' · Shift-click to group' : ` · ${lns.length} runs`)));
      };
      if (ui.lineEdit) {
        if (!isPhone() && !ui.lineEdit.info) inner.appendChild(hint('i-text-edit', 'Type your change · Enter to apply · Esc to cancel'));
        const fc = fontChip(ui.lineEdit.ln.label || ('Original font: ' + ui.lineEdit.ln.fontLabel)); fc.title += ' · Enter to apply · Esc to cancel';
        inner.appendChild(fc);
        if (ui.lineEdit.info) lineStyleTools(inner, sep, hint);
        addNudge();
      } else if (!data) inner.appendChild(hint('i-text-edit', 'Reading the text on this page…'));
      else if (data.refusal) inner.appendChild(hint('i-help', data.refusal.message));
      else {
        if (!sel.length) inner.appendChild(hint('i-text-edit', isPhone() ? 'Tap a line of text to change it' : 'Click any outlined line of text to change it'));
        else inner.appendChild(fontChip(sel.length > 1 ? `${sel.length} runs selected` : (() => { const l = data.lines.find((x) => x.id === sel[0]); return l ? (l.bullet ? 'Bullet · ' : '') + (l.label || l.fontLabel) : ''; })()));
        addNudge();
        const stray = data.lines.filter((l) => l.strayBullet && l.movable);
        if (stray.length) {
          inner.appendChild(sep());
          const fb = propBtn('i-check', stray.length === 1 ? 'Fix bullet position' : `Fix all bullets (${stray.length})`, () => fixBullets(stray.map((l) => l.id)));
          fb.classList.add('fix-bullets'); inner.appendChild(fb);
        }
        if (!sel.length && ui.lastEdit && ui.lastEdit.pageId === curPage().id) inner.appendChild(fontChip(ui.lastEdit.label, ui.lastEdit.tier));
      }
    } else if (kind === 'select') {
      inner.appendChild(hint('i-select', isPhone() ? 'Tap an item to select · double-tap text to edit' : 'Click an annotation to select, drag to move · double-click text to edit'));
    } else if (kind === 'whiteout' && !target) {
      inner.appendChild(hint('i-eraser', 'Drag over content to cover it with white'));
    } else if (kind === 'image') {
      inner.appendChild(hint('i-image', 'Drag corners to resize'));
    } else if (kind === 'whiteout') {
      inner.appendChild(hint('i-eraser', 'White-out box · drag corners to resize'));
    } else {
      const cur = target ? target.color : st.color;
      inner.appendChild(colorPicker(kind === 'highlight' ? HL_PALETTE : PALETTE, cur, (c, live) => apply('color', c, live)));
      inner.appendChild(sep());
      if (kind === 'text') {
        const size = target ? target.size : st.size;
        const g = document.createElement('div'); g.className = 'stepper'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Font size');
        g.innerHTML = `<button type="button" class="icon-btn" aria-label="Decrease font size"><svg class="i"><use href="#i-minus"/></svg></button><output aria-live="polite">${Math.round(size)}</output><button type="button" class="icon-btn" aria-label="Increase font size"><svg class="i"><use href="#i-plus"/></svg></button>`;
        const out = g.querySelector('output');
        const step = (dir) => {
          const curS = (editingText || s || st).size;
          const sizes = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 96];
          let n = dir > 0 ? sizes.find((v) => v > curS + 0.1) : sizes.slice().reverse().find((v) => v < curS - 0.1);
          if (n == null) n = curS;
          apply('size', n); out.textContent = Math.round(n);
        };
        g.children[0].addEventListener('click', () => step(-1));
        g.children[2].addEventListener('click', () => step(1));
        inner.appendChild(labelled('Size', g));
        const bold = document.createElement('button');
        bold.type = 'button'; bold.className = 'icon-btn toggle-btn'; bold.setAttribute('aria-label', 'Bold'); bold.title = 'Bold';
        bold.setAttribute('aria-pressed', String(!!(target ? target.bold : st.bold)));
        bold.innerHTML = '<svg class="i"><use href="#i-bold"/></svg>';
        bold.addEventListener('mousedown', (e) => e.preventDefault()); // keep textarea focus
        bold.addEventListener('click', () => { const v = bold.getAttribute('aria-pressed') !== 'true'; bold.setAttribute('aria-pressed', String(v)); apply('bold', v); });
        inner.appendChild(bold);
        if (s && !editingText) {
          inner.appendChild(sep());
          const eb = propBtn('i-edit', 'Edit text', () => openTextEditor(s, false));
          inner.appendChild(eb);
        }
        // keep textarea focus while using the stepper
        g.querySelectorAll('button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
      } else {
        const ranges = { pen: [1, 24], highlight: [6, 48], shape: [1, 16] };
        const [mn, mx] = ranges[key];
        const val = target ? target.width : st.width;
        const r = document.createElement('label'); r.className = 'range';
        r.innerHTML = `<span class="prop-label">Size</span><input type="range" min="${mn}" max="${mx}" step="1" value="${val}" aria-label="Stroke thickness"><output>${val}px</output>`;
        const inp = r.querySelector('input'), out = r.querySelector('output');
        inp.addEventListener('input', () => { out.textContent = inp.value + 'px'; apply('width', +inp.value, true); });
        inp.addEventListener('change', () => apply('width', +inp.value, false));
        inner.appendChild(r);
      }
    }
    if (s && !editingText) {
      inner.appendChild(sep());
      inner.appendChild(nudgePad((x, y) => { commit(() => translate(s, x, y)); renderOverlay(); updateThumbOverlay(); }, 'Nudge the selected object'));
      inner.appendChild(sep());
      inner.appendChild(propBtn('i-copy', 'Duplicate', duplicateSelected));
      const del = propBtn('i-trash', 'Delete', deleteSelected); del.classList.add('danger');
      inner.appendChild(del);
    }
    propbar.appendChild(inner);
  }
  /** Text toolbar for an existing line: size, bold / italic (when the font family allows), colour, alignment. */
  function lineStyleTools(inner, sep, hint) {
    const le = ui.lineEdit, info = le.info, st = le.style;
    const keep = (b) => { b.addEventListener('mousedown', (e) => e.preventDefault()); return b; };   // keep the caret in the line
    const changed = () => { positionLineEditor(); buildPropbar(); };
    inner.appendChild(sep());
    const cur = () => st.size || le.ln.origSize || le.ln.size;
    const g = document.createElement('div'); g.className = 'stepper line-size'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Font size');
    g.innerHTML = `<button type="button" class="icon-btn" aria-label="Decrease font size"><svg class="i"><use href="#i-minus"/></svg></button><output aria-live="polite"></output><button type="button" class="icon-btn" aria-label="Increase font size"><svg class="i"><use href="#i-plus"/></svg></button>`;
    g.querySelector('output').textContent = (Math.round(cur() * 2) / 2).toString();
    const stepSize = (d) => { const v = Math.max(4, Math.min(144, Math.round((cur() + d) * 2) / 2)); st.size = Math.abs(v - (le.ln.origSize || le.ln.size)) < 0.01 ? null : v; if (st.size == null) delete st.size; changed(); };
    keep(g.children[0]).addEventListener('click', () => stepSize(-0.5));
    keep(g.children[2]).addEventListener('click', () => stepSize(0.5));
    inner.appendChild(labelled('Size', g));
    const tog = (icon, label, key, can, same) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn toggle-btn line-' + key;
      const val = st[key] != null ? st[key] : !!(le.ln[key]);
      b.setAttribute('aria-pressed', String(!!val)); b.setAttribute('aria-label', label);
      b.disabled = !can;
      b.title = !can ? `${label} isn’t available for this font` : same ? `${label} (same font family, already in this PDF)` : `${label} (uses a matching bundled font face)`;
      b.innerHTML = icon;
      keep(b).addEventListener('click', () => { const v = !(st[key] != null ? st[key] : !!le.ln[key]); st[key] = v; changed(); });
      return b;
    };
    inner.appendChild(tog('<svg class="i"><use href="#i-bold"/></svg>', 'Bold', 'bold', info.canBold, info.boldSameFont));
    inner.appendChild(tog('<span class="i-italic" aria-hidden="true">I</span>', 'Italic', 'italic', info.canItalic, info.italicSameFont));
    inner.appendChild(sep());
    const oc = String(le.info.origColor || '#000000').toLowerCase();
    const pal = [oc].concat(['#111827', '#e11d48', '#2563eb', '#16a34a'].filter((c) => c !== oc));
    const cp = colorPicker(pal, st.color || le.ln.color || '#000000', (c) => { st.color = c === oc ? null : c; if (st.color == null) delete st.color; positionLineEditor(); });
    cp.classList.add('line-color'); inner.appendChild(cp);
    inner.appendChild(sep());
    const al = document.createElement('div'); al.className = 'seg line-align'; al.setAttribute('role', 'radiogroup'); al.setAttribute('aria-label', 'Alignment');
    const curA = st.align || 'auto';
    [['auto', 'Auto', 'Keep the line’s own alignment (detected: ' + info.align + ')'], ['left', 'L', 'Align left (grow to the right)'], ['center', 'C', 'Centre (grow both ways)'], ['right', 'R', 'Align right (grow to the left)'], ['justify', 'J', 'Justify (keep the line’s width)']].forEach(([v, t, ttl]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-btn'; b.dataset.align = v; b.textContent = t; b.title = ttl;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(curA === v)); b.setAttribute('aria-label', ttl);
      keep(b).addEventListener('click', () => { if (v === 'auto') delete st.align; else st.align = v; changed(); });
      al.appendChild(b);
    });
    inner.appendChild(al);
  }
  function fontChip(text, tier) {
    const c = document.createElement('span'); c.className = 'font-chip' + (tier === 1 ? ' exact' : '');
    c.textContent = text; c.title = text; return c;
  }
  function labelled(text, el) {
    const w = document.createElement('div'); w.className = 'prop-group';
    const l = document.createElement('span'); l.className = 'prop-label'; l.textContent = text;
    w.append(l, el); return w;
  }
  function propBtn(icon, text, fn) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'prop-btn';
    b.innerHTML = `<svg class="i"><use href="#${icon}"/></svg><span></span>`; b.lastChild.textContent = text;
    b.setAttribute('aria-label', text); b.title = text;
    b.addEventListener('click', fn); return b;
  }
  function colorPicker(palette, current, onPick) {
    const wrap = document.createElement('div'); wrap.className = 'swatches'; wrap.setAttribute('role', 'radiogroup'); wrap.setAttribute('aria-label', 'Color');
    const lc = String(current).toLowerCase();
    palette.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'swatch'; b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c === lc)); b.setAttribute('aria-label', 'Color ' + c); b.title = c;
      b.innerHTML = `<span style="background:${c}"></span>`;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { $$('.swatch', wrap).forEach((x) => x.setAttribute('aria-checked', 'false')); b.setAttribute('aria-checked', 'true'); custom.classList.remove('active'); onPick(c, false); });
      wrap.appendChild(b);
    });
    const custom = document.createElement('label');
    custom.className = 'swatch-custom' + (palette.includes(lc) ? '' : ' active'); custom.title = 'Custom color';
    custom.innerHTML = `<span></span><input type="color" value="${/^#[0-9a-f]{6}$/i.test(lc) ? lc : '#000000'}" aria-label="Custom color">`;
    const ci = custom.querySelector('input');
    ci.addEventListener('input', () => { $$('.swatch', wrap).forEach((x) => x.setAttribute('aria-checked', 'false')); custom.classList.add('active'); onPick(ci.value, true); });
    ci.addEventListener('change', () => onPick(ci.value, false));
    wrap.appendChild(custom);
    return wrap;
  }

  /* ---------------- Images & signatures ---------------- */
  imageInput.addEventListener('change', async () => {
    const f = imageInput.files[0]; imageInput.value = '';
    if (!f) return;
    if (!/^image\/(png|jpe?g)$/i.test(f.type)) { toast('Please choose a PNG or JPG image', 'error'); return; }
    try {
      const url = await readFile(f, 'url');
      const img = await loadImage(url);
      const norm = normalizeImage(img, url, /png/i.test(f.type) ? 'png' : 'jpg');
      placeAsset(norm, false);
    } catch (e) { console.error(e); toast('Could not read that image', 'error'); }
  });
  function loadImage(url) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }
  function normalizeImage(img, url, kind) {
    const MAX = 2400;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) <= MAX) return { dataUrl: url, kind, w, h };
    const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return kind === 'png' ? { dataUrl: c.toDataURL('image/png'), kind, w, h } : { dataUrl: c.toDataURL('image/jpeg', 0.9), kind, w, h };
  }
  function visibleCenter() {
    const ds = E.displaySize(curPage());
    const vr = viewport.getBoundingClientRect(), wr = pageWrap.getBoundingClientRect();
    const x = (vr.left + vr.width / 2 - wr.left) / ui.zoom, y = (vr.top + vr.height / 2 - wr.top) / ui.zoom;
    return { x: clamp(x, 0, ds.w), y: clamp(y, 0, ds.h) };
  }
  function placeAsset(img, isSig) {
    if (!sigGate(() => placeAsset(img, isSig))) return;
    const assetId = E.uid('as');
    doc.assets[assetId] = { dataUrl: img.dataUrl, kind: img.kind };
    const ds = E.displaySize(curPage());
    let w = isSig ? Math.min(ds.w * 0.34, 190) : Math.min(ds.w * 0.4, img.w * 0.75);
    let h = w * img.h / img.w;
    if (h > ds.h * 0.5) { h = ds.h * 0.5; w = h * img.w / img.h; }
    const c = visibleCenter();
    const a = { id: E.uid('an'), type: 'image', asset: assetId, x: clamp(c.x - w / 2, 0, Math.max(0, ds.w - w)), y: clamp(c.y - h / 2, 0, Math.max(0, ds.h - h)), w, h };
    if (isSig) a.signature = true;
    commit(() => curPage().annots.push(a));
    setTool('select'); select(a.id); updateThumbOverlay();
    toast(isSig ? 'Signature added — drag to position it' : 'Image added — drag to position it', 'ok');
  }

  // Signature pad
  const sigDialog = $('#sigDialog'), sigPad = $('#sigPad');
  const sig = { color: SIG_COLORS[0], strokes: [], drawing: null, bounds: null };
  const sigColorsEl = $('#sigColors');
  SIG_COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(i === 0)); b.setAttribute('aria-label', 'Ink ' + c);
    b.innerHTML = `<span style="background:${c}"></span>`;
    b.addEventListener('click', () => { sig.color = c; $$('.swatch', sigColorsEl).forEach((x) => x.setAttribute('aria-checked', String(x === b))); redrawSig(); });
    sigColorsEl.appendChild(b);
  });
  function openSignature() {
    commitText();
    sig.strokes = []; sig.bounds = null;
    sigDialog.showModal();
    requestAnimationFrame(() => { sizeSigPad(); redrawSig(); });
  }
  function sizeSigPad() {
    const r = sigPad.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    sigPad.width = Math.round(r.width * dpr); sigPad.height = Math.round(r.height * dpr);
  }
  function redrawSig() {
    const ctx = sigPad.getContext('2d'), dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, sigPad.width, sigPad.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = sig.color; ctx.fillStyle = sig.color;
    sig.strokes.forEach((s) => drawStroke(ctx, s));
    $('#sigEmpty').hidden = sig.strokes.length > 0;
    $('#sigUse').disabled = sig.strokes.length === 0;
  }
  function drawStroke(ctx, s) {
    ctx.lineWidth = 2.6;
    if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0][0], s[0][1], 1.4, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath(); ctx.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length - 1; i++) ctx.quadraticCurveTo(s[i][0], s[i][1], (s[i][0] + s[i + 1][0]) / 2, (s[i][1] + s[i + 1][1]) / 2);
    ctx.lineTo(s[s.length - 1][0], s[s.length - 1][1]); ctx.stroke();
  }
  const sigPt = (e) => { const r = sigPad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  sigPad.addEventListener('pointerdown', (e) => {
    e.preventDefault(); sigPad.setPointerCapture(e.pointerId);
    sig.drawing = [sigPt(e)]; sig.strokes.push(sig.drawing); redrawSig();
  });
  sigPad.addEventListener('pointermove', (e) => {
    if (!sig.drawing) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    (evs.length ? evs : [e]).forEach((ev) => sig.drawing.push(sigPt(ev)));
    redrawSig();
  });
  ['pointerup', 'pointercancel'].forEach((t) => sigPad.addEventListener(t, () => { sig.drawing = null; }));
  $('#sigClear').addEventListener('click', () => { sig.strokes = []; redrawSig(); });
  $('#sigUse').addEventListener('click', () => {
    if (!sig.strokes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    sig.strokes.flat().forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
    const pad = 6, S = 3;
    const w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
    const c = document.createElement('canvas'); c.width = Math.ceil(w * S); c.height = Math.ceil(h * S);
    const ctx = c.getContext('2d');
    ctx.scale(S, S); ctx.translate(pad - x0, pad - y0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = sig.color; ctx.fillStyle = sig.color;
    sig.strokes.forEach((s) => drawStroke(ctx, s));
    sigDialog.close();
    placeAsset({ dataUrl: c.toDataURL('image/png'), kind: 'png', w: c.width, h: c.height }, true);
  });

  /* ---------------- Find & replace across PDFs ---------------- */
  // The open document plus any PDFs added here, each with its own state; matches are replaced with the same
  // edit-text tiers as a manual edit (original font first). Everything runs on this device.
  const fr = { files: [], hits: [], sel: new Set(), status: {}, active: null, query: '', opts: {}, notes: {}, searched: false };
  const findDialog = $('#findDialog'), findInput = $('#findInput');
  const frKey = (h) => h.fileId + '|' + h.id;
  function frSyncMain() {
    if (!doc) return;
    const m = fr.files.find((f) => f.main);
    if (!m || m.state !== doc) { fr.files = fr.files.filter((f) => !f.main); fr.files.unshift({ id: 'main', name: doc.name, state: doc, main: true, signed: !!ui.signature }); }
  }
  function openFind(prefill) {
    if (!doc) return;
    commitText(); cancelLineEdit();
    frSyncMain(); frRenderFiles(); frRenderResults();
    if (prefill) $('#findQuery').value = prefill;
    if (!findDialog.open) findDialog.showModal();
    setTimeout(() => $('#findQuery').focus(), 30);
  }
  $('#findBtn').addEventListener('click', () => openFind());
  $('#findClose').addEventListener('click', () => findDialog.close());
  $('#findAddBtn').addEventListener('click', () => findInput.click());
  $('#landingFindBtn').addEventListener('click', () => { ui.findFromLanding = true; findInput.click(); });
  findInput.addEventListener('change', async () => {
    const files = Array.from(findInput.files).filter(isPdf); findInput.value = '';
    if (!files.length) return;
    if (!doc) {                                    // from the home page: the first file opens in the editor
      await openFile(files.shift());
      if (!doc) return;
    }
    await frAddFiles(files);
    openFind();
  });
  async function frAddFiles(files) {
    frSyncMain();
    busy(true, 'Opening PDFs…');
    for (const f of files) {
      try {
        const res = await E.load(new Uint8Array(await readFile(f)), f.name);
        const st = E.createState(res.name); st.pages = res.pages;
        fr.files.push({ id: E.uid('fr'), name: res.name, state: st, main: false, signed: !!(res.signature && res.signature.signed) });
      } catch (e) { if (!e.userFacing) console.error(e); toast(e.message || `Could not open “${f.name}”`, 'error'); }
    }
    busy(false);
    frRenderFiles();
    if (fr.searched) frSearch();
  }
  function frRenderFiles() {
    const box = $('#findFileList'); box.replaceChildren();
    fr.files.forEach((f) => {
      const c = document.createElement('span'); c.className = 'find-file' + (f.main ? ' main' : ''); c.dataset.file = f.id;
      const n = document.createElement('span'); n.className = 'find-file-name'; n.textContent = f.name; n.title = f.name + (f.main ? ' (open in the editor)' : '');
      const m = document.createElement('span'); m.className = 'find-file-meta'; m.textContent = `${f.state.pages.length} p` + (f.signed ? ' · signed' : '') + (f.edited ? ' · edited' : '');
      c.append(n, m);
      if (!f.main) {
        const x = document.createElement('button'); x.type = 'button'; x.className = 'find-file-x'; x.setAttribute('aria-label', 'Remove ' + f.name); x.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
        x.addEventListener('click', () => { fr.files = fr.files.filter((q) => q !== f); fr.hits = fr.hits.filter((h) => h.fileId !== f.id); frRenderFiles(); frRenderResults(); });
        c.append(x);
      }
      box.append(c);
    });
    frRenderExport();
  }
  $('#findForm').addEventListener('submit', (e) => { e.preventDefault(); frSearch(); });
  async function frSearch() {
    const q = $('#findQuery').value;
    fr.query = q; fr.opts = { matchCase: $('#findCase').checked, wholeWord: $('#findWord').checked };
    fr.hits = []; fr.sel.clear(); fr.status = {}; fr.notes = {}; fr.active = null; fr.searched = !!q;
    if (!q) { frRenderResults(); return; }
    frSyncMain();
    $('#findSummary').textContent = 'Searching…';
    for (const f of fr.files) {
      let r;
      try { r = await E.findText(f.state, q, fr.opts); } catch (err) { console.error(err); r = { hits: [], notes: [{ pageIndex: -1, message: 'Pdfroo couldn’t search this file.' }] }; }
      r.hits.forEach((h) => { h.fileId = f.id; fr.hits.push(h); if (h.editable) fr.sel.add(frKey(h)); });
      fr.notes[f.id] = r.notes;
    }
    if (fr.hits.length) fr.active = frKey(fr.hits[0]);
    frRenderResults();
  }
  function frSnippet(h) {
    const t = h.lineText, a = Math.max(0, h.start - 28), b = Math.min(t.length, h.end + 28);
    const frag = document.createDocumentFragment();
    frag.append(document.createTextNode((a > 0 ? '…' : '') + t.slice(a, h.start)));
    const mk = document.createElement('mark'); mk.textContent = t.slice(h.start, h.end); frag.append(mk);
    frag.append(document.createTextNode(t.slice(h.end, b) + (b < t.length ? '…' : '')));
    return frag;
  }
  function frRenderResults() {
    const box = $('#findResults'); box.replaceChildren();
    const sum = $('#findSummary');
    const editable = fr.hits.filter((h) => h.editable).length, blocked = fr.hits.length - editable;
    if (!fr.searched) sum.textContent = fr.files.length > 1 ? `${fr.files.length} PDFs ready — type something to find.` : 'Add more PDFs to search them all at once.';
    else if (!fr.hits.length) sum.textContent = `No matches for “${fr.query}” in ${fr.files.length} PDF${fr.files.length === 1 ? '' : 's'}.`;
    else sum.textContent = `${fr.hits.length} match${fr.hits.length === 1 ? '' : 'es'} in ${new Set(fr.hits.map((h) => h.fileId)).size} of ${fr.files.length} PDF${fr.files.length === 1 ? '' : 's'}` + (blocked ? ` · ${blocked} can’t be replaced (reason shown)` : '');
    for (const f of fr.files) {
      const hs = fr.hits.filter((h) => h.fileId === f.id), notes = fr.notes[f.id] || [];
      if (!fr.searched || (!hs.length && !notes.length)) continue;
      const g = document.createElement('section'); g.className = 'find-group'; g.dataset.file = f.id;
      const hd = document.createElement('h3'); hd.className = 'find-group-head';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', 'Select all matches in ' + f.name);
      const eh = hs.filter((h) => h.editable && !(fr.status[frKey(h)] || {}).ok);
      cb.checked = eh.length > 0 && eh.every((h) => fr.sel.has(frKey(h))); cb.disabled = !eh.length;
      cb.addEventListener('change', () => { eh.forEach((h) => (cb.checked ? fr.sel.add(frKey(h)) : fr.sel.delete(frKey(h)))); frRenderResults(); });
      const nm = document.createElement('span'); nm.textContent = f.name;
      const ct = document.createElement('span'); ct.className = 'find-count'; ct.textContent = hs.length + (hs.length === 1 ? ' match' : ' matches');
      hd.append(cb, nm, ct); g.append(hd);
      notes.forEach((n) => { const d = document.createElement('div'); d.className = 'find-note'; d.textContent = (n.pageIndex >= 0 ? `Page ${n.pageIndex + 1}: ` : '') + n.message + (n.code === 'scan' || /scan/i.test(n.message) ? ' Its text can’t be searched.' : ''); g.append(d); });
      let lastPage = -1;
      for (const h of hs) {
        if (h.pageIndex !== lastPage) { const ph = document.createElement('div'); ph.className = 'find-page'; ph.textContent = 'Page ' + (h.pageIndex + 1); g.append(ph); lastPage = h.pageIndex; }
        const k = frKey(h), stt = fr.status[k];
        const row = document.createElement('div'); row.className = 'find-row' + (k === fr.active ? ' active' : '') + (!h.editable ? ' blocked' : '') + (stt ? (stt.ok ? ' done' : ' failed') : '');
        row.setAttribute('role', 'listitem'); row.dataset.key = k;
        const c = document.createElement('input'); c.type = 'checkbox'; c.className = 'find-chk'; c.setAttribute('aria-label', 'Select this match');
        c.checked = fr.sel.has(k); c.disabled = !h.editable || !!(stt && stt.ok);
        c.addEventListener('change', () => { c.checked ? fr.sel.add(k) : fr.sel.delete(k); frUpdateActions(); const gc = g.querySelector('.find-group-head input'); if (gc) gc.checked = eh.every((x) => fr.sel.has(frKey(x))); });
        const tx = document.createElement('div'); tx.className = 'find-text';
        const sn = document.createElement('div'); sn.className = 'find-snip';
        if (stt && stt.ok) { sn.textContent = stt.newText != null ? stt.newText : ''; } else sn.append(frSnippet(h));
        tx.append(sn);
        const why = stt ? (stt.ok ? 'Replaced · ' + (stt.label || stt.message || '') : 'Not replaced: ' + stt.message) : (!h.editable ? 'Can’t replace: ' + h.reason : '');
        if (why) { const w = document.createElement('div'); w.className = 'find-why'; w.textContent = why; tx.append(w); }
        row.append(c, tx);
        row.addEventListener('click', (e) => { if (e.target === c) return; fr.active = k; $$('.find-row.active', box).forEach((r) => r.classList.remove('active')); row.classList.add('active'); frPreview(); });
        g.append(row);
      }
      box.append(g);
    }
    frUpdateActions(); frPreview(); frRenderExport();
  }
  function frUpdateActions() {
    const n = [...fr.sel].filter((k) => !(fr.status[k] || {}).ok).length;
    const open = fr.hits.filter((h) => h.editable && !(fr.status[frKey(h)] || {}).ok).length;
    $('#findReplaceSel').disabled = !n; $('#findDelete').disabled = !n; $('#findReplaceAll').disabled = !open;
    $('#findReplaceSel').textContent = n ? `Replace selected (${n})` : 'Replace selected';
    $('#findDelete').textContent = n ? `Delete selected (${n})` : 'Delete selected';
    $('#findReplaceAll').textContent = open ? `Replace all (${open})` : 'Replace all';
    $('#findSelAll').disabled = !open;
  }
  $('#findSelAll').addEventListener('click', () => {
    const open = fr.hits.filter((h) => h.editable && !(fr.status[frKey(h)] || {}).ok);
    const all = open.every((h) => fr.sel.has(frKey(h)));
    open.forEach((h) => (all ? fr.sel.delete(frKey(h)) : fr.sel.add(frKey(h))));
    frRenderResults();
  });
  let frPrevToken = 0;
  async function frPreview() {
    const fig = $('#findPreview'), h = fr.hits.find((x) => frKey(x) === fr.active);
    if (!h) { fig.hidden = true; return; }
    const f = fr.files.find((q) => q.id === h.fileId); const pg = f && f.state.pages[h.pageIndex];
    if (!pg) { fig.hidden = true; return; }
    fig.hidden = false;
    $('#findPreviewTitle').textContent = `${f.name} · page ${h.pageIndex + 1}`;
    $('#findShowBtn').hidden = !f.main;
    const host = $('#findPreviewPage');
    const token = ++frPrevToken;
    const ds = E.displaySize(pg);
    const w = Math.max(200, host.clientWidth || 320), z = w / ds.w;
    const c = document.createElement('canvas');
    const hd = E.renderPage(pg, c, z, window.devicePixelRatio || 1);
    try { await hd.promise; } catch (err) { return; }
    if (token !== frPrevToken) return;
    const wrap = document.createElement('div'); wrap.className = 'find-page-wrap'; wrap.style.width = Math.round(ds.w * z) + 'px'; wrap.style.height = Math.round(ds.h * z) + 'px';
    const ov = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); ov.setAttribute('viewBox', `0 0 ${ds.w} ${ds.h}`); ov.setAttribute('class', 'find-hl');
    let activePoly = null;
    fr.hits.filter((x) => x.fileId === h.fileId && x.pageIndex === h.pageIndex).forEach((x) => {
      const k = frKey(x), stt = fr.status[k];
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      pl.setAttribute('points', x.poly.map((q) => q.join(',')).join(' '));
      pl.setAttribute('class', 'hl' + (k === fr.active ? ' active' : '') + (!x.editable ? ' blocked' : '') + (stt && stt.ok ? ' done' : ''));
      ov.append(pl); if (k === fr.active) activePoly = x.poly;
    });
    wrap.append(c, ov); host.replaceChildren(wrap);
    if (activePoly) { const y = Math.min(...activePoly.map((q) => q[1])) * z; host.scrollTop = Math.max(0, y - host.clientHeight / 2); }
  }
  $('#findShowBtn').addEventListener('click', () => {
    const h = fr.hits.find((x) => frKey(x) === fr.active); if (!h) return;
    findDialog.close(); goTo(h.pageIndex); setTool('edittext');
  });
  async function frReplace(mode) {
    const rep = mode === 'delete' ? '' : $('#findReplace').value;
    let targets = fr.hits.filter((h) => h.editable && !(fr.status[frKey(h)] || {}).ok && (mode === 'all' || fr.sel.has(frKey(h))));
    if (!targets.length) return;
    if (mode !== 'delete' && !rep && !confirm('The replacement is empty, so the matches will be deleted. Continue?')) return;
    const mainHits = targets.filter((h) => h.fileId === 'main');
    if (mainHits.length && !sigGate(() => frReplace(mode))) return;
    busy(true, `Replacing ${targets.length} match${targets.length === 1 ? '' : 'es'}…`);
    let ok = 0, bad = 0;
    try {
      for (const f of fr.files) {
        const hs = targets.filter((h) => h.fileId === f.id); if (!hs.length) continue;
        const snap = f.main ? snapshot() : null;
        const res = await E.replaceHits(f.state, hs, rep);
        res.forEach((r) => { const h = hs.find((x) => x.id === r.id); fr.status[frKey(h)] = r; r.ok ? ok++ : bad++; fr.sel.delete(frKey(h)); });
        if (res.some((r) => r.ok)) {
          f.edited = true;
          if (f.main) { pushHistory(snap); renderPage(); doc.pages.forEach((_, i) => refreshThumb(i)); }
        }
      }
    } catch (err) { console.error(err); toast('Something went wrong while replacing.', 'error'); }
    busy(false);
    toast(`${ok} replaced` + (bad ? ` · ${bad} couldn’t be replaced (see the reasons)` : ''), bad ? undefined : 'ok');
    frRenderFiles(); frRenderResults(); updateChrome();
  }
  $('#findReplaceSel').addEventListener('click', () => frReplace('selected'));
  $('#findReplaceAll').addEventListener('click', () => frReplace('all'));
  $('#findDelete').addEventListener('click', () => frReplace('delete'));
  function frRenderExport() {
    const box = $('#findExport'), list = $('#findExportFiles');
    const files = fr.files.filter((f) => f.edited || fr.files.length > 1);
    box.hidden = !fr.files.length || (!fr.files.some((f) => f.edited) && fr.files.length < 2);
    list.replaceChildren();
    files.forEach((f) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost btn-sm find-dl'; b.dataset.file = f.id;
      b.innerHTML = '<svg class="i"><use href="#i-download"/></svg><span></span>'; b.lastChild.textContent = frOutName(f);
      b.addEventListener('click', () => frDownload([f]));
      list.append(b);
    });
  }
  const frOutName = (f) => f.name.replace(/\.pdf$/i, '') + (f.edited ? '-edited' : '') + '.pdf';
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function frDownload(files, zip) {
    busy(true, zip ? 'Building the zip…' : 'Building your PDF…');
    try {
      const out = [];
      for (const f of files) out.push({ name: frOutName(f), data: await E.exportWithAnnotations(f.state) });
      if (zip) {
        const names = new Set();
        out.forEach((o) => { let n = o.name, i = 2; while (names.has(n)) n = o.name.replace(/\.pdf$/i, `-${i++}.pdf`); names.add(n); o.name = n; });
        saveBlob(new Blob([makeZip(out)], { type: 'application/zip' }), 'pdfroo-edited-pdfs.zip');
        toast(`Downloaded pdfroo-edited-pdfs.zip (${out.length} PDFs)`, 'ok');
      } else { out.forEach((o) => saveBlob(new Blob([o.data], { type: 'application/pdf' }), o.name)); toast(`Downloaded ${out.map((o) => o.name).join(', ')}`, 'ok'); }
      if (files.some((f) => f.main)) ui.dirty = false;
      coffeeToast();
    } catch (e) { console.error(e); toast('Export failed: ' + (e.message || e), 'error'); }
    finally { busy(false); }
  }
  $('#findZipBtn').addEventListener('click', () => frDownload(fr.files.slice(), true));
  /** Minimal zip writer (stored, no compression — PDFs are already compressed). files: [{name, data: Uint8Array}] */
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (d) => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF, dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0; all.forEach((b) => { out.set(b, p); p += b.length; });
    return out;
  }

  /* ---------------- Compress PDF ---------------- */
  // Images are re-encoded as JPEG with the browser's own encoder; text, fonts and vector drawings are kept as they are.
  // Everything runs on this device (js/engine/compress.js).
  const cmpDialog = $('#compressDialog'), cmpInput = $('#compressInput');
  const cmp = { result: null, srcBytes: null, docs: [null, null], page: 1, zoom: 1, running: false, token: 0 };
  const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 1 : 2).replace(/\.?0+$/, '') + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' bytes';
  function parseSize(t) {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*(kb|k|mb|m|b|bytes)?\s*$/i.exec(t || ''); if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.')), u = (m[2] || 'kb').toLowerCase();
    const n = Math.round(u[0] === 'm' ? v * 1048576 : u[0] === 'k' ? v * 1024 : v);
    return n >= 10240 ? n : null;                    // below 10 KB is never realistic for a PDF with content
  }
  function cmpReset() {
    cmp.token++; cmp.result = null; cmp.srcBytes = null;
    cmp.docs.forEach((d) => d && d.destroy().catch(() => {})); cmp.docs = [null, null];
    $('#compressResult').hidden = true; $('#compressProgress').hidden = true;
    $('#compressPaneA').replaceChildren(); $('#compressPaneB').replaceChildren();
  }
  function openCompress() {
    if (!doc) return;
    commitText(); cancelLineEdit();
    cmpReset();
    $('#compressSig').hidden = !ui.signature; $('#compressSigAck').checked = false;
    $('#compressGo').disabled = false;
    cmpSyncChips();
    if (!cmpDialog.open) cmpDialog.showModal();
  }
  function cmpSyncChips() {
    const t = parseSize($('#compressTarget').value);
    cmpDialog.querySelectorAll('.cmp-chip').forEach((c) => c.classList.toggle('on', t != null && parseSize(c.dataset.target) === t));
  }
  $('#compressBtn').addEventListener('click', () => openCompress());
  $('#compressClose').addEventListener('click', () => cmpDialog.close());
  cmpDialog.addEventListener('close', () => { if (!cmp.running) cmpReset(); });
  $('#landingCompressBtn').addEventListener('click', () => cmpInput.click());
  cmpInput.addEventListener('change', async () => {
    const f = Array.from(cmpInput.files).filter(isPdf)[0]; cmpInput.value = '';
    if (!f) return;
    await openFile(f);
    if (doc) openCompress();
  });
  cmpDialog.querySelectorAll('.cmp-chip').forEach((c) => c.addEventListener('click', () => {
    const inp = $('#compressTarget');
    inp.value = c.classList.contains('on') ? '' : c.dataset.target;   // tap again to clear
    cmpSyncChips();
  }));
  $('#compressTarget').addEventListener('input', () => { cmpSyncChips(); $('#compressTarget').removeAttribute('aria-invalid'); });
  $('#compressTarget').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runCompress(); } });
  $('#compressGo').addEventListener('click', () => runCompress());
  async function runCompress() {
    if (!doc || cmp.running) return;
    if (ui.signature && !$('#compressSigAck').checked) {
      toast('This PDF is signed — tick “I understand” to compress it (the signature will no longer be valid)', 'error');
      $('#compressSigAck').focus(); return;
    }
    const tv = $('#compressTarget').value.trim(); const target = tv ? parseSize(tv) : null;
    if (tv && !target) { $('#compressTarget').setAttribute('aria-invalid', 'true'); toast('Type a size like 200 KB or 1.5 MB (at least 10 KB)', 'error'); $('#compressTarget').focus(); return; }
    const preset = (cmpDialog.querySelector('input[name=cmpPreset]:checked') || {}).value || 'balanced';
    cmpReset(); const token = cmp.token;
    cmp.running = true; $('#compressGo').disabled = true;
    const bar = $('#compressBar'), pt = $('#compressProgressText');
    $('#compressProgress').hidden = false; bar.style.width = '4%'; pt.textContent = 'Preparing your PDF…';
    let n = 0;
    try {
      await new Promise((r) => setTimeout(r, 20));
      const src = await E.exportWithAnnotations(doc);
      const res = await window.FolioCompress.compress(src, {
        preset, target,
        onProgress: (msg) => { n++; pt.textContent = msg; bar.style.width = Math.min(94, 8 + n * 11) + '%'; },
      });
      if (token !== cmp.token) return;
      bar.style.width = '100%';
      cmp.result = res; cmp.srcBytes = src; cmp.preset = preset; cmp.target = target;
      await cmpShowResult();
    } catch (e) {
      if (!e.userFacing) console.error(e);
      toast(e.userFacing ? e.message : 'Could not compress this PDF: ' + (e.message || e), 'error');
    } finally {
      cmp.running = false; $('#compressGo').disabled = false;
      if (token === cmp.token) $('#compressProgress').hidden = true;
    }
  }
  async function cmpShowResult() {
    const r = cmp.result;
    $('#compressBefore').textContent = fmtSize(r.before);
    $('#compressAfter').textContent = fmtSize(r.after);
    const pct = Math.round((1 - r.after / r.before) * 100);
    const saved = $('#compressSaved');
    saved.textContent = pct > 0 ? `${pct}% smaller` : 'Already compact';
    saved.className = 'cmp-saved' + (cmp.target ? (r.reached ? ' ok' : ' warn') : '');
    let note = '';
    if (cmp.target) {
      note = r.reached
        ? `Fits your ${fmtSize(cmp.target)} limit.` + (r.dpi ? ` Images at ${r.dpi} dpi, quality ${Math.round(r.quality * 100)}.` : ' No image quality was lost.')
        : `Couldn’t reach ${fmtSize(cmp.target)}. ` + (r.explain || 'This is the smallest version Pdfroo can make.');
    } else if (r.dpi) note = `Images re-encoded at ${r.dpi} dpi, quality ${Math.round(r.quality * 100)}. Text and drawings are unchanged.`;
    else if (!r.images) note = 'This PDF has no images, so only lossless clean-up was possible (duplicate fonts and unused objects removed, streams compressed). Text-only PDFs are usually already small.';
    else note = 'The images are already well compressed, so only lossless clean-up was possible.' + (r.skipped.length ? ' Kept as is: ' + r.skipped.join(', ') + '.' : '');
    const extra = [];
    if (r.deduped) extra.push(`${r.deduped} duplicate object${r.deduped === 1 ? '' : 's'} merged`);
    if (r.removed) extra.push(`${r.removed} unused removed`);
    if (r.recompressed) extra.push(`${r.recompressed} image${r.recompressed === 1 ? '' : 's'} re-encoded`);
    if (extra.length) note += ' (' + extra.join(', ') + ')';
    if (ui.signature) note += ' The digital signature is not valid in the compressed copy.';
    $('#compressNote').textContent = note;
    $('#compressNote').classList.toggle('warn', !!(cmp.target && !r.reached));
    $('#compressResult').hidden = false;
    const base = doc.name.replace(/\.pdf$/i, '');
    $('#compressDownload').lastChild.textContent = `Download ${fmtSize(r.after)}`;
    $('#compressDownload').title = `Download ${base}-compressed.pdf`;
    const opt = { cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/', isEvalSupported: false, verbosity: 0 };
    const token = cmp.token;
    try {
      const [a, b] = await Promise.all([cmp.srcBytes, r.bytes].map((d) => window.pdfjsLib.getDocument(Object.assign({ data: d.slice() }, opt)).promise));
      if (token !== cmp.token) { a.destroy(); b.destroy(); return; }
      cmp.docs = [a, b]; cmp.page = Math.min(Math.max(1, ui.current + 1), b.numPages);
      // start on the page with the most image savings is hard to know; the current editor page is a sensible default
      await cmpRenderPage();
    } catch (e) { console.warn('compare preview failed', e); }
    $('#compressResult').scrollIntoView({ block: 'nearest' });
  }
  async function cmpRenderPage() {
    const [a, b] = cmp.docs; if (!a || !b) return;
    const n = b.numPages; cmp.page = Math.min(Math.max(1, cmp.page), n);
    $('#compressPageLbl').textContent = `Page ${cmp.page} / ${n}`;
    $('#compressPrev').disabled = cmp.page <= 1; $('#compressNext').disabled = cmp.page >= n;
    const token = cmp.token, pageNo = cmp.page, zoom = cmp.zoom;
    const panes = [$('#compressPaneA'), $('#compressPaneB')];
    const w = Math.max(120, panes[0].clientWidth - 2);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    await Promise.all([a, b].map(async (d, i) => {
      const pg = await d.getPage(pageNo);
      const vp1 = pg.getViewport({ scale: 1 });
      const scale = (w / vp1.width) * zoom;
      const vp = pg.getViewport({ scale: scale * dpr });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      c.style.width = Math.round(vp.width / dpr) + 'px'; c.style.height = Math.round(vp.height / dpr) + 'px';
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      if (token !== cmp.token || pageNo !== cmp.page || zoom !== cmp.zoom) return;
      const pane = panes[i]; const sx = pane.scrollLeft, sy = pane.scrollTop;
      pane.replaceChildren(c); pane.scrollLeft = sx; pane.scrollTop = sy;
      c.dataset.ready = '1';
    }));
  }
  $('#compressPrev').addEventListener('click', () => { cmp.page--; cmpRenderPage(); });
  $('#compressNext').addEventListener('click', () => { cmp.page++; cmpRenderPage(); });
  cmpDialog.querySelectorAll('.cmp-zoom .seg-btn').forEach((bt) => bt.addEventListener('click', () => {
    cmpDialog.querySelectorAll('.cmp-zoom .seg-btn').forEach((x) => x.classList.toggle('on', x === bt));
    const old = cmp.zoom; cmp.zoom = +bt.dataset.zoom;
    const pa = $('#compressPaneA'); const fx = (pa.scrollLeft + pa.clientWidth / 2) / Math.max(1, pa.scrollWidth), fy = (pa.scrollTop + pa.clientHeight / 2) / Math.max(1, pa.scrollHeight);
    cmpRenderPage().then(() => {                  // keep the same spot centred in both panes
      if (old === cmp.zoom) return;
      const p = $('#compressPaneA'); p.scrollLeft = fx * p.scrollWidth - p.clientWidth / 2; p.scrollTop = fy * p.scrollHeight - p.clientHeight / 2;
    });
  }));
  // synced scrolling between the two panes, so the same detail is always side by side
  (() => {
    const A = $('#compressPaneA'), B = $('#compressPaneB'); let lock = null;
    const sync = (from, to) => () => {
      if (lock && lock !== from) return; lock = from;
      to.scrollLeft = from.scrollLeft; to.scrollTop = from.scrollTop;
      clearTimeout(sync.t); sync.t = setTimeout(() => { lock = null; }, 80);
    };
    A.addEventListener('scroll', sync(A, B)); B.addEventListener('scroll', sync(B, A));
  })();
  $('#compressDownload').addEventListener('click', () => {
    if (!cmp.result) return;
    const name = doc.name.replace(/\.pdf$/i, '') + '-compressed.pdf';
    saveBlob(new Blob([cmp.result.bytes], { type: 'application/pdf' }), name);
    toast(`Downloaded ${name} (${fmtSize(cmp.result.after)})`, 'ok');
    coffeeToast();
  });
  $('#compressOpen').addEventListener('click', async () => {
    if (!cmp.result) return;
    if (ui.dirty && !confirm('Open the compressed copy? Your edits are included in it, but the current editing history will be replaced.')) return;
    const bytes = cmp.result.bytes.slice(), name = doc.name.replace(/\.pdf$/i, '') + '-compressed.pdf';
    cmpDialog.close();
    busy(true, 'Opening the compressed copy…');
    try { await openPdf(bytes, name); toast(`Opened ${name}`, 'ok'); }
    catch (e) { console.error(e); toast('Could not open the compressed copy: ' + (e.message || e), 'error'); }
    finally { busy(false); }
  });

  /* ---------------- Export ---------------- */
  async function download() {
    if (!doc) return;
    commitText();
    busy(true, 'Building your PDF…');
    try {
      const bytes = await E.exportWithAnnotations(doc);
      const src = doc.pages[0] && doc.pages[0].src;
      const orig = ui.signature && src != null ? E.getSourceBytes(src) : null;
      const sigKept = !!(orig && orig.length === bytes.length && orig.every((b, i) => b === bytes[i]));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = doc.name.replace(/\.pdf$/i, '') + '-edited.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      ui.dirty = false;
      if (ui.signature) toast(sigKept ? `Downloaded ${a.download} — unchanged, so the digital signature is still valid` : `Downloaded ${a.download} — note: the digital signature is no longer valid in this copy`, sigKept ? 'ok' : undefined);
      else toast(`Downloaded ${a.download}`, 'ok');
      coffeeToast();
    } catch (e) {
      console.error(e);
      toast('Export failed: ' + (e.message || e), 'error');
    } finally { busy(false); }
  }
  $('#downloadBtn').addEventListener('click', download);

  /* ---------------- Dialog: shortcuts ---------------- */
  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());

  /* ---------------- Keyboard shortcuts ---------------- */
  document.addEventListener('keydown', (e) => {
    if (!doc || editor.hidden) return;
    if (document.querySelector('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); download(); return; }
    if (mod && k === 'f') { e.preventDefault(); openFind(); return; }
    if (typing) return;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected()) { e.preventDefault(); deleteSelected(); return; }
    if (e.key === 'Escape') { if (runSel().length) { ui.runSel = null; renderOverlay(); buildPropbar(); return; } if (ui.selectedId) select(null); else if (ui.tool !== 'select') setTool('select'); closePanel(); return; }
    const s = selected();
    if (!s && ui.tool === 'edittext' && runSel().length && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) {
      e.preventDefault();
      const st = e.shiftKey ? NUDGE_BIG : NUDGE;
      nudgeRuns(k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0);
      return;
    }
    if (s && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) {
      e.preventDefault();
      const st = e.shiftKey ? NUDGE_BIG : NUDGE;
      const dx = k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, dy = k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0;
      commit(() => translate(s, dx, dy));
      renderOverlay(); updateThumbOverlay(); return;
    }
    if (k === 'arrowleft' || e.key === 'PageUp') { e.preventDefault(); goTo(ui.current - 1); return; }
    if (k === 'arrowright' || e.key === 'PageDown') { e.preventDefault(); goTo(ui.current + 1); return; }
    if (e.key === '+' || e.key === '=') { setZoom(ui.zoom * 1.25); return; }
    if (e.key === '-' || e.key === '_') { setZoom(ui.zoom / 1.25); return; }
    if (e.key === '0') { setZoom(0, true); return; }
    if (e.key === '?') { $('#helpDialog').showModal(); return; }
    const map = { v: 'select', t: 'text', x: 'edittext', p: 'pen', h: 'highlight', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout' };
    if (map[k]) { setTool(map[k]); return; }
    if (k === 'i') { imageInput.click(); return; }
    if (k === 's') { openSignature(); return; }
  });

  window.addEventListener('beforeunload', (e) => { if (doc && ui.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // Expose a tiny debug/testing surface (state is plain JSON).
  window.Folio = { getState: () => doc, ui, openPdf, exportBytes: () => E.exportWithAnnotations(doc), find: fr, makeZip, compress: cmp };
})();
