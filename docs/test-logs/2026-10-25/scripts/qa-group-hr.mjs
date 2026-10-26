// QA: the mother company's HR also works as HR of a sister company. The
// Superadmin gives that HR access to the sister company (company switcher)
// and its modules there; the HR then switches to it and does the sister
// company's HR work — employees, bank accounts, salaries, payroll, leave.
// Someone without that access (qa-companies.mjs) still can't.
// Then "All companies" mode (GH-10..): with the Superadmin's extra tick the
// same HR opens and changes both companies' employee records from one place,
// without switching; without the tick the X-Company-Scope header does nothing.
// Usage: node qa-group-hr.mjs <out.json>
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3100';
const R = [];
const T = (id, ok, name, detail = '') => { R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 400) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + String(detail).slice(0, 300) : ''}`); };
async function api(t, m, p, b, company, scope) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...(company ? { 'x-company-id': String(company) } : {}), ...(scope ? { 'x-company-scope': scope } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
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

// ---- All companies mode -----------------------------------------------------
const ALL = (t, m, p, b) => api(t, m, p, b, 1, 'all');
// Without the permission the header changes nothing.
const noPerm = await ALL(HR, 'GET', '/api/employees');
const noPermAcc = await ALL(HR, 'GET', `/api/employees/${eBid}/payment-accounts`);
const mineNo = await ALL(HR, 'GET', '/api/companies/mine');
T('GH-10', !has(noPerm.body, 'Bina Builders') && !has(noPermAcc.body, '777000111') && mineNo.body.can_work_all_companies === false && mineNo.body.all_companies === false, 'Without the permission, "All companies" does nothing (no switcher entry, CBL stays out)', `${J(noPerm)}; mine ${JSON.stringify(mineNo.body).slice(0, 120)}`);
const offByOther = await api(HR, 'PUT', `/api/system/company-access/${hid}/all-companies`, { enabled: true });
T('GH-11', !ok(offByOther), 'HR cannot give themselves the permission (Superadmin only)', J(offByOther));

const grant = await api(SA, 'PUT', `/api/system/company-access/${hid}/all-companies`, { enabled: true });
const audit = sql(`SELECT COUNT(*) FROM user_access_audit WHERE target_user_id=${hid} AND action='all_companies'`);
const mineYes = await ALL(HR, 'GET', '/api/companies/mine');
T('GH-12', ok(grant) && mineYes.body.can_work_all_companies === true && mineYes.body.all_companies === true && Number(audit) >= 1, 'Superadmin ticks it: the switcher offers All companies, the change is in the access audit', `${J(grant)}; audit ${audit}`);
// A mother-company employee to see alongside the CBL one.
const eA = await api(SA, 'POST', '/api/employees', { name: 'Arif Mother', designation: 'Accountant', department_id: 1, joining_date: '2024-01-01', email: 'arif.mother@credence.test' }, 1);
const both = await ALL(HR, 'GET', '/api/employees');
T('GH-13', ok(both) && has(both.body, 'Bina Builders') && has(both.body, 'Arif Mother'), 'All companies: one list has the mother company\'s and CBL\'s employees', J(both));
const accAll = await ALL(HR, 'GET', `/api/employees/${eBid}/payment-accounts`);
T('GH-14', has(accAll.body, '777000111'), 'All companies: opens a CBL employee\'s bank account without switching', J(accAll));
const edAll = await ALL(HR, 'PUT', `/api/employees/${eBid}`, { name: 'Bina Builders', designation: 'Project Engineer' });
T('GH-15', ok(edAll) && sql(`SELECT designation FROM all_employees WHERE id=${eBid}`) === 'Project Engineer', 'All companies: changes a CBL employee without switching', J(edAll));
const edA = await ALL(HR, 'PUT', `/api/employees/${eA.body.id}`, { name: 'Arif Mother', designation: 'Senior Accountant' });
T('GH-16', ok(edA) && sql(`SELECT designation FROM all_employees WHERE id=${eA.body.id}`) === 'Senior Accountant', 'All companies: changes a mother-company employee in the same place', J(edA));
const newE = await ALL(HR, 'POST', '/api/employees', { name: 'New In All Mode', designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email: 'new.allmode@credence.test' });
T('GH-17', ok(newE) && sql(`SELECT company_id FROM all_employees WHERE id=${newE.body.id || 0}`) === '1', 'All companies: a new employee goes to the company chosen in the switcher (mother)', `${J(newE)}; company ${sql(`SELECT company_id FROM all_employees WHERE id=${newE.body.id || 0}`)}`);
const genAll = await ALL(HR, 'POST', '/api/payroll/generate', { employee_id: eBid, month_year: '2026-08', total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0 });
T('GH-18', !ok(genAll), 'All companies: payroll is still run per company (CBL\'s salary is run in CBL)', J(genAll));
// The usual way still works next to it.
const one = await api(HR, 'GET', '/api/employees', undefined, B);
T('GH-19', ok(one) && has(one.body, 'Bina Builders') && !has(one.body, 'Arif Mother'), 'Picking one company still shows just that company', J(one));
// An account allowed only company 1 gets nothing more from the mode.
const oid = (await api(SA, 'POST', '/api/users', { name: 'One Co HR', email: 'oneco.hr@credence.test', password: 'easy', role: 'admin' })).body.id;
await api(SA, 'PUT', `/api/users/${oid}/module-permissions`, { modules: MODS }, 1);
sql(`UPDATE users SET can_work_all_companies = 1 WHERE id = ${oid}`);
const O = await login('oneco.hr@credence.test', 'easy');
const oneOnly = await ALL(O, 'GET', '/api/employees');
T('GH-20', ok(oneOnly) && !has(oneOnly.body, 'Bina Builders'), 'The mode only spans companies the account may enter (company 1 only → no CBL)', J(oneOnly));
const revoke = await api(SA, 'PUT', `/api/system/company-access/${hid}/all-companies`, { enabled: false });
const after = await ALL(HR, 'GET', '/api/employees');
T('GH-21', ok(revoke) && !has(after.body, 'Bina Builders'), 'Superadmin unticks it: back to one company at a time straight away', J(after));

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'qa-group-hr.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
