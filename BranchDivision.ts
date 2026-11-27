/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// An Employee's Division is the type of their Branch, nothing else:
// "Head Office" or "Project Side" (Admin Panel -> Branches -> Branch Type).
// It is set whenever a Branch is picked or changes (Edit Employee, Transfer,
// Merge Branch, a Branch's type, Employee import, joiner -> employee), and the
// Branches page has a one-off "Set Division from Branch" for the people already
// saved. An Employee with no Branch keeps whatever Division they had.
// The names keep the words the old Division reading looks for ("head",
// "project"), so Office / Project filters, Notices and Bill Disbursement
// group people exactly as before.

export const DIVISION_HEAD_OFFICE = "Head Office";
export const DIVISION_PROJECT_SIDE = "Project Side";

export const divisionOfBranchType = (branchType: any): string => (branchType === "project_site" ? DIVISION_PROJECT_SIDE : DIVISION_HEAD_OFFICE);

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

// Sets Division from the Branch for the given Branches' people or the given
// Employee rows (all_employees.id), only where it differs. Returns how many changed.
export async function syncDivision(queryDB: QueryDB, scope: { branchIds?: number[]; employeeIds?: number[] }): Promise<number> {
  const ids = (a?: number[]) => (a || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const branchIds = ids(scope.branchIds);
  const employeeIds = ids(scope.employeeIds);
  if (!branchIds.length && !employeeIds.length) return 0;
  const where: string[] = [];
  const params: any[] = [];
  if (branchIds.length) {
    where.push(`e.branch_id IN (${branchIds.map(() => "?").join(",")})`);
    params.push(...branchIds);
  }
  if (employeeIds.length) {
    where.push(`e.id IN (${employeeIds.map(() => "?").join(",")})`);
    params.push(...employeeIds);
  }
  const rows: any[] =
    (await queryDB(
      `SELECT e.id, e.division, b.branch_type FROM all_employees e JOIN branches b ON b.id = e.branch_id WHERE (${where.join(" OR ")})`,
      params
    ).catch(() => [])) || [];
  let changed = 0;
  for (const r of rows) {
    const want = divisionOfBranchType(r.branch_type);
    if ((r.division || "") === want) continue;
    await queryDB("UPDATE all_employees SET division = ? WHERE id = ?", [want, r.id]);
    changed++;
  }
  return changed;
}
