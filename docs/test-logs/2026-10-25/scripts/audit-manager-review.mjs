// Audit Manager review: internal-control checks against the live API.
// Segregation of duties, maker-checker, locks after approval, audit trail,
// payroll arithmetic, master-data changes and access review.
// Each check is PASS (control works), FAIL (control gap) or INFO (observation).
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3100';
const R = []; let area = '';
const rec = (id, status, name, detail = '') => { R.push({ id, area, status, name, detail: String(detail).slice(0, 500) }); console.log(`${status.padEnd(4)} ${id} ${name}${status !== 'PASS' && detail ? '  — ' + String(detail).slice(0, 300) : ''}`); };
const T = (id, ok, name, detail = '') => rec(id, ok ? 'PASS' : 'FAIL', name, ok ? '' : detail);
const INFO = (id, name, detail) => rec(id, 'INFO', name, detail);
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}
const J = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
const ok = (r) => r.status >= 200 && r.status < 300;
const denied = (r) => r.status === 401 || r.status === 403;
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const money = (v) => Math.round(Number(v || 0) * 100) / 100;

const SA = await login('admin@credence.test', 'AdminPass123');
// ---------------- fixtures ----------------
async function adminUser(name, email, modules, layers) {
  const id = (await api(SA, 'POST', '/api/users', { name, email, password: 'Audit#2026x', role: 'admin' })).body.id;
  await api(SA, 'PUT', `/api/users/${id}/module-permissions`, { modules });
  for (const [module, ls] of Object.entries(layers || {})) await api(SA, 'PUT', `/api/users/${id}/module-permission-layers`, { module, layers: ls });
  return { id, token: await login(email, 'Audit#2026x') };
}
const HR = await adminUser('Hasan HR Payroll', 'hr.pay@credence.test', ['payroll', 'employees'], { payroll: ['read', 'salary_hold'] });
const AUD = await adminUser('Ayesha Audit', 'audit.mgr@credence.test', ['payroll'], { payroll: ['audit_approve', 'access_log'] });
const ACC = await adminUser('Karim Accounts', 'accounts.pay@credence.test', ['payroll'], { payroll: ['accounts_pay'] });
const AUD2 = await adminUser('Audit With Payroll', 'audit.read@credence.test', ['payroll'], { payroll: ['read', 'audit_approve', 'access_log'] });
const BOTH = await adminUser('Both Hats', 'both.hats@credence.test', ['payroll'], { payroll: ['read', 'audit_approve', 'accounts_pay'] });
console.log('fixtures users', HR.id, AUD.id, ACC.id, BOTH.id, !!HR.token, !!AUD.token, !!ACC.token);
const emps = [];
for (const [i, n] of ['Audit Staff One', 'Audit Staff Two', 'Audit Staff Three'].entries()) {
  const e = await api(SA, 'POST', '/api/employees', { name: n, designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email: `aud.staff${i}@credence.test`, create_login: true, login_email: `aud.staff${i}@credence.test`, login_password: 'Pass12345' });
  emps.push(e.body.id);
  await api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: e.body.id, effective_date: '2026-01-01', basic_salary: 30000 + i * 5000, house_rent: 15000, medical_allowance: 3000, conveyance_allowance: 2000 });
  await api(SA, 'POST', `/api/employees/${e.body.id}/payment-accounts`, { account_type: 'bank', account_label: 'Salary', bank_name: 'BRAC Bank', account_number: `15020000${i}`, percentage: 100 });
}
console.log('fixtures employees', emps);
const M = '2026-09', M2 = '2026-08';
const gen = (t, eid, month, extra = {}) => api(t, 'POST', '/api/payroll/generate', { employee_id: eid, month_year: month, total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0, ...extra });

