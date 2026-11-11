// Head of Department + teams, end to end on the test server (:3200).
// Finance: Accounts team (Supervisor Imran) = Sadia, Rafiq, Imran; Treasury
// team (Supervisor Farhana) = nobody yet; Head = Tahmid; Kamal in no team.
// The Timesheet template: Layer 1 Nasrin, Layer 2 Kamal.
import { execSync } from 'node:child_process';
const B = 'http://127.0.0.1:3200';
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
const login = async (id) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: id, password: 'ProbePass123', workspace: 'credence' }) })).json()).token;
const H = (t) => ({ 'content-type': 'application/json', authorization: 'Bearer ' + t });
const call = async (t, method, p, body) => { const r = await fetch(B + p, { method, headers: H(t), body: body === undefined ? undefined : JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => null) }; };
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const sa = await login('admin@credence.test');
const [kamal, imran, tahmid, farhana, nasrin, rafiq, sadia] = await Promise.all(
  ['kamal.uddin', 'imran.hossain', 'tahmid.rahman', 'farhana.r', 'nasrin.sultana', 'rafiq.ahmed', 'sadia.karim'].map((u) => login(`${u}@credence.test`))
);
ok('logins', [sa, kamal, imran, tahmid, farhana, nasrin, rafiq, sadia].every(Boolean));
const proj = sql('SELECT id FROM projects ORDER BY id LIMIT 1');
for (const [uid, d] of [[138, '2026-11-03'], [138, '2026-11-04'], [138, '2026-11-05'], [140, '2026-11-06'], [136, '2026-11-06'], [135, '2026-11-06'], [137, '2026-11-06']]) {
  if (!sql(`SELECT id FROM attendance WHERE user_id = ${uid} AND attendance_date = '${d}' LIMIT 1`)) sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at) VALUES (${uid}, ${proj}, '${d}', '${d} 09:05:00')`);
}
const correct = async (t, d) => (await call(t, 'POST', '/api/attendance/corrections', { project_id: Number(proj), attendance_date: d, check_out_at: `${d} 18:30`, remarks: 'test' })).j;
const reqOf = (uid, d) => sql(`SELECT CONCAT_WS('|', ar.id, IFNULL(ar.supervisor_step_user_id,'-'), IFNULL(ar.head_step_user_id,'-'), ar.current_step, ar.total_steps, ar.status) FROM approval_requests ar JOIN attendance_corrections c ON c.id = ar.source_id WHERE ar.source_type = 'attendance_correction' AND c.user_id = ${uid} AND c.attendance_date = '${d}' ORDER BY ar.id DESC LIMIT 1`).split('|');
const act = (t, id, action = 'approved') => call(t, 'POST', `/api/my-approvals/${id}/act`, { action });
const mine = async (t) => ((await get(t, '/api/my-approvals')).j || []).map((x) => Number(x.approval_id ?? x.id));
const get = (t, p) => call(t, 'GET', p);

console.log('\n— 1. Who may set it up');
ok('Kamal (no Departments module) cannot read teams', (await get(kamal, '/api/departments/1/teams')).s === 403);
ok('Kamal cannot save teams', (await call(kamal, 'PUT', '/api/departments/1/teams', { head_user_id: 140, teams: [] })).s === 403);

console.log('\n— 2. Saving Head + teams (checks)');
const base = { head_user_id: 135, teams: [{ name: 'Accounts', supervisor_user_id: 136, member_ids: [47, 48, 46] }, { name: 'Treasury', supervisor_user_id: 131, member_ids: [] }] };
ok('a person in two teams is refused', (await call(sa, 'PUT', '/api/departments/1/teams', { ...base, teams: [base.teams[0], { ...base.teams[1], member_ids: [48] }] })).s === 400);
ok('someone from another Department is refused', (await call(sa, 'PUT', '/api/departments/1/teams', { ...base, teams: [{ ...base.teams[0], member_ids: [49] }] })).s === 400);
ok('a team without a Supervisor is refused', (await call(sa, 'PUT', '/api/departments/1/teams', { ...base, teams: [{ name: 'X', member_ids: [] }] })).s === 400);
ok('two "everyone else" teams refused', (await call(sa, 'PUT', '/api/departments/1/teams', { ...base, teams: base.teams.map((t) => ({ ...t, everyone_else: true })) })).s === 400);
ok('Head + 2 teams saved', (await call(sa, 'PUT', '/api/departments/1/teams', base)).s === 200);
const t = (await get(sa, '/api/departments/1/teams')).j;
ok('read back: Head Tahmid, Accounts 3 people, Kamal and Farhana in no team', t.department.head_user_id === 135 && t.teams.find((x) => x.name === 'Accounts').member_ids.length === 3 && t.no_team.map((x) => x.id).sort().join() === '36,45,50', JSON.stringify(t.no_team));
const list = (await get(kamal, '/api/departments')).j.find((d) => d.id === 1);
ok('Departments list shows Head and teams (any account)', list.head_name && list.teams.length === 2 && list.teams.find((x) => x.name === 'Accounts').members === 3, JSON.stringify(list).slice(0, 200));

console.log('\n— 3. A team member: own team Supervisor -> Head -> workflow');
await correct(rafiq, '2026-11-03');
let [id, sup, head, step, total] = reqOf(138, '2026-11-03');
ok('Rafiq: step 1 Imran (his team), step 2 Head Tahmid, then 2 template layers', sup === '136' && head === '135' && step === '1' && total === '4', [sup, head, step, total].join());
ok('Farhana (another team\'s Supervisor) does not see it', !(await mine(farhana)).includes(Number(id)));
ok('Farhana cannot approve it', (await act(farhana, id)).s === 403);
ok('Tahmid (Head) cannot jump ahead', (await act(tahmid, id)).s === 403);
ok('Imran sees it', (await mine(imran)).includes(Number(id)));
ok('Imran approves -> step 2', (await act(imran, id)).s === 200 && reqOf(138, '2026-11-03')[3] === '2');
ok('now Tahmid sees it, Imran not', (await mine(tahmid)).includes(Number(id)) && !(await mine(imran)).includes(Number(id)));
ok('Tahmid approves -> step 3 (template Layer 1, Nasrin)', (await act(tahmid, id)).s === 200 && reqOf(138, '2026-11-03')[3] === '3');
ok('Nasrin approves -> step 4 (Kamal)', (await act(nasrin, id)).s === 200 && reqOf(138, '2026-11-03')[3] === '4');
ok('Kamal approves -> done', (await act(kamal, id)).s === 200 && reqOf(138, '2026-11-03')[5] === 'approved');

console.log('\n— 4. Other cases');
await correct(kamal, '2026-11-06');
[id, sup, head, step, total] = reqOf(140, '2026-11-06');
ok('Kamal in no team: Head first, then the workflow', sup === '-' && head === '135' && total === '3', [sup, head, total].join());
await correct(imran, '2026-11-06');
[id, sup, head, step, total] = reqOf(136, '2026-11-06');
ok('Imran (his own team\'s Supervisor) asks: Head first', sup === '-' && head === '135' && total === '3', [sup, head, total].join());
await correct(tahmid, '2026-11-06');
[id, sup, head, step, total] = reqOf(135, '2026-11-06');
ok('Tahmid (the Head) asks: straight to the workflow', sup === '-' && head === '-' && total === '2', [sup, head, total].join());
sql('INSERT INTO employee_supervisors (employee_id, supervisor_id, effective_date, is_direct) VALUES (48, 50, "2026-01-01", 1)');
await correct(rafiq, '2026-11-04');
[id, sup, head] = reqOf(138, '2026-11-04');
ok('a Direct Supervisor still comes first (Kamal), then the Head', sup === '140' && head === '135', [sup, head].join());
sql('DELETE FROM employee_supervisors WHERE employee_id = 48');

console.log('\n— 5. Changes move waiting requests');
await correct(rafiq, '2026-11-05');
[id] = reqOf(138, '2026-11-05');
ok('waiting on Imran', reqOf(138, '2026-11-05')[1] === '136');
await call(sa, 'PUT', '/api/departments/1/teams', { ...base, teams: [{ ...base.teams[0], member_ids: [47, 46] }, { ...base.teams[1], member_ids: [48] }] });
await wait(4000);
ok('Rafiq moved to Treasury: his request now waits on Farhana', reqOf(138, '2026-11-05')[1] === '131', reqOf(138, '2026-11-05').join());
ok('Farhana approves', (await act(farhana, id)).s === 200 && reqOf(138, '2026-11-05')[3] === '2');
await call(sa, 'PUT', '/api/departments/1/teams', { ...base, head_user_id: 139, teams: [{ ...base.teams[0], member_ids: [47, 46] }, { ...base.teams[1], member_ids: [48] }] });
await wait(4000);
ok('new Head (Nasrin): the waiting Head step moves to her', reqOf(138, '2026-11-05')[2] === '139', reqOf(138, '2026-11-05').join());
await call(sa, 'PUT', '/api/departments/1/teams', { ...base, head_user_id: null, teams: [{ ...base.teams[0], member_ids: [47, 46] }, { ...base.teams[1], member_ids: [48] }] });
await wait(4000);
const after = reqOf(138, '2026-11-05');
ok('no Head any more: on to the template Layer 1 (step 2 of 3)', after[2] === '-' && after[3] === '2' && after[4] === '3', after.join());
ok('Nasrin (template Layer 1) now sees it', (await mine(nasrin)).includes(Number(id)));

console.log('\n— 6. "Everyone else" team');
await call(sa, 'PUT', '/api/departments/1/teams', { head_user_id: 135, teams: [{ name: 'Accounts', supervisor_user_id: 136, member_ids: [47, 46, 48] }, { name: 'Treasury', supervisor_user_id: 131, member_ids: [], everyone_else: true }] });
await correct(sadia, '2026-11-06');
ok('Sadia (Accounts) -> Imran', reqOf(137, '2026-11-06')[1] === '136');
sql("DELETE FROM approval_requests WHERE source_type = 'attendance_correction' AND requested_by = 140");
sql('DELETE FROM attendance_corrections WHERE user_id = 140');
await correct(kamal, '2026-11-06');
ok('Kamal (in no team) now goes to the "everyone else" team (Farhana), then the Head', reqOf(140, '2026-11-06')[1] === '131' && reqOf(140, '2026-11-06')[2] === '135', reqOf(140, '2026-11-06').join());
const tt = (await get(sa, '/api/departments/1/teams')).j;
ok('nobody shown as "in no team" when there is an everyone-else team', tt.no_team.length === 0);

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
