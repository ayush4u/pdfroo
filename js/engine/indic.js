/* Folio — engine-internal: Indic text shaping (HarfBuzz) and a CID-keyed font writer.
 *
 * Loaded lazily by pdfEngine.js the first time Indic text is typed or an Indic line is edited.
 * Nothing here runs (or downloads) on first page load.
 *
 *  - shape(text, {bold}) itemizes the text into font runs the way the browser's font fallback does
 *    for the CSS stack "Folio Noto Sans", "FolioIndic <Script>" (so the editor preview and the
 *    export use the same glyphs), then shapes each run with HarfBuzz (GSUB/GPOS: conjuncts,
 *    reordered matras, reph, mark positioning).
 *  - writer(doc) embeds each font as a Type0 / CIDFontType2 font with Identity-H encoding.
 *    Every (glyph, source text) pair gets its own CID, so the ToUnicode CMap can map glyphs to
 *    their source clusters in logical order (e.g. the glyph for ि drawn before क maps to "क"
 *    and the क glyph to "ि", so copy/search gives "कि"). Each shaped run is also wrapped in
 *    marked content with /ActualText holding the original Unicode.
 */
(function (root) {
  'use strict';

  const SCRIPTS = [
    ['Devanagari', 0x0900, 0x097F], ['Bengali', 0x0980, 0x09FF], ['Gurmukhi', 0x0A00, 0x0A7F],
    ['Gujarati', 0x0A80, 0x0AFF], ['Oriya', 0x0B00, 0x0B7F], ['Tamil', 0x0B80, 0x0BFF],
    ['Telugu', 0x0C00, 0x0C7F], ['Kannada', 0x0C80, 0x0CFF], ['Malayalam', 0x0D00, 0x0D7F],
    ['Devanagari', 0xA8E0, 0xA8FF], ['Devanagari', 0x1CD0, 0x1CFF],
  ];
  const INDIC_RE = /[\u0900-\u0D7F\uA8E0-\uA8FF\u1CD0-\u1CFF]/;
  // characters shared by Indic scripts that must stay in the run of the text around them
  const JOINERS = new Set([0x200B, 0x200C, 0x200D, 0x25CC, 0x0964, 0x0965]);
  const FAMILY_PREFIX = 'FolioIndic ';
  const MN_RE = /\p{Mn}/u, CF_RE = /\p{Cf}/u;
  const ALL_FAMILIES = [...new Set(SCRIPTS.map((s) => s[0]))].map((s) => `"${FAMILY_PREFIX}${s}"`).join(', ');

  function scriptOf(cp) {
    for (const [name, a, b] of SCRIPTS) if (cp >= a && cp <= b) return name;
    return null;
  }
  function scriptsIn(text) {
    const set = new Set();
    for (const ch of text) { const s = scriptOf(ch.codePointAt(0)); if (s) set.add(s); }
    return [...set];
  }

  function create(env) {
    const { BASE, loadScript, b64ToBytes, ensureFontkit, getLatinFont } = env;

    let hbP = null;
    function hb() {
      if (hbP) return hbP;
      hbP = (async () => {
        if (!root.createHarfBuzz) await loadScript(BASE + 'vendor/harfbuzz/hb.js');
        if (!root.hbjs) await loadScript(BASE + 'vendor/harfbuzz/hbjs.js');
        let wasm = null;
        if (location.protocol !== 'file:') {
          try { const r = await fetch(BASE + 'vendor/harfbuzz/hb.wasm'); if (r.ok) wasm = await r.arrayBuffer(); } catch (e) { wasm = null; }
        }
        if (!wasm) {           // file:// can't fetch(); the same wasm ships as base64
          await loadScript(BASE + 'vendor/harfbuzz/hb-wasm-data.js');
          wasm = b64ToBytes(root.FolioHbWasm).buffer; delete root.FolioHbWasm;
        }
        const mod = await root.createHarfBuzz({ wasmBinary: wasm });
        return root.hbjs(mod);
      })();
      hbP.catch(() => { hbP = null; });
      return hbP;
    }

    const fontP = {};
    /** key: 'NotoSans<Script>-<Regular|Bold>' or 'Latin-<Regular|Bold|Regular-Basic|Bold-Basic>' */
    function font(key) {
      if (fontP[key]) return fontP[key];
      fontP[key] = (async () => {
        await ensureFontkit();
        const h = await hb();
        let bytes, label, family = null, weight = /Bold/.test(key) ? '700' : '400';
        if (key.startsWith('Latin-')) {
          bytes = (await getLatinFont(key.slice(6))).bytes;
          label = 'Noto Sans' + (weight === '700' ? ' Bold' : '');
        } else {
          if (!(root.FolioFontData && root.FolioFontData[key])) await loadScript(BASE + 'vendor/fonts/indic/' + key + '.js');
          bytes = b64ToBytes(root.FolioFontData[key]); delete root.FolioFontData[key];
          const script = key.replace(/^NotoSans|-(Regular|Bold)$/g, '');
          family = FAMILY_PREFIX + script;
          label = 'Noto Sans ' + script + (weight === '700' ? ' Bold' : '');
          try {                 // same bytes for the on-screen preview
            const ff = new FontFace(family, bytes.slice(0).buffer, { weight });
            await ff.load(); document.fonts.add(ff);
          } catch (e) { /* preview falls back */ }
        }
        const blob = h.createBlob(bytes.slice(0).buffer);
        const face = h.createFace(blob, 0);
        const hbFont = h.createFont(face);
        const fk = root.fontkit.create(bytes);
        const upem = fk.unitsPerEm;
        const advCache = new Map();
        let emptyGid = 0;           // an outline-less glyph for zero-width text carriers
        for (const cp of [0x200B, 0x200C, 0x200D, 0x20]) { const gl = fk.glyphForCodePoint(cp); if (gl && gl.id) { emptyGid = gl.id; break; } }
        return {
          key, bytes, label, family, hbFont, fk, upem, emptyGid, name: String(fk.postscriptName || key).replace(/[^A-Za-z0-9\-+]/g, ''),
          has: (cp) => fk.hasGlyphForCodePoint(cp),
          adv: (gid) => { if (!advCache.has(gid)) advCache.set(gid, Math.round(hbFont.glyphHAdvance(gid) * 1000 / upem * 100) / 100); return advCache.get(gid); },
        };
      })();
      fontP[key].catch(() => { delete fontP[key]; });
      return fontP[key];
    }

    const style = (bold) => (bold ? 'Bold' : 'Regular');
    /** Load HarfBuzz + the fonts needed for `text` (and register them for the preview). */
    async function prepare(text, bold) {
      const st = style(bold);
      const keys = scriptsIn(text).map((s) => 'NotoSans' + s + '-' + st);
      keys.push('Latin-' + st + '-Basic', 'Latin-' + st);
      const fonts = await Promise.all(keys.map(font));
      return fonts;
    }

    /** Shape a single line. Returns { glyphs, width (1/1000 em), fonts: [labels], missing: [chars] }. */
    async function shape(text, opts) {
      const bold = !!(opts && opts.bold);
      const st = style(bold);
      const fonts = await prepare(text, bold);
      const latinB = fonts.find((f) => f.key === 'Latin-' + st + '-Basic');
      const latinX = fonts.find((f) => f.key === 'Latin-' + st);
      const indicFor = (s) => fonts.find((f) => f.key === 'NotoSans' + s + '-' + st);
      const h = await hb();
      // itemize (UTF-16 offsets), mirroring browser font fallback: primary font first, then the script font;
      // joiners / danda / dotted circle stay with the Indic run they belong to
      const cps = Array.from(text);
      const runs = []; const missing = [];
      let off = 0, prevIndic = null;
      for (let i = 0; i < cps.length; i++) {
        const ch = cps[i], cp = ch.codePointAt(0), len = ch.length;
        let f = null;
        const s = scriptOf(cp);
        if (JOINERS.has(cp) && prevIndic && prevIndic.has(cp)) f = prevIndic;
        else if (s) f = indicFor(s);
        else if (JOINERS.has(cp)) {
          const nxt = cps.slice(i + 1).map((c) => scriptOf(c.codePointAt(0))).find(Boolean);
          f = nxt ? indicFor(nxt) : null;
        }
        if (!f || !f.has(cp)) f = latinB.has(cp) ? latinB : latinX.has(cp) ? latinX : (f && f.has(cp) ? f : null);
        if (!f) { missing.push(ch); f = latinX; }
        if (f.family) prevIndic = f;
        const last = runs[runs.length - 1];
        if (last && last.font === f) last.len += len; else runs.push({ font: f, off, len });
        off += len;
      }
      const glyphs = [];
      let width = 0;
      for (const r of runs) {
        const buf = h.createBuffer();
        buf.addText(text, r.off, r.len);        // whole line as context, this run as the item
        buf.guessSegmentProperties();
        h.shape(r.font.hbFont, buf);
        const out = buf.json();
        buf.destroy();
        const k = 1000 / r.font.upem;
        const cls = [...new Set(out.map((g) => g.cl))].sort((a, b) => a - b);
        const endOf = (cl) => { const j = cls.indexOf(cl); return j + 1 < cls.length ? cls[j + 1] : r.off + r.len; };
        // Group glyphs by cluster and hand the cluster's characters out in glyph order (the extracted text
        // is the concatenation of per-glyph ToUnicode strings, so it comes out in logical order even when
        // a matra is drawn before its consonant). Extractors such as pdf.js treat any glyph whose text
        // contains a nonspacing mark (Mn) as zero-width, so marks never ride on a glyph that has width:
        // they go on an invisible zero-width filler glyph placed right after it.
        const filler = (u) => glyphs.push({ font: r.font, gid: r.font.emptyGid, ax: 0, dx: 0, dy: 0, u, filler: true });
        for (let i = 0; i < out.length;) {
          let j = i; while (j < out.length && out[j].cl === out[i].cl) j++;
          const real = out.slice(i, j), n = real.length;
          const clText = text.slice(out[i].cl, endOf(out[i].cl));
          let toks = Array.from(clText).filter((ch) => !CF_RE.test(ch));
          const wide = real.map((g) => g.ax > 0);
          if (wide.filter(Boolean).length > toks.filter((t) => !MN_RE.test(t)).length) toks = Array.from(clText.normalize('NFD')).filter((ch) => !CF_RE.test(ch));
          // partition tokens (logical order) into one group per glyph; a wide glyph's group starts at a non-mark
          const starts = []; let pos = 0;
          for (let q = 0; q < n; q++) {
            let p0 = q === 0 ? 0 : pos;
            if (q > 0 && wide[q]) while (p0 < toks.length && MN_RE.test(toks[p0])) p0++;
            p0 = Math.min(p0, toks.length); starts.push(p0); pos = Math.min(p0 + 1, toks.length);
          }
          for (let q = 0; q < n; q++) {
            const g = real[q];
            const group = toks.slice(starts[q], q + 1 < n ? starts[q + 1] : toks.length);
            let u = group.join(''), after = '';
            if (wide[q]) {
              let h = 0; while (h < group.length && MN_RE.test(group[h])) h++;
              if (h > 0 && h < group.length) { filler(group.slice(0, h).join('')); u = group[h]; after = group.slice(h + 1).join(''); }
              else if (h === 0 && group.length) { u = group[0]; after = group.slice(1).join(''); }
            }
            glyphs.push({ font: r.font, gid: g.g, ax: g.ax * k, dx: g.dx * k, dy: g.dy * k, u });
            if (after) filler(after);
            width += g.ax * k;
          }
          i = j;
        }
      }
      return { text, glyphs, width, fonts: [...new Set(runs.map((r) => r.font.label))], missing };
    }

    const fmt = (v) => { const r = Math.round(v * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };
    const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
    const utf16hex = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += hex4(s.charCodeAt(i)); return o; };

    /** Per-document CID font writer. Call finalize() before doc.save(). */
    function writer(doc) {
      if (doc.__folioIndic) return doc.__folioIndic;
      const L = root.PDFLib;
      const fonts = new Map();           // key -> { f, ref, cids: Map, list: [] }
      const pageNames = new WeakMap();    // page node -> { key: '/Fn' }
      function entry(f) {
        if (!fonts.has(f.key)) fonts.set(f.key, { f, ref: doc.context.nextRef(), cids: new Map(), list: [] });
        return fonts.get(f.key);
      }
      // One CID per (glyph, source text, advance). The advance written in /W is chosen so that after the
      // glyph the pen sits exactly at the next logical position (ax − dx): marks shifted back over their
      // base then need no rightward TJ gap, which text extractors would read as a space.
      function cid(e, gid, u, w) {
        const k = gid + '\u0000' + u + '\u0000' + w;
        let c = e.cids.get(k);
        if (c == null) { c = e.list.length + 1; e.cids.set(k, c); e.list.push({ cid: c, gid, u, w }); }
        return c;
      }
      function nameFor(page, e) {
        let m = pageNames.get(page.node); if (!m) { m = {}; pageNames.set(page.node, m); }
        if (!m[e.f.key]) m[e.f.key] = page.node.newFontDictionary('FolioShaped', e.ref).toString();
        return m[e.f.key];
      }
      /** Content-stream operators drawing a shaped line with its baseline origin at (x, y).
       *  In-flow glyphs are written left to right in TJ arrays with their true advances, so text
       *  extractors see a clean run. Glyphs HarfBuzz offsets (GPOS mark / cursive positioning) are
       *  drawn afterwards at absolute positions with a CID mapped to an invisible format character;
       *  their text and advance ride on an outline-less carrier glyph in the flow instead. */
      function draw(page, shaped, o) {
        const hs = o.hs || 1, size = o.size;
        let s = `q BT ${o.rgb} rg ` + (o.fakeBold ? `${o.rgb} RG ${fmt(o.fakeBold)} w 2 Tr ` : '0 Tr ') +
          `0 Tc 0 Tw 100 Tz 0 Ts ${fmt(size * hs)} 0 0 ${fmt(size)} ${fmt(o.x)} ${fmt(o.y)} Tm\n` +
          `/Span <</ActualText <FEFF${utf16hex(shaped.text)}>>> BDC\n`;
        let curFont = null, open = false, P = 0;
        const detached = [];
        const close = () => { if (open) { s += '] TJ\n'; open = false; } };
        const setFont = (e) => { if (curFont !== e) { close(); s += `${nameFor(page, e)} 1 Tf `; curFont = e; } };
        for (const g of shaped.glyphs) {
          const e = entry(g.font);
          const offset = !g.filler && (Math.abs(g.dx) > 0.5 || Math.abs(g.dy) > 0.5);
          if (offset) detached.push({ e, gid: g.gid, x: P + g.dx, y: g.dy });
          const gid = offset ? g.font.emptyGid : g.gid;
          const w = Math.max(0, Math.round(g.ax * 100) / 100);
          setFont(e);
          if (!open) { s += '['; open = true; }
          s += `<${hex4(cid(e, gid, g.u || '\u200B', w))}>`;
          P += w;
        }
        close();
        for (const d of detached) {
          setFont(d.e);
          s += `${fmt(size * hs)} 0 0 ${fmt(size)} ${fmt(o.x + d.x / 1000 * size * hs)} ${fmt(o.y + d.y / 1000 * size)} Tm [<${hex4(cid(d.e, d.gid, '\u200B', 0))}>] TJ\n`;
        }
        s += 'EMC ET Q\n';
        return s;
      }
      function finalize() {
        for (const e of fonts.values()) {
          if (e.done) continue;
          e.done = true;
          const f = e.f, k = 1000 / f.upem, ctx = doc.context;
          const bb = f.fk.bbox;
          const file = ctx.flateStream(f.bytes, { Length1: f.bytes.length });
          const fd = ctx.obj({
            Type: 'FontDescriptor', FontName: f.name, Flags: 4,
            FontBBox: [bb.minX * k, bb.minY * k, bb.maxX * k, bb.maxY * k].map(Math.round),
            ItalicAngle: 0, Ascent: Math.round(f.fk.ascent * k), Descent: Math.round(f.fk.descent * k),
            CapHeight: Math.round((f.fk.capHeight || f.fk.ascent * 0.7) * k), StemV: 80, FontFile2: ctx.register(file),
          });
          const map = new Uint8Array((e.list.length + 1) * 2);
          const W = [];
          for (const { cid: c, gid, w } of e.list) { map[c * 2] = gid >> 8; map[c * 2 + 1] = gid & 255; W.push(c, [w]); }
          const cidFont = ctx.obj({
            Type: 'Font', Subtype: 'CIDFontType2', BaseFont: f.name,
            CIDSystemInfo: { Registry: L.PDFString.of('Adobe'), Ordering: L.PDFString.of('Identity'), Supplement: 0 },
            FontDescriptor: ctx.register(fd), DW: 0, W, CIDToGIDMap: ctx.register(ctx.flateStream(map)),
          });
          let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
            '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
          const withText = e.list.filter((x) => x.u);
          for (let i = 0; i < withText.length; i += 100) {
            const chunk = withText.slice(i, i + 100);
            cmap += `${chunk.length} beginbfchar\n` + chunk.map((x) => `<${hex4(x.cid)}> <${utf16hex(x.u)}>`).join('\n') + '\nendbfchar\n';
          }
          cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
          const tu = ctx.register(ctx.flateStream(new TextEncoder().encode(cmap)));
          ctx.assign(e.ref, ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: f.name, Encoding: 'Identity-H', DescendantFonts: [ctx.register(cidFont)], ToUnicode: tu }));
        }
      }
      const w = { draw, finalize, fonts };
      doc.__folioIndic = w;
      return w;
    }

    /** HarfBuzz clusters for `text` in Noto (visual order): [{text, n}] with n = glyph count (no fillers). */
    async function clusters(text) {
      text = String(text || '');
      if (!text) return [];
      const bold = false;
      const st = style(bold);
      const fonts = await prepare(text, bold);
      const latinB = fonts.find((f) => f.key === 'Latin-' + st + '-Basic');
      const latinX = fonts.find((f) => f.key === 'Latin-' + st);
      const indicFor = (s) => fonts.find((f) => f.key === 'NotoSans' + s + '-' + st);
      const h = await hb();
      const cps = Array.from(text);
      const runs = [];
      let off = 0, prevIndic = null;
      for (let i = 0; i < cps.length; i++) {
        const ch = cps[i], cp = ch.codePointAt(0), len = ch.length;
        let f = null;
        const s = scriptOf(cp);
        if (JOINERS.has(cp) && prevIndic && prevIndic.has(cp)) f = prevIndic;
        else if (s) f = indicFor(s);
        else if (JOINERS.has(cp)) {
          const nxt = cps.slice(i + 1).map((c) => scriptOf(c.codePointAt(0))).find(Boolean);
          f = nxt ? indicFor(nxt) : null;
        }
        if (!f || !f.has(cp)) f = latinB.has(cp) ? latinB : latinX.has(cp) ? latinX : (f && f.has(cp) ? f : null);
        if (!f) f = latinX;
        if (f.family) prevIndic = f;
        const last = runs[runs.length - 1];
        if (last && last.font === f) last.len += len; else runs.push({ font: f, off, len });
        off += len;
      }
      const out = [];
      for (const r of runs) {
        const buf = h.createBuffer();
        buf.addText(text, r.off, r.len);
        buf.guessSegmentProperties();
        h.shape(r.font.hbFont, buf);
        const gs = buf.json();
        buf.destroy();
        const cls = [...new Set(gs.map((g) => g.cl))].sort((a, b) => a - b);
        const endOf = (cl) => { const j = cls.indexOf(cl); return j + 1 < cls.length ? cls[j + 1] : r.off + r.len; };
        for (let i = 0; i < gs.length;) {
          let j = i; while (j < gs.length && gs[j].cl === gs[i].cl) j++;
          out.push({ text: text.slice(gs[i].cl, endOf(gs[i].cl)), n: j - i, gids: gs.slice(i, j).map((g) => g.g), font: r.font.key });
          i = j;
        }
      }
      return out;
    }

    return { shape, prepare, writer, font, hb, scriptsIn, clusters };
  }

  root.FolioIndic = { create, INDIC_RE, scriptOf, scriptsIn, ALL_FAMILIES, FAMILY_PREFIX };
})(window);
