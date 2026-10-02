/* =========================================================================
   Pdfroo — "Add like this" + reflow internals (engine layer, used only by pdfEngine.js)
   * scanGeometry: every vector path, image, Form XObject and inline image painted by a page content
     stream, with its page-space bbox, the clip in force and the colour / line-width state (for cloning)
   * rows / columns / paragraphs / bullets / headings from the analysed text lines
   * region tests and the cumulative shift of an item through a page's list of shifts
   * content-stream rewrites: a path drawn (0, dy) further in page space (its coordinates rewritten, so
     graphics state and clipping are untouched), images / forms wrapped in q / cm / Q, cloned paths
   ========================================================================= */
(function (root) {
  'use strict';
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const ID = [1, 0, 0, 1, 0, 0];
  const num = (a) => (a && a.t === 'num' ? a.v : 0);
  const fmt = (v) => { const r = Math.round(v * 10000) / 10000; return Object.is(r, -0) ? '0' : String(r); };
  const tp = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const bboxOf = (pts) => { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const inter = (a, b) => (!a ? b : !b ? a : [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  const CONSTRUCT = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
  const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
  const COLOR_OPS = new Set(['g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN']);

  /**
   * xinfo(name) -> null | { type: 'image' } | { type: 'form', bbox: [x0,y0,x1,y1], matrix: [6] }
   * Returns { items, textClip } — items: [{ kind: 'path'|'image'|'form'|'inline'|'shading', i0, i1, s, e, bbox,
   *   ctm, clip (bool: this path sets a clip), clipAt (page-space clip bbox in force, or null), stroke, lw, gsText }],
   * textClip: { opIndex: clip bbox in force when that text-show op ran }.
   */
  function scanGeometry(ops, xinfo) {
    const items = [], textClip = {};
    let gs = { ctm: ID.slice(), clip: null, lw: 1, color: {}, colorOk: true };
    const stack = [];
    let path = null, pendingClip = false, inText = false;
    const pts = (m, arr) => arr.map(([x, y]) => tp(m, x, y));
    ops.forEach((op, idx) => {
      const a = op.args;
      if (inText) {
        if (op.op === 'ET') inText = false;
        else if (op.op === 'Tj' || op.op === 'TJ' || op.op === "'" || op.op === '"') textClip[idx] = gs.clip;
        return;
      }
      if (CONSTRUCT.has(op.op)) {
        if (!path) path = { i0: idx, s: op.s, pts: [], ctm: gs.ctm.slice() };
        const v = a.map(num);
        if (op.op === 'm' || op.op === 'l') path.pts.push(...pts(gs.ctm, [[v[0], v[1]]]));
        else if (op.op === 'c') path.pts.push(...pts(gs.ctm, [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]]]));
        else if (op.op === 'v' || op.op === 'y') path.pts.push(...pts(gs.ctm, [[v[0], v[1]], [v[2], v[3]]]));
        else if (op.op === 're') path.pts.push(...pts(gs.ctm, [[v[0], v[1]], [v[0] + v[2], v[1]], [v[0], v[1] + v[3]], [v[0] + v[2], v[1] + v[3]]]));
        return;
      }
      if (op.op === 'W' || op.op === 'W*') { pendingClip = true; return; }
      if (PAINT.has(op.op)) {
        if (path && path.pts.length) {
          const stroke = /^[SsBb]/.test(op.op);
          const sc = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
          let bb = bboxOf(path.pts);
          const lw = stroke ? gs.lw * sc : 0;
          if (stroke) bb = [bb[0] - lw / 2, bb[1] - lw / 2, bb[2] + lw / 2, bb[3] + lw / 2];
          items.push({ kind: 'path', i0: path.i0, i1: idx, s: path.s, e: op.e, bbox: bb, ctm: path.ctm, clip: pendingClip, painted: op.op !== 'n', paint: op.op,
            clipAt: gs.clip, stroke, lw, gsText: gs.colorOk ? ['fillCs', 'fill', 'strokeCs', 'stroke'].map((k) => gs.color[k] || '').filter(Boolean).join(' ') + ` ${fmt(gs.lw)} w` : null, ops: ops.slice(path.i0, idx) });
          if (pendingClip) gs.clip = inter(gs.clip, bboxOf(path.pts));
        }
        path = null; pendingClip = false;
        return;
      }
      path = null;
      switch (op.op) {
        case 'BT': inText = true; break;
        case 'q': stack.push(JSON.parse(JSON.stringify(gs))); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': gs.ctm = mul(a.map(num), gs.ctm); break;
        case 'w': gs.lw = num(a[0]); break;
        case 'Do': {
          const x = a[0] && a[0].t === 'name' && xinfo ? xinfo(a[0].v) : null;
          if (!x) break;
          if (x.type === 'image') items.push({ kind: 'image', i0: idx, i1: idx, s: op.s, e: op.e, bbox: bboxOf(pts(gs.ctm, [[0, 0], [1, 0], [0, 1], [1, 1]])), ctm: gs.ctm.slice(), clipAt: gs.clip });
          else if (x.type === 'form') {
            const m = mul(x.matrix || ID, gs.ctm), b = x.bbox || [0, 0, 1, 1];
            items.push({ kind: 'form', i0: idx, i1: idx, s: op.s, e: op.e, bbox: bboxOf(pts(m, [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]])), ctm: gs.ctm.slice(), clipAt: gs.clip });
          }
          break;
        }
        case 'BI': items.push({ kind: 'inline', i0: idx, i1: idx, s: op.s, e: op.e, bbox: bboxOf(pts(gs.ctm, [[0, 0], [1, 0], [0, 1], [1, 1]])), ctm: gs.ctm.slice(), clipAt: gs.clip, open: true }); break;
        case 'EI': { const it = items[items.length - 1]; if (it && it.kind === 'inline' && it.open) { it.i1 = idx; it.e = op.e; delete it.open; } break; }
        case 'sh': items.push({ kind: 'shading', i0: idx, i1: idx, s: op.s, e: op.e, bbox: gs.clip || [-1e6, -1e6, 1e6, 1e6], ctm: gs.ctm.slice(), clipAt: gs.clip }); break;
        default:
          if (COLOR_OPS.has(op.op)) {
            const stroke = /^(G|RG|K|CS|SC|SCN)$/.test(op.op), side = stroke ? 'stroke' : 'fill';
            const txt = a.map((v) => (v.t === 'num' ? fmt(v.v) : v.t === 'name' ? '/' + v.v : '')).join(' ') + ' ' + op.op;
            if (/^(cs|CS)$/.test(op.op)) { gs.color[side + 'Cs'] = txt; gs.color[side] = ''; gs[side + 'Ok'] = /^Device(Gray|RGB|CMYK)$/.test(a[0] && a[0].v); }
            else {
              if (/^(g|rg|k|G|RG|K)$/.test(op.op)) { delete gs.color[side + 'Cs']; gs[side + 'Ok'] = true; }
              if (/^(scn|SCN)$/.test(op.op) && a.some((v) => v.t === 'name')) gs[side + 'Ok'] = false;
              gs.color[side] = txt;
            }
            gs.colorOk = gs.fillOk !== false && gs.strokeOk !== false;
          }
      }
    });
    return { items, textClip };
  }

  /* ---------------- regions and shifts ---------------- */
  /** A region is a list of page-space rects { x0, x1, yTop, yBot } (y up). Contained in any rect -> in the region. */
  function inRegion(bb, rects, tol) {
    const t = tol == null ? 1 : tol;
    const cy = (bb[1] + bb[3]) / 2;   // vertical centre decides: a tall ascender or a link box poking above the cut still belongs below it
    return rects.some((r) => bb[0] >= r.x0 - t && bb[2] <= r.x1 + t && cy <= r.yTop && cy >= r.yBot);
  }
  /** Total dy for an item (original bbox) through a page's shifts, each defined in the coordinates after the ones before. */
  function shiftFor(bb, shifts) {
    let b = bb.slice(), dy = 0;
    for (const s of shifts || []) if (inRegion(b, s.rects, s.tol)) { b = [b[0], b[1] + s.dy, b[2], b[3] + s.dy]; dy += s.dy; }
    return dy;
  }

  /** How far above a region's top a path may start and still move with it: a clip-only path must start inside; a painted
   *  box may poke up a little (a tag pill behind its text) but not span the cut (a page-white or sidebar fill, a frame). */
  const pathPoke = (it) => (it.painted ? Math.min(0.5 * (it.bbox[3] - it.bbox[1]), 6) : 0.1);
  /** dy for a scanned item: like shiftFor, but a path only moves when it starts inside the shifted region (pathPoke). */
  function itemShift(it, shifts) {
    if (it.kind !== 'path') return shiftFor(it.bbox, shifts);
    const poke = pathPoke(it);
    let b = it.bbox.slice(), dy = 0;
    for (const s of shifts || []) {
      const t = s.tol == null ? 1 : s.tol;
      if (inRegion(b, s.rects, s.tol) && s.rects.some((r) => b[0] >= r.x0 - t && b[2] <= r.x1 + t && b[3] <= r.yTop + poke)) { b = [b[0], b[1] + s.dy, b[2], b[3] + s.dy]; dy += s.dy; }
    }
    return dy;
  }

  /* ---------------- content-stream rewrites ---------------- */
  const inv = (m) => { const d = m[0] * m[3] - m[1] * m[2]; return d ? [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d] : null; };
  /** (0, dy) in page space expressed in the user space of matrix m. */
  function userDelta(m, dx, dy) { const i = inv(m); if (!i) return null; return [i[0] * dx + i[2] * dy, i[1] * dx + i[3] * dy]; }
  /** Path construction ops re-emitted with every point moved by (ux, uy) user units. */
  function movedPathOps(ops, ux, uy) {
    return ops.map((op) => {
      const v = op.args.map(num);
      const P = (k) => `${fmt(v[k] + ux)} ${fmt(v[k + 1] + uy)}`;
      switch (op.op) {
        case 'm': case 'l': return `${P(0)} ${op.op}`;
        case 'c': return `${P(0)} ${P(2)} ${P(4)} c`;
        case 'v': case 'y': return `${P(0)} ${P(2)} ${op.op}`;
        case 're': return `${P(0)} ${fmt(v[2])} ${fmt(v[3])} re`;
        case 'h': return 'h';
        default: return null;
      }
    });
  }
  /**
   * Replacements ({s, e, text}) moving the items of a scan by their own dy (dyOf(item) -> number|0).
   * Paths: coordinates rewritten in place (the paint op and everything else untouched). Images, forms,
   * inline images: wrapped in q [1 0 0 1 ux uy] cm … Q.
   */
  function shiftReps(str, scan, dyOf) {
    const reps = [];
    for (let k = 0; k < scan.items.length; k++) {
      const it = scan.items[k];
      const dy = dyOf(it, k);
      if (!dy || it.kind === 'shading') continue;
      const d = userDelta(it.ctm, 0, dy); if (!d) continue;
      if (it.kind === 'path') {
        const mv = movedPathOps(it.ops, d[0], d[1]);
        it.ops.forEach((op, k) => { if (mv[k] != null && op.op !== 'h') reps.push({ s: op.s, e: op.e, text: mv[k] }); });
      } else reps.push({ s: it.s, e: it.e, text: `q 1 0 0 1 ${fmt(d[0])} ${fmt(d[1])} cm ${str.slice(it.s, it.e)} Q` });
    }
    return reps;
  }
  /** Replacements that make items (indices into scan.items) paint nothing: a path keeps its construction (and any clip)
      but its paint op becomes 'n'; an image / form / inline image / shading op is removed. */
  function dropReps(ops, scan, keys) {
    const reps = [];
    for (const k of keys) {
      const it = scan.items[k]; if (!it) continue;
      if (it.kind === 'path') { if (!it.painted) continue; const po = ops[it.i1]; if (po) reps.push({ s: po.s, e: po.e, text: it.clip ? 'n' : 'n' }); }
      else reps.push({ s: it.s, e: it.e, text: '' });
    }
    return reps;
  }
  /** A stand-alone copy of a painted path, drawn dy further down (for "Add section like this": the heading's divider). */
  function clonePath(it, dx, dy) {
    if (it.kind !== 'path' || !it.painted || it.clip || it.gsText == null) return null;
    const d = userDelta(it.ctm, dx, dy); if (!d) return null;
    const body = movedPathOps(it.ops, d[0], d[1]);
    if (body.some((x) => x == null)) return null;
    return `q ${it.ctm.map(fmt).join(' ')} cm ${it.gsText} ${body.join(' ')} ${it.paint} Q\n`;
  }

  /* ---------------- text structure ---------------- */
  const BULLET_RE = /^[\u2022\u25CF\u25AA\u25A0\u2023\u25E6\u2043\u2219\u27A2\u2713\u2714\u25BA\u25B8\u2013\u2014\-*·▪•◦‣]/;
  /** Group analysed lines into visual rows: same baseline, small gaps (a bold label + its text, a bullet + its text). */
  function buildRows(lines, maxGapEm, splitXs) {
    const mg = maxGapEm == null ? 2.2 : maxGapEm, sx = splitXs || [];
    const ls = lines.filter((l) => Math.abs(l.b || 0) < 0.02 * l.size && Math.abs(l.c || 0) < 0.02 * l.size && (String(l.text).trim() || l.bullet))
      .slice().sort((p, q) => q.y - p.y || p.x - q.x);
    const rows = [];
    for (const l of ls) {
      const r = rows.find((r) => Math.abs(r.y - l.y) <= 0.3 * Math.max(r.size, l.size) && l.x >= r.x1 - 0.5 && l.x - r.x1 < mg * Math.max(r.size, l.size) && !sx.some((x) => x > r.x1 - 0.5 && x < l.x + 0.5));
      if (r) { r.lines.push(l); r.x1 = Math.max(r.x1, l.x + l.width); r.size = Math.max(r.size, l.size); r.bold = r.bold && !!l.bold; }
      else rows.push({ lines: [l], x0: l.x, x1: l.x + l.width, y: l.y, size: l.size, bold: !!l.bold });
    }
    for (const r of rows) {
      r.lines.sort((p, q) => p.x - q.x);
      const first = r.lines[0];
      r.text = r.lines.map((l) => l.text).join(' ').trim();
      r.bulletRun = first.bullet || (first.width < 1.2 * first.size && Array.from(String(first.text).trim()).length <= 1 && r.lines.length > 1) ? first : null;
      r.inlineBullet = !r.bulletRun && BULLET_RE.test(String(first.text).trim()) ? String(first.text).trim().match(BULLET_RE)[0] : null;
      r.textX = r.bulletRun && r.lines[1] ? r.lines[1].x : r.x0;
      r.top = Math.max(...r.lines.map((l) => l.y + (l.asc || 0.8) * l.size));
      r.bottom = Math.min(...r.lines.map((l) => l.y + (l.desc || -0.2) * l.size));
      r.caps = /[A-Z]{3}/.test(r.text) && r.text === r.text.toUpperCase() && !/[a-z]/.test(r.text);
    }
    return rows;
  }
  /** Column gutters: x ranges of at least `minGap` no row crosses, among rows in [yLo, yHi]. Spanners (very wide rows) excluded. */
  function findGutters(rows, x0, x1, yLo, yHi, minGap) {
    const W = x1 - x0; const segs = [];
    rows.forEach((r) => { if (r.y <= yHi && r.y >= yLo && (r.x1 - r.x0) < 0.7 * W) segs.push([r.x0, r.x1]); });
    segs.sort((a, b) => a[0] - b[0]);
    const gaps = []; let end = null, start = null;
    for (const s of segs) {
      if (end == null) { start = s[0]; end = s[1]; continue; }
      if (s[0] - end >= minGap) gaps.push([end, s[0]]);
      end = Math.max(end, s[1]);
    }
    return { gaps, start, end };
  }

  /**
   * Column gutters by x-coverage: vertical strips (>= minGap wide) that almost no row in [yLo, yHi] crosses, with
   * text on both sides. A few crossing rows (a centred header, a wide footer) are allowed and reported as `cross`.
   */
  function columnGutters(rows, yLo, yHi, minGap) {
    const rs = rows.filter((r) => r.y <= yHi && r.y >= yLo);
    if (rs.length < 4) return [];
    const X0 = Math.floor(Math.min(...rs.map((r) => r.x0))), X1 = Math.ceil(Math.max(...rs.map((r) => r.x1)));
    const n = Math.max(1, Math.ceil((X1 - X0) * 2));
    const cov = new Int32Array(n + 1);
    for (const r of rs) { const a = Math.max(0, Math.floor((r.x0 - X0) * 2)), b = Math.min(n, Math.ceil((r.x1 - X0) * 2)); for (let k = a; k < b; k++) cov[k]++; }
    const allow = Math.max(0, Math.floor(rs.length * 0.08));
    const out = [];
    let k = 0;
    while (k < n) {
      if (cov[k] > allow) { k++; continue; }
      let e = k; while (e < n && cov[e] <= allow) e++;
      // trim to the emptiest part of the strip
      let lo = Infinity; for (let j = k; j < e; j++) lo = Math.min(lo, cov[j]);
      let a = k, b = e; while (a < b && cov[a] > lo) a++; while (b > a && cov[b - 1] > lo) b--;
      const ga = X0 + a / 2, gb = X0 + b / 2;
      if (gb - ga >= minGap) {
        const left = rs.filter((r) => r.x1 <= ga + 0.5).length, right = rs.filter((r) => r.x0 >= gb - 0.5).length;
        const cross = rs.filter((r) => r.x0 < ga - 0.5 && r.x1 > gb + 0.5);
        if (left >= 2 && right >= 2) out.push({ a: ga, b: gb, mid: (ga + gb) / 2, left, right, cross: cross.length, crossTop: cross.length ? Math.max(...cross.map((r) => r.top)) : null });
      }
      k = e;
    }
    return out;
  }

  root.FolioReflow = { scanGeometry, inRegion, shiftFor, itemShift, pathPoke, shiftReps, dropReps, clonePath, userDelta, buildRows, findGutters, columnGutters, BULLET_RE, fmt };
})(typeof window !== 'undefined' ? window : globalThis);
