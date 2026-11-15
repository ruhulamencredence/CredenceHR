// Users page: "N accounts can't use the Mobile App", Show them, Turn on for
// all, the bulk bar's Mobile App buttons, the new-account setting.
// Screenshots to $SHOTS_DIR (default /tmp/app-shots).
import pw from '/opt/node-tools/node_modules/playwright/index.js';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3200';
const OUT = (process.env.SHOTS_DIR || '/tmp/app-shots') + '/';
execSync(`mkdir -p ${OUT}`);
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
sql('UPDATE users SET can_use_app = 0 WHERE id IN (141,142,143,144,145,146)');
const b = await pw.chromium.launch();
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(B + '/'); const ws = p.getByLabel('Workspace code');
if (await ws.isVisible({ timeout: 20000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
await p.getByPlaceholder(/Employee ID/).fill('admin@credence.test'); await p.locator('input[type="password"]').fill('ProbePass123'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(7000);
for (const t of ["Don't ask again", 'Not now', 'Later', 'Skip']) { const l = p.getByRole('button', { name: t }); if (await l.isVisible().catch(() => false)) await l.click(); }
await p.goto(B + '/admin/users'); await p.waitForTimeout(6000);
const off = Number(sql("SELECT COUNT(*) FROM users WHERE can_use_app = 0 AND role <> 'superadmin' AND COALESCE(is_blocked,0) = 0"));
ok(`banner: ${off} accounts can't use the Mobile App`, await p.getByText(new RegExp(`${off} accounts can't use the Mobile App yet`)).isVisible());
ok('"No app" label on their rows', (await p.getByText('No app', { exact: true }).count()) >= off);
ok('the new-account setting shows On', await p.getByText(/New accounts get the Mobile App:/).isVisible() && (await p.getByRole('switch', { name: 'New accounts get the Mobile App' }).getAttribute('aria-checked')) === 'true');
await p.screenshot({ path: OUT + 'users-banner.png' });
await p.getByRole('button', { name: 'Show them' }).click(); await p.waitForTimeout(800);
ok('Show them: only accounts without the app', (await p.locator('tbody tr').locator('visible=true').count()) === off, String(await p.locator('tbody tr').locator('visible=true').count()));
// tick two and use the bulk bar
await p.getByLabel(/Select Bulk Tester 1/).locator('visible=true').first().check(); await p.getByLabel(/Select Bulk Tester 2/).locator('visible=true').first().check();
ok('bulk bar has Mobile App Turn on / Turn off', await p.getByRole('button', { name: 'Turn on', exact: true }).isVisible() && await p.getByRole('button', { name: 'Turn off', exact: true }).isVisible());
await p.screenshot({ path: OUT + 'users-bulk.png' });
await p.getByRole('button', { name: 'Turn on', exact: true }).click(); await p.waitForTimeout(600);
await p.locator('.liquid-glass').getByRole('button', { name: 'Turn on' }).click(); await p.waitForTimeout(2500);
ok('bulk: 2 turned on', sql('SELECT SUM(can_use_app) FROM users WHERE id IN (142,143)') === '2');
// turn on for all the rest
await p.getByRole('button', { name: /Turn on for all/ }).click(); await p.waitForTimeout(600);
await p.screenshot({ path: OUT + 'users-confirm.png' });
await p.locator('.liquid-glass').getByRole('button', { name: 'Turn on' }).click(); await p.waitForTimeout(3000);
ok('Turn on for all: nobody left without the app', sql("SELECT COUNT(*) FROM users WHERE can_use_app = 0 AND role <> 'superadmin'") === '0');
ok('banner gone', !(await p.getByText(/can't use the Mobile App yet/).isVisible()));
await p.screenshot({ path: OUT + 'users-after.png' });
ok('no page errors', errs.length === 0, errs.join(' | '));
console.log(`\n${pass}/${n} passed`);
await b.close();
process.exit(pass === n ? 0 : 1);
