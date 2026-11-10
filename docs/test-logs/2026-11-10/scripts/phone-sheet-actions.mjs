import pw from '/opt/node-tools/node_modules/playwright/index.js';
const { chromium } = pw; const B = 'http://localhost:3200', OUT = process.env.OUT;
const b = await chromium.launch();
const R = []; const ok = (n, c, i = '') => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? ' — ' + i : '')); };
const login = async (vp, mobile) => {
  const ctx = await b.newContext({ viewport: vp, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); });
  const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(String(e)));
  await p.goto(B + '/'); const ws = p.getByLabel('Workspace code');
  if (await ws.isVisible({ timeout: 30000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
  await p.getByPlaceholder(/Employee ID/).fill('admin@credence.test'); await p.getByPlaceholder('••••••••').fill('ProbePass123'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(6000);
  return p;
};
const go = async (p, t) => { await p.goto(`${B}/admin/${t}`); await p.waitForTimeout(4500); const l = p.getByRole('button', { name: "Don't ask again" }); if (await l.isVisible().catch(() => false)) await l.click(); };
const sheetOpen = (p) => p.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => getComputedStyle(d).display !== 'none' && d.querySelector('.phone-sheet-body')));

const p = await login({ width: 390, height: 844 }, true);
// Departments
await go(p, 'departments');
ok('dep: form hidden, Add button shown', !(await p.getByPlaceholder('e.g. Accounts & Finance').isVisible().catch(() => false)) && await p.getByRole('button', { name: 'Add Department' }).first().isVisible());
await p.screenshot({ path: `${OUT}/dep-list.png` });
const before = await p.locator('table[data-phone-card] tbody tr').count();
await p.getByRole('button', { name: 'Add Department' }).first().click(); await p.waitForTimeout(600);
ok('dep: sheet opens', await sheetOpen(p));
await p.screenshot({ path: `${OUT}/dep-sheet.png` });
await p.getByPlaceholder('e.g. Accounts & Finance').fill('Phone Test Dept');
await p.locator('.phone-sheet-body button[type="submit"]').click(); await p.waitForTimeout(2500);
const after = await p.locator('table[data-phone-card] tbody tr').count();
ok('dep: saved and sheet closed', after === before + 1 && !(await sheetOpen(p)), `${before} -> ${after}`);
// edit -> sheet opens with Edit title; close cancels edit
const row = p.locator('table[data-phone-card] tbody tr').filter({ hasText: 'Phone Test Dept' }).first(); await row.scrollIntoViewIfNeeded();
await row.locator('button').first().click(); await p.waitForTimeout(800);
ok('dep: edit opens the sheet', await sheetOpen(p) && await p.locator('.phone-sheet-body').getByText('Save Changes').isVisible());
await p.screenshot({ path: `${OUT}/dep-edit-sheet.png` });
await p.getByRole('button', { name: 'Close' }).last().click(); await p.waitForTimeout(600);
ok('dep: close cancels the edit', !(await sheetOpen(p)));
// Projects add sheet
await go(p, 'projects');
await p.getByRole('button', { name: 'Add Project' }).first().click(); await p.waitForTimeout(600);
ok('projects: sheet opens with the form', await sheetOpen(p) && await p.getByPlaceholder('e.g. Metro Rail Extension').isVisible());
await p.getByRole('button', { name: 'Close' }).last().click();
// Remote attendance filters
await go(p, 'attendance');
await p.getByRole('button', { name: /^Filters/ }).first().click(); await p.waitForTimeout(600);
ok('attendance: filter sheet opens', await sheetOpen(p));
await p.screenshot({ path: `${OUT}/att-filter.png` });
await p.locator('.phone-sheet-body input[type="date"]').first().fill('2026-11-01');
await p.locator('.phone-sheet-body').getByRole('button', { name: 'Apply' }).click(); await p.waitForTimeout(1500);
ok('attendance: Apply closes the sheet', !(await sheetOpen(p)));
ok('attendance: filter count shows 1', /Filters\s*1/.test(await p.getByRole('button', { name: /^Filters/ }).first().innerText()));
// PEPM reports filters
await go(p, 'reports');
await p.getByRole('button', { name: /^Filters/ }).first().click(); await p.waitForTimeout(600);
ok('reports: filter sheet opens', await sheetOpen(p));
await p.getByRole('button', { name: 'Close' }).last().click();
// Users add
await go(p, 'users');
ok('users: Add New User button', await p.getByRole('button', { name: 'Add New User' }).first().isVisible());
// Fold
await go(p, 'approvals');
const fold = p.locator('p[data-phone-fold]').first();
const h1 = (await fold.boundingBox())?.height || 0; await fold.click(); await p.waitForTimeout(300); const h2 = (await fold.boundingBox())?.height || 0;
ok('approvals: explanation folded, tap opens', h1 > 0 && h1 < 50 && h2 > h1, `${h1} -> ${h2}`);
await p.screenshot({ path: `${OUT}/approvals-fold.png` });
ok('phone: no page errors', p.errs.length === 0, p.errs.slice(0, 2).join(' | '));
// Desktop: forms inline, no sheet buttons
const d = await login({ width: 1440, height: 900 });
await go(d, 'departments');
ok('desktop: Add Department form inline', await d.getByPlaceholder('e.g. Accounts & Finance').isVisible());
await go(d, 'attendance');
ok('desktop: filters inline, no Filters button', await d.locator('input[type="date"]').first().isVisible() && (await d.getByRole('button', { name: /^Filters/ }).count()) === 0);
await go(d, 'approvals');
ok('desktop: nothing folded', (await d.locator('[data-phone-fold]').count()) === 0);
ok('desktop: no page errors', d.errs.length === 0);
console.log(`${R.filter(Boolean).length}/${R.length}`);
await b.close();
