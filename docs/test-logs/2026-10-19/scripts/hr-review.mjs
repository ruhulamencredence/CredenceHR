// HR-specialist review: adversarial / compliance checks against the live API.
// Each check is PASS (the system protects), FAIL (a defect), or INFO (observation).
import fs from 'fs';
import { execFileSync } from 'child_process';
const BASE = 'http://localhost:3100';
const R = []; let area = '';
const rec = (id, status, name, detail = '') => { R.push({ id, area, status, name, detail: String(detail).slice(0, 400) }); console.log(`${status.padEnd(4)} ${id} ${name}${status !== 'PASS' && detail ? '  — ' + String(detail).slice(0, 260) : ''}`); };
const T = (id, ok, name, detail = '') => rec(id, ok ? 'PASS' : 'FAIL', name, ok ? '' : detail);
const INFO = (id, name, detail) => rec(id, 'INFO', name, detail);
async function api(t, m, p, b, extra = {}) {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...(extra.headers || {}) }, body: b !== undefined ? (typeof b === 'string' ? b : JSON.stringify(b)) : undefined });
  const txt = await r.text(); let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body, headers: r.headers };
}
const isHtml = (r) => typeof r.body === 'string' && /<html/i.test(r.body);
const J = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const sql = (q) => execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const login = async (i, p) => (await api(null, 'POST', '/api/auth/login', { identifier: i, password: p }));
const denied = (r) => r.status === 401 || r.status === 403;
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

const SA = (await login('admin@credence.test', 'AdminPass123')).body.token;
// ---- fixtures ----
const mkEmp = async (name, email, extra = {}) => { const r = await api(SA, 'POST', '/api/employees', { name, designation: 'Officer', department_id: 2, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: 'Pass12345', ...extra }); return r; };
const eA = await mkEmp('Alice Review', 'alice.rv@credence.test'); const eB = await mkEmp('Bob Review', 'bob.rv@credence.test');
const A = (await login('alice.rv@credence.test', 'Pass12345')).body; const B = (await login('bob.rv@credence.test', 'Pass12345')).body;
console.log('fixtures', eA.status, eB.status, !!A.token, !!B.token);
const hrU = (await api(SA, 'POST', '/api/users', { name: 'HR Limited', email: 'hr.lim@credence.test', password: 'Pass12345', role: 'admin' })).body.id;
await api(SA, 'PUT', `/api/users/${hrU}/module-permissions`, { modules: ['employees'] });
const HR = (await login('hr.lim@credence.test', 'Pass12345')).body;

