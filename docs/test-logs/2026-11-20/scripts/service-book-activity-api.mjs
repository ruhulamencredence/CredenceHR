// Service Book: the Login & Access log (every change to a login, written by one
// middleware), the extra timeline events, "More activity", and that nothing
// else changed (failed requests log nothing, the password never lands in the
// log, the official service history and My Service Book are untouched).
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>&1`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, tok, body) => { const r = await fetch(B + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { code: r.status, body: j }; };
const login = async (email, password) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = await login('admin@credence.test', 'ProbePass123');
const tag = Date.now().toString(36);
const logs = (uid) => Number(sql(`SELECT COUNT(*) FROM user_access_log WHERE user_id=${uid}`));

// An Employee without a login gets one.
const free = (await call('GET', '/api/users/employees-without-login', admin)).body;
const emp = free[0];
ok(!!emp, 'an employee without a login to test with');
const before360 = (await call('GET', `/api/hr-ops/p360/${emp.id}`, admin)).body;
let r = await call('POST', '/api/users', admin, { name: emp.name, email: `sb.${tag}@credence.test`, password: 'QaPass#2026x', employee_id: emp.id });
const uid = r.body.id;
await wait(400);
ok(r.code === 200 && sql(`SELECT action FROM user_access_log WHERE user_id=${uid} ORDER BY id LIMIT 1`) === 'Login created', 'a new login is written as "Login created"');
ok(sql(`SELECT employee_id FROM user_access_log WHERE user_id=${uid} LIMIT 1`) === String(emp.id), 'the row is tied to the Employee too');

// Mobile App, projects, block / unblock, password.
const appWas = sql(`SELECT can_use_app FROM users WHERE id=${uid}`);
r = await call('PUT', `/api/users/${uid}/app-access`, admin, { can_use_app: appWas !== '1' });
await wait(400);
const appRow = JSON.parse(sql(`SELECT changes_json FROM user_access_log WHERE user_id=${uid} AND action='Mobile App' ORDER BY id DESC LIMIT 1`) || '[]');
ok(r.code === 200 && appRow.some((c) => c.what === 'Mobile App' && c.to === (appWas === '1' ? 'Off' : 'On')), 'Mobile App: Off → On written with who did it');
ok(sql(`SELECT actor_name IS NOT NULL FROM user_access_log WHERE user_id=${uid} AND action='Mobile App' LIMIT 1`) === '1', '…and the name of who did it');

const projects = sql('SELECT id FROM projects ORDER BY id LIMIT 2').split('\n').map(Number);
const pname = sql(`SELECT project_name FROM projects WHERE id=${projects[0]}`);
r = await call('PUT', `/api/users/${uid}/projects`, admin, { project_ids: projects });
await wait(400);
r = await call('PUT', `/api/users/${uid}/projects`, admin, { project_ids: [projects[1]] });
await wait(400);
const pj = sql(`SELECT changes_json FROM user_access_log WHERE user_id=${uid} AND action='Project Access' ORDER BY id`).split('\n').map((x) => JSON.parse(x));
ok(pj.length === 2 && pj[0][0].added.includes(pname) && pj[1][0].removed.includes(pname) && !pj[1][0].added.length, 'Project Access: given, then taken away, by name');

const nBad = logs(uid);
r = await call('PUT', `/api/users/${uid}/block`, admin, { blocked: true }); // no reason → 400
await wait(400);
ok(r.code === 400 && logs(uid) === nBad, 'a refused request writes nothing');
r = await call('PUT', `/api/users/${uid}/block`, admin, { blocked: true, reason: 'QA test' });
await wait(400);
r = await call('PUT', `/api/users/${uid}/block`, admin, { blocked: false });
await wait(400);
const bl = sql(`SELECT changes_json FROM user_access_log WHERE user_id=${uid} AND action='Block / Unblock' ORDER BY id`).split('\n').map((x) => JSON.parse(x));
ok(bl.length === 2 && bl[0].some((c) => c.what === 'Login' && c.to === 'Blocked') && bl[0].some((c) => c.what === 'Block reason' && c.to === 'QA test') && bl[1].some((c) => c.to === 'Open'), 'Block (with reason) and Unblock both written');

const hash = sql(`SELECT password_hash FROM users WHERE id=${uid}`);
r = await call('PUT', `/api/users/${uid}/reset-password`, admin, { new_password: 'QaPass#2026y' });
await wait(400);
const pw = sql(`SELECT changes_json FROM user_access_log WHERE user_id=${uid} AND action='Password reset' ORDER BY id DESC LIMIT 1`);
ok(r.code === 200 && /"Password"/.test(pw) && /Reset/.test(pw), 'password reset written as "Reset"');
ok(!sql(`SELECT GROUP_CONCAT(changes_json) FROM user_access_log WHERE user_id=${uid}`).includes(hash.slice(7, 30)) && !/\$2[aby]\$/.test(sql(`SELECT GROUP_CONCAT(changes_json) FROM user_access_log`)), 'no password hash anywhere in the log');

r = await call('PUT', `/api/users/${uid}/module-permissions`, admin, { modules: ['hr_operations'] });
await wait(400);
ok(/Module access/.test(sql(`SELECT changes_json FROM user_access_log WHERE user_id=${uid} AND action='Module Access' ORDER BY id DESC LIMIT 1`)), 'Module Access change written');
r = await call('PUT', `/api/users/${uid}/tasks-access`, admin, { can_view_tasks: true });
await wait(400);
ok(/Tasks/.test(sql(`SELECT changes_json FROM user_access_log WHERE user_id=${uid} AND action='Tasks access' ORDER BY id DESC LIMIT 1`)), 'a Self Service switch (My Tasks) written');
const nSame = logs(uid);
r = await call('PUT', `/api/users/${uid}/tasks-access`, admin, { can_view_tasks: true });
await wait(400);
ok(r.code === 200 && logs(uid) === nSame, 'saving with nothing changed writes nothing');

// Timeline, More activity, Login & Access.
r = await call('GET', `/api/hr-ops/p360/${emp.id}/activity`, admin);
const titles = (r.body.events || []).map((e) => e.title);
ok(r.code === 200 && titles.includes('Login created') && titles.includes('PEPM project given') && titles.includes('PEPM project taken away') && titles.includes('Login blocked') && titles.includes('Password reset'), 'timeline gets login, PEPM and block events (' + titles.join(', ') + ')');
ok(r.body.can_access_log === true, 'Superadmin may see Login & Access');
r = await call('GET', `/api/hr-ops/p360/${emp.id}/access-log`, admin);
ok(r.code === 200 && r.body.rows.length === logs(uid) && r.body.rows[0].by && r.body.recording_since, 'Login & Access lists every row, newest first, with who and since when');
sql(`INSERT INTO grievances (raised_by, category, description, is_anonymous, status, company_id) VALUES (${uid}, 'QA anon', 'x', 1, 'open', 1)`);
r = await call('GET', `/api/hr-ops/p360/${emp.id}/more`, admin);
const keys = (r.body.boxes || []).map((b) => b.key);
const g = (r.body.boxes || []).find((b) => b.key === 'grievance');
ok(r.code === 200 && ['mobile_bill', 'vehicle', 'asset_requisitions', 'grievance', 'tasks', 'exit'].every((k) => keys.includes(k)), 'More activity: every box for the Superadmin (' + keys.join(', ') + ')');
ok(g && !g.rows.some((x) => /QA anon/.test(x.label)), 'an anonymous grievance is never tied to the person');

// History from before this log: the older Users -> Activity rows (what was sent).
sql(`INSERT INTO user_access_audit (target_user_id, actor_user_id, action, detail, created_at) VALUES (${uid}, NULL, 'projects', '{"project_ids":[${projects[0]}]}', '2025-01-05 10:00:00'), (${uid}, NULL, 'block', '{"blocked":true,"reason":"Old QA block"}', '2025-01-06 10:00:00')`);
r = await call('GET', `/api/hr-ops/p360/${emp.id}/access-log`, admin);
const older = r.body.rows.filter((x) => x.source === 'older');
ok(older.length === 2 && older.some((x) => x.changes[0].text.includes(pname)) && older.some((x) => /Old QA block/.test(x.changes[0].text)), 'older Users → Activity rows shown, project ids as names');
ok(r.body.rows.filter((x) => x.source !== 'older').length === logs(uid), 'newer changes are not shown twice');
r = await call('GET', `/api/hr-ops/p360/${emp.id}/activity`, admin);
ok(r.body.events.some((e) => e.date === '2025-01-06' && e.title === 'Login blocked'), 'an older block shows in the timeline too');

// The official history and My Service Book are unchanged.
const after360 = (await call('GET', `/api/hr-ops/p360/${emp.id}`, admin)).body;
ok(JSON.stringify(after360.events.map((e) => e.kind)) === JSON.stringify(before360.events.map((e) => e.kind)), 'the official service history (and its PDF) did not change');

// A plain HR account: More activity yes, Login & Access only with its own layer.
sql(`UPDATE users SET must_change_password=0, role='user' WHERE id=${uid}`);
const hr = await login(`sb.${tag}@credence.test`, 'QaPass#2026y');
r = await call('GET', `/api/hr-ops/p360/${emp.id}/activity`, hr);
ok(r.code === 200 && r.body.can_access_log === false, 'HR Operations alone: timeline yes, Login & Access no');
r = await call('GET', `/api/hr-ops/p360/${emp.id}/access-log`, hr);
ok(r.code === 403, 'Login & Access API refused without the layer');
r = await call('GET', `/api/hr-ops/p360/${emp.id}/more`, hr);
ok(r.code === 200 && r.body.boxes.length === 0, 'More activity shows no box for modules they don\'t hold');
await call('PUT', `/api/users/${uid}/module-permission-layers`, admin, { module: 'hr_operations', layers: ['read', 'p360_access'] });
r = await call('GET', `/api/hr-ops/p360/${emp.id}/access-log`, hr);
ok(r.code === 200, 'with "Service Book — Login & Access log" ticked it opens');

// Clean up the test login (its log rows go with the test).
sql(`DELETE FROM grievances WHERE category='QA anon'; DELETE FROM user_access_audit WHERE target_user_id=${uid}; DELETE FROM user_access_log WHERE user_id=${uid}; UPDATE all_employees SET user_id=NULL WHERE id=${emp.id}; DELETE FROM users WHERE id=${uid}`);
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
