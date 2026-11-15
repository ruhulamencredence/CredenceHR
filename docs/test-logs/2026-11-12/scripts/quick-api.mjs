// HR Operations -> Quick reports API: the numbers, and who may see them.
// Test server :3200, test database. Run after quick-setup.sql:
//   node docs/test-logs/2026-11-12/scripts/quick-api.mjs
import { execSync } from 'node:child_process';
const B = 'http://127.0.0.1:3200';
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
const H = (t) => ({ 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) });
const call = async (t, method, p, body) => { const r = await fetch(B + p, { method, headers: H(t), body: body === undefined ? undefined : JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => null) }; };
const login = async (email) => (await call(null, 'POST', '/api/auth/login', { email, password: 'ProbePass123', workspace: 'credence' })).j?.token;
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };
const KINDS = ['probation', 'joiners', 'transfers', 'resignations', 'religion'];
const today = sql('SELECT CURDATE()');

sql("UPDATE users u JOIN (SELECT password_hash FROM users WHERE id = 1) a SET u.password_hash = a.password_hash WHERE u.id IN (133, 140)");
const sa = await login('admin@credence.test');

console.log('— numbers (Superadmin)');
const s = (await call(sa, 'GET', '/api/hr-ops/quick/summary')).j;
ok('summary: probation 1 due in 30 days, 1 overdue, 1 confirmed this month', s.probation.due_30 === 1 && s.probation.overdue === 1 && s.probation.confirmed === 1, JSON.stringify(s.probation));
ok('summary: 2 joined this month (Admin 1, HR 1)', s.joiners.joined === 2 && s.joiners.top.length === 2, JSON.stringify(s.joiners));
ok('summary: 2 transfers this month, 1 takes effect later (the 2025 one is left out)', s.transfers.transfers === 2 && s.transfers.scheduled === 1, JSON.stringify(s.transfers));
ok('summary: 3 in notice, 2 leave within 30 days (cancelled one left out)', s.resignations.in_notice === 3 && s.resignations.leaving_30 === 2 && s.resignations.submitted === 3, JSON.stringify(s.resignations));
ok('summary: 4 religions, 1 not recorded, Islam 6 ("muslim" counted as Islam, inactive left out)', s.religion.religions === 4 && s.religion.not_recorded === 1 && s.religion.top[0].label === 'Islam' && s.religion.top[0].count === 6 && s.religion.total === 10, JSON.stringify(s.religion));

let r = (await call(sa, 'GET', '/api/hr-ops/quick/probation')).j;
const by = (rows, name) => rows.find((x) => x.name === name);
ok('probation: Rafiq overdue 11 days, Tanvir due in 9, Sadia confirmed; Imran (60 days) not listed', by(r.rows, 'Rafiq Ahmed')?.state === 'overdue' && by(r.rows, 'Rafiq Ahmed')?.days === -11 && by(r.rows, 'Tanvir Hasan')?.days === 9 && by(r.rows, 'Sadia Karim')?.state === 'confirmed' && !by(r.rows, 'Imran Hossain'), JSON.stringify(r.rows.map((x) => [x.name, x.state, x.days])));
ok('probation: department filter (MIS) keeps only Tanvir', (await call(sa, 'GET', '/api/hr-ops/quick/probation?department=MIS')).j.rows.map((x) => x.name).join() === 'Tanvir Hasan');
r = (await call(sa, 'GET', '/api/hr-ops/quick/joiners')).j;
ok('joiners: Rumana with onboarding 2 of 3 (n/a not counted), Jahid not started', by(r.rows, 'Rumana Islam')?.onboarding_done === 2 && by(r.rows, 'Rumana Islam')?.onboarding_total === 3 && by(r.rows, 'Jahid Hasan')?.onboarding_total === null);
ok('joiners: no money fields in any row', r.rows.every((x) => !Object.keys(x).some((k) => /salary|gross|amount|basic/i.test(k))));
r = (await call(sa, 'GET', '/api/hr-ops/quick/transfers')).j;
ok('transfers: Jahid Admin -> Transport scheduled, designation change kept', by(r.rows, 'Jahid Hasan')?.scheduled === true && by(r.rows, 'Jahid Hasan')?.to_designation === 'Security Guard');
ok('transfers: period 2025 finds the old one', (await call(sa, 'GET', '/api/hr-ops/quick/transfers?from=2025-01-01&to=2025-12-31')).j.rows.length === 1);
ok('transfers: department filter matches from or to (Transport)', (await call(sa, 'GET', '/api/hr-ops/quick/transfers?department=Transport')).j.rows.map((x) => x.name).join() === 'Jahid Hasan');
r = (await call(sa, 'GET', '/api/hr-ops/quick/resignations')).j;
ok('resignations: in notice first, nearest last working day first', r.rows.map((x) => x.name).slice(0, 3).join() === 'Tanvir Hasan,Imran Hossain,Sadia Karim', r.rows.map((x) => x.name).join());
ok('resignations: Tanvir clearance 3 of 5, 8 days left', by(r.rows, 'Tanvir Hasan')?.clearance_done === 3 && by(r.rows, 'Tanvir Hasan')?.clearance_total === 5 && by(r.rows, 'Tanvir Hasan')?.days_left === 8);
ok('resignations: 2 resign + 1 termination submitted this month, cancelled left out', r.summary.resignations === 2 && r.summary.terminations === 1 && !by(r.rows, 'Kamal Uddin'));
ok('resignations: reasons grouped (better offer, study, family, other)', ['Better offer', 'Higher study', 'Family / personal', 'Other'].every((k) => r.reasons.some((g) => g.label === k)), JSON.stringify(r.reasons));
ok('resignations: turnover counts only those already gone (Nasrin, last month)', r.turnover.left_this_year === (today.slice(5, 7) === '01' ? 0 : 1), JSON.stringify(r.turnover));
ok('resignations: type=termination keeps only Sadia', (await call(sa, 'GET', '/api/hr-ops/quick/resignations?type=termination')).j.rows.map((x) => x.name).join() === 'Sadia Karim');
const lm = (await call(sa, 'GET', `/api/hr-ops/quick/resignations?from=${sql("SELECT DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')")}&to=${sql('SELECT LAST_DAY(CURDATE() - INTERVAL 1 MONTH)')}`)).j;
ok('resignations: last month shows Nasrin as settled', by(lm.rows, 'Nasrin Sultana')?.status === 'settled' && lm.summary.settled === 1, JSON.stringify(lm.summary));
ok('resignations: no money anywhere in the answer', !/settlement_amount|net_payable|gratuity|amount/i.test(JSON.stringify(r)));
r = (await call(sa, 'GET', '/api/hr-ops/quick/religion')).j;
ok('religion: percentages add up to 100', Math.round(r.groups.reduce((a, g) => a + g.percent, 0)) === 100);
ok('religion: Rumana shows as not recorded', by(r.rows, 'Rumana Islam')?.religion === null);
ok('unknown report -> 404', (await call(sa, 'GET', '/api/hr-ops/quick/salaries')).s === 404);
ok('bad dates fall back to this month', (await call(sa, 'GET', '/api/hr-ops/quick/joiners?from=x&to=y')).j.from === today.slice(0, 8) + '01');

