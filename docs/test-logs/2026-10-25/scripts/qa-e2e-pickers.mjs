// QA: the search-and-pick fields (Combobox / SearchSelect) inside the popups,
// used the way a person uses them: open the popup, type part of a name, pick
// the person from the list, fill the rest, submit — then check in the
// database that the right person (their id, not the typed text) was saved.
// Loan / advance, salary adjustment, Document Vault upload, emergency vehicle
// requisition, disciplinary action, department supervisor.
// Usage: node qa-e2e-pickers.mjs <out-dir>
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM || '/usr/local/lib/node_modules_global/')('playwright');
const BASE = process.env.BASE || 'http://localhost:3100';
const OUT = process.argv[2] || 'pickers-out';
fs.mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
async function api(t, m, p, b) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j };
}
const R = [];
let page;
const T = async (id, ok, name, detail = '') => {
  R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + String(detail).slice(0, 300) : ''}`);
  if (!ok && page) await page.screenshot({ path: path.join(OUT, `${id}.png`), fullPage: true }).catch(() => {});
};
const LOGIN = (await api(null, 'POST', '/api/auth/login', { identifier: 'admin@credence.test', password: 'AdminPass123' })).body;
const SA = LOGIN.token;

// People to pick: similar names on purpose, so the search has to narrow.
const PEOPLE = ['Nusrat Jahan', 'Nusrat Ara', 'Kamrul Hasan', 'Kamrul Islam', 'Shirin Akter', 'Tareq Aziz'];
const who = {};
for (const name of PEOPLE) {
  const key = name.toLowerCase().replace(/\s+/g, '.');
  const e = await api(SA, 'POST', '/api/employees', { name, designation: 'Officer', department_id: 1, joining_date: '2024-01-01', email: `${key}@pick.test`, create_login: true, login_email: `${key}@pick.test`, login_password: 'easy' });
  who[name] = { emp: e.body.id, uid: Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.body.id}`)) };
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Dhaka' });
await ctx.addInitScript(([t, u]) => {
  localStorage.setItem('mpr_token', t);
  localStorage.setItem('mpr_user', JSON.stringify(u));
  localStorage.setItem(`credence_webpush_snooze_${u.id}`, String(Date.now() + 9e9));
}, [SA, LOGIN.user]);
page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const onScreen = async (loc) => { for (const l of await loc.all()) { const bb = await l.boundingBox(); if (bb && bb.x >= 0 && bb.x < 1440 && bb.width > 0) return l; } return loc.first(); };
const click = async (name) => (await onScreen(page.getByRole('button', { name, exact: true }))).click();
const go = async (url, ...buttons) => {
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (const b of buttons) {
    await click(b);
    await page.waitForTimeout(1000);
  }
};
// Type part of the name into a search-and-pick field and pick the person.
// Returns [what the list offered, what the field shows after picking].
const pickPerson = async (field, typed, name) => {
  await field.click();
  await field.fill(typed);
  // The list can still be loading on a page that has just opened.
  await page.getByRole('listbox').last().getByRole('option', { name: new RegExp(`^${name}`) }).first().waitFor({ timeout: 10000 });
  const offered = (await page.getByRole('listbox').last().getByRole('option').allInnerTexts()).map((s) => s.trim());
  await page.getByRole('listbox').last().getByRole('option', { name: new RegExp(`^${name}`) }).first().click();
  await page.waitForTimeout(200);
  return [offered, await field.inputValue()];
};
const narrowed = (offered, name, other) => offered.some((o) => o.startsWith(name)) && !offered.some((o) => o.startsWith(other));
const combo = (placeholder) => page.locator(`input[role=combobox][placeholder="${placeholder}"]`).locator('visible=true').last();

