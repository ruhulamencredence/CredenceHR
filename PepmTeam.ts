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
//
// Entry sharing (projects.entry_scope, Admin Panel -> Projects -> Edit):
//   - "team" (default): as above — the whole team shares every entry.
//   - "own": each member sees and works on only the entries they made; a
//     Final Submit locks only theirs.
//   - "home" (By home project — e.g. Central Inventory, which everyone is
//     given): each entry says which of its maker's own Projects it is for
//     (entries.for_project_id, "For: Anamika"). That Project's team shares
//     it; other teams on the same Project don't see it. With no For (the
//     maker has no other Project) only the maker sees it. For is set when
//     the entry is made and doesn't follow later transfers.
// An entry's "share key" names the group that shares it: '' (the whole
// Project), 'u:<user id>' (one person) or 'f:<project id>' (a home team).
// Final Submit locks are kept per (Budget, Project, share key).

type Q = (sql: string, params?: any[]) => Promise<any>;

const isAdminRole = (user: any) => user?.role === "admin" || user?.role === "superadmin";

async function hasColumn(queryDB: Q, table: string, column: string): Promise<boolean> {
  const rows: any[] =
    (await queryDB(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? /*unscoped*/",
      [table, column]
    )) || [];
  return rows.length > 0;
}

export const ENTRY_SCOPES = ["team", "own", "home"] as const;
export type EntryScope = (typeof ENTRY_SCOPES)[number];

