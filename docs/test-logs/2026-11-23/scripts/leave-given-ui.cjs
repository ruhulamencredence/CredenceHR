// Phone Leave page: the thin "Given for <year>" row (left + approved this
// year + still waiting), a picked type's Given / Taken / Waiting / Left, and
// Apply Leave floating above the bottom bar like Check In/Out's button —
// only on the Leave page.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Leave#2026pass';
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const email = `leaver.${tag}@credence.test`;
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const r = await fetch(B + '/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SA }, body: JSON.stringify({ name: `Leaver ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS }) });
  const emp = await r.json();
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${emp.id}`));
  sql(`UPDATE users SET must_change_password=0, can_view_leave_application=1 WHERE id=${uid}`);
  const y = new Date().getFullYear();
  // Given Casual 10, Sick 14: approved Casual 3 + Sick 1 this year, Casual 1 waiting (already deducted).
  sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${uid}, 6, 13, 0) ON DUPLICATE KEY UPDATE casual_leave=6, sick_leave=13, leave_without_pay=0`);
  sql(`DELETE FROM leave_balances WHERE user_id=${uid} AND id NOT IN (SELECT * FROM (SELECT MAX(id) FROM leave_balances WHERE user_id=${uid}) t)`);
  sql(`UPDATE leave_balances SET casual_leave=6, sick_leave=13 WHERE user_id=${uid}`);
  sql(`INSERT INTO leave_applications (user_id, leave_type, start_date, end_date, day_count, purpose, status, apply_date) VALUES
       (${uid}, 'casual', '${y}-02-02', '${y}-02-04', 3, 't', 'approved', '${y}-02-01'),
       (${uid}, 'sick', '${y}-03-10', '${y}-03-10', 1, 't', 'approved', '${y}-03-10'),
       (${uid}, 'casual', '${y}-12-20', '${y}-12-20', 1, 't', 'pending', '${y}-11-20')`);

  const a = await login(email, PASS);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/'); await p.waitForTimeout(7000);
  const fab = p.getByTestId('leave-apply-fab');
  ok((await fab.count()) === 0, 'Dashboard: no Apply Leave button');
  await p.evaluate(() => { const el = [...document.querySelectorAll('nav button, nav a')].find((e) => e.textContent.trim() === 'Leave'); el && el.click(); });
  await p.waitForTimeout(3000);
  const given = p.getByTestId('leave-given').filter({ visible: true }).first();
  ok(await given.isVisible(), 'Leave: the Given row is there');
  const gt = (await given.innerText()).replace(/\s+/g, ' ');
  ok(new RegExp(`Given for ${y}`, 'i').test(gt), `Given row says "Given for ${y}"`);
  ok(/Casual 10/.test(gt) && /Sick 14/.test(gt) && /No pay No limit/.test(gt), 'Given: Casual 10 (6 left + 3 taken + 1 waiting), Sick 14, No pay No limit — ' + gt);
  const box = await given.boundingBox();
  ok(box && box.height < 60, 'Given row is thin (' + Math.round(box?.height || 0) + 'px)');

  ok(await fab.isVisible(), 'Leave: Apply Leave button shows');
  const fb = await fab.boundingBox(); const vw = 390;
  ok(fb && Math.abs(fb.x + fb.width / 2 - vw / 2) < 3, 'Apply Leave is centred');
  const nav = await p.locator('nav').filter({ visible: true }).last().boundingBox();
  ok(fb && nav && fb.y + fb.height <= nav.y + 40 && fb.y + fb.height > nav.y - 80, 'Apply Leave sits just above the bottom bar');
  ok(!(await p.locator('.liquid-glass button:has-text("Apply Leave")').count()), 'no Apply Leave inside the card any more');
  await p.screenshot({ path: `${OUT}/leave-given-phone.png` }).catch(() => {});

  await p.locator('button[aria-pressed]').filter({ hasText: 'Casual' }).first().click(); await p.waitForTimeout(500);
  const pt = (await given.innerText()).replace(/\s+/g, ' ');
  ok(/Casual leave/i.test(pt) && /Given 10/.test(pt) && /Taken 3/.test(pt) && /Waiting 1/.test(pt) && /Left 6/.test(pt), 'Casual picked: Given 10 · Taken 3 · Waiting 1 · Left 6 — ' + pt);
  await p.screenshot({ path: `${OUT}/leave-given-casual-phone.png` }).catch(() => {});

  await fab.click(); await p.waitForTimeout(1200);
  ok((await fab.count()) === 0, 'Apply Leave opens the form (button steps aside while it is open)');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);

  await p.goto(B + '/'); await p.waitForTimeout(5000);
  await p.evaluate(() => { const el = [...document.querySelectorAll('nav button, nav a')].find((e) => e.textContent.trim() === 'Leave'); el && el.click(); });
  await p.waitForTimeout(2500);
  await p.evaluate(() => { const el = [...document.querySelectorAll('nav button, nav a')].find((e) => e.textContent.trim() === 'Home'); el && el.click(); });
  await p.waitForTimeout(1500);
  ok((await fab.count()) === 0, 'back on Home: the button goes away');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
