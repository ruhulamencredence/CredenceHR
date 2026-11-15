// Overtime + guards, end to end against the running test server (port 3200)
// and the test world from ot-setup.sql. Run: node docs/test-logs/2026-11-11/scripts/ot-api.mjs
import { execSync } from 'node:child_process';
const B = 'http://127.0.0.1:3200';
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
const login = async (id) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: id, password: 'ProbePass123', workspace: 'credence' }) })).json()).token;
const H = (t) => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });
const call = async (t, method, p, body) => { const r = await fetch(B + p, { method, headers: H(t), body: body === undefined ? undefined : JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => null) }; };
const get = (t, p) => call(t, 'GET', p);
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };

const sa = await login('admin@credence.test');
const nasrin = await login('nasrin.sultana@credence.test');
const kamal = await login('kamal.uddin@credence.test');
const imran = await login('imran.hossain@credence.test');
const tanvir = await login('tanvir.r@credence.test');
const rafiq = await login('rafiq.ahmed@credence.test');
ok('all test logins work', [sa, nasrin, kamal, imran, tanvir, rafiq].every(Boolean));

console.log('\n— 1. Permissions: nothing new without its own layer / switch');
ok('Kamal (Payroll read only) cannot open OT Rules', (await get(kamal, '/api/ot/settings')).s === 403);
ok('Kamal cannot change who gets OT', (await call(kamal, 'PUT', '/api/ot/gets-ot', { employee_ids: [48], on: true })).s === 403);
ok('Kamal (Duty Roster read only) cannot open Guard Posts', (await get(kamal, '/api/guard/posts')).s === 403);
ok('Kamal cannot see coverage', (await get(kamal, '/api/guard/coverage?from=2026-11-16&to=2026-11-22')).s === 403);
ok('Kamal cannot open OT Approval', (await get(kamal, '/api/ot/approvals')).s === 403);
const kShifts = (await get(kamal, '/api/roster/shifts')).j;
ok('Duty Roster tells Kamal\'s screen: no OT Approval / Guard Posts tab', kShifts.can_ot_approve === false && kShifts.can_guard_posts === false, JSON.stringify(kShifts).slice(0, 120));
ok('Imran (supervisor, Team OT switch off) cannot open approvals', (await get(imran, '/api/ot/approvals')).s === 403);
ok('Rafiq cannot open My OT (switch off)', (await get(rafiq, '/api/my-ot')).s === 403);
const kAcc = (await get(kamal, '/api/payroll/approval-access')).j;
ok('Payroll tells Kamal\'s screen: no OT Rules tab', kAcc.ot_rules === false);
ok('Payroll tells Nasrin\'s screen: OT Rules tab', (await get(nasrin, '/api/payroll/approval-access')).j.ot_rules === true);

console.log('\n— 2. Settings (Nasrin, ot_rules)');
const st = (await get(nasrin, '/api/ot/settings')).j;
ok('defaults: labour law, 208, ×2, 30 min, Team Supervisor approves', st.rules.rate_type === 'labour_law' && st.rules.divisor === 208 && st.rules.multiplier === 2 && st.rules.min_minutes === 30 && st.rules.approver_mode === 'supervisor');
ok('saving the rules', (await call(nasrin, 'PUT', '/api/ot/settings', { ...st.rules, approver_mode: 'supervisor' })).s === 200);
ok('bad approver refused', (await call(nasrin, 'PUT', '/api/ot/settings', { approver_mode: 'boss' })).s === 400);
ok('Security Guard own rate ৳100 / ৳150 (designation)', (await call(nasrin, 'POST', '/api/ot/rates', { designation: 'Security Guard', rate_type: 'fixed', rate: 100, off_rate: 150 })).s === 200);
for (const [ids, on] of [[[48, 40, 38], true], [[47], false]]) await call(nasrin, 'PUT', '/api/ot/gets-ot', { employee_ids: ids, on });
ok('Gets OT: Rafiq, both guards on; Sadia off', sql('SELECT GROUP_CONCAT(id ORDER BY id) FROM all_employees WHERE gets_ot = 1') === '38,40,48');

