/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Every employee / user picker shows "Name · Employee ID · Designation ·
// Department" (CLAUDE.md "Picking a person"; src/lib/personLabel.ts). The
// lists those pickers load come from many routes, most of them returning
// just {id, name}; this adds the three fields from the person's Employee
// record. It only describes the people already in the list.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface PersonInfo {
  employee_code: string | null;
  designation: string | null;
  department: string | null;
}

/**
 * Adds employee_code / designation / department to each row (fields a row
 * already has are kept). `by` says what the row's id is: a login ("user",
 * matched on all_employees.user_id) or an Employee record ("employee").
 */
export async function attachPersonInfo<T extends Record<string, any>>(
  queryDB: QueryDB,
  rows: T[],
  by: "user" | "employee" = "user",
  key = "id"
): Promise<(T & PersonInfo)[]> {
  const list = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(list.map((r) => Number(r?.[key])).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return list.map((r) => ({ employee_code: null, designation: null, department: null, ...r }));
  const col = by === "user" ? "user_id" : "id";
  const info = new Map<number, PersonInfo>();
  try {
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const emps: any[] =
        (await queryDB(
          `/*unscoped*/ SELECT e.id, e.user_id, e.employee_id, e.designation, e.department, d.name AS department_name
             FROM all_employees e LEFT JOIN departments d ON d.id = e.department_id
            WHERE e.${col} IN (${chunk.map(() => "?").join(",")})`,
          chunk
        )) || [];
      for (const e of emps) {
        const k = Number(e[col]);
        if (info.has(k)) continue;
        info.set(k, {
          employee_code: e.employee_id ? String(e.employee_id) : null,
          designation: e.designation || null,
          department: e.department_name || e.department || null
        });
      }
    }
  } catch {
    // A missing table / database hiccup: the picker still works by name.
  }
  return list.map((r) => {
    const p = info.get(Number(r?.[key]));
    return {
      ...r,
      employee_code: r.employee_code ?? p?.employee_code ?? null,
      designation: r.designation ?? p?.designation ?? null,
      department: r.department ?? p?.department ?? null
    };
  });
}
