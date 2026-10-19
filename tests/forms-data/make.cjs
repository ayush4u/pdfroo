// Builds the test forms with pdf-lib. Run: node tests/forms-data/make.cjs
const fs = require('fs'), path = require('path');
const { PDFDocument, StandardFonts } = require('../../vendor/pdf-lib.min.js');
(async () => {
  const out = (n, b) => fs.writeFileSync(path.join(__dirname, n), b);
  { // every field type
    const d = await PDFDocument.create(), f = d.getForm(), font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    const lab = (t, y) => p.drawText(t, { x: 40, y: y + 6, size: 11, font });
    lab('Full name', 760); f.createTextField('full_name').addToPage(p, { x: 160, y: 755, width: 300, height: 22 });
    lab('PIN (6)', 720); const pin = f.createTextField('pin'); pin.setMaxLength(6); pin.addToPage(p, { x: 160, y: 715, width: 120, height: 22 });
    lab('Address', 660); const ad = f.createTextField('address'); ad.enableMultiline(); ad.addToPage(p, { x: 160, y: 620, width: 300, height: 60 });
    lab('I agree', 580); f.createCheckBox('agree').addToPage(p, { x: 160, y: 575, width: 18, height: 18 });
    lab('Gender', 540); const g = f.createRadioGroup('gender');
    ['Male', 'Female', 'Other'].forEach((o, i) => { g.addOptionToPage(o, p, { x: 160 + i * 90, y: 535, width: 18, height: 18 }); p.drawText(o, { x: 182 + i * 90, y: 540, size: 10, font }); });
    lab('State', 500); const s = f.createDropdown('state'); s.addOptions(['Delhi', 'Karnataka', 'Maharashtra', 'Uttar Pradesh']); s.addToPage(p, { x: 160, y: 495, width: 200, height: 22 });
    lab('Skills', 440); const k = f.createOptionList('skills'); k.addOptions(['Excel', 'Power Apps', 'Python', 'SQL']); k.enableMultiselect(); k.addToPage(p, { x: 160, y: 390, width: 200, height: 70 });
    lab('Ref no', 350); const ro = f.createTextField('ref_no'); ro.setText('REF-001'); ro.enableReadOnly(); ro.addToPage(p, { x: 160, y: 345, width: 150, height: 22 });
    const p2 = d.addPage([595, 842]); p2.drawText('Page 2: Signature date', { x: 40, y: 766, size: 11, font });
    f.createTextField('sign_date').addToPage(p2, { x: 200, y: 760, width: 150, height: 22 });
    out('all-types.pdf', await d.save());
  }
  { // radio-heavy: 25 yes/no questions
    const d = await PDFDocument.create(), f = d.getForm(), font = await d.embedFont(StandardFonts.Helvetica), p = d.addPage([595, 842]);
    for (let i = 1; i <= 25; i++) { const y = 800 - i * 30; p.drawText('Q' + i, { x: 40, y: y + 4, size: 10, font });
      const r = f.createRadioGroup('q' + i); r.addOptionToPage('Yes', p, { x: 120, y, width: 16, height: 16 }); r.addOptionToPage('No', p, { x: 200, y, width: 16, height: 16 }); }
    out('radio-heavy.pdf', await d.save());
  }
  { // no fields
    const d = await PDFDocument.create(), font = await d.embedFont(StandardFonts.Helvetica); d.addPage([595, 842]).drawText('Just a letter, nothing to fill.', { x: 50, y: 780, size: 14, font });
    out('no-fields.pdf', await d.save());
  }
  { // a form that carries a (structurally real, cryptographically fake) signature: tests the warning only
    const d = await PDFDocument.load(fs.readFileSync(path.join(__dirname, 'all-types.pdf'))), ctx = d.context, { PDFName, PDFString, PDFHexString } = require('../../vendor/pdf-lib.min.js');
    const v = ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of('00'.repeat(64)), Name: PDFString.of('Test Signer') });
    const page = d.getPage(1), w = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), V: ctx.register(v), Rect: [40, 600, 240, 640], F: 4, P: page.ref });
    const wr = ctx.register(w); page.node.addAnnot(wr); d.getForm().acroForm.addField(wr);
    out('signed-form.pdf', await d.save());
  }
  console.log('made test forms');
})();
