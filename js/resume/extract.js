/* Pdfroo Resume Rebuild: PDF -> JSON Resume + photo, with per-field confidence. Own MIT code (ideas only from public
 * resume-parsing write-ups; no AGPL code). Reuses the editor engine's line analysis (PdfEngine._analyzePage), its hidden-text
 * rule (PdfEngine._pageGeometry: Tr 3/7, white-on-white, clipped out) and its row/column grouping (FolioReflow). */
(function (root) {
  'use strict';
  const M = () => root.ResumeModel;
  const DICT = {
    summary: ['summary', 'profile', 'professional summary', 'objective', 'career objective', 'about me', 'profile summary', 'professional profile', 'career summary', 'about'],
    work: ['experience', 'work experience', 'employment history', 'professional experience', 'internships', 'internship', 'industrial training', 'employment', 'work history', 'relevant experience', 'experience summary'],
    education: ['education', 'academic qualifications', 'educational qualification', 'educational qualifications', 'scholastic record', 'academics', 'academic details', 'qualifications', 'academic background', 'education and training'],
    skills: ['skills', 'technical skills', 'key skills', 'core competencies', 'areas of expertise', 'it skills', 'skill set', 'skills & abilities', 'skills and abilities', 'technologies', 'tools', 'computer skills', 'soft skills', 'strengths', 'expertise', 'languages and technologies', 'programming skills'],
    projects: ['projects', 'academic projects', 'major project', 'minor project', 'personal projects', 'key projects', 'project'],
    awards: ['certifications', 'certificates', 'achievements', 'awards', 'honors', 'honours', 'honors & awards', 'awards and achievements', 'grants and awards', 'extra-curricular activities', 'extracurricular activities', 'extra curricular activities', 'positions of responsibility', 'por', 'activities', 'accomplishments', 'leadership', 'training', 'courses', 'trainings'],
    languages: ['languages known', 'languages', 'language'],
    interests: ['hobbies', 'interests', 'hobbies and interests', 'hobbies & interests'],
    other: ['references', 'referees', 'selected publications', 'publications', 'volunteer', 'volunteering', 'misc', 'miscellaneous', 'additional information', 'other', 'research', 'patents', 'talks'],
    personal: ['personal details', 'personal information', 'personal profile', 'personal data', 'personal info'],
    declaration: ['declaration'],
  };
  const HEAD = new Map(); for (const k in DICT) for (const w of DICT[k]) HEAD.set(w, k);
  const HEADNS = new Map(); for (const [w, k] of HEAD) if (!HEADNS.has(w.replace(/ /g, ''))) HEADNS.set(w.replace(/ /g, ''), k);   // letter-spaced headings
  const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const D1 = `(?:${MON}\\s*,?\\s*'?\\d{2,4}|\\d{1,2}[/.]\\d{2,4}|(?:19|20)\\d{2})`;
  // Indic date words ("2021 – वर्तमान"). Broken text layers drop the virama/repha, vowel signs or split words with spaces
  // ("वत मान", "वतमान", "वरतमान"), so words are compared on a skeleton: NFC, vowel signs / virama / nukta / anusvara / ZWJ / spaces
  // removed; a reference word's repha or half-ra (र्) may also be missing. Same Devanagari block as PdfEngine.hasIndic/indicMalformed.
  const DEV_MARKS = /[\u0900-\u0903\u093A-\u094F\u0951-\u0957\u0962\u0963\u200B-\u200D\s]/g;
  const devSkel = (t) => String(t || '').normalize('NFC').replace(DEV_MARKS, '');
  const NOW_SKELS = new Set(['वर्तमान', 'वर्तमान तक', 'अब तक', 'आज तक', 'अभी तक', 'अद्यतन', 'जारी'].flatMap((w) => [devSkel(w), devSkel(w.replace(/र्(?=[\u0915-\u0939])/g, ''))]));
  /** the leading words of `t` that read as a "present" word ("वत मान 2024" -> "वत मान"), or null */
  const devNow = (t) => { const ws = String(t || '').trim().split(/\s+/); for (let n = Math.min(ws.length, 4); n >= 1; n--) { const w = ws.slice(0, n).join(' '); if (/^[\u0900-\u097F\u200C\u200D ]+$/.test(w) && NOW_SKELS.has(devSkel(w))) return w; } return null; };
  const DEV_RUN = '[\\u0900-\\u097F](?:[\\u0900-\\u097F\\u200C\\u200D]|\\s+(?=[\\u0900-\\u097F]))*';
  const RANGE_RE = new RegExp(`(${D1})\\s*(?:-|‐|‑|−|–|—|to|till|until)\\s*(${D1}|present|current|till date|now|ongoing|today|${DEV_RUN}|\\d{2}\\b)`, 'i');
  const RANGE_LAT_RE = new RegExp(RANGE_RE.source.replace('|' + DEV_RUN, ''), 'i');
  const SINGLE_RE = new RegExp(`(${D1})`, 'i');
  const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
  const PHONE_IN = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/;
  const PHONE_ANY = /\+?\(?\d[\d\s().-]{8,}\d/;
  const URL_RES = [/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w%-]+\/?/i, /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i, /https?:\/\/[^\s|,]+/i];
  // bare domain with a real TLD, optional path; not part of an email, not a file name like Node.js
  const BARE_URL_RE = /(?:^|[^\w@./-])((?:www\.)?[a-z0-9][\w-]*(?:\.[\w-]+)*\.(?:com|io|in|dev|me|org|net|co|xyz|site|app|ai|tech|page|github\.io|vercel\.app|netlify\.app)(?:\/[^\s|,·()]*)?)(?=$|[\s|·,)])/gi;
  const BULLET_STRIP = /^\s*(?:[•\-–—▪◦●○■□➢➤►▸*·‣⁃✓✔]|\(?\d{1,2}[.)]|[a-z][.)](?=\s))\s*/;
  const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const yr = (y) => { y = String(y).replace(/\D/g, ''); return y.length === 2 ? (+y > 50 ? '19' : '20') + y : y; };
  function normDate(s, ref) {
    s = String(s || '').trim().toLowerCase().replace(/'/g, '');
    if (!s || /present|current|till|now|ongoing|today/.test(s) || devNow(s)) return '';
    let m = s.match(/^([a-z]{3})[a-z]*\.?\s*,?\s*(\d{2,4})$/); if (m && MONTHS[m[1]]) return yr(m[2]) + '-' + MONTHS[m[1]];
    m = s.match(/^(\d{1,2})[/.](\d{2,4})$/); if (m) return yr(m[2]) + '-' + String(m[1]).padStart(2, '0');
    m = s.match(/^\d{4}$/); if (m) return s;
    m = s.match(/^\d{2}$/); if (m && ref) return String(ref).slice(0, 2) + s;   // Indian academic "2019-23"
    return s;
  }
  function findRange(t) {
    let m = RANGE_RE.exec(t);
    if (m && /^[\u0900-\u097F]/.test(m[2])) {   // an Indic word after the dash: a range only if it reads as "present"
      const w = devNow(m[2]);
      if (w) return { start: normDate(m[1]), end: '', raw: m[0].slice(0, m[0].length - m[2].length) + w, present: true };
      m = RANGE_LAT_RE.exec(t);
    }
    if (m) { const a = normDate(m[1]); return { start: a, end: normDate(m[2], a), raw: m[0], present: /present|current|till|now|ongoing|today/i.test(m[2]) }; }
    const s = SINGLE_RE.exec(t); if (s && /(?:19|20)\d{2}/.test(s[0])) return { start: '', end: normDate(s[1]), raw: s[0], single: true };
    return null;
  }
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').replace(/\s+([,;:])/g, '$1').trim();
  const CITY_RE = /^(?:Mumbai|Pune|Delhi|New Delhi|Bengaluru|Bangalore|Hyderabad|Chennai|Kolkata|Noida|Gurgaon|Gurugram|Ahmedabad|Jaipur|Kochi|Indore|Lucknow|Chandigarh|Nagpur|Remote|Thane|Navi Mumbai|Coimbatore|Bhopal|Goa|London|Singapore|Dubai|[A-Z][a-z]+,\s*[A-Z]{2})$/;
  /** drop empty/repeated separators left after taking out dates and places: "A • • OP" -> "A" */
  const tidy = (t) => { let s = clean(t); for (let i = 0; i < 4; i++) s = s.replace(/\s*(?:\(\s*[-–—,]?\s*\)|\[\s*[-–—,]?\s*\])/g, '').replace(/(?:\s*(?:[•·|–—]|\s-\s)\s*){2,}/g, ' · ').replace(/^\s*(?:[•·|,–—-]\s*)+|(?:\s*[•·|,–—-])+\s*$/g, '').trim(); return s; };
  const headKey = (t) => {
    let s = clean(t);
    if (/^(?:[A-Za-z&] ){3,}[A-Za-z&]$/.test(s)) { s = s.replace(/ /g, ''); const k = HEADNS.get(s.toLowerCase()); if (k) return k; }   // letter-spaced "E X P E R I E N C E" / "W O R K E X P E R I E N C E"
    // letter-spaced with kerned pairs left joined ("S U M M A RY", "E D U C AT I O N", "AWA R D S"): match the heading with spaces ignored
    else if (/^(?:[A-Za-z&]{1,3} ){3,}[A-Za-z&]{1,3}$/.test(s) && s.split(' ').filter((w) => w.length === 1).length >= 0.6 * s.split(' ').length) { const k = HEADNS.get(s.replace(/ /g, '').toLowerCase()); if (k) return k; }
    s = s.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[:：|\-–—_•.]+$/, '').replace(/^[^a-z]+/, '').replace(/\s+/g, ' ').trim();
    if (HEAD.has(s)) return HEAD.get(s);
    if (/[\/|]/.test(s)) { for (const part of s.split(/\s*[\/|]\s*/)) { const k = part && headKey(part); if (k) return k; } }   // bilingual "Experience / अनुभव"
    const s2 = s.replace(/&/g, 'and'); if (HEAD.has(s2)) return HEAD.get(s2);
    return null;
  };

  /* ---------- lines in reading order (engine geometry) ---------- */
  function probeBox(l) { return [l.x, l.y + (l.desc || -0.2) * l.size, l.x + l.width, l.y + (l.asc || 0.8) * l.size]; }
  async function pageLines(src, index) {
    const E = root.PdfEngine, RF = root.FolioReflow;
    const an = await E._analyzePage(src, index);
    let geo = null; try { geo = await E._pageGeometry(src, index); } catch (e) { geo = null; }
    const hid = geo ? (geo.texts || []).filter((t) => t.hidden) : [], vis = geo ? (geo.texts || []).filter((t) => !t.hidden && !t.rot) : [];
    const view = an.page.view, H = view[3] - view[1], W = view[2] - view[0];
    const lines = (an.lines || []).filter((l) => {
      if (!clean(String(l.text).replace(/[\u0000-\u001f\ufffd]+/g, '')) || l.size < 2) return false;
      if (/invisible text layer|hidden underneath an image/.test(l.reason || '')) return false;   // same rule as the clip check
      if (!hid.length) return true;
      const pb = probeBox(l);
      const hit = (t) => { const cy = (t.box[1] + t.box[3]) / 2; return Math.abs(cy - (pb[1] + pb[3]) / 2) < 0.45 * l.size && Math.min(t.box[2], pb[2]) - Math.max(t.box[0], pb[0]) > 0.2 * l.size; };
      return !hid.some(hit) || vis.some(hit);
    });
    const rows = RF.buildRows(lines, 2.2);
    const sizes = {}; lines.forEach((l) => { const k = Math.round(l.size * 2) / 2; sizes[k] = (sizes[k] || 0) + clean(l.text).length; });
    const body = +Object.keys(sizes).sort((a, b) => sizes[b] - sizes[a])[0] || 10;
    // columns: one gutter (sidebar layouts); rows crossing it are full-width bands (the header)
    let cols = [rows];
    const gs = rows.length >= 8 ? RF.columnGutters(rows, -1e9, 1e9, Math.max(8, 0.9 * body)) : [];
    let g = gs.filter((x) => x.left >= 4 && x.right >= 4 && x.mid > view[0] + 0.18 * W && x.mid < view[0] + 0.82 * W).sort((a, b) => (b.left + b.right) - (a.left + a.right))[0];
    // a "gutter" between left text and right-aligned dates on the SAME baselines is a table row ("Role, Company ..... 2019 - Present"),
    // not a sidebar: reject it when most rows on the narrow side are dates sitting next to a row on the other side
    if (g) {
      const lf = rows.filter((r) => r.x1 <= g.a + 0.5), rt = rows.filter((r) => r.x0 >= g.b - 0.5);
      const nar = (Math.max(0, ...lf.map((r) => r.x1 - r.x0)) >= Math.max(0, ...rt.map((r) => r.x1 - r.x0))) ? rt : lf, wide = nar === rt ? lf : rt;
      const dateRow = (r) => (findRange(r.text) || /^\s*(?:present|current)\s*$/i.test(r.text)) && clean(r.text).split(/\s+/).length <= 7;
      const beside = nar.filter((r) => wide.some((q) => Math.abs(q.y - r.y) <= 0.3 * Math.max(q.size, r.size))), paired = beside.filter(dateRow);
      // also a table when nearly every narrow-side row shares a baseline with the other side and several are dates
      // (a skills grid "Languages | Frameworks | Infrastructure" above "Role at Company ..... dates" rows)
      if (nar.length && (paired.length >= 0.6 * nar.length || (paired.length >= 2 && beside.length >= 0.8 * nar.length))) g = null;
    }
    if (g) {
      const cross = rows.filter((r) => r.x0 < g.a - 0.5 && r.x1 > g.b + 0.5);
      const crossTop = cross.length ? Math.min(...cross.map((r) => r.y)) : null;
      const head = cross.filter((r) => r.y >= crossTop);
      const L = rows.filter((r) => r.x1 <= g.a + 0.5 && !head.includes(r)), R = rows.filter((r) => r.x0 >= g.b - 0.5 && !head.includes(r));
      const rest = rows.filter((r) => !head.includes(r) && !L.includes(r) && !R.includes(r));
      const hdr = head.concat(rest.filter((r) => r.y > Math.max(...L.concat(R).map((q) => q.y), -1e9)));
      const tail = rest.filter((r) => !hdr.includes(r));
      // main (wider) column first, sidebar after: matches how ATS-safe output is written
      const wL = Math.max(...L.map((r) => r.x1 - r.x0), 0), wR = Math.max(...R.map((r) => r.x1 - r.x0), 0);
      cols = wL >= wR ? [hdr, L, R, tail] : [hdr, R, L, tail];
      cols.colSplit = true;
    }
    const out = [];
    cols.forEach((cr, ci) => {
      const sorted = cr.slice().sort((p, q) => q.y - p.y || p.x0 - q.x0);
      const merged = [];
      for (const r of sorted) {   // same baseline in one column = one logical line ("Role, Company      2020 - 2022")
        const m = merged[merged.length - 1];
        if (m && Math.abs(m.y - r.y) <= 0.3 * Math.max(m.size, r.size)) { m.parts.push(r); m.x1 = Math.max(m.x1, r.x1); m.size = Math.max(m.size, r.size); m.bold = m.bold && r.bold; continue; }
        merged.push({ parts: [r], y: r.y, x0: r.x0, x1: r.x1, size: r.size, bold: r.bold, top: r.top, bottom: r.bottom });
      }
      let prev = null;
      for (const m of merged) {
        m.parts.sort((p, q) => p.x0 - q.x0);
        // pieces of one row that interleave ("Site Engineer … Ltd" + "—" inside it, "2021 वत मान" + the "–" before "वत") are put back
        // in x order; otherwise "2021 – वर्तमान" reads "2021 वत मान –"
        for (let k = 1; k < m.parts.length; k++) {
          const a = m.parts[k - 1], b = m.parts[k];
          if (Math.abs(a.size - b.size) <= 0.15 * Math.max(a.size, b.size) && Math.abs(a.y - b.y) <= 0.15 * Math.max(a.size, b.size) && b.x0 < a.x1 - 0.5) {
            const ls = a.lines.concat(b.lines).sort((p, q) => p.x - q.x);
            m.parts.splice(k - 1, 2, Object.assign({}, a, { lines: ls, x1: Math.max(a.x1, b.x1), text: ls.map((l) => l.text).join(' ').trim() })); k--;
          }
        }
        const text = clean(m.parts.map((p) => p.text).join('   ').replace(/[\u0000-\u0008\u000e-\u001f\ufffd]+/g, ' '));
        const caps = /[A-Z]{3}/.test(text) && !/[a-z]/.test(text);
        const bold = m.parts.every((p) => p.lines.every((l) => l.bold));
        const gap = prev ? prev.y - m.y : 99;
        out.push({ text, parts: m.parts.map((p) => clean(p.text)), size: m.size, bold, caps, y: m.y, x: m.x0, gap, page: index, col: ci, relY: (view[3] - m.y) / H, bullet: !!(m.parts[0].bulletRun || m.parts[0].inlineBullet) });
        prev = m;
      }
    });
    return { lines: out, body, page: an.page, view, colSplit: !!cols.colSplit };
  }

  /* ---------- photo: original JPEG bytes from pdf-lib (DCTDecode), else pdf.js pixels -> PNG ---------- */
  async function findPhoto(bytes, page, view) {
    try {
      const pdfjs = root.pdfjsLib, OPS = pdfjs.OPS;
      const ol = await page.getOperatorList();
      const stack = []; let ctm = [1, 0, 0, 1, 0, 0];
      const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
      const cands = [];
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i], a = ol.argsArray[i];
        if (fn === OPS.save) stack.push(ctm.slice()); else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (fn === OPS.transform) ctm = mul(a, ctm);
        else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
          const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3]);
          const x = Math.min(ctm[4], ctm[4] + ctm[0] + ctm[2]), y = Math.min(ctm[5], ctm[5] + ctm[1] + ctm[3]);
          cands.push({ name: a[0], w, h, x, y, rw: a[1], rh: a[2] });
        }
      }
      const W = view[2] - view[0], H = view[3] - view[1];
      const names = {}; cands.forEach((c) => { names[c.name] = (names[c.name] || 0) + 1; });
      const ok = cands.filter((c) => { const ar = c.w / c.h; return ar >= 0.7 && ar <= 1.4 && c.w >= 40 && c.w <= 300 && c.h >= 40 && c.h <= 300 && ((view[3] - (c.y + c.h)) <= 0.4 * H || c.x + c.w < view[0] + 0.35 * W) && c.w < 0.6 * W; })
        .sort((p, q) => q.w * q.h - p.w * p.h);
      const c = ok[0]; if (!c) return null;
      let img = null; try { img = await new Promise((res) => { const o = page.objs.get(c.name, (d) => res(d)); if (o) res(o); }); } catch (e) { img = await new Promise((res) => page.objs.get(c.name, res)); }
      const pw = img && (img.width || (img.bitmap && img.bitmap.width)), ph = img && (img.height || (img.bitmap && img.bitmap.height));
      // pdf-lib: a DCTDecode XObject of the same pixel size is the original JPEG file
      try {
        const L = root.PDFLib, doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        const pg = doc.getPage(0), res = pg.node.Resources(), xo = res && res.lookup(L.PDFName.of('XObject'));
        if (xo && xo.entries) {
          for (const [, ref] of xo.entries()) {
            const s = doc.context.lookup(ref); if (!s || !s.dict) continue;
            const f = s.dict.lookup(L.PDFName.of('Filter')), fs = String(f || '');
            const iw = s.dict.lookup(L.PDFName.of('Width')), ih = s.dict.lookup(L.PDFName.of('Height'));
            if (/DCTDecode/.test(fs) && !/Flate/.test(fs) && (!pw || (iw && iw.asNumber() === pw && ih.asNumber() === ph))) {
              const cs = String(s.dict.lookup(L.PDFName.of('ColorSpace')) || '');
              if (/CMYK/.test(cs)) break;
              return { bytes: s.contents.slice(0), type: 'image/jpeg', w: iw.asNumber(), h: ih.asNumber(), source: 'jpeg', box: [c.x, c.y, c.w, c.h] };
            }
          }
        }
      } catch (e) { /* fall through */ }
      if (!pw) return null;
      const cv = document.createElement('canvas'); cv.width = pw; cv.height = ph;
      const ctx = cv.getContext('2d');
      if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
      else if (img.data) {
        const id = ctx.createImageData(pw, ph), d = img.data, n = pw * ph;
        if (d.length === n * 4) id.data.set(d); else if (d.length === n * 3) { for (let i = 0, j = 0; i < n; i++) { id.data[j++] = d[i * 3]; id.data[j++] = d[i * 3 + 1]; id.data[j++] = d[i * 3 + 2]; id.data[j++] = 255; } } else return null;
        ctx.putImageData(id, 0, 0);
      } else return null;
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/png', w: pw, h: ph, source: 'pixels', box: [c.x, c.y, c.w, c.h] };
    } catch (e) { return null; }
  }

  /* ---------- fields ---------- */
  function splitTitle(t) {
    t = clean(t);
    let m = t.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i); if (m) return [m[1], m[2]];
    m = t.split(/\s*(?:\||·|•|—|–|\s-\s|,\s)\s*/).filter(Boolean);
    return m.length >= 2 ? [m[0], m.slice(1).join(', ')] : [t, ''];
  }
  function bulletsFrom(lines) {
    const out = [];
    for (let l of markBullets(lines)) {
      if (LONE_BULLET.test(l.text)) { l = Object.assign({}, l, { text: '' }); }
      const raw = l.text, isB = l.isB || l.bullet || BULLET_STRIP.test(raw);
      const t = clean(raw.replace(BULLET_STRIP, ''));
      if (!t) continue;
      const last = out[out.length - 1];
      if (!isB && last && (l.cont || (!/[.!?]$/.test(last) && l.gap < 1.6 * l.size && /^[a-z(0-9]/.test(t)))) out[out.length - 1] = last + ' ' + t;
      else out.push(t);
    }
    return out;
  }
  const LONE_BULLET = /^\s*[•\-–—▪◦●○■□➢➤►▸*·‣⁃✓✔]\s*$/;
  const TITLE_RE = /\b(engineer|developer|manager|analyst|intern|designer|consultant|lead|associate|specialist|architect|scientist|officer|executive|director|head|trainee|administrator|tester|programmer|accountant|teacher|professor|researcher|founder|co-founder|vp|president)\b/i;
  /** Bullet structure: a lone glyph line takes the next line as its text; wrapped lines after a bullet stay in it. */
  function markBullets(lines) {
    const out = []; let pending = false, inB = false;
    for (const l0 of lines) {
      if (LONE_BULLET.test(l0.text)) { pending = true; continue; }
      const l = Object.assign({}, l0);
      const glyph = l.bullet || BULLET_STRIP.test(l.text) || pending;
      if (pending) { l.bullet = true; l.text = '• ' + l.text.replace(BULLET_STRIP, ''); }
      pending = false;
      if (glyph) { l.isB = true; inB = true; }
      else if (inB && !l.bold && !(findRange(l.text) && !findRange(l.text).single) && l.gap < 2 * l.size && (/^[a-z(]/.test(l.text.trim()) || !/[.;!?]$/.test(String(out[out.length - 1] && out[out.length - 1].text).trim()))) l.cont = true;
      else inB = false;
      out.push(l);
    }
    return out;
  }
  const isHeaderLine = (l) => {
    if (l.isB || l.cont) return false;
    const r = findRange(l.text); if (!r) return false;
    const rest = clean(l.text.replace(r.raw, ' ')).replace(/[^A-Za-z]/g, '');
    if (r.single && !/(?:19|20)\d{2}\s*$/.test(l.text.trim())) return false;    // "2024: did X" is not a job header
    if (/^\s*(?:19|20)\d{2}\s*[:\-–]?\s+[a-z]/i.test(l.text) && !RANGE_RE.test(l.text.slice(0, 25))) return false;
    return rest.length >= 3 && l.text.length <= 110;
  };
  function entries(lines0, isEdu, isProj) {
    const lines = markBullets(lines0);
    const groups = [];
    let cur = null;
    lines.forEach((l, i) => {
      const r = findRange(l.text);
      const hdr = isHeaderLine(l);
      // a bold, non-bullet title line directly followed by its company/date line also opens an entry
      const nx = lines.slice(i + 1, i + 3);
      const titleFirst = !l.isB && !l.cont && !r && l.text.length < 80 && (l.bold || TITLE_RE.test(l.text)) && nx.some((q) => isHeaderLine(q)) && !nx.some((q) => q.isB && lines.indexOf(q) < lines.indexOf(nx.find(isHeaderLine)));
      // education: a line with its own year ("Diploma ..., Mumbai University | 2018 | 65.53%") is its own entry
      const eduLine = isEdu && !l.isB && !l.cont && /\b(?:19|20)\d{2}\b/.test(l.text) && l.text.replace(/[^A-Za-z]/g, '').length >= 6 && !(cur && cur.lines.length === 1 && !/\b(?:19|20)\d{2}\b/.test(cur.lines[0].text));
      // projects: a bold (or stand-alone short) title line followed by its description opens a new project
      const nxt = lines[i + 1], prv = lines[i - 1];
      const projTitle = isProj && !l.isB && !l.cont && !!nxt && !nxt.bold && l.text.length < 90 && !/[.,;:]$/.test(l.text.trim()) && (l.bold || (prv && /[.!?]$/.test(prv.text.trim()) && l.text.length < 70));
      // a lone dateless line ("Example Payments Ltd      Gurugram, India") followed by "Role ..... 2023 – Present" is one entry
      // moderncv: "Example Fintech      Bengaluru" then "Senior Product Manager      2022–Present": a dateless, non-bullet name line
      // right before a header line opens the next entry, even when the previous entry already has lines and dates
      const nameFirst = !titleFirst && !isProj && !l.isB && !l.cont && !r && !!nxt && isHeaderLine(nxt) && l.text.length < 90 && /^[A-Z0-9]/.test(l.text.trim()) && !/[.,;:!?]$/.test(l.text.trim()) && (!cur || !!cur.range);
      const starts = !cur || titleFirst || projTitle || nameFirst || (eduLine && cur && cur.lines.some((q) => /\b(?:19|20)\d{2}\b/.test(q.text))) || (hdr && !((cur.opener || (cur.lines.length === 1 && !isEdu && !isProj && !cur.lines[0].isB && cur.lines[0].text.length < 90)) && !cur.range && cur.lines.length <= 2));
      if (!starts && hdr && cur && !cur.range) { cur.lines.push(l); cur.range = r; return; }
      if (starts) { cur = { lines: [l], range: hdr || (eduLine && r) ? r : null, opener: titleFirst || nameFirst }; groups.push(cur); }
      else { cur.lines.push(l); if (!cur.range && hdr) cur.range = r; }
    });
    return groups.map((g) => {
      const head = [], rest = [];
      for (const l of g.lines) { if (!rest.length && head.length < 2 && !(l.isB || l.cont || l.bullet || BULLET_STRIP.test(l.text)) && (head.length === 0 || l.text.replace(/[^\p{L}]/gu, '').length >= 3) && (head.length === 0 || l.bold || findRange(l.text) || (l.text.length < 45 && !/[.;]$/.test(l.text.trim())))) head.push(l); else rest.push(l); }
      const strip = (t) => tidy(g.range ? t.replace(new RegExp(g.range.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (g.range.present ? '(?:\\s+[A-Z]{1,3}\\b)?' : '')), ' ') : t);
      const h = head.map((l) => strip(l.text)).filter(Boolean);
      const dates = g.range ? { startDate: g.range.start, endDate: g.range.end } : { startDate: '', endDate: '' };
      if (isEdu) {
        const all = g.lines.map((l) => l.text).join(' ');
        const sc = all.match(/(?:cgpa|gpa|sgpa|percentage|score|marks)\s*[:\-]?\s*[\d.]+\s*(?:\/\s*\d+)?%?|\b\d{1,2}(?:\.\d{1,2})?\s*(?:\/\s*\d+\s*)?(?:cgpa|gpa|sgpa)\b|\b\d{2}(?:\.\d+)?\s*%|\b\d\.\d{1,2}\s*\/\s*10\b/i);
        let [a, b] = h.length >= 2 ? [h[0], h[1]] : splitTitle(h[0] || '');
        let area = '';
        const INST = /\b(college|university|school|institute|institution|academy|board|vidyalaya|polytechnic|iit|nit|iiit|campus)\b/i;
        if (g.lines.length === 1) {   // "Degree, Subject, College, City | 2021 | CGPA 7.15/10" on one line
          const seg = g.lines[0].text.split(/\s*\|\s*/).map((x) => tidy(g.range ? x.replace(g.range.raw, ' ') : x)).filter((x) => x && (!sc || !sc[0].includes(x)) && !(sc && x.includes(sc[0]) && x.length - sc[0].length < 3));
          const parts = (seg[0] || '').split(/\s*,\s*/).filter(Boolean), ii = parts.findIndex((x, j) => j > 0 && INST.test(x));
          if (ii > 0) { a = parts.slice(ii).join(', '); b = parts[0]; area = parts.slice(1, ii).join(', '); }
        }
        const degFirst = /\b(b\.?\s?tech|b\.?\s?eng|m\.?\s?eng|bsc|msc|b\.?s\.?\b|m\.?s\.?\b|b\.?\s?e\b|bachelor|master|m\.?\s?tech|mba|b\.?\s?sc|m\.?\s?sc|b\.?com|m\.?com|b\.?a\b|m\.?a\b|ph\.?d|diploma|class|10th|12th|ssc|hsc|cbse|icse|b\.?des|bca|mca|b\.?arch|degree|secondary)/i;
        // "B.Des, Communication Design — Example Institute of Design" + "First class with distinction": degree and institution are both on
        // the first line, the second line is a note
        let note = '';
        if (h.length >= 2 && degFirst.test(h[0]) && INST.test(h[0]) && !INST.test(h[1]) && (!degFirst.test(h[1]) || /\b(?:first|second|class|distinction|honou?rs|merit|grade)\b/i.test(h[1]))) { const sp = h[0].split(/\s+[—–|]\s+|\s+at\s+/); if (sp.length === 2) { [a, b] = INST.test(sp[1]) ? [sp[1], sp[0]] : [sp[0], sp[1]]; note = h[1]; } }
        if (degFirst.test(a) && !degFirst.test(b)) [a, b] = [b, a];
        else if (INST.test(b) && !INST.test(a)) [a, b] = [b, a];   // "BEng Electronics — University of Leeds": the university is the institution
        const ent = { institution: a || '', studyType: (b || '').replace(sc ? sc[0] : '\u0000', '').replace(/[,|]\s*$/, '').trim(), area, score: sc ? clean(sc[0]) : '', ...dates, courses: [] };
        const extra = g.lines.length === 1 ? [] : bulletsFrom(rest).filter((x) => !sc || !x.includes(sc[0]));
        if (note && !extra.includes(note) && (!sc || !note.includes(sc[0]))) extra.unshift(note);
        if (extra.length) ent.courses = extra;
        return { ent, conf: (ent.institution && g.range ? 0.85 : 0.55) * (h.length ? 1 : 0.8) };
      }
      let position = '', company = '', location = '';
      // "Example Fintech        Bengaluru": a right-aligned city on a header line is the location
      head.forEach((l, k) => { const ps = (l.parts || []).map((p) => clean(typeof p === 'string' ? p : p.text)).filter(Boolean); if (!location && ps.length >= 2 && CITY_RE.test(ps[ps.length - 1]) && h[k] && h[k].endsWith(ps[ps.length - 1])) { location = ps[ps.length - 1]; h[k] = tidy(h[k].slice(0, -location.length)); } });
      for (let k = 0; k < h.length; k++) { const segs = h[k].split(/\s*(?:•|·|\||\s-\s|,)\s*/).filter(Boolean); const li = segs.findIndex((x, j) => j > 0 && CITY_RE.test(x)); if (li > 0) { location = segs[li]; segs.splice(li, 1); h[k] = segs.join(' · '); } }
      if (h.length >= 2) { position = h[0]; company = h[1]; if (TITLE_RE.test(company) && !TITLE_RE.test(position)) [position, company] = [company, position]; if (/\b(pvt|ltd|inc|llc|technologies|solutions|limited|corp|company|labs|university)\b/i.test(position) && !/\b(pvt|ltd|inc|llc|technologies|solutions|limited|corp)\b/i.test(company)) [position, company] = [company, position]; }
      else [position, company] = splitTitle(h[0] || '');
      company = company.replace(/\s{2,}.*$/, '');
      const ent = { position: tidy(position), name: tidy(company), location, ...dates, highlights: bulletsFrom(rest) };
      if (isProj && rest.length && !markBullets(rest).some((q) => q.isB)) { ent.description = ent.highlights.join(' '); ent.highlights = []; }
      return { ent, conf: (position && company && g.range ? 0.85 : position && (company || g.range) ? 0.65 : 0.45) };
    });
  }
  function skillChips(lines) {
    const out = [], seen = new Set();
    // a skill list wrapped over lines: "UiPath, Automation" + "Anywhere, ..." is one item. Only a list line (has a separator) or a
    // long line wraps; short one-item lines ("Malayalam Native" / "English Fluent", "Tally" / "Excel") are items of their own.
    const joined = [];
    for (const l of lines) { const p = joined[joined.length - 1]; if (p && (/[,|•·;]/.test(p.text) || p.text.length >= 40) && !/[,|•·;:]\s*$/.test(p.text) && !/^[^:]{2,30}:/.test(l.text) && !BULLET_STRIP.test(l.text) && /^[A-Za-z]/.test(l.text)) { p.text += ' ' + l.text; p.parts.push(l.text); } else joined.push({ text: l.text, parts: [l.text] }); }
    const chips = (t) => clean(t.replace(BULLET_STRIP, '').replace(/^[^:]{2,30}:\s*/, ''))   // "Languages: Java, C" -> chips only
      .split(/\s*(?:,|\||•|·|;|\s{3,}|\/\/)\s*/).map((s) => clean(s.replace(/^and\s+/i, '').replace(/[★☆✩✪●○◉◯◦▪■□]/g, ' ')).replace(/[.]$/, '')).filter(Boolean);   // rating stars/dots ("Tally ★★★★") are not part of the skill
    for (const l of joined) {
      let cs = chips(l.text);
      if (l.parts.length > 1 && cs.some((s) => s.length > 40)) cs = l.parts.flatMap(chips);   // the join made an over-long item: keep the lines apart
      for (const s of cs) {
        if (s.length > 40 || seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase()); out.push({ name: s });
      }
    }
    return out;
  }

  /* ---------- scanned PDFs: tesseract.js (already bundled in vendor/tesseract), English, whole page ---------- */
  const BASE = (document.currentScript && document.currentScript.src.replace(/js\/resume\/extract\.js.*$/, '')) || '';
  let ocrWorker = null;
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
  async function ocrPages(src, n, onStatus) {
    if (!root.Tesseract) await loadScript(BASE + 'vendor/tesseract/tesseract.min.js');
    const simd = (() => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; } })();
    if (!ocrWorker) ocrWorker = await root.Tesseract.createWorker('eng', 1, { workerPath: BASE + 'vendor/tesseract/worker.min.js', workerBlobURL: false, corePath: BASE + 'vendor/tesseract/core/folio-core-' + (simd ? 'simd-' : '') + 'lstm.js', langPath: BASE + 'vendor/tesseract/lang', gzip: true, cacheMethod: 'write', logger: (m) => { if (onStatus) onStatus(m); } });
    await ocrWorker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', debug_file: '/dev/null' });
    const out = [];
    for (let i = 0; i < n; i++) {
      const an = await root.PdfEngine._analyzePage(src, i), page = an.page, view = page.view, H = view[3] - view[1], S = 2.5;
      const vp = page.getViewport({ scale: S }), cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      const res = await ocrWorker.recognize(cv, {}, { text: true, blocks: true });
      const d = res.data, tl = d.lines || (d.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
      let prev = null; const lines = [];
      for (const L of tl) {
        const text = clean(L.text); if (!text || (L.confidence != null && L.confidence < 30)) continue;
        const size = Math.max(4, (L.bbox.y1 - L.bbox.y0) / S * 0.8), y = view[3] - L.bbox.y1 / S;
        lines.push({ text, parts: [text], size, bold: false, caps: /[A-Z]{3}/.test(text) && !/[a-z]/.test(text), y, x: L.bbox.x0 / S, gap: prev ? prev.y - y : 99, page: i, col: 0, relY: L.bbox.y0 / S / H, bullet: BULLET_STRIP.test(text) });
        prev = lines[lines.length - 1];
      }
      out.push({ lines, body: 10, page, view, colSplit: false });
    }
    return out;
  }

  /* ---------- main ---------- */
  async function extract(src, bytes, opts) {
    opts = opts || {};
    const E = root.PdfEngine;
    const nPages = E.getPageCount(src);
    if (nPages > 6) return { refusal: 'too-many-pages', message: 'This doesn’t look like a resume (more than 6 pages) — edit it as a PDF instead.' };
    const pages = [];
    for (let i = 0; i < Math.min(nPages, opts.maxPages || 6); i++) pages.push(await pageLines(src, i));
    let pageLinks = [];
    try { const pg0 = pages[0] && pages[0].page, v0 = pages[0] && pages[0].view; if (pg0 && pg0.getAnnotations) pageLinks = (await pg0.getAnnotations()).filter((a) => a.subtype === 'Link' && /^https?:/i.test(a.url || '') && (!v0 || !a.rect || (a.rect[3] > v0[3] - 0.25 * (v0[3] - v0[1]) || a.rect[1] < v0[1] + 0.15 * (v0[3] - v0[1])))).map((a) => a.url); } catch (e) { pageLinks = []; }
    let all = pages.flatMap((p) => p.lines), ocr = false;
    if (!all.length && opts.ocr !== false) { const op = await ocrPages(src, Math.min(nPages, 2), opts.onStatus); if (op.length) { pages.splice(0, pages.length, ...op); all = op.flatMap((p) => p.lines); ocr = true; } }
    const bodyCounts = {}; all.forEach((l) => { const k = Math.round(l.size * 2) / 2; bodyCounts[k] = (bodyCounts[k] || 0) + l.text.length; });
    const body = +Object.keys(bodyCounts).sort((a, b) => bodyCounts[b] - bodyCounts[a])[0] || 10;
    if (!all.length) return { refusal: 'no-text', message: 'We couldn’t find any text in this PDF, even with text recognition.' };
    // headings
    for (const l of all) {
      const k = headKey(l.text) || (l.parts.length > 1 ? null : null);
      const words = l.text.split(/\s+/).length;
      let s = 0;
      if (k) s += 2; if (l.bold || l.caps) s++; if (l.size >= body + 1) s++; if (words <= 4) s++; if (l.gap >= 1.2 * 1.2 * l.size) s++; if (!/[.]$/.test(l.text)) s++;
      l.hscore = s; l.hkey = k && s >= 3 ? k : null;
      // "Skills: a, b, c" inline heading
      if (!l.hkey) { const m = l.text.match(/^([A-Za-z &]{3,30}):\s*(.+)$/); const ik = m && headKey(m[1]); if (ik && (l.bold || l.relY < 2)) { l.inline = { key: ik, rest: m[2], title: m[1] }; } }
    }
    const sections = []; const pre = [];
    let cur = null;
    for (const l of all) {
      if (l.hkey) { cur = { key: l.hkey, title: clean(l.text).replace(/[:：]$/, ''), lines: [], hscore: l.hscore, col: l.col }; sections.push(cur); continue; }
      if (l.inline && (!cur || l.inline.key !== cur.key)) { const s = { key: l.inline.key, title: l.inline.title, lines: [Object.assign({}, l, { text: l.inline.rest })], hscore: 3, inlineHead: true }; sections.push(s); if (!cur) continue; if (l.inline.key === 'skills' || l.inline.key === 'languages') continue; }
      if (cur && !(EMAIL_RE.test(l.text) || (PHONE_IN.test(l.text) && !RANGE_RE.test(l.text)))) cur.lines.push(l); else pre.push(l);
    }
    const r = M().blank(); const P = r.meta.pdfroo; const conf = P.conf;
    const text = all.map((l) => l.text).join('\n');
    // basics
    const p1 = all.filter((l) => l.page === 0);
    const top = p1.filter((l) => l.relY < 0.35);
    const em = text.match(EMAIL_RE);
    if (em) { r.basics.email = em[0].replace(/[.,]+$/, ''); conf['basics.email'] = top.some((l) => l.text.includes(em[0])) || pages[0].colSplit ? 0.95 : 0.75; }
    const phoneSrc = all.filter((l) => !RANGE_RE.test(l.text) || /\d{5}/.test(l.text)).map((l) => l.text).join('\n');
    let ph = phoneSrc.match(PHONE_IN);
    if (ph) { r.basics.phone = clean(ph[0]).replace(/^\+?\d{1,3}\)\s*/, (x) => x.replace(')', '')); const d = ph[0].replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''); conf['basics.phone'] = d.length === 10 ? 0.95 : 0.6; }
    else if ((ph = phoneSrc.match(PHONE_ANY)) && ph[0].replace(/\D/g, '').length >= 9 && ph[0].replace(/\D/g, '').length <= 15 && !/^(19|20)\d{2}\s*[-–]/.test(ph[0].trim())) { r.basics.phone = clean(ph[0]).replace(/^(\+?\d{1,3})\)\s*/, '$1 ').replace(/^\((?=[^)]*$)/, ''); conf['basics.phone'] = 0.7; }
    const nameText0 = (l) => clean(String(l.parts[0] || l.text).replace(/[\u0000-\u001f\ufffd]/g, '')).replace(/\s{2,}.*/, '').replace(/\s*[|·•,–—].*$/, '').replace(/\s*\((?:fictional|cv|resume)\)\s*$/i, '');
    // letter-spaced "S A R A D S O U Z A" is collapsed; word breaks come from the e-mail local part (sara.dsouza@)
    const nameText = (l) => { let t = nameText0(l); if (/^(?:[A-Za-z] ){3,}[A-Za-z]$/.test(t)) { t = t.replace(/ /g, ''); if (emTok.length > 1 && t.toLowerCase() === emTok.join('')) { let k = 0; t = emTok.map((w) => { const s = t.slice(k, k + w.length); k += w.length; return s; }).join(' '); } } return /\s/.test(t) ? t : t.replace(/([a-z])([A-Z])/g, '$1 $2'); };
    const emTok = em ? em[0].split('@')[0].toLowerCase().split(/[._\-\d+]+/).filter((x) => x.length >= 3) : [];
    const p0 = (l) => String(l.parts[0] || l.text);
    const nameCands = p1.filter((l) => l.relY < 0.35 && !l.hkey && !headKey(p0(l)) && !EMAIL_RE.test(p0(l)) && !/linkedin|github|http|resume|curriculum|vitae|^cv$|\.com/i.test(p0(l)) && !/^(contact|profile|about|personal|summary|details|info|methods)\b/i.test(p0(l)))
      .map((l) => ({ l, t: nameText(l) })).filter((c) => /^[A-Za-z][A-Za-z .'-]{2,40}$/.test(c.t) && c.t.split(/\s+/).length <= 5 && /[A-Za-z]{2}/.test(c.t));
    const emHit = (t) => emTok.length && t.toLowerCase().split(/[\s.'-]+/).some((w) => w.length >= 3 && emTok.some((k) => k.startsWith(w) || w.startsWith(k)));
    const best = nameCands.slice().sort((a, b) => (emHit(b.t) ? 100 : 0) + b.l.size - ((emHit(a.t) ? 100 : 0) + a.l.size) || a.l.relY - b.l.relY)[0];
    const nm = best && best.l;
    if (best) { r.basics.name = best.t; if (/^(?:[A-Z] ){2,}[A-Z]/.test(r.basics.name)) r.basics.name = r.basics.name.replace(/(\S) (?=\S)/g, '$1').replace(/\s+/g, ' '); conf['basics.name'] = nm.size >= body * 1.3 || emHit(best.t) ? 0.92 : 0.55; }
    if (r.basics.name && r.basics.name === r.basics.name.toUpperCase()) r.basics.name = r.basics.name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    // links: every distinct one survives (website + all profiles): explicit URLs, bare domains in the header
    // (ayush4u.github.io/portfolio), and the PDF's clickable link annotations near the top of page 1
    const seenL = new Set(), others = [];
    const addLink = (u) => {
      u = String(u || '').trim().replace(/[).,;:]+$/, ''); if (!u || /^(?:mailto|tel):/i.test(u) || (/@/.test(u) && !/^https?:/i.test(u))) return;
      const k = u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''); if (!k || seenL.has(k)) return; seenL.add(k);
      if (/linkedin\.com\//i.test(u)) r.basics.profiles.push({ network: 'LinkedIn', url: u });
      else if (/(?:^|[/.])github\.com\//i.test(u)) r.basics.profiles.push({ network: 'GitHub', url: u });
      else others.push(u);
    };
    for (const re of URL_RES) { const m = text.match(re); if (m) addLink(m[0]); }
    // the header plus the contact block around the e-mail line (a sidebar contact list can sit below 35% of the page)
    const emI = p1.findIndex((l) => EMAIL_RE.test(l.text)), hdrL = p1.filter((l, i) => l.relY < 0.35 || (emI >= 0 && Math.abs(i - emI) <= 4 && l.relY < 0.6));
    const topText = hdrL.map((l) => l.text).join(' · ');
    for (const m of topText.matchAll(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w%-]+\/?|(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+|https?:\/\/[^\s|,·]+/gi)) addLink(m[0]);
    // a bare domain is never a degree/tech token (B.Tech, M.Tech, B.E., M.Sc, Node.js); a fragment of a URL hyphenated over two
    // lines ("exam-" / "ple.com/kavya") is replaced by the clickable link it belongs to, or dropped if there is none
    const DEGREE = /^(?:[a-z]{1,2}\.)+(?:tech|sc|com|e|a|arch|des|ed|pharm|ba|ca|phil)\.?$|^[\w-]+\.(?:js|ts|py|net)$/i;
    const annK = (pageLinks || []).map((u) => [u, u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')]);
    const bareLink = (u, cut) => {
      if (DEGREE.test(u) || (!/\//.test(u) && /^[a-z]{1,2}\./i.test(u))) return;
      const k = u.toLowerCase().replace(/^www\./, '').replace(/\/+$/, ''), full = annK.find(([, a]) => a !== k && a.endsWith(k) && /[\w-]$/.test(a.slice(0, a.length - k.length)));
      if (full) return addLink(full[0]); if (cut) return; addLink(u);
    };
    const topJ = topText.replace(/([a-z0-9])-\s*·\s*(?=[a-z0-9][\w-]*\.[a-z])/gi, '$1');
    for (const m of topJ.matchAll(BARE_URL_RE)) if (!/@$/.test(topJ.slice(0, m.index + m[0].indexOf(m[1]))) && topJ[m.index + m[0].length] !== '@') bareLink(m[1], /-\s*·\s*$/.test(topText.slice(0, topText.indexOf(m[1]))));
    if (pageLinks && pageLinks.length) pageLinks.forEach(addLink);
    others.forEach((u) => { if (!r.basics.url) r.basics.url = u; else r.basics.profiles.push({ network: u.replace(/^https?:\/\/(?:www\.)?/i, '').split(/[/?#]/)[0], url: u }); });
    const REG = 'India|USA|UK|Canada|Germany|Singapore|UAE|Australia|Maharashtra|Karnataka|Tamil Nadu|Kerala|Telangana|Andhra Pradesh|Gujarat|Rajasthan|Punjab|Haryana|Delhi|Uttar Pradesh|Madhya Pradesh|West Bengal|Bihar|Odisha|Assam|Goa|Jharkhand|Chhattisgarh|Uttarakhand|Himachal Pradesh|Jammu and Kashmir|NCR|[A-Z]{2}';
    const loc = top.map((l) => l.text).join(' · ').match(new RegExp('\\b([A-Z][a-zA-Z]+(?:\\s[A-Z][a-zA-Z]+)?),\\s*(' + REG + ')\\b'));
    if (loc && loc[0] !== r.basics.name && !/manager|engineer|developer|designer|analyst/i.test(loc[1])) { r.basics.location = { city: loc[1], region: loc[2] }; conf['basics.location'] = 0.6; }
    const NOT_TITLE = (t) => /\b(?:university|college|school|institute|academy)\b/i.test(t) || /^\(.*\)$/.test(t.trim()) || !!headKey(t) || /^(?:contact|details|info)$/i.test(t.trim());
    if (nm) {
      // the headline is the first line right under the name, before the contact block or the first heading:
      // "AI Automation Engineer | LLM agents, RAG, UiPath" is the job title, not an "Other" section
      const isContact = (t) => /^[^\x00-\x7f]\s+\S/.test(t) || EMAIL_RE.test(t) || PHONE_IN.test(t) || /linkedin|github|https?:|www\.|\.(?:com|io|in|dev|me|org)\b/i.test(t);
      for (let i = all.indexOf(nm) + 1; i < all.length; i++) {
        const l = all[i];
        // "Medicinal Chemist      Chennai, India | example.com/x": the title is the non-contact part of the line
        const own = (l.parts || [l.text]).filter((p) => p && !isContact(p) && !(loc && clean(p).startsWith(loc[0])));
        if (l.page !== 0 || l.hkey || l.relY > nm.relY + 0.1 || (isContact(l.text) && !(own.length && l.parts && l.parts.length > 1 && !isContact(own[0])))) break;
        const t = clean(isContact(l.text) || own.length < (l.parts || []).length ? own[0] : l.text), words = t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
        const notTitle = NOT_TITLE(t) || /^\d+[\w/-]*\s+\S.*\b(?:road|rd|street|st|lane|ln|avenue|ave|nagar|marg|sector|block)\b/i.test(t) || (loc && clean(t) === clean(loc[0]));
        if (!notTitle && t.length >= 3 && t.length <= 90 && words <= 12 && !/[.]$/.test(t) && !/\d{4,}/.test(t)) { r.basics.label = t; conf['basics.label'] = 0.7; }
        break;
      }
    }
    // sections
    const other = []; const usedKeys = [];
    for (const s of sections) {
      if (!usedKeys.includes(s.key)) usedKeys.push(s.key);
      const hc = Math.min(1, s.hscore / 5);
      if (s.key === 'summary') { r.basics.summary = (r.basics.summary ? r.basics.summary + ' ' : '') + bulletsFrom(s.lines).join(' '); conf['basics.summary'] = 0.85 * hc + 0.1; }
      else if (s.key === 'work' || s.key === 'projects') {
        const es = entries(s.lines, false, s.key === 'projects');
        es.forEach((e) => {
          if (s.key === 'projects') { r.projects.push({ name: [e.ent.position, e.ent.name].filter(Boolean).join(' — '), description: e.ent.description || '', startDate: e.ent.startDate, endDate: e.ent.endDate, highlights: e.ent.highlights }); conf['projects.' + (r.projects.length - 1)] = Math.max(0.6, e.conf) * hc; }
          else { r.work.push(e.ent); conf['work.' + (r.work.length - 1)] = e.conf * (0.7 + 0.3 * hc); }
        });
      } else if (s.key === 'education') {
        entries(s.lines, true).forEach((e) => { r.education.push(e.ent); conf['education.' + (r.education.length - 1)] = e.conf * (0.7 + 0.3 * hc); });
      } else if (s.key === 'skills') { r.skills.push(...skillChips(s.lines).filter((x) => !r.skills.some((y) => y.name.toLowerCase() === x.name.toLowerCase()))); conf.skills = 0.8 * hc + 0.15; }
      else if (s.key === 'languages') {
        // "Malayalam: Native" / "Tamil — native" is a language with its fluency (the "Label: a, b" rule would keep only "Native")
        const FL = /^(?:native|mother tongue|fluent|proficient|professional|full professional|conversational|intermediate|advanced|basic|beginner|elementary|limited|working)\b/i, rest = [];
        for (const l of s.lines) { const m = clean(String(l.text).replace(BULLET_STRIP, '')).match(/^([^:–—,]{2,30}?)\s*(?::|\s[–—-]\s)\s*(.{2,40})$/); if (m && FL.test(m[2])) r.languages.push({ language: m[1], fluency: m[2] }); else rest.push(l); }
        skillChips(rest).forEach((x) => r.languages.push({ language: x.name, fluency: '' }));
      }
      else if (s.key === 'interests') { skillChips(s.lines).forEach((x) => r.interests.push({ name: x.name })); }
      else if (s.key === 'awards') { bulletsFrom(s.lines).forEach((t) => r.awards.push({ title: t, date: '', awarder: '' })); }
      else if (s.key === 'personal') { P.personal = { title: s.title, text: s.lines.map((l) => l.text).join('\n') }; }
      else if (s.key === 'declaration') { P.declaration = { title: s.title, text: s.lines.map((l) => l.text).join(' ') }; }
      else other.push({ title: s.title, text: bulletsFrom(s.lines).join('\n') });
    }
    // anything before the first heading that isn't contact goes to "Other" (nothing is silently dropped)
    const contactish = (t) => EMAIL_RE.test(t) || PHONE_ANY.test(t) || /linkedin|github|http/i.test(t) || /^\s*(?:www\.)?[\w-]+\.(?:com|io|in|dev|me|org|net|co|xyz|site)(?:\/\S*)?\s*$/i.test(t) || /^\s*(?:mastodon|twitter|telegram|skype|x)\b.*@\w/i.test(t) || t === (nm && nm.text) || (r.basics.label && t.includes(r.basics.label)) || (loc && t.includes(loc[0]));
    // a short job-title line between the contact block and the summary is the job title, not summary text
    if (!r.basics.label) {
      const tl = pre.find((l) => l !== nm && !contactish(l.text) && !NOT_TITLE(l.text) && l.text.split(/\s+/).length <= 6 && !/[.:]$/.test(l.text) && /^[A-Za-z][A-Za-z &/,-]+$/.test(l.text) && (TITLE_RE.test(l.text) || l.bold));
      if (tl) { r.basics.label = tl.text; conf['basics.label'] = 0.7; pre.splice(pre.indexOf(tl), 1); }
    }
    const leftover = pre.filter((l) => !contactish(l.text) && l !== nm && l.text.length > 2);
    if (leftover.length) {
      const t = leftover.map((l) => l.text).join(' ');
      if (!r.basics.summary && t.length > 80) { r.basics.summary = t; conf['basics.summary'] = 0.5; }
      else if (t.replace(/[^A-Za-z0-9]/g, '').length >= 3) other.unshift({ title: 'Other', text: leftover.map((l) => l.text).join('\n'), unmapped: true });
    }
    // safety net: parsing above is unchanged; any block of source text that ended up nowhere in the resume
    // is added to an amber "Check this" section so it is never silently lost. Only whole blocks
    // (3+ lines in a row, or one long line) count, so stray bullets, page numbers and footers stay out.
    {
      const norm = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      const hay = norm(JSON.stringify([r, other, P.personal, P.declaration]));
      const words = new Set(hay.match(/[\p{L}\p{N}]{3,}/gu) || []);
      const placed = (l) => { const w = norm(l.text).match(/[\p{L}\p{N}]{3,}/gu) || []; if (!w.length) return true; return w.filter((x) => words.has(x)).length / w.length >= 0.6; };
      const skip = (l) => l === nm || l.hkey || contactish(l.text) || /^\s*(?:page\s*)?\d+(?:\s*(?:\/|of)\s*\d+)?\s*$/i.test(l.text) || norm(l.text).replace(/[^\p{L}\p{N}]/gu, '').length < 4;
      const runs = []; let run = [];
      all.forEach((l) => { if (skip(l)) return; if (!placed(l)) run.push(l); else if (run.length) { runs.push(run); run = []; } });
      if (run.length) runs.push(run);
      const lost = runs.filter((g) => g.length >= 3 || g.some((l) => l.text.length >= 60)).flat();
      // bullet and rating glyphs ("English ○ ○ ○", "Over 1000 lines: • A. Banerjee") are dropped from the rescued text; inline bullets split lines
      const rescued = lost.flatMap((l) => String(l.text).split(/\s+[•▪●➢➤►▸‣⁃]\s+/)).map((t) => clean(t.replace(BULLET_STRIP, '').replace(/[•▪◦●○■□➢➤►▸‣⁃✓✔]/g, ' ').replace(/(?:\s[-–—*·])+\s*$/, ''))).filter((t) => /[\p{L}\p{N}]{2}/u.test(t));
      if (rescued.length) { other.push({ title: 'Check this', text: rescued.join('\n'), unmapped: true, rescued: true }); conf['custom.rescued'] = 0.3; }
    }
    P.custom = other;
    P.order = usedKeys.filter((k) => M().DEFAULT_ORDER.includes(k)).concat(M().DEFAULT_ORDER.filter((k) => !usedKeys.includes(k)));
    if (!r.basics.summary) P.order = P.order.filter((k) => k !== 'summary').concat(['summary']);
    else if (!usedKeys.includes('summary')) P.order = ['summary'].concat(P.order.filter((k) => k !== 'summary'));
    const nSections = sections.filter((s) => !s.inlineHead || s.key === 'skills').length;
    // photo
    let photo = null;
    if (opts.photo !== false && pages[0]) photo = await findPhoto(bytes, pages[0].page, pages[0].view);
    // detection score (how resume-like): pages, contact near the top, heading words, face-sized image
    let score = 0;
    if (nPages <= 2) score += 1;
    if (top.some((l) => EMAIL_RE.test(l.text) || PHONE_IN.test(l.text) || PHONE_ANY.test(l.text))) score += 2;
    const hk = new Set(sections.map((s) => s.key)); score += Math.min(3, hk.size);
    if (photo) score += 1;
    if (hk.size >= 2 && (hk.has('work') || hk.has('education'))) score += 1;
    const isResume = score >= 6 ? 'high' : score >= 4 ? 'unsure' : 'no';
    if (ocr) { for (const k of ['basics.name', 'basics.email', 'basics.phone', 'basics.label', 'basics.summary', 'skills']) conf[k] = 0.4; for (const k of Object.keys(conf)) conf[k] = Math.min(conf[k], 0.4); r.work.forEach((_, i) => { conf['work.' + i] = 0.4; }); r.education.forEach((_, i) => { conf['education.' + i] = 0.4; }); }
    const result = { ocr, resume: r, photo, conf, sections: sections.map((s) => ({ key: s.key, title: s.title })), nSections, pages: nPages, score, isResume, colSplit: pages.some((p) => p.colSplit), body };
    if (nSections < 3) result.warning = 'This doesn’t look like a resume — you can still edit it as a PDF.';
    return result;
  }
  root.ResumeExtract = { extract, findRange, normDate, headKey, EMAIL_RE, PHONE_IN, DICT, _pageLines: pageLines };   // _pageLines: debugging (resume-corpus/lines.mjs)
})(window);
