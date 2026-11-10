import pw from '/opt/node-tools/node_modules/playwright/index.js';
const { chromium } = pw; const B = 'http://localhost:3200', OUT = process.env.OUT;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
const R = []; const ok = (n, c, i = '') => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? ' — ' + i : '')); };
await p.goto(B + '/'); const ws = p.getByLabel('Workspace code');
if (await ws.isVisible({ timeout: 30000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
await p.getByPlaceholder(/Employee ID/).fill('admin@credence.test'); await p.locator('input[type="password"]').fill('ProbePass123'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(6000);
const go = async (t) => { await p.goto(`${B}/admin/${t}`); await p.waitForTimeout(4500); const l = p.getByRole('button', { name: "Don't ask again" }); if (await l.isVisible().catch(() => false)) await l.click(); };
// Departments: edit pencil inside the card opens edit mode
await go('departments');
const row = p.locator('table[data-phone-card] tbody tr').filter({ hasText: 'Finance' }).first();
await row.scrollIntoViewIfNeeded();
const btns = row.locator('button'); const n = await btns.count();
ok('departments: card has its buttons', n >= 2, `${n} buttons`);
await btns.first().click(); await p.waitForTimeout(1200);
// Since step 3 the edit form opens in the bottom sheet (PhoneSheet.tsx), outside <main>.
const editing = await p.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => getComputedStyle(d).display !== 'none' && d.querySelector('.phone-sheet-body input')));
ok('departments: edit button opens the edit sheet', editing);
await p.screenshot({ path: `${OUT}/dep-edit.png` });
// Employees: the edit (pencil) action on a card
await go('employees');
const er = p.locator('table[data-phone-card] tbody tr').filter({ hasText: 'Farhana' }).first(); await er.scrollIntoViewIfNeeded();
const eb = er.locator('button'); const en = await eb.count();
ok('employees: card buttons present', en >= 2, `${en}`);
await eb.nth(en - 2).click().catch(() => {}); await p.waitForTimeout(1500);
const dialogOpen = await p.locator('[role="dialog"], .fixed.inset-0').filter({ visible: true }).count();
ok('employees: card action opens its popup', dialogOpen > 0);
await p.screenshot({ path: `${OUT}/emp-action.png` });
await p.keyboard.press('Escape'); await p.goto(B + '/'); await p.waitForTimeout(2000);
// Approvals: Approve button inside the card is visible and enabled
await go('approvals');
const ap = p.locator('table[data-phone-card] tbody tr').first(); await ap.scrollIntoViewIfNeeded();
const appr = ap.getByRole('button', { name: 'Approve' });
ok('approvals: Approve visible on the card', await appr.isVisible().catch(() => false));
// tap targets in cards ≥ 32px
const small = await p.evaluate(() => [...document.querySelectorAll('table[data-phone-card] button')].filter((x) => x.offsetParent && x.getBoundingClientRect().height < 30).length);
ok('approvals: no tiny buttons in cards', small === 0, `${small}`);
// Users: Manage opens the access drawer
await go('users');
const ur = p.locator('table[data-phone-card] tbody tr').filter({ hasText: 'Imran' }).first(); await ur.scrollIntoViewIfNeeded();
await ur.getByRole('button', { name: 'Manage' }).click().catch(() => {}); await p.waitForTimeout(1500);
ok('users: Manage opens', (await p.locator('[role="dialog"], .fixed.inset-0').filter({ visible: true }).count()) > 0);
await p.screenshot({ path: `${OUT}/users-manage.png` });
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
console.log(`${R.filter(Boolean).length}/${R.length}`);
await b.close();
