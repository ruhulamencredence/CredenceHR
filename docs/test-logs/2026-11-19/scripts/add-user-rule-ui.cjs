// Users -> Add New User: "Login for: An employee / Not an employee", employee picker (type to search), onboarding hint.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = 'http://localhost:3200', D = process.argv[2] || '/tmp';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
(async () => {
  const tag = Date.now().toString(36);
  sql(`INSERT INTO all_employees (name, employee_id, designation, department, company_id, is_active) VALUES ('Picker ${tag}', 'PK-${tag}', 'Officer', 'MIS', 1, 1)`);
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/admin/users', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
  ok(await p.getByRole('radiogroup', { name: 'Login for' }).isVisible(), 'Add New User asks who the login is for');
  ok(await p.getByText(/new joiner/i).first().isVisible(), 'points new joiners to Onboarding');
  const pick = p.getByRole('combobox', { name: 'Employee' });
  await pick.click(); await p.waitForTimeout(800); await pick.fill(`PK-${tag}`); await p.waitForTimeout(500);
  await p.getByRole('option', { name: new RegExp(`Picker ${tag}`) }).first().click(); await p.waitForTimeout(300);
  ok((await p.locator('input[placeholder="From the employee"]').inputValue()) === `Picker ${tag}`, 'picking the employee fills the name');
  await p.locator('input[placeholder*="character" i], input[minlength]').first().fill('QaPass#2026x');
  await p.screenshot({ path: D + '/add-user.png' });
  await p.getByRole('button', { name: /Create User/ }).click(); await p.waitForTimeout(2500);
  ok(sql(`SELECT u.username FROM all_employees e JOIN users u ON u.id = e.user_id WHERE e.employee_id='PK-${tag}'`) === `PK-${tag}`, 'login made and linked, Login ID = Employee ID');
  await p.getByRole('radio', { name: 'Not an employee' }).click();
  ok(await p.getByLabel('Who is this login for').isVisible(), '"Not an employee" asks who it is');
  console.log('errors:', errs.slice(0, 2)); ok(errs.length === 0, 'no page errors');
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
})();
