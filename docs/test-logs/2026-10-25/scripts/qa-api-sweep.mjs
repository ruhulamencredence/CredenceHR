// QA: sweep every /api route found in the server code.
//  1. no sign-in            -> must be refused (401), except the public routes
//  2. a plain employee login (no Self Service switches) and
//  3. an Admin with NO modules -> GET routes: who gets data they shouldn't
//  4. Superadmin, empty / wrong-typed bodies on POST/PUT -> must never be a 500
// Route params are filled with 1. Output: JSON + a readable list of findings.
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3100';
const routes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outFile = process.argv[3] || 'qa-api-sweep.json';
async function call(tok, method, path, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { method, signal: ctl.signal, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const txt = await r.text();
    return { status: r.status, ms: Date.now() - t0, len: txt.length, snip: txt.slice(0, 160), html: /^\s*<!doctype html|<html/i.test(txt) };
  } catch (e) { return { status: 0, ms: Date.now() - t0, len: 0, snip: String(e.name || e) }; } finally { clearTimeout(t); }
}
const fill = (p) => p.replace(/:[A-Za-z_]+(\([^)]*\))?/g, '1');
const login = async (i, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json()).token;
const SA = await login('admin@credence.test', 'AdminPass123');
const mk = async (name, email, role) => { await call(SA, 'POST', '/api/users', { name, email, password: 'QaPass#2026', role }); return login(email, 'QaPass#2026'); };
const USER = await mk('QA Plain User', 'qa.user@credence.test', 'user');
const ADMIN0 = await mk('QA Admin No Modules', 'qa.admin0@credence.test', 'admin');
const PUBLIC = [/^\/api\/auth\/(login|register|refresh|logout)/, /^\/api\/auth\/fingerprint\/(app\/login|passkey\/login)/, /^\/api\/public\//, /^\/api\/password-reset/, /^\/api\/auth\/(forgot|reset|password)/, /^\/api\/health/, /^\/api\/app-version/, /^\/api\/onboarding\/public/];
const isPublic = (p) => PUBLIC.some((re) => re.test(p));
const res = { unauth: [], user: [], admin0: [], fuzz: [], slow: [] };
const seen = new Set();
for (const r of routes) {
  const key = r.method + ' ' + r.path; if (seen.has(key)) continue; seen.add(key);
  const p = fill(r.path);
  // 1. no sign-in
  const a = await call(null, r.method, p, r.method === 'GET' ? undefined : {});
  if (!(a.status === 401 || a.status === 403) && !isPublic(r.path)) res.unauth.push({ ...r, got: a.status, snip: a.snip });
  if (a.status >= 500) res.fuzz.push({ ...r, who: 'no sign-in', got: a.status, snip: a.snip });
  if (r.method !== 'GET') continue;
  // 2/3. low-privilege GETs
  for (const [who, tok, bucket] of [['plain user', USER, 'user'], ['admin, no modules', ADMIN0, 'admin0']]) {
    const g = await call(tok, 'GET', p);
    if (g.status >= 200 && g.status < 300 && !g.html) res[bucket].push({ ...r, got: g.status, len: g.len, snip: g.snip });
    if (g.status >= 500) res.fuzz.push({ ...r, who, got: g.status, snip: g.snip });
  }
  const s = await call(SA, 'GET', p);
  if (s.status >= 500) res.fuzz.push({ ...r, who: 'superadmin GET', got: s.status, snip: s.snip });
  if (s.ms > 1500) res.slow.push({ ...r, ms: s.ms });
}
// 4. Superadmin with bad bodies on writes (no DELETE: keep the data).
const BAD = [{}, { id: 'x', name: 12345, amount: 'abc', date: 'not-a-date', employee_id: -1, month_year: '9999-99' }, '{"broken json', { name: 'x'.repeat(20000) }];
for (const r of routes.filter((r) => r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH')) {
  if (/logout|password|block|delete|purge|reset|restore|wipe|sync|send|email|import/i.test(r.path)) continue;
  for (const b of BAD) {
    const x = await call(SA, r.method, fill(r.path), b);
    if (x.status >= 500 || x.status === 0) { res.fuzz.push({ ...r, who: 'superadmin, bad body', body: typeof b === 'string' ? b : JSON.stringify(b).slice(0, 60), got: x.status, snip: x.snip }); break; }
  }
}
fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
for (const k of Object.keys(res)) console.log(k, res[k].length);
