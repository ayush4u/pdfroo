/* ==========================================================================
   Folio — existing-text editing internals (engine layer, used only by pdfEngine.js)
   --------------------------------------------------------------------------
   * A small PDF content-stream tokenizer + text-state simulator that finds the
     exact show-text operators (Tj/TJ/'/") that painted a given line.
   * Removes those operators surgically (replacing each with an equal-width
     positioning-only TJ so any following text keeps its position). Every other
     byte of the content stream is kept verbatim — clipping paths, images, soft
     masks, marked content etc. are untouched. The page is NOT regenerated.
   * Appends a new content stream with the replacement text (tier 1: the page's
     own font resource and codes; tier 2/3: an embedded substitute font).
   ========================================================================== */
(function (root) {
  'use strict';

  /* ---------------- bytes <-> latin1 ---------------- */
  function bytesToLatin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 8192)));
    return s;
  }
  function latin1ToBytes(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }

  /* ---------------- tokenizer ---------------- */
  const isWS = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

  /** Tokenize a content stream (latin1 string) into operators: {op, args, s, e}. */
  function parseOps(str) {
    const ops = [];
    let i = 0; const n = str.length;
    let args = []; let argStart = -1;
    const stack = [];            // for arrays
    function pushVal(v, start) {
      if (stack.length) stack[stack.length - 1].push(v);
      else { if (argStart < 0) argStart = start; args.push(v); }
    }
    while (i < n) {
      const c = str.charCodeAt(i);
      if (isWS(c)) { i++; continue; }
      const start = i;
      if (c === 37) { while (i < n && str.charCodeAt(i) !== 10 && str.charCodeAt(i) !== 13) i++; continue; } // comment
      if (c === 40) { // literal string
        let depth = 1; i++; const out = [];
        while (i < n && depth > 0) {
          let ch = str.charCodeAt(i);
          if (ch === 92) { // backslash
            i++; ch = str.charCodeAt(i);
            if (ch === 110) out.push(10); else if (ch === 114) out.push(13); else if (ch === 116) out.push(9);
            else if (ch === 98) out.push(8); else if (ch === 102) out.push(12);
            else if (ch === 13) { if (str.charCodeAt(i + 1) === 10) i++; }
            else if (ch === 10) { /* line continuation */ }
            else if (ch >= 48 && ch <= 55) {
              let oct = ch - 48; let k = 0;
              while (k < 2 && str.charCodeAt(i + 1) >= 48 && str.charCodeAt(i + 1) <= 55) { i++; oct = oct * 8 + (str.charCodeAt(i) - 48); k++; }
              out.push(oct & 255);
            } else out.push(ch);
            i++; continue;
          }
          if (ch === 40) depth++;
          else if (ch === 41) { depth--; if (depth === 0) { i++; break; } }
          out.push(ch); i++;
        }
        pushVal({ t: 'str', bytes: out }, start); continue;
      }
      if (c === 60) {
        if (str.charCodeAt(i + 1) === 60) { // dict: skip balanced << >>
          let depth = 0;
          while (i < n) {
            if (str.charCodeAt(i) === 60 && str.charCodeAt(i + 1) === 60) { depth++; i += 2; continue; }
            if (str.charCodeAt(i) === 62 && str.charCodeAt(i + 1) === 62) { depth--; i += 2; if (!depth) break; continue; }
            if (str.charCodeAt(i) === 40) { // skip strings inside dicts
              let d = 1; i++;
              while (i < n && d) { const ch = str.charCodeAt(i); if (ch === 92) i++; else if (ch === 40) d++; else if (ch === 41) d--; i++; }
              continue;
            }
            i++;
          }
          pushVal({ t: 'dict' }, start); continue;
        }
        i++; let hex = '';
        while (i < n && str.charCodeAt(i) !== 62) { const ch = str[i]; if (/[0-9a-fA-F]/.test(ch)) hex += ch; i++; }
        i++;
        if (hex.length % 2) hex += '0';
        const out = []; for (let k = 0; k < hex.length; k += 2) out.push(parseInt(hex.substr(k, 2), 16));
        pushVal({ t: 'hex', bytes: out }, start); continue;
      }
      if (c === 91) { if (!stack.length && argStart < 0) argStart = start; stack.push([]); i++; continue; }
      if (c === 93) { const arr = stack.pop() || []; i++; pushVal({ t: 'arr', items: arr }, start); continue; }
      if (c === 47) { i++; while (i < n && !isWS(str.charCodeAt(i)) && !isDelim(str.charCodeAt(i))) i++; pushVal({ t: 'name', v: str.slice(start + 1, i) }, start); continue; }
      if (c === 123 || c === 125 || c === 62) { i++; continue; }
      // number or keyword
      while (i < n && !isWS(str.charCodeAt(i)) && !isDelim(str.charCodeAt(i))) i++;
      const tok = str.slice(start, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { pushVal({ t: 'num', v: parseFloat(tok) }, start); continue; }
      if (tok === 'true' || tok === 'false' || tok === 'null') { pushVal({ t: 'kw', v: tok }, start); continue; }
      // operator
      if (stack.length) { stack.length = 0; }
      const op = { op: tok, args, s: argStart >= 0 ? argStart : start, e: i };
      ops.push(op);
      args = []; argStart = -1;
      if (tok === 'ID') { // inline image data: skip to EI
        let j = i + 1;
        while (j < n - 2) {
          if (str.charCodeAt(j) === 69 && str.charCodeAt(j + 1) === 73 && isWS(str.charCodeAt(j - 1)) && (j + 2 >= n || isWS(str.charCodeAt(j + 2)))) break;
          j++;
        }
        i = j;
      }
    }
    return ops;
  }

  /* ---------------- matrices ---------------- */
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const ID = [1, 0, 0, 1, 0, 0];
  const num = (a) => (a && a.t === 'num' ? a.v : 0);
  const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  const rgbHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b);
  const cmykHex = (c, m, y, k) => rgbHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

  /**
   * Simulate text state; return all show-text operations with user-space geometry.
   * fonts: { [resourceKey]: { composite, widths:{code:w}, defaultWidth, toUnicode: [] | null } }
   */
  /**
   * Simulate a content stream. opts (optional):
   *   onDo(name) -> null | {type:'image', opaque} | {type:'form', ops, fonts, matrix, onDo, prefix}
   * Form XObjects are simulated recursively (their shows get font keys prefixed with `prefix`, and
   * form: true, so they are never matched for surgical removal); image paints are recorded in
   * shows.images with their page-space bbox. Every show/image gets a global paint order `seq`.
   */
  function simulate(ops, fonts, opts, _ctx) {
    const ctx = _ctx || { shows: [], images: [], seq: 0, depth: 0 };
    const shows = ctx.shows;
    const prefix = (opts && opts.prefix) || '';
    let gs = _ctx && _ctx.initGs ? JSON.parse(JSON.stringify(_ctx.initGs)) : { ctm: ID.slice(), fill: '#000000', cs: 'DeviceGray' };
    const gstack = [];
    let ts = _ctx && _ctx.initTs ? Object.assign({}, _ctx.initTs) : { Tc: 0, Tw: 0, Th: 1, TL: 0, Tfs: 0, font: null, Ts: 0, Tr: 0 };
    let Tm = ID.slice(), Tlm = ID.slice();
    const nextLine = (tx, ty) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm.slice(); };

    function show(opIndex, op, items, prefixAdv) {
      const f = fonts[ts.font];
      const Trm0 = mul([ts.Tfs * ts.Th, 0, 0, ts.Tfs, 0, ts.Ts], mul(Tm, gs.ctm));
      const rec = { i: opIndex, op: op.op, s: op.s, e: op.e, font: prefix + ts.font, Tfs: ts.Tfs, Th: ts.Th,
        start: [Trm0[4], Trm0[5]], m: Trm0, Tm0: Tm.slice(), Tlm: Tlm.slice(), ctm: gs.ctm.slice(), fill: gs.fill, Tr: ts.Tr, lw: (gs.lw == null ? 1 : gs.lw) * Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])), codes: [], gx: [], text: '', known: !!f && !f.unknown, seq: ctx.seq++, form: !!prefix };
      let adv = 0;            // in unscaled text space units (before Th)
      let inkAdv = 0;         // advance up to the end of the last non-blank glyph
      let firstInk = null;    // advance before the first non-blank glyph
      for (const it of items) {
        if (it.t === 'num') { adv += -it.v / 1000 * ts.Tfs; continue; }
        if (it.t !== 'str' && it.t !== 'hex') continue;
        const b = it.bytes;
        const two = f && f.composite;
        for (let k = 0; k < b.length; k += two ? 2 : 1) {
          const code = two ? ((b[k] << 8) | (b[k + 1] || 0)) : b[k];
          rec.codes.push(code);
          const w = f ? (f.widths[code] != null ? f.widths[code] : (f.defaultWidth || 0)) : 0;
          const advBefore = adv;
          rec.gx.push(advBefore);          // pen position of this glyph (text space, before Th)
          adv += w / 1000 * ts.Tfs + ts.Tc + (!two && code === 32 ? ts.Tw : 0);
          const u = f && f.toUnicode ? (f.toUnicode[code] || '') : '';
          rec.text += u;
          if (!(u ? /^\s+$/.test(u) : (!two && code === 32))) {             // blanks at either end don't count as ink
            if (firstInk == null) firstInk = advBefore;
            inkAdv = adv;
          }
        }
      }
      rec.adv = adv;
      Tm = mul([1, 0, 0, 1, adv * ts.Th, 0], Tm);
      const Trm1 = mul([ts.Tfs * ts.Th, 0, 0, ts.Tfs, 0, ts.Ts], mul(Tm, gs.ctm));
      rec.end = [Trm1[4], Trm1[5]];
      const TrmI = mul([ts.Tfs * ts.Th, 0, 0, ts.Tfs, 0, ts.Ts], mul(mul([1, 0, 0, 1, (inkAdv - adv) * ts.Th, 0], Tm), gs.ctm));
      rec.inkEnd = [TrmI[4], TrmI[5]];
      const TrmS = mul([ts.Tfs * ts.Th, 0, 0, ts.Tfs, 0, ts.Ts], mul(mul([1, 0, 0, 1, ((firstInk || 0) - adv) * ts.Th, 0], Tm), gs.ctm));
      rec.inkStart = [TrmS[4], TrmS[5]];
      shows.push(rec);
    }

    ops.forEach((op, idx) => {
      const a = op.args;
      switch (op.op) {
        case 'q': gstack.push(JSON.parse(JSON.stringify(gs))); break;
        case 'Q': if (gstack.length) gs = gstack.pop(); break;
        case 'cm': gs.ctm = mul(a.map(num), gs.ctm); break;
        case 'BT': Tm = ID.slice(); Tlm = ID.slice(); break;
        case 'Tf': ts.font = a[0] && a[0].v; ts.Tfs = num(a[1]); break;
        case 'Tc': ts.Tc = num(a[0]); break;
        case 'Tw': ts.Tw = num(a[0]); break;
        case 'Tz': ts.Th = num(a[0]) / 100; break;
        case 'TL': ts.TL = num(a[0]); break;
        case 'Ts': ts.Ts = num(a[0]); break;
        case 'Tr': ts.Tr = num(a[0]); break;
        case 'w': gs.lw = num(a[0]); break;
        case 'Td': nextLine(num(a[0]), num(a[1])); break;
        case 'TD': ts.TL = -num(a[1]); nextLine(num(a[0]), num(a[1])); break;
        case 'Tm': Tlm = a.map(num); Tm = Tlm.slice(); break;
        case 'T*': nextLine(0, -ts.TL); break;
        case 'Do': {
          const x = opts && opts.onDo && a[0] && a[0].t === 'name' ? opts.onDo(a[0].v) : null;
          if (!x) break;
          if (x.type === 'image') {
            const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [gs.ctm[0] * u + gs.ctm[2] * v + gs.ctm[4], gs.ctm[1] * u + gs.ctm[3] * v + gs.ctm[5]]);
            const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
            ctx.images.push({ seq: ctx.seq++, opaque: !!x.opaque, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
          } else if (x.type === 'form' && ctx.depth < 8) {
            const sub = Object.assign({}, ctx, { depth: ctx.depth + 1, initGs: Object.assign({}, gs, { ctm: mul(x.matrix || ID, gs.ctm) }), initTs: ts });
            simulate(x.ops, x.fonts || {}, { onDo: x.onDo, prefix: x.prefix }, sub);
            ctx.seq = sub.seq;
          }
          break;
        }
        case 'Tj': show(idx, op, [a[0]]); break;
        case 'TJ': show(idx, op, (a[0] && a[0].items) || []); break;
        case "'": nextLine(0, -ts.TL); show(idx, op, [a[0]]); break;
        case '"': ts.Tw = num(a[0]); ts.Tc = num(a[1]); nextLine(0, -ts.TL); show(idx, op, [a[2]]); break;
        case 'g': gs.fill = rgbHex(num(a[0]), num(a[0]), num(a[0])); gs.cs = 'DeviceGray'; break;
        case 'rg': gs.fill = rgbHex(num(a[0]), num(a[1]), num(a[2])); gs.cs = 'DeviceRGB'; break;
        case 'k': gs.fill = cmykHex(num(a[0]), num(a[1]), num(a[2]), num(a[3])); gs.cs = 'DeviceCMYK'; break;
        case 'cs': gs.cs = a[0] && a[0].v; gs.fill = gs.cs === 'DeviceGray' || gs.cs === 'DeviceRGB' || gs.cs === 'DeviceCMYK' ? '#000000' : null; break;
        case 'sc': case 'scn': {
          const v = a.filter((x) => x.t === 'num').map((x) => x.v);
          if (a.some((x) => x.t === 'name')) gs.fill = null;           // pattern
          else if (v.length === 1) gs.fill = rgbHex(v[0], v[0], v[0]);
          else if (v.length === 3) gs.fill = rgbHex(v[0], v[1], v[2]);
          else if (v.length === 4) gs.fill = cmykHex(v[0], v[1], v[2], v[3]);
          else gs.fill = null;
          break;
        }
      }
    });
    if (!_ctx) shows.images = ctx.images;
    return shows;
  }

  const normText = (s) => String(s).replace(/\s+/g, '').normalize('NFKC');

  /**
   * Find show ops that painted `line` ({x, y, end, size, text, fontKeys}).
   * Returns { ok, shows, reason }.
   */
  function matchLine(shows, line) {
    const tol = line.size;
    const keys = line.fontKeys || [line.fontKey];
    const cands = shows.filter((s) => keys.includes(s.font) &&
      Math.abs(s.m[1]) < 1e-3 * tol && Math.abs(s.m[2]) < 1e-3 * tol &&
      Math.abs(s.start[1] - line.y) <= 0.3 * tol &&
      (s.inkStart || s.start)[0] >= line.x - 0.3 * tol && (s.inkStart || s.start)[0] <= line.end - 0.05 * tol);
    if (!cands.length) return { ok: false, reason: 'not-found' };
    for (const s of cands) {
      if (!s.known) return { ok: false, reason: 'unknown-font' };
      if ((s.inkEnd || s.end)[0] > line.end + 0.6 * tol) return { ok: false, reason: 'shared-run' };
    }
    const got = normText(cands.map((s) => s.text).join(''));
    const want = normText(line.text);
    if (got) { if (got !== want) return { ok: false, reason: 'text-mismatch', got, want }; }
    else {
      const glyphs = cands.reduce((n, s) => n + s.codes.filter((c) => c !== 32).length, 0);
      if (glyphs !== want.length) return { ok: false, reason: 'text-mismatch' };
    }
    return { ok: true, shows: cands };
  }

  const fmt = (v) => { const r = Math.round(v * 10000) / 10000; return Object.is(r, -0) ? '0' : String(r); };

  /** Replacement for a removed show op: same advance, no glyphs. */
  function replacementFor(s, op) {
    const n = s.Tfs ? -s.adv * 1000 / s.Tfs : 0;
    const tj = `[${fmt(n)}] TJ`;
    if (s.op === "'") return `T* ${tj}`;
    if (s.op === '"') return `${fmt(num(op.args[0]))} Tw ${fmt(num(op.args[1]))} Tc T* ${tj}`;
    return tj;
  }

  const inv = (m) => {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  };
  const hexStr = (it) => '<' + Array.from(it && it.bytes ? it.bytes : [], (b) => b.toString(16).padStart(2, '0')).join('') + '>';
  /**
   * The same show op drawn (dx, dy) points further in page space: a Tm that is the original one translated, the
   * original glyphs, then the text state put back exactly (Tlm restored by Tm, the pen advance by a pure TJ spacing
   * number), so everything after it in the BT block lands where it did before. null if that can't be done exactly.
   */
  function movedFor(s, op, dx, dy, src) {
    const f6 = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r); };
    if (!s.Tm0 || !s.Tlm || !s.ctm || !s.Tfs || !s.Th) return null;
    const ci = inv(s.ctm); if (!ci) return null;
    const T = mul(mul(mul(s.Tm0, s.ctm), [1, 0, 0, 1, dx, dy]), ci);
    // pen after the show, relative to the line matrix: must be a pure translation along the baseline
    const after = mul([1, 0, 0, 1, s.adv * s.Th, 0], s.Tm0);
    const li = inv(s.Tlm); if (!li) return null;
    const R = mul(after, li);
    if (Math.abs(R[0] - 1) > 1e-6 || Math.abs(R[1]) > 1e-6 || Math.abs(R[2]) > 1e-6 || Math.abs(R[3] - 1) > 1e-6 || Math.abs(R[5]) > 1e-4) return null;
    let body;
    if (s.op === 'Tj' || s.op === 'TJ') body = src;
    else if (s.op === "'") body = `${hexStr(op.args[0])} Tj`;
    else if (s.op === '"') body = `${hexStr(op.args[2])} Tj`;
    else return null;
    if (!body) return null;
    const pre = s.op === "'" ? 'T* ' : s.op === '"' ? `${fmt(num(op.args[0]))} Tw ${fmt(num(op.args[1]))} Tc T* ` : '';
    const n = R[4] ? -R[4] * 1000 / (s.Tfs * s.Th) : 0;
    return ` ${pre}${T.map(f6).join(' ')} Tm ${body} ${s.Tlm.map(f6).join(' ')} Tm` + (Math.abs(n) > 1e-7 ? ` [${f6(n)}] TJ ` : ' ');
  }

  /* ---------------- font resources ---------------- */
  function decodeStreamBytes(L, obj) {
    if (!obj) return null;
    if (obj instanceof L.PDFRawStream) return L.decodePDFRawStream(obj).decode();
    if (obj.getContents) return obj.getContents();
    return null;
  }

  function readFsType(bytes) {
    try {
      if (!bytes || bytes.length < 12) return null;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const tag0 = dv.getUint32(0);
      if (tag0 !== 0x00010000 && tag0 !== 0x74727565 && tag0 !== 0x4F54544F) return null;
      const numTables = dv.getUint16(4);
      for (let t = 0; t < numTables; t++) {
        const off = 12 + t * 16;
        const tag = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
        if (tag === 'OS/2') return dv.getUint16(dv.getUint32(off + 8) + 8);
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  const cleanName = (n) => String(n || '').replace(/^[A-Z]{6}\+/, '');
  const normName = (n) => cleanName(n).replace(/-\d{3,}$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  /** Describe the page's font resources: {key: {ref, baseName, norm, composite, identity, fsType, embedded}} */
  function pageFonts(L, page, resDict) {
    const out = {};
    const res = resDict || page.node.Resources();
    const fd = res && res.lookupMaybe(L.PDFName.of('Font'), L.PDFDict);
    if (!fd) return out;
    for (const [k, v] of fd.entries()) {
      const dict = page.doc.context.lookupMaybe(v, L.PDFDict);
      if (!dict) continue;
      const subtype = dict.get(L.PDFName.of('Subtype'));
      const base = dict.get(L.PDFName.of('BaseFont'));
      let desc = null; let descendant = null;
      const composite = String(subtype) === '/Type0';
      if (composite) {
        const arr = dict.lookupMaybe(L.PDFName.of('DescendantFonts'), L.PDFArray);
        descendant = arr && arr.lookupMaybe(0, L.PDFDict);
        desc = descendant && descendant.lookupMaybe(L.PDFName.of('FontDescriptor'), L.PDFDict);
      } else desc = dict.lookupMaybe(L.PDFName.of('FontDescriptor'), L.PDFDict);
      let fsType = null, embedded = false;
      if (desc) {
        for (const ff of ['FontFile2', 'FontFile3', 'FontFile']) {
          const s = desc.lookup(L.PDFName.of(ff));
          if (s) { embedded = true; if (ff !== 'FontFile') { try { fsType = readFsType(decodeStreamBytes(L, s)); } catch (e) { /* ignore */ } } break; }
        }
      }
      const enc = dict.get(L.PDFName.of('Encoding'));
      // Which codes have an encoding spelled out in the PDF itself (not left to the font program's
      // built-in encoding, which viewers interpret differently)? 'all' | [codes] | null
      let encExplicit = null;
      try {
        if (composite) encExplicit = 'all';
        else {
          const ed = page.doc.context.lookup(enc);
          if (ed instanceof L.PDFName) encExplicit = 'all';
          else if (ed instanceof L.PDFDict) {
            if (ed.get(L.PDFName.of('BaseEncoding'))) encExplicit = 'all';
            else {
              const diff = ed.lookupMaybe(L.PDFName.of('Differences'), L.PDFArray); const codes = [];
              // a subset Type 1 font lists the glyphs it really holds in /CharSet: codes whose glyph isn't there would print blank
              let cs = null;
              try { const c0 = desc && desc.lookup(L.PDFName.of('CharSet')); const t = c0 && (c0.decodeText ? c0.decodeText() : String(c0)); if (t && /\//.test(t)) cs = new Set(t.replace(/^\(|\)$/g, '').split('/').filter(Boolean)); } catch (e) { cs = null; }
              if (diff) { let c = 0; for (let i = 0; i < diff.size(); i++) { const v = diff.get(i); if (v instanceof L.PDFNumber) c = v.asNumber(); else { if (!cs || cs.has(String(v).replace(/^\//, ''))) codes.push(c); c++; } } }
              encExplicit = codes;
            }
          }
        }
      } catch (e) { encExplicit = null; }
      const names = [base && base.decodeText ? base.decodeText() : String(base || '').replace(/^\//, '')];
      if (descendant) { const db = descendant.get(L.PDFName.of('BaseFont')); if (db) names.push(String(db).replace(/^\//, '')); }
      out[k.decodeText ? k.decodeText() : String(k).replace(/^\//, '')] = {
        ref: v, dict, baseName: names[0], norms: names.map(normName), composite,
        identity: composite ? String(enc) === '/Identity-H' : true,
        type3: String(subtype) === '/Type3', fsType, embedded, encExplicit,
      };
    }
    return out;
  }

  function contentString(L, page) {
    const c = page.node.Contents();
    const parts = [];
    const ctx = page.doc.context;
    if (!c) return '';
    if (c instanceof L.PDFArray) {
      for (let i = 0; i < c.size(); i++) parts.push(bytesToLatin1(decodeStreamBytes(L, ctx.lookup(c.get(i)))));
    } else parts.push(bytesToLatin1(decodeStreamBytes(L, c)));
    return parts.join('\n');
  }

  root.FolioTextInternals = {
    parseOps, simulate, matchLine, replacementFor, movedFor, pageFonts, contentString, decodeStreamBytes,
    bytesToLatin1, latin1ToBytes, cleanName, normName, fmt, mul,
  };
})(window);
