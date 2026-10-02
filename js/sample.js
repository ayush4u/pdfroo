/* Folio — builds a realistic multi-page sample PDF in the browser with pdf-lib.
   Also usable from Node (set global.PDFLib = require('pdf-lib')). */
(function (root) {
  'use strict';

  async function createSamplePdf(opts) {
    opts = opts || {};
    const { PDFDocument, StandardFonts, rgb, degrees } = root.PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle('Pdfroo sample — Project Proposal');
    doc.setAuthor('Pdfroo');
    const reg = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.07, 0.08, 0.17), gray = rgb(0.38, 0.41, 0.5), light = rgb(0.9, 0.91, 0.95);
    const brand = rgb(0.357, 0.314, 0.941);

    const W = 595.28, H = 841.89; // A4

    function para(page, text, x, y, size, maxW, font, color, lh) {
      font = font || reg; color = color || ink; lh = lh || size * 1.45;
      const words = text.split(' ');
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(test, size) > maxW && line) {
          page.drawText(line, { x, y, size, font, color }); y -= lh; line = w;
        } else line = test;
      }
      if (line) { page.drawText(line, { x, y, size, font, color }); y -= lh; }
      return y;
    }
    function header(page, n, total) {
      page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: brand });
      page.drawText('NORTHWIND STUDIO', { x: 56, y: H - 44, size: 9, font: bold, color: brand });
      page.drawText('Project Proposal · Confidential', { x: W - 56 - reg.widthOfTextAtSize('Project Proposal · Confidential', 9), y: H - 44, size: 9, font: reg, color: gray });
      page.drawLine({ start: { x: 56, y: H - 56 }, end: { x: W - 56, y: H - 56 }, thickness: 0.8, color: light });
      const f = 'Page ' + n + ' of ' + total;
      page.drawText(f, { x: W / 2 - reg.widthOfTextAtSize(f, 9) / 2, y: 36, size: 9, font: reg, color: gray });
    }
    const total = 3;
    const lorem = 'Our team will redesign the customer portal with a focus on speed, accessibility and a consistent visual language. The engagement includes research, interaction design, a component library and hands-on support during implementation so that the new experience ships on time and on budget.';

    // ---- Page 1
    let p = doc.addPage([W, H]);
    header(p, 1, total);
    p.drawText('Website Redesign', { x: 56, y: H - 120, size: 32, font: bold, color: ink });
    p.drawText('Proposal prepared for Acme Corporation', { x: 56, y: H - 146, size: 13, font: reg, color: gray });
    let y = H - 196;
    p.drawText('1. Executive summary', { x: 56, y, size: 16, font: bold, color: ink }); y -= 24;
    y = para(p, lorem, 56, y, 11, W - 112);
    y = para(p, 'We estimate a total timeline of twelve weeks, split into three phases. Each phase ends with a review so priorities can be adjusted as we learn more about your users.', 56, y - 6, 11, W - 112);
    y -= 18;
    p.drawText('2. Budget overview', { x: 56, y, size: 16, font: bold, color: ink }); y -= 20;
    const rows = [['Phase', 'Duration', 'Cost'], ['Discovery & research', '3 weeks', '$12,000'], ['Design & prototyping', '5 weeks', '$24,500'], ['Build support & QA', '4 weeks', '$16,800'], ['Total', '12 weeks', '$53,300']];
    rows.forEach((r, i) => {
      const ry = y - i * 28;
      if (i === 0) p.drawRectangle({ x: 56, y: ry - 9, width: W - 112, height: 28, color: rgb(0.93, 0.93, 1) });
      else p.drawLine({ start: { x: 56, y: ry - 9 }, end: { x: W - 56, y: ry - 9 }, thickness: 0.6, color: light });
      const f = (i === 0 || i === rows.length - 1) ? bold : reg;
      p.drawText(r[0], { x: 68, y: ry, size: 11, font: f, color: ink });
      p.drawText(r[1], { x: 300, y: ry, size: 11, font: f, color: ink });
      p.drawText(r[2], { x: W - 68 - f.widthOfTextAtSize(r[2], 11), y: ry, size: 11, font: f, color: ink });
    });
    y -= rows.length * 28 + 24;
    p.drawText('3. Expected impact', { x: 56, y, size: 16, font: bold, color: ink }); y -= 16;
    const bars = [38, 55, 71, 86];
    const labels = ['Q1', 'Q2', 'Q3', 'Q4'];
    p.drawRectangle({ x: 56, y: y - 150, width: W - 112, height: 150, color: rgb(0.975, 0.976, 0.99), borderColor: light, borderWidth: 1 });
    bars.forEach((b, i) => {
      const bx = 96 + i * 110;
      p.drawRectangle({ x: bx, y: y - 130, width: 44, height: b * 1.3, color: i === 3 ? brand : rgb(0.66, 0.64, 0.98) });
      p.drawText(labels[i], { x: bx + 14, y: y - 145, size: 9, font: reg, color: gray });
      p.drawText(b + '%', { x: bx + 10, y: y - 124 + b * 1.3, size: 9, font: bold, color: ink });
    });
    p.drawText('Customer satisfaction score (projected)', { x: 330, y: y - 22, size: 9, font: reg, color: gray });

    // ---- Page 2
    p = doc.addPage([W, H]);
    header(p, 2, total);
    y = H - 110;
    p.drawText('4. Scope of work', { x: 56, y, size: 16, font: bold, color: ink }); y -= 26;
    const items = ['User interviews with 12 customers and 4 internal stakeholders', 'Information architecture and navigation model', 'High-fidelity designs for 18 key screens', 'Accessible, themeable component library', 'Interactive prototype for usability testing', 'Launch checklist and handoff documentation'];
    items.forEach((t) => {
      p.drawCircle({ x: 62, y: y + 4, size: 2.5, color: brand });
      p.drawText(t, { x: 74, y, size: 11, font: reg, color: ink }); y -= 22;
    });
    y -= 14;
    p.drawText('5. Timeline', { x: 56, y, size: 16, font: bold, color: ink }); y -= 22;
    const phases = [['Discovery', 0, 3], ['Design', 3, 5], ['Build support', 8, 4]];
    for (let wk = 0; wk <= 12; wk += 2) p.drawText('W' + wk, { x: 170 + wk * 28 - 6, y, size: 8, font: reg, color: gray });
    y -= 18;
    phases.forEach(([n, s, d]) => {
      p.drawText(n, { x: 56, y: y + 3, size: 10, font: reg, color: ink });
      p.drawRectangle({ x: 170, y: y - 2, width: 12 * 28, height: 14, color: rgb(0.95, 0.95, 0.98) });
      p.drawRectangle({ x: 170 + s * 28, y: y - 2, width: d * 28, height: 14, color: brand });
      y -= 26;
    });
    y -= 16;
    p.drawText('6. Terms', { x: 56, y, size: 16, font: bold, color: ink }); y -= 22;
    y = para(p, 'Invoices are issued at the start of each phase and are payable within 30 days. Either party may pause the engagement with two weeks written notice. All deliverables become the property of the client upon final payment.', 56, y, 11, W - 112);
    y = para(p, 'This proposal is valid for 60 days from the date of issue. Please sign below to confirm acceptance.', 56, y - 6, 11, W - 112);
    y -= 60;
    [['Client signature', 56], ['Date', 360]].forEach(([l, x]) => {
      p.drawLine({ start: { x, y }, end: { x: x + (l === 'Date' ? 180 : 250), y }, thickness: 0.8, color: gray });
      p.drawText(l, { x, y: y - 14, size: 9, font: reg, color: gray });
    });

    // ---- Page 3 (landscape)
    p = doc.addPage([H, W]);
    const LW = H, LH = W;
    p.drawRectangle({ x: 0, y: LH - 6, width: LW, height: 6, color: brand });
    p.drawText('Appendix A — Moodboard', { x: 56, y: LH - 70, size: 24, font: bold, color: ink });
    p.drawText('Landscape page to show mixed page sizes and orientations.', { x: 56, y: LH - 94, size: 11, font: reg, color: gray });
    const cols = [rgb(0.357, 0.314, 0.941), rgb(1, 0.478, 0.349), rgb(0.086, 0.639, 0.29), rgb(0.96, 0.62, 0.04), rgb(0.07, 0.08, 0.17)];
    cols.forEach((c, i) => {
      p.drawRectangle({ x: 56 + i * 146, y: LH - 300, width: 130, height: 170, color: c });
      p.drawText(['Indigo', 'Coral', 'Leaf', 'Amber', 'Ink'][i], { x: 56 + i * 146, y: LH - 318, size: 11, font: bold, color: ink });
    });
    y = para(p, 'Typography: Inter for UI, Source Serif for long-form reading. Rounded corners, soft shadows and generous spacing create a calm, trustworthy feel.', 56, LH - 360, 12, LW - 112);
    p.drawText('Page 3 of 3', { x: LW / 2 - 24, y: 30, size: 9, font: reg, color: gray });

    if (opts.rotateLast) p.setRotation(degrees(90));
    return await doc.save();
  }

  root.FolioSample = { createSamplePdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createSamplePdf };
})(typeof window !== 'undefined' ? window : globalThis);
