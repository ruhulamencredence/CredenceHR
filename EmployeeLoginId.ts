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
