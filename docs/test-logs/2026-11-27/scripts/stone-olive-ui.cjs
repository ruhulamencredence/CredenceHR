// Stone & Olive, the real theme (no injected CSS): picked like a user would
// (localStorage mpr_bg_theme_v2 = 'stone'), pages opened on phone and computer.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const fs = require('fs'); const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3300', D = process.argv[2] || __dirname;
const SCAN = eval(fs.readFileSync(__dirname + '/stone-olive-scan.js', 'utf8'));
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
const THEME = process.env.THEME || 'stone';
(async () => {
  const dept = Number(sql("SELECT MAX(id) FROM departments WHERE name='Engineering'"));
  const tEmail = sql(`SELECT u.email FROM users u JOIN departments d ON d.head_user_id=u.id WHERE d.id=${dept}`);
  const kUid = Number(sql(`SELECT u.id FROM users u JOIN all_employees e ON e.user_id=u.id WHERE e.department_id=${dept} AND e.name='Karim Ahmed'`));
  const T = await login(tEmail, 'Demo#2026pass'), SA = await login('admin@credence.test', 'ProbePass123');
  const room = await (await fetch(B + '/api/chat/rooms', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T.token }, body: JSON.stringify({ type: 'direct', memberIds: [kUid] }) })).json();
  const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
  const tuid = T.user.id;
  const seedAtt = () => { sql(`DELETE FROM attendance WHERE user_id=${tuid} AND attendance_date='${today}'`); sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_lat, check_in_lng, check_out_at, check_out_lat, check_out_lng) VALUES (${tuid}, 1, '${today}', '${today} 08:55:00', 23.7806, 90.4074, '${today} 18:05:00', 23.7806, 90.4074)`); };
  seedAtt();
  const b = await chromium.launch(); const RES = {};
  const open = async (who, phone, path = '/', opts = {}) => {
    const geo = { geolocation: { latitude: 23.7806, longitude: 90.4074 }, permissions: ['geolocation'] };
    const ctx = await b.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ...geo } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...geo });
    await ctx.addInitScript(([t, u, ph, th, sec, nb]) => { if (t) { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); } for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} localStorage.setItem('mpr_bg_theme_v2', th); if (u) { if (sec) localStorage.setItem('mpr_user_section_' + u.id, sec); else localStorage.removeItem('mpr_user_section_' + u.id); } if (ph && !nb && u && u.role !== 'superadmin') window.androidBridge = { postMessage() {} }; }, [who?.token, who?.user, phone, THEME, opts.sec || '', !!opts.nb]);
    const p = await ctx.newPage(); p.errs = [];
    p.on('pageerror', (e) => { if (!/not implemented on android/.test(String(e))) p.errs.push(String(e).slice(0, 160)); });
    await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });
    await p.goto(B + path); await p.waitForTimeout(7500);
    return p;
  };
  const shot = async (who, phone, path, name, fn, opts) => {
    try { const p = await open(who, phone, path, opts); if (fn) await fn(p); await p.waitForTimeout(900);
      await p.screenshot({ path: `${D}/${name}.png` }); const sc = await p.evaluate(SCAN);
      const attrs = await p.evaluate(() => ({ bg: document.documentElement.dataset.bg, ui: document.documentElement.dataset.ui }));
      RES[name] = { scan: sc, errs: p.errs, attrs }; await p.context().close(); console.log('ok', name, 'off-theme colours:', sc.n, 'errors:', p.errs.length, JSON.stringify(attrs));
    } catch (e) { console.log('fail', name, String(e).slice(0, 200)); }
  };
  const conf = (msg, o) => async (p) => { await p.evaluate(([m, o]) => import('/src/lib/confirmDialog.tsx').then((x) => { x.confirmDialog(m, o); }), [msg, o]); await p.waitForTimeout(900); };
  if (process.env.ONLY) { for (const n of process.env.ONLY.split(',')) { if (n==='d-dash') await shot(T, false, '/', 'd-dash'); if (n==='m-dash') await shot(T, true, '/', 'm-dash'); } await b.close(); return; }
  await shot(T, true, '/', 'm-dash');
  await shot(T, true, '/', 'm-dash2', async (p) => { await p.evaluate(() => { const s = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)); (s[0] || document.scrollingElement).scrollTop += 820; }); });
  await shot(T, true, '/', 'm-leave', null, { sec: 'leave' });
  await shot(T, true, '/', 'm-billclaim', null, { sec: 'billClaim' });
  await shot(T, true, '/', 'm-myteam', async (p) => { const c = p.getByTestId('my-team-card').first(); await c.scrollIntoViewIfNeeded(); await c.getByText('See all').click(); await p.waitForTimeout(2500); });
  await shot(T, true, '/', 'm-chat', async (p) => { await p.evaluate((id) => window.dispatchEvent(new CustomEvent('credence:open-chat-room', { detail: { roomId: id } })), room.id); await p.waitForTimeout(3500); });
  await shot(T, true, '/', 'm-more', async (p) => { await p.getByRole('button', { name: 'More' }).last().click(); await p.waitForTimeout(1200); });
  await shot(T, true, '/', 'm-confirm', conf('Give your Out Time again? The 06:05 PM you gave today will be replaced.', { confirmLabel: 'Give again' }));
  await shot(T, true, '/', 'm-danger', conf('Delete this leave application? This cannot be undone.', { confirmLabel: 'Delete', tone: 'danger' }));
  await shot(T, true, '/', 'm-appearance', async (p) => { await p.getByRole('button', { name: 'Open profile' }).first().click(); await p.waitForTimeout(1500); await p.getByRole('button', { name: 'Stone & Olive background' }).scrollIntoViewIfNeeded(); await p.waitForTimeout(500); });
  await shot(SA, true, '/self/approve-applications', 'm-approve', async (p) => { await p.waitForTimeout(3000); });
  sql(`DELETE FROM attendance WHERE user_id=${tuid} AND attendance_date='${today}'`);
  await shot(T, true, '/', 'm-map', async (p) => { await p.getByText('Set Now').first().click(); await p.waitForTimeout(8000); }, { nb: true });
  seedAtt();
  await shot(T, false, '/', 'd-dash');
  await shot(SA, false, '/self/mail', 'd-mail', async (p) => { await p.waitForTimeout(4000); });
  await shot(T, false, '/', 'd-chat', async (p) => { await p.evaluate((id) => window.dispatchEvent(new CustomEvent('credence:open-chat-room', { detail: { roomId: id } })), room.id); await p.waitForTimeout(3500); });
  await shot(SA, false, '/self/approve-applications', 'd-approve', async (p) => { await p.waitForTimeout(3000); });
  await shot(SA, false, '/admin/employees', 'd-employees', async (p) => { await p.waitForTimeout(3000); });
  await shot(SA, false, '/admin/users', 'd-access', async (p) => { await p.waitForTimeout(2000); await p.getByRole('button', { name: 'Access Templates' }).click(); await p.waitForTimeout(1800); });
  await shot(SA, false, '/admin/departments', 'd-dept', async (p) => { await p.waitForTimeout(1500); await p.locator('tr', { hasText: 'Engineering' }).first().locator('button').first().click(); await p.waitForTimeout(2000); });
  await shot(null, true, '/', 'm-login'); await shot(null, false, '/', 'd-login');
  fs.writeFileSync(`${D}/result.json`, JSON.stringify(RES, null, 1));
  await b.close();
})();
