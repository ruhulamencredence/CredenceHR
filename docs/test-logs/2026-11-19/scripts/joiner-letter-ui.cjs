// Appointment Letter at Hire — screens: HR Operations -> Onboarding -> New
// Joiners: "Issue appointment letter" on a joiner's row -> popup (salary,
// prepare, edit, issue); the joiner's My Onboarding shows the letter card.
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B = 'http://localhost:3200', D = process.argv[2] || '/tmp';
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const login = async (email, password = 'ProbePass123') => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json());
const seed = (ctx, a, extra = {}) => ctx.addInitScript(([t, u, x]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); for (const [k, v] of Object.entries(x)) localStorage.setItem(k, v); }, [a.token, a.user, extra]);
(async () => {
  const a = await login('admin@credence.test');
  const name = `UI Joiner ${Date.now().toString(36)}`;
  const c = await (await fetch(B + '/api/hr-ops/joiner-onboarding', { method: 'POST', headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' }, body: JSON.stringify({ name, designation: 'Site Engineer', joining_date: '2026-12-01' }) })).json();
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  await seed(ctx, a, { hr_ops_tab: 'onboarding' });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/admin/hr-operations', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
  await p.getByRole('button', { name: /^Onboarding$/ }).first().click(); await p.waitForTimeout(1500);
  const joiners = p.getByRole('button', { name: 'New Joiners' });
  if (await joiners.isVisible().catch(() => false)) { await joiners.click(); await p.waitForTimeout(2000); }
  const row = p.locator('tr', { hasText: name });
  ok(await row.isVisible(), 'the joiner is listed');
  await row.getByRole('button', { name: /Issue appointment letter/ }).click(); await p.waitForTimeout(600);
  const dlg = p.getByRole('dialog', { name: 'Issue Appointment Letter' });
  ok(await dlg.isVisible(), 'Issue Appointment Letter popup');
  await dlg.getByRole('button', { name: 'Prepare the letter' }).click(); await p.waitForTimeout(400);
  ok(await dlg.getByText('Type the gross salary offered.').isVisible(), 'asks for the gross salary first');
  await dlg.getByLabel('Gross salary (BDT) *').fill('55000');
  await dlg.getByLabel('Basic salary (BDT)').fill('33000');
  await dlg.getByRole('button', { name: 'Prepare the letter' }).click(); await p.waitForTimeout(1500);
  const body = await dlg.getByRole('textbox', { name: 'Letter', exact: true }).inputValue();
  ok(body.includes(name) && body.includes('55,000'), 'letter filled from the template with name and salary');
  await p.screenshot({ path: D + '/letter-hr-popup.png' });
  await dlg.getByRole('button', { name: 'Issue to the joiner' }).click(); await p.waitForTimeout(2000);
  ok(await p.getByText(new RegExp(`sent to ${name}`)).isVisible(), 'issued: confirmation shown');
  ok(await row.getByText(/APT/).isVisible(), 'row shows the letter ref');
  console.log('errors:', errs.slice(0, 2)); ok(errs.length === 0, 'no page errors (HR)');
  await ctx.close();

  // joiner
  const j = await login(c.login_id, c.password);
  // (the temporary password was already replaced — the card shows after that step)
  require('child_process').execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -e "UPDATE users SET must_change_password=0 WHERE id=${j.user.id}"`);
  const c2 = await b.newContext({ ...devices['Pixel 7'] });
  await seed(c2, j);
  const q = await c2.newPage(); const errs2 = []; q.on('pageerror', (e) => errs2.push(String(e)));
  await q.goto(B + '/', { waitUntil: 'domcontentloaded' }); await q.waitForTimeout(6000);
  ok(await q.getByText('Your Appointment Letter').isVisible(), 'My Onboarding shows the Appointment Letter card');
  ok(await q.getByText('Signed copy not uploaded yet').isVisible(), 'says the signed copy is still needed');
  await q.screenshot({ path: D + '/letter-joiner-card.png' });
  await q.getByRole('button', { name: 'Open the letter' }).click(); await q.waitForTimeout(2500);
  await q.screenshot({ path: D + '/letter-joiner-pdf.png' });
  console.log('errors:', errs2.slice(0, 2)); ok(errs2.length === 0, 'no page errors (joiner)');
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
})();
