// Vehicle rides: Start Ride only from N minutes before the start time (Ride
// settings, start_early_minutes); earlier only by Vehicle Management / a
// Vehicle Maintainer with a reason. A ride request is never rejected
// without a reason (server, every path).
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>&1`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json()).token;
const SA = await login('admin@credence.test', 'ProbePass123');
const tag = Date.now().toString(36).slice(-5);
const dept = Number(sql('SELECT MIN(id) FROM departments'));
const PASS = 'Ride#2026pass';
async function person(name, desig) {
  const email = `${name.split(' ')[0].toLowerCase()}.${tag}@credence.test`;
  const e = await api(SA, 'POST', '/api/employees', { name: `${name} ${tag}`, designation: desig, department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS });
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.b.id}`));
  sql(`UPDATE users SET must_change_password=0 WHERE id=${uid}`);
  return { emp: e.b.id, uid, email, token: await login(email, PASS) };
}
const R = await person('Rider', 'Engineer');
const A = await person('Approver', 'Manager');
const T = await person('Transport', 'Transport In-charge');
const D = await person('Driver', 'Driver');
await api(SA, 'PUT', `/api/users/${T.uid}/role`, { role: 'admin' });
await api(SA, 'PUT', `/api/users/${T.uid}/module-permissions`, { modules: ['vehicle_maintainer', 'vehicle_management'] });
T.token = await login(T.email, PASS);
const veh = (await api(SA, 'POST', '/api/vehicles', { vehicle_no: `TST-${tag}`, model: 'Test car', vehicle_type: 'Car' })).b.id;
const oldDefault = sql("SELECT IFNULL(GROUP_CONCAT(id),'') FROM approval_templates WHERE request_type='vehicle' AND is_default=1");
sql("UPDATE approval_templates SET is_default=0 WHERE request_type='vehicle'");
const tpl = (await api(SA, 'POST', '/api/approval-templates', { name: `Ride test ${tag}`, request_type: 'vehicle', is_default: true, is_active: true, steps: [{ approver_user_ids: [A.uid], approver_type: 'employee', label: 'Check' }, { approver_user_ids: [T.uid], approver_type: 'vehicle_maintainer', label: 'Transport' }] })).b.id;

const dhaka = (ms) => new Date(Date.now() + 6 * 3600e3 + ms);
const at = (ms) => ({ ride_date: dhaka(ms).toISOString().slice(0, 10), start_time: dhaka(ms).toISOString().slice(11, 16) });
const book = (ms, purpose) => api(R.token, 'POST', '/api/vehicles/requisitions', { purpose, pickup_location: 'Head Office', destination: 'Site', ...at(ms), estimated_duration_hours: 1, trip_type: 'round' });
const queueId = async (t, id) => { const b = (await api(t, 'GET', '/api/my-approvals')).b; return (Array.isArray(b) ? b : b?.items || []).find((r) => r.source_type === 'vehicle_requisition' && Number(r.source_id) === Number(id))?.id; };
const act = async (t, id, action, remarks) => { const q = await queueId(t, id); return q ? api(t, 'POST', `/api/my-approvals/${q}/act`, { action, remarks }) : { s: 404, b: 'not in queue' }; };
const ready = async (ms, purpose) => { const id = (await book(ms, purpose)).b.id; await act(A.token, id, 'approved', 'ok'); return id; };

// ---- 3. Reject needs a reason ----
let id = (await book(3 * 3600e3, 'reject test')).b.id;
let r = await act(A.token, id, 'rejected', '');
ok(r.s === 400 && /why/i.test(r.b.error) && sql(`SELECT status FROM vehicle_requisitions WHERE id=${id}`) === 'pending', 'reject without a reason is refused, request still pending (' + r.s + ')');
r = await act(A.token, id, 'rejected', '   ');
ok(r.s === 400, 'spaces only is not a reason');
r = await act(A.token, id, 'rejected', 'Take the office CNG, no car free');
ok(r.s === 200 && sql(`SELECT status FROM vehicle_requisitions WHERE id=${id}`) === 'rejected', 'reject with a reason works');
id = await ready(3 * 3600e3, 'maintainer reject');
r = await act(T.token, id, 'rejected', '');
ok(r.s === 400, 'the Vehicle Maintainer Layer can\'t reject without a reason either');
r = await act(A.token, (await book(4 * 3600e3, 'approve no remark')).b.id, 'approved', '');
ok(r.s === 200, 'approving still needs no remark');

