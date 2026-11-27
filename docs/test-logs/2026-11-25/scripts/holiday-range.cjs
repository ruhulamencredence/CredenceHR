// Holiday Calendar -> Add Date with a From–To range (e.g. Eid): every day is
// added, days already set are skipped and named; one date works as before.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const days = (g, a, b) => sql(`SELECT IFNULL(GROUP_CONCAT(DATE_FORMAT(entry_date,'%m-%d') ORDER BY entry_date),'') FROM holiday_calendar WHERE applies_to='${g}' AND entry_date BETWEEN '${a}' AND '${b}'`);
(async () => {
  sql("DELETE FROM holiday_calendar WHERE entry_date BETWEEN '2031-03-01' AND '2031-06-30'");
  const sa = await login('admin@credence.test', 'ProbePass123'); const SA = sa.token;
  // One day as before.
  const one = await api(SA, 'POST', '/api/holidays', { entry_date: '2031-03-21', title: 'Eid ul-Fitr', applies_to: 'head_office' });
  ok(one.s === 200 && one.b.entry_date === '2031-03-21' && one.b.inserted === undefined, 'one date: added as before');
  // Range 20–23 March, the 21st already set.
  const r = await api(SA, 'POST', '/api/holidays', { entry_date: '2031-03-20', end_date: '2031-03-23', title: 'Eid ul-Fitr', applies_to: 'head_office' });
  ok(r.s === 200 && r.b.inserted === 3 && JSON.stringify(r.b.skipped) === '["2031-03-21"]', 'range 20–23: 3 added, the 21st (already set) skipped ' + JSON.stringify(r.b));
  ok(days('head_office', '2031-03-19', '2031-03-24') === '03-20,03-21,03-22,03-23', 'calendar: 20, 21, 22, 23 March');
  ok(days('project_site', '2031-03-19', '2031-03-24') === '', 'the other calendar (Project Side) untouched');
  ok((await api(SA, 'POST', '/api/holidays', { entry_date: '2031-03-20', end_date: '2031-03-23', applies_to: 'head_office' })).s === 409, 'same range again: everything already set → refused');
  ok((await api(SA, 'POST', '/api/holidays', { entry_date: '2031-03-20', end_date: '2031-03-10', applies_to: 'head_office' })).s === 400, 'To before From → refused');
  ok((await api(SA, 'POST', '/api/holidays', { entry_date: '2031-04-01', end_date: '2031-06-30', applies_to: 'head_office' })).s === 400 && days('head_office', '2031-04-01', '2031-06-30') === '', 'more than 62 days → refused, nothing added');
  const t = sql("SELECT GROUP_CONCAT(DISTINCT title) FROM holiday_calendar WHERE applies_to='head_office' AND entry_date BETWEEN '2031-03-20' AND '2031-03-23'");
  ok(t === 'Eid ul-Fitr', 'every day carries the title');

  // Screen.
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([tk, u]) => { localStorage.setItem('mpr_token', tk); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); }, [sa.token, sa.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });
  await p.goto(B + '/admin/holidays'); await p.waitForTimeout(6000);
  await p.getByRole('button', { name: /Add Date/ }).first().click(); await p.waitForTimeout(600);
  const dlg = p.getByRole('dialog', { name: 'Add Date' });
  ok(await dlg.isVisible(), 'Add Date popup');
  await dlg.locator('#hol-from').fill('2031-05-10');
  await dlg.locator('#hol-to').fill('2031-05-14');
  await dlg.getByPlaceholder(/Independence Day|Weekend/).fill('Eid ul-Adha');
  ok(/5 days, /.test(await dlg.innerText()), 'shows "5 days, … – …"');
  await p.screenshot({ path: `${OUT}/holiday-range-form.png` }).catch(() => {});
  await dlg.getByRole('button', { name: 'Save' }).click(); await p.waitForTimeout(2000);
  ok(await p.getByText('Added 5 dates to the calendar.').isVisible(), 'screen: "Added 5 dates to the calendar."');
  ok(days('head_office', '2031-05-01', '2031-05-31') === '05-10,05-11,05-12,05-13,05-14', 'calendar: 10–14 May');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close();
  sql("DELETE FROM holiday_calendar WHERE entry_date BETWEEN '2031-03-01' AND '2031-06-30'");
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
