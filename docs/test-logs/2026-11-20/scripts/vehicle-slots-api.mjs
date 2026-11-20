// Vehicles booked by time: a car (and driver) is held only for a ride's own
// time plus the gap (Ride settings, ride_gap_minutes); "on_ride" only while
// a ride is on the road.
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>&1`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json()).token;
const SA = await login('admin@credence.test', 'ProbePass123');
const tag = Date.now().toString(36).slice(-5);
const dept = Number(sql('SELECT MIN(id) FROM departments'));
const PASS = 'Slot#2026pass';
async function person(name, desig) {
  const email = `${name.toLowerCase()}.${tag}@credence.test`;
  const e = await api(SA, 'POST', '/api/employees', { name: `${name} ${tag}`, designation: desig, department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS });
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.b.id}`));
  sql(`UPDATE users SET must_change_password=0 WHERE id=${uid}`);
  return { uid, email, token: await login(email, PASS) };
}
const R = await person('Slotrider', 'Engineer');
const A = await person('Slotapprover', 'Manager');
const T = await person('Slottransport', 'Transport In-charge');
const D1 = await person('Slotdrivera', 'Driver');
const D2 = await person('Slotdriverb', 'Driver');
await api(SA, 'PUT', `/api/users/${T.uid}/role`, { role: 'admin' });
await api(SA, 'PUT', `/api/users/${T.uid}/module-permissions`, { modules: ['vehicle_maintainer', 'vehicle_management'] });
T.token = await login(T.email, PASS);
const V1 = (await api(SA, 'POST', '/api/vehicles', { vehicle_no: `SL1-${tag}`, model: 'Noah', vehicle_type: 'Microbus' })).b.id;
const V2 = (await api(SA, 'POST', '/api/vehicles', { vehicle_no: `SL2-${tag}`, model: 'Axio', vehicle_type: 'Car' })).b.id;
const V3 = (await api(SA, 'POST', '/api/vehicles', { vehicle_no: `SL3-${tag}`, model: 'X-Trail', vehicle_type: 'SUV' })).b.id;
await api(SA, 'PUT', `/api/vehicles/${V3}`, { status: 'maintenance' });
const oldDefault = sql("SELECT IFNULL(GROUP_CONCAT(id),'') FROM approval_templates WHERE request_type='vehicle' AND is_default=1");
sql("UPDATE approval_templates SET is_default=0 WHERE request_type='vehicle'");
const tpl = (await api(SA, 'POST', '/api/approval-templates', { name: `Slots ${tag}`, request_type: 'vehicle', is_default: true, is_active: true, steps: [{ approver_user_ids: [A.uid], approver_type: 'employee', label: 'Check' }, { approver_user_ids: [T.uid], approver_type: 'vehicle_maintainer', label: 'Transport' }] })).b.id;
const s0 = (await api(SA, 'GET', '/api/vehicles/ride-settings')).b;
const setGap = (g) => api(SA, 'PUT', '/api/vehicles/ride-settings', { grace_minutes: s0.grace_minutes, reminder_minutes: s0.reminder_minutes, ride_gap_minutes: g });

// Dhaka clock: a date some days ahead at a fixed time.
const dayAhead = (d) => new Date(Date.now() + 6 * 3600e3 + d * 864e5).toISOString().slice(0, 10);
const D = dayAhead(2);
const book = (date, time, hours, purpose) => api(R.token, 'POST', '/api/vehicles/requisitions', { purpose, pickup_location: 'Head Office', destination: 'Site', ride_date: date, start_time: time, estimated_duration_hours: hours, trip_type: 'round' });
const queueId = async (t, id) => { const b = (await api(t, 'GET', '/api/my-approvals')).b; return (Array.isArray(b) ? b : b?.items || []).find((r) => r.source_type === 'vehicle_requisition' && Number(r.source_id) === Number(id))?.id; };
const ready = async (date, time, hours, purpose) => { const id = (await book(date, time, hours, purpose)).b.id; await api(A.token, 'POST', `/api/my-approvals/${await queueId(A.token, id)}/act`, { action: 'approved' }); return id; };
const give = (id, v, d) => api(T.token, 'PUT', `/api/vehicles/requisitions/${id}/approve-and-assign`, { vehicle_id: v, driver_user_id: d });
const vstatus = (v) => sql(`SELECT status FROM vehicles WHERE id=${v}`);

ok((await setGap(30)).s === 200, 'gap between rides set to 30 min');
let r = await api(SA, 'PUT', '/api/vehicles/ride-settings', { grace_minutes: 30, reminder_minutes: 60, ride_gap_minutes: 9999 });
ok(r.s === 400, 'gap out of range refused');

// A: day after tomorrow 10:00–13:00 on V1 with D1.
const A1 = await ready(D, '10:00', 3, 'A 10-13');
r = await give(A1, V1, D1.uid);
ok(r.s === 200, 'ride A (10:00–13:00) gets V1 + driver 1');
ok(vstatus(V1) === 'available', 'V1 stays "available" — a booked ride does not take it off other times');

// B: same day 13:15–14:00 — inside the 30 min gap.
const B1 = await ready(D, '13:15', 0.75, 'B 13:15');
r = await give(B1, V1, D2.uid);
ok(r.s === 400 && /booked/.test(r.b.error) && /30 min gap/.test(r.b.error), 'ride B at 13:15 can\'t have V1 (inside the gap): ' + (r.b && r.b.error));
r = await give(B1, V2, D1.uid);
ok(r.s === 400 && /driver/.test(r.b.error), 'nor driver 1 (still on ride A + gap): ' + (r.b && r.b.error));
r = await give(B1, V2, D2.uid);
ok(r.s === 200, 'ride B gets V2 + driver 2');

