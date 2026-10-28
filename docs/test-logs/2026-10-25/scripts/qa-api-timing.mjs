// QA: response time of every GET /api route as Superadmin on a filled database
// (run after the HR 2-year simulation). Params are filled with 1.
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3100';
const routes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).filter((r) => r.method === 'GET');
const fill = (p) => p.replace(/:[A-Za-z_]+(\([^)]*\))?\??/g, '1');
const SA = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@credence.test', password: 'AdminPass123' }) })).json()).token;
const out = []; const seen = new Set();
for (const r of routes) {
  if (seen.has(r.path)) continue; seen.add(r.path);
  const t0 = performance.now(); let status = 0, len = 0;
  try { const x = await fetch(BASE + fill(r.path), { headers: { authorization: `Bearer ${SA}` }, signal: AbortSignal.timeout(15000) }); status = x.status; len = (await x.arrayBuffer()).byteLength; } catch {}
  out.push({ path: r.path, status, ms: Math.round(performance.now() - t0), kb: Math.round(len / 1024) });
}
out.sort((a, b) => b.ms - a.ms);
const ms = out.map((o) => o.ms).sort((a, b) => a - b);
const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
console.log(`GET routes ${out.length}; median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${ms[ms.length - 1]} ms; over 1 s: ${out.filter((o) => o.ms > 1000).length}; over 300 ms: ${out.filter((o) => o.ms > 300).length}`);
for (const o of out.slice(0, 12)) console.log(`${String(o.ms).padStart(6)} ms  ${String(o.kb).padStart(6)} KB  ${o.status}  ${o.path}`);
fs.writeFileSync(process.argv[3] || 'qa-api-timing.json', JSON.stringify(out, null, 1));
