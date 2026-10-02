/* Folio — Compress PDF, entirely in the browser (window.FolioCompress).
 * Lossless pass: identical streams (duplicate fonts / images) merged, unreachable objects dropped, uncompressed
 * streams Flate-compressed, object streams on save. Lossy pass (presets / target size): only image XObjects are
 * re-encoded as JPEG with the browser's canvas encoder, stepping resolution + quality down until the target is met.
 * Page content streams, fonts and vector drawings are never touched, so text stays sharp and searchable; forms,
 * links and outlines are kept. Transparency (SMask) is kept as a separate soft mask; CMYK, grayscale, Indexed and
 * ICC-based images are converted to RGB first. Uses pdf-lib (MIT) only — no Ghostscript. */
(function (root) {
  'use strict';
  const PL = () => root.PDFLib;
  const PRESETS = {
    small: { dpi: 110, q: 0.55, label: 'Smaller' },
    balanced: { dpi: 150, q: 0.72, label: 'Balanced' },
    high: { dpi: 200, q: 0.85, label: 'High quality' },
  };
  // resolution (dpi at the page size) + JPEG quality, from best to smallest
  const LADDER = [[220, 0.88], [200, 0.82], [170, 0.76], [150, 0.7], [150, 0.62], [130, 0.56], [110, 0.5], [96, 0.45], [85, 0.4], [72, 0.35], [60, 0.3], [50, 0.25], [42, 0.2], [36, 0.16]];

  const nm = (v) => (v && v.constructor && v.constructor.name === 'PDFName' ? v.asString().slice(1) : (v && v.encodedName ? v.encodedName.slice(1) : null));
  function nameOf(v) { const L = PL(); return v instanceof L.PDFName ? v.decodeText ? v.decodeText() : v.asString().replace(/^\//, '') : null; }
  const num = (v) => { const L = PL(); return v instanceof L.PDFNumber ? v.asNumber() : null; };

  /* ---------- lossless: dedupe, prune, compress ---------- */
  function hashBytes(u8) { let h1 = 0x811c9dc5, h2 = 0; for (let i = 0; i < u8.length; i++) { h1 = Math.imul(h1 ^ u8[i], 16777619); h2 = (h2 + u8[i] * (i + 1)) | 0; } return (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36) + '.' + u8.length; }
  function dictKey(dict) {
    const L = PL(); const parts = [];
    for (const [k, v] of dict.entries()) { const ks = k.asString(); if (ks === '/Length') continue; parts.push(ks + '=' + (v instanceof L.PDFRef ? 'R' + v.objectNumber + '.' + v.generationNumber : v.toString())); }
    return parts.sort().join('|');
  }
  function remap(obj, map) {
    const L = PL();
    if (obj instanceof L.PDFRef) return map.get(obj.tag) || obj;
    if (obj instanceof L.PDFDict) { for (const [k, v] of obj.entries()) { const r = remap(v, map); if (r !== v) obj.set(k, r); } return obj; }
    if (obj instanceof L.PDFArray) { for (let i = 0; i < obj.size(); i++) { const v = obj.get(i); const r = remap(v, map); if (r !== v) obj.set(i, r); } return obj; }
    if (obj instanceof L.PDFStream) { remap(obj.dict, map); return obj; }
    return obj;
  }
  function dedupeStreams(pdf) {
    const L = PL(), ctx = pdf.context;
    const seen = new Map(), map = new Map();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof L.PDFRawStream)) continue;
      const k = dictKey(obj.dict) + '#' + hashBytes(obj.contents);
      const first = seen.get(k);
      if (first) map.set(ref.tag, first); else seen.set(k, ref);
    }
    if (!map.size) return 0;
    for (const [, obj] of ctx.enumerateIndirectObjects()) remap(obj, map);
    remap(ctx.trailerInfo.Root && ctx.lookup(ctx.trailerInfo.Root), map);
    for (const tag of map.keys()) { const [n, g] = tag.split(' '); ctx.delete(L.PDFRef.of(+n, +g)); }
    return map.size;
  }
  function pruneUnreachable(pdf) {
    const L = PL(), ctx = pdf.context, seen = new Set();
    const stack = [];
    const ti = ctx.trailerInfo;
    [ti.Root, ti.Info, ti.Encrypt].forEach((r) => r && stack.push(r));
    while (stack.length) {
      const o = stack.pop();
      if (o instanceof L.PDFRef) { if (seen.has(o.tag)) continue; seen.add(o.tag); const t = ctx.lookup(o); if (t) stack.push(t); continue; }
      if (o instanceof L.PDFDict) { for (const [, v] of o.entries()) stack.push(v); continue; }
      if (o instanceof L.PDFArray) { for (let i = 0; i < o.size(); i++) stack.push(o.get(i)); continue; }
      if (o instanceof L.PDFStream) stack.push(o.dict);
    }
    let n = 0;
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) { ctx.delete(ref); n++; }
    return n;
  }
  function flateRaw(pdf) {
    const L = PL(), ctx = pdf.context; let n = 0;
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof L.PDFRawStream) || obj.dict.get(L.PDFName.of('Filter')) || obj.contents.length < 128) continue;
      const d = L.PDFDict.withContext(ctx);
      for (const [k, v] of obj.dict.entries()) if (k.asString() !== '/Length') d.set(k, v);
      const fs = ctx.flateStream(obj.contents, {});
      for (const [k, v] of d.entries()) fs.dict.set(k, v);
      if (fs.getContentsSize ? fs.getContentsSize() < obj.contents.length : true) { ctx.assign(ref, fs); n++; }
    }
    return n;
  }

  /* ---------- images ---------- */
  function pngUnpredict(data, colors, bpc, columns) {
    const bpp = Math.max(1, Math.ceil(colors * bpc / 8)), row = Math.ceil(colors * bpc * columns / 8);
    const rows = Math.floor(data.length / (row + 1)), out = new Uint8Array(rows * row);
    let prev = new Uint8Array(row);
    for (let y = 0; y < rows; y++) {
      const t = data[y * (row + 1)], src = data.subarray(y * (row + 1) + 1, (y + 1) * (row + 1)), cur = out.subarray(y * row, (y + 1) * row);
      for (let x = 0; x < row; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        let v = src[x];
        if (t === 1) v += a; else if (t === 2) v += b; else if (t === 3) v += (a + b) >> 1;
        else if (t === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[x] = v & 255;
      }
      prev = cur;
    }
    return out;
  }
  function resolveCS(ctx, cs) {
    const L = PL();
    cs = cs instanceof L.PDFRef ? ctx.lookup(cs) : cs;
    if (cs instanceof L.PDFName) { const n = cs.asString().slice(1); return { DeviceRGB: { n: 3 }, DeviceGray: { n: 1 }, DeviceCMYK: { n: 4, cmyk: true }, CalRGB: { n: 3 }, CalGray: { n: 1 } }[n] || null; }
    if (cs instanceof L.PDFArray) {
      const fam = cs.get(0) instanceof L.PDFName ? cs.get(0).asString().slice(1) : '';
      if (fam === 'ICCBased') { const s = ctx.lookup(cs.get(1)); const N = s && num(s.dict.get(L.PDFName.of('N'))); return N === 1 ? { n: 1 } : N === 3 ? { n: 3 } : N === 4 ? { n: 4, cmyk: true } : null; }
      if (fam === 'CalRGB') return { n: 3 }; if (fam === 'CalGray') return { n: 1 };
      if (fam === 'Indexed') {
        const base = resolveCS(ctx, cs.get(1)); if (!base || base.indexed) return null;
        let lut = ctx.lookup(cs.get(3)) || cs.get(3);
        let bytes = null;
        if (lut instanceof L.PDFHexString || lut instanceof L.PDFString) bytes = lut.asBytes();
        else if (lut instanceof L.PDFRawStream) bytes = L.decodePDFRawStream(lut).decode();
        if (!bytes) return null;
        return { n: 1, indexed: true, base, lut: bytes };
      }
    }
    return null;
  }
  const sofComponents = (u8) => { for (let i = 2; i < u8.length - 9;) { if (u8[i] !== 0xFF) { i++; continue; } const m = u8[i + 1]; if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return u8[i + 9]; const len = (u8[i + 2] << 8) | u8[i + 3]; i += 2 + len; } return 0; };
  const hasAdobe = (u8) => { for (let i = 0; i < Math.min(u8.length - 6, 65536); i++) if (u8[i] === 0xFF && u8[i + 1] === 0xEE && u8[i + 4] === 0x41 && u8[i + 5] === 0x64) return true; return false; };

  function newCanvas(w, h) { if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h); const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  async function toBlob(c, type, q) { return c.convertToBlob ? c.convertToBlob({ type, quality: q }) : new Promise((res) => c.toBlob(res, type, q)); }

  /**
   * CMYK (and other non-RGB) images are decoded by pdf.js itself, so the colours match exactly what the viewer shows
   * (pdf.js converts CMYK with a SWOP-like curve and knows the Adobe-JPEG / Decode-array inversion rules).
   * A one-page PDF holding only this image (no soft mask) is rendered 1:1 onto a canvas.
   */
  async function decodeViaPdfjs(w, h, dictEntries, data) {
    const pdfjs = root.pdfjsLib; if (!pdfjs || typeof document === 'undefined') return null;
    if (w * h > 40e6) return null;
    const enc = new TextEncoder(), parts = [], offs = [];
    let len = 0; const push = (u) => { if (typeof u === 'string') u = enc.encode(u); parts.push(u); len += u.length; };
    push('%PDF-1.5\n%\xE2\xE3\n');
    const obj = (n, body, stream) => {
      offs[n] = len;
      if (stream) { push(`${n} 0 obj\n<<${body}/Length ${stream.length}>>\nstream\n`); push(stream); push('\nendstream\nendobj\n'); }
      else push(`${n} 0 obj\n${body}\nendobj\n`);
    };
    const content = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    obj(1, '<</Type/Catalog/Pages 2 0 R>>');
    obj(2, '<</Type/Pages/Kids[3 0 R]/Count 1>>');
    obj(3, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>`);
    obj(4, '', content);
    obj(5, `/Type/XObject/Subtype/Image/Width ${w}/Height ${h}${dictEntries}`, data);
    const xref = len;
    push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => String(offs[n]).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
    const bytes = new Uint8Array(len); let o = 0; parts.forEach((u) => { bytes.set(u, o); o += u.length; });
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise;
      const pg = await doc.getPage(1); const vp = pg.getViewport({ scale: 1 });
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      await pg.render({ canvasContext: g, viewport: vp, intent: 'print' }).promise;
      return c;
    } catch (e) { return null; }
    finally { if (doc) doc.destroy(); }
  }
  /** PDF syntax for the image dict entries pdf.js needs (filters, colour space, Decode, DecodeParms). */
  function imageDictSyntax(ctx, d, cs, filters) {
    const L = PL(); const get = (k) => { const v = d.get(L.PDFName.of(k)); return v instanceof L.PDFRef ? ctx.lookup(v) : v; };
    const numArr = (a) => a instanceof L.PDFArray && a.asArray().every((x) => x instanceof L.PDFNumber) ? '[' + a.asArray().map((x) => x.asNumber()).join(' ') + ']' : null;
    let out = `/BitsPerComponent ${num(get('BitsPerComponent')) || 8}`;
    if (cs.indexed) {
      if (cs.base.n !== 4) return null;
      const hex = Array.from(cs.lut, (b) => b.toString(16).padStart(2, '0')).join('');
      out += `/ColorSpace[/Indexed/DeviceCMYK ${cs.lut.length / 4 - 1}<${hex}>]`;
    } else out += `/ColorSpace/${cs.n === 4 ? 'DeviceCMYK' : cs.n === 3 ? 'DeviceRGB' : 'DeviceGray'}`;
    const dec = get('Decode'); if (dec) { const s = numArr(dec); if (!s) return null; out += '/Decode' + s; }
    if (filters.length) out += '/Filter[' + filters.map((f) => '/' + f).join(' ') + ']';
    const dp = get('DecodeParms');
    const dpOne = dp instanceof L.PDFArray ? dp.asArray().map((x) => (x instanceof L.PDFRef ? ctx.lookup(x) : x)) : dp ? [dp] : [];
    if (dpOne.length) {
      const ser = dpOne.map((x) => {
        if (!(x instanceof L.PDFDict)) return 'null';
        let t = '<<'; for (const [k, v] of x.entries()) { if (v instanceof L.PDFNumber) t += k.asString() + ' ' + v.asNumber(); else if (v instanceof L.PDFBool || v instanceof L.PDFName) t += k.asString() + ' ' + v.toString(); } return t + '>>';
      });
      out += '/DecodeParms' + (dp instanceof L.PDFArray ? '[' + ser.join(' ') + ']' : ser[0]);
    }
    return out;
  }

  /** Decode an image XObject into a canvas (RGB). Returns { canvas, w, h } or { skip: reason }. */
  async function decodeImage(ctx, stream) {
    const L = PL(), d = stream.dict;
    const get = (k) => { const v = d.get(L.PDFName.of(k)); return v instanceof L.PDFRef ? ctx.lookup(v) : v; };
    const w = num(get('Width')), h = num(get('Height'));
    if (!w || !h) return { skip: 'no size' };
    if (get('ImageMask') && get('ImageMask').toString() === 'true') return { skip: 'stencil mask' };
    let filters = get('Filter'); filters = filters instanceof L.PDFArray ? filters.asArray().map((f) => f.asString().slice(1)) : filters ? [filters.asString().slice(1)] : [];
    if (filters.some((f) => /JPX|JBIG2|CCITT/.test(f))) return { skip: filters.find((f) => /JPX|JBIG2|CCITT/.test(f)) + ' image kept as is' };
    const maskArr = get('Mask'); if (maskArr instanceof L.PDFArray) return { skip: 'colour-key mask kept as is' };
    const bpc = num(get('BitsPerComponent')) || 8;
    const cs = resolveCS(ctx, d.get(L.PDFName.of('ColorSpace')));
    const decodeArr = get('Decode');
    const canvas = newCanvas(w, h), g = canvas.getContext('2d');
    if (filters[filters.length - 1] === 'DCTDecode') {
      let jpg = stream.contents;
      if (filters.length > 1) {                         // e.g. [/ASCII85Decode /DCTDecode]: undo the outer filters only
        try {
          const dd = L.PDFDict.withContext(ctx);
          for (const [k, v] of d.entries()) if (!['/Filter', '/DecodeParms'].includes(k.asString())) dd.set(k, v);
          dd.set(L.PDFName.of('Filter'), ctx.obj(filters.slice(0, -1).map((f) => L.PDFName.of(f))));
          jpg = L.decodePDFRawStream(L.PDFRawStream.of(dd, stream.contents)).decode();
        } catch (e) { return { skip: 'unreadable JPEG' }; }
      }
      const comps = sofComponents(jpg);
      if (comps === 4) {
        const syn = imageDictSyntax(ctx, d, cs || { n: 4 }, ['DCTDecode']);
        const c = syn && await decodeViaPdfjs(w, h, syn, jpg);
        if (c) return { canvas: c, w, h, gray: false };
        return { skip: 'CMYK JPEG kept as is' };        // never guess CMYK colours
      }
      let bmp;
      try { bmp = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' })); } catch (e) { return { skip: 'JPEG the browser can’t decode' }; }
      g.drawImage(bmp, 0, 0, w, h); bmp.close && bmp.close();
      if (comps === 4) {
        // Browsers decode Adobe CMYK JPEGs as inverted (Photoshop) data; PDFs mark the opposite with /Decode [1 0 …]
        const inv = decodeArr instanceof L.PDFArray && num(decodeArr.get(0)) === 1;
        if (inv !== !hasAdobe(jpg)) { const id = g.getImageData(0, 0, w, h), p = id.data; for (let i = 0; i < p.length; i += 4) { p[i] = 255 - p[i]; p[i + 1] = 255 - p[i + 1]; p[i + 2] = 255 - p[i + 2]; } g.putImageData(id, 0, 0); }
      } else if (decodeArr instanceof L.PDFArray && num(decodeArr.get(0)) === 1) return { skip: 'inverted JPEG kept as is' };
      return { canvas, w, h, gray: comps === 1 };
    }
    if (!cs) return { skip: 'unusual colour space kept as is' };
    if (bpc !== 8 && !(bpc === 16 && !cs.indexed)) return { skip: bpc + '-bit image kept (already compact)' };
    if (cs.n === 4 || (cs.indexed && cs.base.n === 4) || decodeArr || bpc === 16) {
      const syn = imageDictSyntax(ctx, d, cs, filters);
      const c = syn && await decodeViaPdfjs(w, h, syn, stream.contents);
      if (c) return { canvas: c, w, h, gray: cs.n === 1 && !cs.indexed };
      return { skip: cs.n === 4 || cs.indexed ? 'CMYK image kept as is' : 'image with a Decode array kept as is' };
    }
    let raw;
    try { raw = filters.length ? L.decodePDFRawStream(stream).decode() : stream.contents; } catch (e) { return { skip: 'unreadable image data' }; }
    const parms = get('DecodeParms');
    const pr = parms instanceof L.PDFDict ? num(parms.get(L.PDFName.of('Predictor'))) : null;
    if (pr && pr >= 10) raw = pngUnpredict(raw, num(parms.get(L.PDFName.of('Colors'))) || cs.n, bpc, num(parms.get(L.PDFName.of('Columns'))) || w);
    else if (pr === 2) return { skip: 'TIFF-predicted image kept as is' };
    if (raw.length < w * h * cs.n) return { skip: 'truncated image kept as is' };
    const id = g.createImageData(w, h), p = id.data;
    const n = w * h;
    if (cs.indexed) {
      const bn = cs.base.n, lut = cs.lut;
      for (let i = 0; i < n; i++) {
        const o = raw[i] * bn;
        if (bn === 3) { p[i * 4] = lut[o]; p[i * 4 + 1] = lut[o + 1]; p[i * 4 + 2] = lut[o + 2]; }
        else if (bn === 1) { p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = lut[o]; }
        else { const c = lut[o] / 255, m = lut[o + 1] / 255, y = lut[o + 2] / 255, k = lut[o + 3] / 255; p[i * 4] = 255 * (1 - c) * (1 - k); p[i * 4 + 1] = 255 * (1 - m) * (1 - k); p[i * 4 + 2] = 255 * (1 - y) * (1 - k); }
        p[i * 4 + 3] = 255;
      }
    } else if (cs.n === 3) for (let i = 0; i < n; i++) { p[i * 4] = raw[i * 3]; p[i * 4 + 1] = raw[i * 3 + 1]; p[i * 4 + 2] = raw[i * 3 + 2]; p[i * 4 + 3] = 255; }
    else if (cs.n === 1) for (let i = 0; i < n; i++) { p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = raw[i]; p[i * 4 + 3] = 255; }
    else for (let i = 0; i < n; i++) {
      const c = raw[i * 4] / 255, m = raw[i * 4 + 1] / 255, y = raw[i * 4 + 2] / 255, k = raw[i * 4 + 3] / 255;
      p[i * 4] = 255 * (1 - c) * (1 - k); p[i * 4 + 1] = 255 * (1 - m) * (1 - k); p[i * 4 + 2] = 255 * (1 - y) * (1 - k); p[i * 4 + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    return { canvas, w, h, gray: cs.n === 1 && !cs.indexed };
  }

  /** Image XObjects with the largest page (in points) that uses each one. */
  function collectImages(pdf) {
    const L = PL(), ctx = pdf.context, info = new Map(), smasks = new Set();
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (obj instanceof L.PDFStream) { const sm = obj.dict.get(L.PDFName.of('SMask')); if (sm instanceof L.PDFRef) smasks.add(sm.tag); }
    }
    const visit = (res, pageLong, depth) => {
      res = res instanceof L.PDFRef ? ctx.lookup(res) : res;
      if (!(res instanceof L.PDFDict) || depth > 4) return;
      let xo = res.get(L.PDFName.of('XObject')); xo = xo instanceof L.PDFRef ? ctx.lookup(xo) : xo;
      if (!(xo instanceof L.PDFDict)) return;
      for (const [, ref] of xo.entries()) {
        if (!(ref instanceof L.PDFRef)) continue;
        const s = ctx.lookup(ref); if (!(s instanceof L.PDFStream)) continue;
        const st = s.dict.get(L.PDFName.of('Subtype'));
        if (st && st.asString() === '/Image') { if (smasks.has(ref.tag)) continue; const cur = info.get(ref.tag); if (!cur || cur.pageLong < pageLong) info.set(ref.tag, { ref, pageLong }); }
        else if (st && st.asString() === '/Form') visit(s.dict.get(L.PDFName.of('Resources')), pageLong, depth + 1);
      }
    };
    pdf.getPages().forEach((p) => { const { width, height } = p.getSize(); visit(p.node.Resources(), Math.max(width, height), 0); });
    return [...info.values()];
  }

  async function encodeImage(ctx, item, dpi, q) {
    const L = PL(), src = item.dec;
    const maxPx = Math.max(16, Math.round(dpi * item.pageLong / 72));
    const s = Math.min(1, maxPx / Math.max(src.w, src.h));
    const w = Math.max(1, Math.round(src.w * s)), h = Math.max(1, Math.round(src.h * s));
    const key = w + 'x' + h + '@' + q;
    if (item.cache[key]) return item.cache[key];
    const c = newCanvas(w, h), g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.drawImage(src.canvas, 0, 0, w, h);
    const blob = await toBlob(c, 'image/jpeg', q);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    item.cache[key] = { bytes, w, h };
    return item.cache[key];
  }
  function imageStream(ctx, item, enc) {
    const L = PL(), od = item.orig.dict;
    const d = { Type: 'XObject', Subtype: 'Image', Width: enc.w, Height: enc.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' };
    const s = ctx.stream(enc.bytes, d);
    for (const k of ['SMask', 'Mask', 'Interpolate', 'Intent', 'OC', 'Metadata', 'Name', 'StructParent', 'ID']) {
      const v = od.get(L.PDFName.of(k)); if (v) s.dict.set(L.PDFName.of(k), v);
    }
    return s;
  }
  /** Downsample a large soft mask (8-bit gray Flate) alongside its image. */
  async function shrinkSMask(ctx, item, enc) {
    const L = PL(), ref = item.orig.dict.get(L.PDFName.of('SMask'));
    if (!(ref instanceof L.PDFRef)) return;
    const sm = ctx.lookup(ref);
    if (!item.smaskOrig) item.smaskOrig = sm;
    const o = item.smaskOrig, gw = num(o.dict.get(L.PDFName.of('Width'))), gh = num(o.dict.get(L.PDFName.of('Height')));
    if (!gw || !gh || gw <= enc.w * 1.4) { ctx.assign(ref, o); return; }
    const bpc = num(o.dict.get(L.PDFName.of('BitsPerComponent'))) || 8;
    if (bpc !== 8 || o.dict.get(L.PDFName.of('Decode')) || o.dict.get(L.PDFName.of('Matte'))) return;
    let raw; try { raw = o.dict.get(L.PDFName.of('Filter')) ? L.decodePDFRawStream(o).decode() : o.contents; } catch (e) { return; }
    const parms = o.dict.get(L.PDFName.of('DecodeParms'));
    const pr = parms instanceof L.PDFDict ? num(parms.get(L.PDFName.of('Predictor'))) : null;
    if (pr && pr >= 10) raw = pngUnpredict(raw, 1, 8, num(parms.get(L.PDFName.of('Columns'))) || gw);
    if (raw.length < gw * gh) return;
    const c0 = newCanvas(gw, gh), g0 = c0.getContext('2d'), id = g0.createImageData(gw, gh);
    for (let i = 0; i < gw * gh; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = raw[i]; id.data[i * 4 + 3] = 255; }
    g0.putImageData(id, 0, 0);
    const c = newCanvas(enc.w, enc.h), g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c0, 0, 0, enc.w, enc.h);
    const px = g.getImageData(0, 0, enc.w, enc.h).data, out = new Uint8Array(enc.w * enc.h);
    for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
    const ns = ctx.flateStream(out, { Type: 'XObject', Subtype: 'Image', Width: enc.w, Height: enc.h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
    ctx.assign(ref, ns);
  }

  async function save(pdf) { return pdf.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false }); }

  /**
   * compress(bytes, { preset: 'small'|'balanced'|'high', target: bytes, onProgress(msg) })
   * -> { bytes, before, after, reached, steps, dpi, quality, imageBytes: {before, after}, images, skipped, deduped, removed, explain }
   */
  async function compress(bytes, opts) {
    opts = opts || {};
    const L = PL(); const prog = opts.onProgress || (() => {});
    const before = bytes.length;
    prog('Reading the PDF…');
    let pdf;
    try { pdf = await L.PDFDocument.load(bytes, { updateMetadata: false }); }
    catch (e) { if (/encrypt/i.test(e.message || '')) { const err = new Error('This PDF is password-protected or encrypted, so it can’t be compressed.'); err.userFacing = true; throw err; } throw e; }
    const ctx = pdf.context;
    const deduped = dedupeStreams(pdf);
    const removed = pruneUnreachable(pdf);
    const flated = flateRaw(pdf);
    // images
    const items = collectImages(pdf);
    let imgBefore = 0; const skipped = [];
    prog(`Looking at ${items.length} image${items.length === 1 ? '' : 's'}…`);
    for (const it of items) {
      it.orig = ctx.lookup(it.ref); it.cache = {};
      it.size = it.orig.contents.length;
      const sm = it.orig.dict.get(L.PDFName.of('SMask')); if (sm instanceof L.PDFRef) { const s = ctx.lookup(sm); if (s) it.size += s.contents.length; }
      imgBefore += it.size;
      try { it.dec = await decodeImage(ctx, it.orig); } catch (e) { it.dec = { skip: 'unreadable image' }; }
      if (it.dec.skip) skipped.push(it.dec.skip);
    }
    const usable = items.filter((it) => it.dec && !it.dec.skip);
    const lossless = await save(pdf);
    const apply = async (dpi, q) => {
      for (const it of usable) {
        const enc = await encodeImage(ctx, it, dpi, q);
        if (enc.bytes.length < it.orig.contents.length * 0.92) { ctx.assign(it.ref, imageStream(ctx, it, enc)); await shrinkSMask(ctx, it, enc); }
        else { ctx.assign(it.ref, it.orig); if (it.smaskOrig) ctx.assign(it.orig.dict.get(L.PDFName.of('SMask')), it.smaskOrig); }
      }
      return save(pdf);
    };
    let best = lossless, used = null, steps = 0;
    const tryStep = async (dpi, q) => { steps++; prog(`Re-encoding images at ${dpi} dpi, quality ${Math.round(q * 100)}…`); const out = await apply(dpi, q); return out; };
    if (usable.length && opts.target) {
      if (lossless.length <= opts.target) { best = lossless; }
      else {
        // binary search the ladder (capped at the chosen preset's quality) for the best step that fits
        const cap = { small: 110, balanced: 150, high: 220 }[opts.preset || 'high'] || 220;
        const lad = LADDER.filter((st) => st[0] <= cap);
        let lo = 0, hi = lad.length - 1, fit = null, smallest = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1; const out = await tryStep(lad[mid][0], lad[mid][1]);
          if (!smallest || out.length < smallest.out.length) smallest = { out, i: mid };
          if (out.length <= opts.target) { fit = { out, i: mid }; hi = mid - 1; } else lo = mid + 1;
        }
        if (!fit && smallest.i !== lad.length - 1) { const out = await tryStep(...lad[lad.length - 1]); if (out.length < smallest.out.length) smallest = { out, i: lad.length - 1 }; }
        const pick = fit || smallest;
        best = pick.out.length < lossless.length ? pick.out : lossless; used = best === lossless ? null : lad[pick.i];
      }
    } else if (usable.length) {
      const P = PRESETS[opts.preset || 'balanced'] || PRESETS.balanced;
      const out = await tryStep(P.dpi, P.q);
      if (out.length < lossless.length) { best = out; used = [P.dpi, P.q]; }
    }
    if (best.length > before) best = bytes;                       // never hand back a bigger file
    // image bytes in the result
    let imgAfter = 0;
    try {
      const chk = await L.PDFDocument.load(best, { updateMetadata: false });
      for (const it of collectImages(chk)) { const s = chk.context.lookup(it.ref); imgAfter += s.contents.length; const sm = s.dict.get(L.PDFName.of('SMask')); if (sm instanceof L.PDFRef) imgAfter += chk.context.lookup(sm).contents.length; }
    } catch (e) { imgAfter = 0; }
    const reached = !opts.target || best.length <= opts.target;
    let explain = '';
    if (!reached) {
      const other = best.length - imgAfter;
      const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
      if (other > opts.target) explain = `This is the smallest Folio can make it without turning text into pictures: text, fonts and drawings alone take ${kb(other)}, more than the ${kb(opts.target)} target (images are only ${kb(imgAfter)}).`;
      else if (!usable.length) explain = `There are no images Folio can shrink in this file${skipped.length ? ' (' + [...new Set(skipped)].join(', ') + ')' : ''}; text, fonts and drawings are kept as they are.`;
      else explain = `Images are already at the lowest quality Folio will go (${LADDER[LADDER.length - 1][0]} dpi). Text, fonts and drawings take ${kb(other)} of the ${kb(best.length)}.`;
    }
    return { bytes: best, before, after: best.length, reached, steps, dpi: used ? used[0] : null, quality: used ? used[1] : null, images: items.length, recompressed: usable.length, skipped: [...new Set(skipped)], imageBytes: { before: imgBefore, after: imgAfter }, deduped, removed, flated, explain };
  }

  root.FolioCompress = { compress, PRESETS, LADDER };
})(typeof window !== 'undefined' ? window : globalThis);