console.log('\n— 3. Shifts with normal hours');
const mk = async (b) => (await call(sa, 'POST', '/api/roster/shifts', b)).j?.id;
const G = await mk({ name: 'General', code: 'G', start_time: '09:00', end_time: '18:00' });
const GD = await mk({ name: 'Guard Day', code: 'GD', start_time: '08:00', end_time: '20:00', normal_minutes: 480, extra_mode: 'ot' });
const GN = await mk({ name: 'Guard Night', code: 'GN', start_time: '20:00', end_time: '08:00', normal_minutes: 480, extra_mode: 'ot' });
const S12 = await mk({ name: 'Security 12h', code: 'S12', start_time: '08:00', end_time: '20:00', normal_minutes: 480, extra_mode: 'salary' });
ok('four shifts made', [G, GD, GN, S12].every(Boolean), JSON.stringify([G, GD, GN, S12]));
ok('normal hours > shift length refused', (await call(sa, 'POST', '/api/roster/shifts', { name: 'X', code: 'X9', start_time: '09:00', end_time: '17:00', normal_minutes: 600 })).s === 400);
const shifts = (await get(sa, '/api/roster/shifts')).j.shifts;
ok('shift list carries normal hours and mode', shifts.find((s) => s.id === GD)?.normal_minutes === 480 && shifts.find((s) => s.id === S12)?.extra_mode === 'salary');

