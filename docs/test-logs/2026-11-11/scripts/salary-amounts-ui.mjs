import pw from '/opt/node-tools/node_modules/playwright/index.js';
const { chromium } = pw; const B = 'http://localhost:3200';
const b = await chromium.launch();
let pass = 0, n = 0; const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, x); };
for (const who of ['payC', 'payB']) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/'); const ws = p.getByLabel('Workspace code');
  if (await ws.isVisible({ timeout: 20000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
  await p.getByPlaceholder(/Employee ID/).fill(who); await p.locator('input[type="password"]').fill('ProbePass123'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(8000);
  for (const t of ["Don't ask again", 'Not now', 'Later', 'Skip']) { const l = p.getByRole('button', { name: t }); if (await l.isVisible().catch(() => false)) await l.click(); }
  const clickText = (t) => p.evaluate((t) => { const el = [...document.querySelectorAll('span, button, a')].find((e) => e.textContent.trim() === t && e.offsetParent); (el?.closest('button, a') || el)?.click(); return !!el; }, t);
  await clickText('Payroll & Claims'); await p.waitForTimeout(800);
  console.log(who, 'opened Payroll:', await clickText('Payroll')); await p.waitForTimeout(7000);
  await p.screenshot({ path: `${who}-payroll.png`, fullPage: false });
  const body = await p.locator('body').innerText();
  const stars = (body.match(/\*\*\*\*\*/g) || []).length;
  const taka = (body.match(/৳\s?[1-9][\d,]*\.?\d*/g) || []);
  if (who === 'payC') { ok('payC: amounts shown as *****', stars > 0, `stars=${stars}`); ok('payC: no real ৳ amount on the page', taka.length === 0, taka.slice(0, 5).join(' ')); }
  else { ok('payB: real ৳ amounts shown', taka.length > 0, taka.slice(0, 3).join(' ')); ok('payB: no *****', stars === 0, `stars=${stars}`); }

  await clickText('Payroll List'); await p.waitForTimeout(2500);
  const mi = p.locator('input[type="month"]').locator('visible=true').last();
  if (await mi.count()) { await mi.fill('2026-09'); await mi.dispatchEvent('change'); await p.waitForTimeout(3500); }
  await p.screenshot({ path: `${who}-list.png`, fullPage: false });
  const lb = await p.locator('body').innerText();
  const lstars = (lb.match(/\*\*\*\*\*/g) || []).length, ltaka = (lb.match(/৳\s?[1-9][\d,]*\.?\d*/g) || []);
  if (who === 'payC') ok('payC list (Sep): ***** and no real amounts', lstars > 3 && ltaka.length === 0, `stars=${lstars} taka=${ltaka.slice(0,3)}`);
  else ok('payB list (Sep): real amounts', ltaka.length > 3 && lstars === 0, `taka=${ltaka.slice(0,3)}`);
  const edit = p.getByRole('button', { name: /^(Edit|Generate|Run Payroll|Mark as paid|Process)/ }).locator('visible=true');
  if (who === 'payC') ok('payC: no edit / run buttons', (await edit.count()) === 0, String(await edit.count()));
  ok(`${who}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}
console.log(`${pass}/${n}`);
await b.close();