// ================= SEC =================
area = 'Security — accounts & sessions';
{
  const w = await login('alice.rv@credence.test', 'wrong'); const u = await login('nobody@credence.test', 'wrong');
  T('SEC-01', [400,401].includes(w.status) && [400,401].includes(u.status), 'Wrong password and unknown user both refused', `${w.status}/${u.status}`);
  T('SEC-02', JSON.stringify(w.body.error) === JSON.stringify(u.body.error), 'Same message for wrong password and unknown user (no account enumeration)', `${JSON.stringify(w.body)} vs ${JSON.stringify(u.body)}`);
  let codes = []; for (let i = 0; i < 25; i++) codes.push((await login('alice.rv@credence.test', 'bad' + i)).status);
  const throttled = codes.some((c) => c === 429 || c === 423);
  const still = (await login('alice.rv@credence.test', 'Pass12345')).status;
  T('SEC-03', throttled, 'Repeated wrong passwords are throttled / the account locked (25 attempts)', `statuses ${[...new Set(codes)]}; the right password still logs in: ${still}`);
  const inj = await login("' OR '1'='1' --", "' OR '1'='1"); T('SEC-04', [400,401].includes(inj.status) && !inj.body.token, 'SQL injection in login refused', J(inj));
  const parts = SA.split('.'); const tam = parts[0] + '.' + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), role: 'superadmin', id: 99999 })).toString('base64url') + '.' + parts[2];
  T('SEC-05', denied(await api(tam, 'GET', '/api/users')), 'Tampered token refused');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ id: 1, role: 'superadmin' })).toString('base64url') + '.';
  T('SEC-06', denied(await api(none, 'GET', '/api/users')), 'Unsigned (alg=none) token refused');
  const weak = await api(SA, 'POST', '/api/users', { name: 'Weak Pw', email: 'weak.pw@credence.test', password: '111111', role: 'user' });
  T('SEC-07', weak.status >= 400, 'Password "111111" is refused by the password policy', `accepted: ${J(weak)} — the only rule is "at least 6 characters"`);
  const lst = await api(SA, 'GET', '/api/users'); T('SEC-08', !/password_hash|\$2[aby]\$/.test(JSON.stringify(lst.body)), 'User list does not return password hashes');
  const hashRow = sql("SELECT password_hash FROM users WHERE email='alice.rv@credence.test'"); T('SEC-09', /^\$2[aby]\$/.test(hashRow), 'Passwords stored as bcrypt hashes');
  const chg = await api(A.token, 'PUT', '/api/profile/password', { current_password: 'Pass12345', new_password: 'NewPass456' });
  const old = await api(A.token, 'GET', '/api/auth/me');
  T('SEC-10', chg.status === 200 && denied(old), 'After a password change the old token stops working', `change ${chg.status}; old token /auth/me → ${old.status}`);
  const relog = await login('alice.rv@credence.test', 'NewPass456'); A.token = relog.body.token;
  const cors = await api(null, 'GET', '/api/health', undefined, { headers: { Origin: 'https://evil.example' } });
  T('SEC-11', cors.headers.get('access-control-allow-origin') !== '*' && cors.headers.get('access-control-allow-origin') !== 'https://evil.example', 'API does not allow any website to call it (CORS)', `Access-Control-Allow-Origin: ${cors.headers.get('access-control-allow-origin')}`);
  const hd = cors.headers; const missing = ['content-security-policy', 'x-frame-options', 'strict-transport-security', 'x-content-type-options'].filter((h) => !hd.get(h));
  T('SEC-12', missing.length === 0, 'Standard security headers present (CSP, X-Frame-Options, HSTS, nosniff)', `missing: ${missing.join(', ')}`);
  const jwtSrc = fs.readFileSync('/home/user/CredenceHR/server.ts', 'utf8');
  T('SEC-13', !/JWT_SECRET\s*=\s*process\.env\.JWT_SECRET\s*\|\|\s*"[^"]+"/.test(jwtSrc), 'No hard-coded fallback JWT secret in code', 'server.ts falls back to a fixed secret when JWT_SECRET is not set');
  const big = await api(SA, 'POST', '/api/notices', JSON.stringify({ title: 'x', content_html: 'a'.repeat(30 * 1024 * 1024) }));
  T('SEC-14', big.status === 413 || big.status === 400, 'Oversized request refused', J(big));
  const bad = await api(SA, 'POST', '/api/notices', '{bad json'); T('SEC-15', bad.status === 400 && typeof bad.body !== 'string', 'Malformed JSON gives a clean JSON error (not an HTML error page)', J(bad).slice(0,120));
  const nf = await api(SA, 'GET', '/api/does-not-exist'); T('SEC-16', nf.status === 404, 'An unknown /api path answers 404 (not the web page with 200)', `status ${nf.status}, html=${isHtml(nf)}`);
}
area = 'Security — stored XSS / notices';
{
  const x = await api(SA, 'POST', '/api/notices', { title: 'XSS probe', content_html: '<p>hi</p><img src=x onerror="window.__xss=1"><script>window.__xss2=1</script>', target_type: 'all', is_active: true });
  const board = await api(B.token, 'GET', '/api/notices/board');
  const back = JSON.stringify(board.body);
  T('SEC-17', !/onerror|<script/i.test(back), 'Notice HTML is cleaned on the server before it reaches employees', 'script / onerror reached the employee unchanged — rendered with dangerouslySetInnerHTML in NoticeBoard, NoticePopup, TrackingNoticeCard');
  const lim = await api(HR.token, 'POST', '/api/notices', { title: 't', content_html: '<p>x</p>', target_type: 'all', is_active: true });
  T('SEC-18', denied(lim), 'Admin without the Notices module cannot post a notice (only the Employees module)', J(lim));
}

