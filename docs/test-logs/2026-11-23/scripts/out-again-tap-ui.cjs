// My Attendance card: no "Set again" text under the Out Time; for an account
// allowed to give the Out again (users.can_update_check_out) the Out Time box
// itself is tapped, which asks first; for anyone else the box does nothing.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Out#2026pass';
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
  const proj = Number(sql('SELECT MIN(id) FROM projects'));
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const person = async (name, canAgain) => {
    const email = `${name}.${tag}@credence.test`;
    const e = await (await fetch(B + '/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SA }, body: JSON.stringify({ name: `${name} ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS }) })).json();
    const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.id}`));
    sql(`UPDATE users SET must_change_password=0, can_use_attendance=1, can_update_check_out=${canAgain ? 1 : 0} WHERE id=${uid}`);
    sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_lat, check_in_lng, check_out_at, check_out_lat, check_out_lng) VALUES (${uid}, ${proj}, '${today}', '${today} 09:07:00', 23.8, 90.4, '${today} 18:31:00', 23.8, 90.4)`);
    return { uid, email };
  };
  const A = await person('outagain', true), N = await person('outfixed', false);
  const b = await chromium.launch();
  const open = async (x) => {
    const a = await login(x.email, PASS);
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(String(e))); await p.goto(B + '/'); await p.waitForTimeout(7000); return p;
  };
  let p = await open(A);
  ok(await p.getByText('06:31').filter({ visible: true }).first().isVisible(), 'allowed: Out Time 06:31 PM shows');
  ok((await p.getByText('Set again').count()) === 0, 'allowed: no "Set again" text');
  const box = p.getByRole('button', { name: 'Out Time — tap to give it again' }).filter({ visible: true }).first();
  ok(await box.isVisible(), 'allowed: the Out Time box is tappable');
  await p.screenshot({ path: `${OUT}/out-again-card.png` }).catch(() => {});
  await box.click(); await p.waitForTimeout(800);
  ok(await p.getByText(/Give your Out Time again\?/).isVisible(), 'tap: asks first ("Give your Out Time again?")');
  await p.getByRole('button', { name: /Cancel|No|Not now/i }).last().click().catch(() => p.keyboard.press('Escape')); await p.waitForTimeout(800);
  ok(/18:31/.test(sql(`SELECT check_out_at FROM attendance WHERE user_id=${A.uid}`)), 'cancel: nothing changed');
  ok(p.errs.length === 0, 'allowed: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();

  p = await open(N);
  ok(await p.getByText('06:31').filter({ visible: true }).first().isVisible(), 'not allowed: Out Time shows');
  ok((await p.getByRole('button', { name: /tap to give it again/ }).count()) === 0, 'not allowed: the box is not tappable');
  ok((await p.getByText('Set again').count()) === 0, 'not allowed: no "Set again" text');
  await p.context().close();
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
