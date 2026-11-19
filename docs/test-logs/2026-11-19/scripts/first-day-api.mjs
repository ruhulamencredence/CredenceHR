// Onboarding checklist — first-day steps: the three new items exist, tick
// themselves when done (PEPM projects, Mobile App, department team), the
// first-day endpoint says what is set and what this account may do.
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, tok, body) => { const r = await fetch(B + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { code: r.status, body: j }; };
const login = async (email) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'ProbePass123' }) })).json()).token;
const admin = await login('admin@credence.test');

// the newest approved joiner (from joiner-letter-api.mjs)
const emp = Number(sql("SELECT employee_id FROM onboarding_applications WHERE status='approved' AND name LIKE 'Letter Joiner %' ORDER BY id DESC LIMIT 1"));
ok(emp > 0, 'an approved joiner exists (Employee ' + emp + ')');
const user = Number(sql(`SELECT user_id FROM all_employees WHERE id=${emp}`));
const keys = sql(`SELECT GROUP_CONCAT(task_key) FROM hr_onboarding_items WHERE employee_id=${emp}`);
ok(/pepm_projects/.test(keys) && /mobile_app/.test(keys) && /dept_team/.test(keys), 'checklist has the first-day items');

sql(`DELETE FROM user_project_permissions WHERE user_id=${user}`);
sql(`UPDATE users SET can_use_app=0 WHERE id=${user}`);
sql(`UPDATE hr_onboarding_items SET status='pending', note=NULL, value_text=NULL WHERE employee_id=${emp} AND task_key IN ('pepm_projects','mobile_app')`);
let fd = (await call('GET', `/api/hr-ops/onboarding/${emp}/first-day`, admin)).body;
ok(fd && fd.user_id === user && fd.projects.length === 0 && fd.app_on === false, 'first-day: no projects, app off');
ok(fd.can.projects && fd.can.mobile_app && fd.can.sim && fd.can.id_card && fd.can.team, 'Superadmin may do every step');

// give a project through the same API the checklist button uses
const pid = Number(sql("SELECT id FROM projects WHERE project_name='QA Anamika'"));
ok((await call('PUT', `/api/users/${user}/projects`, admin, { project_ids: [pid] })).code === 200, 'Give projects saves through /api/users/:id/projects');
ok((await call('PUT', `/api/users/${user}/app-access`, admin, { can_use_app: true })).code === 200, 'Turn on Mobile App through /api/users/:id/app-access');
const items = (await call('GET', `/api/hr-ops/onboarding/${emp}`, admin)).body;
const it = (k) => items.find((i) => i.task_key === k);
ok(it('pepm_projects').status === 'done' && /QA Anamika/.test(it('pepm_projects').value_text), 'PEPM projects item ticks itself, with the project');
ok(it('mobile_app').status === 'done', 'Mobile App item ticks itself');

// a plain user can't use the endpoint
const pu = sql("SELECT email FROM users WHERE email LIKE 'qa.share.rahim%' LIMIT 1");
if (pu) ok((await call('GET', `/api/hr-ops/onboarding/${emp}/first-day`, await login(pu))).code === 403, 'a plain user gets 403');
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