// ================= AUTHZ =================
area = 'Authorization & privacy';
{
  const adm = ['/api/users', '/api/employees', '/api/payroll?month_year=2026-10', '/api/hr-analytics/summary', '/api/approval-templates', '/api/companies', '/api/departments/manage', '/api/exit-requests/pending'];
  for (const p of adm) { const r = await api(B.token, 'GET', p); if (isHtml(r)) { INFO('AUTHZ-01', `${p} is not an API route here (HTML page returned)`, ''); continue; } T('AUTHZ-01', denied(r), `Employee cannot open ${p}`, J(r)); }
  const ew = [['POST', '/api/notices', { title: 'a', content_html: 'b', target_type: 'all' }], ['PUT', '/api/leave-balances/bulk', {}], ['POST', '/api/holidays', { entry_date: day(3), day_type: 'holiday', title: 'x' }], ['POST', '/api/payroll/generate', {}], ['POST', '/api/employees', { name: 'Evil' }], ['PUT', `/api/users/${hrU}/module-permissions`, { modules: ['payroll'] }], ['POST', '/api/users', { name: 'Evil', email: 'evil@x.test', password: 'Pass12345', role: 'admin' }]];
  for (const [m, p, b] of ew) { const r = await api(B.token, m, p, b); T('AUTHZ-02', denied(r), `Employee cannot ${m} ${p}`, J(r)); }
  const meU = await api(B.token, 'GET', '/api/auth/me'); const bid = meU.body.id || meU.body.user?.id;
  const esc = await api(B.token, 'PUT', '/api/profile', { role: 'superadmin', name: 'Bob' }); const roleNow = sql(`SELECT role FROM users WHERE id=${bid}`);
  T('AUTHZ-03', roleNow === 'user', 'Employee cannot raise their own role through the profile API (mass assignment)', `role is now ${roleNow} (${esc.status})`);
  const lim = await api(HR.token, 'PUT', `/api/users/${hrU}/module-permissions`, { modules: ['employees', 'notices', 'payroll'] });
  T('AUTHZ-04', denied(lim), 'A limited Admin cannot give themselves more modules', J(lim));
  const pay = await api(HR.token, 'GET', '/api/payroll?month_year=2026-10'); T('AUTHZ-05', denied(pay), 'HR Admin without Payroll module cannot read payroll', J(pay));
  const empList = await api(HR.token, 'GET', '/api/employees'); const s = JSON.stringify(empList.body).toLowerCase();
  const sens = ['basic_salary', 'gross_salary', 'bank_account', 'nid', 'password']; const leaked = sens.filter((k) => s.includes('"' + k));
  INFO('PRIV-01', 'Fields the Employees module returns for every employee', `sensitive keys present: ${leaked.join(', ') || 'none'}`);
  const dir = await api(B.token, 'GET', '/api/employee-directory'); const ds = JSON.stringify(dir.body).toLowerCase();
  const dl = ['salary', 'nid', 'birth', 'blood', 'phone', 'mobile', 'address', 'bank'].filter((k) => ds.includes(k));
  INFO('PRIV-02', 'What every employee can see in the Employee Directory', `keys present: ${dl.join(', ') || 'none'} (status ${dir.status})`);
}

