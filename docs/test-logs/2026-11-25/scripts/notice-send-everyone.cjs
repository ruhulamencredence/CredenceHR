// Notices -> Who has read it -> "Send again ▾": to who hasn't read it (as
// before) or to everyone (those who have read it too) — push only; nobody's
// Read ✓ / opened record changes. Same permission (notice_read_report).
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Notice#2026pass';
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const sa = await login('admin@credence.test', 'ProbePass123'); const SA = sa.token;
  const tag = Date.now().toString(36).slice(-5);
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const people = [];
  for (const n of ['Readone', 'Openone', 'Notyet', 'Notyettwo']) {
    const email = `${n.toLowerCase()}.${tag}@credence.test`;
    const e = (await api(SA, 'POST', '/api/employees', { name: `${n} ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS })).b;
    const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.id}`)); sql(`UPDATE users SET must_change_password=0 WHERE id=${uid}`);
    people.push({ uid, email });
  }
  const title = `Send everyone test ${tag}`;
  const c = await api(SA, 'POST', '/api/notices', { title, content_html: '<p>Please read.</p>', target_type: 'specific', target_user_ids: people.map((p) => p.uid), priority: 'important', require_ack: true, is_active: true });
  ok(c.s === 201 && c.b.status === 'live', 'live notice for 4 people');
  const id = c.b.id;
  sql(`INSERT INTO notice_reads (notice_id, user_id, opened_at, acknowledged_at) VALUES (${id}, ${people[0].uid}, NOW(), NOW()), (${id}, ${people[1].uid}, NOW(), NULL)`);
  const readsBefore = sql(`SELECT GROUP_CONCAT(CONCAT(user_id,':',IFNULL(acknowledged_at,'-')) ORDER BY user_id) FROM notice_reads WHERE notice_id=${id}`);

  const r1 = await api(SA, 'POST', `/api/notices/${id}/remind`);
  ok(r1.s === 200 && r1.b.sent === 3 && r1.b.to === 'unread', 'no "to": as before — the 3 who haven\'t tapped "I have read this" (' + JSON.stringify(r1.b) + ')');
  const r2 = await api(SA, 'POST', `/api/notices/${id}/remind`, { to: 'everyone' });
  ok(r2.s === 200 && r2.b.sent === 4 && r2.b.to === 'everyone', 'to everyone: all 4, the one who read it too (' + JSON.stringify(r2.b) + ')');
  ok(sql(`SELECT GROUP_CONCAT(CONCAT(user_id,':',IFNULL(acknowledged_at,'-')) ORDER BY user_id) FROM notice_reads WHERE notice_id=${id}`) === readsBefore, 'nobody\'s Read ✓ / opened changed');
  const P = (await login(people[2].email, PASS)).token;
  ok((await api(P, 'POST', `/api/notices/${id}/remind`, { to: 'everyone' })).s === 403, 'someone without Notices: refused');
  sql(`UPDATE notices SET is_active=0 WHERE id=${id}`);
  ok((await api(SA, 'POST', `/api/notices/${id}/remind`, { to: 'everyone' })).s === 400, 'a paused notice can\'t be sent again');
  sql(`UPDATE notices SET is_active=1 WHERE id=${id}`);

  // Screen.
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); }, [sa.token, sa.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });
  await p.goto(B + '/admin/notices'); await p.waitForTimeout(6000);
  const row = p.locator('div').filter({ hasText: title }).filter({ has: p.getByRole('button', { name: /Who read it/ }) }).last();
  await row.getByRole('button', { name: /Who read it/ }).click(); await p.waitForTimeout(2000);
  const send = p.getByRole('button', { name: /^Send again/ });
  ok(await send.isVisible(), 'popup: "Send again ▾" button');
  await send.click(); await p.waitForTimeout(400);
  const menu = p.getByRole('menu');
  const mt = (await menu.innerText()).replace(/\s+/g, ' ');
  ok(/To who hasn't read it/.test(mt) && /Not yet 2 \+ Opened 1/.test(mt) && / 3/.test(mt), 'menu: "To who hasn\'t read it" 3 (Not yet 2 + Opened 1) — ' + mt.slice(0, 120));
  ok(/To everyone/.test(mt) && /Also the 1 who've read it/.test(mt) && /4/.test(mt), 'menu: "To everyone" 4, "also the 1 who\'ve read it"');
  await p.screenshot({ path: `${OUT}/notice-send-menu.png` }).catch(() => {});
  await menu.getByRole('menuitem', { name: /To everyone/ }).click(); await p.waitForTimeout(600);
  const dlg = p.getByRole('alertdialog', { name: 'Send this notice to everyone?' });
  ok(await dlg.isVisible() && /all 4 people/.test(await dlg.innerText()), 'confirm: "Send this notice to everyone?" with all 4');
  await p.screenshot({ path: `${OUT}/notice-send-confirm.png` }).catch(() => {});
  await dlg.getByRole('button', { name: 'Send to 4' }).click(); await p.waitForTimeout(1500);
  ok(await p.getByText('Sent again to 4 people.').isVisible(), 'after sending: "Sent again to 4 people."');
  await send.click(); await p.waitForTimeout(300);
  await p.getByRole('menuitem', { name: /To who hasn't read it/ }).click(); await p.waitForTimeout(500);
  await p.getByRole('alertdialog').getByRole('button').last().click(); await p.waitForTimeout(1500);
  ok(await p.getByText('Sent again to 3 people.').isVisible(), 'the old way still works: "Sent again to 3 people."');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close();
  sql(`UPDATE notices SET is_active=0 WHERE id=${id}`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
