import pw from '/opt/node-tools/node_modules/playwright/index.js';
const { chromium } = pw; const B = 'http://localhost:3200';
const b = await chromium.launch();
let pass = 0, n = 0; const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, x); };
const open = async (who) => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/'); const ws = p.getByLabel('Workspace code');
  if (await ws.isVisible({ timeout: 20000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
  await p.getByPlaceholder(/Employee ID/).fill(who); await p.locator('input[type="password"]').fill('ProbePass123'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(8000);
  for (const t of ["Don't ask again", 'Not now', 'Later', 'Skip']) { const l = p.getByRole('button', { name: t }); if (await l.isVisible().catch(() => false)) await l.click(); }
  return { p, ctx, errs };
};
const tile = (p, label) => p.locator('button, [role="button"], div').filter({ hasText: new RegExp(`^${label}`) }).last();
const clickTile = async (p, label) => { await p.getByText(label, { exact: true }).first().click(); await p.waitForTimeout(800); };
// 2. Superadmin: approves the corrections
{
  const { p, ctx, errs } = await open('admin@credence.test');
  await p.goto(B + '/admin/dashboard'); await p.waitForTimeout(8000);
  for (const t of ["Don't ask again", 'Not now', 'Later', 'Skip']) { const l = p.getByRole('button', { name: t }); if (await l.isVisible().catch(() => false)) await l.click(); }
  await clickTile(p, 'Pending Attendance Recon.');
  const dlg = p.getByRole('dialog', { name: /Attendance corrections/ });
  ok('Superadmin: 2 corrections tickable', (await dlg.locator('input[type="checkbox"][aria-label^="Select "]').count()) === 2);
  await dlg.getByText(/Select all you can approve/).click();
  await dlg.getByRole('button', { name: /Approve selected \(2\)/ }).click(); await p.waitForTimeout(500);
  await p.getByRole('button', { name: 'Approve', exact: true }).click(); await p.waitForTimeout(4000);
  const msg1 = await dlg.locator('[role="status"]').textContent();
  ok('message tells final vs next layer', /1 approved, 1 passed to the next approver/.test(msg1 || ''), msg1);
  await dlg.getByText(/Select all you can approve/).click();
  await dlg.getByRole('button', { name: /Approve selected \(1\)/ }).click(); await p.waitForTimeout(500);
  await p.getByRole('button', { name: 'Approve', exact: true }).click(); await p.waitForTimeout(4000);
  const msg2 = await dlg.locator('[role="status"]').textContent();
  ok('second round finishes the last one', /^1 approved\.$/.test(msg2 || '') && await dlg.getByText('Nothing is waiting.').isVisible(), msg2);
  await p.screenshot({ path: 's-recon.png' });
  ok('no page errors (Superadmin)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
console.log(`${pass}/${n}`);
await b.close();
