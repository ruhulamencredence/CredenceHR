// Test data for Departments -> team "Add people by project": an Inventory department,
// people at three work stations, some from other departments, one already in a team.
const mysql = require('mysql2/promise');
(async () => {
  const db = await mysql.createConnection({ host: '127.0.0.1', user: 'cred', password: 'credpass', database: 'admin_ui' });
  const q = async (s, p = []) => (await db.query(s, p))[0];
  await q("DELETE FROM department_teams WHERE department_id IN (SELECT id FROM departments WHERE name IN ('Inventory QA','Accounts QA'))");
  await q("DELETE FROM all_employees WHERE employee_id LIKE 'INV-%'");
  await q("DELETE FROM departments WHERE name IN ('Inventory QA','Accounts QA')");
  await q("DELETE FROM branches WHERE branch_name = 'Uttara Project'");
  const cid = (await q('SELECT MIN(id) AS c FROM companies'))[0].c || 1;
  const inv = (await q('INSERT INTO departments (name, company_id) VALUES (?, ?)', ['Inventory QA', cid])).insertId;
  const acc = (await q('INSERT INTO departments (name, company_id) VALUES (?, ?)', ['Accounts QA', cid])).insertId;
  await q("INSERT INTO branches (branch_name, company_id) VALUES ('Uttara Project', ?)", [cid]);
  const br = Object.fromEntries((await q('SELECT id, branch_name FROM branches')).map((b) => [b.branch_name, b.id]));
  const emp = async (code, name, dept, branch) =>
    (await q("INSERT INTO all_employees (employee_id, name, designation, department, department_id, branch, branch_id, is_active, company_id, created_at) VALUES (?, ?, 'Store Keeper', ?, ?, ?, ?, 1, ?, NOW() - INTERVAL 30 DAY)",
      [code, name, dept === inv ? 'Inventory QA' : 'Accounts QA', dept, branch, br[branch], cid])).insertId;
  const ids = {};
  ids.g1 = await emp('INV-01', 'Abdur Rahim', inv, 'Gulshan Tower');
  ids.g2 = await emp('INV-02', 'Shahin Alam', inv, 'Gulshan Tower');
  ids.g3 = await emp('INV-03', 'Nasir Uddin', inv, 'Gulshan Tower');
  ids.b1 = await emp('INV-04', 'Kamrul Hasan', inv, 'Banani Site');
  ids.b2 = await emp('INV-05', 'Jahid Hasan', inv, 'Banani Site');
  ids.u1 = await emp('INV-06', 'Rasel Mia', inv, 'Uttara Project');
  ids.a1 = await emp('INV-07', 'Faruk Hossain', acc, 'Gulshan Tower');
  // Faruk is in an Accounts team now.
  const accTeam = (await q('INSERT INTO department_teams (department_id, name, supervisor_user_id) VALUES (?, ?, 1)', [acc, 'Accounts QA team'])).insertId;
  await q('INSERT INTO department_team_members (team_id, employee_id) VALUES (?, ?)', [accTeam, ids.a1]);
  console.log(JSON.stringify({ inv, acc, accTeam, ...ids }));
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
