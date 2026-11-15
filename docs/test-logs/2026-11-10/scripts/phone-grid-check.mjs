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
for (const t of ['duty-roster', 'attendance-reports']) {
  await p.goto(`${B}/admin/${t}`); await p.waitForTimeout(5000);
  const l = p.getByRole('button', { name: "Don't ask again" }); if (await l.isVisible().catch(() => false)) await l.click();
  const tbl = p.locator('table[data-phone-grid]').first(); await tbl.scrollIntoViewIfNeeded();
  const r = await p.evaluate(() => {
    const t = document.querySelector('table[data-phone-grid]'); const box = t.parentElement;
    const first = t.querySelector('tbody tr > :first-child'); const x0 = first.getBoundingClientRect().left;
    box.scrollLeft = 400; const x1 = first.getBoundingClientRect().left;
    const dayCells = [...t.querySelectorAll('thead tr > :not(:first-child)')].filter((c) => { const r = c.getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= first.getBoundingClientRect().right - 1; }).length;
    return { w: Math.round(first.getBoundingClientRect().width), stays: Math.abs(x0 - x1) < 2, scrolled: box.scrollLeft, visibleDays: dayCells, overflowPage: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/${t}.png` });
  ok(`${t}: name column stays while days scroll`, r.stays && r.scrolled > 0, JSON.stringify(r));
  ok(`${t}: name column narrow (≤ 120px)`, r.w <= 120);
  ok(`${t}: page itself does not scroll sideways`, !r.overflowPage);
}
// duty roster: paint a cell still works
await p.goto(`${B}/admin/duty-roster`); await p.waitForTimeout(5000);
const cell = p.locator('table[data-phone-grid] tbody tr').nth(1).locator('td').nth(3);
await cell.scrollIntoViewIfNeeded(); const before = (await cell.innerText()).trim(); await cell.click(); await p.waitForTimeout(1200);
const after = (await cell.innerText()).trim();
ok('duty roster: tapping a day paints it', before !== after, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
console.log(`${R.filter(Boolean).length}/${R.length}`);
await b.close();
