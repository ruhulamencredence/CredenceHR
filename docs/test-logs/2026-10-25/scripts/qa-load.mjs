// QA: light load — 20 parallel users, 500 requests over busy pages' APIs.
const BASE = process.env.BASE || 'http://localhost:3100';
const SA = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@credence.test', password: 'AdminPass123' }) })).json()).token;
const paths = ['/api/approvals', '/api/payroll', '/api/leave-applications', '/api/admin-dashboard/extras', '/api/employee-directory', '/api/alerts', '/api/hr-ops/actions'];
const N = 500, C = 20; let i = 0, fails = 0; const times = [];
const t0 = performance.now();
await Promise.all(Array.from({ length: C }, async () => {
  while (i < N) { const p = paths[i++ % paths.length]; const s = performance.now();
    try { const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${SA}` } }); await r.arrayBuffer(); if (r.status !== 200) fails++; } catch { fails++; }
    times.push(performance.now() - s); }
}));
times.sort((a, b) => a - b);
console.log(`${N} requests, ${C} in parallel: ${Math.round(N / ((performance.now() - t0) / 1000))} req/s, median ${Math.round(times[N >> 1])} ms, p95 ${Math.round(times[Math.floor(N * 0.95)])} ms, failures ${fails}`);