// ================= LEAVE =================
for (const k of ['casual', 'sick']) await api(SA, 'PUT', `/api/leave-policies/${k}`, { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false });
for (const [e, u] of [[eA, A], [eB, B]]) { const uid = e.body.user_id; await api(SA, 'PUT', `/api/users/${uid}/leave-application-access`, { can_view_leave_application: true }); await api(SA, 'PUT', `/api/leave-balances/${uid}`, { casual_leave: 10, sick_leave: 14, leave_without_pay: 0 }); }
area = 'Leave policy';
{
  const apply = (tok, b) => api(tok, 'POST', '/api/leave-applications', b);
  const s1 = day(40), e1 = day(41);
  T('LEAVE-01', (await apply(A.token, { leave_type: 'casual', start_date: e1, end_date: s1, purpose: 'x' })).status === 400, 'End date before start date refused');
  T('LEAVE-02', (await apply(A.token, { leave_type: 'casual', start_date: s1, end_date: e1, purpose: '' })).status === 400, 'Purpose is required');
  T('LEAVE-03', (await apply(A.token, { leave_type: 'unknown_type', start_date: s1, end_date: e1, purpose: 'x' })).status === 400, 'Unknown leave type refused');
  const first = await apply(A.token, { leave_type: 'casual', start_date: s1, end_date: e1, purpose: 'Family' });
  INFO('LEAVE-04a', 'First application accepted', J(first));
  const dup = await apply(A.token, { leave_type: 'casual', start_date: s1, end_date: e1, purpose: 'Family again' });
  T('LEAVE-04', dup.status >= 400, 'Applying again for the same dates is refused (no double booking)', J(dup));
  const ov = await apply(A.token, { leave_type: 'sick', start_date: e1, end_date: day(43), purpose: 'overlaps the 2nd day' });
  T('LEAVE-05', ov.status >= 400, 'A different leave overlapping an existing application is refused', J(ov));
  const race = await Promise.all([1, 2, 3].map(() => apply(B.token, { leave_type: 'casual', start_date: day(60), end_date: day(60), purpose: 'race' })));
  const okc = race.filter((r) => r.status === 200).length; T('LEAVE-06', okc <= 1, 'Three identical applications sent at once create only one record', `${okc} created`);
  const bal = await api(B.token, 'GET', '/api/leave-balances/mine'); INFO('LEAVE-07', 'Balances a new employee starts with', JSON.stringify(bal.body).slice(0, 220));
  const big = await apply(B.token, { leave_type: 'casual', start_date: day(100), end_date: day(160), purpose: '60 days casual' });
  T('LEAVE-08', big.status >= 400, 'Casual leave longer than the balance (61 days) is refused', J(big));
  const back = await apply(B.token, { leave_type: 'casual', start_date: day(-400), end_date: day(-399), purpose: 'back dated' });
  INFO('LEAVE-09', 'A leave dated more than a year in the past', J(back));
  const sw = await apply(B.token, { leave_type: 'casual', start_date: s1, end_date: s1, purpose: 'x', day_count: 5 });
  INFO('LEAVE-10', 'Client-sent day_count is ignored / recomputed', J(sw));
  const mine = await api(B.token, 'GET', '/api/leave-applications'); const seesA = JSON.stringify(mine.body).includes('Family');
  T('LEAVE-11', !seesA, "An employee's leave list does not show a colleague's applications (privacy)", J(mine).slice(0, 160));
  const selfApprove = await api(A.token, 'POST', `/api/leave-applications/${first.body.id}/decision`, { action: 'approved' });
  T('LEAVE-12', denied(selfApprove) || selfApprove.status === 400, 'An employee cannot approve their own leave', J(selfApprove));
  const idor = await api(B.token, 'POST', `/api/leave-applications/${first.body.id}/decision`, { action: 'approved' });
  T('LEAVE-13', denied(idor) || idor.status === 400 || idor.status === 404, 'A colleague who is not the approver cannot approve it', J(idor));
}

// ================= EMPLOYEE DATA =================
area = 'Employee master data';
{
  const dupE = await mkEmp('Alice Duplicate', 'alice.rv@credence.test'); T('EMP-01', dupE.status >= 400, 'Duplicate login email refused', J(dupE));
  const badE = await api(SA, 'POST', '/api/employees', { name: 'Bad Email', email: 'not-an-email', joining_date: '2024-01-01' }); T('EMP-02', badE.status >= 400, 'Invalid email address refused', J(badE));
  const fut = await api(SA, 'POST', '/api/employees', { name: 'Future Joiner', joining_date: day(400), department_id: 2 }); INFO('EMP-03', 'Joining date set 13 months in the future', J(fut));
  const minor = await api(SA, 'POST', '/api/employees', { name: 'Minor Test', joining_date: '2024-01-01', date_of_birth: '2015-01-01', gender: 'Male', department_id: 2 });
  T('EMP-04', minor.status >= 400, 'An employee born in 2015 (age 11) is refused (minimum working age)', J(minor));
  const noName = await api(SA, 'POST', '/api/employees', { joining_date: '2024-01-01' }); T('EMP-05', noName.status >= 400, 'Name is required', J(noName));
  const xss = await api(SA, 'POST', '/api/employees', { name: '<img src=x onerror=alert(1)>', joining_date: '2024-01-01', department_id: 2 });
  INFO('EMP-06', 'Employee name containing HTML is stored as text (React escapes it on screen)', J(xss));
  const codes = sql('SELECT COUNT(*), COUNT(DISTINCT employee_id) FROM all_employees WHERE employee_id IS NOT NULL'); INFO('EMP-07', 'Employee IDs (count, distinct)', codes);
}

