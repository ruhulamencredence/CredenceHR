/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A login's work outlives the login. Deleting a user (Users -> Manage ->
// Delete this user) used to delete, through ON DELETE CASCADE, the person's
// attendance, claims, leave, exit and final settlement, tasks, targets,
// documents, chat messages… — records that can't be got back.
//
//   - KEPT_USER_RECORDS: the tables whose rows keep a login from being
//     deleted. DELETE /api/users/:id refuses while any of them has a row for
//     the account (keptUserRecordsOf) and points to Block login instead,
//     which stops the sign-in and keeps everything.
//   - ensureUserRecordsGuard: the database itself refuses too — every
//     foreign key from these tables to users that is ON DELETE CASCADE is
//     switched to ON DELETE RESTRICT (on every start, only where still
//     CASCADE), so no other path can wipe them either.
// A login made by mistake (no such records) is still deleted as before, with
// its settings (permissions, alerts, saved places…). Merge accounts moves the
// records first, then deletes the old login (AccountMergeRoutes.ts).

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export const KEPT_USER_RECORDS: { table: string; label: string }[] = [
  { table: "attendance", label: "attendance day" },
  { table: "attendance_corrections", label: "attendance correction" },
  { table: "employee_breaks", label: "break" },
  { table: "location_pings", label: "tracking point" },
  { table: "bill_claims", label: "bill claim" },
  { table: "claims", label: "conveyance claim" },
  { table: "conveyance_bills", label: "conveyance bill" },
  { table: "mobile_limit_requests", label: "mobile limit request" },
  { table: "leave_applications", label: "leave application" },
  { table: "leave_balances", label: "leave balance" },
  { table: "leave_category_balances", label: "leave balance" },
  { table: "exit_requests", label: "exit request" },
  { table: "final_settlements", label: "final settlement" },
  { table: "grievances", label: "grievance" },
  { table: "disciplinary_actions", label: "disciplinary action" },
  { table: "performance_reviews", label: "performance review" },
  { table: "performance_goals", label: "performance goal" },
  { table: "approval_requests", label: "approval request" },
  { table: "tasks", label: "task" },
  { table: "targets", label: "target" },
  { table: "target_task_updates", label: "target update" },
  { table: "employee_documents", label: "document" },
  { table: "document_signatures", label: "e-signature" },
  { table: "document_signers", label: "document to sign" },
  { table: "asset_assignments", label: "asset assignment" },
  { table: "asset_assignment_claims", label: "asset claim" },
  { table: "asset_requisitions", label: "asset requisition" },
  { table: "vehicle_requisitions", label: "ride" },
  { table: "job_edit_requests", label: "Job Edit request" },
  { table: "job_submissions", label: "Job Final Submit" },
  { table: "budget_submissions", label: "Budget Final Submit" },
  { table: "chat_messages", label: "chat message" }
];

// The foreign keys from those tables to users (table, column, constraint, rules).
async function keptKeys(q: (sql: string, params?: any[]) => Promise<any[]>): Promise<{ t: string; col: string; name: string; del: string; upd: string }[]> {
  const rows: any[] =
    (await q(
      `SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS col, k.CONSTRAINT_NAME AS name, r.DELETE_RULE AS del, r.UPDATE_RULE AS upd
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'users'
          AND k.TABLE_NAME IN (${KEPT_USER_RECORDS.map(() => "?").join(", ")}) /*unscoped*/`,
      KEPT_USER_RECORDS.map((k) => k.table)
    )) || [];
  return rows.map((r) => ({ t: String(r.t), col: String(r.col), name: String(r.name), del: String(r.del), upd: String(r.upd) }));
}

export async function ensureUserRecordsGuard(dbPool: any): Promise<void> {
  try {
    const q = async (sql: string, params?: any[]) => ((await dbPool.query(sql.replace("/*unscoped*/", ""), params))[0] as any[]) || [];
    for (const fk of (await keptKeys(q)).filter((k) => k.del === "CASCADE")) {
      const t = fk.t.replace(/`/g, "");
      const col = fk.col.replace(/`/g, "");
      const name = fk.name.replace(/`/g, "");
      const onUpdate = ["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"].includes(fk.upd) ? fk.upd : "RESTRICT";
      const keep = `fk_keepu_${t}_${col}`.slice(0, 64);
      try {
        // The RESTRICT key goes on first, then the CASCADE one comes off, so
        // the records are never unguarded in between.
        const has = await q("SELECT COUNT(*) AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?", [t, keep]);
        if (!Number(has?.[0]?.n || 0)) {
          await dbPool.query(`ALTER TABLE \`${t}\` ADD CONSTRAINT \`${keep}\` FOREIGN KEY (\`${col}\`) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE ${onUpdate}`);
        }
        await dbPool.query(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${name}\``);
        console.log(`🔒 ${t}.${col}: a login with these records can no longer be deleted`);
      } catch (err: any) {
        console.warn(`⚠️ Could not protect ${t}.${col} from user deletes: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.warn("⚠️ User records guard: " + err.message);
  }
}

// What still points at this login among KEPT_USER_RECORDS (through any of
// the foreign-key columns; tables that don't exist here are skipped).
export async function keptUserRecordsOf(queryDB: QueryDB, userId: number): Promise<{ label: string; count: number }[]> {
  const keys = await keptKeys(async (sql, params) => ((await queryDB(sql, params).catch(() => [])) as any[]) || []);
  const byLabel = new Map<string, number>();
  for (const k of KEPT_USER_RECORDS) {
    const cols = [...new Set(keys.filter((x) => x.t === k.table).map((x) => x.col))];
    if (!cols.length) continue;
    const where = cols.map((c) => `\`${c.replace(/`/g, "")}\` = ?`).join(" OR ");
    const rows: any[] | null = await queryDB(`/*unscoped*/ SELECT COUNT(*) AS n FROM \`${k.table}\` WHERE ${where}`, cols.map(() => userId)).catch(() => null);
    const n = Number(rows?.[0]?.n || 0);
    if (n > 0) byLabel.set(k.label, (byLabel.get(k.label) || 0) + n);
  }
  return [...byLabel.entries()].map(([label, count]) => ({ label, count }));
}
