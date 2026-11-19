// A Transfer moves PEPM projects, Remote Attendance check-in and the department
// team with the person on the effective date (HROperationsRoutes.ts,
// transferAccessPlan / applyTransferAccess). Project -> project and
// project -> Head Office (no linked project; HR gives one by hand).
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, tok, body) => { const r = await fetch(B + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { code: r.status, body: j }; };
const login = async (email) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'ProbePass123' }) })).json()).token;
const admin = await login('admin@credence.test');
const today = sql("SELECT DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+06:00'))");

// projects, branches linked to them, a Head Office with none
for (const p of ['QA Anamika', 'QA Rupayan', 'QA Central Inventory', 'QA Gulshan']) sql(`INSERT IGNORE INTO projects (project_name) VALUES ('${p}')`);
const pid = (n) => Number(sql(`SELECT id FROM projects WHERE project_name='${n}'`));
const br = (name, proj) => {
  sql(`INSERT IGNORE INTO branches (branch_name, project_id, company_id) VALUES ('${name}', ${proj ? pid(proj) : 'NULL'}, 1)`);
  sql(`UPDATE branches SET project_id=${proj ? pid(proj) : 'NULL'} WHERE branch_name='${name}'`);
  return Number(sql(`SELECT id FROM branches WHERE branch_name='${name}'`));
};
const bAna = br('QA Anamika Site', 'QA Anamika'), bRup = br('QA Rupayan Site', 'QA Rupayan'), bHO = br('QA Head Office', null);
// a team that takes people at the Rupayan site
const dept = Number(sql("SELECT id FROM departments ORDER BY id LIMIT 1"));
sql(`DELETE FROM department_teams WHERE name IN ('QA Rupayan Site Team','QA Anamika Site Team')`);
sql(`INSERT INTO department_teams (department_id, name) VALUES (${dept}, 'QA Anamika Site Team'), (${dept}, 'QA Rupayan Site Team')`);
const tAna = Number(sql("SELECT id FROM department_teams WHERE name='QA Anamika Site Team'")), tRup = Number(sql("SELECT id FROM department_teams WHERE name='QA Rupayan Site Team'"));
sql(`INSERT INTO department_team_auto (team_id, branch, department_id) VALUES (${tRup}, 'QA Rupayan Site', NULL)`);

// the person: an employee with a login at the Anamika site
const tag = Date.now().toString(36);
sql(`INSERT INTO users (name, email, password_hash, role) SELECT 'QA Mover ${tag}', 'mover.${tag}@credence.test', password_hash, 'user' FROM users WHERE email='admin@credence.test'`);
const uid = Number(sql(`SELECT id FROM users WHERE email='mover.${tag}@credence.test'`));
sql(`INSERT INTO all_employees (name, employee_id, user_id, branch_id, branch, department_id, company_id, is_active, joining_date) VALUES ('QA Mover ${tag}', 'MV-${tag}', ${uid}, ${bAna}, 'QA Anamika Site', ${dept}, 1, 1, '2025-01-01')`);
const emp = Number(sql(`SELECT id FROM all_employees WHERE employee_id='MV-${tag}'`));
sql(`INSERT INTO user_project_permissions (user_id, project_id) VALUES (${uid}, ${pid('QA Anamika')}), (${uid}, ${pid('QA Central Inventory')})`);
sql(`INSERT INTO user_attendance_projects (user_id, project_id, valid_from) VALUES (${uid}, ${pid('QA Anamika')}, '2025-01-01')`);
sql(`INSERT INTO department_team_members (team_id, employee_id) VALUES (${tAna}, ${emp})`);

// 1. the plan (preview)
const eff = today;
let plan = (await call('POST', '/api/hr-ops/actions/transfer-plan', admin, { employee_id: emp, branch_id: bRup, effective_date: eff })).body;
ok(plan.from_project?.name === 'QA Anamika' && plan.to_project?.name === 'QA Rupayan', 'plan: from QA Anamika to QA Rupayan (branch-linked projects)');
ok(plan.pepm.remove.map((p) => p.name).join() === 'QA Anamika' && plan.pepm.add.map((p) => p.name).join() === 'QA Rupayan' && plan.pepm.keep.some((p) => p.name === 'QA Central Inventory'), 'plan: PEPM Anamika off, Rupayan on, Central Inventory stays');
ok(plan.attendance.end[0]?.name === 'QA Anamika' && plan.attendance.start[0]?.name === 'QA Rupayan' && plan.attendance.start[0]?.valid_from === eff, 'plan: check-in Anamika ends the day before, Rupayan from the day');
ok(plan.team.from?.name === 'QA Anamika Site Team' && plan.team.to?.name === 'QA Rupayan Site Team', 'plan: team Anamika Site → Rupayan Site');
let ho = (await call('POST', '/api/hr-ops/actions/transfer-plan', admin, { employee_id: emp, branch_id: bHO, effective_date: eff })).body;
ok(ho.to_project === null && ho.pepm.add.length === 0 && ho.pepm.remove[0]?.name === 'QA Anamika' && ho.attendance.start.length === 0, 'plan to Head Office: no project comes in, Anamika goes');

