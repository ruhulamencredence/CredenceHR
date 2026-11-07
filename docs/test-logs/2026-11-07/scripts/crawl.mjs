// Full-app crawl: every Admin tab and Self Service page per role, desktop + phone.
import { createRequire } from 'module'; const { chromium, devices } = createRequire('/usr/local/lib/node_modules_global/')('playwright');
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || 'crawl.json';
const shots = process.argv[3] || 'shots'; fs.mkdirSync(shots, { recursive: true });
const src = fs.readFileSync('/home/user/CredenceHR/src/lib/adminUrl.ts', 'utf8');
const tabs = [...src.match(/ADMIN_TAB_KEYS = new Set<string>\(\[(.*?)\]\)/s)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
const selfSrc = fs.readFileSync('/home/user/CredenceHR/src/lib/selfUrl.ts', 'utf8');
const slugs = [...selfSrc.matchAll(/^\s+\w+: '([a-z-]+)',?$/gm)].map((m) => m[1]);
const login = async (i, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
const roles = JSON.parse(process.env.ROLES);
const b = await chromium.launch();
const out = [];
async function run(label, auth, urls, ctxOpts) {
  const ctx = await b.newContext(ctxOpts);
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); }, [auth.token, auth.user]);
  const page = await ctx.newPage(); let errs = [], bad = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|net::ERR|tile|carto|fonts|openstreetmap|nominatim|Failed to load resource/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 180)); });
  page.on('response', (r) => { const u = r.url(); if (u.startsWith(BASE + '/api') && r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${u.replace(BASE, '').split('?')[0].slice(0, 80)}`); });
  for (const u of urls) {
    errs = []; bad = []; const t0 = Date.now();
    try { await page.goto(BASE + u, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(2500); } catch (e) { errs.push('nav: ' + e.message.slice(0, 120)); }
    for (const n of ['Later', 'Got it', 'Not now']) { const l = page.getByRole('button', { name: n, exact: true }); if (await l.first().isVisible().catch(() => false)) await l.first().click().catch(() => {}); }
    const info = await page.evaluate(() => {
      const ov = document.documentElement.scrollWidth - window.innerWidth;
      const txt = document.body.innerText.replace(/\s+/g, ' ');
      const h = [...document.querySelectorAll('h1,h2,h3')].map((x) => x.textContent.trim()).filter(Boolean).slice(0, 3).join(' | ');
      const errText = /something went wrong|failed to load|not authorized|error loading|cannot read|undefined|NaN|\[object Object\]/i.exec(txt)?.[0] || '';
      return { ov, len: txt.trim().length, h, path: location.pathname, errText };
    }).catch(() => ({ ov: 0, len: 0, h: '', path: '', errText: '' }));
    const name = `${label}${u.replace(/\//g, '_') || '_home'}`;
    if (errs.length || info.ov > 2 || info.errText || bad.some((x) => /^5/.test(x))) await page.screenshot({ path: `${shots}/${name}.png` }).catch(() => {});
    out.push({ label, url: u, landed: info.path, ms: Date.now() - t0, heading: info.h, errors: [...new Set(errs)], api: [...new Set(bad)], overflowPx: info.ov > 2 ? info.ov : 0, blank: info.len < 30, suspiciousText: info.errText });
  }
  await ctx.close();
}
for (const r of roles) {
  const auth = await login(r.login, r.password);
  if (!auth.token) { out.push({ label: r.label, error: 'login failed', detail: JSON.stringify(auth).slice(0, 200) }); continue; }
  const urls = ['/', ...(r.admin ? tabs.map((t) => '/admin/' + t.replace(/_/g, '-')) : []), ...slugs.map((s) => '/self/' + s)];
  await run(r.label + '-desktop', auth, urls, { viewport: { width: 1440, height: 900 } });
  await run(r.label + '-phone', auth, urls, { ...devices['Pixel 7'] });
}
await b.close();
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const probs = out.filter((o) => o.error || o.errors?.length || o.overflowPx || o.suspiciousText || o.api?.some((x) => /^5/.test(x)));
console.log('pages', out.length, 'with problems', probs.length);
for (const o of probs) console.log(o.label, o.url, '->', o.landed, '| err:', (o.errors || []).join(' ; ').slice(0, 220), '| 5xx:', (o.api || []).filter((x) => /^5/.test(x)).join(','), '| overflow', o.overflowPx, '| text:', o.suspiciousText, o.error || '');
const four = out.filter((o) => o.api?.some((x) => /^4/.test(x)));
console.log('pages with 4xx', four.length); for (const o of four) console.log(' ', o.label, o.url, o.api.filter((x) => /^4/.test(x)).join(', '));
