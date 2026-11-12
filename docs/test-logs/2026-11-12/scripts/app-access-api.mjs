// Mobile App access for many at once + "New accounts get the Mobile App".
// Test server :3200, test database. Run: node docs/test-logs/2026-11-12/scripts/app-access-api.mjs
import { execSync } from 'node:child_process';
const B = 'http://127.0.0.1:3200';
const sql = (q) => execSync(`mysql -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)} 2>/dev/null`).toString().trim();
const H = (t) => ({ 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) });
const call = async (t, method, p, body) => { const r = await fetch(B + p, { method, headers: H(t), body: body === undefined ? undefined : JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => null) }; };
// Past the Mobile App gate (a new phone may still wait for device approval).
const inApp = (j) => !!j && (!!j.token || (j.code && j.code !== 'APP_ACCESS_OFF'));
const login = async (id, app = false) => call(null, 'POST', '/api/auth/login', { email: id, password: 'ProbePass123', workspace: 'credence', ...(app ? { platform: 'app', latitude: 23.78, longitude: 90.41, device_id: `qa-${id}`, device_name: 'QA phone', device_platform: 'android' } : {}) });
let pass = 0, n = 0;
const ok = (name, c, x = '') => { n++; if (c) pass++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : x); };

// Setup: three test accounts off, password known.
sql("UPDATE users u JOIN (SELECT password_hash FROM users WHERE id = 1) a SET u.password_hash = a.password_hash, u.can_use_app = 0 WHERE u.id IN (142,143,144)");
sql("UPDATE users u JOIN (SELECT password_hash FROM users WHERE id = 1) a SET u.password_hash = a.password_hash WHERE u.id IN (133,140)");
sql('DELETE FROM app_access_settings');
sql("DELETE FROM users WHERE email = 'new.joiner@credence.test'");
const mail = (id) => sql(`SELECT email FROM users WHERE id = ${id}`);
const sa = (await login('admin@credence.test')).j.token;
const kamal = (await login('kamal.uddin@credence.test')).j.token;

console.log('— who may');
ok('Kamal (no Module Access granting) cannot read the setting', (await call(kamal, 'GET', '/api/app-access/settings')).s === 403);
ok('Kamal cannot turn the app on for others', (await call(kamal, 'PUT', '/api/app-access/bulk', { user_ids: [142], can_use_app: true })).s === 403);
const st = (await call(sa, 'GET', '/api/app-access/settings')).j;
ok('setting: new accounts get the app (on), Superadmin may change it', st.new_accounts_app === true && st.can_change === true, JSON.stringify(st));

console.log('— before');
ok('an account with the app off cannot sign in to the app', (await login(mail(142), true)).j?.code === 'APP_ACCESS_OFF');
ok('…but can still use the website', !!(await login(mail(142))).j?.token);
const users = (await call(sa, 'GET', '/api/users')).j;
ok('Users list shows app_on false for them, true for others', users.find((u) => u.id === 142)?.app_on === false && users.find((u) => u.id === 140)?.app_on === true);

console.log('— many at once');
let r = (await call(sa, 'PUT', '/api/app-access/bulk', { user_ids: [142, 143, 144, 1], can_use_app: true })).j;
ok('3 turned on in one go, the Superadmin skipped', r.done === 3 && r.skipped.length === 1, JSON.stringify(r));
ok('now they get past the app gate', inApp((await login(mail(142), true)).j) && inApp((await login(mail(144), true)).j), JSON.stringify((await login(mail(142), true)).j));
ok('each change is in the access log', Number(sql("SELECT COUNT(*) FROM user_access_audit WHERE action = 'app-access-bulk' AND target_user_id IN (142,143,144)")) >= 3);
r = (await call(sa, 'PUT', '/api/app-access/bulk', { user_ids: [143], can_use_app: false })).j;
ok('turned off again for one', r.done === 1 && (await login(mail(143), true)).j?.code === 'APP_ACCESS_OFF');

console.log('— an Admin who grants Module Access');
sql("DELETE FROM admin_module_permissions WHERE user_id = 133 AND module_key = 'users'");
sql("INSERT INTO admin_module_permissions (user_id, module_key) VALUES (133, 'users')");
sql("UPDATE users SET can_grant_module_access = 1 WHERE id = 133");
const rumana = (await login(mail(133))).j.token;
r = (await call(rumana, 'PUT', '/api/app-access/bulk', { user_ids: [143, 1, 133], can_use_app: true })).j;
ok('a delegated Admin changes plain Users only (Superadmin and themselves skipped)', r?.done === 1 && r.skipped.length === 2, JSON.stringify(r));
const st2 = await call(rumana, 'PUT', '/api/app-access/settings', { new_accounts_app: false });
ok('…and cannot change the new-account setting', st2.s === 403);

console.log('— new accounts');
const made = (await call(sa, 'POST', '/api/users', { name: 'New Joiner', email: 'new.joiner@credence.test', password: 'Joiner#2026pass', role: 'user' })).j;
ok('a new account is made', !!made && !made.error, JSON.stringify(made));
ok('it has nothing set for itself (follows the setting)', sql("SELECT IFNULL(can_use_app, 'null') FROM users WHERE email = 'new.joiner@credence.test'") === 'null');
const nj = async () => (await call(null, 'POST', '/api/auth/login', { email: 'new.joiner@credence.test', password: 'Joiner#2026pass', workspace: 'credence', platform: 'app', latitude: 23.78, longitude: 90.41, device_id: 'qa-new-joiner', device_name: 'QA phone', device_platform: 'android' })).j;
ok('the setting is on: the new account gets past the app gate straight away', inApp(await nj()), JSON.stringify(await nj()));
ok('Superadmin turns the setting off', (await call(sa, 'PUT', '/api/app-access/settings', { new_accounts_app: false })).s === 200);
await new Promise((x) => setTimeout(x, 16000));
ok('now a new account (nothing set) cannot use the app', (await nj())?.code === 'APP_ACCESS_OFF');
ok('an account turned on by hand keeps the app', inApp((await login(mail(142), true)).j));
await call(sa, 'PUT', '/api/app-access/settings', { new_accounts_app: true });

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
