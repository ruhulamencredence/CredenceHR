/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Pay and service records outlive the Employee record they belong to.
// Deleting an Employee used to delete, through ON DELETE CASCADE, every salary
// run (paid ones too), salary structure, advance, bonus, HR action, letter and
// transfer of that person — records that have to be kept for audit and the law.
//
//   - KEPT_RECORDS: the tables whose rows keep an Employee from being deleted.
//     DELETE /api/employees/:id refuses while any of them has a row for the
//     person (keptRecordsOf); someone who left is marked Resigned / Terminated
//     instead, which keeps everything.
//   - ensureEmployeeRecordsGuard: the database itself refuses too — every
//     foreign key from these tables to all_employees is switched from
//     ON DELETE CASCADE to ON DELETE RESTRICT (on every start, only where
//     still CASCADE), so no other path can wipe them either.
//
// Records with no legal weight (education, family, supervisors, probation
// settings…) still go
// with an Employee created by mistake.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export const KEPT_RECORDS: { table: string; label: string }[] = [
  { table: "payrolls", label: "salary run" },
  { table: "salary_structures", label: "salary structure" },
  { table: "salary_adjustments", label: "salary adjustment" },
  { table: "pending_bonuses", label: "bonus" },
  { table: "employee_pay_items", label: "pay item" },
  { table: "employee_advances", label: "loan / advance" },
  { table: "advance_requests", label: "loan / advance request" },
  { table: "late_waivers", label: "late waiver" },
  { table: "hr_actions", label: "HR action" },
  { table: "hr_letters", label: "letter" },
  { table: "employee_transfers", label: "transfer" }
];

export async function ensureEmployeeRecordsGuard(dbPool: any): Promise<void> {
  try {
    const [rows]: any = await dbPool.query(
      `SELECT k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, r.UPDATE_RULE AS on_update
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'all_employees' AND r.DELETE_RULE = 'CASCADE'
          AND k.TABLE_NAME IN (${KEPT_RECORDS.map(() => "?").join(", ")})`,
      KEPT_RECORDS.map((k) => k.table)
    );
    for (const fk of rows || []) {
      const t = String(fk.t).replace(/`/g, "");
      const name = String(fk.name).replace(/`/g, "");
      const col = String(fk.col).replace(/`/g, "");
      const onUpdate = ["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"].includes(String(fk.on_update)) ? String(fk.on_update) : "RESTRICT";
      const keep = `fk_keep_${t}_${col}`.slice(0, 64);
      try {
        // The RESTRICT key goes on first, then the CASCADE one comes off, so
        // the records are never unguarded in between.
        const [has]: any = await dbPool.query(
          "SELECT COUNT(*) AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?",
          [t, keep]
        );
        if (!Number(has?.[0]?.n || 0)) {
          await dbPool.query(
            `ALTER TABLE \`${t}\` ADD CONSTRAINT \`${keep}\` FOREIGN KEY (\`${col}\`) REFERENCES all_employees(id) ON DELETE RESTRICT ON UPDATE ${onUpdate}`
          );
        }
        await dbPool.query(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${name}\``);
        console.log(`🔒 ${t}.${col}: an Employee with these records can no longer be deleted`);
      } catch (err: any) {
        console.warn(`⚠️ Could not protect ${t}.${col} from Employee deletes: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.warn("⚠️ Employee records guard: " + err.message);
  }
}

// What still points at this Employee among KEPT_RECORDS (tables that don't
// exist on this server are skipped).
export async function keptRecordsOf(queryDB: QueryDB, employeeId: number): Promise<{ label: string; count: number }[]> {
  const found: { label: string; count: number }[] = [];
  for (const k of KEPT_RECORDS) {
    const rows: any[] | null = await queryDB(`SELECT COUNT(*) AS n FROM \`${k.table}\` WHERE employee_id = ?`, [employeeId]).catch(() => null);
    const n = Number(rows?.[0]?.n || 0);
    if (n > 0) found.push({ label: k.label, count: n });
  }
  return found;
}
