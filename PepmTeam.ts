/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PEPM project teams.
//
// Everyone given a Project (Admin Panel -> Users -> Manage Projects, i.e.
// user_project_permissions) is that Project's team. The team works on the
// Project's PEPM entries together, exactly as when two engineers shared one
// project login:
//   - every member sees and changes every entry of the Project (same rules
//     as before: full edit until Final Submit, then Delivery Date / Job Edit);
//   - a Final Submit locks the Project for the whole team — a Budget Final
//     Submit locks that Budget in every Project the submitter works on
//     (budget_project_locks), a Job Final Submit locks that Job;
//   - Job Nos run per Project within a Budget (one JOB-0001, 0002… series);
//   - an MPR No used by a team member can be used again by the team for the
//     rest of its Qty (it stays closed to other Projects, as before).
// Taking a Project away takes its entries away with it — even the ones that
// person entered. entries.created_by stays the person who entered the row
// ("Entered by").
//
// Admins / the Superadmin don't need a Project to enter (POST /api/entries
// lets them), so for them their own entries count too.

type Q = (sql: string, params?: any[]) => Promise<any>;

const isAdminRole = (user: any) => user?.role === "admin" || user?.role === "superadmin";

export async function ensurePepmTeamSchema(queryDB: Q): Promise<void> {
  // One row per (Budget, Project) that a Budget Final Submit has locked.
  // budget_submissions keeps who submitted (Admin -> Submissions panel);
  // this table is what the lock checks read.
  await queryDB(`
    CREATE TABLE IF NOT EXISTS budget_project_locks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      budget_id INT NOT NULL,
      project_id INT NOT NULL,
      user_id INT NOT NULL,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_budget_project (budget_id, project_id),
      KEY idx_bpl_user (budget_id, user_id)
    )
  `);
  // Once, and harmless to repeat: every Budget Final Submit made before
  // project teams locks the Projects of that person's entries in the Budget —
  // exactly the entries it locked until now.
  await queryDB(`
    INSERT IGNORE INTO budget_project_locks (budget_id, project_id, user_id, submitted_at)
    SELECT DISTINCT bs.budget_id, e.project_id, bs.user_id, bs.submitted_at
      FROM budget_submissions bs
      JOIN entries e ON e.budget_id = bs.budget_id AND e.created_by = bs.user_id AND e.deleted_at IS NULL
     WHERE NOT EXISTS (SELECT 1 FROM budget_project_locks l WHERE l.budget_id = bs.budget_id AND l.user_id = bs.user_id)
  `);
}

/** The Projects an account works on (its team memberships). */
export async function projectIdsOf(queryDB: Q, userId: number): Promise<number[]> {
  const rows: any[] = (await queryDB("SELECT project_id FROM user_project_permissions WHERE user_id = ?", [userId])) || [];
  return rows.map((r) => Number(r.project_id));
}

/**
 * SQL for "this entry belongs to the caller's team(s)", on the alias given.
 * A plain User: the entry's Project is one of theirs. An Admin / Superadmin:
 * that, or they entered it themselves.
 */
export function teamScopeSql(alias: string, user: any): { sql: string; params: any[] } {
  const inProjects = `${alias}.project_id IN (SELECT upp.project_id FROM user_project_permissions upp WHERE upp.user_id = ?)`;
  if (isAdminRole(user)) return { sql: `(${inProjects} OR ${alias}.created_by = ?)`, params: [Number(user.id), Number(user.id)] };
  return { sql: inProjects, params: [Number(user.id)] };
}

/** May this account work on an entry of this Project (entered by createdBy)? */
export async function onTeam(queryDB: Q, user: any, projectId: any, createdBy?: any): Promise<boolean> {
  if (!user) return false;
  if (isAdminRole(user) && createdBy !== undefined && Number(createdBy) === Number(user.id)) return true;
  if (!projectId) return false;
  const rows: any[] = (await queryDB("SELECT id FROM user_project_permissions WHERE user_id = ? AND project_id = ? LIMIT 1", [Number(user.id), Number(projectId)])) || [];
  return rows.length > 0;
}

/** The Project a Job's entries belong to (a Job is entered for one Project). */
export async function jobProjectId(queryDB: Q, jobId: any): Promise<number | null> {
  const rows: any[] = (await queryDB("SELECT project_id FROM entries WHERE job_id = ? ORDER BY deleted_at IS NOT NULL, id ASC LIMIT 1", [Number(jobId)])) || [];
  return rows.length ? Number(rows[0].project_id) : null;
}

