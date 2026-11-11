// Departments -> Edit: Head of Department + teams, in a real browser.
// Run after dept-api.mjs. Screenshots go to $SHOTS_DIR (default /tmp/dept-shots).
import pw from '/opt/node-tools/node_modules/playwright/index.js';
import { execSync } from 'node:child_process';
const { chromium, devices } = pw;
const B = 'http://localhost:3200';
const OUT = (process.env.SHOTS_DIR || '/tmp/dept-shots') + '/';
execSync(`mkdir -p ${OUT}`);
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
sql("DELETE FROM department_teams WHERE name = 'Audit'");
const b = await chromium.launch();
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };
async function open(phone = false) {
  const ctx = await b.newContext(phone ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/'); const ws = p.getByLabel('Workspace code');
  if (await ws.isVisible({ timeout: 20000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
  await p.getByPlaceholder(/Employee ID/).fill('admin@credence.test'); await p.locator('input[type="password"]').fill('ProbePass123'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(7000);
  for (const t of ["Don't ask again", 'Not now', 'Later', 'Skip']) { const l = p.getByRole('button', { name: t }); if (await l.isVisible().catch(() => false)) await l.click(); }
  await p.goto(B + '/admin/departments'); await p.waitForTimeout(5000);
  return { ctx, p, errs };
}
const pick = async (p, label, text) => {
  const box = p.getByRole('combobox', { name: label }).locator('visible=true').first();
  await box.click(); await box.fill(text); await p.waitForTimeout(400);
  await p.getByRole('option', { name: new RegExp(text, 'i') }).first().click();
};
{
  const { ctx, p, errs } = await open();
  await p.getByText('Teams · Supervisor · People').first().waitFor({ timeout: 15000 }).catch(() => {});
  ok('list shows Head and teams columns', (await p.locator('th').allInnerTexts()).some((x) => x.trim().toLowerCase() === 'head') && await p.getByText('Teams · Supervisor · People').first().isVisible());
  await p.screenshot({ path: OUT + 'dept-list.png' });
  await p.locator('tr', { hasText: 'Finance' }).getByTitle('Edit').click(); await p.waitForTimeout(2500);
  ok('Edit shows the Head of Department picker and the teams', await p.getByRole('combobox', { name: 'Head of Department' }).isVisible() && await p.getByRole('textbox', { name: 'Team 1 name' }).isVisible());
  await p.screenshot({ path: OUT + 'dept-edit.png' });
  await p.getByRole('button', { name: 'Add team' }).click();
  await p.getByRole('textbox', { name: 'Team 3 name' }).fill('Audit');
  await pick(p, 'Supervisor of Audit', 'Kamal');
  await pick(p, 'Add member to Audit', 'Farhana');
  ok('member added as a chip', await p.getByRole('button', { name: /Take Farhana Akter out of Audit/ }).isVisible());
  await p.screenshot({ path: OUT + 'dept-edit-new-team.png' });
  await p.getByRole('button', { name: 'Save Changes' }).click(); await p.waitForTimeout(3000);
  ok('saved: Audit team with Kamal and Farhana', sql("SELECT CONCAT(t.supervisor_user_id, ':', GROUP_CONCAT(m.employee_id)) FROM department_teams t JOIN department_team_members m ON m.team_id = t.id WHERE t.name = 'Audit' GROUP BY t.id") === '140:36');
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const { ctx, p, errs } = await open(true);
  await p.screenshot({ path: OUT + 'phone-dept-list.png' });
  const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('Departments page fits the phone', w <= 1, String(w));
  ok('no page errors (phone)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
console.log(`\n${pass}/${n} passed`);
await b.close();
process.exit(pass === n ? 0 : 1);
