// Form filler tests. Run from repo root: node tests/forms.mjs   (serves the folder on :8791 itself)
import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve('.'), D = 'tests/forms-data/';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.wasm': 'application/wasm' };
const srv = http.createServer((q, s) => { const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f.endsWith('/') ? f + 'index.html' : f, (e, b) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); s.end(b); }); });
await new Promise((res) => srv.listen(0, '127.0.0.1', res)); const PORT = srv.address().port, BASE = `http://127.0.0.1:${PORT}/`;
const r = []; const ok = (n, c, i = '') => { r.push(`${c ? 'PASS' : 'FAIL'}  ${n}${i !== '' ? '  (' + i + ')' : ''}`); };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const errs = [], reqs = [];
async function page(mobile) {
  const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true } : { viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  p.on('request', (q) => { if (!q.url().startsWith(BASE) && !q.url().startsWith('blob:') && !q.url().startsWith('data:')) reqs.push(q.url()); });
  await p.goto(BASE + 'index.html'); await p.waitForFunction(() => window.PdfrooForms && window.pdfjsLib);
  return p;
}
const openForm = async (p, file) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#landingFormBtn')]); await fc.setFiles(D + file); await p.waitForSelector('.ff-shell'); };
const download = async (p) => { const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.ff-dl')]); const f = await dl.path(); return { name: dl.suggestedFilename(), bytes: [...fs.readFileSync(f)] }; };
const readBack = (p, bytes) => p.evaluate((a) => PdfrooForms.readBack(new Uint8Array(a)), bytes);
const pageText = (p, bytes) => p.evaluate(async (a) => { const d = await pdfjsLib.getDocument({ data: new Uint8Array(a) }).promise; let t = ''; for (let i = 1; i <= d.numPages; i++) t += (await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + '\n'; return t; }, bytes);
const fieldCount = (p, bytes) => p.evaluate(async (a) => (await PDFLib.PDFDocument.load(new Uint8Array(a))).getForm().getFields().length, bytes);

/* ---- desktop: every field type through the real UI ---- */
let p = await page(false);
ok('1 Landing has "Fill in a PDF form" button', await p.isVisible('#landingFormBtn'));
await openForm(p, 'all-types.pdf');
ok('2 Finds every box (8 editable fields, 3 radio buttons, 1 read-only)', (await p.$$('.ff-f')).length === 11, (await p.$$('.ff-f')).length + ' boxes');
ok('3 Counter starts right', (await p.textContent('.ff-count')) === '0 of 8 filled', await p.textContent('.ff-count'));
ok('4 Read-only field is locked and shows its value', await p.$eval('[aria-label="ref no"]', (e) => e.disabled && e.value === 'REF-001'));
await p.fill('[aria-label="full name"]', 'Ayush Tomar');
await p.fill('[aria-label="pin"]', '2010011234');
ok('5 Max length respected (PIN 6)', (await p.inputValue('[aria-label="pin"]')) === '201001');
await p.fill('textarea[aria-label="address"]', 'Flat 4B\nSector 62, Noida');
await p.check('[aria-label="agree"]');
await p.check('[aria-label="gender Female"]');
await p.selectOption('select[aria-label="state"]', 'Uttar Pradesh');
await p.selectOption('select[aria-label="skills"]', ['Excel', 'SQL']);
await p.fill('[aria-label="sign date"]', '09/10/2026');
ok('6 Counter updates', (await p.textContent('.ff-count')) === '8 of 8 filled', await p.textContent('.ff-count'));
// Prev/Next walks the fields in order
await p.click('[aria-label="full name"]'); await p.click('[aria-label="Next field"]');
ok('7 Next goes to the following field', await p.evaluate(() => document.activeElement.getAttribute('aria-label')) === 'pin');
await p.click('[aria-label="Previous field"]'); await p.click('[aria-label="Previous field"]');
ok('8 Prev wraps from first to last field', await p.evaluate(() => document.activeElement.getAttribute('aria-label')) === 'sign date');
let d = await download(p), v = await readBack(p, d.bytes);
const want = { full_name: 'Ayush Tomar', pin: '201001', address: 'Flat 4B\nSector 62, Noida', agree: true, gender: 'Female', state: 'Uttar Pradesh', skills: ['Excel', 'SQL'], ref_no: 'REF-001', sign_date: '09/10/2026' };
const bad = Object.keys(want).filter((k) => JSON.stringify(v[k]) !== JSON.stringify(want[k]));
ok('9 Downloaded PDF keeps every answer, still fillable', !bad.length && (await fieldCount(p, d.bytes)) === 9, bad.map((k) => k + '=' + JSON.stringify(v[k])).join(' ') || d.name);
ok('10 File name', d.name === 'all-types-filled.pdf', d.name);
// reopen the filled file: answers come back into the boxes
await p.evaluate((a) => PdfrooForms.open(new File([new Uint8Array(a)], 'again.pdf')), d.bytes); await p.waitForSelector('.ff-shell');
ok('11 Reopening a filled form shows the saved answers', await p.evaluate(() => { const q = (s) => document.querySelector(s); return q('[aria-label="full name"]').value === 'Ayush Tomar' && q('[aria-label="agree"]').checked && q('[aria-label="gender Female"]').checked && q('select[aria-label="state"]').value === 'Uttar Pradesh' && [...q('select[aria-label="skills"]').selectedOptions].map((o) => o.value).join() === 'Excel,SQL'; }));
ok('12 Counter after reopen', (await p.textContent('.ff-count')) === '8 of 8 filled', await p.textContent('.ff-count'));
// flatten
await p.uncheck('[aria-label="agree"]'); await p.check('#ffFlat');
d = await download(p);
const t = await pageText(p, d.bytes);
ok('13 Lock answers: no fields left, text is on the page', (await fieldCount(p, d.bytes)) === 0 && t.includes('Ayush Tomar') && t.includes('Uttar Pradesh') && t.includes('09/10/2026'), d.name);
await p.click('.ff-x'); ok('15 Close removes the filler and unlocks scrolling', !(await p.$('.ff-shell')) && !(await p.evaluate(() => document.documentElement.classList.contains('ff-lock'))));

/* ---- API round-trips ---- */
const api = await p.evaluate(async () => {
  const src = new Uint8Array(await (await fetch('tests/forms-data/all-types.pdf')).arrayBuffer()), o = {}, loadFont = async () => new Uint8Array(await (await fetch('vendor/fonts/FolioNotoSans-Regular.ttf')).arrayBuffer());
  let x = await PdfrooForms.fillPdf(src, { agree: false, gender: '', state: '', skills: [], full_name: '' });
  const rb = await PdfrooForms.readBack(x.bytes); o.clear = rb.agree === false && rb.gender === '' && rb.state === '' && rb.skills.length === 0 && rb.full_name === '';
  x = await PdfrooForms.fillPdf(src, { full_name: 'Zoë Müller · €120 · ₹5,000 · Иван' }, { loadFont }); o.unicode = (await PdfrooForms.readBack(x.bytes)).full_name; o.usedFont = x.usedFont;
  // unicode + flatten must still work (needs the embedded font)
  x = await PdfrooForms.fillPdf(src, { full_name: '₹5,000 Zoë' }, { flatten: true, loadFont }); o.plainNoFont = !(await PdfrooForms.fillPdf(src, { full_name: 'plain' }, { loadFont })).usedFont;
  o.uniFlatOk = !!x.bytes.length;
  try { await PdfrooForms.fillPdf(src, { full_name: 'आयुष' }, { loadFont }); o.hindi = 'no error'; } catch (e) { o.hindi = e.message; }
  x = await PdfrooForms.fillPdf(src, { nope: 'x', state: 'Goa' }); o.skipped = x.skipped.join();
  return o;
});
ok('16 Clearing answers works (untick, no radio, empty list)', api.clear);
ok('17 ₹ € ü and Cyrillic saved (font loaded only when needed)', api.unicode === 'Zoë Müller · €120 · ₹5,000 · Иван' && api.usedFont && api.plainNoFont, api.unicode);
ok('18 ₹ with Lock answers works', api.uniFlatOk);
ok('19 Hindi gives a clear message, not a crash', /Hindi/.test(api.hindi), api.hindi);
ok('20 Unknown field and option outside the list are skipped, not crashed', api.skipped === 'nope,state', api.skipped);

/* ---- W-9 (real IRS form) ---- */
await openForm(p, 'w9.pdf');
const w9 = await p.evaluate(() => ({ n: document.querySelectorAll('.ff-f').length, cnt: document.querySelector('.ff-count').textContent }));
ok('21 W-9 fields found', w9.n > 20, w9.n + ' boxes, ' + w9.cnt);
const first = await p.$('.ff-text:not(:disabled)'); const nm = await first.getAttribute('aria-label'); await first.fill('Ayush Tomar');
const cb = await p.$('.ff-checkbox:not(:disabled)'); await cb.check();
d = await download(p);
const w9b = await p.evaluate(async (a) => { const f = (await PDFLib.PDFDocument.load(new Uint8Array(a))).getForm(); return { texts: f.getFields().filter((x) => x instanceof PDFLib.PDFTextField).map((x) => x.getText()), checks: f.getFields().filter((x) => x instanceof PDFLib.PDFCheckBox && x.isChecked()).length }; }, d.bytes);
ok('22 W-9 answer saved and box ticked', w9b.texts.includes('Ayush Tomar') && w9b.checks >= 1, nm);
await p.check('#ffFlat'); d = await download(p);
ok('23 W-9 Lock answers', (await pageText(p, d.bytes)).includes('Ayush Tomar') && (await fieldCount(p, d.bytes)) === 0);
await p.click('.ff-x');

/* ---- radio heavy ---- */
await openForm(p, 'radio-heavy.pdf');
for (let i = 1; i <= 25; i++) await p.check(`[aria-label="q ${(i % 2 ? 'Yes' : 'No')}"] >> nth=${i - 1}`).catch(() => {});
const radioCnt = await p.textContent('.ff-count');
d = await download(p); v = await readBack(p, d.bytes);
const rbad = []; for (let i = 1; i <= 25; i++) if (v['q' + i] !== (i % 2 ? 'Yes' : 'No')) rbad.push('q' + i + '=' + v['q' + i]);
ok('24 25 yes/no questions saved', !rbad.length, rbad.slice(0, 4).join(' ') || radioCnt);
await p.click('.ff-x');

/* ---- no fields / not a pdf ---- */
await openForm(p, 'no-fields.pdf');
ok('25 PDF with no fields: clear message', /no fillable fields/.test(await p.textContent('.ff-shell')));
await p.click('.ff-x');
fs.writeFileSync('/tmp/notpdf.pdf', 'hello');
{ const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#landingFormBtn')]); await fc.setFiles('/tmp/notpdf.pdf'); await p.waitForSelector('.ff-shell'); }
ok('26 Not a PDF: clear message', /doesn’t look like a PDF/.test(await p.textContent('.ff-shell')));
await p.click('.ff-x');

/* ---- phone ---- */
const m = await page(true);
await openForm(m, 'all-types.pdf');
await m.screenshot({ path: '/tmp/ff-phone.png' });
const fits = await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.ff-bar > *')].every((e) => e.getBoundingClientRect().right <= innerWidth + 1));
ok('27 Phone: nothing wider than the screen', fits);
const taps = await m.evaluate(() => [...document.querySelectorAll('.ff-bar button, .ff-bar label')].map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h < 44));
ok('28 Phone: bar buttons are 44px+ tall', !taps.length, taps.join());
await m.tap('[aria-label="full name"]');
ok('29 Phone: tapping a text box opens the big editor', await m.isVisible('.ff-sheet input'));
await m.screenshot({ path: '/tmp/ff-phone-sheet.png' });
await m.fill('.ff-sheet input', 'Ayush'); 
ok('30 Phone: typing in the editor fills the box on the page', (await m.inputValue('[aria-label="full name"]')) === 'Ayush');
await m.click('.ff-sheet button:has-text("Next")');
ok('31 Phone: Next moves to the next field in the editor', (await m.getAttribute('.ff-sheet .ff-sheet-in', 'aria-label')) === 'pin');
await m.fill('.ff-sheet input', '110001'); await m.press('.ff-sheet input', 'Enter');
ok('32 Phone: Enter key also moves on', (await m.getAttribute('.ff-sheet .ff-sheet-in', 'aria-label')) === 'address');
await m.click('.ff-sheet button:has-text("Done")');
ok('33 Phone: Done closes the editor', !(await m.$('.ff-sheet')));
d = await download(m); v = await readBack(m, d.bytes);
ok('34 Phone: answers saved', v.full_name === 'Ayush' && v.pin === '110001', JSON.stringify([v.full_name, v.pin]));

ok('35 No page errors', !errs.length, errs.slice(0, 2).join(' | '));
ok('36 Nothing sent off the device', !reqs.length, reqs.slice(0, 2).join(' '));
await b.close(); srv.close();
console.log(r.join('\n')); const f = r.filter((x) => x.startsWith('FAIL')).length; console.log(`\n${r.length - f}/${r.length} passed`); process.exit(f ? 1 : 0);