/** Has a Budget Final Submit locked this Budget for this Project's team? */
export async function isProjectLocked(queryDB: Q, budgetId: any, projectId: any): Promise<boolean> {
  if (!budgetId || !projectId) return false;
  const rows: any[] = (await queryDB("SELECT id FROM budget_project_locks WHERE budget_id = ? AND project_id = ? LIMIT 1", [Number(budgetId), Number(projectId)])) || [];
  return rows.length > 0;
}

/** Is a Job Final Submitted (by any team member)? */
export async function isJobSubmitted(queryDB: Q, jobId: any): Promise<boolean> {
  if (!jobId) return false;
  const rows: any[] = (await queryDB("SELECT id FROM job_submissions WHERE job_id = ? LIMIT 1", [Number(jobId)])) || [];
  return rows.length > 0;
}

/** An entry is locked when its Project's Budget or its Job was Final Submitted. */
export async function isEntryLocked(queryDB: Q, budgetId: any, jobId: any, projectId: any): Promise<boolean> {
  return (await isProjectLocked(queryDB, budgetId, projectId)) || (await isJobSubmitted(queryDB, jobId));
}

/**
 * The Projects a Budget Final Submit by this account locks: the ones it works
 * on that the Budget has rows for, plus any it has entries in (an Admin's own).
 */
export async function projectsToLock(queryDB: Q, user: any, budgetId: number): Promise<number[]> {
  const ids = new Set<number>();
  const mine: any[] =
    (await queryDB(
      `SELECT DISTINCT p.id FROM projects p
         JOIN budget_items bi ON bi.budget_id = ? AND LOWER(TRIM(bi.project_name)) = LOWER(TRIM(p.project_name))
         JOIN user_project_permissions upp ON upp.project_id = p.id AND upp.user_id = ?`,
      [budgetId, Number(user.id)]
    )) || [];
  for (const r of mine) ids.add(Number(r.id));
  const own: any[] = (await queryDB("SELECT DISTINCT project_id FROM entries WHERE budget_id = ? AND created_by = ? AND deleted_at IS NULL", [budgetId, Number(user.id)])) || [];
  for (const r of own) ids.add(Number(r.project_id));
  return [...ids];
}

/**
 * After an entry is deleted: a Final Submit with nothing left behind it lifts
 * by itself (as before, now per Project) — the Job's when the Job is empty,
 * the Budget's for this Project when the Project has no entry left in it.
 */
export async function unlockIfEmpty(queryDB: Q, budgetId: any, projectId: any): Promise<void> {
  if (!budgetId || !projectId) return;
  try {
    const jobLocks: any[] =
      (await queryDB(
        `SELECT DISTINCT js.job_id FROM job_submissions js
          WHERE js.budget_id = ? AND EXISTS (SELECT 1 FROM entries e WHERE e.job_id = js.job_id AND e.project_id = ?)`,
        [budgetId, projectId]
      )) || [];
    for (const js of jobLocks) {
      const left: any[] = (await queryDB("SELECT id FROM entries WHERE job_id = ? AND deleted_at IS NULL LIMIT 1", [js.job_id])) || [];
      if (left.length === 0) await queryDB("DELETE FROM job_submissions WHERE job_id = ?", [js.job_id]);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not auto-unlock Job submissions for budget " + budgetId + ": " + err.message);
  }
  try {
    const left: any[] = (await queryDB("SELECT id FROM entries WHERE budget_id = ? AND project_id = ? AND deleted_at IS NULL LIMIT 1", [budgetId, projectId])) || [];
    if (left.length > 0) return;
    const locks: any[] = (await queryDB("SELECT user_id FROM budget_project_locks WHERE budget_id = ? AND project_id = ?", [budgetId, projectId])) || [];
    if (!locks.length) return;
    await queryDB("DELETE FROM budget_project_locks WHERE budget_id = ? AND project_id = ?", [budgetId, projectId]);
    // The submission record goes once none of its Projects is locked any more.
    for (const l of locks) {
      const still: any[] = (await queryDB("SELECT id FROM budget_project_locks WHERE budget_id = ? AND user_id = ? LIMIT 1", [budgetId, l.user_id])) || [];
      if (!still.length) await queryDB("DELETE FROM budget_submissions WHERE budget_id = ? AND user_id = ?", [budgetId, l.user_id]);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not auto-unlock budget " + budgetId + " for project " + projectId + ": " + err.message);
  }
}

/** Admin -> Submissions -> Unlock: lifts everything one account's Budget Final Submit locked. */
export async function unlockBudgetSubmission(queryDB: Q, budgetId: number, userId: number): Promise<void> {
  await queryDB("DELETE FROM budget_project_locks WHERE budget_id = ? AND user_id = ?", [budgetId, userId]);
  await queryDB("DELETE FROM budget_submissions WHERE budget_id = ? AND user_id = ?", [budgetId, userId]);
}
