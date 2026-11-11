const B = 'http://127.0.0.1:3200';
const login = async (id) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: id, password: 'ProbePass123', workspace: 'credence' }) })).json()).token;
const H = (t) => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });
let pass = 0, n = 0; const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, x); };
const sa = await login('admin@credence.test'), b = await login('payB'), c = await login('payC');
const get = async (t, p) => { const r = await fetch(B + p, { headers: H(t) }); return { s: r.status, j: await r.json().catch(() => null) }; };
const month = (await get(sa, '/api/payroll')).j?.[0]?.month_year;
console.log('month', month);
// 1. list of salaries
const listSa = (await get(sa, '/api/payroll')).j, listB = (await get(b, '/api/payroll')).j, listC = (await get(c, '/api/payroll')).j;
ok('Superadmin sees net salary', typeof listSa[0].net_salary !== 'string' || listSa[0].net_salary !== '*****', String(listSa[0].net_salary));
ok('payB (granted) sees the same net', String(listB[0].net_salary) === String(listSa[0].net_salary));
ok('payC sees ***** for every amount in the list', ['net_salary','gross_salary','basic_salary'].every((k) => !(k in listC[0]) || listC[0][k] === '*****'), JSON.stringify({ net: listC[0].net_salary, gross: listC[0].gross_salary, basic: listC[0].basic_salary }));
ok('payC still sees who / which month / ids', listC[0].id === listSa[0].id && listC[0].month_year === listSa[0].month_year && listC[0].employee_name === listSa[0].employee_name);
// 2. no number leaks anywhere in payC answers (except safe keys) — scan several endpoints
const leaks = [];
for (const p of ['/api/payroll', '/api/payroll/salary-structures', '/api/payroll/advances', '/api/payroll/pending-bonuses', '/api/payroll/dashboard-summary', `/api/payroll/approval/${month}`, `/api/payroll/approval/${month}/salary-sheet`, `/api/payroll/approval/${month}/top-sheet`, `/api/payroll/approval/${month}/compare`, '/api/payroll/pay-items', '/api/payroll/adjustments']) {
  const a = await get(sa, p), z = await get(c, p);
  if (z.s !== 200) { console.log('  (payC', z.s, p, ')'); continue; }
  const saNums = new Set(); (function walk(v) { if (v && typeof v === 'object') Object.values(v).forEach(walk); else if ((typeof v === 'number' || (typeof v === 'string' && /^-?\d+\.\d+$/.test(v))) && Math.abs(Number(v)) >= 1000) saNums.add(String(Number(v))); })(a.j);
  (function walk(v, k) { if (v && typeof v === 'object') Object.entries(v).forEach(([kk, vv]) => walk(vv, kk)); else if ((typeof v === 'number' || typeof v === 'string') && saNums.has(String(Number(v))) && v !== '') leaks.push(`${p} ${k}=${v}`); })(z.j);
}
ok('no salary-sized number from Superadmin\'s answers shows up in payC\'s', leaks.length === 0, leaks.slice(0, 8).join(' | '));
// 3. writes refused
const w = await fetch(B + '/api/payroll/salary-structures', { method: 'POST', headers: H(c), body: JSON.stringify({}) });
ok('payC cannot change salary structures', w.status === 403, String(w.status));
const w2 = await fetch(B + `/api/payroll/${listSa[0].id}`, { method: 'PUT', headers: H(c), body: JSON.stringify({ remarks: 'x' }) });
ok('payC cannot edit a salary', w2.status === 403, String(w2.status));
const al = await fetch(B + '/api/payroll/access-log', { method: 'POST', headers: H(c), body: JSON.stringify({ page: 'test' }) });
ok('payC page-visit log still allowed', al.status !== 403, String(al.status));
// 4. approval-access tells the UI
const acc = (await get(c, '/api/payroll/approval-access')).j;
ok('approval-access: salary_amounts false, edit false', acc.salary_amounts === false && acc.edit === false, JSON.stringify(acc));
ok('approval-access for payB: salary_amounts true', (await get(b, '/api/payroll/approval-access')).j.salary_amounts === true);
console.log(`${pass}/${n}`);
