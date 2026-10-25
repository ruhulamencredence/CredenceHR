// QA: basic accessibility on the main pages — buttons/links with no name,
// inputs with no label, images with no alt, and keyboard focus visibility.
import { createRequire } from 'module';
const { chromium } = createRequire('/usr/local/lib/node_modules_global/')('playwright');
const BASE = process.env.BASE || 'http://localhost:3100';
const login = async (i, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
const SA = await login('admin@credence.test', 'AdminPass123');
const EMP = await login(process.env.EMP_LOGIN || 'imran@credence.test', 'Staff@123');
const b = await chromium.launch();
const pages = [['superadmin', SA, '/'], ['superadmin', SA, '/admin/employees'], ['superadmin', SA, '/admin/payroll'], ['superadmin', SA, '/admin/approvals'], ['employee', EMP, '/'], ['employee', EMP, '/self/timesheet'], ['employee', EMP, '/self/my-tasks']];
const ctxs = {};
const tot = { unnamedButtons: 0, unlabeledInputs: 0, imgNoAlt: 0 };
for (const [who, auth, url] of pages) {
  const ctx = ctxs[who] || (ctxs[who] = await b.newContext({ viewport: { width: 1440, height: 900 } }));
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); localStorage.setItem(`credence_webpush_snooze_${u.id}`, String(Date.now() + 9e9)); }, [auth.token, auth.user]);
  const p = await ctx.newPage(); await p.goto(BASE + url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000);
  const r = await p.evaluate(() => {
    const vis = (e) => { const s = getComputedStyle(e); const rc = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && rc.width > 0 && rc.height > 0; };
    const name = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.getAttribute('aria-labelledby') || '').trim();
    const btn = [...document.querySelectorAll('button, [role=button], a[href]')].filter(vis).filter((e) => !name(e) && !e.querySelector('img[alt]:not([alt=""])'));
    const inp = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(vis).filter((e) => !(e.id && document.querySelector(`label[for="${e.id}"]`)) && !e.closest('label') && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.getAttribute('title'));
    const img = [...document.querySelectorAll('img')].filter(vis).filter((e) => !e.hasAttribute('alt'));
    return { unnamedButtons: btn.length, unlabeledInputs: inp.length, placeholderOnly: inp.filter((e) => e.getAttribute('placeholder')).length, imgNoAlt: img.length, sample: btn.slice(0, 3).map((e) => e.outerHTML.slice(0, 90)) };
  });
  await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
  const focus = await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 'nothing focused'; const s = getComputedStyle(e); return s.outlineStyle !== 'none' && s.outlineWidth !== '0px' ? 'visible outline' : s.boxShadow !== 'none' ? 'ring (box-shadow)' : 'NO visible focus'; });
  for (const k of Object.keys(tot)) tot[k] += r[k];
  console.log(`${who.padEnd(10)} ${url.padEnd(18)} unnamed buttons/links ${r.unnamedButtons}, unlabeled inputs ${r.unlabeledInputs} (placeholder only ${r.placeholderOnly}), img without alt ${r.imgNoAlt}, Tab focus: ${focus}`);
  if (r.sample.length) console.log('           e.g. ' + r.sample.join(' | '));
  await p.close();
}
console.log('TOTAL', JSON.stringify(tot));
await b.close();