console.log('— who may see them');
ok('no token -> 401', (await call(null, 'GET', '/api/hr-ops/quick/summary')).s === 401);
const kamal = await login('kamal.uddin@credence.test');
for (const k of ['summary', ...KINDS]) ok(`Kamal (no HR Operations) is refused: ${k}`, (await call(kamal, 'GET', `/api/hr-ops/quick/${k}`)).s === 403);
sql("DELETE FROM admin_module_permissions WHERE user_id = 133 AND module_key = 'hr_operations'");
sql("DELETE FROM admin_module_permission_layers WHERE user_id = 133 AND module_key = 'hr_operations'");
sql("INSERT INTO admin_module_permissions (user_id, module_key) VALUES (133, 'hr_operations')");
let t133 = await login('roster.hr@credence.test');
ok('HR Operations with no layers ticked: gets Quick reports (the default)', (await call(t133, 'GET', '/api/hr-ops/quick/summary')).s === 200);
sql("INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES (133, 'hr_operations', 'read'), (133, 'hr_operations', 'onboarding_create')");
for (const k of ['summary', ...KINDS]) ok(`layers ticked without Quick reports: refused ${k}`, (await call(t133, 'GET', `/api/hr-ops/quick/${k}`)).s === 403);
ok('…but HR Operations itself still opens', (await call(t133, 'GET', '/api/hr-ops/meta')).s === 200);
sql("INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES (133, 'hr_operations', 'quick_reports')");
ok('Quick reports ticked: allowed', (await call(t133, 'GET', '/api/hr-ops/quick/religion')).s === 200);

console.log('— existing accounts get it once');
sql("DELETE FROM admin_module_permission_layers WHERE user_id = 133 AND module_key = 'hr_operations' AND layer_key = 'quick_reports'");
sql("DELETE FROM startup_migrations WHERE name = 'hr_quick_reports_grant'");
execSync('./node_modules/.bin/tsx docs/test-logs/2026-11-12/scripts/quick-grant.ts', { stdio: 'ignore' });
ok('an account that had HR Operations "read" got Quick reports', sql("SELECT COUNT(*) FROM admin_module_permission_layers WHERE user_id = 133 AND module_key = 'hr_operations' AND layer_key = 'quick_reports'") === '1');
sql("DELETE FROM admin_module_permission_layers WHERE user_id = 133 AND module_key = 'hr_operations' AND layer_key = 'quick_reports'");
execSync('./node_modules/.bin/tsx docs/test-logs/2026-11-12/scripts/quick-grant.ts', { stdio: 'ignore' });
ok('…only once: untick it and it stays off after a restart', sql("SELECT COUNT(*) FROM admin_module_permission_layers WHERE user_id = 133 AND module_key = 'hr_operations' AND layer_key = 'quick_reports'") === '0');

// leave 133 as it was before (no HR Operations)
sql("DELETE FROM admin_module_permission_layers WHERE user_id = 133 AND module_key = 'hr_operations'");
sql("DELETE FROM admin_module_permissions WHERE user_id = 133 AND module_key = 'hr_operations'");
console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
