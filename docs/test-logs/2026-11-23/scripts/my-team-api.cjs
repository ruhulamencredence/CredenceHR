// Self Service -> My Team API: who is under a Head of Department, a team
// Supervisor and a Direct Supervisor; today's status; one person's details;
// nobody outside the team, nobody who left; no access for anyone else.
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Team#2026pass';
const api = async (t, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
  sql(`INSERT INTO departments (name, is_active, company_id) VALUES ('TeamDept ${tag}', 1, 1), ('OtherDept ${tag}', 1, 1)`);
  const D = Number(sql(`SELECT id FROM departments WHERE name='TeamDept ${tag}'`)), D2 = Number(sql(`SELECT id FROM departments WHERE name='OtherDept ${tag}'`));
  const person = async (name, dept, login = true) => {
    const email = `${name.toLowerCase()}.${tag}@credence.test`;
    const e = await api(SA, 'POST', '/api/employees', { name: `${name} ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, ...(login ? { create_login: true, login_email: email, login_password: PASS } : {}) });
    const id = e.b.id; const uid = Number(sql(`SELECT IFNULL(user_id,0) FROM all_employees WHERE id=${id}`)) || null;
    if (uid) sql(`UPDATE users SET must_change_password=0 WHERE id=${uid}`);
    return { id, uid, email };
  };
  const H = await person('Head', D2), S = await person('Sup', D2), X = await person('Direct', D2), O = await person('Outsider', D2);
  const P1 = await person('Early', D), P2 = await person('Late', D), P3 = await person('Leaver', D), P4 = await person('Quit', D), P5 = await person('Nologin', D, false);
  const Q1 = await person('Teamed', D2), Q2 = await person('Reportee', D2), Q3 = await person('Elsewhere', D2);
  sql(`UPDATE departments SET head_user_id=${H.uid} WHERE id=${D}`);
  sql(`UPDATE all_employees SET job_status='resigned' WHERE id=${P4.id}`);
  // Team of S: Q1 by name (from another Department) and P2 in it; an "everyone else" team of D too.
  sql(`INSERT INTO department_teams (department_id, name, supervisor_user_id, everyone_else, is_active) VALUES (${D2}, 'Crew ${tag}', ${S.uid}, 0, 1)`);
  const T = Number(sql(`SELECT id FROM department_teams WHERE name='Crew ${tag}'`));
  sql(`INSERT INTO department_team_members (team_id, employee_id) VALUES (${T}, ${Q1.id}), (${T}, ${P2.id})`);
  sql(`INSERT INTO employee_supervisors (employee_id, supervisor_id, is_direct) VALUES (${Q2.id}, ${X.id}, 1)`);
  // Today: P1 in at 08:40 (present), P2 in at 11:30 (late), P3 on approved leave.
  const proj = Number(sql('SELECT MIN(id) FROM projects'));
  sql(`INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_lat, check_in_lng) VALUES (${P1.uid}, ${proj}, '${today}', '${today} 08:40:00', 23.8, 90.4), (${P2.uid}, ${proj}, '${today}', '${today} 11:30:00', 23.8, 90.4)`);
  sql(`INSERT INTO leave_applications (user_id, leave_type, start_date, end_date, day_count, purpose, status, apply_date) VALUES (${P3.uid}, 'casual', '${today}', '${today}', 1, 'test', 'approved', '${today}')`);
  const tok = async (x) => (await login(x.email, PASS)).token;
  const [Ht, St, Xt, Ot] = [await tok(H), await tok(S), await tok(X), await tok(O)];
  const names = (r) => (r.b?.people || []).map((p) => p.name.split(' ')[0]).sort().join(',');
  const find = (r, who) => (r.b?.people || []).find((p) => p.id === who.id);

  const h = await api(Ht, 'GET', '/api/my-team');
  ok(h.s === 200 && h.b.has_team, 'Head: has a team');
  ok(names(h) === 'Early,Late,Leaver,Nologin', 'Head: the whole Department — not the one who resigned, nobody from elsewhere: ' + names(h));
  ok(find(h, P1)?.via?.[0]?.kind === 'head' && find(h, P1).via[0].label === `TeamDept ${tag}`, 'Head: shown as "Head of <Department>"');
  ok(find(h, P1)?.today?.status === 'present' && find(h, P1).today.in === '08:40', 'today: P1 present, In 08:40');
  ok(find(h, P2)?.today?.status === 'late', 'today: P2 late (11:30)');
  ok(find(h, P3)?.today?.status === 'leave' && /Casual/.test(find(h, P3).today.leave_type || ''), 'today: P3 on Casual Leave');
  ok(find(h, P5)?.today?.status === 'not_in' && find(h, P5).user_id === null, 'today: the Employee with no login is listed, not in yet');
  ok(h.b.summary.total === 4 && h.b.summary.present === 1 && h.b.summary.late === 1 && h.b.summary.leave === 1, 'summary counts ' + JSON.stringify(h.b.summary));

  const s = await api(St, 'GET', '/api/my-team');
  ok(names(s) === 'Late,Teamed', 'Team Supervisor: their team members, from any Department: ' + names(s));
  ok(find(s, Q1)?.via?.[0]?.kind === 'team' && find(s, Q1).via[0].label === `Crew ${tag}`, 'Team Supervisor: shown with the team name');

  // An "everyone else" team catches the Department's people in no team.
  sql(`UPDATE department_teams SET department_id=${D}, everyone_else=1 WHERE id=${T}`);
  const s2 = await api(St, 'GET', '/api/my-team');
  ok(names(s2) === 'Early,Late,Leaver,Nologin,Teamed', '"Everyone else" team: plus the Department\'s people in no team: ' + names(s2));
  sql(`UPDATE department_teams SET department_id=${D2}, everyone_else=0 WHERE id=${T}`);

  const x = await api(Xt, 'GET', '/api/my-team');
  ok(names(x) === 'Reportee' && find(x, Q2)?.via?.[0]?.label === 'Direct report', 'Direct Supervisor: only the person whose Supervisor tab names them');

  const o = await api(Ot, 'GET', '/api/my-team');
  ok(o.s === 200 && o.b.has_team === false && o.b.people.length === 0, 'someone with nobody under them: no team');
  ok((await api(Ot, 'GET', `/api/my-team/${P1.id}`)).s === 403, 'outsider cannot open a person');
  ok((await api(Ht, 'GET', `/api/my-team/${Q3.id}`)).s === 403, 'Head cannot open someone outside the Department');
  ok((await api(Ht, 'GET', `/api/my-team/${P4.id}`)).s === 403, 'Head cannot open the one who resigned');
  const sa = await api(SA, 'GET', '/api/my-team');
  ok(sa.s === 200 && !find(sa, P1) && !find(sa, Q2), 'Superadmin: only people actually under them, not the whole company');
  ok((await api(SA, 'GET', `/api/my-team/${P1.id}`)).s === 403, 'Superadmin cannot open someone not under them here (Employee 360 is for that)');

  const d = await api(Ht, 'GET', `/api/my-team/${P1.id}`);
  ok(d.s === 200 && d.b.today.status === 'present' && d.b.email === P1.email, 'Head opens P1: today + email');
  ok(d.b.month && d.b.month.present >= 1 && d.b.month.from.endsWith('-01') && typeof d.b.month.absent === 'number', 'P1 this month so far ' + JSON.stringify(d.b.month));
  const d5 = await api(Ht, 'GET', `/api/my-team/${P5.id}`);
  ok(d5.s === 200 && d5.b.month.present === 0 && d5.b.month.absent === null, 'no attendance recorded at all this month: not shown absent every day ' + JSON.stringify(d5.b.month));

  // Losing the role ends it at once.
  sql(`UPDATE departments SET head_user_id=NULL WHERE id=${D}`);
  ok((await api(Ht, 'GET', '/api/my-team')).b?.has_team === false, 'no longer Head: the team is gone at once');
  ok((await api(Ht, 'GET', `/api/my-team/${P1.id}`)).s === 403, 'no longer Head: cannot open P1');

  sql(`UPDATE departments SET is_active=0 WHERE id IN (${D}, ${D2})`);
  sql(`UPDATE department_teams SET is_active=0 WHERE id=${T}`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
