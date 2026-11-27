// Leave application on a phone: the Reliever picker's list must stay in the
// part of the screen the keyboard leaves visible (the keyboard is simulated
// with the dev hook window.__credenceKeyboard, lib/keyboardInsetVar.ts).
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B = 'http://localhost:3200', out = process.argv[2] || '/tmp';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); localStorage.setItem(`mpr_user_section_${u.id}`, 'leave'); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); await p.goto(B + '/'); await p.waitForTimeout(8000);
  await p.getByRole('button', { name: /apply leave/i }).filter({ visible: true }).first().click(); await p.waitForTimeout(1500);
  const box = p.locator('input[aria-label="Reliever"], input[placeholder="Select Reliever"]').first();
  ok(await box.count() > 0, 'Reliever field is in the leave form');
  await box.scrollIntoViewIfNeeded(); await box.click();
  const KB = 330; await p.evaluate((h) => window.__credenceKeyboard(h), KB);
  await p.waitForTimeout(900);
  await box.type('a', { delay: 50 }); await p.waitForTimeout(800);
  const vh = p.viewportSize().height;
  const list = await p.locator('[role="listbox"]').first().boundingBox();
  const field = await box.boundingBox();
  console.log('screen', vh, 'keyboard top', vh - KB, 'field', JSON.stringify(field), 'list', JSON.stringify(list));
  ok(!!list, 'list is open while typing');
  if (list) {
    ok(list.y >= 0, 'list does not go above the screen');
    ok(list.y + list.height <= vh - KB + 1, 'list ends above the keyboard');
    ok(list.y + list.height <= field.y + 2 || list.y >= field.y + field.height - 2, 'list does not cover the field');
  }
  ok(field.y + field.height <= vh - KB + 1 && field.y >= 0, 'field itself is visible above the keyboard');
  await p.screenshot({ path: out + '/reliever-keyboard.png' });

  // Field just above the keyboard (the list has no room below): it must open
  // upwards and still stay on screen.
  await p.evaluate(() => { const i = document.querySelector('input[aria-label="Reliever"], input[placeholder="Select Reliever"]'); let el = i.parentElement; while (el && !(el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible')) el = el.parentElement; window.__sc = el; });
  for (let k = 0; k < 40; k++) {
    const f = await box.boundingBox();
    const d = f.y + f.height - (vh - KB - 20);
    if (Math.abs(d) < 6) break;
    await p.evaluate((dd) => { window.__sc.scrollTop += dd; }, d);
    await p.waitForTimeout(100);
  }
  await p.waitForTimeout(500);
  const f2 = await box.boundingBox(); const l2 = await p.locator('[role="listbox"]').first().boundingBox();
  console.log('low field', JSON.stringify(f2), 'list', JSON.stringify(l2));
  if (f2.y + f2.height > vh - KB - 40) {
    ok(!!l2 && l2.y + l2.height <= f2.y + 2, 'low field: list opens above it');
    ok(!!l2 && l2.y >= 0, 'low field: list stays on screen');
  } else console.log('SKIP low-field case (popup could not scroll the field that low)');
  await p.screenshot({ path: out + '/reliever-keyboard-low.png' });
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
