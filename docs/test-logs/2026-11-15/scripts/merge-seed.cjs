// Test data for Users -> Merge accounts: logins made by hand (no employee)
// with real records, and employees whose import made a second login.
const mysql = require('mysql2/promise'); const bcrypt = require('bcryptjs');
(async () => {
  const db = await mysql.createConnection({ host: '127.0.0.1', user: 'cred', password: 'credpass', database: 'admin_ui' });
  const q = async (s, p = []) => (await db.query(s, p))[0];
  const oldHash = await bcrypt.hash('OldPass123', 10), newHash = await bcrypt.hash('ImportPass123', 10);
  for (const e of ['karim.old@credence.test', 'rafiq.personal@credence.test', 'sumon.old@credence.test', 'stranger@credence.test']) await q('DELETE FROM users WHERE email = ?', [e]);
  await q("DELETE FROM users WHERE username IN ('MRG-901','MRG-902','MRG-903','MRG-904')");
  await q("DELETE FROM all_employees WHERE employee_id IN ('MRG-901','MRG-902','MRG-903','MRG-904')");
  const user = async (name, email, username, hash, role = 'user') => (await q('INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)', [name, email, username, hash, role])).insertId;
  const emp = async (code, name, email, userId) => (await q("INSERT INTO all_employees (employee_id, name, designation, department, email, user_id, is_active, company_id) VALUES (?, ?, 'Executive', 'Sales', ?, ?, 1, (SELECT MIN(id) FROM companies))", [code, name, email, userId])).insertId;
  // 1. Karim: old login by hand (admin, chat + attendance module access, data), import login MRG-901 (name match).
  const karimOld = await user('Md. Karim Uddin', 'karim.old@credence.test', null, oldHash, 'admin');
  const karimNew = await user('Karim Uddin', null, 'MRG-901', newHash);
  await emp('MRG-901', 'Karim Uddin', null, karimNew);
  await q('UPDATE users SET can_use_chat = 1, can_use_attendance = 1 WHERE id = ?', [karimOld]);
  await q("INSERT INTO admin_module_permissions (user_id, module_key) VALUES (?, 'attendance'), (?, 'leave')", [karimOld, karimOld]);
  await q("INSERT INTO admin_module_permissions (user_id, module_key) VALUES (?, 'tasks')", [karimNew]);
  for (const d of ['2026-11-02', '2026-11-03', '2026-11-04']) await q("INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at) VALUES (?, 1, ?, CONCAT(?, ' 09:05:00'))", [karimOld, d, d]);
  await q("INSERT INTO leave_applications (user_id, leave_type, start_date, end_date, day_count, purpose, apply_date, status, decided_by) VALUES (?, 'casual', '2026-11-10', '2026-11-10', 1, 'Family', '2026-11-08', 'approved', 1)", [karimOld]);
  // Karim approved someone else's leave with the old login.
  await q("INSERT INTO leave_applications (user_id, leave_type, start_date, end_date, day_count, purpose, apply_date, status, decided_by) VALUES (2, 'sick', '2026-11-11', '2026-11-11', 1, 'Fever', '2026-11-11', 'approved', ?)", [karimOld]);
  await q("INSERT INTO bill_claims (user_id, claim_date, from_date, to_date, amount, status) VALUES (?, '2026-11-05', '2026-11-01', '2026-11-05', 1200, 'pending')", [karimOld]);
  // 2. Rafiq: old login's email = the employee's email (email match), nothing on it.
  const rafiqOld = await user('Rafiq', 'rafiq.personal@credence.test', 'rafiq', oldHash);
  const rafiqNew = await user('Rafiq Hasan', null, 'MRG-902', newHash);
  await emp('MRG-902', 'Rafiq Hasan', 'rafiq.personal@credence.test', rafiqNew);
  // 3. Sumon: two employees with the same name -> "name only, more than one".
  const sumonOld = await user('Sumon Ahmed', 'sumon.old@credence.test', null, oldHash);
  await emp('MRG-903', 'Sumon Ahmed', null, await user('Sumon Ahmed', null, 'MRG-903', newHash));
  await emp('MRG-904', 'Sumon Ahmed', null, await user('Sumon Ahmed', null, 'MRG-904', newHash));
  // 4. A login with no employee and no match.
  await user('Stranger Person', 'stranger@credence.test', null, oldHash);
  console.log(JSON.stringify({ karimOld, karimNew, rafiqOld, rafiqNew, sumonOld }));
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
