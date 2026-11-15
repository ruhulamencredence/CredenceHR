const B = 'http://127.0.0.1:3200';
const login = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123', workspace: 'credence' }) })).json();
const tok = login.token; if (!tok) { console.log('login failed', login); process.exit(1); }
const imp = async (rows) => (await fetch(B + '/api/data-import/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ rows, dry_run: true }) })).json();
const cases = [
  ['normal login, same person -> linked', { employee_id: 'relink01', name: 'Md. Rahim Uddin' }, (r) => r.status === 'create' && /linked to the existing login/.test(r.message)],
  ['normal login, other name -> refused', { employee_id: 'relink01', name: 'Karim Hossain' }, (r) => r.status === 'error'],
  ['Superadmin login -> refused', { employee_id: 'admin@credence.test', name: 'System Admin' }, (r) => r.status === 'error' && !/linked/.test(r.message)],
  ['Admin login -> refused', { employee_id: 'roster.hr@credence.test', name: 'Rumana Islam' }, (r) => r.status === 'error' && !/linked/.test(r.message)],
];
let pass = 0;
for (const [label, row, ok] of cases) {
  const out = await imp([{ ...row, department: 'HR' }]);
  const r = out.results?.[0] || out;
  const good = ok(r); pass += good;
  console.log(good ? 'PASS' : 'FAIL', label, '—', r.status, r.message || r.error);
}
console.log(`${pass}/${cases.length}`);