// ---- 2. Start Ride window ----
const s0 = await api(SA, 'GET', '/api/vehicles/ride-settings');
ok(s0.s === 200 && s0.b.start_early_minutes === 30, 'Ride settings: Start Ride from 30 min before by default');
r = await api(SA, 'PUT', '/api/vehicles/ride-settings', { grace_minutes: s0.b.grace_minutes, reminder_minutes: s0.b.reminder_minutes });
ok(r.s === 200 && r.b.start_early_minutes === 30, 'an older page that does not send it keeps the saved value');
r = await api(T.token, 'PUT', '/api/vehicles/ride-settings', { grace_minutes: 30, reminder_minutes: 60, start_early_minutes: 5 });
ok(r.s === 403, 'only the Superadmin changes it');
r = await api(SA, 'PUT', '/api/vehicles/ride-settings', { grace_minutes: s0.b.grace_minutes, reminder_minutes: s0.b.reminder_minutes, start_early_minutes: 2000 });
ok(r.s === 400, 'out of range refused');

// A ride tomorrow, given the car.
const far = await ready(26 * 3600e3, 'tomorrow');
r = await api(T.token, 'PUT', `/api/vehicles/requisitions/${far}/approve-and-assign`, { vehicle_id: veh, driver_user_id: D.uid });
ok(r.s === 200, 'tomorrow\'s ride gets a car and driver');
r = await api(D.token, 'POST', `/api/vehicles/requisitions/${far}/start`, {});
ok(r.s === 400 && r.b.code === 'too_early' && r.b.can_override === false && /can be started from/.test(r.b.error), 'the driver can\'t start it a day early (' + (r.b && r.b.error) + ')');
r = await api(D.token, 'POST', `/api/vehicles/requisitions/${far}/start`, { early_reason: 'I want to' });
ok(r.s === 400, '…not even with a reason');
r = await api(T.token, 'POST', `/api/vehicles/requisitions/${far}/start`, {});
ok(r.s === 400 && r.b.can_override === true && /write why/i.test(r.b.error), 'Vehicle Management is asked why');
r = await api(T.token, 'POST', `/api/vehicles/requisitions/${far}/start`, { early_reason: 'MD asked to leave early' });
ok(r.s === 200 && sql(`SELECT status FROM vehicle_requisitions WHERE id=${far}`) === 'ongoing', 'with a reason Vehicle Management starts it');
ok(/MD asked to leave early/.test(sql(`SELECT early_start_reason FROM vehicle_requisitions WHERE id=${far}`)), 'the reason and who started it are kept');
await api(D.token, 'POST', `/api/vehicles/requisitions/${far}/complete`, {});
ok(sql(`SELECT status FROM vehicles WHERE id=${veh}`) === 'available', 'completed, car free again');

// A ride in 20 minutes: inside the window, the driver starts it.
const soon = await ready(20 * 60e3, 'soon');
await api(T.token, 'PUT', `/api/vehicles/requisitions/${soon}/approve-and-assign`, { vehicle_id: veh, driver_user_id: D.uid });
r = await api(D.token, 'POST', `/api/vehicles/requisitions/${soon}/start`, {});
ok(r.s === 200, 'a ride 20 min away: the driver starts it (inside the 30 min window)');
ok(sql(`SELECT IFNULL(early_start_reason,'none') FROM vehicle_requisitions WHERE id=${soon}`) === 'none', 'no early reason recorded for it');
await api(D.token, 'POST', `/api/vehicles/requisitions/${soon}/complete`, {});

// Window set to 0: a ride 20 min away can no longer be started by the driver.
await api(SA, 'PUT', '/api/vehicles/ride-settings', { grace_minutes: s0.b.grace_minutes, reminder_minutes: s0.b.reminder_minutes, start_early_minutes: 0 });
const soon2 = await ready(20 * 60e3, 'soon2');
await api(T.token, 'PUT', `/api/vehicles/requisitions/${soon2}/approve-and-assign`, { vehicle_id: veh, driver_user_id: D.uid });
r = await api(D.token, 'POST', `/api/vehicles/requisitions/${soon2}/start`, {});
ok(r.s === 400 && r.b.code === 'too_early', 'window 0: only at the start time');
await api(T.token, 'POST', `/api/vehicles/requisitions/${soon2}/cancel`, { reason: 'test done' });

// ---- clean up ----
await api(SA, 'PUT', '/api/vehicles/ride-settings', { grace_minutes: s0.b.grace_minutes, reminder_minutes: s0.b.reminder_minutes, start_early_minutes: 30 });
sql(`UPDATE approval_templates SET is_default=0, is_active=0 WHERE id=${tpl}`);
sql(`UPDATE vehicles SET status='retired' WHERE id=${veh}`);
if (oldDefault) sql(`UPDATE approval_templates SET is_default=1 WHERE id IN (${oldDefault})`);
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
