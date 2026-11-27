// The In Time / Out Time popup (AttendanceMapConfirm.tsx), new look: big map
// with the status line and location button on it, Remarks / Reason, Cancel /
// Submit side by side. Inside the area In Time goes straight in; outside every
// project the Out needs a reason and goes for approval.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Pop#2026pass';
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const email = `popup.${tag}@credence.test`;
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const ho = sql("SELECT id, location_lat, location_lng, location_radius FROM projects WHERE location_lat IS NOT NULL ORDER BY id LIMIT 1").split('\t');
  const [hoId, hoLat, hoLng] = [Number(ho[0]), Number(ho[1]), Number(ho[2])];
  const e = await (await fetch(B + '/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SA }, body: JSON.stringify({ name: `Popup ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS }) })).json();
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.id}`));
  sql(`UPDATE users SET must_change_password=0, can_use_attendance=1 WHERE id=${uid}`);
  const a = await login(email, PASS);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, geolocation: { latitude: hoLat + 0.0001, longitude: hoLng + 0.0001, accuracy: 10 }, permissions: ['geolocation'] });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (x) => errs.push(String(x)));
  await p.goto(B + '/'); await p.waitForTimeout(7000);

  // In Time, inside Head Office.
  await p.getByRole('button', { name: 'Set Now' }).first().click(); await p.waitForTimeout(4000);
  const dlg = p.getByRole('dialog', { name: 'In Time' });
  ok(await dlg.isVisible(), 'In: popup titled "In Time"');
  const st = (await p.getByTestId('attendance-map-status').innerText()).trim();
  ok(/You're inside .*'s area · \d+ m/.test(st), 'In: status on the map says inside the area — ' + st);
  ok(await dlg.getByRole('button', { name: 'Use current location' }).isVisible(), 'In: location button on the map');
  ok((await dlg.locator('.leaflet-control-zoom').count()) === 0, 'In: no +/- zoom buttons');
  ok(!(await dlg.innerText()).match(/\d+\.\d{6}, \d+\.\d{6}/), 'In: no raw coordinates');
  ok(await dlg.getByText('Remarks').first().isVisible() && await dlg.getByText('(optional)').isVisible(), 'In: Remarks (optional)');
  const [c, s] = [await dlg.getByRole('button', { name: 'Cancel' }).boundingBox(), await dlg.getByRole('button', { name: 'Submit' }).boundingBox()];
  ok(c && s && Math.abs(c.width - s.width) < 2 && Math.abs(c.y - s.y) < 2, 'In: Cancel and Submit side by side, same size');
  ok(await dlg.getByRole('button', { name: 'Submit' }).isEnabled(), 'In: Submit enabled');
  await p.screenshot({ path: `${OUT}/attendance-popup-in.png` }).catch(() => {});
  await dlg.getByRole('button', { name: 'Use current location' }).click(); await p.waitForTimeout(2500);
  ok(/inside/.test(await p.getByTestId('attendance-map-status').innerText()), 'In: location button refreshes and stays inside');
  await dlg.getByRole('button', { name: 'Submit' }).click(); await p.waitForTimeout(3500);
  ok(Number(sql(`SELECT COUNT(*) FROM attendance WHERE user_id=${uid} AND check_in_at IS NOT NULL`)) === 1, 'In: Submit records the In Time');

  // Out Time far from every project.
  await ctx.setGeolocation({ latitude: hoLat + 0.25, longitude: hoLng + 0.25, accuracy: 10 });
  await p.waitForTimeout(31000); // the card accepts a fix up to 30 s old (AttendanceCard maximumAge)
  await p.getByRole('button', { name: 'Set Now' }).first().click(); await p.waitForTimeout(4000);
  const od = p.getByRole('dialog', { name: 'Out Time' });
  ok(await od.isVisible(), 'Out: popup titled "Out Time"');
  const ost = (await p.getByTestId('attendance-map-status').innerText()).trim();
  ok(/goes for approval/.test(ost), 'Out (outside every project): status says it goes for approval — ' + ost);
  ok(await od.getByText('Reason').first().isVisible() && await od.getByText('(needed)').isVisible(), 'Out: label becomes Reason (needed)');
  ok(await od.getByRole('button', { name: 'Submit' }).isDisabled(), 'Out: Submit off until a reason is written');
  await od.locator('textarea').fill('Client meeting at Gulshan');
  ok(await od.getByRole('button', { name: 'Submit' }).isEnabled(), 'Out: Submit on with a reason');
  await p.screenshot({ path: `${OUT}/attendance-popup-out-offsite.png` }).catch(() => {});
  await od.locator('textarea').focus(); await p.waitForTimeout(600);
  await od.getByRole('button', { name: 'Submit' }).click(); await p.waitForTimeout(3500);
  ok(Number(sql(`SELECT COUNT(*) FROM attendance_corrections WHERE user_id=${uid} AND offsite_out=1 AND status='pending'`)) === 1, 'Out: sent for approval as an off-site Out');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
