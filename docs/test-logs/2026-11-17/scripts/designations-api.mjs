// Admin Panel -> Designations: one list for all companies, permanent codes,
// spelling variants, rename everywhere, merge, delete, permissions. Dev server :3200.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s.replace(/"/g, '\\"')}"`).toString().trim();
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const login = async (email) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'ProbePass123' }) })).json()).token;
const A = await login('admin@credence.test');
const call = (tok) => async (m, p, b) => { const r = await fetch(B + '/api/designations' + p, { method: m, headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const api = call(A);

// Test data: a second company of the group; employees with mixed spellings in both.
sql("DELETE FROM all_employees WHERE employee_id LIKE 'DSGT-%'; DELETE FROM ot_rates WHERE designation IN ('Sr. Executive','Executive','Officer','Senior Executive'); DELETE FROM leave_balance_workflows WHERE name='QA designation wf'");
sql("INSERT IGNORE INTO companies (id, group_id, name, short_code) VALUES (2, (SELECT group_id FROM (SELECT group_id FROM companies WHERE id=1) x), 'QA Sister Concern', 'QASC')");
sql("DELETE FROM designations");
// A re-run: put back what an earlier run renamed.
sql("UPDATE all_employees SET designation='Executive' WHERE designation='Officer'");
sql("UPDATE all_employees SET designation_id=NULL");
const emp = (code, d, company = 1) => sql(`INSERT INTO all_employees (employee_id, name, designation, is_active, company_id) VALUES ('${code}', 'QA ${code}', '${d}', 1, ${company})`);
emp('DSGT-1', 'Senior Executive'); emp('DSGT-2', 'Senior Executive'); emp('DSGT-3', 'senior  executive ');
emp('DSGT-4', 'Sr. Executive'); emp('DSGT-5', 'Sr. Executive', 2);
emp('DSGT-6', 'Executive'); emp('DSGT-7', 'executive', 2); emp('DSGT-8', 'Store Keeper');
sql("INSERT INTO ot_rates (company_id, designation, rate_type, rate) VALUES (1, 'Executive', 'fixed', 100), (1, 'Sr. Executive', 'fixed', 150)");
sql("INSERT INTO leave_balance_workflows (name, scope_type, designation) VALUES ('QA designation wf', 'designation', 'Sr. Executive')");

let L = await api('GET', '');
ok(L.status === 200, `list (${L.status} ${L.body.error || ''})`);
const find = (n) => (L.body.designations || []).find((d) => d.name === n);
const se = find('Senior Executive'), sr = find('Sr. Executive'), ex = find('Executive');
ok(se && sr && ex && find('Store Keeper'), 'made from the employees: Senior Executive, Sr. Executive, Executive, Store Keeper');
ok(/^DSG-\d{3}$/.test(se?.code || '') && new Set(L.body.designations.map((d) => d.code)).size === L.body.designations.length, `codes DSG-…, all different (${se?.code})`);
ok(se?.employees === 3, `"senior  executive " counted as Senior Executive (3) — ${se?.employees}`);
ok(sql("SELECT designation FROM all_employees WHERE employee_id='DSGT-3'") === 'Senior Executive', 'its text tidied to "Senior Executive"');
const exp = (k) => Number(sql(`SELECT COUNT(*) FROM all_employees WHERE COALESCE(is_active,1)=1 AND LOWER(TRIM(REPLACE(designation,'.',' '))) IN (${k})`));
ok(ex?.employees === exp("'executive'") && sr?.employees === 2 && sql("SELECT COUNT(*) FROM all_employees WHERE employee_id IN ('DSGT-5','DSGT-7') AND company_id=2 AND designation_id IS NOT NULL") === '2', `counts across both companies (Executive ${ex?.employees}, Sr. Executive ${sr?.employees}; the sister concern's people linked too)`);
ok((L.body.lookAlikes || []).some((g) => g.includes(se.id) && g.includes(sr.id)), 'Senior Executive / Sr. Executive shown as look-alikes');
ok(ex.usedIn.some((u) => u.label === 'OT rates'), 'Executive: "Used in OT rates"');

// Add: same name refused, look-alike asked, then allowed.
const p1 = await api('POST', '', { name: 'Project Coordinator', level: 8 });
ok(p1.status === 200 && /^DSG-\d{3}$/.test(p1.body.designation.code), `add Project Coordinator -> ${p1.body.designation?.code}`);
const dupe = await api('POST', '', { name: ' project  coordinator. ' });
ok(dupe.status === 409 && dupe.body.existing?.code === p1.body.designation.code, `same name again -> 409 "${dupe.body.error}"`);
const asked = await api('POST', '', { name: 'Senior Project Coordinator' });
ok(asked.status === 200, 'Senior Project Coordinator added');
const look2 = await api('POST', '', { name: 'Sr. Project Coordinator' });
ok(look2.status === 409 && look2.body.similar, `look-alike "Sr. Project Coordinator" -> asked: "${look2.body.error}"`);
ok((await api('POST', '', { name: 'Sr. Project Coordinator', force: true })).status === 200, '"Add anyway" works');

// Rename: code stays, employees and rules follow.
const r1 = await api('PATCH', `/${ex.id}`, { name: 'Officer' });
L = await api('GET', '');
ok(r1.status === 200 && find('Officer')?.code === ex.code && !find('Executive'), `rename Executive -> Officer, code ${ex.code} kept`);
ok(sql("SELECT GROUP_CONCAT(DISTINCT designation) FROM all_employees WHERE employee_id IN ('DSGT-6','DSGT-7')") === 'Officer', 'employees in both companies now "Officer"');
ok(sql("SELECT COUNT(*) FROM ot_rates WHERE designation='Officer'") === '1', 'the OT rate follows');
const rn2 = await api('PATCH', `/${se.id}`, { name: 'Store Keeper' });
ok(rn2.status === 409, `rename onto an existing name -> 409 "${rn2.body.error}"`);

// Merge Sr. Executive into Senior Executive.
const maxBefore = Number(sql("SELECT MAX(code_no) FROM designations"));
const mg = await api('POST', '/merge', { keepId: se.id, mergeIds: [sr.id] });
L = await api('GET', '');
ok(mg.status === 200 && find('Senior Executive')?.employees === 5 && !find('Sr. Executive'), `merge -> Senior Executive 5, Sr. Executive gone (${mg.body.error || ''})`);
ok(sql("SELECT COUNT(*) FROM ot_rates WHERE designation='Senior Executive'") === '1' && sql("SELECT designation FROM leave_balance_workflows WHERE name='QA designation wf'") === 'Senior Executive', 'OT rate and leave workflow follow the merge');
ok(sql(`SELECT CONCAT(is_deleted,'/',merged_into) FROM designations WHERE id=${sr.id}`) === `1/${se.id}`, `${sr.code} retired, points to ${se.code}`);
// An old Excel with the merged name / the old code lands on the kept one.
emp('DSGT-9', 'Sr. Executive'); emp('DSGT-10', sr.code);
await api('PATCH', `/${se.id}`, { level: 6 }); // any edit triggers nothing; list does the pass:
const n = await api('POST', '', { name: 'Zz Probe ' + Date.now() }); // new code after merge
ok(Number(n.body.designation.code.slice(4)) === maxBefore + 1 || Number(n.body.designation.code.slice(4)) > maxBefore, `new code after the merge is new (${n.body.designation.code}), never a retired one`);
// the list runs the linking pass itself
L = await api('GET', '');
ok(sql("SELECT designation FROM all_employees WHERE employee_id='DSGT-9'") === 'Senior Executive', 'old name "Sr. Executive" in a later import -> Senior Executive (no new designation)');
ok(sql("SELECT designation FROM all_employees WHERE employee_id='DSGT-10'") === 'Senior Executive', `written as its old code ${sr.code} -> Senior Executive`);
ok(!find('Sr. Executive'), 'Sr. Executive did not come back');

// Delete: refused while people have it; allowed when nobody does.
ok((await api('DELETE', `/${find('Store Keeper').id}`)).status === 400, 'delete with employees -> 400');
ok((await api('DELETE', `/${n.body.designation.id}`)).status === 200, 'delete one nobody has');
// Level and Inactive.
await api('PATCH', `/${p1.body.designation.id}`, { isActive: false });
const opts = await (await fetch(B + '/api/designations/options', { headers: { Authorization: 'Bearer ' + A } })).json();
ok(!opts.some((o) => o.name === 'Project Coordinator') && opts.some((o) => o.name === 'Senior Executive'), 'Inactive left out of the form picker');

// Permissions.
sql("UPDATE users SET role='admin' WHERE email='qa.claimant@credence.test'; DELETE FROM admin_module_permissions WHERE user_id=(SELECT id FROM users WHERE email='qa.claimant@credence.test'); DELETE FROM admin_module_permission_layers WHERE user_id=(SELECT id FROM users WHERE email='qa.claimant@credence.test')");
let U = await login('qa.claimant@credence.test');
ok((await call(U)('GET', '')).status === 403, 'no Designations module -> 403');
ok((await fetch(B + '/api/designations/options', { headers: { Authorization: 'Bearer ' + U } })).status === 200, 'the form picker names: any Admin Panel account');
sql("INSERT INTO admin_module_permissions (user_id, module_key) SELECT id, 'designations' FROM users WHERE email='qa.claimant@credence.test'; INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) SELECT id, 'designations', 'read' FROM users WHERE email='qa.claimant@credence.test'");
await new Promise((r) => setTimeout(r, 1500));
U = await login('qa.claimant@credence.test');
ok((await call(U)('GET', '')).status === 200 && (await call(U)('POST', '', { name: 'Should Not' })).status === 403, 'read layer only: can see, cannot add (403)');
sql("UPDATE users SET role='user' WHERE email='qa.claimant@credence.test'; DELETE FROM admin_module_permissions WHERE user_id=(SELECT id FROM users WHERE email='qa.claimant@credence.test') AND module_key='designations'; DELETE FROM admin_module_permission_layers WHERE user_id=(SELECT id FROM users WHERE email='qa.claimant@credence.test') AND module_key='designations'");
console.log(`\n${pass} passed, ${fail} failed`);
