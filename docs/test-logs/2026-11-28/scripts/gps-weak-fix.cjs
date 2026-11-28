// A weak GPS fix (what a cold phone gives: a Wi-Fi / tower guess, ±1500 m) on
// Remote Attendance (In Time popup) and Check In/Out (map).
//   android-weak  the Android app (fake-android-bridge.cjs) whose GPS stays weak:
//                 a weak fix must not be submitted; a good one then is
//   android-warm  the Android app whose GPS warms up (1500 -> 400 -> 120 -> 12 m
//                 over a few readings): Submit unlocks by itself, no tapping
//   web           a browser / desktop has no GPS: a weak fix may go, with a warning
// Also: the app asks the phone to warm its GPS up while these screens are open
// and stops it when they close (android only).
// Run it before the fix (it fails where the app lets a weak fix through) and
// after (all pass). Dev server on :3200.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const fake = require('./fake-android-bridge.cjs');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const PASS = 'Gps#2026pass';
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const tryAcc = (q) => { try { return sql(q); } catch { return 'no column'; } };
const cols = (t) => sql(`SELECT GROUP_CONCAT(column_name) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='${t}' AND column_name LIKE '%accuracy%'`);

async function person(SA, tag, kind) {
  const email = `gps.${kind}.${tag}@credence.test`;
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const e = await (await fetch(B + '/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SA }, body: JSON.stringify({ name: `Gps ${kind} ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS }) })).json();
  const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.id}`));
  sql(`UPDATE users SET must_change_password=0, can_use_attendance=1, can_view_movement_claims=1 WHERE id=${uid}`);
  return { uid, auth: await login(email, PASS) };
}

(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const ho = sql('SELECT id, location_lat, location_lng, location_radius FROM projects WHERE location_lat IS NOT NULL ORDER BY id LIMIT 1').split('\t');
  const [lat, lng] = [Number(ho[1]), Number(ho[2])];
  const near = { latitude: lat + 0.0001, longitude: lng + 0.0001 };
  const WARM = [1500, 400, 120, 12].map((accuracy) => ({ ...near, accuracy }));
  const b = await chromium.launch();

  for (const mode of ['android-weak', 'android-warm', 'web']) {
    const { uid, auth } = await person(SA, tag, mode);
    const android = mode.startsWith('android');
    const warm = mode === 'android-warm';
    const finalAcc = warm ? 12 : android ? 10 : 1500;
    console.log(`--- ${mode}`);
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, geolocation: { ...near, accuracy: 1500 }, permissions: ['geolocation'] });
    await ctx.addInitScript(([t, u]) => {
      localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u));
      for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9));
      localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9));
      try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {}
    }, [auth.token, auth.user]);
    if (android) {
      await fake.install(ctx);
      await ctx.addInitScript((f) => { window.__fake.fix = f; }, { ...near, accuracy: 1500 });
    }
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (x) => { if (!/not implemented/i.test(String(x))) errs.push(String(x)); });
    const setFix = (acc) => (android ? p.evaluate((f) => { window.__fake.fix = f; window.__fake.queue = []; }, { ...near, accuracy: acc }) : ctx.setGeolocation({ ...near, accuracy: acc }));
    const startWarm = () => (warm ? p.evaluate((q) => { window.__fake.queue = q; }, WARM) : null);
    const callCount = (m) => p.evaluate((n) => window.__fake.calls.filter((c) => c.plugin === 'LocationAccess' && c.method === n).length, m);
    await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });

    // ---- Remote Attendance (In Time popup) ----
    await p.goto(B + '/'); await p.getByRole('button', { name: 'Set Now' }).first().waitFor({ timeout: 90000 }); await p.waitForTimeout(1500);
    await startWarm();
    await p.getByRole('button', { name: 'Set Now' }).first().click();
    const dlg = p.getByRole('dialog', { name: 'In Time' }); await dlg.waitFor({ timeout: 20000 });
    if (android) ok((await callCount('warmUp')) >= 1, `${mode}: the app asks the phone to warm its GPS up when In Time opens`);
    await p.waitForTimeout(warm ? 12000 : 10000); // the retry window
    const st = (await p.getByTestId('attendance-map-status').innerText()).trim();
    console.log('  status:', st);
    const submit = dlg.getByRole('button', { name: /Submit|Locating|Weak GPS/ });
    if (warm) {
      ok(await dlg.getByRole('button', { name: 'Submit' }).isEnabled(), 'android-warm: Submit unlocks by itself once the GPS is good');
      ok(/inside/.test(st) && !/±\s?1500/.test(st), 'android-warm: the map ends on the good fix, inside the area');
    } else {
      ok(/±\s?1500/.test(st), `${mode}: the weak fix is named on the map (±1500 m)`);
      ok(/weak|only|may be wrong/i.test(st), `${mode}: the map says the position may be wrong`);
      if (android) ok(await submit.isDisabled(), 'android-weak: Submit stays off on a weak fix after the retry window');
      else ok(await submit.isEnabled(), 'web: a browser has no GPS — Submit stays possible, with the warning');
      await p.screenshot({ path: `${OUT}/gps-attendance-${mode}.png` }).catch(() => {});
      if (android) {
        await setFix(10);
        await dlg.getByRole('button', { name: 'Use current location' }).click(); await p.waitForTimeout(3500);
        ok(await dlg.getByRole('button', { name: 'Submit' }).isEnabled(), 'android-weak: a good fix (±10 m) turns Submit on');
        ok(/inside/.test(await p.getByTestId('attendance-map-status').innerText()), 'android-weak: …and the map says inside the area');
      }
    }
    await dlg.getByRole('button', { name: 'Submit' }).click(); await p.waitForTimeout(3500);
    const row = tryAcc(`SELECT IFNULL(check_in_accuracy_m,'null') FROM attendance WHERE user_id=${uid} AND check_in_at IS NOT NULL`);
    ok(Number(sql(`SELECT COUNT(*) FROM attendance WHERE user_id=${uid} AND check_in_at IS NOT NULL`)) === 1, `${mode}: the In Time was recorded`);
    ok(row === String(finalAcc), `${mode}: the fix's accuracy is stored with the In Time (${row || 'no row'})`);
    if (android) ok((await callCount('stopWarm')) >= 1, `${mode}: the phone is told to stop the warm-up when the popup closes`);

    // ---- Check In/Out (map) ----
    await setFix(1500);
    await p.goto(B + '/'); await p.getByRole('button', { name: 'Set Now' }).first().waitFor({ timeout: 90000 }); await p.waitForTimeout(2500);
    await p.evaluate(() => { const el = [...document.querySelectorAll('span')].find((e) => e.textContent === 'Check In/Out' && e.closest('button')); el.closest('button').click(); }); await p.waitForTimeout(1500);
    await startWarm();
    await p.getByRole('button', { name: /Add Check In\/Out/ }).click();
    const cio = p.getByRole('dialog', { name: 'Check In/Out' }); await cio.waitFor({ timeout: 20000 });
    await cio.getByPlaceholder('e.g. Meeting').fill('Site visit');
    if (android) ok((await callCount('warmUp')) >= 2, `${mode}: …and when Check In/Out opens`);
    await p.waitForTimeout(warm ? 12000 : 10000);
    const cioText = await cio.innerText();
    console.log('  check-in/out says:', cioText.replace(/\s+/g, ' ').slice(0, 260));
    const go = cio.getByRole('button', { name: /Check In here/ });
    if (warm) {
      ok(await go.isEnabled(), 'android-warm: Check In here unlocks by itself once the GPS is good');
      ok(/±\s?12\b/.test(cioText), 'android-warm: Check In/Out shows the good fix (±12 m)');
    } else {
      ok(/±\s?1500/.test(cioText), `${mode}: Check In/Out names the weak fix (±1500 m)`);
      ok(/weak|may be wrong/i.test(cioText), `${mode}: Check In/Out says the position may be wrong`);
      if (android) ok(await go.isDisabled(), 'android-weak: Check In here stays off on a weak fix');
      else ok(await go.isEnabled(), 'web: Check In here stays possible, with the warning');
      await p.screenshot({ path: `${OUT}/gps-checkinout-${mode}.png` }).catch(() => {});
      if (android) {
        // The map is still reading GPS: the moment it gets good, Check In here turns on by itself.
        await setFix(10); await p.waitForTimeout(6000);
        ok(await go.isEnabled(), 'android-weak: when the GPS gets good (±10 m) Check In here turns on by itself');
      }
    }
    await go.click(); await p.waitForTimeout(3500);
    const crow = tryAcc(`SELECT IFNULL(check_in_accuracy_m,'null') FROM claims WHERE user_id=${uid} ORDER BY id DESC LIMIT 1`);
    ok(Number(sql(`SELECT COUNT(*) FROM claims WHERE user_id=${uid}`)) === 1, `${mode}: the Check In was recorded`);
    ok(crow === String(finalAcc), `${mode}: the fix's accuracy is stored with the Check In (${crow || 'no row'})`);
    if (android) ok((await callCount('stopWarm')) >= 2, `${mode}: the phone is told to stop the warm-up when Check In/Out closes`);
    ok(errs.length === 0, `${mode}: no page errors ${JSON.stringify(errs)}`);
    await ctx.close();
  }
  console.log('accuracy columns: attendance =', cols('attendance') || 'none', '| claims =', cols('claims') || 'none');
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