// 1. Loan / advance
try {
  await go('/self/payroll', 'Loans & Advances', 'New Loan / Advance');
  const [offered, shown] = await pickPerson(combo('Select an employee'), 'nusrat j', 'Nusrat Jahan');
  const nums = page.locator('input[type=number]').locator('visible=true');
  await nums.nth(0).fill('12000');
  await nums.nth(1).fill('3000');
  await page.getByPlaceholder('e.g. Eid advance, emergency loan').fill('picker test');
  await click('Save');
  await page.waitForTimeout(2000);
  const row = sql(`SELECT employee_id, ROUND(total_amount), ROUND(monthly_installment) FROM employee_advances WHERE reason='picker test' ORDER BY id DESC LIMIT 1`);
  await T('PK-01', narrowed(offered, 'Nusrat Jahan', 'Kamrul') && shown.startsWith('Nusrat Jahan') && row === `${who['Nusrat Jahan'].emp}\t12000\t3000`, 'Loan / advance: "nusrat j" finds Nusrat Jahan, the loan is saved for her', `offered ${offered.slice(0, 4).join(' | ')}; shown "${shown}"; saved ${row}`);
} catch (e) { await T('PK-01', false, 'Loan / advance', e.message.split('\n')[0]); }

// 2. Salary adjustment (recovery)
try {
  await go('/self/payroll', 'Allowance & Adjustment', 'Salary Adjustment (Arrear / Recovery)', 'New adjustment');
  const [offered, shown] = await pickPerson(combo('— choose —'), 'kamrul is', 'Kamrul Islam');
  await page.getByRole('button', { name: /Paid too much/ }).first().click();
  await page.locator('input[type=number]').locator('visible=true').first().fill('3000');
  await page.getByPlaceholder(/August paid 3,000 extra/).fill('picker test');
  await click('Save adjustment');
  await page.waitForTimeout(2000);
  const row = sql(`SELECT employee_id FROM salary_adjustments WHERE employee_id=${who['Kamrul Islam'].emp} ORDER BY id DESC LIMIT 1`);
  await T('PK-02', narrowed(offered, 'Kamrul Islam', 'Kamrul Hasan') && shown.startsWith('Kamrul Islam') && row === String(who['Kamrul Islam'].emp), 'Salary adjustment: "kamrul is" finds Kamrul Islam (not Kamrul Hasan); saved for him', `offered ${offered.slice(0, 4).join(' | ')}; shown "${shown}"; saved ${row || 'nothing'}`);
} catch (e) { await T('PK-02', false, 'Salary adjustment', e.message.split('\n')[0]); }

