// QA retest: one check per fix in docs/QA-Report-2026-10-25.md §৬.
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3100';
const R = [];
const T = (id, ok, name, detail = '') => { R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + String(detail).slice(0, 260) : ''}`); };
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const J = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;
const ok = (r) => r.status >= 200 && r.status < 300;
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const SA = await login('admin@credence.test', 'AdminPass123');
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

// ---- QA-01 Admin Dashboard parts follow the modules ----
const mkAdmin = async (email, modules) => { const id = (await api(SA, 'POST', '/api/users', { name: email.split('@')[0], email, password: 'QaCheck#2026', role: 'admin' })).body.id; await api(SA, 'PUT', `/api/users/${id}/module-permissions`, { modules }); return login(email, 'QaCheck#2026'); };
const A0 = await mkAdmin('qa.none@credence.test', []);
const AE = await mkAdmin('qa.emp@credence.test', ['employees']);
const e = await api(SA, 'POST', '/api/employees', { name: 'Birthday Person', designation: 'Officer', department_id: 1, joining_date: '2024-01-01', date_of_birth: `1990-${day(2).slice(5)}` });
const x0 = (await api(A0, 'GET', '/api/admin-dashboard/extras')).body;
const xe = (await api(AE, 'GET', '/api/admin-dashboard/extras')).body;
const xs = (await api(SA, 'GET', '/api/admin-dashboard/extras')).body;
T('QA-01a', x0.birthdays?.length === 0 && x0.tasks?.length === 0 && x0.alerts?.length === 0, 'An Admin with no modules gets no birthdays, HR alerts or task counts', JSON.stringify(x0).slice(0, 200));
T('QA-01b', xe.birthdays?.some((b) => b.name === 'Birthday Person') && xe.tasks?.length === 0, 'An Admin with the Employees module sees birthdays, but not other modules\' task counts', JSON.stringify(xe).slice(0, 200));
T('QA-01c', xs.birthdays?.some((b) => b.name === 'Birthday Person') && xs.tasks?.length === 12, 'Superadmin still sees every part', `${xs.birthdays?.length} birthdays, ${xs.tasks?.length} task rows`);

// ---- QA-02 dead Servers code removed ----
T('QA-02', !fs.existsSync('ServerProfileRoutes.ts') && !fs.existsSync('src/components/ServerProfilesPanel.tsx') && !fs.existsSync('src/components/ServerSwitcherModal.tsx'), 'Unused Servers code (calling an API that is not there) is gone');

// ---- QA-04 client mistakes are 4xx, not 500 ----
const long = 'x'.repeat(20000);
const d1 = await api(SA, 'POST', '/api/departments', { name: long });
const d2 = await api(SA, 'POST', '/api/employees', { name: long });
const l1 = await api(SA, 'POST', '/api/hr-ops/letters/preview', {});
const n1 = await api(SA, 'POST', '/api/notices/999999/dismiss', {});
T('QA-04', [d1, d2, l1, n1].every((r) => r.status >= 400 && r.status < 500), 'Too-long name, letter with no employee, unknown notice → 4xx (not 500)', [d1, d2, l1, n1].map((r) => r.status).join(' / '));

// ---- Password rule: any password the person likes (company policy), not empty ----
const simple = ['1234', '111111', 'password', 'a'];
const created = [];
for (const pw of simple) created.push((await api(SA, 'POST', '/api/users', { name: 'Simple', email: `simple.${created.length}@credence.test`, password: pw, role: 'user' })).status);
T('PWD-01', created.every((s) => s >= 200 && s < 300), `Simple passwords are accepted when creating a user (${simple.join(', ')})`, created.join(','));
const empty = await api(SA, 'POST', '/api/users', { name: 'Empty', email: 'empty.pw@credence.test', password: '', role: 'user' });
T('PWD-02', empty.status === 400, 'An empty password is refused', J(empty));
const S1 = await login('simple.0@credence.test', '1234');
T('PWD-03', !!S1, 'The user signs in with the simple password 1234');
const ch = await api(S1, 'PUT', '/api/profile/password', { current_password: '1234', new_password: '1111' });
T('PWD-04', ok(ch) && !!(await login('simple.0@credence.test', '1111')), 'Changing my own password to 1111 works', J(ch));
const el = await api(SA, 'POST', '/api/employees', { name: 'Login Simple', designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email: 'login.simple@credence.test', create_login: true, login_email: 'login.simple@credence.test', login_password: '123' });
const rs = await api(SA, 'PUT', `/api/users/${(await api(SA, 'GET', '/api/users')).body.find((u) => u.email === 'simple.1@credence.test').id}/reset-password`, { new_password: '0000' });
T('PWD-05', ok(el) && ok(rs) && !!(await login('login.simple@credence.test', '123')) && !!(await login('simple.1@credence.test', '0000')), 'Employee login (123) and Admin reset (0000) accept simple passwords too', `${el.status} / ${rs.status}`);

// ---- EMP-02 / EMP-04 email and age ----
const em = await api(SA, 'POST', '/api/employees', { name: 'Bad Mail', designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email: 'not-an-email' });
const kid = await api(SA, 'POST', '/api/employees', { name: 'Too Young', designation: 'Officer', department_id: 1, joining_date: '2024-01-01', date_of_birth: '2015-01-01' });
const fut = await api(SA, 'POST', '/api/employees', { name: 'Future', designation: 'Officer', department_id: 1, joining_date: '2024-01-01', date_of_birth: day(30) });
const okE = await api(SA, 'POST', '/api/employees', { name: 'Fine Person', designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email: 'fine.person@credence.test', date_of_birth: '1994-03-10' });
T('EMP-02', em.status === 400, 'Invalid email refused', J(em));
T('EMP-04', kid.status === 400 && fut.status === 400 && ok(okE), 'Age under 14 and a future birth date refused; a normal record saves', `${kid.status} / ${fut.status} / ${okE.status}`);
sql(`UPDATE all_employees SET email='legacy-bad-mail' WHERE id=${okE.body.id}`);
const list = (await api(SA, 'GET', '/api/employees')).body;
const cur = (Array.isArray(list) ? list : list.employees || []).find((x) => Number(x.id) === Number(okE.body.id));
const ed = await api(SA, 'PUT', `/api/employees/${okE.body.id}`, { ...cur, designation: 'Senior Officer' });
T('EMP-05', ok(ed), 'An old record with a bad email can still be saved for an unrelated change', J(ed));

// ---- R-01 rest: Superadmin's My Approvals lists "no approver" requests ----
await api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
const he = await api(SA, 'POST', '/api/employees', { name: 'Head Nobody', designation: 'Head', department_id: 2, joining_date: '2024-01-01', email: 'head.nobody@credence.test', create_login: true, login_email: 'head.nobody@credence.test', login_password: 'Head2026Ok' });
const huid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${he.body.id}`));
await api(SA, 'PUT', `/api/users/${huid}/leave-application-access`, { can_view_leave_application: true });
sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${huid}, 10, 14, 0)`);
const H = await login('head.nobody@credence.test', 'Head2026Ok');
const la = await api(H, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: day(15), end_date: day(15), purpose: 'QA' });
const q = await api(SA, 'GET', '/api/my-approvals');
const items = Array.isArray(q.body) ? q.body : q.body.items || [];
const row = items.find((r) => r.source_type === 'leave_application' && Number(r.source_id) === Number(la.body.id));
const act = row ? await api(SA, 'POST', `/api/my-approvals/${row.id}/act`, { action: 'approved', remarks: 'OK' }) : { status: 0 };
T('R01-b', !!row && row.no_approver === true && ok(act) && sql(`SELECT status FROM leave_applications WHERE id=${la.body.id}`) === 'approved', 'A "no approver" request is in the Superadmin\'s My Approvals (marked) and can be decided there', `in queue ${!!row}, no_approver=${row?.no_approver}, act ${act.status}`);

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'qa-fixes.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
