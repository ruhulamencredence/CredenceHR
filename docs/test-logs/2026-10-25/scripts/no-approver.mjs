// R-01 today: an employee with NO Supervisor and NO Approval Template files a
// Leave, a Conveyance Bill Claim and a Timesheet correction. What happens?
// Observation run (no expected answer) — every line says what the system did.
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3100';
const out = [];
const say = (id, what, result) => { out.push({ id, what, result: String(result).slice(0, 400) }); console.log(`${id.padEnd(5)} ${what}\n      → ${String(result).slice(0, 300)}`); };
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).body.token;
const list = (b) => (Array.isArray(b) ? b : b?.items || b?.rows || b?.requests || b?.applications || b?.claims || []);
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

const SA = await login('admin@credence.test', 'AdminPass123');
const proj = await api(SA, 'POST', '/api/projects', { project_name: 'Head Office', location_lat: 23.7806, location_lng: 90.4074, location_radius: 200, location_label: 'Gulshan' });
await api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
async function person(name, email) {
  const e = await api(SA, 'POST', '/api/employees', { name, designation: 'Head of Sales', department_id: 2, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: 'Pass12345' });
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.body.id}`));
  for (const [route, col] of [['leave-application-access', 'can_view_leave_application'], ['timesheet-access', 'can_view_timesheet'], ['conveyance-claim-access', 'can_view_conveyance_claims']]) await api(SA, 'PUT', `/api/users/${uid}/${route}`, { [col]: true });
  await api(SA, 'PUT', `/api/users/${uid}/feature-permissions`, { can_use_attendance: true });
  sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${uid}, 10, 14, 0)`);
  return { emp: e.body.id, uid, name, token: await login(email, 'Pass12345') };
}
const H = await person('Rafiq Head', 'rafiq.head@credence.test');
// An HR admin with the Approvals module (Edit) and one with Conveyance.
const hrId = (await api(SA, 'POST', '/api/users', { name: 'Nasrin HR', email: 'nasrin.r01@credence.test', password: 'Pass12345x', role: 'admin' })).body.id;
await api(SA, 'PUT', `/api/users/${hrId}/module-permissions`, { modules: ['approvals', 'leave_applications', 'conveyance', 'attendance'] });
await api(SA, 'PUT', `/api/users/${hrId}/module-permission-layers`, { module: 'approvals', layers: ['read', 'edit_add'] });
const HR = await login('nasrin.r01@credence.test', 'Pass12345x');
const cats = (await api(H.token, 'GET', '/api/bill-claim-categories')).body;
const cat = list(cats)[0];
console.log(`Setup: ${H.name} — no Direct Supervisor, Department has no Supervisor, no Approval Template for leave / conveyance / timesheet.\n`);

