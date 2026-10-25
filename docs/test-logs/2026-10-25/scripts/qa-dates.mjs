// QA: dates at the edges — month and year ends, 29 February, impossible
// dates, times around midnight, age boundaries and the Dhaka "today".
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3100';
const R = [];
const T = (id, ok, name, detail = '') => { R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 400) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + String(detail).slice(0, 300) : ''}`); };
const INFO = (id, name, detail) => { R.push({ id, status: 'INFO', name, detail: String(detail).slice(0, 400) }); console.log(`INFO ${id} ${name}  — ${String(detail).slice(0, 300)}`); };
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const ok = (r) => r.status >= 200 && r.status < 300;
const J = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const dhaka = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const day = (n) => dhaka(new Date(Date.now() + n * 864e5));
const SA = await login('admin@credence.test', 'AdminPass123');

await api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
const proj = await api(SA, 'POST', '/api/projects', { project_name: 'Head Office', location_lat: 23.78, location_lng: 90.4, location_radius: 200 });
const e = await api(SA, 'POST', '/api/employees', { name: 'Date Person', designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email: 'date.person@credence.test', create_login: true, login_email: 'date.person@credence.test', login_password: 'Pass12345' });
const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.body.id}`));
for (const [route, col] of [['leave-application-access', 'can_view_leave_application'], ['timesheet-access', 'can_view_timesheet'], ['conveyance-claim-access', 'can_view_conveyance_claims']]) await api(SA, 'PUT', `/api/users/${uid}/${route}`, { [col]: true });
await api(SA, 'PUT', `/api/users/${uid}/feature-permissions`, { can_use_attendance: true });
sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${uid}, 30, 30, 0)`);
const P = await login('date.person@credence.test', 'Pass12345');
const leave = (s, en, extra = {}) => api(P, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: s, end_date: en, purpose: 'dates', ...extra });
const y = Number(day(0).slice(0, 4)) + 1;

// Leave
const l1 = await leave(`${y}-01-30`, `${y}-02-02`);
T('DT-01', ok(l1) && Number(l1.body.day_count) === 4, `Leave across a month end (${y}-01-30 → 02-02) counts 4 days`, J(l1));
const l2 = await leave(`${y}-12-30`, `${y + 1}-01-02`);
INFO('DT-02', `Leave across a year end (${y}-12-30 → ${y + 1}-01-02)`, `${J(l2)} — the whole 4 days come off this year's balance (there is one balance row, no split by leave year)`);
const leap = [2028, 2032, 2036].find((v) => v > Number(day(0).slice(0, 4)));
const l3 = await leave(`${leap}-02-29`, `${leap}-02-29`);
T('DT-03', ok(l3) && Number(l3.body.day_count) === 1, `Leave on 29 Feb ${leap} (leap year) is accepted, 1 day`, J(l3));
const l4 = await leave(`${y === leap ? y + 1 : y}-02-29`, `${y === leap ? y + 1 : y}-02-29`);
T('DT-04', !ok(l4), `Leave on 29 Feb of a non-leap year is refused`, J(l4));
const l5 = await leave(`${y}-03-10`, `${y}-03-05`);
T('DT-05', !ok(l5), 'Leave ending before it starts is refused', J(l5));
const l6 = await leave(`${y}-04-31`, `${y}-04-31`);
T('DT-06', !ok(l6), '31 April (does not exist) is refused', J(l6));
const l7 = await leave(day(-40), day(-40));
INFO('DT-07', 'Back-dated leave (40 days ago) with advance notice set to 0', J(l7));

