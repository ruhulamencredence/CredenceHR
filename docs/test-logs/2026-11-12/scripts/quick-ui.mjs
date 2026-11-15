// HR Operations -> Reports -> Quick reports, and the Admin Dashboard's
// "HR reports" card, in the browser. Run after quick-setup.sql.
// Screenshots to $SHOTS_DIR (default /tmp/quick-shots).
import pw from '/opt/node-tools/node_modules/playwright/index.js';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3200';
const OUT = (process.env.SHOTS_DIR || '/tmp/quick-shots') + '/';
execSync(`mkdir -p ${OUT}`);
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
const b = await pw.chromium.launch();
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };
async function signIn(email, viewport = { width: 1440, height: 900 }) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} });
  const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(String(e)));
  await p.goto(B + '/'); const ws = p.getByLabel('Workspace code');
  if (await ws.isVisible({ timeout: 20000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
  await p.getByPlaceholder(/Employee ID/).fill(email); await p.locator('input[type="password"]').fill('ProbePass123'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(7000);
  for (const t of ["Don't ask again", 'Not now', 'Later', 'Skip']) { const l = p.getByRole('button', { name: t }); if (await l.isVisible().catch(() => false)) await l.click(); }
  return { ctx, p };
}

// ---- Superadmin
let { ctx, p } = await signIn('admin@credence.test');
await p.goto(B + '/admin/dashboard'); await p.waitForTimeout(6000);
const card = p.getByTestId('dashboard-hr-reports');
ok('Admin Dashboard: HR reports card is there', await card.isVisible());
ok('…probation shows 2 (1 due + 1 overdue), "1 already overdue"', (await card.locator('[data-dash-quick="probation"]').innerText()).includes('2') && (await card.locator('[data-dash-quick="probation"]').innerText()).includes('1 already overdue'));
ok('…religion lists Islam 6', (await card.locator('[data-dash-quick="religion"]').innerText()).includes('Islam 6'));
await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: OUT + 'dashboard-card.png' });
await card.locator('[data-dash-quick="resignations"]').click(); await p.waitForTimeout(5000);
ok('tap Resignations -> HR Operations, Reports, Quick reports, Resignations open', /hr-operations/.test(p.url()) && await p.getByRole('heading', { name: 'Resignations & exits' }).isVisible() && await p.getByRole('tab', { name: 'Quick reports' }).getAttribute('aria-selected') === 'true', p.url());
ok('…Tanvir in notice, 8 days left, clearance 3 of 5', await p.getByRole('row', { name: /Tanvir Hasan.*in 8 days.*3 of 5.*Clearance/ }).isVisible());
ok('…In notice now 3, Leaving in 30 days 2', /IN NOTICE NOW\s*3/i.test(await p.locator('main').innerText()) && /LEAVING IN 30 DAYS\s*2/i.test(await p.locator('main').innerText()));
await p.screenshot({ path: OUT + 'resignations.png', fullPage: true });

await p.locator('[data-quick-card="probation"]').click(); await p.waitForTimeout(2500);
ok('Probation card: Rafiq overdue, Tanvir due soon', await p.getByRole('row', { name: /Rafiq Ahmed.*11 days late.*Overdue/ }).isVisible() && await p.getByRole('row', { name: /Tanvir Hasan.*in 9 days.*Due soon/ }).isVisible());
await p.screenshot({ path: OUT + 'probation.png', fullPage: true });
await p.getByRole('button', { name: /Confirmed in period/ }).click(); await p.waitForTimeout(500);
ok('…"Confirmed in period" shows only Sadia', (await p.locator('tbody tr').count()) === 1 && await p.getByRole('row', { name: /Sadia Karim/ }).isVisible());

await p.locator('[data-quick-card="religion"]').click(); await p.waitForTimeout(2500);
await p.getByRole('button', { name: /Not recorded/ }).click(); await p.waitForTimeout(500);
ok('Religion: "Not recorded" lists only Rumana', (await p.locator('tbody tr').count()) === 1 && await p.getByRole('row', { name: /Rumana Islam/ }).isVisible());
await p.screenshot({ path: OUT + 'religion.png', fullPage: true });

await p.locator('[data-quick-card="transfers"]').click(); await p.waitForTimeout(2500);
ok('Transfers: Jahid Admin -> Transport, from end of month', await p.getByRole('row', { name: /Jahid Hasan.*Admin → Transport.*From/ }).isVisible());
let dl = p.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await p.getByRole('button', { name: 'Excel' }).click(); dl = await dl;
ok('Excel downloads', !!dl && /Transfers\.xlsx$/.test(dl.suggestedFilename()), dl?.suggestedFilename());
dl = p.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await p.getByRole('button', { name: 'PDF' }).click(); dl = await dl;
ok('PDF downloads', !!dl && /Transfers\.pdf$/.test(dl.suggestedFilename()), dl?.suggestedFilename());
await p.getByRole('combobox', { name: 'Period' }).selectOption('this_year'); await p.waitForTimeout(2000);
ok('Period "This year" still 2 (the 2025 one stays out)', (await p.locator('tbody tr').count()) === 2);

await p.locator('[data-quick-card="joiners"]').click(); await p.waitForTimeout(2500);
ok('New joiners: Rumana 2 of 3, Jahid not started', await p.getByRole('row', { name: /Rumana Islam.*2 of 3/ }).isVisible() && await p.getByRole('row', { name: /Jahid Hasan.*Not started/ }).isVisible());
await p.getByRole('row', { name: /Rumana Islam/ }).click(); await p.waitForTimeout(3000);
ok('tap a row -> that person\'s Service Book', (await p.locator('main').innerText()).includes('Rumana Islam') && await p.getByRole('button', { name: /Service Book/ }).first().isVisible());

await p.goto(B + '/admin/hr-operations'); await p.waitForTimeout(5000);
await p.getByRole('button', { name: /^Reports$/ }).click(); await p.waitForTimeout(1500);
await p.getByRole('tab', { name: 'Build your own' }).click(); await p.waitForTimeout(2500);
ok('"Build your own" still opens Employee Reports', !(await p.locator('[data-quick-card]').count()));
ok('no page errors (Superadmin)', p.errs.length === 0, p.errs.join(' | '));
await ctx.close();

// ---- phone
({ ctx, p } = await signIn('admin@credence.test', { width: 390, height: 844 }));
await p.evaluate(() => { sessionStorage.setItem('hr_ops_tab', 'reports'); sessionStorage.setItem('hr_ops_reports_view', 'quick'); sessionStorage.setItem('hr_ops_quick_kind', 'resignations'); });
await p.goto(B + '/admin/hr-operations'); await p.waitForTimeout(6000);
const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok('phone: Quick reports fit the screen (no sideways page scroll)', over <= 1, String(over));
await p.screenshot({ path: OUT + 'phone.png', fullPage: true });
await ctx.close();

// ---- HR Operations without the Quick reports layer
sql("UPDATE users u JOIN (SELECT password_hash FROM users WHERE id = 1) a SET u.password_hash = a.password_hash WHERE u.id = 133");
sql("DELETE FROM admin_module_permissions WHERE user_id = 133 AND module_key IN ('hr_operations', 'admin_dashboard')");
sql("DELETE FROM admin_module_permission_layers WHERE user_id = 133 AND module_key = 'hr_operations'");
sql("INSERT INTO admin_module_permissions (user_id, module_key) VALUES (133, 'hr_operations'), (133, 'admin_dashboard')");
sql("INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES (133, 'hr_operations', 'read')");
({ ctx, p } = await signIn('roster.hr@credence.test'));
await p.goto(B + '/admin/dashboard'); await p.waitForTimeout(6000);
ok('without Quick reports: no HR reports card on the dashboard', !(await p.getByTestId('dashboard-hr-reports').count()));
await p.evaluate(() => { sessionStorage.setItem('hr_ops_tab', 'reports'); sessionStorage.setItem('hr_ops_reports_view', 'quick'); });
await p.goto(B + '/admin/hr-operations'); await p.waitForTimeout(6000);
ok('…Reports tab has no Quick reports (only Employee Reports)', !(await p.getByRole('tab', { name: 'Quick reports' }).count()) && !(await p.locator('[data-quick-card]').count()));
ok('…and no "Quick Reports" menu item', !(await p.getByRole('button', { name: 'Quick Reports', exact: true }).count()) && !(await p.getByRole('link', { name: 'Quick Reports', exact: true }).count()));
await ctx.close();
// with it ticked
sql("INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES (133, 'hr_operations', 'quick_reports')");
({ ctx, p } = await signIn('roster.hr@credence.test'));
await p.goto(B + '/admin/dashboard'); await p.waitForTimeout(6000);
ok('ticked: HR reports card shows', await p.getByTestId('dashboard-hr-reports').isVisible());
await ctx.close();
sql("DELETE FROM admin_module_permission_layers WHERE user_id = 133 AND module_key = 'hr_operations'");
sql("DELETE FROM admin_module_permissions WHERE user_id = 133 AND module_key IN ('hr_operations', 'admin_dashboard')");

await b.close();
console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