// ================= PAYROLL: maker-checker =================
area = 'Payroll — maker / checker / payer';
{
  const g = []; for (const e of emps) g.push(await gen(HR.token, e, M));
  T('PAY-01', g.every(ok), 'HR (maker) runs the month\'s payroll', g.map(J).join(' | '));
  const dup = await gen(HR.token, emps[0], M);
  T('PAY-02', !ok(dup), 'The same employee cannot be paid twice for one month', J(dup));
  const runs = JSON.parse('[' + sql(`SELECT CONCAT('{"id":',id,',"gross":',gross_earned,',"basic":',basic_amount,',"allow":',allowances_total,',"ot":',overtime_amount,',"bonus":',bonus_amount,',"ded":',total_deduction,',"net":',net_salary,',"abs":',absent_deduction,',"tax":',tax_deduction,',"pf":',pf_deduction,',"adv":',advance_deduction,',"oth":',other_deduction,',"late":',IFNULL(late_deduction_amount,0),'}') FROM payrolls WHERE month_year='${M}'`).split('\n').join(',') + ']');
  const bad = runs.filter((r) => Math.abs(money(r.gross - r.ded) - money(r.net)) > 0.01);
  T('PAY-03', runs.length === 3 && bad.length === 0, 'Every run reconciles: gross − total deductions = net', JSON.stringify(bad));
  const badDed = runs.filter((r) => Math.abs(money(r.abs + r.tax + r.pf + r.adv + r.oth + r.late) - money(r.ded)) > 0.01);
  INFO('PAY-03b', 'Total deduction = absent + tax + PF + advance + other + late', badDed.length ? `differs on ${badDed.length} run(s): ${JSON.stringify(badDed).slice(0, 300)}` : 'matches on every run');
  const view = await api(AUD.token, 'GET', `/api/payroll/approval/${M}`);
  const viewRun = await api(AUD.token, 'GET', `/api/payroll?month_year=${M}`);
  T('PAY-03c', ok(view) || ok(viewRun), 'An Audit-only account (Audit Approve layer) can open the salary sheet it is asked to approve', `month status ${view.status}, salary list ${viewRun.status} — Audit would approve without seeing the figures, or must be given the full "Payroll" layer`);
  const early = await api(AUD.token, 'POST', `/api/payroll/approval/${M}/approve`, {});
  T('PAY-04', !ok(early), 'Audit cannot approve a month HR has not submitted', J(early));
  T('PAY-05', denied(await api(HR.token, 'POST', `/api/payroll/approval/${M}/approve`, {})), 'HR (maker) cannot audit-approve');
  const sub = await api(HR.token, 'POST', `/api/payroll/approval/${M}/submit`, { note: 'September salary' });
  T('PAY-06', ok(sub), 'HR submits the month for audit', J(sub));
  const rid = runs[0].id;
  const e1 = await api(HR.token, 'PUT', `/api/payroll/${rid}`, { bonus_amount: 50000 });
  const e2 = await api(HR.token, 'DELETE', `/api/payroll/${runs[1].id}`);
  const e3 = await gen(HR.token, emps[0], M);
  T('PAY-07', !ok(e1) && !ok(e2) && !ok(e3), 'Once submitted the month is locked: no edit, delete or re-run', `edit ${e1.status} delete ${e2.status} rerun ${e3.status}`);
  const pre = await api(ACC.token, 'POST', `/api/payroll/approval/${M}/pay`, { payment_date: '2026-09-30', payment_method: 'Bank Transfer' });
  T('PAY-08', !ok(pre), 'Accounts cannot pay before Audit approves', J(pre));
  const rn = await api(AUD.token, 'POST', `/api/payroll/approval/${M}/return`, {});
  T('PAY-09', !ok(rn), 'Audit must write a reason to return a sheet', J(rn));
  const rt = await api(AUD.token, 'POST', `/api/payroll/approval/${M}/return`, { note: 'Check Staff Two overtime' });
  const fix = await api(HR.token, 'PUT', `/api/payroll/${runs[1].id}`, { overtime_amount: 0 });
  T('PAY-10', ok(rt) && ok(fix), 'Returned sheet unlocks for HR to correct', `return ${rt.status}, HR edit ${J(fix)}`);
  await api(HR.token, 'POST', `/api/payroll/approval/${M}/submit`, { note: 'Corrected' });
  const ap = await api(AUD.token, 'POST', `/api/payroll/approval/${M}/approve`, { note: 'Checked against attendance' });
  T('PAY-11', ok(ap), 'Audit (checker) approves the corrected sheet', J(ap));
  const e4 = await api(HR.token, 'PUT', `/api/payroll/${rid}`, { bonus_amount: 50000 });
  T('PAY-12', !ok(e4), 'After audit approval HR still cannot change a run', J(e4));
  T('PAY-13', denied(await api(AUD.token, 'POST', `/api/payroll/approval/${M}/pay`, { payment_date: '2026-09-30', payment_method: 'Bank Transfer' })), 'Audit cannot pay (no Accounts layer)');
  const pnm = await api(ACC.token, 'POST', `/api/payroll/approval/${M}/pay`, { payment_date: '2026-09-30' });
  T('PAY-14', !ok(pnm), 'Accounts must record how it was paid', J(pnm));
  const sheet = await api(ACC.token, 'GET', `/api/payroll/approval/${M}/payment-sheet`);
  T('PAY-14b', ok(sheet), 'Accounts (pay layer only) can open the bank payment sheet it pays from', J(sheet));
  const pay = await api(ACC.token, 'POST', `/api/payroll/approval/${M}/pay`, { payment_date: '2026-09-30', payment_method: 'Bank Transfer', payment_reference: 'BRAC-ADV-0930' });
  T('PAY-15', ok(pay), 'Accounts (payer) pays the approved month', J(pay));
  const st = await api(SA, 'GET', `/api/payroll/approval/${M}`);
  const sheetTotal = money((await api(SA, 'GET', `/api/payroll/approval/${M}/payment-sheet`)).body.rows?.reduce((s, r) => s + Number(r.amount), 0));
  T('PAY-16', money(pay.body.total) === money(st.body.summary?.total_net) && sheetTotal === money(pay.body.total), 'Paid total = sheet total = bank payment sheet total', `paid ${pay.body.total}, sheet ${st.body.summary?.total_net}, bank sheet ${sheetTotal}`);
  const ev = (st.body.events || []).map((e) => `${e.action}:${e.by}`);
  T('PAY-17', ev.join(',') === 'submitted:Hasan HR Payroll,returned:Ayesha Audit,submitted:Hasan HR Payroll,approved:Ayesha Audit,paid:Karim Accounts', 'The month keeps a full trail: who submitted, returned, approved and paid', ev.join(', '));
  const e5 = await api(SA, 'PUT', `/api/payroll/${rid}`, { bonus_amount: 1 });
  const e6 = await api(SA, 'DELETE', `/api/payroll/${rid}`);
  T('PAY-18', !ok(e5) && !ok(e6), 'Even the Superadmin cannot edit or delete a paid salary', `edit ${e5.status} delete ${e6.status}`);
  const hold = await api(HR.token, 'POST', `/api/payroll/${rid}/hold`, { reason: 'test' });
  T('PAY-19', !ok(hold), 'A paid salary cannot be put on hold afterwards', J(hold));
}

