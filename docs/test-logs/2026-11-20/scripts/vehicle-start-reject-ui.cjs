// Screens: the driver presses Start Ride a day early (told when it opens); Vehicle
// Management starts it early through the "why" popup; Approve Application won't
// reject a ride without a reason.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Ride#2026pass';
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const clickText = (p, t) => p.evaluate((t) => { const el = [...document.querySelectorAll('button, a, span, div')].find((e) => e.textContent.trim() === t && e.offsetParent !== null); if (el) (el.closest('button, a') || el).click(); return !!el; }, t);
(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const person = async (name, desig) => {
    const email = `${name.toLowerCase()}.${tag}@credence.test`;
    const e = await api(SA, 'POST', '/api/employees', { name: `${name} ${tag}`, designation: desig, department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS });
    const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.b.id}`));
    sql(`UPDATE users SET must_change_password=0 WHERE id=${uid}`);
    return { uid, email };
  };
  const R = await person('Riderui', 'Engineer'), A = await person('Approverui', 'Manager'), T = await person('Transportui', 'Transport In-charge'), D = await person('Driverui', 'Driver');
  await api(SA, 'PUT', `/api/users/${T.uid}/role`, { role: 'admin' });
  await api(SA, 'PUT', `/api/users/${T.uid}/module-permissions`, { modules: ['vehicle_maintainer', 'vehicle_management'] });
  const tok = async (x) => (await login(x.email, PASS)).token;
  const [Rt, At, Tt] = [await tok(R), await tok(A), await tok(T)];
  const veh = (await api(SA, 'POST', '/api/vehicles', { vehicle_no: `UI-${tag}`, model: 'UI car', vehicle_type: 'Car' })).b.id;
  const oldDefault = sql("SELECT IFNULL(GROUP_CONCAT(id),'') FROM approval_templates WHERE request_type='vehicle' AND is_default=1");
  sql("UPDATE approval_templates SET is_default=0 WHERE request_type='vehicle'");
  const tpl = (await api(SA, 'POST', '/api/approval-templates', { name: `Ride UI ${tag}`, request_type: 'vehicle', is_default: true, is_active: true, steps: [{ approver_user_ids: [A.uid], approver_type: 'employee', label: 'Check' }, { approver_user_ids: [T.uid], approver_type: 'vehicle_maintainer', label: 'Transport' }] })).b.id;
  const when = new Date(Date.now() + 6 * 3600e3 + 26 * 3600e3);
  const book = async (purpose) => (await api(Rt, 'POST', '/api/vehicles/requisitions', { purpose, pickup_location: 'Head Office', destination: 'Uttara Site', ride_date: when.toISOString().slice(0, 10), start_time: when.toISOString().slice(11, 16), estimated_duration_hours: 1, trip_type: 'round' })).b.id;
  const q = async (t, id) => { const b = (await api(t, 'GET', '/api/my-approvals')).b; return (Array.isArray(b) ? b : b?.items || []).find((r) => r.source_type === 'vehicle_requisition' && Number(r.source_id) === Number(id))?.id; };
  const ride = await book('UI early start');
  await api(At, 'POST', `/api/my-approvals/${await q(At, ride)}/act`, { action: 'approved' });
  await api(Tt, 'PUT', `/api/vehicles/requisitions/${ride}/approve-and-assign`, { vehicle_id: veh, driver_user_id: D.uid });
  const toReject = await book('UI reject');

  const b = await chromium.launch();
  const open = async (x, phone) => {
    const a = await login(x.email, PASS);
    const ctx = await b.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(String(e))); return p;
  };

  // Driver, phone: Start Ride a day early.
  let p = await open(D, true);
  await p.goto(B + '/'); await p.waitForTimeout(6000);
  await clickText(p, 'Book a Ride'); await p.waitForTimeout(2500);
  await p.getByText('My rides').first().click(); await p.waitForTimeout(2000);
  await p.getByText('My Trips').first().click().catch(() => p.getByText('Trips').first().click()); await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Start Ride' }).first().click(); await p.waitForTimeout(2000);
  ok(await p.getByText(/it can be started from/).first().isVisible(), 'driver: told when the ride can be started');
  ok(sql(`SELECT status FROM vehicle_requisitions WHERE id=${ride}`) === 'assigned', 'driver: ride not started');
  await p.screenshot({ path: '/tmp/claude-0/sb/v-driver-early.png' });
  ok(p.errs.length === 0, 'driver: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();

  // Vehicle Management: Ride Requests -> Start Ride -> why popup.
  p = await open(T, false);
  await p.goto(B + '/admin/vehicle-management'); await p.waitForTimeout(7000);
  const card = p.locator('div.border.rounded-lg').filter({ hasText: 'UI early start' }).first();
  await card.getByRole('button', { name: /Start Ride/ }).first().click(); await p.waitForTimeout(1500);
  const dlg = p.getByRole('dialog', { name: 'Start this ride early?' });
  ok(await dlg.isVisible(), 'Vehicle Management: "Start this ride early?" popup with the time');
  ok(await dlg.getByRole('button', { name: 'Start now' }).isDisabled(), 'Start now stays off until a reason is typed');
  await dlg.getByRole('textbox').fill('Guest arrived early');
  await p.screenshot({ path: '/tmp/claude-0/sb/v-early-popup.png' });
  await dlg.getByRole('button', { name: 'Start now' }).click(); await p.waitForTimeout(2500);
  ok(sql(`SELECT status FROM vehicle_requisitions WHERE id=${ride}`) === 'ongoing' && /Guest arrived early/.test(sql(`SELECT early_start_reason FROM vehicle_requisitions WHERE id=${ride}`)), 'started, reason kept');
  ok(p.errs.length === 0, 'Vehicle Management: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();
  await api(Tt, 'POST', `/api/vehicles/requisitions/${ride}/complete`, {});

  // Approver: Approve Application -> Reject without a reason.
  p = await open(A, false);
  await p.goto(B + '/'); await p.waitForTimeout(6000);
  await clickText(p, 'Approve'); await p.waitForTimeout(3500);
  const c2 = p.locator('main').locator('div').filter({ hasText: 'UI reject' }).filter({ has: p.getByRole('button', { name: 'Reject', exact: true }) }).last();
  ok(await c2.getByPlaceholder('Remarks (a reason is needed to Reject)').count() > 0, 'approver: Remarks says a reason is needed to Reject');
  await c2.getByRole('button', { name: 'Reject', exact: true }).click(); await p.waitForTimeout(1500);
  ok(await p.getByText('Write why this ride is rejected in Remarks — the rider sees it.').isVisible(), 'approver: Reject without a reason is stopped with a message');
  ok(sql(`SELECT status FROM vehicle_requisitions WHERE id=${toReject}`) === 'pending', 'approver: request still pending');
  await p.screenshot({ path: '/tmp/claude-0/sb/v-reject-noreason.png' });
  await c2.getByPlaceholder('Remarks (a reason is needed to Reject)').fill('Use the pool car tomorrow');
  await c2.getByRole('button', { name: 'Reject', exact: true }).click(); await p.waitForTimeout(2500);
  ok(sql(`SELECT status FROM vehicle_requisitions WHERE id=${toReject}`) === 'rejected', 'approver: with a reason it is rejected');
  ok(p.errs.length === 0, 'approver: no page errors ' + JSON.stringify(p.errs));
  await b.close();
  sql(`UPDATE approval_templates SET is_default=0, is_active=0 WHERE id=${tpl}`);
  if (oldDefault) sql(`UPDATE approval_templates SET is_default=1 WHERE id IN (${oldDefault})`);
  process.exit(fails ? 1 : 0);
})();
