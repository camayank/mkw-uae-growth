// Headless smoke test for the UAE ASP Selector.
// Usage: cd tests && npm install && node test.js
// Exercises: wizard walk, share-token round trip, scoring over all providers for five personas,
// deadline + exposure rendering, checklist, directory search, compare drawer.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.html'), 'utf8');

function run(hash) {
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/' + (hash ? '#' + hash : ''), pretendToBeVisual: true });
  const w = dom.window, d = w.document, g = n => w.eval(n);
  w.addEventListener('error', e => errors.push(e.message || String(e)));
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const out = { errors, providers: g('DATA').length, dirRows: d.querySelectorAll('#dir details').length };
  if (!hash) {
    for (const v of ['sme', 'Tally', 'freezone', '2-5', '100-1k', 'yes']) {
      const b = [...d.querySelectorAll('#wizard .opt')].find(o => o.dataset.v === v);
      if (!b) { errors.push('option missing: ' + v); break; }
      b.click(); g('advance')();
    }
    const pr = [...d.querySelectorAll('#wizard .opt')];
    pr.find(o => o.dataset.v === 'cost').click(); pr.find(o => o.dataset.v === 'trial').click();
    d.getElementById('next').click();
  }
  const st = g('state');
  out.token = g('encodeToken')(st.answers);
  out.decodedOk = JSON.stringify(g('decodeToken')(out.token)) === JSON.stringify({ ...st.answers, priorities: st.answers.priorities || [] });
  out.matches = [...d.querySelectorAll('#matches .match h3')].map(h => h.textContent);
  out.scores = [...d.querySelectorAll('#matches .score b')].map(b => +b.textContent);
  out.checklist = d.querySelectorAll('#checklist .ck li').length;
  out.exposure = d.getElementById('exp-total') && d.getElementById('exp-total').textContent;
  const personas = [
    { band: 'large', erp: 'SAP', zone: 'both', entities: '6+', volume: '10k+', gcc: 'yes', priorities: ['global', 'support'] },
    { band: 'sme', erp: 'Zoho Books', zone: 'mainland', entities: '1', volume: 'lt100', gcc: 'no', priorities: ['cost', 'trial', 'arabic'] },
    { band: 'gov', erp: 'Oracle', zone: 'mainland', entities: '2-5', volume: '1k-10k', gcc: 'no', priorities: [] },
    { band: 'unsure', erp: 'Excel/CSV upload', zone: 'freezone', entities: '1', volume: 'lt100', gcc: 'no', priorities: ['speed'] },
    { band: 'sme', erp: 'Other ERP', zone: 'mainland', entities: '1', volume: '100-1k', gcc: 'yes', priorities: ['advisory'] }
  ];
  out.personas = personas.map(a => {
    const scored = g('DATA').map(p => g('score')(p, a));
    const bad = scored.filter(s => !Number.isFinite(s.score) || s.score < 0 || s.score > 100).length;
    const top = g('DATA').map((p, i) => ({ n: p.name, s: scored[i].score })).sort((x, y) => y.s - x.s).slice(0, 3).map(x => `${x.n} ${x.s}`);
    return { erp: a.erp, band: a.band, badScores: bad, top };
  });
  d.getElementById('q').value = 'tally'; d.getElementById('q').dispatchEvent(new w.Event('input'));
  out.searchTally = d.querySelectorAll('#dir details').length;
  const cbs = [...d.querySelectorAll('#matches [data-cmp]')];
  if (cbs.length >= 2) { cbs[0].click(); cbs[1].click(); d.getElementById('cbar-open').click(); out.compareRows = d.querySelectorAll('#drawer-body tr').length; }
  dom.window.close();
  return out;
}
function runPartner(hash) {
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/#' + hash, pretendToBeVisual: true });
  const w = dom.window, d = w.document, g = n => w.eval(n);
  w.addEventListener('error', e => errors.push(e.message || String(e)));
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const out = { errors };
  out.bannerVisible = !d.getElementById('pbanner').hidden;
  out.bannerName = d.getElementById('pbanner-name').textContent;
  out.bannerWa = d.getElementById('pbanner-wa').getAttribute('href');
  out.ctaText = d.querySelector('#share .actions .btn.primary') && d.querySelector('#share .actions .btn.primary').textContent;
  out.ctaHref = d.querySelector('#share .actions .btn.primary') && d.querySelector('#share .actions .btn.primary').getAttribute('href');
  out.shareLink = g('shareLink')();
  out.summaryHasPartner = /Shared via: Al Hilal Accounting/.test(d.getElementById('summary').value);
  d.getElementById('pg-name').value = 'Noor & Co'; d.getElementById('pg-name').dispatchEvent(new w.Event('input'));
  d.getElementById('pg-wa').value = '+971 50 999 8888'; d.getElementById('pg-wa').dispatchEvent(new w.Event('input'));
  out.generated = d.getElementById('pg-link').textContent;
  out.generatedDecodes = JSON.stringify(g('decodePartner')(out.generated.split('#')[1]));
  dom.window.close();
  return out;
}
const a = run('');
const b = run(a.token);
const c = runPartner('p-971501234567-Al_Hilal_Accounting.' + a.token);
const ok = !a.errors.length && !b.errors.length && !c.errors.length && a.decodedOk && a.matches.length === 5 && b.matches.join() === a.matches.join() && a.personas.every(p => p.badScores === 0)
  && c.bannerVisible && c.bannerName === 'Al Hilal Accounting' && /wa\.me\/971501234567/.test(c.ctaHref || '') && /p-971501234567-Al_Hilal_Accounting\.q/.test(c.shareLink) && c.summaryHasPartner && /p-971509998888-Noor_Co/.test(c.generated);
console.log(JSON.stringify({ ok, walk: a, reopen: { errors: b.errors, matches: b.matches }, partner: c }, null, 1));
process.exit(ok ? 0 : 1);
