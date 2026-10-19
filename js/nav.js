/* Pdfroo back-button history: each in-app screen (resume builder, form filler, tool dialogs) is one history entry,
   so browser/Android Back returns to the previous screen instead of leaving the site. The editor keeps its own entry
   (app.js, state.pdfrooEditor); we carry that flag along so Back from a screen opened over the editor lands on the editor. */
(function (root) {
  'use strict';
  const stack = [];          // [{ view, close }]
  let skip = 0;              // popstates caused by our own history.go()
  let reuse = false;         // a screen handed its history entry on to the next screen (chooser -> builder)
  function open(view, close) {
    const top = stack[stack.length - 1];
    if (top && top.view === view) { top.close = close; return; }   // re-render of the same screen: no double push
    if (reuse && history.state && history.state.pdfrooDepth) stack.length = history.state.pdfrooDepth - 1; else reuse = false;
    stack.push({ view, close });
    const st = Object.assign({}, history.state && history.state.pdfrooEditor ? { pdfrooEditor: 1 } : null, { pdfrooView: view, pdfrooDepth: stack.length });
    try { if (reuse) history.replaceState(st, '', location.href); else history.pushState(st, '', location.href); } catch (e) { /* file:// etc. */ }
    reuse = false;
  }
  // the screen was closed in-app (✕ / ← / Esc): drop its history entry (and any above it) without re-closing
  // handOn = the next screen is about to open: keep the entry for it instead of going back (no back/push race)
  function done(view, handOn) {
    const i = stack.findIndex((s) => s.view === view); if (i < 0) return;
    if (handOn && i === stack.length - 1) { reuse = true; return; }
    const n = stack.length - i; stack.splice(i);
    try { skip++; history.go(-n); } catch (e) { skip--; }
  }
  root.addEventListener('popstate', (e) => {
    if (skip) { skip--; return; }
    reuse = false;
    const depth = (e.state && e.state.pdfrooDepth) || 0;
    // Forward onto an entry whose screen is already closed: step straight back without reopening, so no dead entry
    // is left that would cost an extra Back press (only our own pdfroo entries; the editor entry is app.js's business)
    if (depth > stack.length) { try { skip++; history.go(stack.length - depth); } catch (er) { skip--; } return; }
    while (stack.length > depth) { const s = stack.pop(); try { s.close(); } catch (er) { console.error(er); } }
  });
  root.PdfrooNav = { open, done };
})(window);