const leave = await api(H.token, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: day(12), end_date: day(12), purpose: 'Family program' });
const claim = await api(H.token, 'POST', '/api/user-claims', { from_date: day(0), to_date: day(0), items: [{ category_id: cat?.id, bill_date: day(0), amount: 420, description: 'CNG' }], description: 'Client visit' });
const ts = await api(H.token, 'POST', '/api/attendance/corrections', { project_id: proj.body.id, attendance_date: day(-2), check_in_at: `${day(-2)} 09:05:00`, check_out_at: `${day(-2)} 18:00:00`, remarks: 'Forgot to check in' });
const items = [['leave_application', 'Leave', leave, 'leave_applications'], ['user_claim', 'Conveyance Bill Claim', claim, 'user_claims'], ['attendance_correction', 'Timesheet correction', ts, 'attendance_corrections']];
let i = 0;
for (const [type, label, r, table] of items) {
  i++;
  say(`${i}.1`, `${H.name} submits a ${label}`, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  if (r.status >= 300) continue;
  const id = r.body.id;
  say(`${i}.2`, `${label}: its own status, and the approval request`, `${table}.status = ${sql(`SELECT status FROM ${table} WHERE id=${id}`)}; approval_requests: ${sql(`SELECT CONCAT('status=',status,' awaiting_approver=',awaiting_approver,' steps=',total_steps) FROM approval_requests WHERE source_type='${type}' AND source_id=${id}`)}`);
}
// What the employee sees.
const myL = list((await api(H.token, 'GET', '/api/leave-applications/mine')).body)[0];
const myC = list((await api(H.token, 'GET', '/api/user-claims/mine')).body)[0];
const myT = list((await api(H.token, 'GET', '/api/attendance/corrections/mine')).body)[0];
say('4.1', 'What the employee sees on their own pages', `Leave: ${myL?.status} (waiting on: ${JSON.stringify(myL?.current_approvers ?? myL?.pending_with ?? myL?.approval?.current_approvers ?? null)}); Claim: ${myC?.status}; Timesheet: ${myT?.status}`);
// Alerts.
const alertsTo = (uid) => sql(`SELECT COUNT(*) FROM alerts WHERE user_id=${uid} AND title='No approver set'`);
say('4.2', '"No approver set" alerts sent', `Superadmin: ${alertsTo(1)}, HR (Approvals module): ${alertsTo(hrId)}`);
say('4.3', 'What the alert to HR says', sql(`SELECT message FROM alerts WHERE user_id=${hrId} AND title='No approver set' LIMIT 1`));
// Queues.
const saMine = list((await api(SA, 'GET', '/api/my-approvals')).body).filter((r) => items.some(([t]) => t === r.source_type)).length;
const saAdmin = list((await api(SA, 'GET', '/api/approvals')).body).filter((r) => r.status === 'pending' && Number(r.awaiting_approver) === 1);
const hrMine = list((await api(HR, 'GET', '/api/my-approvals')).body).length;
const hrAdmin = list((await api(HR, 'GET', '/api/approvals')).body).filter((r) => r.status === 'pending' && Number(r.awaiting_approver) === 1);
say('5.1', 'Superadmin: Self Service "My Approvals" / Admin Panel → Approvals', `My Approvals: ${saMine} of 3; Admin Panel → Approvals: ${saAdmin.length} of 3 (marked "No approver set yet")`);
say('5.2', 'HR: Self Service "My Approvals" / Admin Panel → Approvals', `My Approvals: ${hrMine}; Admin Panel → Approvals: ${hrAdmin.length} of 3 (UI shows no Approve button for them)`);
const leaveReq = saAdmin.find((r) => r.source_type === 'leave_application');
const hrTry = leaveReq ? await api(HR, 'POST', `/api/approvals/${leaveReq.id}/act`, { action: 'approved', remarks: 'ok' }) : null;
say('5.3', 'HR tries to approve the leave from Admin Panel → Approvals', hrTry ? `${hrTry.status} ${JSON.stringify(hrTry.body)}` : 'not listed');
const direct = await api(HR, 'POST', `/api/leave-applications/${leave.body.id}/decision`, { action: 'approved' });
say('5.4', 'HR tries the old direct Leave decision', `${direct.status} ${JSON.stringify(direct.body).slice(0, 160)}`);
const saTry = leaveReq ? await api(SA, 'POST', `/api/approvals/${leaveReq.id}/act`, { action: 'approved', remarks: 'Approved by Superadmin' }) : null;
say('5.5', 'Superadmin approves the leave from Admin Panel → Approvals', `${saTry?.status} ${JSON.stringify(saTry?.body)}; leave now ${sql(`SELECT status FROM leave_applications WHERE id=${leave.body.id}`)}`);
// Later: a Template appears for conveyance, a Supervisor for the person.
const t = await api(SA, 'POST', '/api/approval-templates', { name: 'Conveyance — 1 layer', request_type: 'conveyance', is_default: true, is_active: true, steps: [{ approver_user_ids: [hrId], approver_type: 'admin', label: 'HR' }] });
await api(HR, 'GET', '/api/my-approvals');
const claimReq = sql(`SELECT CONCAT('awaiting_approver=',awaiting_approver,' template=',IFNULL(template_id,'none')) FROM approval_requests WHERE source_type='user_claim' AND source_id=${claim.body.id}`);
const hrGot = list((await api(HR, 'GET', '/api/my-approvals')).body).some((r) => r.source_type === 'user_claim' && Number(r.source_id) === Number(claim.body.id));
say('6.1', 'Superadmin later adds a Conveyance Template (Layer 1 = HR) — the waiting claim moves?', `template ${t.status}; request now ${claimReq}; in HR's My Approvals: ${hrGot}; HR alerted "Approval waiting on you": ${sql(`SELECT COUNT(*) FROM alerts WHERE user_id=${hrId} AND title='Approval waiting on you'`)}`);
const bossE = await api(SA, 'POST', '/api/employees', { name: 'Karim MD', designation: 'Managing Director', department_id: 5, joining_date: '2020-01-01', email: 'karim.md@credence.test', create_login: true, login_email: 'karim.md@credence.test', login_password: 'Pass12345' });
await api(SA, 'POST', `/api/employees/${H.emp}/supervisors`, { supervisor_id: bossE.body.id, effective_date: '2024-01-01', is_direct: true });
const MD = await login('karim.md@credence.test', 'Pass12345');
const mdGot = list((await api(MD, 'GET', '/api/my-approvals')).body).some((r) => r.source_type === 'attendance_correction' && Number(r.source_id) === Number(ts.body.id));
say('6.2', 'Superadmin later sets a Direct Supervisor (Karim MD) — the waiting timesheet correction moves?', `request now ${sql(`SELECT CONCAT('awaiting_approver=',awaiting_approver,' supervisor_step=',IFNULL(supervisor_step_user_id,'none')) FROM approval_requests WHERE source_type='attendance_correction' AND source_id=${ts.body.id}`)}; in Karim's My Approvals: ${mdGot}`);
fs.writeFileSync(process.argv[2] || 'no-approver.json', JSON.stringify({ when: new Date().toISOString(), observations: out }, null, 1));
