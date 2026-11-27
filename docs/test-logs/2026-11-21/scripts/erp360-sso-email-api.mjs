// 360 ERP sign-in sends an email even when the login itself has none: the
// login's email (read fresh), else the office email on the Employee record;
// with neither, a clear message instead of 360 ERP's "The email field is required."
// Needs the server started with ERP360_BASE_URL=http://127.0.0.1:3299 (a fake 360 ERP here).
import http from 'node:http';
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>&1`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
let last = null;
const fake = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { last = JSON.parse(b || '{}'); res.setHeader('content-type', 'application/json'); if (!last.email) { res.statusCode = 422; return res.end(JSON.stringify({ message: 'The email field is required.' })); } res.end(JSON.stringify({ forward_url: 'https://erp.example/sso/abc' })); }); }).listen(3299);
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json()).token;
const SA = await login('admin@credence.test', 'ProbePass123');
const tag = Date.now().toString(36).slice(-5);
const dept = Number(sql('SELECT MIN(id) FROM departments'));
const office = `erp.${tag}@credencehousinglimited.com`;
const e = await api(SA, 'POST', '/api/employees', { name: `Erp Tester ${tag}`, designation: 'Officer', department_id: dept, joining_date: '2024-01-01', email: office, create_login: true, login_email: `erplogin.${tag}@credence.test`, login_password: 'Erp#2026pass' });
const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.b.id}`));
sql(`UPDATE users SET must_change_password=0, username='erp${tag}' WHERE id=${uid}`);
const tok = await login(`erplogin.${tag}@credence.test`, 'Erp#2026pass');
// 1. The login loses its email (an Employee-ID login): the office email is sent.
sql(`UPDATE users SET email=NULL WHERE id=${uid}`);
let r = await api(tok, 'POST', '/api/sso/erp360/initiate');
ok(r.s === 200 && last?.email === office, 'login with no email → the Employee record\'s office email is sent (' + JSON.stringify(last) + ')');
// 2. The login has its own email: that one, read fresh.
sql(`UPDATE users SET email='own.${tag}@credencehousinglimited.com' WHERE id=${uid}`);
r = await api(tok, 'POST', '/api/sso/erp360/initiate');
ok(r.s === 200 && last?.email === `own.${tag}@credencehousinglimited.com`, 'login with its own email (set after sign-in) → that one is sent');
// 3. No email anywhere: a clear message, 360 ERP not called.
sql(`UPDATE users SET email=NULL WHERE id=${uid}; UPDATE all_employees SET email=NULL WHERE id=${e.b.id}`);
last = null;
r = await api(tok, 'POST', '/api/sso/erp360/initiate');
ok(r.s === 400 && /no email address/.test(r.b.error) && last === null, 'no email anywhere → "add your office email" message, 360 ERP not called');
fake.close();
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
