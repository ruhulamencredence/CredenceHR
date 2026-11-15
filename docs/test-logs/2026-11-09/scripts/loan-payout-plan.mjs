// Loans: pay-out step and custom repayment plan (LoanPlan.ts) — end to end
// against a running server on a copy of the database.
//   BASE=http://localhost:3200 DB=loan_test SA_EMAIL=… SA_PASS=… EMP_EMAIL=… EMP_PASS=… EMP_ID=<all_employees.id>
//   ADMIN_EMAIL=… ADMIN_PASS=… (an Admin with the Payroll module but NOT "Accounts Pay")
//   node loan-payout-plan.mjs
import { execFileSync } from 'node:child_process';
const B = process.env.BASE;
const DB = process.env.DB;
const R = [];
const ok = (id, cond, name, info = '') => {
  R.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} ${name}${info ? '  — ' + info : ''}`);
};
const sql = (q) => execFileSync('mysql', ['-uroot', '-N', DB, '-e', q]).toString().trim();
const j = async (method, path, token, body) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let d = null;
  try { d = await r.json(); } catch {}
  return { s: r.status, d };
};
const login = async (email, password) => (await j('POST', '/api/auth/login', null, { email, password, workspace: 'credence' })).d?.token;
const shift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const M0 = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 7);
const M1 = shift(M0, 1), M2 = shift(M0, 2), M3 = shift(M0, 3), M4 = shift(M0, 4);
const EMP = Number(process.env.EMP_ID);

const SA = await login(process.env.SA_EMAIL, process.env.SA_PASS);
const EMPT = await login(process.env.EMP_EMAIL, process.env.EMP_PASS);
const ADM = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASS);
ok('L0', SA && EMPT && ADM, 'sign-ins');
sql(`DELETE FROM employee_advances WHERE employee_id=${EMP}; DELETE FROM advance_requests WHERE employee_id=${EMP}; DELETE FROM payrolls WHERE employee_id=${EMP}`);

// What the salary of a month would take for loans (same math as the salary run).
const previewLoan = async (ym) => {
  const r = await j('POST', '/api/payroll/generate-preview', SA, { month_year: ym, employees: [{ employee_id: EMP, total_working_days: 26, present_days: 26 }] });
  const row = (r.d?.results || r.d || [])[0] || {};
  return { s: r.s, adv: Number(row.advance_deduction ?? row.preview?.advance_deduction ?? NaN), raw: row };
};

// 1. Employee applies with a wished start month.
const ap = await j('POST', '/api/my-loans/requests', EMPT, { kind: 'loan', total_amount: 12000, installments: 4, reason: 'Medical', preferred_start_month: M2 });
ok('L1', ap.s === 201, 'employee applies with a start month', `status ${ap.s} ${ap.d?.error || ''}`);
ok('L1b', sql(`SELECT preferred_start_month FROM advance_requests WHERE employee_id=${EMP} ORDER BY id DESC LIMIT 1`) === M2, 'wished start month saved');
const bad = await j('POST', '/api/my-loans/requests', EMPT, { kind: 'loan', total_amount: 100, installments: 1, reason: 'x', preferred_start_month: shift(M0, 20) });
ok('L1c', bad.s === 400, 'start month > 12 months ahead refused', `status ${bad.s}`);
// Decided by Payroll (the request's own chain is skipped for the test).
const reqId = sql(`SELECT id FROM advance_requests WHERE employee_id=${EMP} ORDER BY id DESC LIMIT 1`);
sql(`UPDATE advance_requests SET chain_status='approved' WHERE id=${reqId}; UPDATE approval_requests SET status='approved' WHERE source_type='advance_request' AND source_id=${reqId}`);
const dec = await j('POST', `/api/payroll/advance-requests/${reqId}/decision`, SA, { action: 'approve' });
ok('L2', dec.s === 200, 'Payroll approves', `status ${dec.s} ${dec.d?.error || ''}`);
const advId = Number(sql(`SELECT advance_id FROM advance_requests WHERE id=${reqId}`));
ok('L2b', sql(`SELECT CONCAT(disbursement_status,'|',repay_start_month) FROM employee_advances WHERE id=${advId}`) === `pending|${M2}`, 'approved loan waits for payment, wished month carried over');
ok('L2c', Number(sql(`SELECT COUNT(*) FROM alerts WHERE title='Loan Ready to Pay' AND related_id=${advId}`)) > 0, 'Accounts alerted "Loan Ready to Pay"');

// 2. Nothing taken while not paid out.
let pv = await previewLoan(M3);
ok('L3', pv.adv === 0, 'no installment while waiting for payment', `adv ${pv.adv} ${JSON.stringify(pv.raw).slice(0, 120)}`);

// 3. Who may pay it out.
ok('L4', (await j('POST', `/api/payroll/advances/${advId}/disburse`, EMPT, { method: 'cash' })).s === 403, 'employee cannot pay out');
ok('L4b', (await j('POST', `/api/payroll/advances/${advId}/disburse`, ADM, { method: 'cash' })).s === 403, 'Payroll admin without Accounts Pay cannot pay out');
ok('L4c', (await j('POST', `/api/payroll/advances/${advId}/disburse`, SA, { method: 'bank' })).s === 400, 'bank without reference refused');
ok('L4d', (await j('POST', `/api/payroll/advances/${advId}/disburse`, SA, { method: 'cash', date: '2999-01-01' })).s === 400, 'future date refused');
const both = await Promise.all([1, 2, 3].map(() => j('POST', `/api/payroll/advances/${advId}/disburse`, SA, { method: 'bank', reference: 'TRX-1' })));
ok('L5', both.filter((x) => x.s === 200).length === 1, 'three at once — paid out exactly once', both.map((x) => x.s).join(','));
ok('L5b', sql(`SELECT CONCAT(disbursement_status,'|',disbursement_method,'|',repay_start_month) FROM employee_advances WHERE id=${advId}`) === `paid|bank|${M2}`, 'paid out; start month kept at the wish');
ok('L5c', Number(sql(`SELECT COUNT(*) FROM alerts WHERE title='Loan Paid to You' AND related_id=${advId}`)) === 1, 'employee told once');

// 4. Plan: before the start month nothing, then equal installments.
ok('L6', (await previewLoan(M1)).adv === 0, 'month before start: 0');
ok('L6b', (await previewLoan(M2)).adv === 3000, 'start month: 3000 (12000 / 4)');

// 5. Plan changes (Payroll module) — and who may.
ok('L7', (await j('PUT', `/api/payroll/advances/${advId}/plan`, EMPT, { repay_mode: 'lump' })).s === 403, 'employee cannot change the plan');
let pl = await j('PUT', `/api/payroll/advances/${advId}/plan`, SA, { repay_mode: 'custom', repay_start_month: M2, repay_schedule: { [M2]: 2000, [M4]: 5000 } });
ok('L8', pl.s === 400 && /add up/.test(pl.d?.error || ''), 'custom schedule not adding up refused', pl.d?.error);
pl = await j('PUT', `/api/payroll/advances/${advId}/plan`, SA, { repay_mode: 'custom', repay_start_month: M2, repay_schedule: { [M2]: 2000, [M4]: 10000 } });
ok('L9', pl.s === 200, 'custom schedule saved', pl.d?.error);
ok('L9b', (await previewLoan(M2)).adv === 2000 && (await previewLoan(M3)).adv === 0 && (await previewLoan(M4)).adv === 10000, 'custom: M2 2000, M3 0, M4 10000');
ok('L9c', JSON.stringify(pl.d?.plan?.months) === JSON.stringify([{ month: M2, amount: 2000 }, { month: M4, amount: 10000 }]), 'preview matches', JSON.stringify(pl.d?.plan));
pl = await j('PUT', `/api/payroll/advances/${advId}/plan`, SA, { repay_mode: 'equal', monthly_installment: 3000, repay_start_month: M2, skip_months: [M3] });
ok('L10', pl.s === 200 && (await previewLoan(M3)).adv === 0 && (await previewLoan(M4)).adv === 3000, 'equal with a skipped month');
pl = await j('PUT', `/api/payroll/advances/${advId}/plan`, SA, { repay_mode: 'equal', monthly_installment: 3000, repay_start_month: M2, settle_month: M3 });
ok('L11', pl.s === 200 && (await previewLoan(M3)).adv === 12000, 'take everything left in the settle month');
pl = await j('PUT', `/api/payroll/advances/${advId}/plan`, SA, { repay_mode: 'lump', repay_start_month: M1 });
ok('L12', pl.s === 200 && (await previewLoan(M1)).adv === 12000, 'all at once');
ok('L12b', (await j('PUT', `/api/payroll/advances/${advId}/plan`, SA, { repay_mode: 'equal', monthly_installment: 3000, repay_start_month: shift(M0, -1) })).s === 400, "start before the pay-out month refused");
await j('PUT', `/api/payroll/advances/${advId}/plan`, SA, { repay_mode: 'equal', monthly_installment: 3000, repay_start_month: M1 });

// 6. A salary taken and paid: credited to the loan by the plan.
const gen = await j('POST', '/api/payroll/generate', SA, { employee_id: EMP, month_year: M1, total_working_days: 26, present_days: 26 });
ok('L13', gen.s === 200 || gen.s === 201, 'salary of M1 made', `status ${gen.s} ${gen.d?.error || ''}`);
const run = sql(`SELECT CONCAT(id,'|',advance_deduction) FROM payrolls WHERE employee_id=${EMP} AND month_year='${M1}'`).split('|');
ok('L13b', Number(run[1]) === 3000, 'the salary took 3000', run.join('|'));
sql(`UPDATE payrolls SET payment_status='processed' WHERE id=${run[0]}`);
const mp = await j('POST', `/api/payroll/${run[0]}/mark-paid`, SA, {});
ok('L14', mp.s === 200 && Number(sql(`SELECT paid_amount FROM employee_advances WHERE id=${advId}`)) === 3000, 'paying the salary credits 3000 to the loan', `status ${mp.s} ${mp.d?.error || ''}`);
ok('L14b', Number(sql(`SELECT COUNT(*) FROM loan_events WHERE advance_id=${advId} AND event='salary'`)) === 1, 'logged as taken from salary');

// 7. Paid back outside the salary (Accounts Pay).
ok('L15', (await j('POST', `/api/payroll/advances/${advId}/repay`, ADM, { amount: 1000, method: 'cash' })).s === 403, 'Payroll admin without Accounts Pay cannot record a repayment');
ok('L15b', (await j('POST', `/api/payroll/advances/${advId}/repay`, SA, { amount: 99999, method: 'cash' })).s === 400, 'more than what is left refused');
const rp = await Promise.all([1, 2].map(() => j('POST', `/api/payroll/advances/${advId}/repay`, SA, { amount: 4000, method: 'cash' })));
ok('L16', rp.filter((x) => x.s === 200).length === 1 && Number(sql(`SELECT paid_amount FROM employee_advances WHERE id=${advId}`)) === 7000, 'two at once — counted once (3000 + 4000)', rp.map((x) => x.s).join(','));
const fin = await j('POST', `/api/payroll/advances/${advId}/repay`, SA, { amount: 5000, method: 'mfs', reference: 'BK-9' });
ok('L17', fin.s === 200 && sql(`SELECT status FROM employee_advances WHERE id=${advId}`) === 'completed', 'rest paid back — loan completed');

// 8. Delete rules and the employee's view.
ok('L18', (await j('DELETE', `/api/payroll/advances/${advId}`, SA)).s === 400, 'a paid-out loan cannot be deleted');
const man = await j('POST', '/api/payroll/advances', SA, { employee_id: EMP, total_amount: 5000, monthly_installment: 5000, kind: 'advance' });
const manId = man.d?.id;
ok('L19', man.s === 200 && sql(`SELECT disbursement_status FROM employee_advances WHERE id=${manId}`) === 'pending', 'HR-logged advance also waits for payment');
ok('L19b', (await j('DELETE', `/api/payroll/advances/${manId}`, SA)).s === 200, 'not-paid-out one can still be deleted');
const my = await j('GET', '/api/my-loans', EMPT);
const ml = my.d?.loans?.find((l) => l.id === advId);
ok('L20', my.s === 200 && ml?.disbursement_status === 'paid' && ml?.disbursement_method === 'bank' && ml?.events?.length >= 4, 'employee sees pay-out and history', JSON.stringify(ml || my.d).slice(0, 200));
ok('L21', (await j('GET', `/api/payroll/advances/${advId}/detail`, EMPT)).s === 403, "employee can't open Payroll's loan detail");
// Old loans (before this) count as paid out: unchanged behaviour.
sql(`INSERT INTO employee_advances (employee_id,total_amount,monthly_installment,paid_amount,status,kind) VALUES (${EMP},2000,500,0,'active','loan')`);
ok('L22', (await previewLoan(M4)).adv === 500, 'a loan from before this keeps working as before (500 a month)');

const f = R.filter((x) => !x).length;
console.log(`\n${R.length - f}/${R.length} pass`);
process.exit(f ? 1 : 0);
