// QA: two people (or one double-click) doing the same thing at the same moment.
// Each check fires the same request several times in parallel and looks at
// what the database ended up with — money paid once, a layer cleared once.
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3100';
const R = [];
const T = (id, ok, name, detail = '') => { R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 400) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + String(detail).slice(0, 300) : ''}`); };
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const ok = (r) => r.status >= 200 && r.status < 300;
const codes = (rs) => rs.map((r) => r.status).join(',');
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const burst = (n, f) => Promise.all(Array.from({ length: n }, () => f()));
const SA = await login('admin@credence.test', 'AdminPass123');

async function person(name, email) {
  const e = await api(SA, 'POST', '/api/employees', { name, designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: 'Pass12345' });
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.body.id}`));
  for (const [route, col] of [['leave-application-access', 'can_view_leave_application'], ['conveyance-claim-access', 'can_view_conveyance_claims']]) await api(SA, 'PUT', `/api/users/${uid}/${route}`, { [col]: true });
  sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${uid}, 10, 14, 0)`);
  return { emp: e.body.id, uid, token: await login(email, 'Pass12345') };
}
const E = await person('Race Employee', 'race.emp@credence.test');
const A = await person('Approver A', 'race.a@credence.test');
const B = await person('Approver B', 'race.b@credence.test');
const C = await person('Approver C', 'race.c@credence.test');
await api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
for (const t of ['leave', 'conveyance']) await api(SA, 'POST', '/api/approval-templates', { name: `${t} race`, request_type: t, is_default: true, is_active: true, steps: [{ approver_user_ids: [A.uid, B.uid], approver_type: 'employee' }, { approver_user_ids: [C.uid], approver_type: 'employee' }] });
const queueRow = async (tok, type, id) => { const l = await api(tok, 'GET', '/api/my-approvals'); return (Array.isArray(l.body) ? l.body : l.body.items || []).find((r) => r.source_type === type && Number(r.source_id) === Number(id)); };

// C1 — the same leave submitted 5 times at once.
const leaves = await burst(5, () => api(E.token, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: day(20), end_date: day(20), purpose: 'race' }));
const made = Number(sql(`SELECT COUNT(*) FROM leave_applications la JOIN users u ON u.id = la.user_id WHERE u.email='race.emp@credence.test' AND la.start_date='${day(20)}'`));
const bal = sql(`SELECT casual_leave FROM leave_balances WHERE user_id=${E.uid}`);
T('C1', made === 1, 'The same leave sent 5 times at once is created once', `created ${made}; answers ${codes(leaves)}; casual balance now ${bal}`);
const leaveId = leaves.find(ok)?.body?.id;

// C2 — both Layer-1 approvers press Approve at the same moment.
const ra = await queueRow(A.token, 'leave_application', leaveId);
const [x, y] = await Promise.all([api(A.token, 'POST', `/api/my-approvals/${ra?.id}/act`, { action: 'approved', remarks: 'A' }), api(B.token, 'POST', `/api/my-approvals/${ra?.id}/act`, { action: 'approved', remarks: 'B' })]);
const st = sql(`SELECT CONCAT(status,' step ',current_step,'/',total_steps) FROM approval_requests WHERE id=${ra?.id}`);
const layer1Acts = (JSON.parse(sql(`SELECT actions_json FROM approval_requests WHERE id=${ra?.id}`) || '[]')).length;
T('C2', st === 'pending step 2/2' && layer1Acts === 1 && sql(`SELECT status FROM leave_applications WHERE id=${leaveId}`) === 'pending', 'Two Layer-1 approvers at once: the request moves to Layer 2 once (Layer 2 is not skipped)', `answers ${x.status},${y.status}; request ${st}; actions recorded ${layer1Acts}`);

// C3 — Layer 2 double-clicks Approve.
const rc = await queueRow(C.token, 'leave_application', leaveId);
const dbl = await burst(3, () => api(C.token, 'POST', `/api/my-approvals/${rc?.id}/act`, { action: 'approved', remarks: 'C' }));
const acts = (JSON.parse(sql(`SELECT actions_json FROM approval_requests WHERE id=${ra?.id}`) || '[]')).length;
T('C3', dbl.filter(ok).length === 1 && acts === 2 && sql(`SELECT status FROM leave_applications WHERE id=${leaveId}`) === 'approved', 'A double-click on the final Approve counts once', `answers ${codes(dbl)}; actions ${acts}; balance ${sql(`SELECT casual_leave FROM leave_balances WHERE user_id=${E.uid}`)}`);

// C4 — the same payroll run generated 5 times at once.
await api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: E.emp, effective_date: '2026-01-01', basic_salary: 30000, house_rent: 15000, medical_allowance: 3000, conveyance_allowance: 2000 });
await api(SA, 'POST', '/api/payroll/advances', { employee_id: E.emp, total_amount: 10000, monthly_installment: 2000, reason: 'race' });
const gens = await burst(5, () => api(SA, 'POST', '/api/payroll/generate', { employee_id: E.emp, month_year: '2026-09', total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0 }));
const runs = Number(sql(`SELECT COUNT(*) FROM payrolls WHERE employee_id=${E.emp} AND month_year='2026-09'`));
T('C4', runs === 1 && gens.every((g) => g.status < 500), 'Payroll run 5 times at once makes one salary (others refused, no server error)', `rows ${runs}; answers ${codes(gens)}`);

// C5 — Accounts presses Pay twice at the same moment.
await api(SA, 'POST', '/api/payroll/approval/2026-09/submit', {});
await api(SA, 'POST', '/api/payroll/approval/2026-09/approve', {});
const pays = await burst(3, () => api(SA, 'POST', '/api/payroll/approval/2026-09/pay', { payment_date: '2026-09-30', payment_method: 'Bank Transfer', payment_reference: 'RACE' }));
const recovered = sql(`SELECT paid_amount FROM employee_advances WHERE employee_id=${E.emp}`);
const paidEvents = Number(sql(`SELECT COUNT(*) FROM payroll_batch_events e JOIN payroll_batches b ON b.id=e.batch_id WHERE b.month_year='2026-09' AND e.action='paid'`));
T('C5', Number(recovered) === 2000 && paidEvents === 1, 'Pay pressed 3 times at once: paid once, the loan installment recovered once', `answers ${codes(pays)}; loan recovered ${recovered} (should be 2000); 'paid' events ${paidEvents}`);

// C6 — two conveyance claims for the same day at once (one claim a day).
const cats = (await api(E.token, 'GET', '/api/bill-claim-categories')).body;
const cat = (Array.isArray(cats) ? cats : cats.categories || [])[0];
const claims = await burst(3, () => api(E.token, 'POST', '/api/user-claims', { from_date: day(0), to_date: day(0), items: [{ category_id: cat?.id, bill_date: day(0), amount: 300, description: 'race' }], description: 'race' }));
const claimRows = Number(sql(`SELECT COUNT(*) FROM user_claims WHERE user_id=${E.uid}`));
T('C6', claimRows === 1, 'Three Conveyance claims for today sent at once: one is kept (one claim a day)', `rows ${claimRows}; answers ${codes(claims)}`);

// C7 — the approved claim's bill disbursed 3 times at once.
const claimId = claims.find(ok)?.body?.id;
for (const tok of [A.token, C.token]) { const r = await queueRow(tok, 'user_claim', claimId); if (r) await api(tok, 'POST', `/api/my-approvals/${r.id}/act`, { action: 'approved', remarks: 'ok' }); }
const billId = sql(`SELECT IFNULL(MAX(bill_id),0) FROM conveyance_bill_items WHERE user_claim_id=${claimId}`).trim() || sql(`SELECT IFNULL(MAX(id),0) FROM conveyance_bills`);
const dis = await burst(3, () => api(SA, 'POST', `/api/conveyance-bills/${billId}/disburse`, {}));
const vouchers = sql(`SELECT CONCAT(is_disbursed,' ',IFNULL(voucher_no,'')) FROM conveyance_bills WHERE id=${billId}`);
T('C7', dis.filter(ok).length === 1, 'A bill disbursed 3 times at once is paid out once', `claim ${sql(`SELECT status FROM user_claims WHERE id=${claimId}`)}; bill #${billId}; answers ${codes(dis)}; bill now ${vouchers}`);

