// Users -> Add New User: a login is an Employee's (picked from those with no
// login) or, for someone who isn't an Employee, needs a reason.
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, tok, body) => { const r = await fetch(B + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { code: r.status, body: j }; };
const login = async (email, password = 'ProbePass123') => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json());
const admin = (await login('admin@credence.test')).token;
const tag = Date.now().toString(36);

let r = await call('POST', '/api/users', admin, { name: `Loose ${tag}`, email: `loose.${tag}@credence.test`, password: 'QaPass#2026x', role: 'user' });
ok(r.code === 400 && /Onboarding/.test(r.body.error), 'a plain login with no employee and no reason is refused, pointing to Onboarding');
r = await call('POST', '/api/users', admin, { name: `Loose ${tag}`, email: `loose.${tag}@credence.test`, password: 'QaPass#2026x', non_employee_reason: 'abc' });
ok(r.code === 400, 'a too-short reason is refused');
r = await call('POST', '/api/users', admin, { name: `Auditor ${tag}`, email: `auditor.${tag}@credence.test`, password: 'QaPass#2026x', non_employee_reason: 'External auditor (KPMG)' });
ok(r.code === 200 && sql(`SELECT non_employee_reason FROM users WHERE id=${r.body.id}`) === 'External auditor (KPMG)', 'a non-employee login with a reason is made and the reason kept');

// an employee with no login
sql(`INSERT INTO all_employees (name, employee_id, designation, department, company_id, is_active) VALUES ('NoLogin ${tag}', 'NL-${tag}', 'Officer', 'MIS', 1, 1)`);
const empId = Number(sql(`SELECT id FROM all_employees WHERE employee_id='NL-${tag}'`));
const list = (await call('GET', '/api/users/employees-without-login', admin)).body;
const row = list.find((x) => x.id === empId);
ok(row && row.employee_id === `NL-${tag}` && row.designation === 'Officer' && row.department === 'MIS', 'employees-without-login lists them with ID, designation, department');
r = await call('POST', '/api/users', admin, { employee_id: empId, password: 'QaPass#2026x', role: 'user' });
ok(r.code === 200 && r.body.username === `NL-${tag}` && r.body.name === `NoLogin ${tag}`, 'login for the employee: name from the record, Login ID = Employee ID');
ok(sql(`SELECT user_id FROM all_employees WHERE id=${empId}`) === String(r.body.id), 'the employee is linked to the new login');
const l = await login(`NL-${tag}`, 'QaPass#2026x');
ok(!!l.token, 'they can sign in with their Employee ID');
ok(!(await call('GET', '/api/users/employees-without-login', admin)).body.some((x) => x.id === empId), 'no longer listed as without login');
r = await call('POST', '/api/users', admin, { employee_id: empId, password: 'QaPass#2026x' });
ok(r.code === 400 && /already has a login/.test(r.body.error), 'a second login for the same employee is refused');
const pu = sql("SELECT email FROM users WHERE email LIKE 'qa.share.rahim%' LIMIT 1");
if (pu) ok((await call('GET', '/api/users/employees-without-login', (await login(pu)).token)).code === 403, 'a plain user cannot list them');
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
