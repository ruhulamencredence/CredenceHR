// Probe the partner sign-in (SSO) + welcome slides + disappearing switch on a copy DB.
// env: BASE, SA_EMAIL, SA_PASS, EMP_EMAIL, EMP_ID, EMP_PASS, OTHER_EMP_ID, BLOCKED_EMAIL, BLOCKED_ID, MYSQL (cmd prefix)
import { execSync } from 'node:child_process';
const B = process.env.BASE;
const res = [];
const ok = (name, cond, info = '') => { res.push({ name, pass: !!cond, info }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  — ' + info : '')); };
const j = async (method, path, { body, headers = {}, token } = {}) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { s: r.status, d };
};
const sql = (q) => execSync(`${process.env.MYSQL} -N -e ${JSON.stringify(q)}`).toString().trim();
const login = async (email, password) => (await j('POST', '/api/auth/login', { body: { email, password, workspace: 'credence' } }));

const sa = await login(process.env.SA_EMAIL, process.env.SA_PASS);
ok('superadmin login', sa.s === 200 && sa.d?.token, `status ${sa.s} ${sa.d?.error || ''}`);
const SA = sa.d.token;
const emp = await login(process.env.EMP_EMAIL, process.env.EMP_PASS);
ok('employee login', emp.s === 200, `status ${emp.s} ${emp.d?.error || ''}`);
const EMP = emp.d?.token;

// admin routes are superadmin only
for (const [m, p] of [['GET', '/api/system/sso-clients'], ['POST', '/api/system/sso-clients'], ['GET', '/api/system/welcome-slides'], ['POST', '/api/system/welcome-slides/show-again']]) {
  const r = await j(m, p, { token: EMP, body: { name: 'x' } });
  ok(`employee blocked from ${m} ${p}`, r.s === 403 || r.s === 401, `status ${r.s}`);
  const n = await j(m, p, { body: { name: 'x' } });
  ok(`no-login blocked from ${m} ${p}`, n.s === 401 || n.s === 403, `status ${n.s}`);
}

const mk = await j('POST', '/api/system/sso-clients', { token: SA, body: { name: '360 ERP' } });
ok('create client', mk.s === 200 && mk.d?.secret?.length >= 60, `status ${mk.s}`);
const { app_id, secret } = mk.d;
const list = await j('GET', '/api/system/sso-clients', { token: SA });
ok('secret not in list', !JSON.stringify(list.d).includes(secret));
ok('db keeps only hash', !sql(`SELECT secret_hash FROM api_clients WHERE app_id='${app_id}'`).includes(secret));
const cid = list.d.clients.find((c) => c.app_id === app_id).id;

const H = (s = secret, a = app_id) => ({ 'X-App-Id': a, 'X-App-Secret': s });
const init = (body, headers = H()) => j('POST', '/api/v1/service/sso/initiate', { body, headers });
const good = { email: process.env.EMP_EMAIL, employee_id: process.env.EMP_ID };

ok('no creds -> 401', (await init(good, {})).s === 401);
ok('wrong secret -> 401', (await init(good, H('x'.repeat(64)))).s === 401);
ok('unknown app -> 401', (await init(good, H(secret, 'nope_123'))).s === 401);
ok('other employee id with this email -> 422', (await init({ ...good, employee_id: process.env.OTHER_EMP_ID })).s === 422);
ok('email only -> 422', (await init({ email: good.email })).s === 422);
ok('blocked account -> 422', (await init({ email: process.env.BLOCKED_EMAIL, employee_id: process.env.BLOCKED_ID })).s === 422);
const spoof = await j('POST', '/api/v1/service/sso/initiate', { body: good, headers: { ...H(), Host: 'evil.example.com', 'X-Forwarded-Proto': 'http' } });
ok('plain http from non-local host -> 403', spoof.s === 403, `status ${spoof.s}`);

const r1 = await init(good);
ok('initiate ok', r1.s === 200 && /\/sso\/consume\/[0-9a-f]{64}$/.test(r1.d?.forward_url || ''), `status ${r1.s} ${JSON.stringify(r1.d)}`);
const tok = (r1.d?.forward_url || '').split('/').pop();
ok('token not stored in plain', !sql(`SELECT COUNT(*) FROM sso_login_requests WHERE token_hash='${tok}'`).startsWith('1'));
const c1 = await j('POST', '/api/auth/sso/consume', { body: { token: tok } });
ok('consume signs in the right person', c1.s === 200 && c1.d?.user?.email?.toLowerCase() === good.email.toLowerCase(), `status ${c1.s} ${c1.d?.error || ''}`);
ok('no trusted-device token on SSO', !c1.d?.trusted_device);
const me = await j('GET', '/api/auth/me', { token: c1.d?.token });
ok('session works', me.s === 200);
const c2 = await j('POST', '/api/auth/sso/consume', { body: { token: tok } });
ok('token second use -> 401', c2.s === 401);
// concurrency: two at once, only one wins
const r2 = await init(good); const t2 = r2.d.forward_url.split('/').pop();
const both = await Promise.all([1, 2, 3].map(() => j('POST', '/api/auth/sso/consume', { body: { token: t2 } })));
ok('3 at once -> exactly one sign-in', both.filter((x) => x.s === 200).length === 1, both.map((x) => x.s).join(','));
// expiry
const r3 = await init(good); const t3 = r3.d.forward_url.split('/').pop();
sql(`UPDATE sso_login_requests SET expires_at = NOW() - INTERVAL 1 SECOND WHERE client_id=${cid} AND used_at IS NULL`);
ok('expired token -> 401', (await j('POST', '/api/auth/sso/consume', { body: { token: t3 } })).s === 401);
ok('malformed token -> 400', (await j('POST', '/api/auth/sso/consume', { body: { token: 'abc' } })).s === 400);
ok('random token -> 401', (await j('POST', '/api/auth/sso/consume', { body: { token: 'a'.repeat(64) } })).s === 401);

// blocked after link was made
const r4 = await init(good); const t4 = r4.d.forward_url.split('/').pop();
const uid = sql(`SELECT id FROM users WHERE LOWER(email)=LOWER('${good.email}')`);
sql(`UPDATE users SET is_blocked=1 WHERE id=${uid}`);
const c4 = await j('POST', '/api/auth/sso/consume', { body: { token: t4 } });
ok('blocked between initiate and consume -> refused', c4.s >= 400, `status ${c4.s} ${c4.d?.error || ''}`);
sql(`UPDATE users SET is_blocked=0 WHERE id=${uid}`);

// IP allow-list and switch off
let u = await j('PUT', `/api/system/sso-clients/${cid}`, { token: SA, body: { name: '360 ERP', is_active: true, allowed_ips: '10.9.9.9', rate_per_minute: 60, token_ttl_seconds: 120 } });
ok('set ip list', u.s === 200);
ok('ip not allowed -> 403', (await init(good)).s === 403);
u = await j('PUT', `/api/system/sso-clients/${cid}`, { token: SA, body: { name: '360 ERP', is_active: false, allowed_ips: '', rate_per_minute: 3, token_ttl_seconds: 120 } });
ok('switched off -> 401', (await init(good)).s === 401);
await j('PUT', `/api/system/sso-clients/${cid}`, { token: SA, body: { name: '360 ERP', is_active: true, allowed_ips: '', rate_per_minute: 3, token_ttl_seconds: 120 } });
const burst = []; for (let i = 0; i < 5; i++) burst.push((await init(good)).s);
ok('rate limit 3/min', burst.includes(429), burst.join(','));
// rotate: old secret dead
const rot = await j('POST', `/api/system/sso-clients/${cid}/rotate`, { token: SA });
ok('old secret dead after rotate', (await init(good)).s === 401);
ok('new secret works (or rate-limited)', [200, 429].includes((await init(good, H(rot.d.secret))).s));
// delete
const unused = sql(`SELECT COUNT(*) FROM sso_login_requests WHERE client_id=${cid} AND used_at IS NULL`);
const del = await j('DELETE', `/api/system/sso-clients/${cid}`, { token: SA });
ok('delete client', del.s === 200 && sql(`SELECT COUNT(*) FROM sso_login_requests WHERE client_id=${cid} AND used_at IS NULL`) === '0', `unused before ${unused}`);
ok('deleted app -> 401', (await init(good, H(rot.d.secret))).s === 401);
ok('every call logged', Number(sql(`SELECT COUNT(*) FROM api_access_logs WHERE app_id='${app_id}'`)) >= 15);

// disappearing messages switch
ok('employee flag off by default', me.d?.can_use_disappearing === false || me.d?.user?.can_use_disappearing === false || sql(`SELECT can_use_disappearing FROM users WHERE id=${uid}`) === '0');
const grant = await j('PUT', `/api/users/${uid}/disappearing-access`, { token: EMP, body: { can_use_disappearing: true } });
ok('employee cannot grant self disappearing', grant.s === 403 || grant.s === 401, `status ${grant.s}`);

// welcome slides
const ws = await j('GET', '/api/welcome-slides/status', { token: EMP });
ok('welcome status answers', ws.s === 200 && typeof ws.d?.show === 'boolean', JSON.stringify(ws.d));
await j('POST', '/api/welcome-slides/seen', { token: EMP });
ok('after seen -> not shown', (await j('GET', '/api/welcome-slides/status', { token: EMP })).d?.show === false);
await j('POST', '/api/system/welcome-slides/show-again', { token: SA });
await new Promise((r) => setTimeout(r, 1100));
ok('show again -> shown once more', (await j('GET', '/api/welcome-slides/status', { token: EMP })).d?.show === true);

const f = res.filter((r) => !r.pass);
console.log(`\n${res.length - f.length}/${res.length} pass`);
process.exit(f.length ? 1 : 0);
