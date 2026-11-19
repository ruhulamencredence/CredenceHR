// Entry sharing screens: Projects -> Edit -> Entry sharing (+ old entries with
// no For), the Projects list chip, Users -> Project Access popup (ticked first,
// team names, what they'll see), and the entry form's "For" field.
// Run entry-sharing-api.mjs first (it makes the QA projects, people and entries).
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = 'http://localhost:3200', D = process.argv[2] || '/tmp';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const login = async (email) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'ProbePass123' }) })).json());
const seed = (ctx, a, extra = {}) => ctx.addInitScript(([t, u, x]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); for (const [k, v] of Object.entries(x)) localStorage.setItem(k.replace('{id}', u.id), v); }, [a.token, a.user, extra]);
(async () => {
  const ci = sql("SELECT id FROM projects WHERE project_name='QA Central Inventory'");
  const nasima = sql("SELECT id FROM users WHERE email='qa.share.nasima@credence.test'");
  sql(`UPDATE projects SET entry_scope='team' WHERE id=${ci}`);
  sql(`UPDATE entries SET for_project_id=NULL WHERE project_id=${ci} AND created_by=${nasima}`);
  const a = await login('admin@credence.test');
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  await seed(ctx, a);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));

  // 1. Projects -> Edit -> Entry sharing
  await p.goto(B + '/admin/projects', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
  await p.getByPlaceholder('Search projects...').fill('QA Central');
  await p.waitForTimeout(500);
  await p.getByTitle('Edit project').first().click(); await p.waitForTimeout(600);
  const group = p.getByRole('radiogroup', { name: 'Entry sharing' });
  ok(await group.isVisible(), 'Edit project shows Entry sharing');
  ok(await group.getByRole('radio', { name: /^Team/ }).isChecked(), 'currently Team');
  await group.getByText('By home project', { exact: true }).click();
  await p.getByRole('button', { name: 'Update Project' }).click(); await p.waitForTimeout(2500);
  ok(await p.getByText(/Project saved\. \d+ old entr/).isVisible(), 'saved, with how many old entries got For');
  ok(sql(`SELECT entry_scope FROM projects WHERE id=${ci}`) === 'home', 'saved as By home project');
  const gapBox = p.getByText('Old entries with no “For”');
  ok(await gapBox.isVisible(), 'lists old entries whose maker has several projects');
  const pick = p.getByRole('combobox', { name: /For — QA nasima/ });
  await pick.click(); await pick.fill('Rup'); await p.waitForTimeout(400);
  await p.getByRole('option', { name: /QA Rupayan/ }).first().click(); await p.waitForTimeout(300);
  await p.screenshot({ path: D + '/sharing-project-edit.png' });
  await p.getByRole('button', { name: 'Set For' }).click(); await p.waitForTimeout(1500);
  ok(sql(`SELECT COUNT(*) FROM entries WHERE project_id=${ci} AND created_by=${nasima} AND for_project_id IS NULL`) === '0', "Set For filled Nasima's old entries");
  await p.getByRole('button', { name: 'Cancel' }).first().click(); await p.waitForTimeout(800);
  ok(await p.locator('span', { hasText: /^By home project$/ }).first().isVisible(), 'Projects list shows the "By home project" chip');

  // 2. Users -> Project Access
  await p.goto(B + '/admin/users', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
  const srch = p.getByPlaceholder(/Search/i).first();
  await srch.fill('qa.share.rahim'); await p.waitForTimeout(800);
  await p.getByText('QA rahim').first().click(); await p.waitForTimeout(1200);
  await p.getByRole('button', { name: /^Access/ }).first().click(); await p.waitForTimeout(600);
  await p.getByRole('button', { name: /Projects \(Budget \/ Jobs \/ MPR\)/ }).click(); await p.waitForTimeout(800);
  const dlg = p.getByRole('dialog', { name: 'Project Access' });
  ok(await dlg.isVisible(), 'Project Access popup opens');
  const txt = await dlg.innerText();
  ok(/Given · 2/i.test(txt), 'ticked projects first: "Given · 2"');
  ok(txt.indexOf('QA Anamika') < txt.toLowerCase().indexOf('other projects'), 'QA Anamika listed before the other projects');
  ok(/Team: [^\n]*QA nasima/.test(txt), 'under QA Anamika: who else is on the team');
  ok(/Sees the entries made for QA Anamika/.test(txt), 'under QA Central Inventory: what Rahim will see there');
  ok(await dlg.getByText('By home project').first().isVisible(), 'Central Inventory carries its Entry sharing chip');
  await p.screenshot({ path: D + '/sharing-project-access.png' });
  await dlg.getByRole('checkbox').first().click(); await p.waitForTimeout(300);
  ok(/No other project ticked/.test(await dlg.innerText()), 'unticking Anamika: Central Inventory line says only his own');
  await dlg.getByRole('button', { name: 'Cancel' }).click(); await p.waitForTimeout(400);
  ok(!(await dlg.isVisible()), 'Cancel closes without saving');
  ok(sql(`SELECT COUNT(*) FROM user_project_permissions WHERE user_id=(SELECT id FROM users WHERE email='qa.share.rahim@credence.test')`) === '2', 'nothing saved');
  console.log('errors:', errs.slice(0, 2)); ok(errs.length === 0, 'no page errors (admin)');
  await ctx.close();

  // 3. Entry form For field (phone): Nasima works on two projects
  const n = await login('qa.share.nasima@credence.test');
  const c2 = await b.newContext({ ...devices['Pixel 7'] });
  await seed(c2, n, { 'mpr_user_section_{id}': 'budget', credence_bg_location_consent: 'declined' });
  const q = await c2.newPage(); const errs2 = []; q.on('pageerror', (e) => errs2.push(String(e)));
  await q.goto(B + '/', { waitUntil: 'domcontentloaded' }); await q.waitForTimeout(7000);
  await q.screenshot({ path: D + '/sharing-entry-start.png' });
  const bud = q.getByText('QA Share Budget').first();
  if (await bud.isVisible().catch(() => false)) { await bud.click(); await q.waitForTimeout(2500); }
  const projInput = q.getByPlaceholder('Type to search Project Name...');
  if (await projInput.isVisible().catch(() => false)) {
    await projInput.fill('QA Central'); await q.waitForTimeout(400);
    await q.getByRole('button', { name: 'QA Central Inventory' }).click(); await q.waitForTimeout(1500);
  }
  const forBox = q.getByRole('combobox', { name: 'For' });
  ok(await forBox.isVisible().catch(() => false), 'entry form: "For (your project)" picker for Central Inventory');
  if (await forBox.isVisible().catch(() => false)) {
    await forBox.click(); await q.waitForTimeout(400);
    const opts = await q.getByRole('option').allInnerTexts();
    ok(opts.some((o) => /QA Anamika/.test(o)) && opts.some((o) => /QA Rupayan/.test(o)), 'For offers her two projects: ' + opts.join(' | '));
    await q.keyboard.press('Escape');
  }
  await q.screenshot({ path: D + '/sharing-entry-for.png' });
  console.log('errors:', errs2.slice(0, 2)); ok(errs2.length === 0, 'no page errors (entry form)');
  sql(`UPDATE projects SET entry_scope='team' WHERE id=${ci}`);
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
})();
