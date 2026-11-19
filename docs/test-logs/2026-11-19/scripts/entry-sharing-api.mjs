// PEPM Entry sharing (PepmTeam.ts): Team / Own entries only / By home project.
// Two home teams (QA Anamika: Rahim + Karim, QA Rupayan: Suman + Jamil) and
// QA Central Inventory that all five (plus Nasima, no other project) work on.
// Run against a dev server: node entry-sharing-api.mjs  (DB via mysql CLI).
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const DB = process.env.DB_NAME || 'admin_ui';
const sql = (q) => execSync(`mysql -h${process.env.DB_HOST || '127.0.0.1'} -u${process.env.DB_USER || 'cred'} -p${process.env.DB_PASSWORD || 'credpass'} ${DB} -N -e ${JSON.stringify(q)}`).toString().trim();
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const login = async (email) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'ProbePass123' }) })).json()).token;

// ---- setup -------------------------------------------------------------
const P = { ana: 'QA Anamika', rup: 'QA Rupayan', ci: 'QA Central Inventory' };
const PEOPLE = { rahim: 'ana', karim: 'ana', suman: 'rup', jamil: 'rup', nasima: null };
sql(`DELETE e FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.project_name LIKE 'QA %' AND p.project_name IN ('${P.ana}','${P.rup}','${P.ci}')`);
sql(`DELETE FROM jobs WHERE job_duration = 'qa-share'`);
sql(`DELETE l FROM budget_project_locks l JOIN budgets b ON b.id = l.budget_id WHERE b.budget_name = 'QA Share Budget'`);
sql(`DELETE s FROM budget_submissions s JOIN budgets b ON b.id = s.budget_id WHERE b.budget_name = 'QA Share Budget'`);
sql(`DELETE bi FROM budget_items bi JOIN budgets b ON b.id = bi.budget_id WHERE b.budget_name = 'QA Share Budget'`);
sql(`DELETE FROM budgets WHERE budget_name = 'QA Share Budget'`);
for (const name of Object.values(P)) sql(`INSERT IGNORE INTO projects (project_name, entry_scope) VALUES ('${name}', 'team')`);
sql(`UPDATE projects SET entry_scope = 'team' WHERE project_name IN ('${P.ana}','${P.rup}','${P.ci}')`);
const pid = {}; for (const [k, name] of Object.entries(P)) pid[k] = Number(sql(`SELECT id FROM projects WHERE project_name = '${name}'`));
const uid = {};
for (const who of Object.keys(PEOPLE)) {
  const email = `qa.share.${who}@credence.test`;
  sql(`INSERT IGNORE INTO users (name, email, password_hash, role) SELECT 'QA ${who}', '${email}', password_hash, 'user' FROM users WHERE email = 'admin@credence.test'`);
  sql(`UPDATE users SET can_view_budget_module = 1, role = 'user', can_job_edit = 0 WHERE email = '${email}'`);
  uid[who] = Number(sql(`SELECT id FROM users WHERE email = '${email}'`));
  sql(`DELETE FROM user_project_permissions WHERE user_id = ${uid[who]}`);
  const own = PEOPLE[who];
  if (own) sql(`INSERT INTO user_project_permissions (user_id, project_id) VALUES (${uid[who]}, ${pid[own]})`);
  sql(`INSERT INTO user_project_permissions (user_id, project_id) VALUES (${uid[who]}, ${pid.ci})`);
}
sql(`INSERT INTO budgets (budget_name, is_published) VALUES ('QA Share Budget', 1)`);
const budgetId = Number(sql(`SELECT id FROM budgets WHERE budget_name = 'QA Share Budget'`));
const items = {};
for (const [i, proj] of [[1, P.ci], [2, P.ci], [3, P.ci], [4, P.ci], [5, P.ci], [6, P.ana], [7, P.ci], [8, P.ci]]) {
  const mrf = `QA-SHR-${i}`;
  sql(`INSERT IGNORE INTO mpr_numbers (mpr_no) VALUES ('${mrf}')`);
  sql(`INSERT INTO budget_items (budget_id, project_name, mrf_no, description, unit, req_qty) VALUES (${budgetId}, '${proj}', '${mrf}', 'QA item ${i}', 'pcs', '100')`);
  items[i] = { mpr_id: Number(sql(`SELECT id FROM mpr_numbers WHERE mpr_no = '${mrf}'`)), budget_item_id: Number(sql(`SELECT id FROM budget_items WHERE budget_id = ${budgetId} AND mrf_no = '${mrf}'`)), item_name: `QA item ${i}` };
}
const due = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
const tok = {}; for (const who of Object.keys(PEOPLE)) tok[who] = await login(`qa.share.${who}@credence.test`);
const admin = await login('admin@credence.test');
const enter = (who, project, item, extra = {}) =>
  api(tok[who], 'POST', '/api/entries', { budget_id: budgetId, project_id: pid[project], job_name: `QA ${who} job`, job_duration: 'qa-share', items: [{ ...items[item], requisitioned_qty: 1, delivery_date: due }], ...extra });
