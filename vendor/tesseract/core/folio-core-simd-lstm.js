/* Folio: loads tesseract-core-simd-lstm.wasm.js and drops tessdata_fast's harmless
   "Warning: Parameter not found: …" lines (legacy-engine settings the LSTM-only core doesn't have),
   so they don't reach the console as errors. Everything else is passed through unchanged. */
importScripts(new URL('tesseract-core-simd-lstm.wasm.js', self.FOLIO_CORE_BASE || (self.location.href.replace(/[^/]*$/, '') + 'core/')).href);
(function () {
  var Core = self.TesseractCore;
  self.TesseractCore = function (opts) {
    opts = opts || {};
    var pe = opts.printErr;
    opts.printErr = function (m) { if (/^Warning: Parameter not found/.test(String(m))) return; if (pe) pe(m); else console.warn(m); };
    return Core(opts);
  };
})();
