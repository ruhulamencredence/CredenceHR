// Deleting a login with work behind it is refused (API and database); one made by
// mistake still goes; Block login keeps everything.
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>&1`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, tok, body) => { const r = await fetch(B + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { code: r.status, body: j }; };
const admin = (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json()).token;
const tag = Date.now().toString(36);
const mk = async (who) => (await call('POST', '/api/users', admin, { name: `QA ${who} ${tag}`, email: `${who}.${tag}@credence.test`, password: 'QaPass#2026x', non_employee_reason: 'QA test account' })).body.id;

ok(sql("SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='attendance' AND REFERENCED_TABLE_NAME='users' LIMIT 1") === 'RESTRICT', 'database: attendance → users is RESTRICT now');
ok(sql("SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='users' AND DELETE_RULE='CASCADE' AND TABLE_NAME IN ('attendance','bill_claims','claims','final_settlements','tasks','chat_messages','employee_documents')") === '0', 'database: none of the kept tables cascade any more');

const worker = await mk('worker');
sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at) SELECT ${worker}, (SELECT MIN(id) FROM projects), d, CONCAT(d, ' 09:00:00') FROM (SELECT '2026-11-01' AS d UNION SELECT '2026-11-02') x`);
let r = await call('DELETE', `/api/users/${worker}`, admin);
ok(r.code === 409 && /2 attendance days/.test(r.body.error) && /Block login/.test(r.body.error), 'a login with attendance is refused, with the count and Block login (' + (r.body && r.body.error) + ')');
ok(sql(`SELECT COUNT(*) FROM users WHERE id=${worker}`) === '1' && sql(`SELECT COUNT(*) FROM attendance WHERE user_id=${worker}`) === '2', 'login and attendance both still there');
let direct = ''; try { direct = sql(`DELETE FROM users WHERE id=${worker}`); } catch (e) { direct = String(e.stdout || '') + String(e.message || ''); }
ok(/1451|foreign key constraint fails/i.test(direct) && sql(`SELECT COUNT(*) FROM attendance WHERE user_id=${worker}`) === '2', 'a delete straight in the database is refused too');

const mistake = await mk('mistake');
sql(`INSERT INTO user_project_permissions (user_id, project_id) SELECT ${mistake}, id FROM projects LIMIT 1`);
r = await call('DELETE', `/api/users/${mistake}`, admin);
ok(r.code === 200 && sql(`SELECT COUNT(*) FROM users WHERE id=${mistake}`) === '0', 'a login made by mistake (only settings) is still deleted');

r = await call('PUT', `/api/users/${worker}/block`, admin, { blocked: true, reason: 'Left the company' });
ok(r.code === 200 && sql(`SELECT is_blocked FROM users WHERE id=${worker}`) === '1' && sql(`SELECT COUNT(*) FROM attendance WHERE user_id=${worker}`) === '2', 'Block login works and keeps the records');
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
