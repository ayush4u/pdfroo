/* Pdfroo Resume Rebuild: "ATS check" tuned to Workday-style parsing. On-device, no network. Own MIT code.
 * read(pdfjsLib, bytes) -> page model (text items, image counts, fonts) via pdf.js;
 * analyze(doc, opts) -> parser text (full-width line order, the way a simple parser reads), risks, keyword match, 0-100 score.
 * Works in the browser (window.ResumeATS) and in Node (module.exports) so tests run the same logic. */
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.ResumeATS = api; })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEFAULT_KEYWORDS = ['Python', 'REST APIs', 'LLMs', 'GenAI', 'agents', 'orchestration', 'evals', 'RAG', 'observability', 'MCP', 'LangGraph', 'SQL', 'UiPath'];
  const ALIAS = {
    'rest apis': /\brest(ful)?\s*(apis?|services?|endpoints?)\b|\brest\b/i, 'llms': /\bllms?\b|large language models?/i, 'genai': /\bgen[\s-]?ai\b|generative\s+ai/i,
    'agents': /\b(ai\s+)?agent(s|ic)?\b/i, 'orchestration': /\borchestrat(ion|or|ing|e)\b/i, 'evals': /\bevals?\b|\bevaluations?\b/i, 'rag': /\brag\b|retrieval[\s-]augmented/i,
    'mcp': /\bmcp\b|model context protocol/i, 'sql': /\b(my|postgre|ms|no|t-|pl\/)?sql\b/i, 'uipath': /\bui\s?path\b/i,
  };
  const MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
  const STD = { summary: /^(professional\s+)?summary$/, experience: /^(work\s+|professional\s+)?experience$/, education: /^education$/, skills: /^(technical\s+)?skills$/, certifications: /^certifications?$/ };
  const OK_EXTRA = /^(projects|languages|awards|interests|publications|achievements|volunteering|references)$/;
  const HEADWORD = /summary|profile|objective|about|career|experience|employment|history|education|academic|qualification|skill|competenc|expertise|technolog|tools|strength|certific|licen|training|course|achievement|project|award|honou?r|accomplish|personal|declaration|hobbies|interest|internship|links|social|contact|extra/;
  const GUESS = [['summary', /summary|profile|objective|about/], ['experience', /experience|employment|work history|career/], ['education', /education|academic|qualification/], ['skills', /skill|competenc|expertise|technolog|tools/], ['certifications', /certific|licen|training|course/]];
  const JUNK = /[\uE000-\uF8FF\uFFFD\u2190-\u21FF\u25A0-\u25CE\u25D0-\u25FF\u2700-\u27BF\u2B00-\u2BFF\u{1F300}-\u{1FAFF}\u0000-\u0008]|\(cid:\d+\)/u;
  const ICONFONT = /awesome|icon|symbol|dingbat|wingding|material|glyph|zapf|marvosym|academicons/i;
  const PLACES = /\b(india|usa|united states|uk|united kingdom|canada|germany|singapore|uae|dubai|australia|remote|mumbai|navi mumbai|thane|pune|delhi|new delhi|noida|gurgaon|gurugram|bangalore|bengaluru|hyderabad|chennai|kolkata|ahmedabad|jaipur|indore|lucknow|chandigarh|kochi|london|new york|san francisco|seattle|toronto|berlin|maharashtra|karnataka)\b|,\s*[A-Z]{2}\b(?!\w)/i;

  async function read(lib, bytes) {
    const pdf = await lib.getDocument({ data: bytes.slice ? bytes.slice(0) : bytes, isEvalSupported: false, disableFontFace: true }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i), [x0, y0, x1, y1] = pg.view, W = x1 - x0, H = y1 - y0;
      const tc = await pg.getTextContent();
      let images = 0, smallImages = 0, bigImages = 0; const fonts = {};
      try {
        const ol = await pg.getOperatorList(), O = lib.OPS;
        ol.fnArray.forEach((fn, k) => {
          if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject || fn === O.paintJpegXObject) {
            images++; const a = ol.argsArray[k] || []; const w = +a[1] || (a[0] && a[0].width) || 0, hh = +a[2] || (a[0] && a[0].height) || 0;
            if (w && hh && w * hh <= 64 * 64) smallImages++; else if (w * hh >= 300 * 300) bigImages++;
          }
        });
        for (const f of Object.keys(tc.styles || {})) { try { const o = pg.commonObjs.get(f); fonts[f] = (o && o.name) || ''; } catch (e) { fonts[f] = ''; } }
      } catch (e) { /* operator list is optional */ }
      const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ s: it.str, x: it.transform[4] - x0, top: H - (it.transform[5] - y0), w: it.width, h: Math.abs(it.transform[3]) || it.height || 10, font: fonts[it.fontName] || (tc.styles[it.fontName] || {}).fontFamily || '' }));
      pages.push({ W, H, items, images, smallImages, bigImages });
    }
    await pdf.destroy();
    return { pages };
  }

  function lines(page) {
    const its = page.items.slice().sort((a, b) => a.top - b.top || a.x - b.x), out = [];
    for (const it of its) {
      let L = out.length ? out[out.length - 1] : null;
      if (!L || Math.abs(L.top - it.top) > Math.max(2, Math.min(L.h, it.h) * 0.45)) { L = { top: it.top, h: it.h, items: [] }; out.push(L); }
      L.items.push(it);
    }
    for (const L of out) {
      L.items.sort((a, b) => a.x - b.x); L.segs = []; let cur = null;
      for (const it of L.items) {
        const gap = cur ? it.x - cur.x1 : 1e9;
        if (!cur || gap > Math.max(6, it.h * 0.8)) { cur = { x: it.x, x1: it.x + it.w, s: it.s.trim() }; L.segs.push(cur); }
        else { cur.s += (gap > it.h * 0.15 && !/\s$/.test(cur.s) ? ' ' : '') + it.s.trim(); cur.x1 = Math.max(cur.x1, it.x + it.w); }
      }
      L.text = L.segs.map((s) => s.s).join('   ').replace(/\s{4,}/g, '   ');
      L.fonts = L.items.map((i) => i.font).join(' ');
    }
    return out;
  }

  function kwRegex(k) { const a = ALIAS[k.toLowerCase()]; if (a) return a; const e = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'); return new RegExp('(^|[^a-z0-9])' + e + '($|[^a-z0-9])', 'i'); }
  const STOP = new Set('the and for with you our your are will that this from have has who what all can work team teams able strong role into across using use build building other more years year about such they their them must should would we us an a of to in on at by or as is be it its not plus also well new including within experience skills ability knowledge understanding responsibilities requirements preferred required looking join company help ensure etc'.split(' '));
  function jdKeywords(jd) {
    jd = String(jd || ''); if (!jd.trim()) return [];
    const out = new Map(); const add = (k) => { const n = k.toLowerCase(); if (!out.has(n)) out.set(n, k); };
    for (const k of DEFAULT_KEYWORDS) if (kwRegex(k).test(jd)) add(k);
    (jd.match(/\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[A-Za-z]+\.(js|ts|py|net)\b|\b[A-Z]{2,6}s?\b|\b[A-Za-z]+\+\+|C#/g) || []).forEach((t) => { if (!/^(I|A|THE|AND|OR|WE|US|YOU)$/.test(t)) add(t.replace(/s$/, (m) => /[A-Z]{2,}s$/.test(t) ? '' : m)); });
    const freq = {}; (jd.toLowerCase().match(/[a-z][a-z+#.-]{3,}/g) || []).forEach((w) => { w = w.replace(/[.-]+$/, ''); if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1; });
    Object.entries(freq).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([w]) => add(w));
    return [...out.values()].slice(0, 30);
  }

  function analyze(doc, opts) {
    opts = opts || {}; const risks = []; const P = doc.pages || [];
    const add = (id, level, label, detail, ex) => risks.push({ id, level, label, detail, examples: (ex || []).slice(0, 4) });
    const all = []; let text = '';
    P.forEach((pg, pi) => { const ls = lines(pg); ls.forEach((l) => { l.page = pi; l.pg = pg; all.push(l); text += l.text + '\n'; }); text += '\n'; });
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    const chars = text.replace(/\s/g, '').length;
    // 1. no text layer / text inside images
    const emptyPages = P.filter((p) => p.items.reduce((n, i) => n + i.s.trim().length, 0) < 40).length;
    if (!P.length || chars < 80) add('notext', 'high', 'No readable text layer', 'The parser gets (almost) nothing: this PDF is a scan or text was turned into pictures/outlines. Export it from Word/Docs or rebuild it here.');
    else if (emptyPages) add('notext', 'high', emptyPages + ' page(s) with no text layer', 'Those pages are images only; the parser skips them.');
    const big = P.reduce((n, p) => n + p.bigImages, 0);
    if (big && chars >= 80) add('images', 'med', big + ' large image(s) on the page', 'Any words inside an image (logos, skill bars, charts, a pasted screenshot) are invisible to the parser. Photos are also discouraged.');
    // 2. multi-column
    const cols = [];
    P.forEach((pg, pi) => {
      const ls = all.filter((l) => l.page === pi), buckets = {};
      for (const l of ls) for (let k = 1; k < l.segs.length; k++) { const s = l.segs[k]; if (s.x > pg.W * 0.28 && s.x < pg.W * 0.8) { const b = Math.round(s.x / 6); buckets[b] = (buckets[b] || 0) + 1; } }
      let best = 0, bx = 0; for (const b in buckets) { const n = (buckets[b] || 0) + (buckets[+b - 1] || 0) + (buckets[+b + 1] || 0); if (n > best) { best = n; bx = b * 6; } }
      if (best >= Math.max(5, ls.length * 0.15)) cols.push({ page: pi + 1, x: Math.round(bx), lines: best });
    });
    if (cols.length) add('columns', 'high', 'Multi-column layout', 'Workday-style parsers read straight across the page, so the left and right columns get mixed line by line (see the text on the left). Use one column.', cols.map((c) => 'page ' + c.page + ': second column starts at x≈' + c.x + 'pt on ' + c.lines + ' lines'));
    // 3. tables / grids (3+ cells on consecutive lines sharing x positions)
    let run = 0, tbl = [], tblLines = [];
    for (let i = 0; i < all.length; i++) {
      const l = all[i], p = all[i - 1];
      const shared = p && p.page === l.page && l.segs.length >= 2 && p.segs.length >= 2 ? l.segs.filter((s) => p.segs.some((q) => Math.abs(q.x - s.x) < 5)) : [];
      if (shared.length >= 2 && shared.some((s) => s !== l.segs[0])) { run = run ? run + 1 : 2; if (run === 3) tbl.push(p.text); if (run >= 2) tblLines.push(l.text); } else run = 0;
    }
    if (tbl.length) add('tables', 'med', 'Table or grid layout', 'Cells in a grid are read row by row and often merged into one field. Put skills on plain comma-separated lines.', tblLines);
    // 4. icons
    const iconLines = all.filter((l) => /[\uE000-\uF8FF]/.test(l.text) || ICONFONT.test(l.fonts));
    const smallImg = P.reduce((n, p) => n + p.smallImages, 0);
    if (iconLines.length || smallImg >= 2) add('icons', 'med', 'Icons in place of words', 'Phone/email/location icons come out as junk or nothing, and a parser cannot tell what the number next to them is. Write “Phone:”, “Email:” or just the plain values.', iconLines.map((l) => l.text).concat(smallImg ? [smallImg + ' small icon-size image(s)'] : []));
    // 5. contact info
    const email = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(text), phone = /(\+?\d[\d\s().-]{8,}\d)/.exec(text.replace(/\d{1,2}\/\d{4}/g, ''));
    const loc = all.slice(0, 25).some((l) => PLACES.test(l.text));
    const miss = [!email && 'email', !(phone && phone[1].replace(/\D/g, '').length >= 10) && 'phone', !loc && 'location'].filter(Boolean);
    if (miss.length) add('contact', miss.includes('email') || miss.includes('phone') ? 'high' : 'low', 'Missing ' + miss.join(', '), 'Workday fills the application form from these; put them as plain text near your name (City, State/Country is enough for location).');
    const edge = all.filter((l) => (l.top < l.pg.H * 0.05 || l.top > l.pg.H * 0.95) && (/@/.test(l.text) || /\d{5,}|\d{3}[\s-]\d{3}/.test(l.text)));
    if (edge.length) add('header', 'med', 'Contact details in the header/footer area', 'Text in the top or bottom margin is often treated as a page header/footer and dropped. Move it a little into the page body.', edge.map((l) => l.text));
    // 6. headings
    const heads = []; for (const l of all) for (const sg of l.segs) { const t = sg.s.trim(); if (t.length <= 40 && !/[\d@:|•]/.test(t) && t.split(/\s+/).length <= 5 && (t === t.toUpperCase() && /[A-Z]{3}/.test(t) || l.segs.length === 1) && HEADWORD.test(t.toLowerCase())) heads.push({ text: t, caps: t === t.toUpperCase() }); }
    const seen = {}, odd = [];
    for (const l of heads) {
      const t = l.text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[&/].*$/, '').trim();
      const k = Object.keys(STD).find((s) => STD[s].test(t)); if (k) { seen[k] = 1; continue; }
      if (OK_EXTRA.test(t)) continue;
      if (!l.caps) continue;
      const g = GUESS.find(([, re]) => re.test(t)); if (g) seen[g[0]] = seen[g[0]] || 2;
      odd.push(l.text.trim() + (g ? ' → use “' + g[0][0].toUpperCase() + g[0].slice(1) + '”' : ''));
    }
    const absent = Object.keys(STD).filter((k) => !seen[k]);
    if (odd.length) add('headings', 'med', 'Non-standard section headings', 'Parsers look for Summary, Experience, Education, Skills, Certifications. Other names may put your content in the wrong field.', odd);
    if (absent.length) add('sections', absent.some((k) => k === 'experience' || k === 'education') ? 'med' : 'low', 'No “' + absent.map((k) => k[0].toUpperCase() + k.slice(1)).join('”, “') + '” heading', 'Add the section with that exact name if you have the content.');
    // 7. dates
    const badDate = new RegExp("\\b(" + MON + ")[a-z]*\\.?\\s*['’]\\s?\\d{2}\\b|\\b\\d{1,2}([/.-])\\d{1,2}\\2\\d{2,4}\\b|\\b(?<![/\\w])(19|20)\\d{2}\\s*[-–—]\\s*((19|20)\\d{2}|present|current|now)\\b|\\b\\d{4}-\\d{2}\\b|\\b\\d{1,2}(st|nd|rd|th)\\s+(" + MON + ")", 'i');
    const yearOnly = new RegExp('(' + MON + ')[a-z]*\\.?\\s+\\d{4}\\s*[-–—]|\\d{1,2}/\\d{4}\\s*[-–—]', 'i');
    const dl = all.filter((l) => badDate.test(l.text) && !(yearOnly.test(l.text) && !/['’]\s?\d{2}\b|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(l.text)));
    if (dl.length) add('dates', 'med', 'Dates not in “Mon YYYY” or “MM/YYYY”', 'Year-only ranges, “Jan’21” or full dd/mm/yyyy dates often fail to fill start/end dates. Write “Jan 2021 – Present” or “01/2021 – Present”.', dl.map((l) => l.text));
    // 8. length
    if (P.length > 2) add('pages', 'low', P.length + ' pages', 'Keep it to 1–2 pages; long files are more likely to be truncated or mis-split.');
    // 9. junk glyphs
    const jl = all.filter((l) => JUNK.test(l.text));
    if (jl.length) add('glyphs', 'med', 'Fancy bullets or symbols that extract as junk', 'Use a plain • or - for bullets; arrows, checkmarks, stars and icon-font symbols become garbage characters.', jl.map((l) => l.text.replace(/[^\x20-\x7E•–—’]/g, (c) => '⟨U+' + c.codePointAt(0).toString(16).toUpperCase() + '⟩')));
    // keywords
    const custom = jdKeywords(opts.jd), list = custom.length ? custom : (opts.keywords || DEFAULT_KEYWORDS);
    const found = [], missing = []; for (const k of list) (kwRegex(k).test(text) ? found : missing).push(k);
    const kwScore = list.length ? Math.round(100 * found.length / list.length) : 100;
    const W = { high: 18, med: 8, low: 3 }, parse = Math.max(0, 100 - risks.reduce((n, r) => n + W[r.level], 0));
    const score = Math.round(0.6 * kwScore + 0.4 * parse);
    const explain = 'Score ' + score + '/100 = 60% keyword match (' + found.length + ' of ' + list.length + ' ' + (custom.length ? 'job-description' : 'default') + ' keywords found → ' + kwScore + ') + 40% parse safety (100 minus ' + (100 - parse) + ' for ' + risks.length + ' risk(s): high −18, medium −8, low −3 → ' + parse + ').';
    return { text, pages: P.length, risks, keywords: { source: custom.length ? 'job description' : 'default list', list, found, missing, score: kwScore }, parse, score, explain, lines: all.map((l) => l.text) };
  }
  return { DEFAULT_KEYWORDS, read, analyze, jdKeywords, lines };
});