export async function ensurePepmTeamSchema(queryDB: Q): Promise<void> {
  if (!(await hasColumn(queryDB, "projects", "entry_scope"))) {
    await queryDB("ALTER TABLE projects ADD COLUMN entry_scope VARCHAR(10) NOT NULL DEFAULT 'team'");
  }
  if (!(await hasColumn(queryDB, "entries", "for_project_id"))) {
    await queryDB("ALTER TABLE entries ADD COLUMN for_project_id INT NULL");
    await queryDB("ALTER TABLE entries ADD INDEX idx_entries_for_project (for_project_id)").catch(() => {});
  }
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
      share_key VARCHAR(40) NOT NULL DEFAULT '',
      UNIQUE KEY unique_budget_project_share (budget_id, project_id, share_key),
      KEY idx_bpl_user (budget_id, user_id)
    )
  `);
  // Older tables: one lock per (Budget, Project) — now per share key too.
  if (!(await hasColumn(queryDB, "budget_project_locks", "share_key"))) {
    await queryDB("ALTER TABLE budget_project_locks ADD COLUMN share_key VARCHAR(40) NOT NULL DEFAULT ''");
  }
  const idx: any[] =
    (await queryDB(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'budget_project_locks' AND INDEX_NAME = 'unique_budget_project' /*unscoped*/"
    )) || [];
  if (idx.length) {
    await queryDB("ALTER TABLE budget_project_locks ADD UNIQUE KEY unique_budget_project_share (budget_id, project_id, share_key)").catch(() => {});
    await queryDB("ALTER TABLE budget_project_locks DROP INDEX unique_budget_project").catch(() => {});
  }
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

/** A Project's Entry sharing ("team" when unset or unknown). */
export async function projectScope(queryDB: Q, projectId: any): Promise<EntryScope> {
  if (!projectId) return "team";
  const rows: any[] = (await queryDB("SELECT entry_scope FROM projects WHERE id = ? LIMIT 1", [Number(projectId)])) || [];
  const v = String(rows[0]?.entry_scope || "team");
  return (ENTRY_SCOPES as readonly string[]).includes(v) ? (v as EntryScope) : "team";
}

/** The group that shares an entry (see the top of this file). */
export function shareKeyOf(scope: EntryScope, createdBy: any, forProjectId: any): string {
  if (scope === "own") return `u:${Number(createdBy)}`;
  if (scope === "home") return forProjectId ? `f:${Number(forProjectId)}` : `u:${Number(createdBy)}`;
  return "";
}

export async function entryShareKey(queryDB: Q, projectId: any, createdBy: any, forProjectId: any): Promise<string> {
  return shareKeyOf(await projectScope(queryDB, projectId), createdBy, forProjectId);
}

/** The same share key in SQL, for an entry alias and its Project's alias. */
export function shareKeySql(e: string, p: string): string {
  return `(CASE COALESCE(${p}.entry_scope, 'team')
      WHEN 'own' THEN CONCAT('u:', ${e}.created_by)
      WHEN 'home' THEN IF(${e}.for_project_id IS NULL, CONCAT('u:', ${e}.created_by), CONCAT('f:', ${e}.for_project_id))
      ELSE '' END)`;
}

/**
 * An account's home Projects: the ones it works on that are not themselves
 * "By home project" — what a Central Inventory entry can be For.
 */
export async function homeProjectsOf(queryDB: Q, userId: any): Promise<{ id: number; project_name: string }[]> {
  const rows: any[] =
    (await queryDB(
      `SELECT p.id, p.project_name FROM user_project_permissions upp JOIN projects p ON p.id = upp.project_id
        WHERE upp.user_id = ? AND COALESCE(p.entry_scope, 'team') <> 'home' ORDER BY p.project_name`,
      [Number(userId)]
    )) || [];
  return rows.map((r) => ({ id: Number(r.id), project_name: String(r.project_name) }));
}

/**
 * SQL for "this entry belongs to the caller's team(s)", on the alias given.
 * The entry's Project must be one of theirs, and then by its Entry sharing:
 * "team" — any entry; "own" — the ones they made; "home" — the ones they
 * made or that are For one of their own (non-"home") Projects. An Admin /
 * Superadmin also sees the ones they entered themselves.
 */
export function teamScopeSql(alias: string, user: any): { sql: string; params: any[] } {
  const uid = Number(user.id);
  const scopeOf = `COALESCE((SELECT sp.entry_scope FROM projects sp WHERE sp.id = ${alias}.project_id), 'team')`;
  const inProjects = `${alias}.project_id IN (SELECT upp.project_id FROM user_project_permissions upp WHERE upp.user_id = ?)`;
  const shared = `(${scopeOf} = 'team' OR ${alias}.created_by = ?
      OR (${scopeOf} = 'home' AND ${alias}.for_project_id IN (
            SELECT hu.project_id FROM user_project_permissions hu JOIN projects hp ON hp.id = hu.project_id
             WHERE hu.user_id = ? AND COALESCE(hp.entry_scope, 'team') <> 'home')))`;
  const team = `(${inProjects} AND ${shared})`;
  if (isAdminRole(user)) return { sql: `(${team} OR ${alias}.created_by = ?)`, params: [uid, uid, uid, uid] };
  return { sql: team, params: [uid, uid, uid] };
}

/**
 * May this account work on an entry of this Project (entered by createdBy,
 * For forProjectId)? Without createdBy: may it work on the Project at all
 * (making a new entry).
 */
export async function onTeam(queryDB: Q, user: any, projectId: any, createdBy?: any, forProjectId?: any): Promise<boolean> {
  if (!user) return false;
  const mine = createdBy !== undefined && createdBy !== null && Number(createdBy) === Number(user.id);
  if (isAdminRole(user) && mine) return true;
  if (!projectId) return false;
  const rows: any[] = (await queryDB("SELECT id FROM user_project_permissions WHERE user_id = ? AND project_id = ? LIMIT 1", [Number(user.id), Number(projectId)])) || [];
  if (!rows.length) return false;
  if (createdBy === undefined || createdBy === null) return true;
  const scope = await projectScope(queryDB, projectId);
  if (scope === "team" || mine) return true;
  if (scope === "own" || !forProjectId) return false;
  return (await homeProjectsOf(queryDB, user.id)).some((h) => h.id === Number(forProjectId));
}

/** The first entry of a Job: its Project, maker and For (a Job's entries share them). */
export async function jobEntryInfo(queryDB: Q, jobId: any): Promise<{ project_id: number | null; created_by: number | null; for_project_id: number | null }> {
  const rows: any[] =
    (await queryDB("SELECT project_id, created_by, for_project_id FROM entries WHERE job_id = ? ORDER BY deleted_at IS NOT NULL, id ASC LIMIT 1", [Number(jobId)])) || [];
  const r = rows[0];
  return {
    project_id: r?.project_id ? Number(r.project_id) : null,
    created_by: r?.created_by ? Number(r.created_by) : null,
    for_project_id: r?.for_project_id ? Number(r.for_project_id) : null
  };
}

/** The Project a Job's entries belong to (a Job is entered for one Project). */
export async function jobProjectId(queryDB: Q, jobId: any): Promise<number | null> {
  const rows: any[] = (await queryDB("SELECT project_id FROM entries WHERE job_id = ? ORDER BY deleted_at IS NOT NULL, id ASC LIMIT 1", [Number(jobId)])) || [];
  return rows.length ? Number(rows[0].project_id) : null;
}

/** Has a Budget Final Submit locked this Budget for this Project's team (that share key's group)? */
export async function isProjectLocked(queryDB: Q, budgetId: any, projectId: any, shareKey = ""): Promise<boolean> {
  if (!budgetId || !projectId) return false;
  const rows: any[] =
    (await queryDB("SELECT id FROM budget_project_locks WHERE budget_id = ? AND project_id = ? AND share_key = ? LIMIT 1", [Number(budgetId), Number(projectId), shareKey])) || [];
  return rows.length > 0;
}

/** Is a Job Final Submitted (by any team member)? */
export async function isJobSubmitted(queryDB: Q, jobId: any): Promise<boolean> {
  if (!jobId) return false;
  const rows: any[] = (await queryDB("SELECT id FROM job_submissions WHERE job_id = ? LIMIT 1", [Number(jobId)])) || [];
  return rows.length > 0;
}

/** An entry is locked when its Project's Budget or its Job was Final Submitted. */
export async function isEntryLocked(queryDB: Q, budgetId: any, jobId: any, projectId: any, shareKey = ""): Promise<boolean> {
  return (await isProjectLocked(queryDB, budgetId, projectId, shareKey)) || (await isJobSubmitted(queryDB, jobId));
}

/**
 * What a Budget Final Submit by this account locks: (Project, share key)
 * pairs — the Projects it works on that the Budget has rows for, plus any it
 * has entries in (an Admin's own). A "team" Project locks for the whole team;
 * "own" only the submitter's entries; "home" the groups of the submitter's
 * home teams (and their entries with no For).
 */
export async function projectsToLock(queryDB: Q, user: any, budgetId: number): Promise<{ projectId: number; shareKey: string }[]> {
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
  const homes = await homeProjectsOf(queryDB, user.id);
  const out: { projectId: number; shareKey: string }[] = [];
  for (const pid of ids) {
    const scope = await projectScope(queryDB, pid);
    if (scope === "team") out.push({ projectId: pid, shareKey: "" });
    else {
      out.push({ projectId: pid, shareKey: `u:${Number(user.id)}` });
      if (scope === "home") for (const h of homes) out.push({ projectId: pid, shareKey: `f:${h.id}` });
    }
  }
  return out;
}

/**
 * After an entry is deleted: a Final Submit with nothing left behind it lifts
 * by itself (as before, now per Project) — the Job's when the Job is empty,
 * the Budget's for this Project when the Project has no entry left in it.
 */
export async function unlockIfEmpty(queryDB: Q, budgetId: any, projectId: any, shareKey = ""): Promise<void> {
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
    const left: any[] =
      (await queryDB(
        `SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id
          WHERE e.budget_id = ? AND e.project_id = ? AND e.deleted_at IS NULL AND ${shareKeySql("e", "p")} = ? LIMIT 1`,
        [budgetId, projectId, shareKey]
      )) || [];
    if (left.length > 0) return;
    const locks: any[] = (await queryDB("SELECT user_id FROM budget_project_locks WHERE budget_id = ? AND project_id = ? AND share_key = ?", [budgetId, projectId, shareKey])) || [];
    if (!locks.length) return;
    await queryDB("DELETE FROM budget_project_locks WHERE budget_id = ? AND project_id = ? AND share_key = ?", [budgetId, projectId, shareKey]);
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

/**
 * A Project switched to "By home project": its existing entries with no For
 * get their maker's home Project when the maker has exactly one. Returns how
 * many were filled.
 */
export async function fillForFromHomes(queryDB: Q, projectId: number): Promise<number> {
  const rows: any[] =
    (await queryDB(
      `SELECT DISTINCT e.created_by FROM entries e WHERE e.project_id = ? AND e.for_project_id IS NULL AND e.created_by IS NOT NULL`,
      [projectId]
    )) || [];
  let filled = 0;
  for (const r of rows) {
    const homes = await homeProjectsOf(queryDB, r.created_by);
    if (homes.length !== 1) continue;
    const res: any = await queryDB("UPDATE entries SET for_project_id = ? WHERE project_id = ? AND created_by = ? AND for_project_id IS NULL", [
      homes[0].id,
      projectId,
      Number(r.created_by)
    ]);
    filled += Number(res?.affectedRows || 0);
  }
  return filled;
}

/**
 * The entries of a "By home project" Project that have no For although their
 * maker works on several Projects (Admin chooses one per person), plus how
 * many have none because the maker has no other Project.
 */
export async function forGaps(
  queryDB: Q,
  projectId: number
): Promise<{ people: { user_id: number; name: string; count: number; homes: { id: number; project_name: string }[] }[]; no_home: number }> {
  const rows: any[] =
    (await queryDB(
      `SELECT e.created_by AS user_id, u.name, COUNT(*) AS n FROM entries e LEFT JOIN users u ON u.id = e.created_by
        WHERE e.project_id = ? AND e.for_project_id IS NULL AND e.deleted_at IS NULL AND e.created_by IS NOT NULL
        GROUP BY e.created_by, u.name ORDER BY u.name`,
      [projectId]
    )) || [];
  const people: { user_id: number; name: string; count: number; homes: { id: number; project_name: string }[] }[] = [];
  let noHome = 0;
  for (const r of rows) {
    const homes = await homeProjectsOf(queryDB, r.user_id);
    if (homes.length === 0) noHome += Number(r.n);
    else people.push({ user_id: Number(r.user_id), name: String(r.name || "—"), count: Number(r.n), homes });
  }
  return { people, no_home: noHome };
}
