// Hands-on security / logic probes against a DB copy (port 3300). Reports only.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
const BASE = 'http://localhost:3300';
const R = []; const T = (id, ok, name, detail = '') => { R.push({ id, ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? '  — ' + String(detail).slice(0, 260) : ''}`); };
async function api(t, m, p, b, h = {}) { const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...h }, body: b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b) }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j, h: r.headers }; }
const sql = (q) => execFileSync('mysql', ['-N', 'sweep_db', '-e', q]).toString().trim();
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p })).b;
const SA = (await login('admin@credence.test', 'AdminPass123')).token;
const tahmid = await login('tahmid.rahman@credence.test', 'Credence@2026'); const TA = tahmid.token;
const KA = (await login('kamal.uddin@credence.test', 'Credence@2026')).token;

// P1 IDOR: Tahmid (135) reads someone else's bill claim history / file (claim 1 belongs to 138)
const h = await api(TA, 'GET', '/api/bill-claims/1/history'); T('P1', h.s === 403 || h.s === 404, 'Employee cannot read another person\'s Bill Claim history', `status ${h.s}`);
const f = await api(TA, 'GET', '/api/bill-claims/1/file'); T('P2', f.s === 403 || f.s === 404, 'Employee cannot download another person\'s Bill Claim file', `status ${f.s}`);
// P3 delete someone else's claim
const d = await api(TA, 'DELETE', '/api/bill-claims/1'); T('P3', d.s === 403 || d.s === 404, 'Employee cannot delete another person\'s Bill Claim', `status ${d.s}; still there: ${sql('SELECT COUNT(*) FROM bill_claims WHERE id=1')}`);
// P4 payslip of someone else
const ps = sql("SELECT p.id FROM payrolls p JOIN all_employees e ON e.id=p.employee_id WHERE e.user_id<>135 LIMIT 1");
if (ps) { const r = await api(TA, 'GET', `/api/my-payslips/${ps}`); T('P4', r.s === 403 || r.s === 404, 'Employee cannot open another person\'s payslip by id', `payroll ${ps} -> ${r.s}`); } else T('P4', true, 'no other payroll rows to try');
// P5 mass assignment on own profile
const before = sql('SELECT role FROM users WHERE id=135');
await api(TA, 'PUT', '/api/profile/personal-data', { first_name: 'Tahmid', role: 'superadmin', is_platform_admin: 1, can_view_bill_claims: 1, company_id: 99 });
T('P5', sql('SELECT role FROM users WHERE id=135') === before && sql('SELECT IFNULL(is_platform_admin,0) FROM users WHERE id=135') === '0', 'Profile update ignores role / platform-admin fields', `role ${sql('SELECT role FROM users WHERE id=135')}`);
// P6 JWT tampering
const [hh, pp] = TA.split('.'); const payload = JSON.parse(Buffer.from(pp, 'base64url').toString()); payload.role = 'superadmin'; payload.id = 1;
const forged = `${hh}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${TA.split('.')[2]}`;
const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
const a1 = await api(forged, 'GET', '/api/users'); const a2 = await api(none, 'GET', '/api/users');
T('P6', a1.s === 401 || a1.s === 403, 'Edited token (role=superadmin) is refused', `status ${a1.s}`); T('P7', a2.s === 401 || a2.s === 403, 'Unsigned token (alg none) is refused', `status ${a2.s}`);
// P8 brute force: 12 wrong passwords
const codes = []; for (let i = 0; i < 12; i++) codes.push((await api(null, 'POST', '/api/auth/login', { identifier: 'kamal.uddin@credence.test', password: 'wrong' + i })).s);
const right = await api(null, 'POST', '/api/auth/login', { identifier: 'kamal.uddin@credence.test', password: 'Credence@2026' });
T('P8', codes.some((c) => c === 429 || c === 423) || (right.s !== 200), 'Repeated wrong passwords get slowed / locked', `wrong answers ${codes.join(',')}; right password then ${right.s}`);
// P9 employee acts on an approval meant for someone else
const req = sql("SELECT id FROM approval_requests WHERE status='pending' LIMIT 1");
if (req) { const r = await api(TA, 'POST', `/api/my-approvals/${req}/act`, { action: 'approved' }); T('P9', r.s >= 400, 'Employee cannot approve a request that is not in their queue', `request ${req} -> ${r.s} ${JSON.stringify(r.b).slice(0, 100)}`); }
// P10 a request through /api/approvals (admin route) by employee
const r10 = await api(TA, 'POST', `/api/approvals/${req || 1}/act`, { action: 'approved' }); T('P10', r10.s === 403 || r10.s === 401, 'Employee cannot use the Admin approvals route', `status ${r10.s}`);
// P11 Bill claim file: HTML disguised as PDF
const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
const today = sql("SELECT DATE(CONVERT_TZ(NOW(),'+00:00','+06:00'))");
const cat = (await api(KA, 'GET', '/api/bill-claim-categories')).b?.[0]?.id;
const sub = await api(KA, 'POST', '/api/bill-claims', { claim_date: today, from_date: today, to_date: today, items: [{ category_id: cat, bill_date: today, amount: 50 }], description: '<img src=x onerror=alert(1)>', file_base64: html, file_name: 'x.pdf', file_mimetype: 'application/pdf' });
T('P11', sub.s >= 400, 'A fake PDF (really HTML) is refused as a Bill Claim attachment', `status ${sub.s} ${JSON.stringify(sub.b).slice(0, 140)}`);
// P12 if accepted, how is it served?
if (sub.s < 300) { const id = sub.b.id; const r = await fetch(`${BASE}/api/bill-claims/${id}/file`, { headers: { authorization: `Bearer ${KA}` } }); T('P12', !/html/i.test(r.headers.get('content-type') || ''), 'Stored attachment is never served as HTML', `content-type ${r.headers.get('content-type')}; disposition ${r.headers.get('content-disposition')}; nosniff ${r.headers.get('x-content-type-options')}`); }
// P13 negative / huge amounts
const neg = await api(TA, 'POST', '/api/bill-claims', { claim_date: today, from_date: today, to_date: today, items: [{ category_id: cat, bill_date: today, amount: -500 }] });
T('P13', neg.s >= 400, 'Negative bill amount is refused', `status ${neg.s} ${JSON.stringify(neg.b).slice(0, 120)}`);
// P14 leave with end before start
const lv = await api(TA, 'POST', '/api/leave-applications', { leave_type: 'casual', start_date: '2026-12-10', end_date: '2026-12-05', reason: 'x' });
T('P14', lv.s >= 400, 'Leave whose end is before its start is refused', `status ${lv.s} ${JSON.stringify(lv.b).slice(0, 120)}`);
// P15 SQL injection in search
const inj = await api(SA, 'GET', "/api/employee-directory?q=' OR 1=1 -- ");
T('P15', inj.s < 500, 'Quote characters in search do not break the server', `status ${inj.s}`);
// P16 security headers
const home = await fetch(BASE + '/'); const hd = (k) => home.headers.get(k);
T('P16', !!hd('x-content-type-options') && !!(hd('x-frame-options') || /frame-ancestors/.test(hd('content-security-policy') || '')), 'Security headers on the app page', `nosniff=${hd('x-content-type-options')} xfo=${hd('x-frame-options')} csp=${(hd('content-security-policy') || '').slice(0, 80)} hsts=${hd('strict-transport-security')}`);
// P17 plain user (no Self Service switch) files a bill claim
const PL = (await login('plain.r@credence.test', 'Credence@2026'))?.token;
if (PL) { const r = await api(PL, 'POST', '/api/bill-claims', { claim_date: today, from_date: today, to_date: today, items: [{ category_id: cat, bill_date: today, amount: 10 }] }); T('P17', r.s === 403, 'Account without the Bill Claim switch cannot file one', `status ${r.s}`); }
console.log(JSON.stringify({ pass: R.filter((x) => x.ok).length, fail: R.filter((x) => !x.ok).length }));
