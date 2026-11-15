// Approval Details: who may open an HR Action / Exit, and who sees its salary.
// Run after quick-setup.sql and details-access-setup.sql (test server :3200).
import { execSync } from 'node:child_process';
const B = 'http://127.0.0.1:3200';
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
const login = async (email) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'ProbePass123', workspace: 'credence' }) })).json()).token;
const get = async (t, type, id, file = false) => { const r = await fetch(`${B}/api/approval-details${file ? '/file' : ''}?type=${type}&id=${id}`, { headers: { authorization: 'Bearer ' + t } }); return { s: r.status, j: await r.json().catch(() => null) }; };
const setModules = (mods, layers = []) => { sql('DELETE FROM admin_module_permissions WHERE user_id = 133; DELETE FROM admin_module_permission_layers WHERE user_id = 133'); for (const m of mods) sql(`INSERT INTO admin_module_permissions (user_id, module_key) VALUES (133, '${m}')`); for (const [m, l] of layers) sql(`INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES (133, '${m}', '${l}')`); };
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };
const salary = (r) => r.j?.table?.rows?.find((x) => x[0] === 'gross salary');

const hrId = sql("SELECT id FROM hr_actions WHERE reason = 'QA details: performance'");
const termItem = sql("SELECT ci.id FROM exit_clearance_items ci JOIN exit_requests e ON e.id = ci.exit_id WHERE e.reason = 'QA misconduct' AND ci.item_label = 'QA laptop'");
const resignItem = sql("SELECT ci.id FROM exit_clearance_items ci JOIN exit_requests e ON e.id = ci.exit_id WHERE e.reason = 'QA Got a better offer' ORDER BY ci.id LIMIT 1");
const leaveId = sql('SELECT id FROM leave_applications WHERE user_id = 138 ORDER BY id DESC LIMIT 1');

const sa = await login('admin@credence.test');
const rafiq = await login('rafiq.ahmed@credence.test');
const sadia = await login('sadia.karim@credence.test');
const tanvir = await login('tanvir.r@credence.test');
const nasrin = await login('nasrin.sultana@credence.test');

console.log('— the employee it is about');
ok('Rafiq cannot open the Separation HR is deciding about him', (await get(rafiq, 'hr_action', hrId)).s === 403);
ok('Sadia cannot open the termination HR opened for her', (await get(sadia, 'exit_clearance', termItem)).s === 403);
ok('Tanvir still opens his own resignation', (await get(tanvir, 'exit_clearance', resignItem)).s === 200);
ok('Rafiq still opens his own leave application', (await get(rafiq, 'leave_application', leaveId)).s === 200);

console.log('— Approvals module alone');
setModules(['approvals']);
let a = await login('roster.hr@credence.test');
ok('cannot open an HR Action', (await get(a, 'hr_action', hrId)).s === 403);
ok('cannot open an Exit clearance', (await get(a, 'exit_clearance', termItem)).s === 403);
ok('still opens a leave application (as before)', (await get(a, 'leave_application', leaveId)).s === 200);

console.log('— HR Operations / Exit module');
setModules(['hr_operations']);
a = await login('roster.hr@credence.test');
let r = await get(a, 'hr_action', hrId);
ok('HR Operations opens the HR Action, salary shown as *****', r.s === 200 && salary(r)?.[1] === '*****' && salary(r)?.[2] === '*****', JSON.stringify(r.j?.table));
ok('…other changes still shown (designation)', r.j?.table?.rows?.some((x) => x[0] === 'designation' && x[1] === 'Officer, Accounts'));
ok('…but not an Exit (needs Exit / Offboarding)', (await get(a, 'exit_clearance', termItem)).s === 403);
setModules(['hr_operations', 'payroll'], [['payroll', 'salary_amounts']]);
a = await login('roster.hr@credence.test');
r = await get(a, 'hr_action', hrId);
ok('with Payroll "See salary amounts": salary shown', salary(r)?.[1] === '40000', JSON.stringify(r.j?.table));
setModules(['exit_offboarding']);
a = await login('roster.hr@credence.test');
ok('Exit / Offboarding opens the Exit clearance', (await get(a, 'exit_clearance', termItem)).s === 200);
setModules([]);
a = await login('roster.hr@credence.test');
ok('no modules: neither', (await get(a, 'hr_action', hrId)).s === 403 && (await get(a, 'exit_clearance', termItem)).s === 403);

console.log('— its own chain');
r = await get(nasrin, 'hr_action', hrId);
ok('Nasrin (approver) opens it and sees the salary', r.s === 200 && salary(r)?.[1] === '40000');
ok('Nasrin (clearance approver) opens the termination', (await get(nasrin, 'exit_clearance', termItem)).s === 200);
r = await get(sa, 'hr_action', hrId);
ok('Superadmin sees everything', r.s === 200 && salary(r)?.[1] === '40000');
ok('attachment route follows the same rule', (await get(rafiq, 'hr_action', hrId, true)).s === 403);

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