// ================= PAYROLL =================
area = 'Payroll controls';
{
  const eid = eA.body.id;
  const neg = await api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: eid, effective_date: '2026-01-01', basic_salary: -5000, house_rent: 0, medical_allowance: 0, conveyance_allowance: 0 }); T('PAY-01', neg.status >= 400, 'A negative basic salary is refused', J(neg));
  const ok = await api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: eid, effective_date: '2026-01-01', basic_salary: 30000, house_rent: 15000, medical_allowance: 3000, conveyance_allowance: 2000, tax_deduction: 500, pf_deduction: 1500 });
  INFO('PAY-02a', 'Salary structure for the test employee', J(ok));
  const g1 = await api(SA, 'POST', '/api/payroll/generate', { employee_id: eid, month_year: '2026-09', total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0 });
  const g2 = await api(SA, 'POST', '/api/payroll/generate', { employee_id: eid, month_year: '2026-09', total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0 });
  T('PAY-02', g1.status < 300 && g2.status >= 400, 'The same employee/month cannot be paid twice', `first ${g1.status}, second ${g2.status}`);
  const row = g1.status < 300 ? (await api(SA, 'GET', `/api/payroll/${g1.body.id}`)).body : {};
  const gross = Number(row.gross_salary ?? row.gross ?? 0), net = Number(row.net_salary ?? row.net ?? 0);
  T('PAY-03', net === 48000, 'Net pay = 50,000 gross − 500 tax − 1,500 PF = 48,000', `net ${net}; row keys: ${Object.keys(row).join(',').slice(0,200)}`);
  const bad = await api(SA, 'POST', '/api/payroll/generate', { employee_id: eid, month_year: '2026-08', total_working_days: 26, present_days: 40, leave_days: 0, absent_days: 0 });
  T('PAY-04', bad.status >= 400, 'Present days greater than working days (40 of 26) refused', J(bad));
  const before = await api(SA, 'POST', '/api/payroll/generate', { employee_id: eid, month_year: '2023-06', total_working_days: 26, present_days: 26, leave_days: 0, absent_days: 0 });
  T('PAY-05', before.status >= 400, 'Salary for a month before the joining date (2024-01) is refused', J(before));
  const emp = await api(B.token, 'GET', `/api/payroll/${g1.body?.id || 1}`); T('PAY-06', denied(emp), 'An employee cannot open a payroll record by id', J(emp));
  const ps = await api(B.token, 'GET', '/api/my-payslips'); T('PAY-07', !JSON.stringify(ps.body).includes('50000'), "An employee's payslip list never contains someone else's pay", J(ps));
  const stage = await api(SA, 'POST', '/api/payroll/approval/2026-09/submit', {}); const stage2 = await api(SA, 'POST', '/api/payroll/approval/2026-09/approve', {});
  INFO('PAY-08', 'Superadmin can submit and approve the same month (segregation of duties)', `submit ${stage.status}, approve ${stage2.status}`);
}

// ================= NEW FEATURES =================
area = 'Recent features';
{
  for (const p of ['/api/measurement-sheets', '/api/mpr-dispatch', '/api/dispatch-material']) { const r = await api(B.token, 'GET', p); INFO('NEW-01', `Employee asks for ${p}`, J(r)); }
}
fs.writeFileSync('./hr-review.json', JSON.stringify(R, null, 1));
const c = (s) => R.filter((r) => r.status === s).length;
console.log(`\n${c('PASS')} passed, ${c('FAIL')} failed, ${c('INFO')} observations`);
