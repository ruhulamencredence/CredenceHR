// How many days a Leave Application takes off the balance.
//
// Each Leave Type's policy (Leave Manage -> Leave Policies, "Weekends &
// holidays inside the leave") decides it:
//   count_off_days = true  -> every calendar day from Start to End (the old
//                              rule, and still the default);
//   count_off_days = false -> only the applicant's working days: their branch
//                              group's Holiday Calendar with their Duty Roster
//                              laid over it, the same calendar payroll counts
//                              working days from.
// Half Day takes 0.5 off the total (floored at 0.5), as before.
import { getEmployeeBranchTypeMap, getHolidayMap, type HolidayAppliesTo } from "./holidayRoutes";
import { loadRoster } from "./RosterRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

// Every "YYYY-MM-DD" from..to, both ends included.
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 1000) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// The account's Weekend/Holiday/rostered-off dates in from..to.
export async function offDatesFor(queryDB: QueryDB, userId: number, from: string, to: string): Promise<Set<string>> {
  const group: HolidayAppliesTo = (await getEmployeeBranchTypeMap(queryDB, userId)).get(Number(userId)) || "head_office";
  const base = await getHolidayMap(queryDB, from, to, group);
  const emp: any[] = (await queryDB("SELECT id FROM all_employees WHERE user_id = ? LIMIT 1", [userId]).catch(() => [])) || [];
  if (!emp.length) return new Set(base.keys());
  const empId = Number(emp[0].id);
  const map = (await loadRoster(queryDB, from, to, [empId])).holidaysFor(empId, base);
  return new Set([...map.keys()].filter((d) => d >= from && d <= to));
}

export async function leaveDayCount(
  queryDB: QueryDB,
  userId: number,
  from: string,
  to: string,
  halfDay: boolean,
  countOffDays: boolean
): Promise<{ dayCount: number; offDays: string[] }> {
  const dates = datesBetween(from, to);
  const off = countOffDays ? new Set<string>() : await offDatesFor(queryDB, userId, from, to);
  const offDays = dates.filter((d) => off.has(d));
  const days = dates.length - offDays.length;
  const dayCount = days <= 0 ? 0 : halfDay ? Math.max(0.5, days - 0.5) : days;
  return { dayCount, offDays };
}