// 3. Document Vault upload
try {
  await go('/admin/document-vault', 'Upload Document');
  const [offered, shown] = await pickPerson(combo('Select…'), 'shir', 'Shirin Akter');
  const pdf = path.join(OUT, 'picker.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  await page.locator('input[type=file]').locator('visible=true').last().setInputFiles(pdf);
  await click('Upload');
  await page.waitForTimeout(2500);
  const row = sql(`SELECT COUNT(*) FROM employee_documents WHERE user_id=${who['Shirin Akter'].uid}`);
  await T('PK-03', offered.some((o) => o.startsWith('Shirin Akter')) && shown.startsWith('Shirin Akter') && Number(row) >= 1, 'Document Vault: "shir" finds Shirin Akter; the document is filed under her', `offered ${offered.slice(0, 4).join(' | ')}; shown "${shown}"; her documents ${row}`);
} catch (e) { await T('PK-03', false, 'Document Vault upload', e.message.split('\n')[0]); }

// 4. Emergency vehicle requisition
try {
  await go('/admin/vehicle-management', 'Emergency Requisition');
  const [offered, shown] = await pickPerson(combo('Select an employee…'), 'tareq', 'Tareq Aziz');
  const supervisor = await page.locator('input[role=combobox]').locator('visible=true').nth(1).inputValue();
  await page.locator('textarea').locator('visible=true').first().fill('picker test — site visit');
  await page.getByText('Pickup Location', { exact: true }).locator('..').locator('input').first().fill('Head Office');
  await page.getByText('Destination', { exact: true }).locator('..').locator('input').first().fill('Site A');
  const d = new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  await page.locator('input[type=date]').locator('visible=true').first().fill(d);
  await page.locator('input[type=time]').locator('visible=true').first().fill('10:00');
  const pax = page.locator('input[type=number]').locator('visible=true');
  if (await pax.count()) await pax.first().fill('2');
  await click('Submit Requisition');
  await page.waitForTimeout(2500);
  const row = sql(`SELECT employee_user_id FROM vehicle_requisitions ORDER BY id DESC LIMIT 1`);
  await T('PK-04', offered.some((o) => o.startsWith('Tareq Aziz')) && shown.startsWith('Tareq Aziz') && row === String(who['Tareq Aziz'].uid) && /own Supervisor/.test(supervisor), 'Emergency vehicle requisition: "tareq" finds Tareq Aziz; saved for him; the "own Supervisor" default reads as text', `offered ${offered.slice(0, 3).join(' | ')}; shown "${shown}"; supervisor field "${supervisor}"; saved user ${row || 'nothing'}`);
} catch (e) { await T('PK-04', false, 'Emergency vehicle requisition', e.message.split('\n')[0]); }

// 5. Disciplinary action
try {
  await go('/admin/grievance-disciplinary', ' Disciplinary Actions', 'Issue Action');
  const [offered, shown] = await pickPerson(combo('Select employee…'), 'hasan', 'Kamrul Hasan');
  await page.getByPlaceholder('Reason').fill('picker test');
  await click('Issue');
  await page.waitForTimeout(2000);
  const row = sql(`SELECT user_id FROM disciplinary_actions ORDER BY id DESC LIMIT 1`);
  await T('PK-05', offered.some((o) => o.startsWith('Kamrul Hasan')) && !offered.some((o) => o.startsWith('Nusrat')) && shown.startsWith('Kamrul Hasan') && row === String(who['Kamrul Hasan'].uid), 'Disciplinary action: "hasan" (a surname) finds Kamrul Hasan; issued to him', `offered ${offered.slice(0, 4).join(' | ')}; shown "${shown}"; saved user ${row || 'nothing'}`);
} catch (e) { await T('PK-05', false, 'Disciplinary action', e.message.split('\n')[0]); }

// 6. Department with a Supervisor
try {
  await go('/admin/departments');
  await page.getByPlaceholder('e.g. Accounts & Finance').fill('Picker Dept');
  const [offered, shown] = await pickPerson(combo('— None —'), 'nusrat a', 'Nusrat Ara');
  await click('Add Department');
  await page.waitForTimeout(2000);
  const row = sql(`SELECT supervisor_user_id FROM departments WHERE name='Picker Dept'`);
  await T('PK-06', narrowed(offered, 'Nusrat Ara', 'Kamrul') && shown.startsWith('Nusrat Ara') && row === String(who['Nusrat Ara'].uid), 'Department: Supervisor "nusrat a" → Nusrat Ara, saved with the department', `offered ${offered.slice(0, 4).join(' | ')}; shown "${shown}"; saved supervisor ${row || 'nothing'}`);
} catch (e) { await T('PK-06', false, 'Department supervisor', e.message.split('\n')[0]); }

// 7. Mobile SIM given to someone (the field itself searches name / ID / department)
try {
  await go('/admin/mobile-bill', 'SIMs', 'Give a SIM');
  await page.getByPlaceholder('01XXXXXXXXX').fill('01711999888');
  const [offered, shown] = await pickPerson(combo('— Nobody (spare SIM) —'), 'shirin', 'Shirin Akter');
  const extraSearch = await page.getByPlaceholder(/Search employee name/).count();
  await click('Custom amount');
  await page.getByPlaceholder('৳').fill('500');
  await click('Give SIM');
  await page.waitForTimeout(2000);
  const row = sql(`SELECT employee_id FROM mobile_sims WHERE phone_number LIKE '%1711999888' ORDER BY id DESC LIMIT 1`);
  await T('PK-08', offered.some((o) => o.startsWith('Shirin Akter')) && shown.startsWith('Shirin Akter') && extraSearch === 0 && row === String(who['Shirin Akter'].emp), 'Give a SIM: "shirin" finds Shirin Akter in the field itself (no second search box); SIM saved to her', `offered ${offered.slice(0, 3).join(' | ')}; shown "${shown}"; extra search boxes ${extraSearch}; saved ${row || 'nothing'}`);
} catch (e) { await T('PK-08', false, 'Give a SIM', e.message.split('\n')[0]); }

await T('PK-07', errors.length === 0, 'No script errors on any of these pages', errors.slice(0, 3).join(' | '));
await browser.close();
const s = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(s));
fs.writeFileSync(path.join(OUT, 'qa-e2e-pickers.json'), JSON.stringify({ when: new Date().toISOString(), summary: s, results: R }, null, 1));