// ================= PAYROLL: segregation of duties =================
area = 'Payroll — segregation of duties';
{
  // Audit-only account (audit_approve + access_log, no "read"/Payroll layer).
  const s1 = await api(AUD.token, 'POST', '/api/payroll/salary-structures', { employee_id: emps[2], effective_date: '2026-10-01', basic_salary: 99000, house_rent: 0, medical_allowance: 0, conveyance_allowance: 0 });
  T('SOD-01', !ok(s1), 'An Audit-only account cannot change an employee\'s salary structure', J(s1));
  const s2 = await gen(AUD.token, emps[2], '2026-10');
  T('SOD-02', !ok(s2), 'An Audit-only account cannot run payroll (it would check its own work)', J(s2));
  const s3 = await api(AUD.token, 'POST', '/api/payroll/advances', { employee_id: emps[2], total_amount: 50000, monthly_installment: 5000, reason: 'test' });
  T('SOD-03', !ok(s3), 'An Audit-only account cannot give a loan / advance', J(s3));
  const s4 = await api(ACC.token, 'POST', '/api/payroll/pending-bonuses', { employee_id: emps[2], amount: 20000, month_year: '2026-10', reason: 'x' });
  T('SOD-04', !ok(s4), 'An Accounts-only account cannot add a bonus', J(s4));
  // The realistic Audit setup: it needs the "Payroll" layer just to see the sheet.
  const t1 = await api(AUD2.token, 'POST', '/api/payroll/salary-structures', { employee_id: emps[2], effective_date: '2026-12-01', basic_salary: 99000, house_rent: 0, medical_allowance: 0, conveyance_allowance: 0 });
  T('SOD-01b', !ok(t1), 'An auditor given "Payroll" (to see the sheet) still cannot change salary structures', J(t1));
  const t2 = await gen(AUD2.token, emps[2], '2026-06');
  T('SOD-02b', !ok(t2), 'An auditor given "Payroll" still cannot run payroll', J(t2));
  const t3 = await api(AUD2.token, 'POST', '/api/payroll/advances', { employee_id: emps[2], total_amount: 30000, monthly_installment: 3000, reason: 'test' });
  T('SOD-03b', !ok(t3), 'An auditor given "Payroll" still cannot give a loan / advance', J(t3));
  // Draft month with the per-run buttons: does it skip HR submit / Audit?
  await gen(HR.token, emps[0], '2026-10');
  const r10 = sql(`SELECT id FROM payrolls WHERE month_year='2026-10' AND employee_id=${emps[0]}`);
  const pr = await api(AUD.token, 'POST', `/api/payroll/${r10}/process`, {});
  const mp = await api(ACC.token, 'POST', `/api/payroll/${r10}/mark-paid`, { payment_method: 'Cash' });
  T('SOD-05', !(ok(pr) && ok(mp)), 'A run cannot be processed and paid one-by-one while its month was never submitted to Audit', `process ${J(pr)}; mark-paid ${J(mp)}; batch = ${sql("SELECT IFNULL((SELECT status FROM payroll_batches WHERE month_year='2026-10'),'none')")}`);
  // One account holding both Audit and Accounts layers.
  for (const e of emps) await gen(BOTH.token, e, M2);
  const bs = await api(BOTH.token, 'POST', `/api/payroll/approval/${M2}/submit`, {});
  const ba = await api(BOTH.token, 'POST', `/api/payroll/approval/${M2}/approve`, {});
  T('SOD-06', ok(bs) && !ok(ba), 'Whoever submitted a month cannot also approve it', `submit ${bs.status}; self-approve ${J(ba)}`);
  await api(AUD.token, 'POST', `/api/payroll/approval/${M2}/approve`, {});
  const bp = await api(BOTH.token, 'POST', `/api/payroll/approval/${M2}/pay`, { payment_date: '2026-08-31', payment_method: 'Bank Transfer' });
  T('SOD-07', !ok(bp), 'The person who prepared (submitted) a month cannot also pay it', `maker paid it: ${J(bp)}`);
  // Superadmin alone.
  await gen(SA, emps[1], '2026-07');
  const a = await api(SA, 'POST', '/api/payroll/approval/2026-07/submit', {});
  const b = await api(SA, 'POST', '/api/payroll/approval/2026-07/approve', {});
  const c = await api(SA, 'POST', '/api/payroll/approval/2026-07/pay', { payment_date: '2026-07-31', payment_method: 'Cash' });
  INFO('SOD-08', 'A Superadmin can prepare, approve and pay a month alone', `submit ${a.status} approve ${b.status} pay ${c.status} — by design ("Superadmin always has access"); keep Superadmin accounts few and review their payroll actions in the Activity Log`);
  // Inactive employee.
  await api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: 39, effective_date: '2026-01-01', basic_salary: 40000, house_rent: 0, medical_allowance: 0, conveyance_allowance: 0 });
  const gh = await gen(HR.token, 39, '2026-10');
  T('SOD-09', !ok(gh), 'Payroll refuses an inactive employee (ghost-employee control)', J(gh));
  const neg = await api(HR.token, 'PUT', `/api/payroll/${r10}`, { bonus_amount: -5000 });
  const negNet = sql(`SELECT bonus_amount FROM payrolls WHERE id=${r10}`);
  T('SOD-10', !ok(neg) || Number(negNet) >= 0, 'A negative bonus is refused', `${J(neg)}; bonus now ${negNet}`);
  const over = await gen(HR.token, emps[1], '2026-10', { present_days: 40, total_working_days: 26 });
  const overRow = sql(`SELECT CONCAT(present_days,'/',total_working_days,' net ',net_salary) FROM payrolls WHERE month_year='2026-10' AND employee_id=${emps[1]}`);
  T('SOD-11', !ok(over) || !overRow.startsWith('40/'), 'Present days above working days is refused or capped', `${J(over)}; stored ${overRow}`);
}

