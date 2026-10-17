// Headless test for the E-Invoice Data Check. Usage: node test.js (needs jsdom from ../../tests/node_modules or npm install jsdom)
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const body = fs.readFileSync(path.join(__dirname, 'einvoice_check.html'), 'utf8').replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/, '');
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const errors = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/#p-971501234567-Noor_Co', pretendToBeVisual: true });
const w = dom.window, d = w.document, g = n => w.eval(n);
w.addEventListener('error', e => errors.push(e.message || String(e)));
w.HTMLElement.prototype.scrollIntoView = function () {};
const res = g('state').result;
const expect = { i2: 6, c2: 2, i1: 2, i6: 2, c1: 1, c3: 1, c4: 1, c5: 1, c6: 1, i3: 1, i4: 1, i7: 1, i8: 2, c7: 1, i9: 1, i10: 1 };
const got = Object.fromEntries(res.findings.map(f => [f.id, f.count]));
const mismatches = Object.entries(expect).filter(([k, v]) => got[k] !== v);
d.getElementById('paste-cust').value = 'Name,TRN,Country\nAcme LLC,100123456789012,AE\nBeta FZE,,AE';
d.getElementById('paste-cust').dispatchEvent(new w.Event('input'));
setTimeout(() => {
  d.getElementById('run').click();
  const r2 = g('state').result;
  const ok = !errors.length && !mismatches.length && res.score === 66 && !d.getElementById('pbanner').hidden && r2.cust.n === 2 && g('state').sample === false;
  console.log(JSON.stringify({ ok, errors, score: res.score, mismatches, rejected: res.inv.riskCount, riskAED: res.inv.riskAED, pasteCustomers: r2.cust.n }, null, 1));
  dom.window.close(); process.exit(ok ? 0 : 1);
}, 600);
