// QA: a big company. Puts N employees (default 3000) into the database —
// each with a Salary Structure, a login for a third of them, a month of
// attendance for those and some leave — then times the pages HR opens
// every day and a whole month's payroll run, through the real API, and
// the Employees / Payroll pages in a browser.
// Usage: N=3000 node qa-bigdata.mjs <out.json>
import fs from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const BASE = process.env.BASE || 'http://localhost:3100';
const N = Number(process.env.N || 3000);
const sqlIn = (q) => { try { return execFileSync('mysql', ['-N', 'mpr_tracker_db'], { input: q, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); } catch (e) { throw new Error(String(e.stderr).slice(0, 500)); } };
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
async function api(t, m, p, b) {
  const s = performance.now();
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text();
  let j; try { j = JSON.parse(x); } catch { j = x; }
  return { status: r.status, body: j, ms: Math.round(performance.now() - s), kb: Math.round(x.length / 1024) };
}
const R = [];
const T = (id, ok, name, detail = '') => { R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 400) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}  — ${String(detail).slice(0, 300)}`); };

// ---- Seed -----------------------------------------------------------------
const month = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const t0 = performance.now();
const hash = sql("SELECT password_hash FROM users WHERE email='admin@credence.test'");
const base = Number(sql('SELECT COALESCE(MAX(id),0) FROM all_employees')) + 1;
const ubase = Number(sql('SELECT COALESCE(MAX(id),0) FROM users')) + 1;
sql("INSERT INTO projects (project_name, location_lat, location_lng, location_radius) VALUES ('Big Data Site', 23.78, 90.4, 200)");
const proj = Number(sql("SELECT MAX(id) FROM projects"));
const first = ['Rahim', 'Karim', 'Farhana', 'Nusrat', 'Sabbir', 'Tanvir', 'Mitu', 'Jahid', 'Rumana', 'Arif'];
const last = ['Uddin', 'Ahmed', 'Akter', 'Hossain', 'Islam', 'Khan', 'Chowdhury', 'Rahman'];
let q = 'SET autocommit=0;\n';
const users = [];
for (let i = 0; i < N; i++) {
  const id = base + i;
  const withLogin = i % 3 === 0;
  const uid = withLogin ? ubase + users.length : null;
  const name = `${first[i % 10]} ${last[i % 8]} ${i}`;
  const email = `big${i}@credence.test`;
  if (withLogin) { users.push(uid); q += `INSERT INTO users (id, name, email, password_hash, role) VALUES (${uid}, '${name}', '${email}', '${hash}', 'user');\n`; }
  q += `INSERT INTO all_employees (id, employee_id, name, designation, department_id, email, phone, joining_date, is_active, company_id, user_id) VALUES (${id}, 'BIG-${String(i).padStart(5, '0')}', '${name}', 'Officer', ${1 + (i % 5)}, '${email}', '017${String(10000000 + i)}', '2024-01-01', 1, 1, ${uid ?? 'NULL'});\n`;
  const basic = 20000 + (i % 40) * 1000;
  q += `INSERT INTO salary_structures (employee_id, basic_salary, house_rent, medical_allowance, conveyance_allowance, gross_salary, effective_date) VALUES (${id}, ${basic}, ${basic / 2}, 1500, 1000, ${basic * 1.5 + 2500}, '2024-01-01');\n`;
  if (i % 500 === 499) q += 'COMMIT;\n';
}
for (const [k, uid] of users.entries()) {
  const vals = [];
  for (let d = 1; d <= days; d++) {
    const dt = `${month}-${String(d).padStart(2, '0')}`;
    if (new Date(`${dt}T00:00:00Z`).getUTCDay() === 5) continue; // Friday off
    vals.push(`(${uid}, ${proj}, '${dt}', '${dt} 09:0${k % 10}:00', '${dt} 18:00:00')`);
  }
  q += `INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_out_at) VALUES ${vals.join(',')};\n`;
  if (k % 4 === 0) q += `INSERT INTO leave_applications (user_id, leave_type, start_date, end_date, day_count, purpose, apply_date, status) VALUES (${uid}, 'casual', '${month}-10', '${month}-10', 1, 'seed', '${month}-01', 'approved');\n`;
  if (k % 200 === 199) q += 'COMMIT;\n';
}
q += 'COMMIT;\n';
sqlIn(q);
const seeded = { employees: sql('SELECT COUNT(*) FROM all_employees'), users: sql('SELECT COUNT(*) FROM users'), attendance: sql('SELECT COUNT(*) FROM attendance'), leave: sql('SELECT COUNT(*) FROM leave_applications') };
console.log(`seeded in ${Math.round((performance.now() - t0) / 1000)} s:`, JSON.stringify(seeded));

// ---- API timings ----------------------------------------------------------
const LOGIN = (await api(null, 'POST', '/api/auth/login', { identifier: 'admin@credence.test', password: 'AdminPass123' })).body;
const SA = LOGIN.token;
const LIMIT = 3000; // ms: a page's main list should come back within this
const timed = async (id, name, p, m = 'GET', b) => {
  const runs = [];
  let last;
  for (let k = 0; k < 3; k++) { last = await api(SA, m, p, b); runs.push(last.ms); }
  runs.sort((a, b2) => a - b2);
  T(id, last.status === 200 && runs[1] <= LIMIT, `${name} (${N} employees)`, `median ${runs[1]} ms, ${last.kb} KB, status ${last.status}`);
  return last;
};
await timed('BD-01', 'Employees list', '/api/employees');
await timed('BD-02', 'Employee Directory', '/api/employee-directory');
await timed('BD-03', 'Payroll: employee picker', '/api/payroll/employees');
await timed('BD-04', 'Payroll: Salary Structures', '/api/payroll/salary-structures');
await timed('BD-05', `Payroll wizard: attendance summary for ${month}`, `/api/payroll/wizard/attendance-summary?month_year=${month}`);
await timed('BD-06', 'Leave applications', '/api/leave-applications');
await timed('BD-07', 'Admin Dashboard extras', '/api/admin-dashboard/extras');
await timed('BD-08', 'Approvals', '/api/approvals');

// Whole month's payroll in one go, the way the wizard sends it.
const ids = sql(`SELECT id FROM all_employees WHERE id >= ${base} ORDER BY id`).split('\n').map(Number);
const rows = ids.map((employee_id) => ({ employee_id, total_working_days: 26, present_days: 26, absent_days: 0, leave_days: 0 }));
const bulk = await api(SA, 'POST', '/api/payroll/generate-bulk', { month_year: month, employees: rows });
const okRows = Array.isArray(bulk.body?.results) ? bulk.body.results.filter((r) => r.success).length : 0;
T('BD-09', bulk.status === 200 && okRows === N && bulk.ms <= 120000, `Payroll for the whole month (${N} employees) in one run`, `${okRows}/${N} made in ${Math.round(bulk.ms / 1000)} s (${Math.round(bulk.ms / N)} ms each)`);
const sumDb = Number(sql(`SELECT ROUND(SUM(net_salary)) FROM payrolls WHERE month_year='${month}' AND employee_id >= ${base}`));
const expect = ids.reduce((s, _, i) => s + (20000 + (i % 40) * 1000) * 1.5 + 2500, 0);
T('BD-10', Math.abs(sumDb - expect) < 1, 'Total net salary of the month adds up', `${sumDb} vs expected ${expect}`);
await timed('BD-11', `Payroll list for ${month}`, `/api/payroll?month_year=${month}`);
await timed('BD-11b', `Payroll: Employee Salary Profiles for ${month}`, `/api/payroll/employee-list?month_year=${month}`);
await timed('BD-12', 'Payroll dashboard summary', `/api/payroll/dashboard-summary?month_year=${month}`);

// ---- Browser: the pages HR opens ------------------------------------------
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM || '/usr/local/lib/node_modules_global/')('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Dhaka' });
await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); localStorage.setItem(`credence_webpush_snooze_${u.id}`, String(Date.now() + 9e9)); }, [SA, LOGIN.user]);
const page = await ctx.newPage();
// Warm-up: the dev server compiles each page's code on its first visit,
// which is not what a user of the built app waits for.
for (const u of ['/admin/employees', '/admin/payroll']) { await page.goto(BASE + u, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4000); }
for (const [id, url, waitFor] of [['BD-13', '/admin/employees', /BIG-\d{5}/], ['BD-14', '/admin/payroll', /Payroll/]]) {
  const s = performance.now();
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  let shown = false;
  try { await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), waitFor.source, { timeout: 30000 }); shown = true; } catch {}
  const ms = Math.round(performance.now() - s);
  // Typing in the search box: how long until the list narrows down.
  let searchMs = null;
  if (id === 'BD-13' && shown) {
    const box = page.getByPlaceholder(/Search by name/);
    const s2 = performance.now();
    const lastCode = `BIG-${String(N - 1).padStart(5, '0')}`;
    await box.fill(lastCode);
    try { await page.waitForFunction((code) => { const m = document.body.innerText.match(/BIG-\d{5}/g) || []; return m.length > 0 && m.every((x) => x === code); }, lastCode, { timeout: 15000 }); searchMs = Math.round(performance.now() - s2); } catch {}
  }
  T(id, shown && ms <= 8000 && (id !== 'BD-13' || (searchMs !== null && searchMs <= 2000)), `${url} opens with ${N} employees${id === 'BD-13' ? ' and search narrows the list' : ''}`, `shown in ${ms} ms${searchMs !== null ? `; search ${searchMs} ms` : ''}`);
}
await browser.close();

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'qa-bigdata.json', JSON.stringify({ when: new Date().toISOString(), N, seeded, summary: sum, results: R }, null, 1));
