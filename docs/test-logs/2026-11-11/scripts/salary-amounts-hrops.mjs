const B = 'http://127.0.0.1:3200';
const login = async (id) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: id, password: 'ProbePass123', workspace: 'credence' }) })).json()).token;
const H = (t) => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });
let pass = 0, n = 0; const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, x); };
for (const [who, expect] of [['payB', true], ['payC', false]]) {
  const t = await login(who);
  const cat = await (await fetch(B + '/api/hr-ops/reports/catalog', { headers: H(t) })).json();
  const hasCol = (cat.columns || []).some((c) => c.key === 'gross_salary');
  ok(`${who}: Gross Salary column offered = ${expect}`, hasCol === expect, `payroll flag ${cat.payroll}`);
  const r = await fetch(B + '/api/hr-ops/reports/run', { method: 'POST', headers: H(t), body: JSON.stringify({ columns: ['name', 'gross_salary', 'basic_salary'], filters: [], match: 'all' }) });
  const j = await r.json();
  const grossShown = (j.columns || []).some((c) => c.key === 'gross_salary') && (j.rows || []).some((x) => x.gross_salary != null);
  ok(`${who}: report run shows gross = ${expect}`, grossShown === expect, `${r.status} cols=${(j.columns || []).map((c) => c.key).join(',')}`);
}
console.log(`${pass}/${n}`);
