// QA: multi-company isolation. A second company (B) is made in the same
// group; an HR Admin who may enter only company 1 must never see or change
// B's employees, salaries or requests — not even by sending B's id, or B's
// X-Company-Id header.
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
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const has = (body, text) => JSON.stringify(body).includes(text);
const SA = await login('admin@credence.test', 'AdminPass123');

// Company B, with one employee, a salary and a payroll run.
const cb = await api(SA, 'POST', '/api/system/companies', { name: 'Credence Builders Ltd', short_code: 'CBL' });
const B = cb.body.id || cb.body.company?.id || Number(sql("SELECT id FROM companies WHERE short_code='CBL'"));
T('CO-00', !!B, 'Superadmin creates a second company (CBL)', J(cb));
await api(SA, 'PUT', `/api/system/company-access/1`, { company_ids: [1, B], default_company_id: 1 });
const eB = await api(SA, 'POST', '/api/employees', { name: 'Bina Builders', designation: 'Site Engineer', department_id: 1, joining_date: '2024-01-01', email: 'bina.cbl@credence.test' }, B);
const eBid = eB.body.id;
T('CO-01', ok(eB) && sql(`SELECT company_id FROM all_employees WHERE id=${eBid}`) === String(B), 'An employee added while in CBL belongs to CBL', `${J(eB)}; company ${sql(`SELECT company_id FROM all_employees WHERE id=${eBid}`)}`);
await api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: eBid, effective_date: '2026-01-01', basic_salary: 70000, house_rent: 0, medical_allowance: 0, conveyance_allowance: 0 }, B);
const pB = await api(SA, 'POST', '/api/payroll/generate', { employee_id: eBid, month_year: '2026-09', total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0 }, B);
const pBid = pB.body.id;
await api(SA, 'POST', `/api/employees/${eBid}/payment-accounts`, { account_type: 'bank', account_label: 'Salary', bank_name: 'DBBL', account_number: '777000111', percentage: 100 }, B);

// HR Admin of company 1 only.
const hid = (await api(SA, 'POST', '/api/users', { name: 'HR One Company', email: 'hr.one@credence.test', password: 'HrOne#2026', role: 'admin' })).body.id;
await api(SA, 'PUT', `/api/users/${hid}/module-permissions`, { modules: ['employees', 'payroll', 'approvals', 'leave_applications', 'reports'] });
const HR = await login('hr.one@credence.test', 'HrOne#2026');
const mine = await api(HR, 'GET', '/api/companies/mine');
T('CO-02', !has(mine.body, 'Credence Builders'), 'HR of company 1 does not get CBL in the company switcher', JSON.stringify(mine.body).slice(0, 200));

const list1 = await api(HR, 'GET', '/api/employees');
T('CO-03', ok(list1) && !has(list1.body, 'Bina Builders'), 'Employee list (company 1) has no CBL employee', J(list1));
const listB = await api(HR, 'GET', '/api/employees', undefined, B);
T('CO-04', !has(listB.body, 'Bina Builders'), 'Sending CBL\'s X-Company-Id does not open CBL for this HR', J(listB));
const dir = await api(HR, 'GET', '/api/employee-directory');
T('CO-05', !has(dir.body, 'Bina Builders'), 'Employee Directory has no CBL employee', '');
const acc = await api(HR, 'GET', `/api/employees/${eBid}/payment-accounts`);
T('CO-06', !has(acc.body, '777000111'), 'CBL employee\'s bank account cannot be read by id', J(acc));
const ed = await api(HR, 'PUT', `/api/employees/${eBid}`, { name: 'Hacked Name', designation: 'X' });
T('CO-07', !ok(ed) && sql(`SELECT name FROM all_employees WHERE id=${eBid}`) === 'Bina Builders', 'CBL employee cannot be edited by id', `${J(ed)}; name now ${sql(`SELECT name FROM all_employees WHERE id=${eBid}`)}`);
const del = await api(HR, 'DELETE', `/api/employees/${eBid}`);
T('CO-08', !ok(del) && sql(`SELECT COUNT(*) FROM all_employees WHERE id=${eBid}`) === '1', 'CBL employee cannot be deleted by id', J(del));
const pr = await api(HR, 'GET', `/api/payroll/${pBid}`);
T('CO-09', !ok(pr) || !has(pr.body, '70000'), 'CBL salary run cannot be opened by id', J(pr));
const pe = await api(HR, 'PUT', `/api/payroll/${pBid}`, { bonus_amount: 99999 });
T('CO-10', !ok(pe) && Number(sql(`SELECT bonus_amount FROM payrolls WHERE id=${pBid}`)) === 0, 'CBL salary run cannot be changed by id', `${J(pe)}; bonus now ${sql(`SELECT bonus_amount FROM payrolls WHERE id=${pBid}`)}`);
const plist = await api(HR, 'GET', '/api/payroll?month_year=2026-09');
T('CO-11', !has(plist.body, 'Bina Builders') && !has(plist.body, '70000'), 'Payroll list (company 1) has no CBL salary', J(plist));
const gen = await api(HR, 'POST', '/api/payroll/generate', { employee_id: eBid, month_year: '2026-08', total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0 });
T('CO-12', !ok(gen), 'Company 1 HR cannot run payroll for a CBL employee', J(gen));
const struct = await api(HR, 'POST', '/api/payroll/salary-structures', { employee_id: eBid, effective_date: '2026-10-01', basic_salary: 1, house_rent: 0, medical_allowance: 0, conveyance_allowance: 0 });
T('CO-13', !ok(struct), 'Company 1 HR cannot change a CBL employee\'s salary', J(struct));
const sa1 = await api(SA, 'GET', '/api/employees', undefined, 1);
const saB = await api(SA, 'GET', '/api/employees', undefined, B);
T('CO-14', !has(sa1.body, 'Bina Builders') && has(saB.body, 'Bina Builders'), 'Superadmin sees CBL\'s employee only when working in CBL', `in company 1: ${has(sa1.body, 'Bina Builders')}; in CBL: ${has(saB.body, 'Bina Builders')}`);