// ================= AUDIT TRAIL =================
area = 'Audit trail';
{
  const log = await api(AUD.token, 'GET', '/api/payroll/access-log');
  const rows = log.body.rows || [];
  T('LOG-01', ok(log) && rows.length > 0, 'Audit can read the Payroll Activity Log', J(log));
  T('LOG-02', denied(await api(HR.token, 'GET', '/api/payroll/access-log')), 'HR without the Activity Log layer cannot read it');
  T('LOG-03', rows.some((r) => /^Tried:/.test(r.area)), 'Refused attempts are logged too ("Tried: …")', rows.slice(0, 3).map((r) => r.area).join(' | '));
  T('LOG-04', rows.some((r) => r.area === 'Audit Approve' && r.user_name === 'Ayesha Audit') && rows.some((r) => r.area === 'Accounts Pay'), 'Approve and pay actions are logged with the user', '');
  T('LOG-05', rows.every((r) => r.ip !== undefined && r.created_at), 'Each log row has time and IP', '');
  const del = await api(SA, 'DELETE', '/api/payroll/access-log');
  const delOne = await api(SA, 'DELETE', `/api/payroll/access-log/${rows[0]?.id}`);
  T('LOG-06', !ok(del) && !ok(delOne), 'Nobody (not even Superadmin) can delete the Activity Log through the app', `${del.status}/${delOne.status}`);
  // Salary structure change trail.
  const before = Number(sql("SELECT COUNT(*) FROM payroll_access_log WHERE area LIKE '%Salary structure%'"));
  await api(HR.token, 'POST', '/api/payroll/salary-structures', { employee_id: emps[2], effective_date: '2026-11-01', basic_salary: 36000, house_rent: 15000, medical_allowance: 3000, conveyance_allowance: 2000 });
  T('LOG-07', Number(sql("SELECT COUNT(*) FROM payroll_access_log WHERE area LIKE '%Salary structure%'")) > before, 'A salary change is logged (who, when)', '');
  // Bank account change — the classic payroll-fraud path.
  const acc = (await api(HR.token, 'GET', `/api/employees/${emps[0]}/payment-accounts`)).body;
  const row = (acc.accounts || acc.rows || acc)[0];
  const cl0 = Number(sql(`SELECT COUNT(*) FROM employee_change_log WHERE employee_id=${emps[0]}`));
  const ch = await api(HR.token, 'PUT', `/api/employees/${emps[0]}/payment-accounts/${row?.id}`, { ...row, account_number: '9999999999' });
  const cl1 = Number(sql(`SELECT COUNT(*) FROM employee_change_log WHERE employee_id=${emps[0]}`));
  const anyLog = sql(`SELECT COUNT(*) FROM payroll_access_log WHERE detail LIKE '%9999999999%'`);
  T('LOG-08', ok(ch) && cl1 > cl0, 'Changing an employee\'s salary bank account is recorded (old → new, who)', `change ${J(ch)}; employee_change_log rows ${cl0}→${cl1}; other logs ${anyLog}`);
  const list = (await api(SA, 'GET', '/api/employees')).body;
  const cur = (Array.isArray(list) ? list : list.employees || list.rows || []).find((e) => Number(e.id) === Number(emps[1])) || {};
  const ed = await api(HR.token, 'PUT', `/api/employees/${emps[1]}`, { ...cur, designation: 'Senior Officer' });
  const edLog = sql(`SELECT CONCAT('designation:',from_designation,'→',to_designation,' by user #',IFNULL(action_by,'?')) FROM employee_transfers WHERE employee_id=${emps[1]} ORDER BY id DESC LIMIT 1`) + ' ' + sql(`SELECT CONCAT(field_name,':',IFNULL(old_value,''),'→',IFNULL(new_value,'')) FROM employee_change_log WHERE employee_id=${emps[1]} ORDER BY id DESC LIMIT 3`);
  T('LOG-09', /designation/i.test(edLog), 'Employee master edits (designation) are recorded old → new', `${ed.status}; ${edLog}`);
  // Permission changes.
  const pa0 = Number(sql(`SELECT COUNT(*) FROM user_access_audit WHERE target_user_id=${HR.id}`));
  await api(SA, 'PUT', `/api/users/${HR.id}/module-permission-layers`, { module: 'payroll', layers: ['read', 'salary_hold', 'audit_approve'] });
  await api(SA, 'PUT', `/api/users/${HR.id}/module-permissions`, { modules: ['payroll', 'employees', 'reports'] });
  const pa1 = Number(sql(`SELECT COUNT(*) FROM user_access_audit WHERE target_user_id=${HR.id}`));
  T('LOG-10', pa1 > pa0, 'Granting someone more access is recorded (who gave what to whom)', `user_access_audit rows ${pa0}→${pa1}`);
  await api(SA, 'PUT', `/api/users/${HR.id}/module-permission-layers`, { module: 'payroll', layers: ['read', 'salary_hold'] });
  T('LOG-11', Number(sql("SELECT COUNT(*) FROM login_attempts")) >= 0 && /login_attempts/.test(sql("SHOW TABLES LIKE 'login_attempts'")), 'Failed sign-ins are kept (login_attempts)', '');
}

