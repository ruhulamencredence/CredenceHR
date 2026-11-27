/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Late Attendance Policy -> days of pay deducted — the same rule as the
// server's lateDeductionsFor (PayrollRoutes.ts), for screens that recount
// after a waiver. extreme_lates_per_deduction_day = 0: Extreme Delay has no
// deduction of its own; its days count together with the Delay days (every
// lates_per_deduction_day lates of either kind = 1 day). 1 or more: each kind
// on its own count.
export interface LatePolicyLike {
  lates_per_deduction_day: number;
  extreme_lates_per_deduction_day: number | null | undefined;
}

export const latesCombined = (p: LatePolicyLike | null | undefined): boolean =>
  !!p && p.extreme_lates_per_deduction_day != null && Number(p.extreme_lates_per_deduction_day) === 0;

export function lateDeductions(late: number, extreme: number, p: LatePolicyLike | null | undefined): { late: number; extreme: number } {
  if (!p) return { late: 0, extreme: 0 };
  const per = Math.max(1, Math.round(Number(p.lates_per_deduction_day)) || 1);
  if (latesCombined(p)) return { late: Math.floor((late + extreme) / per), extreme: 0 };
  const extremePer = Math.max(1, Math.round(Number(p.extreme_lates_per_deduction_day)) || 1);
  return { late: Math.floor(late / per), extreme: Math.floor(extreme / extremePer) };
}
