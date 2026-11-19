// New HR Action -> Transfer -> new branch: the "Also changes" panel (PEPM, check-in, team) and the Head Office case.
// Run transfer-access-api.mjs first (it makes QA Mover, the QA sites and teams).
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = 'http://localhost:3200', D = process.argv[2] || '/tmp';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
(async () => {
  const code = sql("SELECT employee_id FROM all_employees WHERE name LIKE 'QA Mover %' ORDER BY id DESC LIMIT 1");
  const empId = sql(`SELECT id FROM all_employees WHERE employee_id='${code}'`);
  const uid = sql(`SELECT user_id FROM all_employees WHERE id=${empId}`);
  // put them back at the Anamika site for the preview
  sql(`UPDATE all_employees SET branch_id=(SELECT id FROM branches WHERE branch_name='QA Anamika Site'), branch='QA Anamika Site' WHERE id=${empId}`);
  sql(`DELETE FROM user_project_permissions WHERE user_id=${uid}`);
  sql(`INSERT INTO user_project_permissions (user_id, project_id) SELECT ${uid}, id FROM projects WHERE project_name IN ('QA Anamika','QA Central Inventory')`);
  sql(`UPDATE user_attendance_projects SET valid_to=NULL WHERE user_id=${uid} AND project_id=(SELECT id FROM projects WHERE project_name='QA Anamika')`);
  sql(`DELETE FROM user_attendance_projects WHERE user_id=${uid} AND project_id=(SELECT id FROM projects WHERE project_name='QA Rupayan')`);
  sql(`DELETE FROM department_team_members WHERE employee_id=${empId}`);
  sql(`INSERT INTO department_team_members (team_id, employee_id) SELECT id, ${empId} FROM department_teams WHERE name='QA Anamika Site Team'`);
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); localStorage.setItem('hr_ops_tab', 'actions'); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/admin/hr-operations', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);

  // the Personnel Actions tab in the page's own tab row (the side menu has one too)
  const tabs = p.locator('button:visible', { hasText: 'Personnel Actions' });
  for (let i = 0; i < await tabs.count(); i++) { const bb = await tabs.nth(i).boundingBox(); if (bb && bb.x > 300) { await tabs.nth(i).click(); break; } }
  await p.waitForTimeout(1500);
  await p.locator('button:visible', { hasText: 'New HR Action' }).first().click(); await p.waitForTimeout(800);
  const dlg = p.getByRole('dialog').last();
  const typeSel = dlg.locator('select').first();
  await typeSel.selectOption('transfer'); await p.waitForTimeout(400);
  const emp = dlg.getByPlaceholder('Search employee by name or ID…').first();
  await emp.click(); await emp.fill(code); await p.waitForTimeout(500); await dlg.locator('button', { hasText: code }).first().click(); await p.waitForTimeout(400);
  const pickBranch = async (name) => {
    const bx = dlg.getByRole('combobox', { name: 'No change' }).first();
    if (!(await bx.count())) return false;
    await bx.click(); await bx.fill(name.slice(0, 9)); await p.waitForTimeout(500);
    const opt = p.getByRole('option', { name: new RegExp('^' + name) });
    if (!(await opt.count())) return false;
    await opt.first().click(); return true;
  };
  ok(await pickBranch('QA Rupayan Site'), 'picked the new branch');
  await p.waitForTimeout(1500);
  const panel = dlg.getByText(/^Also changes on/);
  ok(await panel.isVisible(), '"Also changes" panel shows');
  const t = await dlg.innerText();
  ok(/QA Anamika/.test(t) && /\+ QA Rupayan/.test(t) && /QA Central Inventory stays/.test(t), 'PEPM: Anamika off, + Rupayan, Central Inventory stays');
  ok(/ends/.test(t) && /from/.test(t), 'check-in: ends / from dates');
  ok(/\+ QA Rupayan Site Team/.test(t), 'team: + QA Rupayan Site Team');
  await panel.scrollIntoViewIfNeeded(); await p.screenshot({ path: D + '/transfer-panel.png' });
  ok(await pickBranch('QA Head Office'), 'switched to QA Head Office'); await p.waitForTimeout(1500);
  const t2 = await dlg.innerText();
  ok(/has no linked project/.test(t2) && /Also give PEPM projects/.test(t2), 'Head Office: no project comes in, HR can add one');
  await p.screenshot({ path: D + '/transfer-panel-ho.png' });
  console.log('errors:', errs.slice(0, 2)); ok(errs.length === 0, 'no page errors');
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
})();
