/* Pdfroo Resume Rebuild: data model (JSON Resume, https://jsonresume.org/schema, MIT) + on-device autosave. MIT. */
(function (root) {
  'use strict';
  const KEY = 'pdfroo-resume-v1';
  const SECTION_NAMES = { summary: 'Summary', work: 'Experience', education: 'Education', skills: 'Skills', projects: 'Projects', awards: 'Certifications', languages: 'Languages', interests: 'Interests' };
  const DEFAULT_ORDER = ['summary', 'work', 'education', 'skills', 'projects', 'awards', 'languages', 'interests'];
  function blank() {
    return {
      basics: { name: '', label: '', email: '', phone: '', url: '', image: '', summary: '', location: { city: '', region: '' }, profiles: [] },
      work: [], education: [], skills: [], projects: [], awards: [], languages: [], interests: [],
      meta: { pdfroo: { template: 'modern', photoShape: 'round', order: DEFAULT_ORDER.slice(), custom: [], personal: null, declaration: null, keepPersonal: false, keepDeclaration: false, conf: {} } },
    };
  }
  function normalize(r) {
    const b = blank(); r = r || {};
    const out = Object.assign(b, r);
    out.basics = Object.assign(blank().basics, r.basics || {});
    out.basics.location = Object.assign({ city: '', region: '' }, (r.basics && r.basics.location) || {});
    out.meta = { pdfroo: Object.assign(blank().meta.pdfroo, (r.meta && r.meta.pdfroo) || {}) };
    for (const k of DEFAULT_ORDER) if (!Array.isArray(out[k]) && k !== 'summary') out[k] = [];
    return out;
  }
  function save(r) {
    try { localStorage.setItem(KEY, JSON.stringify(r)); return true; }
    catch (e) { // a large photo can overflow the quota: keep the text, drop the photo from storage only
      try { const c = JSON.parse(JSON.stringify(r)); c.basics.image = ''; localStorage.setItem(KEY, JSON.stringify(c)); return true; } catch (e2) { return false; }
    }
  }
  function load() { try { const s = localStorage.getItem(KEY); return s ? normalize(JSON.parse(s)) : null; } catch (e) { return null; } }
  function clear() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
  function sample() {
    const r = blank();
    Object.assign(r.basics, { name: 'Your Name', label: 'Job title', email: 'you@example.com', phone: '+91 98xxx xxxxx', summary: 'One or two lines about what you do and what you are good at.', location: { city: 'City', region: 'State' } });
    r.work = [{ position: 'Role', name: 'Company', startDate: '2022-01', endDate: '', highlights: ['What you did, with a number if you can.'] }];
    r.education = [{ institution: 'College', studyType: 'Degree', area: 'Subject', startDate: '2018', endDate: '2022', score: '' }];
    r.skills = [{ name: 'Skill one' }, { name: 'Skill two' }];
    return r;
  }
  root.ResumeModel = { KEY, SECTION_NAMES, DEFAULT_ORDER, blank, normalize, save, load, clear, sample };
})(window);
