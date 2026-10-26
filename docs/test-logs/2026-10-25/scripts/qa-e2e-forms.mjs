// QA: the forms, used the way a person uses them — a real browser, typing
// into the fields and clicking the buttons (Playwright), then checking the
// database. Login (wrong and right password), New Employee (with a bad date
// of birth first), an employee applying for leave, the approver approving
// it from Approve Applications, and the Timesheet correction form's night
// shift, and an Asset requisition with units picked from the list and typed
// ("Other…") in the full-screen popup. A screenshot is kept for every step
// that fails.
// Usage: node qa-e2e-forms.mjs <out-dir>
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM || '/usr/local/lib/node_modules_global/')('playwright');
const BASE = process.env.BASE || 'http://localhost:3100';
const OUT = process.argv[2] || 'e2e-out';
fs.mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const R = [];
let page;
const T = async (id, ok, name, detail = '') => {
  R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + String(detail).slice(0, 300) : ''}`);
  if (!ok && page) await page.screenshot({ path: path.join(OUT, `${id}.png`), fullPage: true }).catch(() => {});
};
// The first match that is actually on screen (the phone menu keeps an
// off-screen copy of every button).
const onScreen = async (loc) => { for (const l of await loc.all()) { const bb = await l.boundingBox(); if (bb && bb.x >= 0 && bb.x < 1440 && bb.width > 0) return l; } return loc.first(); };
const visible = (loc) => loc.first().isVisible().catch(() => false);
const textOf = () => page.evaluate(() => document.body.innerText);

const browser = await chromium.launch();
async function freshPage() {
  if (page) await page.context().close();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Dhaka', locale: 'en-GB' });
  // The "turn on notifications" prompt would cover the page.
  await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); });
  page = await ctx.newPage();
}
async function signIn(identifier, password) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const ws = page.getByLabel('Workspace code');
  if (await ws.isVisible({ timeout: 8000 }).catch(() => false)) {
    await ws.fill('credence');
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await page.getByPlaceholder('you@company.com or Project Name').fill(identifier);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
const signedIn = () => page.getByRole('button', { name: 'Logout' }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);

// 1. Login form
await freshPage();
await signIn('admin@credence.test', 'wrong-password');
await page.waitForTimeout(2500);
const loginText = await textOf();
await T('E2E-01', /invalid|incorrect|wrong|not match/i.test(loginText) && !(await visible(page.getByRole('button', { name: 'Logout' }))), 'Wrong password: the form says so and does not sign in', loginText.slice(0, 200).replace(/\s+/g, ' '));
await page.getByPlaceholder('••••••••').fill('AdminPass123');
await page.getByRole('button', { name: 'Sign in' }).click();
await T('E2E-02', await signedIn(), 'Right password: signed in, the menu is shown');

// 2. New Employee form
await page.goto(BASE + '/admin/employees', { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'New Employee' }).click();
await page.getByPlaceholder('Full name').fill('Ui Form Person');
await page.getByPlaceholder('e.g. Executive').fill('Executive');
await page.locator('select').filter({ hasText: '— None —' }).first().selectOption({ label: 'HR' });
await page.getByPlaceholder('name@company.com').fill('ui.form.person@credence.test');
await page.getByPlaceholder('e.g. 01877772209').fill('01711000222');
const dates = page.locator('input[type=date]');
await dates.nth(0).fill('2026-10-01');
await dates.nth(1).fill(day(-365 * 10)); // ten years old
await page.getByRole('button', { name: 'Add Employee' }).click();
await page.waitForTimeout(1500);
const tooYoung = await textOf();
const savedYoung = sql("SELECT COUNT(*) FROM all_employees WHERE name='Ui Form Person'");
await T('E2E-03', savedYoung === '0' && /14|age|old/i.test(tooYoung), 'New Employee: a 10-year-old date of birth is refused with a message, nothing saved', `saved ${savedYoung}`);
await dates.nth(1).fill('1995-05-20');
await page.getByRole('button', { name: 'Add Employee' }).click();
await page.waitForTimeout(2500);
const row = sql("SELECT id, designation, email, DATE_FORMAT(joining_date,'%Y-%m-%d'), DATE_FORMAT(date_of_birth,'%Y-%m-%d'), department_id FROM all_employees WHERE name='Ui Form Person'");
const dept = sql("SELECT id FROM departments WHERE name='HR' LIMIT 1");
const [empId, desig, email, joined, dob, deptId] = row.split('\t');
await T('E2E-04', !!empId && desig === 'Executive' && email === 'ui.form.person@credence.test' && joined === '2026-10-01' && dob === '1995-05-20' && deptId === dept, 'New Employee: after fixing the date it is saved with every field as typed', row);

// Empty Name: the form does not send.
await page.goto(BASE + '/admin/employees', { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'New Employee' }).click();
const before = sql('SELECT COUNT(*) FROM all_employees');
await page.getByPlaceholder('e.g. Executive').fill('No Name');
await page.getByRole('button', { name: 'Add Employee' }).click();
await page.waitForTimeout(1200);
await T('E2E-05', sql('SELECT COUNT(*) FROM all_employees') === before, 'New Employee: without a Name nothing is saved');

// The new employee gets a login (API, as Admin Panel -> Create Login) and Leave.
const SA = (await api(null, 'POST', '/api/auth/login', { identifier: 'admin@credence.test', password: 'AdminPass123' })).body.token;
const u = await api(SA, 'POST', '/api/users', { name: 'Ui Form Person', email: 'ui.form.person@credence.test', password: 'easy', role: 'user', employee_id: Number(empId) });
const uid = Number(u.body.id || sql("SELECT id FROM users WHERE email='ui.form.person@credence.test'"));
if (!sql(`SELECT user_id FROM all_employees WHERE id=${empId}`).match(/^\d+$/)) sql(`UPDATE all_employees SET user_id=${uid} WHERE id=${empId}`);
await api(SA, 'PUT', `/api/users/${uid}/leave-application-access`, { can_view_leave_application: true });
await api(SA, 'PUT', `/api/users/${uid}/timesheet-access`, { can_view_timesheet: true });
await api(SA, 'PUT', `/api/users/${uid}/feature-permissions`, { can_use_attendance: true });
await api(SA, 'POST', '/api/projects', { project_name: 'Head Office', location_lat: 23.78, location_lng: 90.4, location_radius: 200 });
await api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
sql(`INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (${uid}, 10, 14, 0) ON DUPLICATE KEY UPDATE casual_leave = 10`);

// 3. The employee applies for leave through the form.
await freshPage();
await signIn('ui.form.person@credence.test', 'easy');
await T('E2E-06', await signedIn(), 'The new employee signs in with the easy password');
fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify({ empId, uid }));
await (await onScreen(page.getByRole('button', { name: 'Leave', exact: true }))).click();
await page.getByRole('button', { name: 'Submit Leave' }).click();
await page.locator('select').filter({ hasText: 'Select Type' }).selectOption({ label: 'Casual Leave' });
await page.getByPlaceholder('Type here').fill('Family programme (typed in the form)');
await page.getByRole('button', { name: 'Submit Application' }).click();
await page.waitForTimeout(2500);
let leave = sql(`SELECT id, status, leave_type, DATE_FORMAT(start_date,'%Y-%m-%d'), purpose FROM leave_applications WHERE user_id=${uid} ORDER BY id DESC LIMIT 1`);
await T('E2E-07', /pending/.test(leave) && leave.includes('casual') && leave.includes(day(0)) && leave.includes('typed in the form'), 'Leave form: an employee applies for Casual Leave today; it is saved as pending', leave || (await textOf()).slice(0, 300));
const leaveId = leave.split('\t')[0];

// 4. The approver approves it from Approve Applications (no Supervisor and
// no Template set, so it waits for the Superadmin).
await freshPage();
await signIn('admin@credence.test', 'AdminPass123');
await signedIn();
await page.goto(BASE + '/self/approve-applications', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const card = page.locator('div').filter({ hasText: /From Ui Form Person/ }).filter({ has: page.getByRole('button', { name: 'Approve' }) }).last();
await card.getByPlaceholder('Remarks (optional)').fill('Enjoy — approved from the page');
await card.getByRole('button', { name: 'Approve' }).click();
await page.waitForTimeout(2500);
leave = sql(`SELECT status FROM leave_applications WHERE id=${leaveId}`);
const bal = sql(`SELECT casual_leave FROM leave_balances WHERE user_id=${uid}`);
await T('E2E-08', leave === 'approved' && Number(bal) === 9, 'Approve Applications: clicking Approve approves the leave and takes 1 day off the balance', `status ${leave}; casual balance ${bal}`);
await page.goto(BASE + '/self/approve-applications', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await T('E2E-09', !(await textOf()).includes('From Ui Form Person'), 'The approved leave leaves the Pending list');

// 5. Timesheet correction form: Out Time earlier than In Time = night shift.
await freshPage();
await signIn('ui.form.person@credence.test', 'easy');
await signedIn();
await page.goto(BASE + '/self/timesheet', { waitUntil: 'domcontentloaded' });
const d2 = day(-2);
const label = new Date(`${d2}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/ /g, '-');
await page.locator('div[title="Click to correct this day\'s In/Out Time"]').filter({ hasText: label }).first().click();
const times = page.locator('input[type=time]');
await times.nth(0).fill('22:00');
await times.nth(1).fill('06:00');
const hint = await page.getByText(/Next day \(/).isVisible().catch(() => false);
await page.getByRole('button', { name: 'Apply' }).click();
await page.waitForTimeout(2500);
const corr = sql(`SELECT DATE_FORMAT(requested_check_in_at,'%Y-%m-%d %H:%i'), DATE_FORMAT(requested_check_out_at,'%Y-%m-%d %H:%i') FROM attendance_corrections WHERE user_id=${uid} ORDER BY id DESC LIMIT 1`);
const nextD = new Date(Date.parse(`${d2}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
await T('E2E-10', hint && corr === `${d2} 22:00\t${nextD} 06:00`, 'Timesheet correction: In 22:00 / Out 06:00 shows "Next day" and is saved as a night shift ending the next morning', `hint ${hint}; saved ${corr}`);

// 6. Asset requisition: units from the list and a typed one, full-screen popup.
await page.goto(BASE + '/self/asset-management', { waitUntil: 'domcontentloaded' });
await (await onScreen(page.getByRole('button', { name: /New Requisition/i }))).click();
const dlg = page.locator('[role=dialog]');
await dlg.waitFor({ timeout: 10000 });
await page.waitForTimeout(700); // the popup's entrance animation
const bb = await dlg.boundingBox();
const vp = page.viewportSize();
const units = await page.getByLabel('Unit').first().evaluate((el) => [...el.options].map((o) => o.value));
await T('E2E-11', !!bb && bb.width >= vp.width - 40 && bb.height >= vp.height - 40 && units.length > 5 && units.includes('box') && units.includes('kg'), 'New Requisition opens full screen and offers more units than "pcs"', `box ${JSON.stringify(bb)}; units ${units.join(',')}`);
await page.getByLabel('Item name').first().fill('A4 Paper');
await page.getByLabel('Purpose').first().fill('Printing');
await page.getByLabel('Unit').first().selectOption('ream');
await page.getByRole('button', { name: '+ Add Item' }).click();
await page.getByLabel('Item name').nth(1).fill('Engine oil');
await page.getByLabel('Purpose').nth(1).fill('Generator');
await page.getByLabel('Unit').nth(1).selectOption('__other__');
await page.getByLabel('Unit').nth(1).fill('drum');
await page.getByRole('button', { name: 'Submit Request' }).click();
await page.waitForTimeout(2500);
const reqItems = sql(`SELECT GROUP_CONCAT(CONCAT(item_name, ':', unit) ORDER BY id) FROM asset_requisition_items WHERE requisition_id = (SELECT MAX(id) FROM asset_requisitions WHERE employee_user_id = ${uid})`);
await T('E2E-12', reqItems === 'A4 Paper:ream,Engine oil:drum', 'Requisition saved with the picked unit (ream) and a typed one (drum)', reqItems);

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(path.join(OUT, 'qa-e2e-forms.json'), JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
await browser.close();
