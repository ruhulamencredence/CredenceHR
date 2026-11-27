/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Joiner & Probation leave rules (Leave Manage layer "joiner_rules").
// Per Leave Type (Casual / Sick / Without Pay), two switches on
// leave_category_policies, both OFF by default (nothing changes until a Leave
// Manager sets them):
//   probation_mode   what a person on Probation (Employee -> Job Base) gets:
//                    "full" (no limit, the default), "prorata", "none".
//   joiner_prorata   1 = someone who joined during the year gets only the
//                    months left, not the whole year.
// Pro-rata = the Balance Workflow's full-year days x months left / 12, with the
// joining month counted whole, rounded to the nearest half day.
// The rules shape the balance a person is GIVEN when they get one (a new
// account's first balance, the year rollover) and what HR is offered on
// Confirmation (Job Base: Probation -> anything else). Balances already saved
// are never rewritten by them. The year is the calendar year, the same one
// "leave used this year" and the Dashboard card use.

export type ProbationMode = "full" | "prorata" | "none";
export interface JoinerRule {
  probation_mode: ProbationMode;
  joiner_prorata: boolean;
}
export const JOINER_KEYS = ["casual_leave", "sick_leave", "leave_without_pay"] as const;
export type JoinerKey = (typeof JOINER_KEYS)[number];
const POLICY_KEY: Record<JoinerKey, string> = { casual_leave: "casual", sick_leave: "sick", leave_without_pay: "without_pay" };
export const DEFAULT_JOINER_RULE: JoinerRule = { probation_mode: "full", joiner_prorata: false };

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export const isProbation = (emp: any): boolean => String(emp?.job_base || "").trim().toLowerCase() === "probation";

const ymdOf = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

// Months of the calendar year of `asOf` from the month of `from` to December,
// the starting month counted whole. 12 when `from` is before that year.
export function monthsLeftFrom(from: string | null, asOf: string): number {
  const year = Number(asOf.slice(0, 4));
  if (!from) return 12;
  const fy = Number(from.slice(0, 4));
  if (fy < year) return 12;
  if (fy > year) return 0;
  return Math.max(0, 13 - Number(from.slice(5, 7)));
}

export const roundHalf = (n: number) => Math.round(n * 2) / 2;
export const prorata = (full: number, months: number) => roundHalf((full * months) / 12);

export async function loadJoinerRules(queryDB: QueryDB): Promise<Record<JoinerKey, JoinerRule>> {
  const out: Record<JoinerKey, JoinerRule> = {
    casual_leave: { ...DEFAULT_JOINER_RULE },
    sick_leave: { ...DEFAULT_JOINER_RULE },
    leave_without_pay: { ...DEFAULT_JOINER_RULE }
  };
  const rows: any[] = (await queryDB("SELECT category_key, probation_mode, joiner_prorata FROM leave_category_policies WHERE category_key IN ('casual','sick','without_pay')").catch(() => [])) || [];
  for (const r of rows) {
    const key = (Object.keys(POLICY_KEY) as JoinerKey[]).find((k) => POLICY_KEY[k] === String(r.category_key));
    if (!key) continue;
    const mode = String(r.probation_mode || "full");
    out[key] = { probation_mode: mode === "prorata" || mode === "none" ? mode : "full", joiner_prorata: !!Number(r.joiner_prorata || 0) };
  }
  return out;
}

export const joinerRulesOn = (rules: Record<JoinerKey, JoinerRule>) => JOINER_KEYS.some((k) => rules[k].probation_mode !== "full" || rules[k].joiner_prorata);

// What one person is given of a Leave Type today, from the Workflow's full-year days.
export function joinerValue(full: number, rule: JoinerRule, emp: any, today: string): number {
  if (!emp) return full;
  const year = today.slice(0, 4);
  const joined = ymdOf(emp.joining_date);
  const joinedThisYear = !!joined && joined.slice(0, 4) === year;
  const months = joinedThisYear ? monthsLeftFrom(joined, today) : 12;
  if (isProbation(emp)) {
    if (rule.probation_mode === "none") return 0;
    if (rule.probation_mode === "prorata") return prorata(full, months);
    // "full": no probation limit; the joiner rule below still applies
  }
  if (rule.joiner_prorata && joinedThisYear) return prorata(full, months);
  return full;
}
