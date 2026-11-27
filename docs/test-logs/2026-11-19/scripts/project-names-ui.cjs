// Data Import -> a Budget -> "Import more rows": a sheet with a misspelt project name opens the
// "Project names not in Projects" popup; picking the project imports the rows under it.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const XLSX = require(require('path').join(__dirname, '../../../../node_modules/xlsx'));
const { execSync } = require('child_process');
const B = 'http://localhost:3200', D = process.argv[2] || '/tmp';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
(async () => {
  const tag = Date.now().toString(36);
  const P = `QA Lakeview ${tag}`;
  sql(`INSERT INTO projects (project_name) VALUES ('${P}')`);
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  await fetch(B + '/api/budgets', { method: 'POST', headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' }, body: JSON.stringify({ budget_name: `QA UI Names ${tag}` }) });
  const file = `${D}/qa-names-${tag}.xlsx`;
  const ws = XLSX.utils.aoa_to_sheet([['SL No', 'Project Name', 'MRF No', 'Description of Materials', 'Unit', 'Req Qty'], [1, `QA Lakevew ${tag}`, `QAU-${tag}-1`, 'Cement', 'bag', 10]]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); XLSX.writeFile(wb, file);
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/admin/imports', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
  const row = p.locator('div,tr', { hasText: `QA UI Names ${tag}` }).filter({ has: p.getByTitle('Import more rows into this budget') }).last();
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), row.getByTitle('Import more rows into this budget').click()]);
  await chooser.setFiles(file); await p.waitForTimeout(4000);
  const dlg = p.getByRole('dialog', { name: 'Match project names' });
  ok(await dlg.isVisible(), 'popup lists the name that is not in Projects');
  ok(await dlg.getByText(`“QA Lakevew ${tag}”`).isVisible(), 'shows the misspelt name');
  ok(sql(`SELECT COUNT(*) FROM budget_items bi JOIN budgets b ON b.id=bi.budget_id WHERE b.budget_name='QA UI Names ${tag}'`) === '0', 'nothing saved yet');
  const pick = dlg.getByRole('combobox', { name: new RegExp('Project for') });
  await pick.click(); await pick.fill('Lakeview'); await p.waitForTimeout(400);
  await p.getByRole('option', { name: new RegExp(P) }).first().click(); await p.waitForTimeout(300);
  await p.screenshot({ path: D + '/project-match.png' });
  await dlg.getByRole('button', { name: 'Import with these projects' }).click(); await p.waitForTimeout(3000);
  ok(sql(`SELECT bi.project_name FROM budget_items bi JOIN budgets b ON b.id=bi.budget_id WHERE b.budget_name='QA UI Names ${tag}'`) === P, 'row imported under the real project');
  ok(sql(`SELECT COUNT(*) FROM projects WHERE project_name='QA Lakevew ${tag}'`) === '0', 'no project made for the typo');
  console.log('errors:', errs.slice(0, 2)); ok(errs.length === 0, 'no page errors');
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
})();
