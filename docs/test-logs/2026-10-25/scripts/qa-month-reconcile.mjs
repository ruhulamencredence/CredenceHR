// QA: one month's attendance, leave and salary checked against a separate,
// hand-written calculation — the way HR would check it in Excel.
//
// September 2026 (30 days; Fridays are the weekend, 16 Sep a holiday, so 25
// working days). Ten employees, each with one thing to check: perfect month,
// absent days, casual leave, leave without pay, lates, an extreme late, leave
// across a weekend, work on a Friday / holiday, an advance with tax and PF.
// Attendance goes in as check-in rows, leave through the app (apply, then
// approve), payroll through the same two calls the Run Payroll wizard makes.
// Everything the app says is compared with the expected figure worked out
// here from the company rules, and both go into an Excel workbook whose
// "Summary" sheet recomputes the expected salary with formulas — HR can type
// their own month's figures into it to check the app the same way.
//
// Usage: node qa-month-reconcile.mjs <out-dir>
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const XLSX = createRequire(import.meta.url)('../../../../node_modules/xlsx');
const BASE = process.env.BASE || 'http://localhost:3100';
const OUT = process.argv[2] || 'reconcile-out';
fs.mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const ok = (r) => r.status >= 200 && r.status < 300;
const R = [];
const T = (id, pass, name, detail = '') => { R.push({ id, status: pass ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 500) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${!pass && detail ? '  — ' + String(detail).slice(0, 400) : ''}`); };
const INFO = (id, name, detail) => { R.push({ id, status: 'INFO', name, detail }); console.log(`INFO ${id} ${name}  — ${detail}`); };
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const SA = await login('admin@credence.test', 'AdminPass123');

// ---- The month and its rules ---------------------------------------------
const MONTH = '2026-09';
const days = Array.from({ length: 30 }, (_, i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`);
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const FRIDAYS = days.filter((d) => weekday(d) === 5);
const HOLIDAY = '2026-09-16';
const offDay = (d) => FRIDAYS.includes(d) || d === HOLIDAY;
const WORKING = days.filter((d) => !offDay(d));
const RULE = { start: '09:00', grace: 10, latesPerDay: 3, extremeGrace: 60, extremePerDay: 1 };

await api(SA, 'POST', '/api/holidays/bulk-weekly', { from: `${MONTH}-01`, to: `${MONTH}-30`, weekday: 5, title: 'Weekend', applies_to: 'head_office' });
await api(SA, 'POST', '/api/holidays', { entry_date: HOLIDAY, day_type: 'holiday', title: 'Public holiday', applies_to: 'head_office' });
await api(SA, 'POST', '/api/payroll/late-policy', { shift_start_time: RULE.start, grace_minutes: RULE.grace, lates_per_deduction_day: RULE.latesPerDay, extreme_grace_minutes: RULE.extremeGrace, extreme_lates_per_deduction_day: RULE.extremePerDay, effective_date: '2026-01-01' });
await api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
await api(SA, 'PUT', '/api/leave-policies/without_pay', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
const proj = await api(SA, 'POST', '/api/projects', { project_name: 'Head Office', location_lat: 23.78, location_lng: 90.4, location_radius: 200 });
const projectId = proj.body.id || Number(sql("SELECT id FROM projects WHERE project_name='Head Office' LIMIT 1"));

// ---- Ten people, one case each ---------------------------------------------
// times: date -> check-in "HH:MM" (missing = no attendance); leave: [type, from, to]
const everyDay = (t = '08:55') => Object.fromEntries(WORKING.map((d) => [d, t]));
const without = (obj, list) => Object.fromEntries(Object.entries(obj).filter(([d]) => !list.includes(d)));
const CASES = [
  { key: 'perfect', name: 'Rec Perfect', basic: 30000, times: everyDay(), what: 'present every working day' },
  { key: 'absent', name: 'Rec Absent', basic: 25000, times: without(everyDay(), ['2026-09-07', '2026-09-08', '2026-09-09']), what: '3 days absent (7–9 Sep)' },
  { key: 'casual', name: 'Rec Casual', basic: 28000, times: without(everyDay(), ['2026-09-14', '2026-09-15']), leave: ['casual', '2026-09-14', '2026-09-15'], what: 'casual leave 14–15 Sep' },
  { key: 'lwp', name: 'Rec Unpaid', basic: 22000, times: without(everyDay(), ['2026-09-21', '2026-09-22']), leave: ['without_pay', '2026-09-21', '2026-09-22'], what: 'leave without pay 21–22 Sep' },
  { key: 'late4', name: 'Rec Late', basic: 26000, times: { ...everyDay(), '2026-09-01': '09:15', '2026-09-02': '09:20', '2026-09-03': '09:25', '2026-09-06': '09:40' }, what: '4 lates (3 lates = 1 day cut)' },
  { key: 'extreme', name: 'Rec Extreme', basic: 27000, times: { ...everyDay(), '2026-09-10': '10:30', '2026-09-01': '09:20', '2026-09-02': '09:20' }, what: '1 extreme late (10:30) + 2 lates' },
  { key: 'weekendLeave', name: 'Rec Over Weekend', basic: 24000, times: without(everyDay(), ['2026-09-17', '2026-09-19']), leave: ['casual', '2026-09-17', '2026-09-19'], what: 'casual leave Thu 17 – Sat 19 Sep (Friday in between)' },
  { key: 'offDayWork', name: 'Rec Friday Work', basic: 23000, times: { ...everyDay(), '2026-09-11': '09:00', [HOLIDAY]: '09:00' }, what: 'also worked Friday 11 Sep and the holiday' },
  { key: 'advance', name: 'Rec Advance', basic: 40000, tax: 500, pf: 1000, advance: { total: 10000, monthly: 2000 }, times: everyDay(), what: 'advance 2,000/month, tax 500, PF 1,000' },
  { key: 'absentLate', name: 'Rec Mixed', basic: 32000, times: { ...without(everyDay(), ['2026-09-29']), '2026-09-02': '09:12', '2026-09-03': '09:12', '2026-09-06': '09:12' }, what: '1 absent day + 3 lates' }
];
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const START = toMin(RULE.start);
for (const c of CASES) {
  const email = `${c.key.toLowerCase()}@rec.test`;
  const e = await api(SA, 'POST', '/api/employees', { name: c.name, designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: 'easy' });
  c.empId = e.body.id;
  c.uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${c.empId}`));
  await api(SA, 'PUT', `/api/users/${c.uid}/leave-application-access`, { can_view_leave_application: true });
  sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${c.uid}, 10, 14, 10)`);
  const house = c.basic / 2;
  await api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: c.empId, effective_date: '2024-01-01', basic_salary: c.basic, house_rent: house, medical_allowance: 1500, conveyance_allowance: 1000, tax_deduction: c.tax || 0, pf_deduction: c.pf || 0 });
  if (c.advance) await api(SA, 'POST', '/api/payroll/advances', { employee_id: c.empId, total_amount: c.advance.total, monthly_installment: c.advance.monthly, reason: 'reconciliation' });
  const rows = Object.entries(c.times).map(([d, t]) => `(${c.uid}, ${projectId}, '${d}', '${d} ${t}:00', '${d} 18:00:00')`);
  if (rows.length) sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_out_at) VALUES ${rows.join(',')}`);
  if (c.leave) {
    const tok = await login(email, 'easy');
    const la = await api(tok, 'POST', '/api/leave-applications', { leave_type: c.leave[0], start_date: c.leave[1], end_date: c.leave[2], purpose: 'reconciliation' });
    c.leaveId = la.body.id;
    c.leaveDayCount = Number(la.body.day_count);
    // No Supervisor / Template: it waits for the Superadmin (My Approvals).
    const q = await api(SA, 'GET', '/api/my-approvals');
    const item = (Array.isArray(q.body) ? q.body : q.body.items || []).find((r) => r.source_type === 'leave_application' && Number(r.source_id) === Number(la.body.id));
    const act = item ? await api(SA, 'POST', `/api/my-approvals/${item.id}/act`, { action: 'approved', remarks: 'ok' }) : null;
    if (!ok(la) || !act || !ok(act)) console.log('leave setup problem', c.key, la.status, la.body, act && act.status);
  }
  // ---- Expected, by hand ----
  const present = WORKING.filter((d) => c.times[d]).length;
  const leaveDays = c.leave ? WORKING.filter((d) => d >= c.leave[1] && d <= c.leave[2] && !c.times[d]).length : 0;
  const paidLeave = c.leave && c.leave[0] !== 'without_pay' ? leaveDays : 0;
  const lwp = c.leave && c.leave[0] === 'without_pay' ? leaveDays : 0;
  const absent = WORKING.length - present - paidLeave - lwp;
  let lates = 0;
  let extremes = 0;
  for (const d of WORKING) {
    const t = c.times[d];
    if (!t) continue;
    const m = toMin(t);
    if (m > START + RULE.extremeGrace) extremes++;
    else if (m > START + RULE.grace) lates++;
  }
  const lateDays = Math.floor(lates / RULE.latesPerDay) + Math.floor(extremes / RULE.extremePerDay);
  const gross = c.basic + c.basic / 2 + 1500 + 1000;
  const perDay = gross / WORKING.length;
  const cut = Math.round(perDay * (absent + lwp + lateDays) * 100) / 100;
  const deductions = cut + (c.tax || 0) + (c.pf || 0) + (c.advance ? Math.min(c.advance.monthly, c.advance.total) : 0);
  c.expected = { working: WORKING.length, present, absent, leave: paidLeave, lwp, lates, extremes, lateDays, gross, perDay, cut, net: Math.round((gross - deductions) * 100) / 100 };
}

// ---- What the app says: the wizard's two calls ------------------------------
const sum = await api(SA, 'GET', `/api/payroll/wizard/attendance-summary?month_year=${MONTH}`);
const byEmp = new Map((sum.body.employees || []).map((r) => [Number(r.employee_id), r]));
const rows = CASES.map((c) => {
  const r = byEmp.get(Number(c.empId));
  return { employee_id: c.empId, total_working_days: r.total_working_days, present_days: r.present_days, absent_days: r.absent_days, leave_days: r.leave_days, lwp_days: r.lwp_days, late_count: r.late_count + r.extreme_late_count, late_deduction_days: r.late_deduction_days + r.extreme_late_deduction_days, overtime_hours: 0, bonus_amount: 0, other_deduction: 0 };
});
const bulk = await api(SA, 'POST', '/api/payroll/generate-bulk', { month_year: MONTH, employees: rows });
T('REC-00', ok(sum) && ok(bulk) && (bulk.body.results || []).every((x) => x.success), `The app runs ${MONTH} payroll for all ${CASES.length}`, `${sum.status}/${bulk.status} ${JSON.stringify((bulk.body.results || []).filter((x) => !x.success)).slice(0, 200)}`);

const sheetRows = [];
let n = 0;
for (const c of CASES) {
  n++;
  const r = byEmp.get(Number(c.empId)) || {};
  const p = (sql(`SELECT total_working_days, present_days, absent_days, leave_days, lwp_days, late_deduction_days, gross_earned, absent_deduction, tax_deduction, pf_deduction, advance_deduction, net_salary FROM payrolls WHERE employee_id=${c.empId} AND month_year='${MONTH}'`) || '').split('\t').map(Number);
  const [wd, pr, ab, lv, lw, ld, gross, cut, tax, pf, adv, net] = p;
  const e = c.expected;
  const appDays = { working: r.total_working_days, present: r.present_days, absent: r.absent_days, leave: r.leave_days, lwp: r.lwp_days, lates: r.late_count, extremes: r.extreme_late_count, lateDays: (r.late_deduction_days || 0) + (r.extreme_late_deduction_days || 0) };
  const daysOk = ['working', 'present', 'absent', 'leave', 'lwp', 'lates', 'extremes', 'lateDays'].every((k) => Number(appDays[k]) === e[k]);
  T(`REC-${String(n).padStart(2, '0')}a`, daysOk, `${c.name} (${c.what}): attendance counts match`, `app ${JSON.stringify(appDays)} vs expected ${JSON.stringify({ working: e.working, present: e.present, absent: e.absent, leave: e.leave, lwp: e.lwp, lates: e.lates, extremes: e.extremes, lateDays: e.lateDays })}`);
  T(`REC-${String(n).padStart(2, '0')}b`, Math.abs(net - e.net) < 0.02 && Math.abs(gross - e.gross) < 0.02, `${c.name}: net salary ${e.net.toLocaleString('en-IN')} matches`, `app gross ${gross}, cut ${cut}, tax ${tax}, pf ${pf}, advance ${adv}, net ${net} — expected gross ${e.gross}, cut ${e.cut}, net ${e.net}`);
  sheetRows.push({ c, app: { wd, pr, ab, lv, lw, ld, gross, cut, tax, pf, adv, net, lates: r.late_count, extremes: r.extreme_late_count } });
}

// Leave balances after the approved leave.
const bal = (uid, col) => Number(sql(`SELECT ${col} FROM leave_balances WHERE user_id=${uid}`));
const cas = CASES.find((c) => c.key === 'casual');
const unp = CASES.find((c) => c.key === 'lwp');
const wkl = CASES.find((c) => c.key === 'weekendLeave');
T('REC-L1', bal(cas.uid, 'casual_leave') === 8, 'Casual leave 14–15 Sep takes 2 days off the balance (10 → 8)', `now ${bal(cas.uid, 'casual_leave')}`);
T('REC-L2', bal(unp.uid, 'leave_without_pay') === 8, 'Leave without pay 21–22 Sep: 2 days used (10 → 8), and cut from the salary', `now ${bal(unp.uid, 'leave_without_pay')}`);
const wkBal = bal(wkl.uid, 'casual_leave');
INFO('REC-L3', 'Leave Thu 17 – Sat 19 Sep (Friday in between)', `balance ${10} → ${wkBal} (${10 - wkBal} days, the application says ${wkl.leaveDayCount}); payroll counts ${wkl.expected.leave} leave days (the Friday is a weekend, not leave). Decide whether a weekend inside a leave should come off the balance (calendar days, as now) or not.`);

// ---- The Excel workbook -------------------------------------------------------
const wb = XLSX.utils.book_new();
const readme = [
  ['CredenceHR — one month check (' + MONTH + ')'],
  [''],
  ['How to use with your own month'],
  ['1. Sheet "Summary": per employee, type your own figures in the yellow columns (days, lates, salary, tax, PF, advance).'],
  ['2. The grey columns are worked out by formula from them: per-day salary, cut, expected net.'],
  ['3. Type what CredenceHR shows (Payroll list) into the blue "App" columns; "Difference" must be 0.'],
  [''],
  ['Rules used (CredenceHR settings for this month)'],
  [`Working days = days in the month − weekends − holidays = ${days.length} − ${FRIDAYS.length} − 1 = ${WORKING.length}`],
  [`Late: check-in after ${RULE.start} + ${RULE.grace} min; every ${RULE.latesPerDay} lates = 1 day cut. Extreme late: after ${RULE.extremeGrace} min; every ${RULE.extremePerDay} = 1 day cut.`],
  ['Per-day salary = gross ÷ working days. Cut = per-day × (absent + leave without pay + late days). Paid leave costs nothing.'],
  ['Net = gross − cut − tax − PF − advance installment.'],
  [''],
  ['Sheet "Attendance": the day-by-day record used for this test (P present, L late, X extreme late, A absent, CL casual leave, LWP leave without pay, W weekend, H holiday).']
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(readme), 'Read me');

const head = ['Employee', 'Case', 'Working days', 'Present', 'Absent', 'Paid leave', 'Leave without pay', 'Lates', 'Extreme lates', 'Lates per day cut', 'Extremes per day cut', 'Gross salary', 'Tax', 'PF', 'Advance', 'Late days cut', 'Per-day salary', 'Cut', 'Expected net', 'App: present', 'App: absent', 'App: net', 'Difference', 'Match'];
const aoa = [head];
sheetRows.forEach(({ c, app }, i) => {
  const r = i + 2; // Excel row
  const e = c.expected;
  aoa.push([
    c.name, c.what, e.working, e.present, e.absent, e.leave, e.lwp, e.lates, e.extremes, RULE.latesPerDay, RULE.extremePerDay, e.gross, c.tax || 0, c.pf || 0, c.advance ? c.advance.monthly : 0,
    { f: `INT(H${r}/J${r})+INT(I${r}/K${r})` },
    { f: `L${r}/C${r}` },
    { f: `ROUND(Q${r}*(E${r}+G${r}+P${r}),2)` },
    { f: `ROUND(L${r}-R${r}-M${r}-N${r}-O${r},2)` },
    app.pr, app.ab, app.net,
    { f: `ROUND(V${r}-S${r},2)` },
    { f: `IF(ABS(W${r})<0.01,"OK","CHECK")` }
  ]);
});
const ws = XLSX.utils.aoa_to_sheet(aoa);
ws['!cols'] = head.map((h, i) => ({ wch: i < 2 ? (i ? 44 : 18) : Math.max(9, h.length + 1) }));
XLSX.utils.book_append_sheet(wb, ws, 'Summary');

const att = [['Employee', ...days.map((d) => d.slice(8) + ' ' + ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][weekday(d)])]];
for (const c of CASES) {
  att.push([
    c.name,
    ...days.map((d) => {
      const t = c.times[d];
      const inLeave = c.leave && d >= c.leave[1] && d <= c.leave[2];
      if (offDay(d)) return t ? (FRIDAYS.includes(d) ? 'W (worked)' : 'H (worked)') : FRIDAYS.includes(d) ? 'W' : 'H';
      if (t) return toMin(t) > START + RULE.extremeGrace ? `X ${t}` : toMin(t) > START + RULE.grace ? `L ${t}` : 'P';
      if (inLeave) return c.leave[0] === 'without_pay' ? 'LWP' : 'CL';
      return 'A';
    })
  ]);
}
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(att), 'Attendance');
const xlsxPath = path.join(OUT, `CredenceHR-month-check-${MONTH}.xlsx`);
XLSX.writeFile(wb, xlsxPath);
console.log('workbook', xlsxPath);

const s = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length, INFO: R.filter((r) => r.status === 'INFO').length };
console.log('\nSUMMARY', JSON.stringify(s));
fs.writeFileSync(path.join(OUT, 'qa-month-reconcile.json'), JSON.stringify({ when: new Date().toISOString(), month: MONTH, summary: s, results: R }, null, 1));
