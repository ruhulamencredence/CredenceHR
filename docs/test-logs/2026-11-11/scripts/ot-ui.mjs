// Overtime / guard screens in a real browser (desktop + phone).
// Run after ot-api.mjs and ot-ui-seed.sql. Screenshots go to $SHOTS_DIR (default /tmp/ot-shots).
import pw from '/opt/node-tools/node_modules/playwright/index.js';
const { chromium, devices } = pw;
const B = 'http://localhost:3200';
const OUT = (process.env.SHOTS_DIR || '/tmp/ot-shots') + '/'; // screenshots stay out of the repo
const b = await chromium.launch();
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };

async function open(who, phone = false) {
  const ctx = await b.newContext(phone ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/');
  const ws = p.getByLabel('Workspace code');
  if (await ws.isVisible({ timeout: 20000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
  await p.getByPlaceholder(/Employee ID/).fill(who);
  await p.locator('input[type="password"]').fill('ProbePass123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForTimeout(7000);
  for (const t of ["Don't ask again", 'Not now', 'Later', 'Skip']) { const l = p.getByRole('button', { name: t }); if (await l.isVisible().catch(() => false)) await l.click(); }
  return { ctx, p, errs };
}
const clickText = (p, t) => p.evaluate((t) => { const el = [...document.querySelectorAll('span, button, a')].find((e) => e.textContent.trim() === t && e.offsetParent); (el?.closest('button, a') || el)?.click(); return !!el; }, t);
const openRoster = async (p) => { await clickText(p, 'Attendance & Leave'); await p.waitForTimeout(800); await clickText(p, 'Duty Roster'); await p.waitForTimeout(6000); };
const shot = (p, name) => p.screenshot({ path: OUT + name + '.png' });
const pickSearch = async (p, label, text) => {
  const box = p.getByRole('combobox', { name: label }).locator('visible=true').first();
  await box.click(); await box.fill(text); await p.waitForTimeout(400);
  await p.getByRole('option', { name: new RegExp(text, 'i') }).first().click();
};

// ---- Nasrin: Payroll -> OT Rules ----
{
  const { ctx, p, errs } = await open('nasrin.sultana@credence.test');
  await p.goto(B + '/self/payroll'); await p.waitForTimeout(6000);
  const tab = p.getByRole('button', { name: 'OT Rules', exact: true });
  ok('Nasrin sees the OT Rules tab in Payroll', await tab.isVisible());
  await tab.click(); await p.waitForTimeout(2500);
  ok('OT Rules: rate type, who approves, own rates, who gets OT', await p.getByText('How the hourly rate is worked out').isVisible() && await p.getByRole('radiogroup', { name: 'Who approves OT' }).isVisible() && await p.getByText(/Own rate for a designation/i).isVisible() && await p.getByText(/Who gets OT/).first().isVisible());
  ok('the guard rate shows (৳100 / h)', await p.getByText(/Security Guard/).first().isVisible() && (await p.locator('body').innerText()).includes('৳ 100'));
  await shot(p, 'ot-rules');
  await p.getByRole('radio', { name: 'Roster manager' }).check();
  await p.getByRole('button', { name: 'Save rules' }).click(); await p.waitForTimeout(1500);
  ok('saving the approver works', await p.getByText('OT rules saved.').isVisible());
  await p.getByRole('radio', { name: 'Either one' }).check();
  await p.getByRole('button', { name: 'Save rules' }).click(); await p.waitForTimeout(1500);
  // Who gets OT: turn Sadia on, then off again
  await p.getByLabel('Search people').fill('Sadia'); await p.waitForTimeout(400);
  await p.getByRole('switch', { name: 'Gets OT: Sadia Karim' }).click(); await p.waitForTimeout(1500);
  ok('Gets OT switch for one person', (await p.getByRole('switch', { name: 'Gets OT: Sadia Karim' }).getAttribute('aria-checked')) === 'true');
  await p.getByRole('switch', { name: 'Gets OT: Sadia Karim' }).click(); await p.waitForTimeout(1500);
  ok('no page errors (OT Rules)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---- Nasrin: Duty Roster -> Shifts, Roster, OT Approval, Guard Posts ----
{
  const { ctx, p, errs } = await open('nasrin.sultana@credence.test');
  await openRoster(p);
  ok('Duty Roster shows the OT Approval and Guard Posts tabs', await p.getByRole('button', { name: 'OT Approval', exact: true }).isVisible() && await p.getByRole('button', { name: 'Guard Posts', exact: true }).isVisible());
  await p.getByRole('button', { name: 'Shifts', exact: true }).click(); await p.waitForTimeout(1500);
  ok('Shifts list: "Paid as OT" / "In the salary"', await p.getByText('Paid as OT').first().isVisible() && await p.getByText('In the salary').first().isVisible());
  await shot(p, 'roster-shifts');
  await p.getByRole('button', { name: 'Edit Guard Day' }).click(); await p.waitForTimeout(800);
  ok('shift form: normal hours + hours over normal', (await p.getByLabel('Normal hours (overtime)').inputValue()) === '8' && await p.getByText(/earns 4 h of OT/).isVisible());
  await shot(p, 'roster-shift-form');
  await p.getByRole('button', { name: 'Cancel' }).click();
  await p.getByRole('button', { name: 'Roster', exact: true }).click(); await p.waitForTimeout(2500);
  ok('roster grid: OT badge on people who get OT, +2 on a day', (await p.locator('text=OT').count()) > 0 && (await p.locator('sup', { hasText: '+2' }).count()) > 0);
  ok('OT brushes (+1h / +2h / No OT)', await p.getByRole('button', { name: '+2h' }).isVisible() && await p.getByRole('button', { name: 'No OT' }).isVisible());
  await shot(p, 'roster-grid');

  await p.getByRole('button', { name: 'OT Approval', exact: true }).click(); await p.waitForTimeout(4000);
  const rows = await p.locator('tbody tr').count();
  ok('OT Approval lists the waiting days', rows >= 2, String(rows));
  await shot(p, 'ot-approval');
  await p.getByLabel('Select all you can approve').check();
  const box = p.getByLabel(/Approved hours for Rafiq Ahmed/).first();
  await box.fill('2:00');
  await p.getByRole('button', { name: /Approve selected/ }).click(); await p.waitForTimeout(800);
  await shot(p, 'ot-approval-confirm');
  ok('approve asks first (liquid-glass confirm)', await p.locator('.liquid-glass').filter({ hasText: /Approve \d+ overtime/ }).first().isVisible());
  await p.getByRole('button', { name: 'Approve', exact: true }).click(); await p.waitForTimeout(3000);
  ok('approved message', await p.getByText(/approved/).first().isVisible());
  ok('nothing left waiting', await p.getByText('No overtime waiting for you this month.').isVisible());
  await p.getByRole('button', { name: 'Approved', exact: true }).click(); await p.waitForTimeout(2500);
  await shot(p, 'ot-approval-approved');

  await p.getByRole('button', { name: 'Guard Posts', exact: true }).click(); await p.waitForTimeout(3000);
  for (let i = 0; i < 1; i++) { await p.getByRole('button', { name: 'Next week' }).click(); await p.waitForTimeout(2000); }
  ok('Guard Posts: coverage with empty posts in red', await p.getByText(/empty — put relief/).first().isVisible());
  await shot(p, 'guard-coverage');
  await p.getByText(/empty — put relief/).first().click(); await p.waitForTimeout(2000);
  ok('relief popup lists who is free', await p.getByRole('combobox', { name: 'Relief guard' }).isVisible());
  await pickSearch(p, 'Relief guard', 'Rafiq');
  await shot(p, 'guard-relief');
  await p.getByRole('button', { name: 'Put as relief' }).click(); await p.waitForTimeout(2500);
  ok('relief put on the post', await p.getByText(/Rafiq Ahmed \(relief\)/).first().isVisible());
  await p.getByRole('button', { name: /Fill the month with a pattern/ }).click(); await p.waitForTimeout(800);
  await shot(p, 'guard-pattern');
  await p.getByRole('button', { name: 'Cancel' }).click();
  ok('no page errors (Duty Roster)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---- Kamal: none of it ----
{
  const { ctx, p } = await open('kamal.uddin@credence.test');
  await openRoster(p);
  ok('Kamal opened Duty Roster', await p.getByRole('button', { name: 'Shifts', exact: true }).isVisible());
  ok('Kamal: no OT Approval / Guard Posts tabs', !(await p.getByRole('button', { name: 'OT Approval', exact: true }).isVisible()) && !(await p.getByRole('button', { name: 'Guard Posts', exact: true }).isVisible()));
  await p.goto(B + '/self/payroll'); await p.waitForTimeout(5000);
  ok('Kamal: no OT Rules tab', !(await p.getByRole('button', { name: 'OT Rules', exact: true }).isVisible()));
  await ctx.close();
}

// ---- Phone: Tanvir Team OT, Rafiq My OT ----
{
  const { ctx, p, errs } = await open('tanvir.r@credence.test', true);
  await p.goto(B + '/self/team-ot'); await p.waitForTimeout(5000);
  ok('Tanvir (phone): Team OT opens', await p.getByText(/Who approves OT/).isVisible());
  await p.getByRole('button', { name: 'All', exact: true }).click(); await p.waitForTimeout(2500);
  await shot(p, 'phone-team-ot');
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('Team OT fits the phone (no sideways scroll)', w <= 1, String(w));
  ok('no page errors (Team OT)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const { ctx, p, errs } = await open('rafiq.ahmed@credence.test', true);
  await p.goto(B + '/self/my-ot'); await p.waitForTimeout(4000);
  for (let i = 0; i < 0; i++) {}
  const prev = p.getByRole('button', { name: 'Previous month' });
  if (!(await p.getByText(/November 2026/).isVisible())) await prev.click();
  await p.waitForTimeout(2500);
  ok('Rafiq (phone): My OT shows approved hours', await p.getByText('Approved', { exact: true }).first().isVisible());
  await shot(p, 'phone-my-ot');
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('My OT fits the phone', w <= 1, String(w));
  ok('no page errors (My OT)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---- Superadmin: Run Payroll step 3 ----
{
  const { ctx, p, errs } = await open('admin@credence.test');
  await p.goto(B + '/self/payroll'); await p.waitForTimeout(6000);
  const run = p.getByRole('button', { name: /Run Payroll/ }).first();
  await run.click(); await p.waitForTimeout(1500);
  const month = p.locator('input[type="month"]').locator('visible=true').last();
  if (await month.count()) { await month.fill('2026-11'); await month.dispatchEvent('change'); }
  await p.getByRole('button', { name: /^Next/ }).click(); await p.waitForTimeout(8000);
  await p.getByRole('button', { name: /^Next/ }).click(); await p.waitForTimeout(1500);
  ok('Run Payroll step 3: OT filled from OT Approval', await p.getByText('From OT Approval').first().isVisible());
  await shot(p, 'run-payroll-ot');
  const row = p.locator('tr', { hasText: 'Rafiq Ahmed' });
  await row.locator('input[type="number"]').first().fill('7');
  await p.waitForTimeout(500);
  ok('changing OT asks for a reason and stops Next', await p.getByText(/write the reason/).isVisible() && await p.getByRole('button', { name: /^Next/ }).isDisabled());
  await shot(p, 'run-payroll-ot-reason');
  await p.getByLabel(/Reason for changing Rafiq Ahmed/).fill('Stock count night');
  ok('with a reason, Next is back', await p.getByRole('button', { name: /^Next/ }).isEnabled());
  ok('no page errors (Run Payroll)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
console.log(`\n${pass}/${n} passed`);
await b.close();
process.exit(pass === n ? 0 : 1);
