// Conveyance Disbursement toolbar in the browser. Run after disb-setup.sql.
// Screenshots to $SHOTS_DIR (default /tmp/disb-shots).
import pw from '/opt/node-tools/node_modules/playwright/index.js';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3200';
const OUT = (process.env.SHOTS_DIR || '/tmp/disb-shots') + '/';
execSync(`mkdir -p ${OUT}`);
const b = await pw.chromium.launch();
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };
async function signIn(viewport) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} });
  const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(String(e)));
  await p.goto(B + '/'); const ws = p.getByLabel('Workspace code');
  if (await ws.isVisible({ timeout: 20000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
  await p.getByPlaceholder(/Employee ID/).fill('admin@credence.test'); await p.locator('input[type="password"]').fill('ProbePass123'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(7000);
  for (const t of ["Don't ask again", 'Not now', 'Later', 'Skip']) { const l = p.getByRole('button', { name: t }); if (await l.isVisible().catch(() => false)) await l.click(); }
  await p.goto(B + '/admin/disbursement'); await p.waitForTimeout(6000);
  return { ctx, p };
}
const rows = (p) => p.locator('table tbody tr').locator('visible=true');
const pick = async (p, label, text) => { const box = p.getByRole('combobox', { name: label }).locator('visible=true').first(); await box.click(); await box.fill(text); await p.waitForTimeout(300); await p.getByRole('option', { name: new RegExp(text) }).locator('visible=true').first().click(); await p.waitForTimeout(1500); };

let { ctx, p } = await signIn({ width: 1440, height: 900 });
ok('toolbar has every filter', await p.locator('#disb-search').isVisible() && await p.getByRole('combobox', { name: 'Department' }).isVisible() && await p.getByRole('combobox', { name: 'Employee' }).isVisible() && await p.locator('#disb-bill').isVisible() && await p.locator('#disb-paid').isVisible() && await p.getByRole('combobox', { name: 'Disbursed by' }).isVisible() && await p.getByRole('combobox', { name: 'Category' }).isVisible() && await p.getByLabel('Source').isVisible() && await p.getByLabel('Amount from').isVisible());
ok('Employee column shows the designation under the name', await p.getByRole('row', { name: /Rafiq Ahmed\s*EMP-0048 · Officer, Accounts\s*Finance/ }).first().isVisible());
ok('summary line shows the totals', /\d+ bills?/.test(await p.getByTestId('disb-summary').innerText()));
await pick(p, 'Department', 'MIS');
ok('Department MIS: only Tanvir', (await rows(p).count()) === 1 && await p.getByRole('row', { name: /Tanvir Hasan/ }).isVisible(), String(await rows(p).count()));
ok('…a chip shows it', await p.getByTestId('disb-chips').getByText('Department: MIS').isVisible());
await p.getByRole('button', { name: 'Remove Department: MIS' }).click(); await p.waitForTimeout(1500);
await p.locator('#disb-search').fill('rafiq'); await p.waitForTimeout(1800);
ok('Search "rafiq": his two pending bills', (await rows(p).count()) === 2, String(await rows(p).count()));
await pick(p, 'Category', 'Food');
ok('+ Category Food: one bill', (await rows(p).count()) === 1);
await p.screenshot({ path: OUT + 'desktop-filters.png' });
await p.getByRole('button', { name: 'Clear all' }).click(); await p.waitForTimeout(1500);
ok('Clear all removes every chip', !(await p.getByTestId('disb-chips').count()));
await p.getByRole('button', { name: 'all', exact: true }).click(); await p.waitForTimeout(1200);
await p.locator('#disb-paid').selectOption('custom');
await p.getByLabel('Disbursed date from').fill('2025-03-01'); await p.getByLabel('Disbursed date to').fill('2025-03-31'); await p.waitForTimeout(1800);
ok('Disbursed date (picked dates): the 2025 bill', (await rows(p).count()) === 1 && await p.getByRole('row', { name: /PV-QA-OLD/ }).isVisible());
await p.locator('#disb-paid').selectOption('any'); await p.waitForTimeout(800);
await p.getByLabel('Amount from').fill('1000'); await p.waitForTimeout(1800);
ok('Amount from 1000', (await rows(p).count()) === 2, String(await rows(p).count()));
ok('no page errors', p.errs.length === 0, p.errs.join(' | '));
await ctx.close();

({ ctx, p } = await signIn({ width: 390, height: 844 }));
const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok('phone: fits the screen', over <= 1, String(over));
ok('phone: Search shown, other filters behind a Filters button', await p.locator('#disb-search').isVisible() && await p.getByRole('button', { name: /Filters/ }).isVisible() && !(await p.getByRole('combobox', { name: 'Department' }).locator('visible=true').count()));
ok('phone: card shows designation', await p.getByText(/EMP-0048 · Officer, Accounts · Finance/).first().isVisible());
await p.screenshot({ path: OUT + 'phone-list.png' });
await p.getByRole('button', { name: /Filters/ }).click(); await p.waitForTimeout(800);
await p.screenshot({ path: OUT + 'phone-sheet.png' });
ok('phone: the sheet has the filters', await p.getByRole('combobox', { name: 'Department' }).locator('visible=true').first().isVisible() && await p.getByLabel('Amount from').locator('visible=true').first().isVisible());
await ctx.close();
await b.close();
console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