console.log('\n— 4. Roster, a post, relief, attendance');
const post = (await call(nasrin, 'POST', '/api/guard/posts', { name: 'Main Gate', site: 'Credence Skyline Site', needs: [{ shift_id: GD, headcount: 2 }, { shift_id: GN, headcount: 1 }] })).j?.id;
ok('post Main Gate made', !!post);
const cells = [
  { employee_id: 48, date: '2026-11-03', shift_id: G, is_off: false, planned_ot_minutes: 120 },
  { employee_id: 48, date: '2026-11-04', shift_id: G, is_off: false },
  { employee_id: 47, date: '2026-11-04', shift_id: G, is_off: false },
  { employee_id: 40, date: '2026-11-03', shift_id: GD, is_off: false, post_id: post },
  { employee_id: 40, date: '2026-11-05', shift_id: GD, is_off: false, post_id: post },
  { employee_id: 40, date: '2026-11-06', shift_id: null, is_off: true },
  { employee_id: 38, date: '2026-11-04', shift_id: GN, is_off: false, post_id: post },
  { employee_id: 38, date: '2026-11-09', shift_id: S12, is_off: false }
];
ok('roster saved (with OT for the day and posts)', (await call(nasrin, 'PUT', '/api/roster/cells', { cells })).s === 200);
ok('relief: Jahid on his Off day 6 Nov, Main Gate day', (await call(nasrin, 'POST', '/api/guard/relief', { employee_id: 40, date: '2026-11-06', post_id: post, shift_id: GD })).s === 200);
ok('a second relief the same day is refused', (await call(nasrin, 'POST', '/api/guard/relief', { employee_id: 40, date: '2026-11-06', post_id: post, shift_id: GD })).s === 400);
const proj = sql('SELECT id FROM projects ORDER BY id LIMIT 1');
sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_out_at) VALUES
 (138, ${proj}, '2026-11-03', '2026-11-03 09:02:00', '2026-11-03 20:01:00'),
 (138, ${proj}, '2026-11-04', '2026-11-04 08:56:00', '2026-11-04 20:47:00'),
 (137, ${proj}, '2026-11-04', '2026-11-04 09:00:00', '2026-11-04 20:30:00')`);
// Site Attendance muster for the guards (they have no login).
const team = sql("SELECT id FROM site_attendance_teams WHERE name = 'OT Test Guards'");
const sheet = (d) => { sql(`INSERT INTO site_attendance_sheets (team_id, attendance_date, status, submitted_by) VALUES (${team}, '${d}', 'approved', 132)`); return sql(`SELECT id FROM site_attendance_sheets WHERE team_id = ${team} AND attendance_date = '${d}'`); };
const entry = (sh, emp, d, a, b) => sql(`INSERT INTO site_attendance_entries (sheet_id, team_id, employee_id, attendance_date, status, in_time, out_time, confirmed) VALUES (${sh}, ${team}, ${emp}, '${d}', 'present', '${a}', '${b}', 1)`);
sql(`DELETE FROM site_attendance_sheets WHERE team_id = ${team}`);
let sh = sheet('2026-11-03'); entry(sh, 40, '2026-11-03', '07:55', '20:05');
sh = sheet('2026-11-04'); entry(sh, 38, '2026-11-04', '19:51', '08:40');
sh = sheet('2026-11-05'); entry(sh, 40, '2026-11-05', '07:58', '20:02');
sh = sheet('2026-11-06'); entry(sh, 40, '2026-11-06', '08:02', '20:05');
sh = sheet('2026-11-09'); entry(sh, 38, '2026-11-09', '07:50', '20:10');
ok('attendance in: app check-in (Rafiq, Sadia) and muster (guards)', true);

console.log('\n— 5. Worked out by itself');
const list = (await get(sa, '/api/ot/approvals?from=2026-11-01&to=2026-11-30&status=all')).j.entries;
const e = (emp, d) => list.find((x) => x.employee_id === emp && x.date === d);
const r3 = e(48, '2026-11-03'), r4 = e(48, '2026-11-04'), j3 = e(40, '2026-11-03'), j5 = e(40, '2026-11-05'), j6 = e(40, '2026-11-06'), u4 = e(38, '2026-11-04'), u9 = e(38, '2026-11-09');
ok('Rafiq 3 Nov: 09:02→20:01, +2h set in roster -> 2 h, approved by itself', r3?.calc_minutes === 120 && r3.status === 'auto', JSON.stringify(r3));
ok('Rafiq 4 Nov: 08:56→20:47 -> 2 h 30 m waiting, 30 m over the daily max', r4?.calc_minutes === 150 && r4.status === 'pending' && r4.over_limit_minutes === 30, JSON.stringify(r4));
ok('Jahid 3 Nov (muster 07:55→20:05) guard day: 4 h built in, approved', j3?.built_in_minutes === 240 && j3.calc_minutes === 240 && j3.status === 'auto', JSON.stringify(j3));
ok('Jahid 5 Nov: 4 h built in, approved', j5?.calc_minutes === 240 && j5.status === 'auto', JSON.stringify(j5));
ok('Jahid 6 Nov: relief on his Off day -> 12 h Off day OT, waiting', j6?.calc_minutes === 720 && j6.day_kind === 'off' && j6.relief && j6.status === 'pending', JSON.stringify(j6));
ok('Rumana 4 Nov night 19:51→08:40 next day: 4 h built in + 30 m, waiting', u4?.built_in_minutes === 240 && u4.calc_minutes === 270 && u4.auto_minutes === 240 && u4.status === 'pending', JSON.stringify(u4));
ok('Rumana 9 Nov on a 12 h shift "in the salary": no OT (only 10 m after)', !u9, JSON.stringify(u9));
ok('Sadia (Gets OT off): kept as "not paid", not in the approval list', !e(47, '2026-11-04') && sql("SELECT status FROM ot_entries WHERE employee_id = 47 AND work_date = '2026-11-04'") === 'not_eligible');

console.log('\n— 6. Who approves: Team Supervisor');
ok('Superadmin turns on Team OT for Imran and Tanvir', (await call(sa, 'PUT', '/api/users/136/team-ot-access', { can_approve_team_ot: true })).s === 200 && (await call(sa, 'PUT', '/api/users/132/team-ot-access', { can_approve_team_ot: true })).s === 200);
const iList = (await get(imran, '/api/ot/approvals?from=2026-11-01&to=2026-11-30')).j.entries;
ok('Imran sees only his own team (Rafiq)', iList.length === 1 && iList[0].employee_id === 48 && iList[0].can_act === 'final', JSON.stringify(iList.map((x) => [x.employee_name, x.can_act])));
const tList = (await get(tanvir, '/api/ot/approvals?from=2026-11-01&to=2026-11-30')).j.entries;
ok('Tanvir sees only his guards', tList.length === 2 && tList.every((x) => [40, 38].includes(x.employee_id) && x.can_act === 'final'), JSON.stringify(tList.map((x) => [x.employee_name, x.can_act])));
const nList = (await get(nasrin, '/api/ot/approvals?from=2026-11-01&to=2026-11-30')).j.entries;
ok('Nasrin (Roster manager) sees them but may not decide — they have supervisors', nList.length === 3 && nList.every((x) => x.can_act === null), JSON.stringify(nList.map((x) => [x.employee_name, x.can_act])));
let d = (await call(imran, 'POST', '/api/ot/approvals/decide', { action: 'approve', items: [{ id: j6.id }] })).j;
ok('Imran cannot approve a guard (another team)', d.finalized === 0 && d.skipped.length === 1, JSON.stringify(d));
d = (await call(nasrin, 'POST', '/api/ot/approvals/decide', { action: 'approve', items: [{ id: r4.id }] })).j;
ok('Nasrin cannot approve Rafiq (his supervisor approves)', d.finalized === 0, JSON.stringify(d));
d = (await call(imran, 'POST', '/api/ot/approvals/decide', { action: 'approve', items: [{ id: r4.id, minutes: 200 }] })).j;
ok('more than worked out is refused', d.finalized === 0, JSON.stringify(d));
d = (await call(imran, 'POST', '/api/ot/approvals/decide', { action: 'approve', items: [{ id: r4.id, minutes: 120 }] })).j;
ok('Imran approves Rafiq 4 Nov trimmed to 2 h', d.finalized === 1 && sql(`SELECT CONCAT(status, approved_minutes) FROM ot_entries WHERE id = ${r4.id}`) === 'approved120', JSON.stringify(d));

console.log('\n— 7. "Both, one after the other"');
ok('Nasrin switches to both', (await call(nasrin, 'PUT', '/api/ot/settings', { approver_mode: 'both' })).s === 200);
d = (await call(tanvir, 'POST', '/api/ot/approvals/decide', { action: 'approve', items: [{ id: u4.id }] })).j;
ok('Tanvir (step 1) passes Rumana on', d.passed_on === 1 && sql(`SELECT CONCAT(status, step) FROM ot_entries WHERE id = ${u4.id}`) === 'pending2', JSON.stringify(d));
d = (await call(tanvir, 'POST', '/api/ot/approvals/decide', { action: 'approve', items: [{ id: u4.id }] })).j;
ok('Tanvir cannot do step 2 himself', d.finalized === 0 && d.passed_on === 0, JSON.stringify(d));
const n2 = (await get(nasrin, '/api/ot/approvals?from=2026-11-01&to=2026-11-30')).j.entries;
ok('Nasrin now may decide Rumana, not Jahid (still at step 1)', n2.find((x) => x.id === u4.id)?.can_act === 'final' && n2.find((x) => x.id === j6.id)?.can_act === null, JSON.stringify(n2.map((x) => [x.employee_name, x.step, x.can_act])));
d = (await call(nasrin, 'POST', '/api/ot/approvals/decide', { action: 'approve', items: [{ id: u4.id }] })).j;
ok('Nasrin approves Rumana: 4 h 30 m', d.finalized === 1 && sql(`SELECT CONCAT(status, approved_minutes) FROM ot_entries WHERE id = ${u4.id}`) === 'approved270', JSON.stringify(d));
d = (await call(tanvir, 'POST', '/api/ot/approvals/decide', { action: 'reject', items: [{ id: j6.id }] })).j;
ok('Tanvir rejects Jahid\'s relief day -> not paid', d.finalized === 1 && sql(`SELECT CONCAT(status, approved_minutes) FROM ot_entries WHERE id = ${j6.id}`) === 'rejected0', JSON.stringify(d));
await call(nasrin, 'PUT', '/api/ot/settings', { approver_mode: 'supervisor' });
// A late punch arrives for Rafiq on 4 Nov — a decided day never changes.
sql("UPDATE attendance SET check_out_at = '2026-11-04 21:40:00' WHERE user_id = 138 AND attendance_date = '2026-11-04'");
await new Promise((r) => setTimeout(r, 61000));
await get(sa, '/api/ot/approvals?from=2026-11-01&to=2026-11-30&status=all');
ok('a decided day is never recalculated (still approved 2 h)', sql(`SELECT CONCAT(status, approved_minutes) FROM ot_entries WHERE id = ${r4.id}`) === 'approved120');

console.log('\n— 8. Payroll fills itself');
const sum = (await get(sa, '/api/payroll/wizard/attendance-summary?month_year=2026-11')).j;
console.log('   salary month', sum.period_start, '→', sum.period_end);
const row = (id) => sum.employees.find((x) => x.employee_id === id);
const rr = row(48), jr = row(40), ur = row(38), sr = row(47);
ok('Rafiq: 4 h at labour law (30,000 / 208 × 2 = 288.46) = 1,153.85', rr?.overtime_hours === 4 && rr.overtime_rate === 288.46 && rr.overtime_amount === 1153.85, JSON.stringify(rr && { h: rr.overtime_hours, r: rr.overtime_rate, a: rr.overtime_amount }));
ok('Jahid: 8 h at the guard rate ৳100 = 800 (rejected relief not paid)', jr?.overtime_hours === 8 && jr.overtime_amount === 800, JSON.stringify(jr && { h: jr.overtime_hours, a: jr.overtime_amount }));
ok('Rumana: 4.5 h × ৳100 = 450', ur?.overtime_hours === 4.5 && ur.overtime_amount === 450, JSON.stringify(ur && { h: ur.overtime_hours, a: ur.overtime_amount }));
ok('Sadia: nothing (Gets OT off)', sr?.overtime_hours === 0 && sr.overtime_amount === 0);
ok('nothing waiting', sum.ot_pending_total === 0, String(sum.ot_pending_total));
const ks = (await get(kamal, '/api/payroll/wizard/attendance-summary?month_year=2026-11')).j;
ok('Kamal (no "See salary amounts") sees OT amount and rate as *****', ks?.employees?.find((x) => x.employee_id === 48)?.overtime_amount === '*****' && ks.employees.find((x) => x.employee_id === 48).overtime_rate === '*****', JSON.stringify(ks?.employees?.find((x) => x.employee_id === 48)).slice(0, 200));
if (rr && !rr.already_generated && rr.has_salary_structure) {
  const base = { employee_id: 48, total_working_days: rr.total_working_days, present_days: rr.present_days, absent_days: rr.absent_days, leave_days: rr.leave_days, lwp_days: rr.lwp_days, late_count: 0, late_deduction_days: 0, bonus_amount: 0, other_deduction: 0 };
  let g = (await call(sa, 'POST', '/api/payroll/generate-bulk', { month_year: '2026-11', employees: [{ ...base, overtime_hours: 6, overtime_amount: 1730.77 }] })).j;
  ok('Run Payroll: OT changed by hand without a reason is refused', g.results?.[0]?.success === false && /reason/i.test(g.results[0].error), JSON.stringify(g));
  g = (await call(sa, 'POST', '/api/payroll/generate-bulk', { month_year: '2026-11', employees: [{ ...base, overtime_hours: 6, overtime_amount: 1730.77, ot_change_reason: 'Stock count night, approved by MD' }] })).j;
  ok('with a reason it goes through and the change is kept', g.results?.[0]?.success === true && sql("SELECT CONCAT(from_hours, '>', to_hours) FROM ot_payroll_changes WHERE employee_id = 48") === '4.00>6.00', JSON.stringify(g));
  sql("DELETE FROM payroll_payment_splits WHERE payroll_id IN (SELECT id FROM payrolls WHERE employee_id = 48 AND month_year = '2026-11')");
  sql("DELETE FROM payrolls WHERE employee_id = 48 AND month_year = '2026-11'");
} else console.log('   (Rafiq already has November payroll / no structure — Run Payroll reason check skipped)', rr?.already_generated, rr?.has_salary_structure);

console.log('\n— 9. My OT');
ok('Superadmin turns My OT on for Rafiq', (await call(sa, 'PUT', '/api/users/138/my-ot-access', { can_view_my_ot: true })).s === 200);
const my = (await get(rafiq, '/api/my-ot?month=2026-11')).j;
ok('Rafiq sees his 2 days, 4 h approved, nothing waiting', my.entries?.length === 2 && my.approved_minutes === 240 && my.waiting_minutes === 0, JSON.stringify(my).slice(0, 300));
ok('My OT has no money in it', !/rate|amount/i.test(JSON.stringify(my)));

console.log('\n— 10. Guard posts');
const pf = (await call(nasrin, 'POST', '/api/guard/pattern', { post_id: post, employee_ids: [40, 38], from: '2026-11-16', to: '2026-11-29', pattern: 'day_night_week', day_shift_id: GD, night_shift_id: GN })).j;
ok('month filled from a pattern (2 guards × 14 days)', pf.saved === 28, JSON.stringify(pf));
ok('each guard gets 2 Off days in 14', sql("SELECT GROUP_CONCAT(c) FROM (SELECT SUM(is_off) c FROM duty_roster WHERE employee_id IN (38,40) AND roster_date BETWEEN '2026-11-16' AND '2026-11-29' GROUP BY employee_id) x") === '2,2');
const cov = (await get(nasrin, '/api/guard/coverage?from=2026-11-16&to=2026-11-22')).j;
const mg = cov.posts.find((p) => p.id === post);
const dayRow = mg.rows.find((r) => r.shift_id === GD);
ok('coverage: Main Gate day needs 2 — at most 1 there each day, the rest shows empty', dayRow.days.every((x) => x.people.length + x.empty >= 2 && x.empty >= 1), JSON.stringify(dayRow.days.map((x) => [x.people.length, x.empty])));
const fr = (await get(nasrin, `/api/guard/free?date=2026-11-17&shift_id=${GN}`)).j;
ok('free list for a night: guards first, who is on the day shift is "double duty"', fr.people[0]?.guard === true && fr.people.some((p) => p.kind === 'double' || p.kind === 'off'), JSON.stringify(fr.people.slice(0, 3)));
// The roster screen saves a cell without post_id: the post stays.
const before = sql("SELECT post_id FROM duty_roster WHERE employee_id = 40 AND roster_date = '2026-11-16'");
await call(nasrin, 'PUT', '/api/roster/cells', { cells: [{ employee_id: 40, date: '2026-11-16', shift_id: GD, is_off: false }] });
ok('a roster edit without post / OT keeps them', sql("SELECT IFNULL(post_id, 'null') FROM duty_roster WHERE employee_id = 40 AND roster_date = '2026-11-16'") === (before || 'null'), before);
const rg = (await get(nasrin, '/api/roster?from=2026-11-01&to=2026-11-30')).j;
const raf = rg.employees.find((x) => x.id === 48);
ok('roster grid shows Gets OT and OT for the day', raf?.gets_ot === true && raf.days['2026-11-03']?.planned_ot_minutes === 120);

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
