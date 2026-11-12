// Who can open Approval Details for sensitive requests. Writes JSON results
// to the path given (used for the before / after comparison).
//   node details-access-probe.mjs out.json
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const B = 'http://127.0.0.1:3200';
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
const login = async (email) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'ProbePass123', workspace: 'credence' }) })).json()).token;
const get = async (t, type, id) => { const r = await fetch(`${B}/api/approval-details?type=${type}&id=${id}`, { headers: { authorization: 'Bearer ' + t } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const setModules = (mods) => { sql('DELETE FROM admin_module_permissions WHERE user_id = 133; DELETE FROM admin_module_permission_layers WHERE user_id = 133'); for (const m of mods) sql(`INSERT INTO admin_module_permissions (user_id, module_key) VALUES (133, '${m}')`); };

const hrId = sql("SELECT id FROM hr_actions WHERE reason = 'QA details: performance'");
const termItem = sql("SELECT ci.id FROM exit_clearance_items ci JOIN exit_requests e ON e.id = ci.exit_id WHERE e.reason = 'QA misconduct' AND ci.item_label = 'QA laptop'");
const resignItem = sql("SELECT ci.id FROM exit_clearance_items ci JOIN exit_requests e ON e.id = ci.exit_id WHERE e.reason = 'QA Got a better offer' ORDER BY ci.id LIMIT 1");
const leaveId = sql('SELECT id FROM leave_applications WHERE user_id = 138 ORDER BY id DESC LIMIT 1');
const out = [];
const add = (key, who, what, r) => out.push({ key, who, what, status: r.status, body: r.body });

const rafiq = await login('rafiq.ahmed@credence.test');
add('emp_hr', 'Rafiq (employee)', 'His own pending Separation (HR Action)', await get(rafiq, 'hr_action', hrId));
const sadia = await login('sadia.karim@credence.test');
add('emp_term', 'Sadia (employee)', 'Her termination, opened by HR (Exit clearance)', await get(sadia, 'exit_clearance', termItem));
setModules(['approvals']);
let a = await login('roster.hr@credence.test');
add('appr_hr', 'Admin with only Approvals module', "Rafiq's Separation (HR Action)", await get(a, 'hr_action', hrId));
add('appr_exit', 'Admin with only Approvals module', "Sadia's termination (Exit clearance)", await get(a, 'exit_clearance', termItem));
setModules(['hr_operations']);
a = await login('roster.hr@credence.test');
add('hrops_hr', 'HR Operations admin, no "See salary amounts"', "Rafiq's Separation (HR Action)", await get(a, 'hr_action', hrId));
setModules([]);
const nasrin = await login('nasrin.sultana@credence.test');
add('chain_hr', 'Nasrin (approver of this HR Action)', "Rafiq's Separation (HR Action)", await get(nasrin, 'hr_action', hrId));
add('chain_exit', 'Nasrin (clearance approver)', "Sadia's termination (Exit clearance)", await get(nasrin, 'exit_clearance', termItem));
const tanvir = await login('tanvir.r@credence.test');
add('emp_resign', 'Tanvir (employee)', 'His own resignation (Exit clearance)', await get(tanvir, 'exit_clearance', resignItem));
if (leaveId) add('emp_leave', 'Rafiq (employee)', 'His own leave application', await get(rafiq, 'leave_application', leaveId));
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
for (const o of out) console.log(o.status, o.key, o.body?.table ? JSON.stringify(o.body.table.rows) : o.body?.error || '');
