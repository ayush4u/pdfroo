/* Folio — checking Indic lines whose PDF text layer may not match what is printed (lazy-loaded).
 *
 * Three readings of one line are compared:
 *   text layer  what pdf.js extracts (the PDF's ToUnicode map; Word often gets Indic glyphs wrong),
 *   font        glyph IDs mapped back through the embedded font's own cmap, with ligature/conjunct glyphs
 *               decomposed by reversing its GSUB (when the subset kept it) and put back in logical order
 *               (pre-base matras after their consonant cluster, reph before its syllable). Glyphs the font
 *               can't explain fall back to the ToUnicode text and are marked unverified,
 *   OCR         tesseract.js on the line rendered at 300 dpi (loaded only when needed).
 */
(function (root) {
  'use strict';

  // ONE switch for when a line is edited without asking (measured on 1,880 real gov.in lines, see README):
  //   'letters'  OCR and the text layer have the same letters (NFC, ZWJ/ZWNJ, punctuation, digits and
  //              whitespace ignored) and the font reading, when there is one, doesn't contradict them;
  //              the text-layer string is kept                                                   ← default
  //   'exact'    the same, but OCR and the text layer must match exactly (only whitespace collapsed)
  //   'never'    always ask
  // Near matches are never accepted, and legacy-font (Kruti Dev / Chanakya) lines are always confirmed.
  const INDIC_AUTOACCEPT = 'letters';

  const ZW_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  const norm = (s) => String(s || '').normalize('NFC').replace(ZW_RE, '').replace(/\s+/g, ' ').trim();
  // comparison key: no spaces; dashes (OCR reads an em dash as '--') and danda look-alikes unified
  const cmpKey = (s) => norm(s).replace(/\s+/g, '').replace(/[-\u2010-\u2015\u2212]+/g, '-').replace(/\|/g, '\u0964');
  const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('hi', { granularity: 'grapheme' }) : null;
  const graphemes = (s) => (SEG ? Array.from(SEG.segment(s), (x) => x.segment) : Array.from(s));

  /* ---------- character classes (the nine Brahmic blocks share the ISCII layout) ---------- */
  const PRE_BASE = new Set([0x093F, 0x094E, 0x09BF, 0x09C7, 0x09C8, 0x0A3F, 0x0ABF, 0x0B47, 0x0B48, 0x0BC6, 0x0BC7, 0x0BC8, 0x0D46, 0x0D47, 0x0D48]);
  const REPH_BLOCKS = [0x0900, 0x0980, 0x0A80, 0x0B00, 0x0C00, 0x0C80, 0x0D00];
  const REPHS = new Set(REPH_BLOCKS.map((b) => String.fromCharCode(b + 0x30, b + 0x4D)));
  function cls(ch) {
    if (!ch) return 'X';
    const cp = ch.codePointAt(0);
    if (cp === 0x200C || cp === 0x200D) return 'J';
    if (cp < 0x0900 || cp > 0x0D7F) return /\s/.test(ch) ? 'S' : 'X';
    if (PRE_BASE.has(cp)) return 'P';
    const blk = cp & 0xFF80, o = cp & 0x7F;
    if ((o >= 0x15 && o <= 0x39) || (o >= 0x58 && o <= 0x5F) || (blk === 0x0D00 && ((o >= 0x54 && o <= 0x56) || o >= 0x7A)) ||
        ((blk === 0x0980 || blk === 0x0B00) && (o === 0x70 || o === 0x71))) return 'C';
    if (o === 0x3C) return 'N';
    if (o === 0x4D) return 'H';
    if ((o >= 0x3E && o <= 0x4C) || (o >= 0x62 && o <= 0x63) || o === 0x57 || (blk !== 0x0D00 && (o === 0x55 || o === 0x56))) return 'V';
    if (o >= 0x01 && o <= 0x03) return 'A';
    if ((o >= 0x04 && o <= 0x14) || o === 0x60 || o === 0x61) return 'I';
    return 'L';
  }
  const first = (t) => cls(Array.from(t || '')[0]);
  const last = (t) => { const a = Array.from((t || '').replace(/[\u200C\u200D]+$/, '')); return cls(a[a.length - 1]); };
  const inSyllable = (t) => 'CNVAHPI'.includes(last(t));

  /** Visual glyph order → logical Unicode order. units: [{t, v}] (t = text of one glyph, v = verified). */
  function reorder(units) {
    let u = units.filter((x) => x.t).map((x) => ({ t: x.t, v: x.v }));
    // 0a) ambiguous consonant form (U+E000 + C): a half form before a consonant; after a consonant or its
    //     vowel sign it is the below-base form (virama first); a lone RA after a syllable is a reph
    u.forEach((x, i) => {
      if (x.t[0] !== '\uE000') return;
      const c = x.t[1], h = String.fromCharCode((c.charCodeAt(0) & 0xFF80) + 0x4D);
      const prev = u[i - 1], next = u[i + 1];
      const isRa = (c.charCodeAt(0) & 0x7F) === 0x30;
      if (prev && 'CN'.includes(last(prev.t))) x.t = h + c;
      else if (prev && 'VA'.includes(last(prev.t)) && !isRa) x.t = h + c;
      else if (next && first(next.t) === 'C' && !(isRa && prev && inSyllable(prev.t))) x.t = c + h;
      else x.t = c + h;
    });
    // Telugu has no default reph: a ra+virama glyph right after a consonant is the below-base ra
    u.forEach((x, i) => {
      if (x.t === '\u0C30\u0C4D' && u[i - 1] && 'CN'.includes(last(u[i - 1].t))) x.t = '\u0C4D\u0C30';
    });
    // 0b) a reph fused with neighbouring marks (e.g. ो+reph, reph+anusvara) becomes its own unit
    const split = [];
    for (const x of u) {
      const a = Array.from(x.t); let cur = '';
      for (let k = 0; k < a.length; k++) {
        const isReph = k + 1 < a.length && REPHS.has(a[k] + a[k + 1]) && cls(a[k - 1]) !== 'H' && cls(a[k + 2]) !== 'C' && a.length > 2;
        if (isReph) { if (cur) split.push({ t: cur, v: x.v }); split.push({ t: a[k] + a[k + 1], v: x.v }); cur = ''; k++; }
        else cur += a[k];
      }
      if (cur) split.push({ t: cur, v: x.v });
    }
    u = split;
    // 0c) below-base consonant forms (Telugu, Kannada…) drawn after the base's vowel sign: virama+consonant
    //     goes before the trailing vowel signs of the syllable
    for (let i = 1; i < u.length; i++) {
      const a = Array.from(u[i].t);
      if (cls(a[0]) !== 'H' || cls(a[1]) !== 'C') continue;
      let j = i - 1; const moved = [];
      while (j >= 0 && Array.from(u[j].t).every((ch) => 'VA'.includes(cls(ch)))) { moved.unshift(u[j]); j--; }
      if (j < 0) continue;
      const pa = Array.from(u[j].t); let tail = '';
      while (pa.length > 1 && 'VA'.includes(cls(pa[pa.length - 1]))) tail = pa.pop() + tail;
      if (!tail && !moved.length) continue;
      const cur = u[i];
      u.splice(j + 1, i - j);                                       // drop moved mark units + current
      u[j] = { t: pa.join(''), v: u[j].v };
      const ins = [cur]; if (tail) ins.push({ t: tail, v: u[j].v }); ins.push(...moved);
      u.splice(j + 1, 0, ...ins);
    }
    // 1) reph: drawn after its syllable, typed before it
    for (let i = 1; i < u.length; i++) {
      if (!REPHS.has(u[i].t) || !inSyllable(u[i - 1].t)) continue;
      let j = i - 1;
      while (j > 0) {
        const f = first(u[j].t);
        if ('VANHJ'.includes(f) || (f === 'C' && last(u[j - 1].t) === 'H')) { j--; continue; }
        break;
      }
      if (j > 0 && first(u[j - 1].t) === 'P') j--;
      const [r] = u.splice(i, 1); u.splice(j, 0, r);
    }
    // 2) pre-base matras: drawn before the consonant cluster, typed after it
    for (let i = 0; i < u.length; i++) {
      if (first(u[i].t) !== 'P' || i + 1 >= u.length || first(u[i + 1].t) !== 'C') continue;
      let k = i + 1;
      while (k + 1 < u.length) {
        const nf = first(u[k + 1].t);
        if (nf === 'N' || (nf === 'C' && last(u[k].t) === 'H') || nf === 'H' || nf === 'J') k++; else break;
      }
      const [m] = u.splice(i, 1); u.splice(k, 0, m);
      i = k;
    }
    // graphemes with a verified flag (all of their characters verified); NFC composes split vowels
    let s = '', flags = [];
    for (const x of u) for (const ch of x.t) { s += ch; for (let n = 0; n < ch.length; n++) flags.push(x.v); }
    const gs = []; let pos = 0;
    for (const g of graphemes(s)) {
      const v = flags.slice(pos, pos + g.length).every(Boolean); pos += g.length;
      const gt = g.normalize('NFC').replace(ZW_RE, '');
      if (!gt) continue;
      if (/^\s+$/.test(gt)) { if (gs.length && gs[gs.length - 1].g !== ' ') gs.push({ g: ' ', v: true }); continue; }
      gs.push({ g: gt, v });
    }
    while (gs.length && gs[gs.length - 1].g === ' ') gs.pop();
    while (gs.length && gs[0].g === ' ') gs.shift();
    return { text: gs.map((x) => x.g).join(''), graphemes: gs, complete: gs.every((x) => x.v), unverified: gs.filter((x) => !x.v).length };
  }

  /* ---------- reversing a font's GSUB: output glyph → input glyph sequence ---------- */
  const arr = (x) => (!x ? [] : Array.isArray(x) ? x : x.toArray ? x.toArray() : Array.from({ length: x.length }, (_, i) => (x.get ? x.get(i) : x[i])));
  function coverage(cov) {
    if (!cov) return [];
    if (cov.version === 1) return arr(cov.glyphs);
    const out = [];
    for (const r of arr(cov.rangeRecords)) for (let g = r.start; g <= r.end; g++) out.push(g);
    return out;
  }
  function gsubReverse(font) {
    const rev = new Map();
    let G = null; try { G = font.GSUB; } catch (e) { G = null; }
    if (!G || !G.lookupList) return rev;
    const put = (out, src) => {
      if (src.length === 1 && src[0] === out) return;
      const l = rev.get(out) || []; if (!l.some((x) => x.length === src.length && x.every((g, i) => g === src[i]))) l.push(src);
      rev.set(out, l);
    };
    const lookups = arr(G.lookupList);
    // ligatures first (conjuncts, half forms, reph), then single/alternate substitutions (glyph variants)
    for (const pass of [4, 1]) {
      for (const l of lookups) {
        for (let st of arr(l.subTables)) {
          let t = l.lookupType;
          if (t === 7) { t = st.lookupType; st = st.extension; }
          if (!st) continue;
          try {
            const gs = coverage(st.coverage);
            if (pass === 4 && t === 4) {
              const sets = arr(st.ligatureSets);
              gs.forEach((g, k) => { for (const lig of arr(sets[k])) put(lig.glyph, [g, ...arr(lig.components)]); });
            } else if (pass === 1 && t === 1) {
              const subs = st.version === 2 ? arr(st.substitute) : null;
              gs.forEach((g, k) => put(subs ? subs[k] : (g + st.deltaGlyphID) & 0xFFFF, [g]));
            } else if (pass === 1 && t === 3) {
              const sets = arr(st.alternateSet);
              gs.forEach((g, k) => { for (const a of arr(sets[k])) put(a, [g]); });
            }
          } catch (e) { /* malformed subtable: skip */ }
        }
      }
    }
    return rev;
  }

  /** Per-font glyph → text resolver (cmap, then reversed GSUB). Returns null for glyphs it can't explain. */
  function glyphReader(font) {
    const rev = gsubReverse(font);
    // reverse cmap, built once from the font's character set (preferring Indic, then non-NBSP code points)
    const back = new Map();
    let cs = []; try { cs = font.characterSet || []; } catch (e) { cs = []; }
    const rank = (c) => (c >= 0x0900 && c <= 0x0D7F ? 0 : c === 0xA0 ? 2 : 1);
    for (const c of cs) {
      let gid = 0; try { gid = font.glyphForCodePoint(c).id; } catch (e) { gid = 0; }
      if (!gid) continue;
      const cur = back.get(gid);
      if (cur == null || rank(c) < rank(cur)) back.set(gid, c);
    }
    const cmapText = (gid) => { const c = back.get(gid); return c == null ? null : String.fromCodePoint(c === 0xA0 ? 0x20 : c); };
    // every text a glyph can stand for: its cmap character, or each reversed GSUB source (components
    // resolved recursively to their first reading)
    const memo = new Map();
    const texts = (gid, depth) => {
      if (memo.has(gid)) return memo.get(gid);
      memo.set(gid, []);                                        // cycle guard
      const t = cmapText(gid);
      let out = [];
      if (t != null) out = [t];
      else if (depth < 8 && rev.has(gid)) {
        for (const src of rev.get(gid)) {
          if (src.length === 1) { for (const x of texts(src[0], depth + 1)) if (!out.includes(x)) out.push(x); continue; }
          const parts = src.map((g) => texts(g, depth + 1)[0]);
          if (parts.every((x) => x != null)) { const j = parts.join(''); if (!out.includes(j)) out.push(j); }
        }
      }
      memo.set(gid, out);
      return out;
    };
    // consonant+virama vs virama+consonant (half / reph form vs below-base form): same glyph, told apart by position
    const CH = (t) => { const a = Array.from(t); return a.length === 2 && cls(a[0]) === 'C' && cls(a[1]) === 'H' ? a[0] : null; };
    const HC = (t) => { const a = Array.from(t); return a.length === 2 && cls(a[0]) === 'H' && cls(a[1]) === 'C' ? a[1] : null; };
    /** Text for a glyph (null if the font can't explain it). hint = the PDF's ToUnicode text: when the
     *  font allows several readings (many-to-one substitutions), a hint that is one of them is used. */
    const read = (gid, hint) => {
      const ts = texts(gid, 0);
      if (!ts.length) return null;
      if (ts.length === 1) return ts[0];
      const h = hint != null ? String(hint).normalize('NFC') : null;
      if (h && ts.includes(h)) return h;
      const c = ts.map(CH).find(Boolean);
      if (c && ts.some((t) => HC(t) === c) && ts.every((t) => CH(t) === c || HC(t) === c)) return '\uE000' + c;
      return hint == null ? ts[0] : null;
    };
    return { read, hasGSUB: rev.size > 0, cmapSize: back.size };
  }

  /* ---------- diff / merge ---------- */
  function diff(a, b) {                                     // grapheme arrays → [{op:'=',a,b} | {op:'~',a:[],b:[]}]
    const n = a.length, m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const ops = []; let i = 0, j = 0, cur = null;
    const hunk = () => { if (!cur) { cur = { op: '~', a: [], b: [], ai: i, bj: j }; ops.push(cur); } return cur; };
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { cur = null; ops.push({ op: '=', a: [a[i]], b: [b[j]], ai: i, bj: j }); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { hunk().b.push(b[j]); j++; }
      else { hunk().a.push(a[i]); i++; }
    }
    return ops;
  }
  /** Best guess from the font reading (graphemes with verified flags) and OCR text. */
  function merge(font, ocrText) {
    const fg = font.graphemes, og = graphemes(norm(ocrText));
    const ops = diff(fg.map((x) => x.g), og);
    let out = '';
    for (const o of ops) {
      if (o.op === '=') { out += o.a[0]; continue; }
      // word spaces come from positions, not glyphs: where the readings differ only by spaces, OCR decides
      if (o.a.every((g) => g === ' ') && o.b.every((g) => g === ' ')) { out += o.b.join(''); continue; }
      if (o.a.length && o.b.length && cmpKey(o.a.join('')) === cmpKey(o.b.join(''))) { out += o.b.join(''); continue; }   // same letters, other spacing
      const fa = fg.slice(o.ai, o.ai + o.a.length);
      const before = fg[o.ai - 1], after = fg[o.ai + o.a.length];
      const nearUnverified = (before && !before.v) || (after && !after.v);
      if (fa.length && fa.every((x) => x.v)) out += o.a.join('');                 // the font explains these glyphs
      else if (!fa.length && !nearUnverified) { /* OCR-only insertion next to verified text: ignore */ }
      else if (o.b.length) out += o.b.join('');                                   // unverified glyphs: trust OCR
      else out += fa.filter((x) => x.v).map((x) => x.g).join('');
    }
    return norm(out);
  }
  /** Spans of `text` marked where it differs from `ref` (for highlighting). */
  function marks(text, ref) {
    const ops = diff(graphemes(norm(text)), graphemes(norm(ref)));
    const spans = [];
    const push = (t, d) => { if (!t) return; const l = spans[spans.length - 1]; if (l && l.diff === d) l.t += t; else spans.push({ t, diff: d }); };
    for (const o of ops) {
      if (o.op === '=') push(o.a[0], false);
      else if (o.a.length) push(o.a.join(''), true);
      else push('\u2038', true);                               // something missing here
    }
    return spans;
  }

  /** The decision. flagged: the analysis already found the text layer malformed. */
  /** Drop punctuation OCR picked up at the line's ends (neighbouring brackets, colons, rules) unless a
   *  reading from the PDF has it there too. */
  function trimEdges(ocrText, refs) {
    let t = norm(ocrText);
    const P = /[^\p{L}\p{M}\p{N}]/u;
    const has = (ch, atStart) => refs.some((r) => { const n = norm(r); return atStart ? n.startsWith(ch) : n.endsWith(ch); });
    let a = Array.from(t);
    while (a.length && (a[0] === ' ' || (P.test(a[0]) && !has(a[0], true) && !(dashy(a[0]) && refs.some((r) => dashy(Array.from(norm(r))[0] || '')))))) a.shift();
    while (a.length && (a[a.length - 1] === ' ' || (P.test(a[a.length - 1]) && !has(a[a.length - 1], false) && !(dashy(a[a.length - 1]) && refs.some((r) => dashy(Array.from(norm(r)).pop() || '')))))) a.pop();
    return a.join('');
  }
  const dashy = (c) => /^[-\u2010-\u2015\u2212]$/.test(c);
  const letters = (s) => norm(s).replace(/[^\p{L}\p{M}]/gu, '');
  /** Does the font reading contradict `ref`? Only glyphs the font itself explains (verified) count. */
  function fontDisagrees(font, ref) {
    if (!font) return false;
    const ops = diff(font.graphemes.map((x) => x.g), graphemes(norm(ref)));
    for (const o of ops) {
      if (o.op === '=') continue;
      const fa = font.graphemes.slice(o.ai, o.ai + o.a.length);
      const fl = letters(o.a.join('')), rl = letters(o.b.join(''));
      if (fl === rl) continue;
      if (fl && fa.every((x) => x.v)) return true;
    }
    return false;
  }
  const DIG = /[0-9\u0966-\u096F]+/g;
  /** Put the text layer's digits back (the hin model reads Latin 1 as 4; digits usually come from a clean Latin run). */
  function keepDigits(best, textLayer) {
    const tr = norm(textLayer).match(DIG) || [], br = best.match(DIG) || [];
    if (!tr.length || !br.length) return best;
    if (tr.length === br.length) { let i = 0; return best.replace(DIG, () => tr[i++]); }
    const td = tr.join(''), bd = br.join('');
    if (td.length === bd.length) { let k = 0; return best.replace(/[0-9\u0966-\u096F]/g, () => td[k++]); }
    return best;
  }
  /** `reading`'s letters with the text layer's punctuation, spaces and digits wherever the two differ only there. */
  function lettersOnto(textLayer, reading) {
    let out = '';
    for (const o of diff(graphemes(norm(textLayer)), graphemes(norm(reading)))) {
      if (o.op === '=' || letters(o.a.join('')) === letters(o.b.join(''))) out += o.a.join(''); else out += o.b.join('');
    }
    out = norm(out);
    return letters(out) === letters(reading) ? out : norm(reading);
  }
  /** The decision. flagged: the analysis already found the text layer malformed / unreliable.
   *  legacy: a Kruti Dev / Chanakya line; `font` is then the converter's reading. */
  function decide({ textLayer, flagged, font, ocr, rule, legacy }) {
    rule = rule || INDIC_AUTOACCEPT;
    const res = { rule, textLayer: norm(textLayer), font: font ? font.text : null, fontComplete: !!(font && font.complete), ocr: ocr ? norm(ocr.text) : null };
    if (legacy) {
      const conv = norm(font.text);
      const agree = ocr && letters(ocr.text) === letters(conv);
      return Object.assign(res, { decision: 'confirm', best: conv,
        why: !ocr ? 'legacy font; OCR isn’t available here' : agree ? 'legacy font; converter and OCR agree' : 'legacy font; converter and OCR disagree' });
    }
    const T = cmpKey(textLayer);
    const learned = !!(font && font.learned);
    res.learned = font ? font.learned || 0 : 0;
    if (!flagged && font && font.complete && !learned && cmpKey(font.text) === T) return Object.assign(res, { decision: 'text', source: 'font', best: res.textLayer, why: 'font reading matches the text layer' });
    const same = ocr && letters(textLayer).length > 0 && (rule === 'letters' ? letters(ocr.text) === letters(textLayer) : rule === 'exact' ? norm(ocr.text) === res.textLayer : false);
    const contra = same && fontDisagrees(font, textLayer);
    if (same && !contra) return Object.assign(res, { decision: flagged ? 'silent' : 'text', source: 'text layer', best: res.textLayer, why: 'OCR and the text layer agree' + (font ? ' and the font reading doesn’t contradict them' : '') });
    // a reading completed by this document's learned glyph map: accepted only when OCR has the same letters
    // (digits still come from the text layer; 'never' still asks)
    if (learned && rule !== 'never' && font.complete && ocr && letters(font.text).length > 0 && letters(font.text) === letters(ocr.text) &&
        (rule === 'letters' || norm(font.text) === norm(ocr.text))) {
      return Object.assign(res, { decision: 'silent', source: 'learned', best: keepDigits(lettersOnto(textLayer, font.text), textLayer),
        why: 'font reading (completed from glyphs learned on this document) and OCR agree' });
    }
    let best;
    if (font && ocr) best = merge(font, ocr.text);
    else if (font) best = font.text;
    else best = res.ocr || res.textLayer;
    best = keepDigits(best, textLayer);
    const agreeFO = font && ocr && letters(font.text) === letters(ocr.text);
    const why = contra ? 'OCR matches the text layer, but the font’s glyphs say otherwise'
      : !ocr ? 'OCR isn’t available here' : !font ? 'the font can’t be read back'
      : agreeFO ? 'font reading and OCR agree, but the text layer differs' : 'font reading and OCR disagree';
    return Object.assign(res, { decision: 'confirm', best, why, source: learned ? 'learned' : font ? 'font' : ocr ? 'ocr' : 'text layer' });
  }

  /* ---------- legacy Hindi fonts: Kruti Dev 010 (Remington) / Chanakya -> Unicode ----------
   * Port of the research converter work/krutidev.py (our own table, ~100 rules + ि / reph reordering);
   * output-identical to it on every legacy line of the test corpus. Research quality: always confirmed. */
  const KD_BASE = [
    ['zz', '्र'], ['’k', 'श'], ['vkS', 'औ'], ['vks', 'ओ'], ['vk', 'आ'], [',s', 'ऐ'], ['bZ', 'ई'],
    ['[k', 'ख'], ['?k', 'घ'], ['.k', 'ण'], ['Fk', 'थ'], ['/k', 'ध'], ['Hk', 'भ'], ["'k", 'श'], ['"k', 'ष'], ['{k', 'क्ष'], ['Ùk', 'त्त'],
    ['ks', 'ो'], ['kS', 'ौ'],
    ['v', 'अ'], ['b', 'इ'], ['m', 'उ'], ['Å', 'ऊ'], ['_', 'ऋ'], [',', 'ए'],
    ['d', 'क'], ['D', 'क्'], ['’', 'श्'], ['[', 'ख्'], ['x', 'ग'], ['X', 'ग्'], ['?', 'घ्'], ['³', 'ङ'], ['p', 'च'], ['P', 'च्'], ['N', 'छ'], ['t', 'ज'], ['T', 'ज्'],
    ['>', 'झ'], ['´', 'ञ'], ['V', 'ट'], ['B', 'ठ'], ['M', 'ड'], ['<', 'ढ'], ['.', 'ण्'], ['r', 'त'], ['R', 'त्'], ['F', 'थ्'], ['n', 'द'],
    ['/', 'ध्'], ['u', 'न'], ['U', 'न्'], ['i', 'प'], ['I', 'प्'], ['Q', 'फ'], ['c', 'ब'], ['C', 'ब्'], ['H', 'भ्'], ['e', 'म'], ['E', 'म्'],
    [';', 'य'], ['¸', 'य्'], ['j', 'र'], ['y', 'ल'], ['Y', 'ल्'], ['G', 'ळ'], ['o', 'व'], ['O', 'व्'], ["'", 'श्'], ['"', 'ष्'], ['l', 'स'], ['L', 'स्'],
    ['g', 'ह'], ['K', 'ज्ञ'], ['J', 'श्र'], ['Ø', 'क्र'], ['Ù', 'त्त्'], ['Ë', 'ट्ट'], ['–', 'दृ'], ['—', 'कृ'], ['{', 'क्ष्'], ['=', 'त्र'], ['é', 'न्न'],
    ['ß', 'द्य'], ['í', 'द्द'], ['Í', 'द्ध'], [')', 'द्ध'], ['ã', 'ह्म'], ['á', 'ह्य'], ['â', 'हृ'], ['à', 'ह्न'], ['º', 'ह्'], [':', 'रू'], ['#', 'रु'],
    ['k', 'ा'], ['h', 'ी'], ['q', 'ु'], ['w', 'ू'], ['`', 'ृ'], ['s', 'े'], ['S', 'ै'], ['a', 'ं'], ['¡', 'ँ'], ['~', '्'], ['z', '्र'], ['ª', '्र'], ['+', '़'],
    ['A', '।'], [']', ','], ['-', '.'], ['&', '-'], ['@', '/'], ['%', ':'], ['¼', '('], ['½', ')'], ['^', '‘'], ['*', '’'], ['Þ', '“'], ['ß', '”'],
    ['f', '\x01'], ['Z', '\x02'], ['±', '\x02ं'],
  ];
  const KD_SORTED = KD_BASE.map((kv, i) => [kv, i]).sort((a, b) => (b[0][0].length - a[0][0].length) || (a[1] - b[1])).map((x) => x[0]);
  const KD_CHANAKYA = [['=k', 'त्र'], ['=', 'त्र्'], ['/k', 'धा'], ['/', 'ध']].concat(KD_SORTED);
  const KD_C = '[\u0915-\u0939\u0958-\u095F]';
  const KD_CLUSTER = `(?:${KD_C}\u093C?\u094D)*${KD_C}\u093C?`;
  const KD_I_RE = new RegExp('\x01(' + KD_CLUSTER + ')', 'g');
  const KD_REPH_RE = new RegExp('(' + KD_CLUSTER + ')([\u093E-\u094C\u0902\u0901]*)\x02', 'g');
  function legacyToUnicode(s, variant) {
    const table = variant === 'chanakya' ? KD_CHANAKYA : KD_SORTED;
    const out = []; let i = 0;
    s = String(s);
    while (i < s.length) {
      let hit = null;
      for (const kv of table) if (s.startsWith(kv[0], i)) { hit = kv; break; }
      if (hit) { out.push(hit[1]); i += hit[0].length; } else { out.push(s[i]); i += 1; }
    }
    let t = out.join('');
    t = t.replace(KD_I_RE, '$1\u093F').split('\x01').join('\u093F');
    t = t.replace(KD_REPH_RE, 'र्$1$2').split('\x02').join('र्');
    return t.split('अा').join('आ').split('आे').join('ओ').split('आै').join('औ').split('एे').join('ऐ');
  }

  /* ---------- OCR (tesseract.js, created on first use) ---------- */
  const LANG = { Devanagari: 'hin', Bengali: 'ben', Gurmukhi: 'pan', Gujarati: 'guj', Oriya: 'ori', Tamil: 'tam', Telugu: 'tel', Kannada: 'kan', Malayalam: 'mal' };
  const NAMES = ['Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam'];
  function langsFor(text) {
    const set = [];
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x0900 && cp <= 0x0D7F) { const l = LANG[NAMES[(cp - 0x900) >> 7]]; if (!set.includes(l)) set.push(l); }
    }
    if (!set.length) set.push('hin');
    if (/[A-Za-z]/.test(text)) set.push('eng');
    return set.join('+');
  }
  const simd = () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; } };

  function create(env) {
    let worker = null, workerLangs = '', chain = Promise.resolve();
    const params = { tessedit_pageseg_mode: '7', preserve_interword_spaces: '1', user_defined_dpi: '300' };
    async function ensureWorker(langs, onStatus) {
      if (root.location && root.location.protocol === 'file:') throw Object.assign(new Error('OCR needs Folio to be opened over http(s)'), { code: 'file' });
      if (!root.Tesseract) await env.loadScript(env.BASE + 'vendor/tesseract/tesseract.min.js');
      const T = root.Tesseract;
      if (!worker) {
        worker = await T.createWorker(langs, 1, {
          workerPath: env.BASE + 'vendor/tesseract/worker.min.js', workerBlobURL: false,
          corePath: env.BASE + 'vendor/tesseract/core/folio-core-' + (simd() ? 'simd-' : '') + 'lstm.js',
          langPath: env.BASE + 'vendor/tesseract/lang', gzip: true, cacheMethod: 'write',
          logger: (m) => { if (onStatus) onStatus(m); },
        });
        workerLangs = langs; await worker.setParameters(params);
      } else if (workerLangs !== langs) {
        await worker.reinitialize(langs, 1); workerLangs = langs; await worker.setParameters(params);
      }
      return worker;
    }
    /** Recognise one line image (canvas). Serialised: one recognition at a time. */
    function ocr(canvas, langs, onStatus) {
      const run = chain.then(async () => {
        const t0 = performance.now();
        const w = await ensureWorker(langs, onStatus);
        const t1 = performance.now();
        const r = await w.recognize(canvas);
        const t2 = performance.now();
        return { text: String(r.data.text || '').replace(/\s+/g, ' ').trim(), conf: Math.round(r.data.confidence || 0), langs,
          loadMs: Math.round(t1 - t0), ms: Math.round(t2 - t1) };
      });
      chain = run.catch(() => {});
      return run;
    }
    async function terminate() { if (worker) { const w = worker; worker = null; workerLangs = ''; await w.terminate(); } }
    return { ocr, terminate, langsFor, reorder, glyphReader, decide, merge, marks, norm, cmpKey, graphemes, trimEdges, letters, keepDigits, legacyToUnicode, INDIC_AUTOACCEPT };
  }

  root.FolioIndicVerify = { create, reorder, glyphReader, decide, merge, marks, norm, cmpKey, langsFor, trimEdges, letters, keepDigits, legacyToUnicode, INDIC_AUTOACCEPT };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.FolioIndicVerify;
})(typeof window !== 'undefined' ? window : globalThis);
