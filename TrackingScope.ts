/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking -> whom an account may see (Admin Panel -> Users ->
// Module Access -> Employee Tracking -> "Who they can see"). Two lists per
// account: Departments (tracking_department_access) and single Employees
// (tracking_employee_access). Nothing in either = every employee, as before
// this existed. Anything ticked = only people in those Departments plus the
// Employees picked, on every tracking route: live map, status cards, notices,
// notice report, path history, Stay Report and Live Follow. A Superadmin
// always sees everyone.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export async function ensureTrackingScopeSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      console.warn(`⚠️ Tracking scope (${label}): ${err.message}`);
    }
  };
  await run(
    "tracking_department_access",
    `CREATE TABLE IF NOT EXISTS tracking_department_access (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      department VARCHAR(150) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_department (user_id, department),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await run(
    "tracking_employee_access",
    `CREATE TABLE IF NOT EXISTS tracking_employee_access (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      employee_pk INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_employee (user_id, employee_pk),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
}

export interface TrackingScopeLists {
  departments: string[];
  employee_ids: number[];
}

export async function getTrackingScopeLists(queryDB: QueryDB, userId: number): Promise<TrackingScopeLists> {
  const deps: any[] = (await queryDB("SELECT department FROM tracking_department_access WHERE user_id = ? ORDER BY department ASC", [userId]).catch(() => [])) || [];
  const emps: any[] = (await queryDB("SELECT employee_pk FROM tracking_employee_access WHERE user_id = ?", [userId]).catch(() => [])) || [];
  return { departments: deps.map((r) => String(r.department)), employee_ids: emps.map((r) => Number(r.employee_pk)) };
}

export interface TrackingScope {
  // all_employees.id of everyone this account may see
  employeePks: Set<number>;
  // their login accounts (location_pings are keyed by user_id)
  userIds: Set<number>;
}

// null = sees everyone (Superadmin, or nothing ticked).
export async function getTrackingScope(queryDB: QueryDB, user: any): Promise<TrackingScope | null> {
  if (!user || user.role === "superadmin") return null;
  const lists = await getTrackingScopeLists(queryDB, Number(user.id));
  if (lists.departments.length === 0 && lists.employee_ids.length === 0) return null;
  const depts = new Set(lists.departments);
  const picked = new Set(lists.employee_ids);
  const employees: any[] = (await queryDB("SELECT id, user_id, department FROM all_employees", [])) || [];
  const scope: TrackingScope = { employeePks: new Set(), userIds: new Set() };
  for (const e of employees) {
    if (!depts.has(String(e.department || "")) && !picked.has(Number(e.id))) continue;
    scope.employeePks.add(Number(e.id));
    if (e.user_id) scope.userIds.add(Number(e.user_id));
  }
  return scope;
}

export const inTrackingScope = (scope: TrackingScope | null, userId: number) => !scope || scope.userIds.has(Number(userId));

export const TRACKING_SCOPE_DENIED = "This employee is outside the people you can track. Ask your Superadmin to add them.";
