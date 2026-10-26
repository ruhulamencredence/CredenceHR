// QA: the mother company's HR also works as HR of a sister company. The
// Superadmin gives that HR access to the sister company (company switcher)
// and its modules there; the HR then switches to it and does the sister
// company's HR work — employees, bank accounts, salaries, payroll, leave.
// Someone without that access (qa-companies.mjs) still can't.
// Usage: node qa-group-hr.mjs <out.json>
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3100';
const R = [];
const T = (id, ok, name, detail = '') => { R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 400) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + String(detail).slice(0, 300) : ''}`); };
async function api(t, m, p, b, company) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...(company ? { 'x-company-id': String(company) } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const ok = (r) => r.status >= 200 && r.status < 300;
const J = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const has = (body, text) => JSON.stringify(body).includes(text);
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const SA = await login('admin@credence.test', 'AdminPass123');

// Sister company with an employee.
const cb = await api(SA, 'POST', '/api/system/companies', { name: 'Credence Builders Ltd', short_code: 'CBL' });
const B = cb.body.id || cb.body.company?.id || Number(sql("SELECT id FROM companies WHERE short_code='CBL'"));
const eB = await api(SA, 'POST', '/api/employees', { name: 'Bina Builders', designation: 'Site Engineer', department_id: 1, joining_date: '2024-01-01', email: 'bina.cbl@credence.test' }, B);
const eBid = eB.body.id;

// Mother-company HR, given the sister company too (Admin Panel -> Users ->
// Company access, and Module Access in each company).
const MODS = ['employees', 'payroll', 'approvals', 'leave_applications', 'reports'];
const hid = (await api(SA, 'POST', '/api/users', { name: 'Group HR', email: 'group.hr@credence.test', password: 'easy', role: 'admin' })).body.id;
const acc = await api(SA, 'PUT', `/api/system/company-access/${hid}`, { company_ids: [1, B], default_company_id: 1 });
await api(SA, 'PUT', `/api/users/${hid}/module-permissions`, { modules: MODS }, 1);
const modB = await api(SA, 'PUT', `/api/users/${hid}/module-permissions`, { modules: MODS }, B);
const HR = await login('group.hr@credence.test', 'easy');
const mine = await api(HR, 'GET', '/api/companies/mine');
T('GH-01', ok(acc) && ok(modB) && has(mine.body, 'Credence Builders'), 'Group HR has the sister company in the company switcher', `access ${acc.status}; modules ${modB.status}; ${JSON.stringify(mine.body).slice(0, 160)}`);

// Working in the sister company.
const list = await api(HR, 'GET', '/api/employees', undefined, B);
T('GH-02', ok(list) && has(list.body, 'Bina Builders'), 'In CBL: sees CBL\'s employees', J(list));
const ed = await api(HR, 'PUT', `/api/employees/${eBid}`, { name: 'Bina Builders', designation: 'Senior Site Engineer' }, B);
T('GH-03', ok(ed) && sql(`SELECT designation FROM all_employees WHERE id=${eBid}`) === 'Senior Site Engineer', 'In CBL: edits a CBL employee', J(ed));
const pa = await api(HR, 'POST', `/api/employees/${eBid}/payment-accounts`, { account_type: 'bank', account_label: 'Salary', bank_name: 'DBBL', account_number: '777000111', percentage: 100 }, B);
const pr = await api(HR, 'GET', `/api/employees/${eBid}/payment-accounts`, undefined, B);
T('GH-04', ok(pa) && has(pr.body, '777000111'), 'In CBL: adds and reads the bank account', `${J(pa)} / ${J(pr)}`);
const ss = await api(HR, 'POST', '/api/payroll/salary-structures', { employee_id: eBid, effective_date: '2026-01-01', basic_salary: 70000, house_rent: 0, medical_allowance: 0, conveyance_allowance: 0 }, B);
T('GH-05', ok(ss), 'In CBL: sets the salary', J(ss));
const gen = await api(HR, 'POST', '/api/payroll/generate', { employee_id: eBid, month_year: '2026-09', total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0 }, B);
const run = await api(HR, 'GET', `/api/payroll/${gen.body.id}`, undefined, B);
T('GH-06', ok(gen) && ok(run) && has(run.body, 'Bina Builders'), 'In CBL: runs and opens the payroll', `${J(gen)} / ${run.status}`);
const plist = await api(HR, 'GET', '/api/payroll?month_year=2026-09', undefined, B);
T('GH-07', has(plist.body, 'Bina Builders'), 'In CBL: the payroll list has the CBL salary', J(plist));

// Back in the mother company: its own work only (switch to CBL for CBL's).
const l1 = await api(HR, 'GET', '/api/employees', undefined, 1);
T('GH-08', ok(l1) && !has(l1.body, 'Bina Builders'), 'In the mother company: the list shows the mother company\'s employees', J(l1));
const byId = await api(HR, 'GET', `/api/employees/${eBid}/payment-accounts`, undefined, 1);
T('GH-09', !has(byId.body, '777000111'), 'In the mother company: a CBL record opened by id is not shown (switch to CBL for it)', J(byId));

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'qa-group-hr.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
