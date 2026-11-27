// Self Service -> My Team screens: the Dashboard card (phone and computer),
// See all with search and status filter, one person's card; no card for an
// account with nobody under it.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Team#2026pass';
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
  sql(`INSERT INTO departments (name, is_active, company_id) VALUES ('UiTeam ${tag}', 1, 1)`);
  const D = Number(sql(`SELECT id FROM departments WHERE name='UiTeam ${tag}'`));
  const other = Number(sql('SELECT MIN(id) FROM departments'));
  const person = async (name, dept, phone) => {
    const email = `${name.toLowerCase()}.${tag}@credence.test`;
    const e = await api(SA, 'POST', '/api/employees', { name: `${name} ${tag}`, designation: 'Site Engineer', department_id: dept, joining_date: '2024-01-01', email, phone, create_login: true, login_email: email, login_password: PASS });
    const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.b.id}`));
    sql(`UPDATE users SET must_change_password=0 WHERE id=${uid}`);
    return { id: e.b.id, uid, email };
  };
  const H = await person('Hodui', other), O = await person('Nobodyui', other);
  const P1 = await person('Karim', D, '01711000001'), P2 = await person('Nusrat', D), P3 = await person('Sadia', D), P4 = await person('Tanvir', D);
  sql(`UPDATE departments SET head_user_id=${H.uid} WHERE id=${D}`);
  const proj = Number(sql('SELECT MIN(id) FROM projects'));
  sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_lat, check_in_lng) VALUES (${P1.uid}, ${proj}, '${today}', '${today} 11:40:00', 23.8, 90.4), (${P2.uid}, ${proj}, '${today}', '${today} 08:45:00', 23.8, 90.4)`);
  sql(`INSERT INTO leave_applications (user_id, leave_type, start_date, end_date, day_count, purpose, status, apply_date) VALUES (${P3.uid}, 'casual', '${today}', '${today}', 1, 'test', 'approved', '${today}')`);

  const b = await chromium.launch();
  const open = async (x, phone) => {
    const a = await login(x.email, PASS);
    const ctx = await b.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [a.token, a.user]);
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(String(e))); return p;
  };

  // Phone: the card.
  let p = await open(H, true);
  await p.goto(B + '/'); await p.waitForTimeout(7000);
  const card = p.getByTestId('my-team-card').filter({ visible: true }).first();
  await card.scrollIntoViewIfNeeded();
  ok(await card.isVisible(), 'phone: My Team card on the Dashboard');
  const txt = await card.innerText();
  ok(/4 people/.test(txt), 'card: 4 people');
  ok(/1\s*Present/.test(txt) && /1\s*Late/.test(txt) && /1\s*On leave/.test(txt) && /1\s*Not in yet/.test(txt), 'card: 1 Present · 1 Late · 1 On leave · 1 Not in yet');
  ok(/Late: Karim/.test(txt), 'card: who is late');
  await card.screenshot({ path: `${OUT}/my-team-card-phone.png` }).catch(() => {});

  // See all.
  await card.getByText('See all').click(); await p.waitForTimeout(1500);
  const dlg = p.getByRole('dialog', { name: 'My Team' });
  ok(await dlg.isVisible(), 'See all: the My Team page opens');
  ok(await dlg.getByText(`Head of UiTeam ${tag} (4)`).isVisible(), 'page: grouped as "Head of <Department>"');
  ok(await dlg.getByText('Casual Leave').isVisible(), 'page: Sadia shows Casual Leave');
  ok(await dlg.getByText(/In 11:40/).isVisible(), 'page: Karim shows In 11:40 and the Project');
  await p.screenshot({ path: `${OUT}/my-team-page-phone.png` }).catch(() => {});
  await dlg.getByRole('button', { name: /^Late 1$/ }).click(); await p.waitForTimeout(400);
  ok((await dlg.locator('button:has-text("Karim")').count()) === 1 && (await dlg.locator('button:has-text("Nusrat")').count()) === 0, 'filter Late: only Karim');
  await dlg.getByRole('button', { name: /^All 4$/ }).click();
  await dlg.getByPlaceholder(/Search name/).fill('nusr'); await p.waitForTimeout(400);
  ok((await dlg.locator('button:has-text("Nusrat")').count()) === 1 && (await dlg.locator('button:has-text("Karim")').count()) === 0, 'search "nusr": only Nusrat');
  await dlg.getByPlaceholder(/Search name/).fill('');

  // One person.
  await dlg.locator('button:has-text("Karim")').first().click(); await p.waitForTimeout(2000);
  const pc = p.getByRole('dialog', { name: `Karim ${tag}` });
  ok(await pc.isVisible(), 'tap Karim: his card opens');
  ok(await pc.getByTestId('my-team-month').isVisible(), 'person: this month so far');
  ok((await pc.getByRole('link', { name: /Call/ }).getAttribute('href')) === 'tel:01711000001', 'person: Call button dials his number');
  ok(await pc.getByText(`Head of UiTeam ${tag}`).isVisible(), 'person: "Under you as Head of …"');
  await p.screenshot({ path: `${OUT}/my-team-person-phone.png` }).catch(() => {});
  await pc.getByRole('button', { name: 'Close' }).click(); await p.waitForTimeout(400);
  ok(await dlg.isVisible(), 'closing the person keeps the list open');
  ok(p.errs.length === 0, 'phone: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();

  // Computer.
  p = await open(H, false);
  await p.goto(B + '/'); await p.waitForTimeout(7000);
  const dcard = p.getByTestId('my-team-card').filter({ visible: true }).first();
  ok(await dcard.isVisible(), 'computer: My Team card on the Dashboard');
  await dcard.screenshot({ path: `${OUT}/my-team-card-desktop.png` }).catch(() => {});
  ok(p.errs.length === 0, 'computer: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();

  // Nobody under them.
  p = await open(O, true);
  await p.goto(B + '/'); await p.waitForTimeout(7000);
  ok((await p.getByTestId('my-team-card').count()) === 0, 'nobody under them: no My Team card');
  await p.context().close();

  await b.close();
  sql(`UPDATE departments SET is_active=0, head_user_id=NULL WHERE id=${D}`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
