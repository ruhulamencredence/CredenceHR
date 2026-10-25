// Approval routing for a Supervisor's own requests.
// Plan: an employee's request goes to their Supervisor first, then the
// Approval Template layers. A Supervisor's OWN request (no one above them)
// skips the Supervisor step and goes straight to the Template layers.
// Leave, Conveyance Bill Claim and Timesheet correction, each with a
// two-layer Template (Layer 1 -> Layer 2).
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3100';
const R = [];
const rec = (id, ok, name, detail = '') => { R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 400) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + String(detail).slice(0, 300) : ''}`); };
const note = (s) => { R.push({ id: '', status: 'STEP', name: s }); console.log('     ' + s); };
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const ok = (r) => r.status >= 200 && r.status < 300;
const J = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const queue = async (tok) => { const l = await api(tok, 'GET', '/api/my-approvals'); return Array.isArray(l.body) ? l.body : l.body?.items || l.body?.rows || []; };
const findIn = async (tok, type, id) => (await queue(tok)).find((r) => r.source_type === type && Number(r.source_id) === Number(id));
const act = async (tok, type, id) => { const row = await findIn(tok, type, id); return row ? api(tok, 'POST', `/api/my-approvals/${row.id}/act`, { action: 'approved', remarks: 'OK' }) : { status: 404, body: 'not in queue' }; };
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

const SA = await login('admin@credence.test', 'AdminPass123');
// ---------------- setup ----------------
const proj = await api(SA, 'POST', '/api/projects', { project_name: 'Head Office', location_lat: 23.7806, location_lng: 90.4074, location_radius: 200, location_label: 'Gulshan' });
await api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
async function person(name, email, designation) {
  const e = await api(SA, 'POST', '/api/employees', { name, designation, department_id: 2, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: 'Pass12345' });
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.body.id}`));
  for (const [route, col] of [['leave-application-access', 'can_view_leave_application'], ['timesheet-access', 'can_view_timesheet'], ['conveyance-claim-access', 'can_view_conveyance_claims']]) await api(SA, 'PUT', `/api/users/${uid}/${route}`, { [col]: true });
  await api(SA, 'PUT', `/api/users/${uid}/feature-permissions`, { can_use_attendance: true });
  sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${uid}, 10, 14, 0)`);
  return { emp: e.body.id, uid, name, token: await login(email, 'Pass12345') };
}
const SUP = await person('Selim Supervisor', 'selim.sup@credence.test', 'MIS Manager');
const EMP = await person('Mitu Team Member', 'mitu.emp@credence.test', 'MIS Officer');
const L1 = await person('Layer One (HR Manager)', 'layer.one@credence.test', 'HR Manager');
const L2 = await person('Layer Two (Director)', 'layer.two@credence.test', 'Director');
const sup = await api(SA, 'POST', `/api/employees/${EMP.emp}/supervisors`, { supervisor_id: SUP.emp, effective_date: '2024-01-01', is_direct: true });
note(`Setup: ${SUP.name} supervises ${EMP.name} (${sup.status}); ${SUP.name} has no supervisor; department has no Department Supervisor`);
const tpl = {};
for (const t of ['leave', 'conveyance', 'timesheet']) {
  const r = await api(SA, 'POST', '/api/approval-templates', { name: `${t} — 2 layers`, request_type: t, is_default: true, is_active: true, steps: [{ approver_user_ids: [L1.uid], approver_type: 'employee', label: 'Layer 1' }, { approver_user_ids: [L2.uid], approver_type: 'employee', label: 'Layer 2' }] });
  tpl[t] = r.body?.id;
  note(`Template "${t}": Layer 1 = ${L1.name}, Layer 2 = ${L2.name} (${r.status})`);
}
const cats = (await api(SUP.token, 'GET', '/api/bill-claim-categories')).body;
const cat = (Array.isArray(cats) ? cats : cats.categories || [])[0];

// ---------------- submit three requests ----------------
async function submitAll(P, tag, offset) {
  const leave = await api(P.token, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: day(10 + offset), end_date: day(10 + offset), purpose: `${tag} leave` });
  const claim = await api(P.token, 'POST', '/api/user-claims', { from_date: day(0), to_date: day(0), items: [{ category_id: cat?.id, bill_date: day(0), amount: 350 + offset, description: `${tag} CNG` }], description: `${tag} client visit` });
  const ts = await api(P.token, 'POST', '/api/attendance/corrections', { project_id: proj.body.id, attendance_date: day(-2 - offset), check_in_at: `${day(-2 - offset)} 09:05:00`, check_out_at: `${day(-2 - offset)} 18:00:00`, remarks: `${tag} forgot to check in` });
  return [['leave_application', 'Leave', leave], ['user_claim', 'Conveyance Bill Claim', claim], ['attendance_correction', 'Timesheet correction', ts]];
}
const status = (type, id) => sql(type === 'leave_application' ? `SELECT status FROM leave_applications WHERE id=${id}` : type === 'user_claim' ? `SELECT status FROM user_claims WHERE id=${id}` : `SELECT status FROM attendance_corrections WHERE id=${id}`);
const reqRow = (type, id) => sql(`SELECT CONCAT('steps=',total_steps,' supervisor_step=',IFNULL(supervisor_step_user_id,'none'),' template=',IFNULL(template_id,'none'),' awaiting=',awaiting_approver) FROM approval_requests WHERE source_type='${type}' AND source_id=${id}`);

console.log('\n=== A. The Supervisor\'s own requests ===');
let n = 0;
for (const [type, label, r] of await submitAll(SUP, 'Supervisor', 0)) {
  n++;
  rec(`A${n}.1`, ok(r), `${SUP.name} submits a ${label}`, J(r));
  if (!ok(r)) continue;
  const id = r.body.id;
  const row = reqRow(type, id);
  rec(`A${n}.2`, /steps=2 supervisor_step=none/.test(row), `${label}: no Supervisor step, the 2 Template layers only`, row);
  rec(`A${n}.3`, !(await findIn(SUP.token, type, id)), `${label}: not in ${SUP.name}'s own queue (can't approve it himself)`);
  rec(`A${n}.4`, !!(await findIn(L1.token, type, id)) && !(await findIn(L2.token, type, id)), `${label}: waiting on Layer 1 (${L1.name}), not yet on Layer 2`);
  const a1 = await act(L1.token, type, id);
  rec(`A${n}.5`, ok(a1) && status(type, id) === 'pending' && !!(await findIn(L2.token, type, id)), `${label}: Layer 1 approves → moves to Layer 2, still pending`, `${J(a1)}; status ${status(type, id)}`);
  const a2 = await act(L2.token, type, id);
  rec(`A${n}.6`, ok(a2) && status(type, id) === 'approved', `${label}: Layer 2 approves → Approved`, `${J(a2)}; status ${status(type, id)}`);
}

console.log('\n=== B. Control: a team member\'s requests (Supervisor first) ===');
n = 0;
for (const [type, label, r] of await submitAll(EMP, 'Team member', 1)) {
  n++;
  rec(`B${n}.1`, ok(r), `${EMP.name} submits a ${label}`, J(r));
  if (!ok(r)) continue;
  const id = r.body.id;
  const row = reqRow(type, id);
  rec(`B${n}.2`, row.includes(`steps=3 supervisor_step=${SUP.uid}`), `${label}: Supervisor step + 2 Template layers`, row);
  rec(`B${n}.3`, !!(await findIn(SUP.token, type, id)) && !(await findIn(L1.token, type, id)), `${label}: waiting on ${SUP.name} first`);
  const s1 = await act(SUP.token, type, id);
  rec(`B${n}.4`, ok(s1) && !!(await findIn(L1.token, type, id)), `${label}: Supervisor approves → Layer 1`, J(s1));
  const a1 = await act(L1.token, type, id);
  rec(`B${n}.5`, ok(a1) && !!(await findIn(L2.token, type, id)), `${label}: Layer 1 approves → Layer 2`, J(a1));
  const a2 = await act(L2.token, type, id);
  rec(`B${n}.6`, ok(a2) && status(type, id) === 'approved', `${label}: Layer 2 approves → Approved`, `${J(a2)}; status ${status(type, id)}`);
}

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'supervisor-chain.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