// ================= APPROVALS: self-approval =================
area = 'Approvals — self-approval';
{
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${emps[0]}`));
  const tok = await login('aud.staff0@credence.test', 'Pass12345');
  const t = await api(SA, 'POST', '/api/approval-templates', { name: 'Audit self-approval probe', request_type: 'leave', is_default: true, is_active: true, skip_auto_supervisor: true, steps: [{ approver_user_ids: [uid], approver_type: 'employee' }] });
  const la = await api(tok, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: '2026-11-10', end_date: '2026-11-10', purpose: 'Self approval probe' });
  const q = await api(tok, 'GET', '/api/my-approvals');
  const items = q.body.items || q.body || [];
  const mine = (Array.isArray(items) ? items : []).find((i) => Number(i.requested_by) === uid || i.source_type === 'leave_application');
  const act = mine ? await api(tok, 'POST', `/api/my-approvals/${mine.id}/act`, { action: 'approved', remarks: 'ok' }) : { status: 0, body: 'not in queue' };
  T('APR-01', !ok(act), 'Nobody can approve their own request, even when an Approval Template names them', `template ${t.status}; leave ${la.status}; own request in own queue: ${!!mine}; approve → ${J(act)}`);
  if (t.body?.id) await api(SA, 'DELETE', `/api/approval-templates/${t.body.id}`);
}

// ---------------- write log ----------------
const sum = { PASS: 0, FAIL: 0, INFO: 0 }; R.forEach((r) => sum[r.status]++);
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'audit-manager-review.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
