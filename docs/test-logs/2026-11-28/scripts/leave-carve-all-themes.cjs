const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.B || 'http://localhost:3200', D = __dirname, PRE = process.env.PRE || 'all';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const CASES = JSON.parse(process.env.CASES || '[["orange","light"],["default","light"],["apple-glow","light"],["mono","light"],["orange","lightglass"],["orange","dark"],["orange","glass"]]');
(async () => {
  const dept = Number(sql("SELECT MAX(id) FROM departments WHERE name='Engineering'"));
  const email = sql(`SELECT u.email FROM users u JOIN departments d ON d.head_user_id=u.id WHERE d.id=${dept}`);
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password: 'Demo#2026pass' }) })).json();
  const b = await chromium.launch();
  for (const vp of (process.env.VP || 'mobile,desktop').split(',')) {
    const ctx = await b.newContext(vp === 'mobile' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} window.androidBridge = { postMessage() {} }; }, [a.token, a.user]);
    const p = await ctx.newPage();
    await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });
    for (const [theme, mode] of CASES) {
      await p.goto(B + '/'); await p.evaluate(([theme, mode]) => { localStorage.setItem('mpr_bg_theme_v2', theme); localStorage.setItem('mpr_color_mode', mode); }, [theme, mode]);
      await p.reload(); const card = p.locator('.leave-card:visible').first(); try { await card.waitFor({ state: 'visible', timeout: 60000 }); } catch (e) { await p.screenshot({ path: D + '/fail.png' }); console.log('fail', await p.evaluate(() => document.querySelectorAll('.leave-card').length)); throw e; } await p.waitForTimeout(2500);
      await p.evaluate(() => { const c = [...document.querySelectorAll('.leave-card')].find((e) => e.getBoundingClientRect().width > 0); c && c.scrollIntoView({ block: 'center' }); }); await p.waitForTimeout(600);
      const m = await p.evaluate(() => !![...document.querySelectorAll('.leave-head')].some((h) => h.style.maskImage || h.style.webkitMaskImage));
      const box = await p.evaluate(() => { const c = [...document.querySelectorAll('.leave-card')].find((e) => e.getBoundingClientRect().width > 0); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      await p.screenshot({ path: `${D}/${PRE}-${vp}-${theme}-${mode}.png`, clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: box.height + 24 } });
      console.log(vp, theme, mode, 'mask:', m);
    }
    await ctx.close();
  }
  await b.close();
})();