// Payroll
await api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: e.body.id, effective_date: '2024-01-01', basic_salary: 29000, house_rent: 0, medical_allowance: 0, conveyance_allowance: 0 });
const pf = await api(SA, 'POST', '/api/payroll/generate', { employee_id: e.body.id, month_year: `${leap}-02`, total_working_days: 29, present_days: 29, leave_days: 0, absent_days: 0 });
const net = Number(sql(`SELECT net_salary FROM payrolls WHERE employee_id=${e.body.id} AND month_year='${leap}-02'`) || 0);
T('DT-08', ok(pf) && net === 29000, `February ${leap} (29 days) fully present pays the full 29,000`, `${J(pf)}; net ${net}`);
const pa = await api(SA, 'POST', '/api/payroll/generate', { employee_id: e.body.id, month_year: `${leap}-03`, total_working_days: 31, present_days: 30, leave_days: 0, absent_days: 1 });
const net2 = Number(sql(`SELECT net_salary FROM payrolls WHERE employee_id=${e.body.id} AND month_year='${leap}-03'`) || 0);
T('DT-09', ok(pa) && Math.abs(net2 - Math.round(29000 * 30 / 31 * 100) / 100) < 1.01, 'One absent day in a 31-day month takes 1/31 of the salary', `${J(pa)}; net ${net2}, expected ≈ ${(29000 * 30 / 31).toFixed(2)}`);
for (const m of ['2026-13', '2026-00', '26-09', '2026-9']) {
  const bad = await api(SA, 'POST', '/api/payroll/generate', { employee_id: e.body.id, month_year: m, total_working_days: 26, present_days: 26 });
  if (ok(bad)) { T('DT-10', false, 'Impossible months are refused', `${m} accepted`); break; }
}
if (!R.some((r) => r.id === 'DT-10')) T('DT-10', true, 'Impossible months (2026-13, 2026-00, 26-09, 2026-9) are refused');

// Timesheet correction around midnight
const corr = (d, ci, co) => api(P, 'POST', '/api/attendance/corrections', { project_id: proj.body.id, attendance_date: d, check_in_at: ci, check_out_at: co, remarks: 'dates' });
const c1 = await corr(day(-3), `${day(-3)} 22:00:00`, `${day(-2)} 06:00:00`);
T('DT-11', ok(c1), 'Night shift: in 22:00, out 06:00 the next morning is accepted', J(c1));
const c2 = await corr(day(-4), `${day(-4)} 18:00:00`, `${day(-4)} 09:00:00`);
T('DT-12', !ok(c2), 'Out Time earlier than In Time on the same day is refused', J(c2));
const c3 = await corr(day(-5), `${day(-9)} 09:00:00`, `${day(-9)} 18:00:00`);
T('DT-13', !ok(c3), 'In/Out times on a different date than the day being corrected are refused', J(c3));
const c5 = await api(P, 'POST', '/api/attendance/corrections', { project_id: proj.body.id, attendance_date: day(-6), check_in_at: `${day(-6)} 25:00:00`, remarks: 'dates' });
T('DT-13b', !ok(c5), 'An In Time of 25:00 is refused', J(c5));
const c4 = await corr(day(1), `${day(1)} 09:00:00`, `${day(1)} 18:00:00`);
T('DT-14', !ok(c4), 'A correction for tomorrow (Dhaka date) is refused', J(c4));

// Ages and "today"
const ageDob = (years, extraDays) => { const d = new Date(`${day(0)}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - years); d.setUTCDate(d.getUTCDate() + extraDays); return d.toISOString().slice(0, 10); };
const a14 = await api(SA, 'POST', '/api/employees', { name: 'Exactly Fourteen', designation: 'Helper', department_id: 1, joining_date: '2024-01-01', date_of_birth: ageDob(14, 0) });
const a13 = await api(SA, 'POST', '/api/employees', { name: 'One Day Short', designation: 'Helper', department_id: 1, joining_date: '2024-01-01', date_of_birth: ageDob(14, 1) });
T('DT-15', ok(a14) && !ok(a13), 'Turning 14 today is allowed; one day short of 14 is refused', `${a14.status} / ${a13.status}`);
const cats = (await api(P, 'GET', '/api/bill-claim-categories')).body;
const cat = (Array.isArray(cats) ? cats : cats.categories || [])[0];
const cl = await api(P, 'POST', '/api/user-claims', { from_date: day(0), to_date: day(0), items: [{ category_id: cat?.id, bill_date: day(0), amount: 100, description: 'dates' }], description: 'dates' });
const cd = sql(`SELECT DATE_FORMAT(claim_date,'%Y-%m-%d') FROM user_claims WHERE id=${cl.body.id || 0}`);
T('DT-16', ok(cl) && cd === day(0), `A claim filed now is dated with the Dhaka date (${day(0)}), whatever the server clock's zone`, `${J(cl)}; claim_date ${cd}; server UTC date ${new Date().toISOString().slice(0, 10)}`);
const fb = await api(P, 'POST', '/api/user-claims', { from_date: day(0), to_date: day(0), items: [{ category_id: cat?.id, bill_date: day(3), amount: 100, description: 'future bill' }], description: 'future' });
INFO('DT-17', 'A bill line dated 3 days in the future (claim for today already filed, so this also meets one-claim-a-day)', J(fb));

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length, INFO: R.filter((r) => r.status === 'INFO').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'qa-dates.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