// 2. transfer to Rupayan, today, approved
const approveAll = async (id) => { for (let i = 0; i < 6; i++) { const a = (await call('POST', `/api/hr-ops/actions/${id}/decision`, admin, { decision: 'approved' })); if (a.code !== 200) break; if (sql(`SELECT status FROM hr_actions WHERE id=${id}`) === 'approved') break; } };
let c = await call('POST', '/api/hr-ops/actions', admin, { employee_id: emp, action_type: 'transfer', effective_date: eff, to: { branch_id: bRup, access: { pepm: true, attendance: true, team: true, extra_project_ids: [] } }, reason: 'QA move' });
ok(c.code === 200 && c.body.id, 'transfer created');
await approveAll(c.body.id);
ok(sql(`SELECT status FROM hr_actions WHERE id=${c.body.id}`) === 'approved', 'transfer approved');
const projs = () => sql(`SELECT GROUP_CONCAT(p.project_name ORDER BY p.project_name) FROM user_project_permissions u JOIN projects p ON p.id=u.project_id WHERE u.user_id=${uid}`);
ok(projs() === 'QA Central Inventory,QA Rupayan', 'PEPM now Central Inventory + Rupayan (' + projs() + ')');
ok(sql(`SELECT valid_to FROM user_attendance_projects WHERE user_id=${uid} AND project_id=${pid('QA Anamika')}`) === sql(`SELECT DATE_SUB('${eff}', INTERVAL 1 DAY)`), 'check-in at Anamika ends the day before');
ok(sql(`SELECT valid_from FROM user_attendance_projects WHERE user_id=${uid} AND project_id=${pid('QA Rupayan')}`) === eff, 'check-in at Rupayan from the day');
ok(Number(sql(`SELECT team_id FROM department_team_members WHERE employee_id=${emp}`)) === tRup, 'now in the Rupayan Site Team');
ok(sql(`SELECT branch FROM all_employees WHERE id=${emp}`) === 'QA Rupayan Site', 'branch moved');
ok(/access_moved/.test(sql(`SELECT history_json FROM hr_actions WHERE id=${c.body.id}`)), 'what moved is written in the action history');

// 3. then to Head Office, PEPM on but attendance and team left out, HR gives QA Gulshan by hand
c = await call('POST', '/api/hr-ops/actions', admin, { employee_id: emp, action_type: 'transfer', effective_date: eff, to: { branch_id: bHO, access: { pepm: true, attendance: false, team: false, extra_project_ids: [pid('QA Gulshan')] } }, reason: 'QA to HO' });
await approveAll(c.body.id);
ok(projs() === 'QA Central Inventory,QA Gulshan', 'Head Office: Rupayan off, nothing linked comes in, HR-picked Gulshan given (' + projs() + ')');
ok(sql(`SELECT valid_to IS NULL FROM user_attendance_projects WHERE user_id=${uid} AND project_id=${pid('QA Rupayan')}`) === '1', 'attendance left as it was (unticked)');
ok(Number(sql(`SELECT team_id FROM department_team_members WHERE employee_id=${emp}`)) === tRup, 'team left as it was (unticked)');

// 4. a future transfer waits for its day
const future = sql(`SELECT DATE_ADD('${eff}', INTERVAL 10 DAY)`);
c = await call('POST', '/api/hr-ops/actions', admin, { employee_id: emp, action_type: 'transfer', effective_date: future, to: { branch_id: bAna, access: { pepm: true, attendance: true, team: true, extra_project_ids: [] } }, reason: 'QA future' });
await approveAll(c.body.id);
ok(projs() === 'QA Central Inventory,QA Gulshan', 'a future-dated transfer changes nothing yet');
ok((await call('POST', '/api/hr-ops/actions/transfer-plan', await login(sql("SELECT email FROM users WHERE email LIKE 'qa.share.rahim%' LIMIT 1")), { employee_id: emp, branch_id: bRup })).code === 403, 'a plain user cannot read the plan');
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