const rowsOf = async (who) => ((await api(tok[who], 'GET', '/api/entries')).body || []).filter((e) => e.budget_id === budgetId);
const visible = async (who) => {
  const r = await api(tok[who], 'GET', '/api/entries');
  return new Set((r.body || []).filter((e) => e.budget_id === budgetId).map((e) => e.item_name));
};

// ---- 1. Team (today's behaviour) ---------------------------------------
let r = await enter('rahim', 'ci', 1);
ok(r.status === 200, 'team: Rahim enters in Central Inventory (' + r.status + ')');
ok((await visible('suman')).has('QA item 1'), 'team: Suman (other home team) sees it — same as before');

// ---- 2. By home project ------------------------------------------------
r = await api(admin, 'PUT', `/api/projects/${pid.ci}`, { project_name: P.ci, entry_scope: 'home' });
ok(r.status === 200 && r.body.for_filled === 1, 'switch to By home project fills For of the old entry (' + JSON.stringify(r.body) + ')');
ok(sql(`SELECT for_project_id FROM entries WHERE item_name = 'QA item 1' AND budget_id = ${budgetId}`) === String(pid.ana), "old entry is For Rahim's only home, Anamika");
r = await api(admin, 'PUT', `/api/projects/${pid.ci}`, { project_name: P.ci, entry_scope: 'everyone' });
ok(r.status === 400, 'an unknown Entry sharing is refused');

r = await api(tok.karim, 'GET', `/api/entries/for-options?project_id=${pid.ci}`);
ok(r.body.entry_scope === 'home' && r.body.homes.length === 1 && r.body.homes[0].id === pid.ana, 'for-options: Karim can be For Anamika only');
r = await enter('karim', 'ci', 2);
ok(r.status === 200, 'Karim enters with no For: filled with his only home');
r = await enter('jamil', 'ci', 3, { for_project_id: pid.ana });
ok(r.status === 400 && /your own projects/.test(r.body.error), 'Jamil cannot make an entry For Anamika (not his project)');
r = await enter('jamil', 'ci', 3);
ok(r.status === 200, 'Jamil enters (For Rupayan)');
r = await enter('nasima', 'ci', 4);
ok(r.status === 200, 'Nasima (no other project) enters with no For');

let v = await visible('rahim');
ok(v.has('QA item 1') && v.has('QA item 2') && !v.has('QA item 3') && !v.has('QA item 4'), 'Rahim sees Anamika team (1, 2), not Rupayan (3) or Nasima (4): ' + [...v]);
v = await visible('suman');
ok(v.has('QA item 3') && !v.has('QA item 1') && !v.has('QA item 2') && !v.has('QA item 4'), 'Suman sees only Rupayan team (3): ' + [...v]);
v = await visible('nasima');
ok(v.size === 1 && v.has('QA item 4'), 'Nasima sees only her own (4): ' + [...v]);
r = await api(admin, 'GET', '/api/entries?scope=all');
const all = (r.body || []).filter((e) => e.budget_id === budgetId);
ok(all.length === 4 && all.find((e) => e.item_name === 'QA item 3').for_project_name === P.rup, 'Reports (scope=all) sees all four, with For names');

const idOf = (item) => Number(sql(`SELECT id FROM entries WHERE item_name = 'QA item ${item}' AND budget_id = ${budgetId} AND deleted_at IS NULL LIMIT 1`));
r = await api(tok.suman, 'PUT', `/api/entries/${idOf(1)}`, { item_name: 'QA item 1', delivery_date: due });
ok(r.status === 403, "Suman cannot edit an Anamika-team entry (" + r.status + ')');
r = await api(tok.karim, 'PUT', `/api/entries/${idOf(1)}`, { item_name: 'QA item 1', delivery_date: due });
ok(r.status === 200, "Karim can edit Rahim's entry (same home team) (" + r.status + ')');
r = await api(tok.suman, 'DELETE', `/api/entries/${idOf(4)}`);
ok(r.status === 403, "Suman cannot delete Nasima's entry (" + r.status + ')');

// MPR No belongs to the group that used it
r = await enter('suman', 'ci', 1);
ok(r.status === 400, "Rupayan can't reuse Anamika's MPR No in Central Inventory");
r = await enter('karim', 'ci', 1);
ok(r.status === 200, 'Anamika team can reuse its own MPR No');

// Job items: Suman can't add to Rahim's Job
const rahimJob = Number(sql(`SELECT job_id FROM entries WHERE id = ${idOf(1)}`));
r = await api(tok.suman, 'POST', `/api/entries/job/${rahimJob}/items`, { items: [{ ...items[5], requisitioned_qty: 1, delivery_date: due }] });
ok(r.status === 403, "Suman can't add a row to Anamika's Job (" + r.status + ')');
r = await api(tok.karim, 'POST', `/api/entries/job/${rahimJob}/items`, { items: [{ ...items[5], requisitioned_qty: 1, delivery_date: due }] });
ok(r.status === 200 && sql(`SELECT for_project_id FROM entries WHERE item_name = 'QA item 5' AND budget_id = ${budgetId}`) === String(pid.ana), "Karim adds to the team's Job; the new row is For Anamika too");

