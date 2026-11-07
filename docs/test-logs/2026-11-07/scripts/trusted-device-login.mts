// Trusted-device sign-in: every case, against the DB copy on port 3200.
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { resolveJwtSecret } from '/home/user/CredenceHR/JwtSecret';
const B = 'http://localhost:3200';
const R: any[] = [];
const T = (id: string, ok: boolean, name: string, detail = '') => { R.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? '  — ' + detail : ''}`); };
const sql = (q: string) => execFileSync('mysql', ['-N', 'tut_db', '-e', q]).toString().trim();
async function login(identifier: string, password: string, ip: string, trusted?: string[]) {
  const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ identifier, password, workspace: 'credence', ...(trusted ? { trusted_devices: trusted } : {}) }) });
  const b: any = await r.json().catch(() => ({}));
  return { s: r.status, b };
}
const PW = 'Credence@2026';
const SADIA = 'sadia.karim@credence.test', RAFIQ = 'rafiq.ahmed@credence.test', NASRIN = 'nasrin.sultana@credence.test', PLAIN = 'plain.r@credence.test';

// T1 normal sign-in, no token: works, hands out a token
const a = await login(SADIA, PW, '10.1.0.1');
T('T1', a.s === 200 && typeof a.b.trusted_device === 'string' && a.b.trusted_device.split('.').length === 4, 'Normal sign-in works and gives this device a token', `status ${a.s}`);
const sadiaTok = a.b.trusted_device;
// T2 someone else types 5 wrong passwords for Sadia from another network
const wrong: number[] = []; for (let i = 0; i < 5; i++) wrong.push((await login(SADIA, 'bad' + i, '10.2.0.1')).s);
const other = await login(SADIA, PW, '10.2.0.1');
T('T2', other.s === 429, 'After 5 wrong tries the account is locked for devices that are not trusted (as before)', `wrong ${wrong.join(',')}; right password from attacker side ${other.s}`);
const mine = await login(SADIA, PW, '10.1.0.1', [sadiaTok]);
T('T3', mine.s === 200, 'Sadia on her trusted device still signs in with the right password', `status ${mine.s}`);
T('T3b', mine.b.trusted_device?.split('.')[1] === sadiaTok.split('.')[1], 'Her device keeps the same device id (token refreshed)');
// T4 trusted device has its own limit: 10 wrong, then locked on that device
const tok2 = mine.b.trusted_device;
const dw: number[] = []; for (let i = 0; i < 10; i++) dw.push((await login(SADIA, 'oops' + i, '10.1.0.1', [tok2])).s);
const dLocked = await login(SADIA, PW, '10.1.0.1', [tok2]);
T('T4', dw.every((c) => c === 400) && dLocked.s === 429, '10 wrong tries on the trusted device lock that device', `wrong ${dw.join(',')}; then right ${dLocked.s} ${String(dLocked.b.error || '').slice(0, 60)}`);
// T5 office network: 30 wrong sign-ins from one address (many people mistyping)
const office = '10.30.0.1';
for (let i = 0; i < 30; i++) await login(`nobody${i}@credence.test`, 'x', office);
const fresh = await login(PLAIN, PW, office);
T('T5', fresh.s === 429, 'After 30 wrong tries from one network, a device that is not trusted there waits (as before)', `status ${fresh.s}`);
const rafiqFirst = await login(RAFIQ, PW, '10.9.0.9');
const rafiqOffice = await login(RAFIQ, PW, office, [rafiqFirst.b.trusted_device]);
T('T6', rafiqOffice.s === 200, 'Rafiq (trusted device) signs in from the same blocked office network', `status ${rafiqOffice.s}`);
// T7 another account's token does not help
const nas = await login(NASRIN, PW, office, [rafiqFirst.b.trusted_device]);
T('T7', nas.s === 429, 'Rafiq\'s token does not let Nasrin past the network lock', `status ${nas.s}`);
// T8 tampered token
const parts = rafiqFirst.b.trusted_device.split('.'); const tampered = [parts[0], parts[1], String(Date.now()), parts[3]].join('.');
const t8 = await login(RAFIQ, PW, office, [tampered]);
T('T8', t8.s === 429, 'A changed token is ignored (treated as an unknown device)', `status ${t8.s}`);
// T9 expired (181 days old, correctly signed)
const secret = resolveJwtSecret();
const rid = sql("SELECT id FROM users WHERE email='rafiq.ahmed@credence.test'");
const old = `${rid}.${parts[1]}.${Date.now() - 181 * 864e5}`;
const oldTok = `${old}.${crypto.createHmac('sha256', `${secret}:login-device`).update(old).digest('base64url')}`;
const t9 = await login(RAFIQ, PW, office, [oldTok]);
T('T9', t9.s === 429, 'A token older than 180 days is not trusted', `status ${t9.s}`);
// T10 password change ends trust (sessions_valid_after)
sql(`UPDATE users SET sessions_valid_after = NOW(3) WHERE id = ${rid}`);
await new Promise((r) => setTimeout(r, 50));
const t10 = await login(RAFIQ, PW, office, [rafiqOffice.b.trusted_device]);
T('T10', t10.s === 429, 'After the password is changed / sessions ended, the old token no longer helps', `status ${t10.s}`);
// T11 wrong tries on a trusted device do not lock other devices
const k1 = await login('kamal.uddin@credence.test', PW, '10.11.0.1');
for (let i = 0; i < 6; i++) await login('kamal.uddin@credence.test', 'bad' + i, '10.11.0.1', [k1.b.trusted_device]);
const kOther = await login('kamal.uddin@credence.test', PW, '10.12.0.1');
T('T11', kOther.s === 200, 'Typos on your own trusted device do not lock your account elsewhere', `status ${kOther.s}`);
// T12 rows recorded with device id
T('T12', Number(sql("SELECT COUNT(*) FROM login_attempts WHERE device IS NOT NULL")) > 0, 'Attempts from trusted devices are recorded with the device id');
// T13 junk in trusted_devices does not break sign-in
const j = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.13.0.1' }, body: JSON.stringify({ identifier: 'imran.hossain@credence.test', password: PW, workspace: 'credence', trusted_devices: [null, 5, 'a.b.c.d', 'x'.repeat(5000), { t: 1 }] }) });
T('T13', j.status === 200, 'Junk values in trusted_devices are ignored', `status ${j.status}`);
const j2 = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.13.0.2' }, body: JSON.stringify({ identifier: 'imran.hossain@credence.test', password: PW, workspace: 'credence', trusted_devices: 'not-an-array' }) });
T('T14', j2.status === 200, 'trusted_devices that is not a list is ignored', `status ${j2.status}`);
console.log(JSON.stringify({ pass: R.filter(Boolean).length, fail: R.filter((x) => !x).length }));
