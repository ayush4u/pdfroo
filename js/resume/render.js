/* Pdfroo Resume Rebuild: JSON Resume -> ATS-safe PDF with pdf-lib + fontkit. Own MIT code.
 * Real text only, OFL fonts embedded as subsets (pdf-lib writes the ToUnicode map), ligatures off,
 * single column drawn top to bottom in reading order, contact details in the page body. */
(function (root) {
  'use strict';
  const BASE = (document.currentScript && document.currentScript.src.replace(/js\/resume\/render\.js.*$/, '')) || '';
  const A4 = [595.28, 841.89];
  const TEMPLATES = {
    modern: { label: 'Modern', reg: 'Lato-Regular', bold: 'Lato-Bold', accent: [0.659, 0.353, 0.122], bar: [0.91, 0.659, 0.404], name: 22, body: 9.5, head: 9.5, m: 46, gap: 12, align: 'left', rule: 'thin' },
    classic: { label: 'Classic', reg: 'Caladea-Regular', bold: 'Caladea-Bold', accent: [0.1, 0.1, 0.1], name: 21, body: 10, head: 10.5, m: 50, gap: 12, align: 'center', rule: 'full' },
    twocol: { label: 'Two Column', reg: 'Lato-Regular', bold: 'Lato-Bold', accent: [0.659, 0.353, 0.122], bar: [0.91, 0.659, 0.404], name: 21, body: 9.2, head: 9.2, m: 40, gap: 11, align: 'left', rule: 'thin', twoCol: true, ats: false, atsNote: 'Not ATS-safe: Workday-style parsers read straight across both columns and mix them up. Use Modern, Classic or Compact to apply.' },
    compact: { label: 'Compact', reg: 'Carlito-Regular', bold: 'Carlito-Bold', accent: [0.2, 0.2, 0.2], name: 17, body: 9, head: 9.5, m: 36, gap: 8, align: 'left', rule: 'thin' },
  };
  const fontCache = {};
  /* accent colour: WCAG contrast vs white >= 4.5, darkened automatically when needed */
  const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgbHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const contrast = (c) => 1.05 / (lum(c) + 0.05);
  function safeAccent(hex) {
    let c = hexRgb(hex); if (!c) return null;
    const orig = rgbHex(c); let k = 0;
    while (contrast(c) < 4.5 && k++ < 60) c = c.map((v) => v * 0.95);
    return { hex: rgbHex(c), darkened: rgbHex(c) !== orig, ratio: contrast(c) };
  }
  const ACCENTS = [['Pdfroo orange', '#a85a1f'], ['Navy', '#1f3a68'], ['Teal', '#0f6e6e'], ['Emerald', '#1e7a4c'], ['Burgundy', '#7f1d3a'], ['Slate', '#475569'], ['Royal blue', '#2747b8'], ['Charcoal', '#333333']];
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
  async function ensureFontkit() { if (!root.fontkit) await loadScript(BASE + 'vendor/fontkit.umd.min.js'); }
  function b64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function fontBytes(key) {
    if (fontCache[key]) return fontCache[key];
    fontCache[key] = (async () => {
      if (!(root.FolioFontData && root.FolioFontData[key])) await loadScript(BASE + 'vendor/fonts/edit/' + key + '.js');
      return b64(root.FolioFontData[key]);
    })();
    fontCache[key].catch(() => { delete fontCache[key]; });
    return fontCache[key];
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(d) { const m = /^(\d{4})-(\d{2})/.exec(d || ''); return m ? MON[+m[2] - 1] + ' ' + m[1] : (d || ''); }
  function range(a, b) { a = fmtDate(a); b = fmtDate(b); if (!a && !b) return ''; if (!a) return b; return a + ' – ' + (b || 'Present'); }
  const SNAME = () => root.ResumeModel.SECTION_NAMES;

  async function build(resume, opts) {
    opts = opts || {};
    const tid = TEMPLATES[opts.template || (resume.meta && resume.meta.pdfroo.template)] ? opts.template || resume.meta.pdfroo.template : 'modern';
    // opts.fit: { gap, lhK, m, body } overrides used by fitOnePage (template object itself is never changed)
    const T = Object.assign({ lhK: 1 }, TEMPLATES[tid], { id: tid }, opts.fit || {});
    if (opts.fit && opts.fit.body) T.head = Math.max(opts.fit.body, TEMPLATES[tid].head - (TEMPLATES[tid].body - opts.fit.body));
    const P = resume.meta.pdfroo, L = root.PDFLib;
    await ensureFontkit();
    const doc = await L.PDFDocument.create();
    doc.registerFontkit(root.fontkit);
    const feats = { liga: false, clig: false, dlig: false };
    const F = await doc.embedFont(await fontBytes(T.reg), { subset: true, features: feats });
    const FB = await doc.embedFont(await fontBytes(T.bold), { subset: true, features: feats });
    const cs = { r: new Set(F.getCharacterSet()), b: new Set(FB.getCharacterSet()) };
    const safe = (t, f) => { const set = f === FB ? cs.b : cs.r; return Array.from(String(t || '').replace(/[\u2028\n\r\t]+/g, ' ')).map((c) => set.has(c.codePointAt(0)) ? c : ({ '\u2019': "'", '\u2018': "'", '\u201c': '"', '\u201d': '"', '\u2022': '-', '\u20b9': 'Rs.' })[c] || (c.trim() ? '?' : ' ')).join(''); };
    const W = A4[0], H = A4[1], m = T.m, cw = W - 2 * m;
    const ink = L.rgb(0.2, 0.2, 0.2), soft = L.rgb(0.36, 0.36, 0.36);
    const A = P.accent ? safeAccent(P.accent) : null, ac = A ? hexRgb(A.hex).map((v) => v / 255) : null;
    const acc = ac ? L.rgb(...ac) : L.rgb(...T.accent), nameCol = ac ? acc : ink;
    const tint = (f) => L.rgb(...(ac || T.accent).map((v) => 1 - (1 - v) * f));
    const ruleCol = ac ? tint(0.35) : null;
    let page, y, pi = -1, CX = m, CW = cw; const pages = [];
    const newPage = () => { page = doc.addPage(A4); pages.push(page); pi = pages.length - 1; y = H - m; if (T.bar) page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: ac ? acc : L.rgb(...T.bar) }); };
    newPage();
    const need = (h) => { if (y - h < m) { if (pages[pi + 1]) { pi++; page = pages[pi]; y = H - m; } else newPage(); } };
    const wrap = (t, f, s, w) => {
      const words = safe(t, f).split(/\s+/).filter(Boolean), out = []; let ln = '';
      for (const wd of words) { const tt = ln ? ln + ' ' + wd : wd; if (f.widthOfTextAtSize(tt, s) <= w || !ln) ln = tt; else { out.push(ln); ln = wd; } }
      if (ln) out.push(ln); return out;
    };
    const text = (t, o) => {
      const f = o.bold ? FB : F, s = o.size || T.body, lh = s * (o.lh || 1.32) * T.lhK, x0 = o.x != null ? o.x : CX, w = o.w || (CX + CW - x0);
      for (const ln of wrap(t, f, s, w)) {
        need(lh); y -= lh;
        const tw = f.widthOfTextAtSize(ln, s);
        const x = o.align === 'center' ? CX + (CW - tw) / 2 : o.align === 'right' ? CX + CW - tw : x0;
        page.drawText(ln, { x, y: y + (lh - s) * 0.45, size: s, font: f, color: o.color || ink });
      }
    };
    const rowWithDate = (left, right, o) => {   // "Role, Company ........ 2020 – 2022" on one baseline, left text first
      const s = o.size || T.body, f = FB, rw = right ? F.widthOfTextAtSize(safe(right, F), s) : 0;
      const narrow = CW < 300, lines = wrap(left, f, s, narrow ? CW : CW - rw - 12), lh = s * 1.35 * T.lhK;
      lines.forEach((ln, i) => {
        need(lh); y -= lh;
        page.drawText(ln, { x: CX, y: y + (lh - s) * 0.45, size: s, font: f, color: ink });
        if (i === 0 && right && !narrow) page.drawText(safe(right, F), { x: CX + CW - rw, y: y + (lh - s) * 0.45, size: s, font: F, color: soft });
      });
      if (narrow && right) text(right, { color: soft, size: s - 0.5 });
    };
    // ---- header: photo, name, title, contact (all in the page body, never header/footer areas)
    const b = resume.basics;
    let photo = null;
    if (opts.photo && opts.photo.bytes && P.photoShape !== 'skip') {
      try { photo = opts.photo.type === 'image/png' ? await doc.embedPng(opts.photo.bytes) : await doc.embedJpg(opts.photo.bytes); } catch (e) { photo = null; }
    }
    const ps = T.id === 'compact' ? 46 : 58;
    let hx = m;
    const topY = y;
    if (photo) {
      const px = T.align === 'center' ? m : m, py = y - ps - 4;
      const sc = Math.max(ps / photo.width, ps / photo.height), iw = photo.width * sc, ih = photo.height * sc;
      page.pushOperators(L.pushGraphicsState());
      if (P.photoShape === 'square') page.pushOperators(L.rectangle(px, py, ps, ps), L.clip(), L.endPath());
      else { const k = 0.5523 * ps / 2, cx = px + ps / 2, cy = py + ps / 2, rr = ps / 2;
        page.pushOperators(L.moveTo(cx + rr, cy), L.appendBezierCurve(cx + rr, cy + k, cx + k, cy + rr, cx, cy + rr), L.appendBezierCurve(cx - k, cy + rr, cx - rr, cy + k, cx - rr, cy), L.appendBezierCurve(cx - rr, cy - k, cx - k, cy - rr, cx, cy - rr), L.appendBezierCurve(cx + k, cy - rr, cx + rr, cy - k, cx + rr, cy), L.closePath(), L.clip(), L.endPath()); }
      page.drawImage(photo, { x: px + (ps - iw) / 2, y: py + (ps - ih) / 2, width: iw, height: ih });
      page.pushOperators(L.popGraphicsState());
      hx = m + ps + 14;
    }
    const halign = photo ? 'left' : T.align;
    y -= 4;
    text(b.name || 'Your Name', { bold: true, size: T.name, x: hx, align: halign, lh: 1.15, color: nameCol });
    if (b.label) text(b.label, { bold: T.id === 'modern', size: T.body + 1, x: hx, align: halign, color: T.id === 'modern' && !ac ? acc : soft });
    const loc = [b.location && b.location.city, b.location && b.location.region].filter(Boolean).join(', ');
    const contact = [loc, b.email, b.phone, b.url, ...(b.profiles || []).map((p) => p.url)].filter(Boolean).join('  ·  ');
    if (contact) text(contact, { size: T.body - 0.5, x: hx, align: halign, color: soft });
    if (photo) y = Math.min(y, topY - ps - 8);
    y -= T.gap * 0.6;
    if (T.rule === 'full' || T.id === 'modern') { page.drawLine({ start: { x: m, y }, end: { x: W - m, y }, thickness: T.rule === 'full' ? 0.9 : 0.5, color: ac ? (T.rule === 'full' ? acc : ruleCol) : T.rule === 'full' ? ink : L.rgb(0.92, 0.85, 0.76) }); }
    // ---- sections in the user's order
    let curKey = null; const heading = (name) => {
      if (curKey && !written.includes(curKey)) written.push(curKey);
      need(T.gap + T.head * 1.2 * T.lhK + 5 + T.body * 1.4 * T.lhK); y -= T.gap;
      text(name.toUpperCase(), { bold: true, size: T.head, color: acc, lh: 1.2 });
      y -= 3; page.drawLine({ start: { x: CX, y }, end: { x: CX + CW, y }, thickness: T.rule === 'full' ? 0.7 : 0.4, color: ac ? (T.rule === 'full' ? acc : ruleCol) : T.rule === 'full' ? ink : L.rgb(0.9, 0.83, 0.74) }); y -= 2;
    };
    const bullets = (arr) => { for (const h of arr || []) if (String(h).trim()) { const s = T.body, x = CX + 10, bl = s * 1.32 * T.lhK; need(bl); const y0 = y; text(h, { x, size: s }); page.drawCircle({ x: CX + 3.5, y: y0 - bl + (bl - s) * 0.45 + s * 0.33, size: 1.3, color: ink }); } };
    const order = (P.order || root.ResumeModel.DEFAULT_ORDER);
    const S = SNAME(); const written = [];
    const SIDE = ['skills', 'education', 'languages', 'interests'];
    const mainKeys = T.twoCol ? order.filter((k) => !SIDE.includes(k)) : order, sideKeys = T.twoCol ? order.filter((k) => SIDE.includes(k)) : [];
    const bodyTop = y, sideX = m + cw * 0.68, sideW = cw * 0.32;
    if (T.twoCol) { CW = cw * 0.64; page.drawRectangle({ x: sideX - 10, y: m - 10, width: W - sideX + 10 - m + 10, height: bodyTop - m + 4, color: ac ? tint(0.08) : L.rgb(1, 0.953, 0.894) }); }
    const writeSections = (keys) => { for (const k of keys) {
      curKey = k;
      if (k === 'summary' && b.summary) { heading(S.summary); text(b.summary, {}); }
      else if (k === 'work' && resume.work.length) {
        heading(S.work);
        resume.work.forEach((w, i) => { if (i) y -= 4; rowWithDate([w.position, w.name].filter(Boolean).join(', '), range(w.startDate, w.endDate), {}); if (w.summary) text(w.summary, {}); bullets(w.highlights); });
      } else if (k === 'education' && resume.education.length) {
        heading(S.education);
        resume.education.forEach((e, i) => { if (i) y -= 3; rowWithDate([[e.studyType, e.area].filter(Boolean).join(' '), e.institution].filter(Boolean).join(', '), range(e.startDate, e.endDate), {}); if (e.score) text(e.score, { color: soft }); bullets(e.courses); });
      } else if (k === 'skills' && resume.skills.length) { heading(S.skills); text(resume.skills.map((s) => [s.name, ...(s.keywords || [])].filter(Boolean).join(', ')).join('  ·  '), {}); }
      else if (k === 'projects' && resume.projects.length) {
        heading(S.projects);
        resume.projects.forEach((p, i) => { if (i) y -= 3; rowWithDate(p.name || 'Project', range(p.startDate, p.endDate), {}); if (p.description) text(p.description, {}); bullets(p.highlights); });
      } else if (k === 'awards' && resume.awards.length) { heading(S.awards); bullets(resume.awards.map((a) => [a.title, a.awarder, a.date].filter(Boolean).join(', '))); }
      else if (k === 'languages' && resume.languages.length) { heading(S.languages); text(resume.languages.map((l) => l.language + (l.fluency ? ' (' + l.fluency + ')' : '')).join('  ·  '), {}); }
      else if (k === 'interests' && resume.interests.length) { heading(S.interests); text(resume.interests.map((l) => l.name).join('  ·  '), {}); }
    } };
    writeSections(mainKeys);
    curKey = null;
    for (const c of P.custom || []) if (c.text && c.text.replace(/[^A-Za-z0-9]/g, '').length >= 3 && c.keep !== false) { heading(c.title || 'Additional Information'); written.push('custom:' + (c.title || 'Additional Information')); bullets(c.text.split('\n')); }
    if (P.keepPersonal && P.personal && P.personal.text) { heading('Personal Details'); written.push('custom:Personal Details'); for (const ln of P.personal.text.split('\n')) text(ln, {}); }
    if (P.keepDeclaration && P.declaration && P.declaration.text) { heading('Declaration'); written.push('custom:Declaration'); text(P.declaration.text, {}); }
    const mainEnd = { y, pi };
    if (T.twoCol) {   // sidebar written AFTER the main column in the content stream
      pi = 0; page = pages[0]; y = bodyTop; CX = sideX; CW = sideW;
      const links = [b.url, ...(b.profiles || []).map((p) => p.url)].filter(Boolean);
      if (links.length) { heading('Links'); written.push('custom:Links'); for (const u of links) text(u, { size: T.body - 0.5 }); }
      writeSections(sideKeys);
    }
    doc.setTitle((b.name || 'Resume') + ' — Resume'); doc.setSubject('Resume'); doc.setCreator('Pdfroo'); doc.setProducer('Pdfroo (pdf-lib)'); doc.setLanguage('en');
    const bytes = await doc.save({ useObjectStreams: true });
    // how far the content runs onto its last page, as a share of the usable page height (for the "fit" hint)
    const lastY = T.twoCol && mainEnd.pi === pages.length - 1 ? mainEnd.y : y;
    const overflow = pages.length > 1 ? (H - m - lastY) / (H - 2 * m) + (pages.length - 2) : 0;
    return { bytes, pages: doc.getPageCount(), order: written.filter((k) => !k.startsWith('custom:')), written, overflow, fit: opts.fit || null };
  }

  /* ---- Fit to one page: section gap first, then line height, then margins (>= 34pt), then body in small steps (>= 9.5pt) ---- */
  const FIT_MIN = { gap: 8, lhK: 0.92, m: 34, body: 9.5 };
  function fitSteps(tid) {
    const T = TEMPLATES[tid] || TEMPLATES.modern, st = [], cur = {};
    const push = () => st.push(Object.assign({}, cur));
    for (let g = T.gap - 1; g >= Math.min(T.gap, FIT_MIN.gap); g--) { cur.gap = g; push(); }
    for (let k = 0.98; k >= FIT_MIN.lhK - 1e-9; k -= 0.02) { cur.lhK = +k.toFixed(2); push(); }
    for (let mm = T.m - 2; mm >= Math.min(T.m, FIT_MIN.m); mm -= 2) { cur.m = mm; push(); }
    if (T.m > FIT_MIN.m && cur.m !== FIT_MIN.m) { cur.m = FIT_MIN.m; push(); }
    for (let b = +(T.body - 0.1).toFixed(1); b >= FIT_MIN.body - 1e-9; b = +(b - 0.1).toFixed(1)) { cur.body = b; push(); }
    return st;
  }
  async function fitOnePage(resume, opts) {
    opts = opts || {};
    const tid = opts.template || resume.meta.pdfroo.template || 'modern';
    const base = await build(resume, Object.assign({}, opts, { fit: null }));
    if (base.pages <= 1) return Object.assign(base, { fitted: 'already' });
    const steps = fitSteps(tid);
    if (!steps.length) return Object.assign(base, { fitted: 'no' });
    const last = await build(resume, Object.assign({}, opts, { fit: steps[steps.length - 1] }));
    if (last.pages > 1) return Object.assign(base, { fitted: 'no', basePages: base.pages });   // can't: keep the normal 2-page layout
    let lo = 0, hi = steps.length - 1, best = last;     // smallest change that fits (page count only drops as steps go on)
    while (lo < hi) { const mid = (lo + hi) >> 1; const o = await build(resume, Object.assign({}, opts, { fit: steps[mid] })); if (o.pages <= 1) { hi = mid; best = o; } else lo = mid + 1; }
    return Object.assign(best, { fitted: 'yes', basePages: base.pages });
  }

  /* ---- "See what recruiters' software sees": plain text via pdf.js + 4 checks ---- */
  async function atsCheck(bytes, resume, writtenOrder) {
    const pdf = await root.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    let txt = ''; const rows = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i), H = pg.view[3], tc = await pg.getTextContent();
      for (const it of tc.items) {
        txt += it.str + (it.hasEOL ? '\n' : '');
        if (!it.str.trim()) continue;
        const y = it.transform[5]; let r = rows.find((q) => q.p === i && Math.abs(q.y - y) < 2);   // join each line's pieces
        if (!r) { r = { p: i, y, H, s: '' }; rows.push(r); } r.s += it.str;
      }
      txt += '\n';
    }
    await pdf.destroy();
    txt = txt.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const flat = txt.replace(/\s+/g, ' '), low = flat.toLowerCase(), nos = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
    const b = resume.basics, S = SNAME();
    const order = (writtenOrder || resume.meta.pdfroo.order).filter((k) => k === 'summary' ? b.summary : (resume[k] || []).length);
    const real = flat.replace(/\s/g, '').length > 40 && (!b.name || low.includes(b.name.toLowerCase().replace(/\s+/g, ' '))) && !/\ufffd/.test(txt);
    const ci = [b.email, b.phone].filter(Boolean);
    const contact = ci.every((c) => rows.some((r) => nos(r.s).includes(nos(c)) && r.p === 1 && r.y > 40 && r.y < r.H - 30));
    let at = -1, ordered = true;
    const find = (t) => { const k = String(t).replace(/\s+/g, ' ').trim().slice(0, 40); const i = flat.indexOf(k, Math.max(0, at)); return i; };
    for (const mk of [b.name, ...order.map((k) => S[k].toUpperCase())].filter(Boolean)) { const i = find(mk); if (i < 0) { ordered = false; break; } at = i; }
    at = -1; for (const w of resume.work) { if (!w.position) continue; const i = find(w.position); if (i < 0) { ordered = false; break; } at = i; }
    const std = order.every((k) => flat.includes(S[k].toUpperCase()));
    // round trip: our own extractor over the generated PDF vs what was typed
    const lost = [];
    try {
      const E = root.PdfEngine, res = await E.load(bytes.slice(0), 'check.pdf');
      const o = await root.ResumeExtract.extract(res.src, bytes, { photo: false, ocr: false });
      const g = o.resume || { basics: {}, work: [], skills: [] };
      if (b.email && (g.basics.email || '').toLowerCase() !== b.email.toLowerCase()) lost.push('email');
      if (b.phone && (g.basics.phone || '').replace(/\D/g, '') !== b.phone.replace(/\D/g, '')) lost.push('phone');
      const gt = nos((g.work || []).map((w) => w.position + ' ' + w.name).join(' ') + ' ' + (g.projects || []).map((p) => p.name).join(' '));
      for (const w of resume.work) {
        if (w.position && !gt.includes(nos(w.position)) && !nos(flat).includes(nos(w.position))) lost.push('job title “' + w.position + '”');
        const d = range(w.startDate, w.endDate); if (d && !nos(flat).includes(nos(d))) lost.push('dates of “' + (w.position || w.name) + '”');
      }
      const gs = nos((g.skills || []).map((x) => x.name).join(' ') + ' ' + flat);
      for (const sk of resume.skills) if (sk.name && !gs.includes(nos(sk.name))) lost.push('skill “' + sk.name + '”');
    } catch (e) { lost.push('round-trip read failed'); }
    return { text: txt, lost, checks: [
      { id: 'text', label: 'Real text, not images', ok: real },
      { id: 'contact', label: 'Contact details in the page body', ok: contact || !ci.length, warn: !ci.length },
      { id: 'order', label: 'Reads in the right order', ok: ordered },
      { id: 'names', label: 'Standard section names', ok: std },
      { id: 'roundtrip', label: lost.length ? 'Read back: ' + lost.slice(0, 4).join(', ') + (lost.length > 4 ? ' +' + (lost.length - 4) + ' more' : '') + ' lost' : 'Read back: email, phone, skills, jobs and dates all found', ok: !lost.length },
    ] };
  }
  root.ResumeRender = { safeAccent, ACCENTS, build, fitOnePage, fitSteps, FIT_MIN, atsCheck, TEMPLATES, fmtDate, range };
})(window);