// C8 — a loan request sent 3 times at once, then approved 3 times at once.
const L = await person('Loan Person', 'race.loan@credence.test');
await api(SA, 'PUT', `/api/users/${L.uid}/loan-request-access`, { can_view_loan_request: true });
const L2 = await login('race.loan@credence.test', 'Pass12345');
const lr = await burst(3, () => api(L2, 'POST', '/api/my-loans/requests', { kind: 'loan', total_amount: 12000, installments: 6, reason: 'race' }));
const reqs = Number(sql(`SELECT COUNT(*) FROM advance_requests WHERE employee_id=${L.emp}`));
T('C8', reqs === 1, 'A loan request sent 3 times at once is filed once', `requests ${reqs}; answers ${codes(lr)}`);
const lid = sql(`SELECT MIN(id) FROM advance_requests WHERE employee_id=${L.emp}`);
// No Supervisor / Template for loans here, so it is the Superadmin's to decide (My Approvals).
const lrow = await queueRow(SA, 'advance_request', lid);
const dec = await burst(3, () => api(SA, 'POST', `/api/my-approvals/${lrow?.id}/act`, { action: 'approved', remarks: 'ok' }));
const direct = await api(SA, 'POST', `/api/payroll/advance-requests/${lid}/decision`, { action: 'approve' });
const given = Number(sql(`SELECT COUNT(*) FROM employee_advances WHERE employee_id=${L.emp}`));
T('C9', given === 1 && dec.every((d) => d.status < 500), 'The loan approved 3 times at once is given once', `loans given ${given}; answers ${codes(dec)}; Payroll decision afterwards ${direct.status}`);

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'qa-concurrency.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