// Final Submit locks only that team's share
r = await api(tok.rahim, 'POST', `/api/budgets/${budgetId}/submit`);
ok(r.status === 200 && r.body.success, 'Rahim Final Submits the Budget');
const keys = sql(`SELECT GROUP_CONCAT(share_key ORDER BY share_key) FROM budget_project_locks WHERE budget_id = ${budgetId} AND project_id = ${pid.ci}`);
ok(keys === `f:${pid.ana},u:${uid.rahim}`, 'locked: Anamika team and Rahim own share of Central Inventory (' + keys + ')');
r = await enter('karim', 'ci', 7);
ok(r.status === 400 && /already been submitted/.test(r.body.error), 'Karim (Anamika team) can no longer add');
r = await enter('jamil', 'ci', 7);
ok(r.status === 200, 'Jamil (Rupayan) still can — their share is open');
r = await api(tok.suman, 'GET', '/api/entries');
const s3 = (r.body || []).find((e) => e.item_name === 'QA item 3');
ok(s3 && s3.budget_locked === false, "Rupayan's rows don't show as locked");
r = await api(tok.karim, 'GET', '/api/entries');
const k1 = (r.body || []).find((e) => e.item_name === 'QA item 2');
ok(k1 && k1.budget_locked === true, "Anamika's rows show as locked");

// ---- 3. Own entries only -------------------------------------------------
r = await api(admin, 'PUT', `/api/projects/${pid.ci}`, { project_name: P.ci, entry_scope: 'own' });
let kr = await rowsOf('karim');
ok(kr.length > 0 && kr.every((e) => e.created_by === uid.karim), "own: Karim sees only his own rows (" + kr.length + ', makers ' + [...new Set(kr.map((e) => e.created_by))] + ')');
// ---- 4. back to home; a person on two projects --------------------------
await api(admin, 'PUT', `/api/projects/${pid.ci}`, { project_name: P.ci, entry_scope: 'home' });
sql(`INSERT INTO user_project_permissions (user_id, project_id) VALUES (${uid.nasima}, ${pid.ana}), (${uid.nasima}, ${pid.rup})`);
r = await enter('nasima', 'ci', 8);
ok(r.status === 400 && /Choose which/.test(r.body.error), 'two homes: Nasima must choose For');
r = await enter('nasima', 'ci', 8, { for_project_id: pid.rup });
ok(r.status === 200, 'Nasima enters For Rupayan');
ok((await visible('suman')).has('QA item 8') && !(await visible('rahim')).has('QA item 8'), 'that entry is shared with Rupayan, not Anamika');
r = await api(admin, 'GET', `/api/projects/${pid.ci}/for-gaps`);
const gap = (r.body.people || []).find((p) => p.user_id === uid.nasima);
ok(gap && gap.count === 1 && gap.homes.length === 2, 'for-gaps lists Nasima\'s old entry (no For) with her two projects');
r = await api(admin, 'POST', `/api/projects/${pid.ci}/for-fill`, { user_id: uid.nasima, for_project_id: pid.ana });
ok(r.status === 200 && r.body.filled === 1, 'Admin sets it For Anamika');
ok((await visible('rahim')).has('QA item 4'), 'now Anamika team sees it');
r = await api(tok.rahim, 'GET', `/api/projects/${pid.ci}/for-gaps`);
ok(r.status === 403, 'a plain user cannot open for-gaps (' + r.status + ')');
r = await api(tok.rahim, 'PUT', `/api/projects/${pid.ci}`, { project_name: P.ci, entry_scope: 'team' });
ok(r.status === 403, 'a plain user cannot change Entry sharing (' + r.status + ')');

// ---- 5. transfer: Karim leaves Anamika ------------------------------------
sql(`DELETE FROM user_project_permissions WHERE user_id = ${uid.karim} AND project_id = ${pid.ana}`);
sql(`INSERT INTO user_project_permissions (user_id, project_id) VALUES (${uid.karim}, ${pid.rup})`);
kr = await rowsOf('karim');
ok(kr.some((e) => e.created_by === uid.karim) && !kr.some((e) => e.created_by === uid.rahim) && kr.some((e) => e.created_by === uid.jamil),
  "transfer: Karim keeps his own, loses Rahim's, gains Rupayan's (makers " + [...new Set(kr.map((e) => e.created_by))] + ')');
ok((await visible('rahim')).has('QA item 2'), "Rahim still sees Karim's old Anamika entry (For doesn't move)");

// tidy: leave Central Inventory as team so other tests are unaffected
await api(admin, 'PUT', `/api/projects/${pid.ci}`, { project_name: P.ci, entry_scope: 'team' });
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`);
process.exit(fails ? 1 : 0);
