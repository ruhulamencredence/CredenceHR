/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// An employee's Login ID is their Employee ID (e.g. CPL-0201): it is kept in
// users.username, which sign-in already reads and the database keeps unique.
// Email still signs in too; accounts with no Employee record (Superadmin,
// Project logins) keep the Login ID they have.
//
// Because the Employee ID is a Login ID, it can't repeat — not in another
// employee of any company, and not as another account's username or email.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

const clean = (v: unknown) => String(v ?? "").trim();

/** Why this Employee ID can't be used (someone else has it), or null. */
export async function employeeIdConflict(
  queryDB: QueryDB,
  code: unknown,
  exclude: { employeeRowId?: number | null; userId?: number | null } = {}
): Promise<string | null> {
  const c = clean(code);
  if (!c) return null;
  const empParams: any[] = [c];
  let empSql = "/*unscoped*/ SELECT id, name FROM all_employees WHERE LOWER(TRIM(employee_id)) = LOWER(?)";
  if (exclude.employeeRowId) {
    empSql += " AND id <> ?";
    empParams.push(Number(exclude.employeeRowId));
  }
  const emps: any[] = (await queryDB(empSql, empParams)) || [];
  if (emps.length) return `Employee ID ${c} is already used by ${emps[0].name}. An Employee ID is also the Login ID, so it can't repeat.`;
  const userParams: any[] = [c, c];
  let userSql = "SELECT id, name FROM users WHERE (LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?))";
  if (exclude.userId) {
    userSql += " AND id <> ?";
    userParams.push(Number(exclude.userId));
  }
  const users: any[] = (await queryDB(userSql, userParams)) || [];
  if (users.length) return `${c} is already the Login ID of ${users[0].name}. Pick another Employee ID.`;
  return null;
}

/**
 * The employee's login (if any) signs in with their Employee ID. Only fills a
 * login that has no username yet, or whose username was the previous
 * Employee ID — a username someone chose on purpose is left alone. Never
 * throws; a clash is skipped (the next save shows it).
 */
export async function syncEmployeeLoginId(queryDB: QueryDB, employeeRowId: number, previousCode?: string | null): Promise<void> {
  try {
    const rows: any[] = (await queryDB("/*unscoped*/ SELECT employee_id, user_id FROM all_employees WHERE id = ?", [employeeRowId])) || [];
    const e = rows[0];
    const code = clean(e?.employee_id);
    if (!e?.user_id || !code) return;
    const users: any[] = (await queryDB("SELECT id, username FROM users WHERE id = ?", [Number(e.user_id)])) || [];
    const u = users[0];
    if (!u) return;
    const current = clean(u.username).toLowerCase();
    if (current === code.toLowerCase()) return;
    if (current && current !== clean(previousCode).toLowerCase()) return;
    const taken: any[] =
      (await queryDB("SELECT id FROM users WHERE (LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)) AND id <> ?", [code, code, Number(u.id)])) || [];
    if (taken.length) return;
    await queryDB("UPDATE users SET username = ? WHERE id = ?", [code, Number(u.id)]);
  } catch {
    // Left as it was; signing in with the email still works.
  }
}

/** Startup: every employee login that has no username yet gets its Employee ID. */
export async function backfillEmployeeLoginIds(queryDB: QueryDB): Promise<void> {
  try {
    const rows: any[] =
      (await queryDB(
        `/*unscoped*/ SELECT e.id FROM all_employees e JOIN users u ON u.id = e.user_id
         WHERE e.employee_id IS NOT NULL AND TRIM(e.employee_id) <> '' AND (u.username IS NULL OR TRIM(u.username) = '')`
      )) || [];
    for (const r of rows) await syncEmployeeLoginId(queryDB, Number(r.id));
  } catch (err: any) {
    console.warn("⚠️ Could not give employee logins their Employee ID: " + err.message);
  }
}

/**
 * Employee ID = Login ID, so an employee with no login linked whose Employee
 * ID is exactly the username of a login that has no employee record is that
 * person: link them (e.g. after the employees were deleted and imported
 * again, or added by hand). Only ordinary ('user') logins of the same group —
 * an Admin's or the Superadmin's login is linked by hand. Skipped when the
 * Employee ID appears on more than one employee. Never throws. Returns how
 * many were linked. employeeRowId: just that employee.
 *
 * Run at start-up, when the Employees list or Employee Tracking loads (at most
 * once a minute), and right after an employee is added or saved.
 */
let lastAutoLink = 0;
export async function autoLinkByEmployeeId(queryDB: QueryDB, employeeRowId?: number): Promise<number> {
  if (!employeeRowId) {
    if (Date.now() - lastAutoLink < 60_000) return 0;
    lastAutoLink = Date.now();
  }
  try {
    const all: any[] =
      (await queryDB(
        `/*unscoped*/ SELECT e.id, e.employee_id, e.user_id, c.group_id
           FROM all_employees e LEFT JOIN companies c ON c.id = e.company_id`
      )) || [];
    const codeCount = new Map<string, number>();
    const linked = new Set<number>();
    for (const e of all) {
      const k = clean(e.employee_id).toLowerCase();
      if (k) codeCount.set(k, (codeCount.get(k) || 0) + 1);
      if (e.user_id) linked.add(Number(e.user_id));
    }
    const todo = all.filter((e) => !e.user_id && clean(e.employee_id) && (!employeeRowId || Number(e.id) === Number(employeeRowId)));
    if (!todo.length) return 0;
    const users: any[] =
      (await queryDB("SELECT id, username, group_id FROM users WHERE role = 'user' AND username IS NOT NULL AND TRIM(username) <> ''")) || [];
    const byName = new Map<string, any>();
    for (const u of users) if (!linked.has(Number(u.id))) byName.set(clean(u.username).toLowerCase(), u);
    let n = 0;
    for (const e of todo) {
      const k = clean(e.employee_id).toLowerCase();
      if (codeCount.get(k) !== 1) continue;
      const u = byName.get(k);
      if (!u) continue;
      if (e.group_id != null && u.group_id != null && Number(e.group_id) !== Number(u.group_id)) continue;
      await queryDB("/*unscoped*/ UPDATE all_employees SET user_id = ? WHERE id = ? AND user_id IS NULL", [Number(u.id), Number(e.id)]);
      byName.delete(k);
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** The ordinary login whose username is this Employee ID and that has no employee record yet, or null. */
export async function orphanLoginForEmployeeId(queryDB: QueryDB, code: unknown): Promise<number | null> {
  const c = clean(code);
  if (!c) return null;
  try {
    const rows: any[] =
      (await queryDB(
        `/*unscoped*/ SELECT u.id FROM users u
          WHERE u.role = 'user' AND LOWER(u.username) = LOWER(?)
            AND u.id NOT IN (SELECT user_id FROM all_employees WHERE user_id IS NOT NULL)`,
        [c]
      )) || [];
    return rows.length === 1 ? Number(rows[0].id) : null;
  } catch {
    return null;
  }
}
