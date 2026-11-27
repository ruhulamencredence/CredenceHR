// Late Policy screen with Extreme = 0 (the note, saving it, the history), and
// an employee's This Month card counting both kinds of late together.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Late#2026pass';
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const before = sql('SELECT IFNULL(MAX(id),0) FROM late_policy_settings');
  const sa = await login('admin@credence.test', 'ProbePass123');
  const b = await chromium.launch();
  const open = async (a) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (x) => p.errs.push(String(x)));
    // The app's own "How do you like the app?" prompt can pop up at any time — not part of this test.
    await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });
    return p;
  };
  let p = await open(sa);
  await p.goto(B + '/self/payroll'); await p.waitForTimeout(7000);
  await p.getByRole('button', { name: 'Salary Setup' }).first().click(); await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /Late Policy/ }).first().click(); await p.waitForTimeout(2000);
  const box = p.getByTestId('extreme-lates-per-day');
  ok(await box.isVisible(), 'Late Policy: Extreme Lates per Deducted Day field');
  ok((await box.getAttribute('min')) === '0', 'field allows 0');
  await box.fill('0'); await p.waitForTimeout(300);
  ok(await p.getByTestId('extreme-zero-note').isVisible(), '0 shows the "no separate deduction — counted with lates" note');
  const month = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 7);
  await p.locator('input[type="date"]').last().fill(`${month}-01`);
  await p.getByRole('button', { name: 'Save Policy Change' }).click(); await p.waitForTimeout(2500);
  ok(sql('SELECT extreme_lates_per_deduction_day FROM late_policy_settings ORDER BY id DESC LIMIT 1') === '0', 'Save stores 0');
  ok(await p.getByText(/no separate deduction; counted with the lates above/).first().isVisible(), 'summary box says Extreme counts with the lates');
  ok(await p.getByText('0 (with lates)').first().isVisible(), 'history shows "0 (with lates)"');
  await p.screenshot({ path: `${OUT}/late-policy-zero.png`, fullPage: false }).catch(() => {});
  ok(p.errs.length === 0, 'admin: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();

  // Employee with 2 Delay + 1 Extreme this month.
  const tag = Date.now().toString(36).slice(-5); const email = `lateui.${tag}@credence.test`;
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const e = await (await fetch(B + '/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sa.token }, body: JSON.stringify({ name: `Lateui ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS }) })).json();
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.id}`)); sql(`UPDATE users SET must_change_password=0 WHERE id=${uid}`);
  const ua = await login(email, PASS);
  const sum = await (await fetch(B + '/api/my-attendance-summary', { headers: { authorization: 'Bearer ' + ua.token } })).json();
  const proj = Number(sql('SELECT MIN(id) FROM projects'));
  const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10); const days = [];
  for (let i = 1; days.length < 3 && i < 20; i++) { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - i); const ds = d.toISOString().slice(0, 10); if (ds >= sum.period_start && d.getUTCDay() !== 5) days.push(ds); }
  ['09:30:00', '09:40:00', '10:30:00'].forEach((t, i) => sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_lat, check_in_lng) VALUES (${uid}, ${proj}, '${days[i]}', '${days[i]} ${t}', 23.8, 90.4)`));
  p = await open(ua);
  await p.goto(B + '/'); await p.waitForTimeout(7000);
  const card = p.getByTestId('my-month-attendance').filter({ visible: true }).first();
  const ct = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok(/counts with lates/.test(ct), 'employee card: Extreme Delay "counts with lates"');
  ok(/3 lates this month \(3 lates = 1 day\)/.test(ct) && /1 day's salary/.test(ct), "employee card: 3 lates this month (3 lates = 1 day) → 1 day's salary — " + ct.slice(-160));
  await card.screenshot({ path: `${OUT}/late-zero-employee-card.png` }).catch(() => {});
  ok(p.errs.length === 0, 'employee: no page errors ' + JSON.stringify(p.errs));
  await b.close();
  sql(`DELETE FROM late_policy_settings WHERE id > ${before}`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
