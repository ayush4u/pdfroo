# Pdfroo — private PDF editor in your browser

Live test build: https://ayush4u.github.io/pdfroo/

Pdfroo is a fully client-side PDF editor. Open a PDF, annotate it, sign it, rearrange / merge pages and download a real, flattened PDF. **Nothing is uploaded** — all parsing, rendering and writing happens in the browser tab (pdf.js + pdf-lib), and it keeps working offline once loaded.

Works on phones (~375 px), tablets (~768 px) and desktops (1440 px+), with mouse, pen or touch.

## Run it

No build step, no backend, no install.

* **Double-click `index.html`** (works from `file://` — pdf.js falls back to its in-page "fake worker", so it's a bit slower on very large files), **or**
* serve the folder with any static server (recommended):

```bash
npx serve .            # or
python3 -m http.server 8080
```

then open the printed URL. Click **Try a sample PDF** on the landing page if you don't have a PDF handy.

## Features

**Landing page** – the Pdfroo kangaroo landing page (local Fredoka/Nunito/Baloo 2 fonts, SVG mascot): every **Open a PDF** button opens the editor, plus drag-and-drop zone, built-in sample PDF, shortcuts to Find & replace and Compress, Indian-language section and privacy ("pouch promise") section. The editor keeps its light/dark theme.

**Credit and config** – `js/config.js` holds `CREDIT_AUTHOR`, `CREDIT_GITHUB` and `CREDIT_LINKEDIN` (empty hides the LinkedIn icon); they fill the quiet "Made by …" line in the landing footer, the pages-panel footer and the shortcuts dialog. After the first successful download in a session (edit, find & replace, compress), a small kangaroo toast says "Done! Your PDF never left your device. Go enjoy a coffee ☕" — no donation ask; it closes after ~6 s and never appears on errors.

**Pages**
* Thumbnail sidebar (desktop), slide-in drawer (tablet) or bottom sheet (phone)
* Drag to reorder (SortableJS, touch-friendly long-press on mobile)
* Rotate left/right, duplicate, delete, insert blank page
* Merge: append pages from one or more other PDFs (button or drop PDFs onto the editor)
* Zoom in/out/fit, Ctrl+wheel and two-finger pinch zoom, page navigation (buttons, page-number field, keyboard)

**Annotation tools** (all movable; box-type items resizable with corner handles; lines/arrows by their endpoints)
* Select / move
* Text – font size, color, bold, multi-line; double-click (double-tap) to re-edit
* Pen (freehand, color + thickness) and translucent highlighter
* Rectangle, ellipse, line, arrow (Shift = square / 45° snapping)
* White-out rectangle to cover content
* Insert image (PNG / JPG, large images are down-scaled)
* Signature – draw in a modal pad (mouse / pen / finger), trimmed and placed as a transparent PNG
* Duplicate / delete selected, nudging (arrow keys 0.5 pt, Shift 5 pt, or the on-screen arrows on touch screens), unlimited undo/redo (150 steps)

**Nudge / align existing text** (Edit text tool) – a click/tap selects a text run (Shift-click adds runs to a group). Nudge it with the arrow keys (0.5 pt, Shift 5 pt; Alt+arrows while the line editor is open) or the on-screen ↑←↓→ buttons; **Align to line** snaps a run's baseline onto the nearest line in the same row (a bullet goes onto the first line of its paragraph), **Align left edges** lines up a group. Moves rewrite only that run's text position (`Tm`) in the content stream, so the text keeps its font and stays real, searchable text and nothing else on the page changes; text inside a reusable Form XObject is covered and redrawn instead. Bullets (•, ●, ▪, Word's Symbol-font , –, …) that sit off their line are detected and get a small **Fix** chip, plus **Fix all bullets** in the bar. Symbol-font bullets can be moved even though they can't be retyped.

**Edit existing text** (Edit text tool, `X`) – hover (or, on touch screens, look for the dashed outlines) to see editable lines, click/tap one, change it in the inline editor, Enter to apply, Esc to cancel. Undo/redo work as usual. Fonts are matched in three tiers:
1. **Original font.** Pdfroo reuses the page's own font resource when that works reliably. For embedded (usually subset) fonts, a character qualifies if it is already shown with that font on the page, or, as a second chance, if its glyph really exists in the embedded font program (checked with fontkit on pdf.js's parsed font data) and its code is spelled out by the PDF's own encoding, so every viewer agrees on it. Word often splits one typeface into several subset objects (e.g. a CID "ArialMT" plus a WinAnsi "ArialMT"); Pdfroo can switch between these sibling objects inside one line. Page fonts are matched to pdf.js fonts by aligning the content stream's `Tf` operators with pdf.js's operator list, which is exact even when several fonts share a name. For non-embedded standard fonts, any character in the font's encoding works. The new text is written with the font's own codes (1-byte simple fonts, or 2-byte Identity-H CID fonts). A restricted-licence `fsType` blocks this tier.
2. **Metric-compatible substitute** for the whole line (never single letters): Liberation Sans for Arial/Helvetica, Liberation Serif for Times, Liberation Mono for Courier, Carlito for Calibri, Caladea for Cambria, or the same Google font when the PDF uses Roboto, Open Sans or Lato. Weight and italic are matched, and character spacing (`Tc`) and horizontal scaling (`Tz`) are adjusted so the original line keeps its width.
3. **Noto Sans / Noto Serif / Noto Sans Mono**, picked by serif vs sans, weight and italic, for anything else (and for characters like ₹ that the tier-2 font lacks).

The propbar shows a small chip: "Original font: X" (tier 1) or "Substituted font: X" (tiers 2 and 3). If the new text is wider than the gap before the next text on the same baseline (a dotted leader, a table cell), Pdfroo condenses it horizontally by up to 12% to fit, or warns that it overlaps. Synthetic bold (fill + stroke text, common in iText output) is reproduced. Lines are split at wide tab/column gaps, so table cells are edited separately; justified lines stay whole.

How the old line is removed: Pdfroo tokenizes the page content stream and simulates the text state. It then deletes exactly the `Tj`/`TJ`/`'`/`"` operators that painted the line, replacing each with an equal-width positioning-only `TJ`, so neighbouring text doesn't move. Every other byte of the page (clipping paths, images, soft masks, marked content, form XObjects) is left as it was. The page is not regenerated. The new line goes in an appended content stream. It is drawn in the original colour, read from the content stream (or sampled from the render as a fallback).

When the old glyphs can't be removed surgically, the line is covered with a box in the background colour sampled from the page, and the chip/toast says the old text stays in the file underneath. That happens for text inside a form XObject, a text run shared with other lines, or a font that can't be mapped unambiguously. The cover box stops short of underlines and table rules that touch the line, so they stay visible.

Pdfroo refuses, with a clear message:
* scanned / image-only pages (no text layer);
* text converted to outlines;
* rotated, skewed or vertical text;
* Type 3 fonts;
* text without a usable Unicode mapping;
* invisible OCR text layers: text in render mode 3/7 (also inside form XObjects, as OCRmyPDF writes it) or text painted over by an opaque image. A page where most lines are like this gets a page-level "scanned image with an invisible OCR layer" message;
* lines set in legacy pre-Unicode Hindi fonts other than Kruti Dev / DevLys / Chanakya (Shivaji, APS-DV, C-DAC DV-TT). The Kruti Dev family is handled by *Checked Indic lines* below;
* existing lines in Arabic, Hebrew, Thai, Sinhala and other non-Indic shaping scripts;
* (Indic lines whose text layer doesn't match the print are no longer refused; see *Checked Indic lines* below.)
* symbol-font bullets.

**Text styling and alignment** (Edit text tool) – while editing an existing line, a text toolbar offers size (0.5 pt steps), **Bold**, *Italic*, colour (the original colour plus swatches and a custom picker) and alignment (Auto / Left / Centre / Right / Justify). Bold/italic first use a same-family font already in the PDF ("Original font family: …"), otherwise the bundled face; the buttons are disabled with an explanation when neither exists. Alignment is detected automatically: right-aligned dates and amounts keep their right edge, centred lines stay centred, and justified lines keep their width by widening word spaces. The caret lands where you clicked, and dragging objects snaps to page edges/centre, other objects and text baselines (pink guides, Alt disables).

**Find & replace across PDFs** (search button, `Ctrl+F`, or "Find & replace in several PDFs" on the home page) – searches the open PDF and any PDFs you add, with Match case and Whole word. Results are grouped by file and page with a highlighted preview; untick matches to keep them, then Replace selected / Replace all / Delete selected. Each replacement is a normal text edit (original font first), and matches that can't be replaced (scans, invisible OCR layers, unsupported fonts) are listed with the reason, never skipped silently. Download each file or all of them as one .zip. Everything runs on your device.

**Compress PDF** (compress button in the top bar, or "Compress a PDF" on the home page) – makes the file smaller on your device. Pick **Smaller** (images ~110 dpi), **Balanced** (~150 dpi) or **High quality** (~200 dpi), and optionally a target size (chips for 100 KB, 200 KB, 500 KB and 1 MB, or type e.g. "350 KB"). `js/engine/compress.js` first does lossless clean-up with pdf-lib (identical fonts/images/streams merged, unreachable objects removed, uncompressed streams Flate-compressed, object streams), then re-encodes images as JPEG with the browser's own canvas encoder. With a target it steps resolution and quality down (binary search, never above the chosen preset) until the file fits. Page content streams, fonts and vector drawings are never touched, so text stays sharp, selectable and searchable; form fields, links and bookmarks are kept. Transparency (SMask) is kept as a separate, downsampled soft mask; grayscale stays gray; CMYK (incl. Indexed-on-CMYK), 16-bit and Decode-array images are decoded by pdf.js so colours match the viewer (if that isn't possible the image is kept as is rather than guessed). JPEG 2000, JBIG2 and CCITT images (already compact) are left as they are. The result is never bigger than the input. The dialog shows before → after size and a side-by-side preview (synced scrolling, Fit/2×/4×). If a target can't be reached it shows the smallest result and explains why (e.g. "text, fonts and drawings alone take 647 KB"). Signed PDFs show a warning and need an explicit "I understand" because compression invalidates the signature; encrypted PDFs are refused. No Ghostscript (AGPL) or other server-side tool is used.

**Indic scripts (Hindi and 8 more)** – Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada and Malayalam are real, searchable text, both in new text boxes and when editing existing Unicode lines. Nothing extra loads until you type an Indic character or open an Indic line. Then `js/engine/indic.js` lazy-loads **HarfBuzz** (harfbuzzjs 0.10.3, WASM, ~465 KB) and the matching **Noto Sans <Script>** Regular/Bold font (pre-subset with fonttools, GSUB/GPOS kept; 33–190 KB each as base64 JS). Each line is split into runs: Latin, digits, spaces and ₹ use Pdfroo's Noto Sans, and the Indic run uses the script font. Each run is shaped by HarfBuzz with the whole line as context. The glyphs are written with Pdfroo's own low-level writer as a CID-keyed **Type0 / Identity-H** font (CIDFontType2, `CIDToGIDMap`, `W` widths, embedded TrueType). For copy and search:
  * every shaped line is wrapped in a `/Span <</ActualText (original Unicode)>> BDC … EMC`. poppler/pdftotext, Acrobat and MuPDF use this, so conjuncts (क्ष, श्री) and reordered matras (ि) come out in reading order;
  * the **ToUnicode** CMap maps each glyph to its share of the source cluster in logical order. Combining marks travel on zero-width glyphs, and GPOS-offset marks are drawn out of flow, so pdf.js (which ignores ActualText) also returns the exact original string.

  The editor previews with the same font files (registered as `FolioIndic <Script>` FontFaces), so the preview matches the export. Existing Indic lines are always redrawn in Noto Sans <Script>, width-fitted to the original line (85–115 %), since the original fonts' subsets carry no layout tables. Legacy-font and broken-text-layer lines go through the reading check below. Signature and OCR protections are unchanged. Each export embeds the whole pre-subset font of every script used (e.g. ~142 KB for Devanagari Regular).

Every edit is checked with a real round trip before it is accepted: the page is rebuilt and re-read with pdf.js to confirm the new text is present and the old text is gone.

**Checked Indic lines (broken text layers, legacy fonts)** – Word-made Hindi PDFs often copy out wrong: शुद्धिपत्र prints but copies as िुजिपत्र, `Ǒहंदȣ` for हिंदी, or a well-formed wrong word like र्वषय for विषय. Before an Indic line is edited, Pdfroo compares up to three readings:
* the **text layer**, i.e. what pdf.js extracts;
* a **font reading**: glyph IDs mapped back through the embedded subset's own `cmap`, ligatures decomposed by reversing its GSUB when the subset kept one, then put in logical order (ि after its consonant cluster, reph before its syllable). Word's subsets keep a cmap but no GSUB, so conjunct/half/reph glyphs (about 9%) fall back to ToUnicode and are marked unverified;
* **OCR** of just that line, rendered from the original page at 300 dpi and read by tesseract.js 7 (LSTM-only WASM core, `tessdata_fast` models).

Word's mid-word font switches are first joined into one visual line. Indic line boxes are at least 1 em tall (0.95 em up, 0.35 em down, never reaching into the neighbouring lines), for the OCR crop and the cover rectangle.

The decision uses one switch, `INDIC_AUTOACCEPT` in `js/engine/indicVerify.js` (default `'letters'`). It was set from a 1,880-line study of real gov.in PDFs: exact OCR/text-layer agreement was right 136/136 times, and letters-only agreement 46/46 in a sample, doubling coverage. Near matches were wrong 3/7 times.
* **Auto-accept:** OCR and the text layer have the same letters (NFC; ZWJ/ZWNJ, punctuation, digits and spaces ignored), and the font reading doesn't contradict them with glyphs it verified itself. The text-layer string is kept.
* **Everything else**, including near matches, opens a **confirmation box**. It shows the line as printed, a prefilled best reading and the three readings with their differences highlighted. The best reading is OCR, except where the font verified the glyphs, with the text layer's digits kept (the `hin` model reads 1 as 4).
* A clean-looking line whose font reading is fully verified and equal to the text layer skips OCR.
* **Legacy Kruti Dev / DevLys / Chanakya lines** (any name spelling, e.g. `Devnagari-ChanakyaNormalA`) are decoded by Pdfroo's own converter (a JS port of the research table, output-identical to the Python reference on all 343 corpus lines plus 6,000 fuzz strings; holdout accuracy about 9–12/12, so research quality) and cross-checked with OCR. The converter wins on disagreement, they are **always** confirmed, and they are saved as Unicode in Noto Sans Devanagari.

* **Per-document learned glyph map.** For Word subsets without GSUB, each confirmed or auto-accepted line teaches Pdfroo glyph-sequence→text mappings for that font, kept in `state.glyphMaps` (plain JSON, this document only — never across documents). Learning is conservative: only unambiguous one-to-one alignments of PDF glyphs with HarfBuzz/Noto clusters, and conflicting observations cancel a mapping. A later line decoded from the map still needs OCR letter agreement before it is auto-accepted (`source: 'learned'`); the text-layer digits / punctuation win; legacy lines never teach the map. On the researcher's Unicode corpus this lifts auto-accepts from 240 → 263 Pdfroo lines with 0 wrong auto-accepts (see `pdf-editor-dev/real/out/indic-corpus-regression.md`).

Downloads are lazy and happen only on the first checked line: tesseract.js + worker 170 KB; WASM core about 3.8 MB (SIMD or plain); one language model, gzipped: hin 0.9 MB, ben 0.5, pan 0.3, guj 0.7, ori 1.0, tam 1.3, tel 1.2, kan 1.9, mal 2.1, plus eng 1.9 when the line has Latin letters. Models are cached in IndexedDB. OCR takes about 10–70 ms per line after loading, and 0.2–0.3 s for the first line on a warm HTTP cache. OCR needs http(s); on `file://` only the font reading or converter is offered, always with confirmation.

**Export** – Download flattens every annotation and page change into a standard PDF with pdf-lib. Shapes and strokes stay vector. Added text is embedded as real, selectable and searchable text in **Noto Sans** (Regular/Bold, bundled locally and embedded with fontkit). That covers Latin incl. accents, Greek, Cyrillic, and currency signs such as ₹ €. The editor previews text in the same font, so what you see is what you get. Indic text is embedded as shaped, searchable text (see *Indic scripts* above). Text in other scripts pdf-lib can't shape (Arabic/Hebrew, Thai, CJK, emoji), or characters missing from the fonts, is embedded as a crisp transparent image instead; it looks right but isn't selectable. Original page content, text and fonts are preserved. The export is built on top of the first source PDF rather than by copying pages into an empty file. That keeps document-level structure intact: AcroForm fields stay present and fillable, and links, outlines and named destinations keep working. Pages from merged files are copied in. Links pointing to deleted pages are dropped, and deleted pages and replaced content streams are pruned from the saved file.

**Digitally signed PDFs** – On open, Pdfroo looks for signature fields (`/FT /Sig` with a `/V` value, plus the signer name and date), certification signatures (`/Perms /DocMDP`) and Reader usage rights (`/UR3`). For a signed file it shows a non-blocking banner that names the signer and explains that any change (annotations, page edits, text edits) will invalidate the signature. The banner can be minimised to a chip. The first edit of any kind opens a confirmation ("Edit a signed document?" → Cancel / Edit anyway), and there's no second prompt after you agree. If you download without changing anything, Pdfroo returns the original bytes, so the signature stays valid; otherwise the download toast says the signature is no longer valid in that copy. Reader-extension usage rights (`/UR3`) are removed from edited exports, since they would otherwise make Acrobat complain about the modified file.

**Protected PDFs** – Encrypted files are detected when you open or merge them and refused with a clear message, instead of being exported as scrambled pages. This covers password-to-open files and files with only an owner/permissions password.

**Keyboard shortcuts** – `Ctrl/⌘+Z` undo, `Ctrl+Y` / `Ctrl+Shift+Z` redo, `Delete`/`Backspace` delete selection, `Ctrl+S` download, `Ctrl+D` duplicate selection, `V T X P H R E L A W` tools, `I` image, `S` signature, `←/→` `PgUp/PgDn` pages, `+ − 0` zoom, `Ctrl+F` find & replace, `Esc` deselect, `?` help.

## Architecture

```
index.html              markup for landing + editor + dialogs, inline SVG icon sprite
css/styles.css          design tokens (CSS variables, light/dark), responsive layout
js/engine/pdfEngine.js  PDF ENGINE BOUNDARY (the only code that touches pdf.js / pdf-lib)
js/engine/textEdit.js   engine-internal: content-stream tokenizer, text-state simulator,
                        line matching / surgical removal (used only by pdfEngine.js)
js/app.js               UI: tools, overlay interaction, thumbnails, history, shortcuts
js/sample.js            generates the demo PDF with pdf-lib
js/config.js            site config: author credit (name, GitHub, LinkedIn)
vendor/                 pdf.js 3.11 (legacy build + worker, cmaps, standard fonts),
                        pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1 (lazy-loaded at export),
                        SortableJS 1.15, Inter (UI font), Noto Sans (annotation font):
                        FolioNotoSans-*.woff2 preview, FolioNotoSans-*.ttf extended export,
                        FolioNotoSans-*-Basic.ttf ~11 KB basic-Latin export subset,
                        noto-sans-(basic-)data.js = the same TTFs as base64 for file://
                        where fetch() is blocked — all local
vendor/harfbuzz/        harfbuzzjs 0.10.3 (MIT): hb.js + hbjs.js + hb.wasm, plus hb-wasm-data.js
                        (base64 wasm for file://) — lazy-loaded only for Indic text
vendor/fonts/indic/     Noto Sans Devanagari/Bengali/Gurmukhi/Gujarati/Oriya/Tamil/Telugu/
                        Kannada/Malayalam Regular+Bold (OFL), subset to their script block with
                        GSUB/GPOS, base64 .js, one loaded per script on demand; see LICENSE
js/engine/indic.js      lazy: HarfBuzz shaping, cluster→glyph text mapping, Type0 writer
vendor/fonts/edit/      lazily loaded substitute fonts for editing existing text
                        (Liberation Sans/Serif/Mono, Carlito, Caladea, Roboto, Open Sans,
                        Lato: Latin subsets; Noto Sans/Serif/Sans Mono: Latin+Greek+Cyrillic),
                        base64 .js so they load from file:// too; see LICENSES.txt
```

* **Engine boundary.** `window.PdfEngine` exposes `load`, `getPageCount`, `renderPage`, `renderThumbnail`, `exportWithAnnotations`, `merge`, `rotatePage`, `deletePage`, `duplicatePage`, `reorderPages`, `addBlankPage`, and for existing text `getTextLines(page)`, `editTextLine(state, pageIndex, lineId, text)` and `getLineEditorFont(page, lineId)` (+ small geometry helpers). The UI never calls pdf.js or pdf-lib directly, so the engine can later be swapped without touching `app.js`. For example, **MuPDF.js** could provide exact-font editing for glyphs missing from a subset (tier 1 for more cases) behind the same `getTextLines` / `editTextLine` calls.
* **Serializable state.** The whole document is a plain JSON object:
  `{ version, name, pages: [{ id, src, index, w, h, baseRot, rot, annots: [...], textEdits: [...] }], assets: { id: { dataUrl, kind } } }`.
  A text edit is plain JSON too: `{ lineId, original, text, tier, label, geo, match, removal, color, bg, t1, sub }`.
  Annotations are stored in page points (e.g. `{ type: "rect", x, y, w, h, color, width }`). Original PDF bytes are kept inside the engine by `src` id (`PdfEngine.getSourceBytes(src)`), so the state + source files could later be persisted to e.g. Supabase (DB row + storage bucket). There is **no database now**; everything stays in the browser.
* Scripts are classic (non-module) scripts sharing a namespace so the app also runs from `file://`.

## Known limitations

* Compress PDF: only images get smaller. Fonts are de-duplicated but not re-subset, so text-heavy files (e.g. a 650 KB speech) barely shrink and a 100 KB target is reported as unreachable. JPEG 2000 / JBIG2 / CCITT, colour-key-masked and 1–4-bit images are left as they are; images used in tiling patterns or inline images (`BI … EI`) aren't touched. JPEG is lossy, so very low targets give visibly soft photos (text and drawings stay sharp). Very large CMYK images (over 40 MP) are kept as they are.
* Editing existing text works one line at a time. There's no paragraph reflow: a longer line simply runs further right (it can overlap neighbouring content), and wrapping is not recalculated.
* Tier 1 (the original font) only applies when every character is known to exist in the embedded font, i.e. it is already used with that font on the page. Otherwise the whole line switches to a substitute (tier 2/3), which can look slightly different from the rest of a paragraph. Adding missing glyphs to a subset font would need a heavier engine (e.g. MuPDF.js).
* Tier-2 substitute files are Latin-only subsets. Anything else (₹, Greek, Cyrillic…) falls back to tier-3 Noto.
* Text drawn inside form XObjects (e.g. iText-stamped Gazette PDFs), runs shared by several lines, or fonts that can't be mapped unambiguously are covered with a background-coloured box instead of removed, and then use a substitute font (tier 2/3). The old text then stays in the file (selectable underneath), and Pdfroo says so when it happens.
* Pdfroo can't keep digital signatures valid after an edit; that's inherent to signing. It warns you and asks first. Files that only carry Reader usage rights (`/UR3`, e.g. IRS forms) get no banner; those rights are removed on export.
* Refused: scanned pages without a text layer, outlined text, rotated / skewed / vertical text, Type 3 fonts, text without Unicode mapping, invisible OCR layers, legacy Hindi fonts other than Kruti Dev/DevLys/Chanakya, and existing lines in Arabic/Hebrew/Thai/Sinhala.
* On a page rotated in Pdfroo, the inline line editor is still horizontal.
* Encrypted PDFs (user **or** owner password) can't be edited yet. They are rejected with a message; remove the protection (e.g. "Print to PDF") first.
* Interactive form fields are preserved in the export (still fillable in other apps), but Pdfroo itself can't fill them. Type on top instead.
* New text in Arabic, Hebrew, Thai, CJK and emoji is exported as an image, so it isn't selectable or searchable. On screen it uses your system's fonts for those scripts. Indic scripts are real text (see above).
* Indic: only Noto **Sans** faces (no serif Indic substitute), so an edited line in a serif Hindi font (Kokila, Mangal-serif styles) changes typeface. Reading checks: Word subsets have no GSUB, so conjunct glyphs rely on ToUnicode + OCR + the per-document learned glyph map; `tessdata_fast` misreads (digits, nukta, ि) mean most broken lines need confirmation; the Telugu/Kannada logical reordering is heuristic; OCR is unavailable on `file://`; the Kruti Dev/Chanakya converter is research quality. Extractors that ignore `/ActualText` and read only ToUnicode may show an extra ZWSP where a mark was drawn out of flow. Assamese, Sinhala, Ol Chiki and other scripts aren't covered.
* Combining accent marks typed as separate characters may sit slightly off in the PDF; precomposed characters (é, ñ, ά…) are fine.
* Added text grows the export by only ~9 KB per font weight when it uses just basic Latin (ASCII plus curly quotes, dashes, bullet, ellipsis, ©®™°). It grows by ~150 KB per weight when it needs the extended Noto Sans set (₹, accents, Greek, Cyrillic…). Only weights actually used are embedded. Font files are pre-subset with fonttools and embedded whole, because pdf-lib's own glyph subsetter corrupted this font's outlines in testing.
* Ligatures and kerning are disabled for added text (preview and export alike). pdf-lib mispositions ligature glyphs and ignores kerning, so this keeps the two identical.
* When a page is rotated, shapes and strokes rotate with the page, but text boxes and images stay upright (they move with their centre).
* Very large documents are limited by device memory (all processing is local).

## Licenses

pdf.js (Apache-2.0), pdf-lib (MIT), @pdf-lib/fontkit (MIT), harfbuzzjs (MIT, `vendor/harfbuzz/LICENSE`), tesseract.js + tesseract.js-core and the `tessdata_fast` models (Apache-2.0, `vendor/tesseract/LICENSE`), SortableJS (MIT), Inter, Noto Sans and the Noto Sans Indic fonts (SIL OFL 1.1, `vendor/fonts/indic/LICENSE`) — license files are in `vendor/`. Text-editing substitutes: Liberation, Carlito, Caladea, Lato, Noto (SIL OFL 1.1) and Roboto, Open Sans (Apache-2.0) — see `vendor/fonts/edit/LICENSES.txt`. Subsetted copies of fonts with a Reserved Font Name (Liberation, Lato) are renamed internally as the OFL requires.