// The other way round — what must keep working across companies.
await api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
const mk = async (name, email, company) => {
  const e = await api(SA, 'POST', '/api/employees', { name, designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: 'Pass12345' }, company);
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.body.id}`));
  await api(SA, 'PUT', `/api/users/${uid}/leave-application-access`, { can_view_leave_application: true }, company);
  sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${uid}, 10, 14, 0)`);
  return { emp: e.body.id, uid, token: await login(email, 'Pass12345') };
};
// A CBL employee whose Supervisor works in company 1 (e.g. the group's director).
const boss = await mk('Group Director', 'group.dir@credence.test', 1);
const w = await mk('Cross Worker', 'cross.worker@credence.test', B);
// The Admin Panel way: the director is also assigned to CBL, then picked as Supervisor there.
const asgBoss = await api(SA, 'POST', '/api/companies/assignments', { employee_id: boss.emp, company_id: B, start_date: '2024-01-01' }, 1);
const supSet = await api(SA, 'POST', `/api/employees/${w.emp}/supervisors`, { supervisor_id: boss.emp, effective_date: '2024-01-01', is_direct: true }, B);
const outsider = await mk('Not Assigned', 'not.assigned@credence.test', 1);
const supBad = await api(SA, 'POST', `/api/employees/${w.emp}/supervisors`, { supervisor_id: outsider.emp, effective_date: '2024-01-01', is_direct: false }, B);
T('CO-14b', ok(asgBoss) && ok(supSet) && !ok(supBad), 'In CBL the Supervisor can be someone assigned to CBL, not just anyone from company 1', `assign ${asgBoss.status}; set ${supSet.status}; unassigned person ${supBad.status}`);
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const la = await api(w.token, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: day(9), end_date: day(9), purpose: 'cross' });
const q = await api(boss.token, 'GET', '/api/my-approvals');
const row = (Array.isArray(q.body) ? q.body : q.body.items || []).find((r) => r.source_type === 'leave_application' && Number(r.source_id) === Number(la.body.id));
const act = row ? await api(boss.token, 'POST', `/api/my-approvals/${row.id}/act`, { action: 'approved', remarks: 'ok' }) : { status: 0 };
T('CO-15', ok(la) && !!row && ok(act) && sql(`SELECT status FROM leave_applications WHERE id=${la.body.id}`) === 'approved', 'A Supervisor in company 1 still approves a CBL employee\'s leave from My Approvals', `apply ${la.status}; in queue ${!!row}; act ${act.status}; leave ${sql(`SELECT status FROM leave_applications WHERE id=${la.body?.id || 0}`)}`);
// An employee of company 1 also assigned to CBL finds their own leave in either.
const two = await mk('Two Company Person', 'two.co@credence.test', 1);
const asg = await api(SA, 'POST', '/api/companies/assignments', { employee_id: two.emp, company_id: B, start_date: '2024-01-01' }, 1);
await api(SA, 'PUT', `/api/system/company-access/${two.uid}`, { company_ids: [1, B], default_company_id: 1 });
const la2 = await api(two.token, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: day(11), end_date: day(11), purpose: 'two' }, 1);
const mineB = await api(two.token, 'GET', '/api/leave-applications/mine', undefined, B);
T('CO-16', ok(la2) && JSON.stringify(mineB.body).includes(`"id":${la2.body.id}`), 'Someone working in two companies sees their own leave from either', `assignment ${asg.status}; leave ${la2.status}; seen from CBL: ${JSON.stringify(mineB.body).includes(`"id":${la2.body?.id}`)}`);

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'qa-companies.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
