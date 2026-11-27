// Late Policy: Extreme Lates per Deducted Day = 0 means Extreme Delay has no
// deduction of its own and counts together with the Delay days (3 lates of
// either kind = 1 day). 1 or more works as before. Checked on the policy
// save, the employee's This Month summary, Run Payroll's attendance summary
// and the late-days list.
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Late#2026pass';
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const email = `late.${tag}@credence.test`;
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const e = await api(SA, 'POST', '/api/employees', { name: `Late ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS });
  const empId = e.b.id;
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${empId}`));
  sql(`UPDATE users SET must_change_password=0 WHERE id=${uid}`);
  const Ut = (await login(email, PASS)).token;
  const before = sql('SELECT IFNULL(MAX(id),0) FROM late_policy_settings');

  const first = (await api(Ut, 'GET', '/api/my-attendance-summary')).b;
  const month = first.month_year;
  const eff = `${month}-01`;
  const policy = (x) => ({ shift_start_time: '09:00', grace_minutes: 10, lates_per_deduction_day: 3, extreme_grace_minutes: 60, extreme_lates_per_deduction_day: x, effective_date: eff });

  ok((await api(SA, 'POST', '/api/payroll/late-policy', policy(-1))).s === 400, 'save: −1 refused');
  const save0 = await api(SA, 'POST', '/api/payroll/late-policy', policy(0));
  ok(save0.s === 200 || save0.s === 201, 'save: 0 accepted ' + JSON.stringify(save0.b));
  ok(sql(`SELECT extreme_lates_per_deduction_day FROM late_policy_settings ORDER BY id DESC LIMIT 1`) === '0', 'save: stored as 0 (not turned into 1)');

  // Three late days before today in the salary month: 2 Delay (09:30), 1 Extreme Delay (10:30).
  const proj = Number(sql('SELECT MIN(id) FROM projects'));
  const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
  const days = [];
  for (let i = 1; days.length < 3 && i < 20; i++) {
    const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - i);
    const ds = d.toISOString().slice(0, 10);
    if (ds >= first.period_start && d.getUTCDay() !== 5) days.push(ds); // not Friday
  }
  const at = ['09:30:00', '09:40:00', '10:30:00'];
  days.forEach((d, i) => sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_lat, check_in_lng) VALUES (${uid}, ${proj}, '${d}', '${d} ${at[i]}', 23.8, 90.4)`));

  const s0 = (await api(Ut, 'GET', '/api/my-attendance-summary')).b;
  ok(s0.late_count === 2 && s0.extreme_late_count === 1, `my summary: 2 Delay + 1 Extreme marked separately (${s0.late_count}, ${s0.extreme_late_count})`);
  ok(s0.late_deduction_days === 1 && s0.extreme_late_deduction_days === 0, `Extreme = 0: 3 lates together = 1 day, nothing extra for Extreme (${s0.late_deduction_days}, ${s0.extreme_late_deduction_days})`);
  ok(s0.policy.extreme_lates_per_deduction_day === 0 && s0.lates_combined === true, 'my summary: policy says 0 / combined');

  const w0 = (await api(SA, 'GET', `/api/payroll/wizard/attendance-summary?month_year=${month}`)).b;
  const row0 = (w0.employees || w0.rows || w0).find?.((r) => Number(r.employee_id) === Number(empId));
  ok(row0 && row0.late_count === 2 && row0.extreme_late_count === 1 && row0.late_deduction_days === 1 && row0.extreme_late_deduction_days === 0, 'Run Payroll: same — −1 day in all ' + JSON.stringify(row0 && { l: row0.late_count, x: row0.extreme_late_count, ld: row0.late_deduction_days, xd: row0.extreme_late_deduction_days }));
  ok((w0.late_policy || {}).extreme_lates_per_deduction_day === 0, 'Run Payroll: policy shows 0');

  const ld0 = (await api(SA, 'GET', `/api/payroll/late-summary/${empId}?month_year=${month}`));
  ok(ld0.s === 200 && ld0.b.deduction_days === 1 && ld0.b.extreme_deduction_days === 0 && ld0.b.lates_combined === true, 'late-days list: 1 day, combined ' + JSON.stringify(ld0.b && { d: ld0.b.deduction_days, x: ld0.b.extreme_deduction_days }));

  // Waive one Delay day: 2 lates left -> nothing deducted.
  await api(SA, 'POST', '/api/payroll/late-waivers', { employee_id: empId, waiver_date: days[0], reason: 'Traffic jam test' });
  const s1 = (await api(Ut, 'GET', '/api/my-attendance-summary')).b;
  ok(s1.late_deduction_days === 0 && s1.extreme_late_deduction_days === 0, 'a waived day drops out: 2 lates left, nothing deducted');
  sql(`DELETE FROM late_waivers WHERE employee_id=${empId}`);

  // Back to the old rule: Extreme = 1 -> its own count.
  await api(SA, 'POST', '/api/payroll/late-policy', policy(1));
  const s2 = (await api(Ut, 'GET', '/api/my-attendance-summary')).b;
  ok(s2.late_deduction_days === 0 && s2.extreme_late_deduction_days === 1 && s2.lates_combined === false, 'Extreme = 1: old rule — Delay 2÷3 = 0, Extreme 1 = 1 day');

  sql(`DELETE FROM late_policy_settings WHERE id > ${before}`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
