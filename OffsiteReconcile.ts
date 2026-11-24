/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Off-site In (Remote Attendance given outside the project circle) waits for
// approval as an attendance correction (offsite_in = 1). The day's In that
// already counts is the EARLIEST of: an In in `attendance` (a Project row,
// an approved off-site In included) and the office machine's first punch.
// Rules kept here:
//   * a valid In inside the circle (or an office punch) is never blocked by a
//     waiting off-site In;
//   * an off-site In that cannot change the day (a valid In at the same time
//     or earlier already counts) is closed by itself ("superseded"), and the
//     person withdraws their own with "Withdraw" — both end as status
//     'rejected' with a remark saying which, so nothing piles up;
//   * approving an off-site In keeps the earlier In (server.ts
//     finalizeAttendanceCorrection).
// A request that also carries an off-site Out is left to the approver.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type CreateAlert = ((queryDB: QueryDB, a: any) => Promise<any>) | null;

export const dayOf = (v: any): string => {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v ?? "").slice(0, 10);
};

const asTime = (v: any): number => (v ? new Date(v).getTime() : NaN);

export async function validInFor(queryDB: QueryDB, userId: number, day: string): Promise<{ at: Date; source: "project" | "office" } | null> {
  const proj: any[] = (await queryDB("SELECT MIN(check_in_at) AS t FROM attendance WHERE user_id = ? AND attendance_date = ? AND check_in_at IS NOT NULL", [userId, day]).catch(() => [])) || [];
  let best: { at: Date; source: "project" | "office" } | null = proj[0]?.t ? { at: new Date(proj[0].t), source: "project" } : null;
  const emp: any[] = (await queryDB("SELECT zk_device_pin FROM all_employees WHERE user_id = ? AND zk_device_pin IS NOT NULL LIMIT 1", [userId]).catch(() => [])) || [];
  if (emp.length) {
    const z: any[] = (await queryDB("SELECT MIN(punch_time) AS t FROM zk_attendance_logs WHERE device_user_pin = ? AND DATE(punch_time) = ?", [emp[0].zk_device_pin, day]).catch(() => [])) || [];
    if (z[0]?.t && (!best || asTime(z[0].t) < best.at.getTime())) best = { at: new Date(z[0].t), source: "office" };
  }
  return best;
}

const hm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" });

// Ends a waiting off-site request without approving it. 'rejected' is the only
// ending the tables have, so the remark tells the story.
export async function closeOffsiteRequest(
  queryDB: QueryDB,
  createAlert: CreateAlert,
  id: number,
  how: "withdrawn" | "superseded",
  detail?: string
): Promise<boolean> {
  const remark = how === "withdrawn" ? "[Withdrawn by the employee]" : `[Closed by the system] ${detail || "An earlier In already counts for this day."}`;
  const r: any = await queryDB("UPDATE attendance_corrections SET status = 'rejected', admin_remarks = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'", [remark, id]);
  if (typeof r?.affectedRows === "number" && r.affectedRows === 0) return false;
  await queryDB("UPDATE approval_requests SET status = 'rejected' WHERE source_type = 'attendance_correction' AND source_id = ? AND status = 'pending'", [id]).catch(() => {});
  if (how === "superseded" && createAlert) {
    const c: any = (((await queryDB("SELECT user_id, attendance_date FROM attendance_corrections WHERE id = ?", [id]).catch(() => [])) as any[]) || [])[0];
    if (c) {
      await createAlert(queryDB, {
        userId: Number(c.user_id),
        type: "hr_action",
        title: "Off-site In closed",
        message: `Your off-site In for ${dayOf(c.attendance_date)} was closed: ${detail || "an earlier In already counts for the day"}. No approval is needed.`,
        relatedType: "attendance_correction",
        relatedId: Number(id)
      }).catch(() => {});
    }
  }
  return true;
}

// Closes every waiting In-only off-site request (of one person, or of everyone)
// whose day already has a valid In at the same time or earlier. Returns how many.
export async function reconcileOffsiteIn(queryDB: QueryDB, createAlert: CreateAlert, opts: { userId?: number; sinceDays?: number } = {}): Promise<number> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 7) * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
  const params: any[] = [since];
  let sql = `SELECT id, user_id, attendance_date, requested_check_in_at FROM attendance_corrections
              WHERE status = 'pending' AND offsite_in = 1 AND COALESCE(offsite_out, 0) = 0 AND requested_check_out_at IS NULL
                AND requested_check_in_at IS NOT NULL AND attendance_date >= ?`;
  if (opts.userId) {
    sql += " AND user_id = ?";
    params.push(opts.userId);
  }
  const rows: any[] = (await queryDB(sql, params).catch(() => [])) || [];
  let closed = 0;
  for (const c of rows) {
    const valid = await validInFor(queryDB, Number(c.user_id), dayOf(c.attendance_date));
    if (valid && valid.at.getTime() <= asTime(c.requested_check_in_at)) {
      if (await closeOffsiteRequest(queryDB, createAlert, Number(c.id), "superseded", `your ${valid.source === "office" ? "office" : "project"} In at ${hm(valid.at)} already counts`)) closed++;
    }
  }
  return closed;
}
