// Admin Panel -> Designations in the browser, and the employee form's picker. Dev server :3200.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = 'http://localhost:3200', D = process.argv[2];
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s.replace(/"/g, '\\"')}"`).toString().trim();
(async () => {
  let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  sql("DELETE FROM all_employees WHERE employee_id LIKE 'DSGU-%'");
  // Fresh names each run (a merged-away name later joins the kept one, as it should).
  const T = 'Planner ' + String(Date.now()).slice(-5);
  const LONG = `Assistant ${T}`, SHORT = `Asst. ${T}`, NEW = `Asst ${T} (Ops)`;
  sql(`INSERT INTO all_employees (employee_id, name, designation, is_active, company_id) VALUES ('DSGU-1','QA Asst One','${SHORT}',1,1),('DSGU-2','QA Asst Two','${LONG}',1,1),('DSGU-3','QA Asst Three','${LONG}',1,1)`);
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/admin/designations', { waitUntil: 'domcontentloaded' });
  await p.getByRole('heading', { name: 'Designations' }).waitFor({ timeout: 60000 }); await p.waitForTimeout(2500);
  ok(await p.getByText(/one list for all companies/).isVisible(), 'page opens: count line "one list for all companies"');
  const am = p.locator('tr', { hasText: LONG }).first();
  ok(/DSG-\d{3}/.test(await am.innerText()), 'rows show their code');
  const box = p.locator('[aria-label="Look-alike designations"]');
  ok(await box.isVisible() && (await box.innerText()).includes(SHORT), `look-alike box: ${LONG} / ${SHORT}`);
  await p.screenshot({ path: D + '/designations-list.png' });
  // Merge from the box (keeps the one most people have).
  const grp = box.locator('div', { hasText: SHORT }).last();
  await grp.getByRole('button', { name: /Merge/ }).click(); await p.waitForTimeout(600);
  ok(await p.getByLabel('Keep this one (its name and code)').isVisible(), 'merge popup: keep which');
  ok((await p.getByLabel('Keep this one (its name and code)').inputValue()) === sql(`SELECT id FROM designations WHERE name='${LONG}' AND is_deleted=0`), 'the one most people have is picked');
  await p.screenshot({ path: D + '/designations-merge.png' });
  await p.getByRole('button', { name: /^Merge$/ }).last().click(); await p.waitForTimeout(2000);
  ok(sql("SELECT GROUP_CONCAT(DISTINCT designation) FROM all_employees WHERE employee_id LIKE 'DSGU-%'") === LONG, `merged: all three are "${LONG}"`);
  // Rename: popup says the code stays, shows what changes.
  await p.locator('tr', { hasText: LONG }).first().getByRole('button', { name: /Rename/ }).click(); await p.waitForTimeout(800);
  ok(await p.getByText(/stays the same/).isVisible() && await p.getByText(/employee.*\(all companies\)/).isVisible(), 'rename popup: code stays, how many employees change');
  await p.screenshot({ path: D + '/designations-rename.png' });
  const code = sql(`SELECT code FROM designations WHERE name='${LONG}' AND is_deleted=0`);
  await p.locator('#dg-rename').fill(NEW); await p.getByRole('button', { name: 'Rename everywhere' }).click(); await p.waitForTimeout(2000);
  ok(sql(`SELECT code FROM designations WHERE name='${NEW}'`) === code, `renamed, code ${code} kept`);
  ok(sql("SELECT GROUP_CONCAT(DISTINCT designation) FROM all_employees WHERE employee_id LIKE 'DSGU-%'") === NEW, 'employees follow the rename');
  await p.locator('tr', { hasText: NEW }).first().getByRole('button', { name: /Rename/ }).click(); await p.locator('#dg-rename').fill(LONG); await p.getByRole('button', { name: 'Rename everywhere' }).click(); await p.waitForTimeout(1500);
  // Add with a look-alike: asked, "Add anyway".
  await p.getByRole('button', { name: /Add designation/ }).click();
  await p.locator('#dg-name').fill(SHORT); await p.getByRole('button', { name: /^Add$/ }).click(); await p.waitForTimeout(800);
  ok(await p.getByText(`Looks like “${LONG}”`, { exact: false }).isVisible() && await p.getByRole('button', { name: 'Add anyway' }).isVisible(), 'add a look-alike: asked, with "Add anyway"');
  await p.getByRole('button', { name: 'Cancel' }).click();
  // Employee form: type to find, new name noted.
  await p.goto(B + '/admin/employees', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
  await p.locator('button[title="Edit"]').first().click(); await p.waitForTimeout(1500);
  const f = p.getByRole('combobox', { name: 'Designation', exact: true }).last();
  await f.click(); await f.fill(T.slice(0, 7)); await p.waitForTimeout(600);
  ok((await p.locator('[role="listbox"]').last().innerText().catch(() => '')).includes(LONG), `employee form: typing "${T.slice(0, 7)}" offers "${LONG}"`);
  await f.fill('Chief Happiness Officer'); await p.waitForTimeout(300);
  ok(await p.getByText(/New designation — it is added to Designations/).isVisible(), 'a new name is noted: "added to Designations when you save"');
  await p.screenshot({ path: D + '/designations-form.png' });
  console.log('errors:', errs.slice(0, 2)); ok(errs.length === 0, 'no page errors');
  sql("DELETE FROM all_employees WHERE employee_id LIKE 'DSGU-%'");
  console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
