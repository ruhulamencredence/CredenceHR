// App open animation (BootIntroAnimation.tsx), production build on :3201,
// forced onto the native path (androidBridge). The app under it is hidden
// while it plays and shown again as it fades out; the sign-in picture's own
// animation waits for it; tap-to-skip still reveals the app.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B = process.env.BASE || 'http://localhost:3201';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const open = async (session) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => { window.androidBridge = { postMessage() {} }; });
    if (session) {
      const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@credence.test', password: 'ProbePass123' }) })).json();
      await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); }, [a.token, a.user]);
    }
    const p = await ctx.newPage(); p.errs = []; // The fake bridge has no native plugins; that error is the test's, not the app's.
    p.on('pageerror', (e) => { if (!/plugin is not implemented/.test(String(e))) p.errs.push(String(e)); }); return p;
  };
  const state = (p) => p.evaluate(() => ({
    attr: document.documentElement.hasAttribute('data-boot-intro'),
    intro: !!document.querySelector('.boot-intro'),
    rootHidden: (() => { const el = document.querySelector('#root > :not(.boot-intro)'); return el ? getComputedStyle(el).visibility === 'hidden' : null; })(),
    lottie: !!document.querySelector('.hero-art svg g'),
  }));

  // Sign-in screen.
  let p = await open(false);
  await p.goto(B + '/'); await p.waitForTimeout(1500);
  let s = await state(p);
  ok(s.intro && s.attr, 'sign-in: intro playing, <html data-boot-intro> set');
  ok(s.rootHidden === true, 'sign-in: the app under the intro is hidden while it plays');
  ok(!s.lottie, 'sign-in: the picture animation has not started under the intro');
  await p.waitForTimeout(6000);
  s = await state(p);
  ok(!s.intro && !s.attr, 'sign-in: intro gone, attribute removed');
  ok(s.rootHidden === false, 'sign-in: app visible again');
  ok(s.lottie, 'sign-in: picture animation started after the intro');
  ok(await p.getByText('Welcome').first().isVisible(), 'sign-in: the card is on screen');
  ok(p.errs.length === 0, 'sign-in: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();

  // Signed in: Home is revealed.
  p = await open(true);
  await p.goto(B + '/'); await p.waitForTimeout(1500);
  ok((await state(p)).rootHidden === true, 'signed in: app hidden under the intro');
  await p.waitForTimeout(6000);
  s = await state(p);
  ok(!s.attr && s.rootHidden === false, 'signed in: app visible after the intro');
  ok(p.errs.length === 0, 'signed in: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();

  // Tap to skip.
  p = await open(false);
  await p.goto(B + '/'); await p.waitForTimeout(1800);
  await p.locator('.boot-intro').click({ force: true }); await p.waitForTimeout(700);
  s = await state(p);
  ok(!s.intro && !s.attr && s.rootHidden === false, 'tap: intro skipped, app shown at once');
  await p.context().close();
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