// C: same day 14:00–15:00 on V1 — after A + gap.
const C1 = await ready(D, '14:00', 1, 'C 14-15');
r = await give(C1, V1, D1.uid);
ok(r.s === 200, 'ride C (14:00) gets V1 and driver 1 again (A ends 13:00 + 30 min)');

// D: 08:00–09:45 on V1 — ends 15 min before A starts: refused; gap 0: allowed.
const E1 = await ready(D, '08:00', 1.75, 'E 8-9:45');
r = await give(E1, V1, D2.uid);
ok(r.s === 400, 'ride at 08:00–09:45 refused on V1 (A starts 10:00, gap 30)');
await setGap(0);
r = await give(E1, V1, D2.uid);
ok(r.s === 200, 'with the gap set to 0 it fits');
await setGap(30);

// Maintenance car.
const M1 = await ready(D, '18:00', 1, 'M 18');
r = await give(M1, V3, D2.uid);
ok(r.s === 400 && /maintenance/.test(r.b.error), 'a car in maintenance is refused');

// The pickers' list.
const av = (await api(T.token, 'GET', '/api/vehicles/available')).b;
const v1 = av.find((v) => v.id === V1);
ok(v1 && v1.bookings.length === 3 && v1.gap_minutes === 30 && !av.find((v) => v.id === V3), 'available list: V1 with its 3 bookings and the gap; the maintenance car not listed');
const dp = (await api(T.token, 'GET', '/api/vehicles/driver-picker')).b;
ok(dp.find((d) => d.id === D1.uid)?.bookings.length === 2, 'driver picker: driver 1 with 2 bookings');
const board = (await api(T.token, 'GET', `/api/vehicles/day-board?date=${D}`)).b;
ok(board.date === D && board.vehicles.find((v) => v.id === V1)?.rides.length === 3 && board.vehicles.find((v) => v.id === V3)?.status === 'maintenance', 'day board: V1 with 3 rides that day, V3 shows maintenance');

// Race: two overlapping rides given V2 at the same instant.
const X1 = await ready(D, '16:00', 1, 'X1'), X2 = await ready(D, '16:30', 1, 'X2');
const both = await Promise.all([give(X1, V2, D1.uid), give(X2, V2, D2.uid)]);
ok(both.filter((x) => x.s === 200).length === 1, 'two overlapping rides given V2 at once: only one gets it (' + both.map((x) => x.s).join(',') + ')');

// On the road: a ride 20 min from now.
const soon = new Date(Date.now() + 6 * 3600e3 + 20 * 60e3);
const today = soon.toISOString().slice(0, 10);
const S1 = await ready(today, soon.toISOString().slice(11, 16), 1, 'soon');
r = await give(S1, V1, D2.uid);
ok(r.s === 200, 'a ride today, 20 min from now, gets V1 (the other bookings are days away)');
r = await api(D2.token, 'POST', `/api/vehicles/requisitions/${S1}/start`, {});
ok(r.s === 200 && vstatus(V1) === 'on_ride', 'Start Ride → V1 "on_ride"');
// A ride later today on V1 while it is on the road but not overlapping.
const later = new Date(Date.now() + 6 * 3600e3 + 4 * 3600e3);
if (later.toISOString().slice(0, 10) === today) {
  const L1 = await ready(today, later.toISOString().slice(11, 16), 1, 'later today');
  r = await give(L1, V1, D1.uid);
  ok(r.s === 200, 'a car on the road can still be given a later ride today');
  await api(T.token, 'POST', `/api/vehicles/requisitions/${L1}/cancel`, { reason: 'test' });
}
// Starting another of V1's rides while it is on the road (Vehicle Management, early, with a reason).
r = await api(T.token, 'POST', `/api/vehicles/requisitions/${A1}/start`, { early_reason: 'testing the car rule' });
ok(r.s === 400 && r.b.code === 'car_on_road', 'another ride on V1 can\'t start while V1 is on the road');
r = await api(D2.token, 'POST', `/api/vehicles/requisitions/${S1}/complete`, {});
ok(r.s === 200 && vstatus(V1) === 'available', 'Completed → V1 "available"');

// Cancel a booked ride: the car stays available and the time is free.
r = await api(T.token, 'POST', `/api/vehicles/requisitions/${A1}/cancel`, { reason: 'plans changed' });
ok(r.s === 200 && vstatus(V1) === 'available', 'cancel ride A: V1 still available');
const N1 = await ready(D, '10:30', 1, 'after cancel');
r = await give(N1, V1, D1.uid);
ok(r.s === 200, 'the 10:00–13:00 time on V1 is free again after the cancel (' + r.s + ' ' + JSON.stringify(r.b) + ')');

// Clean up: cancel what's left of this run, restore settings and template.
for (const id of [B1, C1, E1, M1, X1, X2, N1]) await api(T.token, 'POST', `/api/vehicles/requisitions/${id}/cancel`, { reason: 'test done' });
await setGap(s0.ride_gap_minutes ?? 30);
sql(`UPDATE approval_templates SET is_default=0, is_active=0 WHERE id=${tpl}`);
if (oldDefault) sql(`UPDATE approval_templates SET is_default=1 WHERE id IN (${oldDefault})`);
sql(`UPDATE vehicles SET status='retired' WHERE id IN (${V1},${V2},${V3})`);
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
