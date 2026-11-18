// "Update available" in the Android app, updating inside the app
// (AppUpdatePrompt.tsx + AppUpdaterPlugin). A phone-sized Chromium plays the
// Android app: a fake native bridge answers App.getInfo and the AppUpdater
// plugin, and GET /api/app/android-latest is answered with a newer APK.
// Modes: ok (download → one-time permission → install screen → "updated"
// note after restart), fail (download fails → Try again / Download in
// browser), old (an APK without AppUpdater → the old browser button).
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B = 'http://localhost:3200', out = process.argv[2] || '/tmp';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const fakeBridge = ([mode, build]) => {
  window.androidBridge = { postMessage() {} };
  const calls = (window.__updCalls = []);
  const cbs = {};
  let allowed = mode === 'ok-allowed';
  const headers = [
    { name: 'App', methods: [{ name: 'getInfo', rtype: 'promise' }, { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }
  ];
  if (mode !== 'old') headers.push({ name: 'AppUpdater', methods: ['download', 'cancel', 'canInstall', 'openInstallSettings', 'install', 'removeListener'].map((n) => ({ name: n, rtype: 'promise' })).concat([{ name: 'addListener', rtype: 'callback' }]) });
  let id = 0;
  window.Capacitor = {
    PluginHeaders: headers,
    nativeCallback(plugin, method, opts, cb) {
      const cid = String(++id);
      if (method === 'addListener') cbs[plugin + ':' + opts.eventName] = cb;
      return Promise.resolve(cid);
    },
    async nativePromise(plugin, method, opts) {
      calls.push(plugin + '.' + method + (opts && opts.url ? ' ' + opts.url : ''));
      if (plugin === 'App' && method === 'getInfo') return { build: String(build), version: '2.4.0', name: 'CredenceHR', id: 'com.mprtracker.app' };
      if (plugin !== 'AppUpdater') return {};
      if (method === 'download') {
        const send = (loaded) => cbs['AppUpdater:progress'] && cbs['AppUpdater:progress']({ loaded, total: 25000000 });
        for (const l of [0, 5e6, 12e6]) { send(l); await new Promise((r) => setTimeout(r, 400)); }
        window.__midShot = true; await new Promise((r) => setTimeout(r, 900));
        if (mode === 'fail') { const e = new Error('HTTP 503'); e.code = 'FAILED'; throw e; }
        send(25e6); return { size: 25e6, versionName: '2.4.1' };
      }
      if (method === 'canInstall') return { allowed };
      if (method === 'openInstallSettings') { allowed = true; return { allowed }; }
      if (method === 'install') return {};
      return {};
    }
  };
};

async function run(mode, build, pending, waitFor) {
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.addInitScript(([t, u, p]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); localStorage.setItem('credence_bg_location_consent', 'declined'); if (p) localStorage.setItem('credence_app_update_pending', p); }, [a.token, a.user, pending || '']);
  await ctx.addInitScript(fakeBridge, [mode, build]);
  await ctx.route('**/api/app/android-latest', (r) => r.fulfill({ json: { available: true, version_code: pending ? build : build + 100, version_name: '2.4.1', url: '/downloads/CredenceHR.apk', min_version_code: 0 } }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(B + '/');
  if (waitFor) await p.getByText(waitFor).waitFor({ timeout: 20000 }).catch(() => {});
  else await p.waitForTimeout(7000);
  return { b, p, errs };
}

(async () => {
  // 1. In-app: download with progress → permission once → installer opened
  {
    const { b, p, errs } = await run('ok', 5000);
    const dlg = p.getByRole('dialog', { name: /update available/i });
    ok(await dlg.isVisible(), 'ok: "Update available" shows');
    await dlg.getByRole('button', { name: 'Update now' }).click();
    await p.waitForFunction(() => window.__midShot, null, { timeout: 8000 });
    const txt = await dlg.innerText();
    ok(/Downloading the update/.test(txt) && /\d+%/.test(txt) && /\d+\.\d \/ 23\.8 MB/.test(txt), 'ok: progress shown while downloading (' + (txt.match(/\d+%/) || [''])[0] + ', ' + (txt.match(/[\d.]+ \/ [\d.]+ MB/) || [''])[0] + ')');
    ok(!(await dlg.getByRole('button', { name: 'Later' }).count()), 'ok: no Later while downloading');
    ok(await dlg.getByRole('button', { name: 'Cancel' }).isVisible(), 'ok: Cancel while downloading');
    await p.screenshot({ path: out + '/update-1-downloading.png' });
    await dlg.getByRole('button', { name: 'Allow and install' }).waitFor({ timeout: 6000 });
    ok(/Allow from this source/.test(await dlg.innerText()), 'ok: asks for the one-time Android switch');
    await p.screenshot({ path: out + '/update-2-permission.png' });
    await dlg.getByRole('button', { name: 'Allow and install' }).click();
    await dlg.getByRole('button', { name: 'Install' }).waitFor({ timeout: 4000 });
    const calls = await p.evaluate(() => window.__updCalls);
    ok(calls.some((c) => c === 'AppUpdater.download ' + B + '/downloads/CredenceHR.apk'), 'ok: downloads the full APK link of this server');
    ok(calls.indexOf('AppUpdater.openInstallSettings') > -1 && calls.lastIndexOf('AppUpdater.install') > calls.indexOf('AppUpdater.openInstallSettings'), 'ok: opens the installer after the switch');
    ok(!calls.some((c) => /browser/.test(c)), 'ok: no browser involved');
    const pend = await p.evaluate(() => localStorage.getItem('credence_app_update_pending'));
    ok(/"code":5100/.test(pend || ''), 'ok: remembers the version being installed');
    await p.screenshot({ path: out + '/update-3-install.png' });
    ok(!errs.length, 'ok: no page errors ' + errs.join(' | '));
    await b.close();
  }
  // 2. Already allowed: straight from download to the installer
  {
    const { b, p } = await run('ok-allowed', 5000);
    const dlg = p.getByRole('dialog', { name: /update available/i });
    await dlg.getByRole('button', { name: 'Update now' }).click();
    await dlg.getByRole('button', { name: 'Install' }).waitFor({ timeout: 8000 });
    const calls = await p.evaluate(() => window.__updCalls);
    ok(!calls.includes('AppUpdater.openInstallSettings') && calls.includes('AppUpdater.install'), 'allowed: no permission step, installer opens');
    await b.close();
  }
  // 3. Download fails: Try again + Download in browser
  {
    const { b, p } = await run('fail', 5000);
    const dlg = p.getByRole('dialog', { name: /update available/i });
    await dlg.getByRole('button', { name: 'Update now' }).click();
    await dlg.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 8000 });
    ok(/HTTP 503/.test(await dlg.innerText()), 'fail: says what went wrong');
    ok(await dlg.getByRole('button', { name: 'Download in browser' }).isVisible(), 'fail: browser way offered');
    ok(await dlg.getByRole('button', { name: 'Later' }).isVisible(), 'fail: Later back');
    await p.screenshot({ path: out + '/update-4-failed.png' });
    await b.close();
  }
  // 4. Old APK without the plugin: the browser button as before
  {
    const { b, p } = await run('old', 5000);
    const dlg = p.getByRole('dialog', { name: /update available/i });
    ok(await dlg.getByRole('button', { name: 'Update now' }).isVisible(), 'old: Update now still there');
    await dlg.getByRole('button', { name: 'Update now' }).click(); await p.waitForTimeout(800);
    const calls = await p.evaluate(() => window.__updCalls);
    ok(!calls.some((c) => c.startsWith('AppUpdater')), 'old: no in-app download tried');
    await b.close();
  }
  // 5. Back after the update: "CredenceHR updated to 2.4.1"
  {
    const { b, p } = await run('ok', 5100, JSON.stringify({ code: 5100, name: '2.4.1' }), 'CredenceHR updated to 2.4.1');
    const note = p.getByRole('status').filter({ hasText: 'CredenceHR updated to 2.4.1' });
    ok(await note.isVisible(), 'restart: "CredenceHR updated to 2.4.1" note');
    ok(!(await p.evaluate(() => localStorage.getItem('credence_app_update_pending'))), 'restart: note shown once');
    await p.screenshot({ path: out + '/update-5-updated.png' });
    await p.waitForTimeout(5500);
    ok(!(await note.count()), 'restart: note goes away by itself');
    await b.close();
  }
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
