/* Pdfroo site config — edit these values. */
const CREDIT_LINKEDIN = 'https://www.linkedin.com/in/ayushtomar-rpa-ai/';  // LinkedIn profile URL; set to '' to hide the LinkedIn icon
const CREDIT_AUTHOR = 'Ayush Tomar';                // name shown in "Made by …"
const CREDIT_GITHUB = 'https://github.com/ayush4u'; // GitHub profile URL

/* Fills every element with a data-credit attribute with: Made by <author> [GitHub] [LinkedIn] */
(function () {
  'use strict';
  const ICONS = {
    github: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
    linkedin: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.63 0H2.37C1.06 0 0 1.06 0 2.37v11.26C0 14.94 1.06 16 2.37 16h11.26c1.31 0 2.37-1.06 2.37-2.37V2.37C16 1.06 14.94 0 13.63 0zM4.75 13.6H2.4V6h2.35v7.6zM3.57 4.96a1.36 1.36 0 110-2.72 1.36 1.36 0 010 2.72zM13.6 13.6h-2.35V9.9c0-.88-.02-2.02-1.23-2.02-1.23 0-1.42.96-1.42 1.95v3.77H6.25V6h2.26v1.04h.03c.31-.6 1.08-1.23 2.23-1.23 2.39 0 2.83 1.57 2.83 3.62v4.17z"/></svg>',
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const link = (href, label, icon) => `<a class="credit-link" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}">${icon}</a>`;
  function render() {
    const html = `<span>Made by ${esc(CREDIT_AUTHOR)}</span>` +
      (CREDIT_GITHUB ? link(CREDIT_GITHUB, `${CREDIT_AUTHOR} on GitHub`, ICONS.github) : '') +
      (CREDIT_LINKEDIN ? link(CREDIT_LINKEDIN, `${CREDIT_AUTHOR} on LinkedIn`, ICONS.linkedin) : '');
    document.querySelectorAll('[data-credit]').forEach((el) => { el.innerHTML = html; });
  }
  window.PdfrooConfig = { CREDIT_LINKEDIN, CREDIT_AUTHOR, CREDIT_GITHUB, renderCredits: render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
