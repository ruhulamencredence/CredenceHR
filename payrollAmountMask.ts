/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll's "See salary amounts" layer (payroll -> salary_amounts). Without
// it, every Payroll API answer has its amounts replaced by "*****" here, on
// the server — so no screen, export, Assistant answer or direct API call can
// show them — and nothing in Payroll can be changed (a form full of hidden
// amounts would save them back as 0).
//
// Masking is deny-by-default: EVERY number in the answer (and every string
// that is just a number — MySQL returns DECIMAL that way) is hidden, except
// under keys that plainly are not money: ids, counts, days, hours, dates,
// months, years, steps, flags, percentages... A new money field is therefore
// hidden without anyone having to list it here.

export const MASK = "*****";

// Keys whose numbers are not money.
const SAFE_KEY =
  /(^id$|_id$|^ids$|_ids$|^uid$|^pk$|_pk$|days?$|_days?_|^days|hours?$|_hours?_|minutes?$|mins?$|count$|_count|^count|^n$|^num_|_no$|^no$|month|year|date|_at$|time$|step|order|index|^idx|version|^page|limit|offset|^total_(rows|pages|count|employees|people|staff)|^is_|^has_|^can_|qty|quantity|pin$|employees$|headcount|people$|staff$|members$|percent|pct$|_pct|ratio|^late|_late|absent|present|leave|holiday|weekend|lwp|grade|level|^age$|attendance|^seq|sort|rank|priority|^status|_status$|layer|^total_steps|current_step|installments?_(left|total|count|paid|done)|^installments$|tenure|^months|^weeks)/i;

// A money word in the key wins over a safe one: late_deduction,
// leave_encashment, absent_deduction, holiday_allowance… are money.
const MONEY_KEY =
  /(amount|amt|deduct|salary|wage|earning|allowance|bonus|incentive|encash|fine|penalty|gross|basic|^net|_net|net_|payable|payout|paid_amount|pay_amount|total(?!_(rows|pages|count|employees|people|staff|days|steps|hours))|^sum|_sum|subtotal|cost|rate|fee|tax|fund|balance|outstanding|principal|install(ment)?_amount|arrear|advance|loan|overtime_pay|ot_pay|house_rent|medical|conveyance|food|mobile_bill|festival|difference|^diff|_diff)/i;

const isSafeKey = (key: string) => SAFE_KEY.test(key) && !MONEY_KEY.test(key);

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

export function maskPayrollAmounts(value: any, key = ""): any {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => maskPayrollAmounts(v, key));
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskPayrollAmounts(v, k);
    return out;
  }
  if (typeof value === "number") return isSafeKey(key) ? value : MASK;
  if (typeof value === "string" && NUMERIC_STRING.test(value.trim())) return isSafeKey(key) ? value : MASK;
  return value;
}

// Payroll routes that change nothing and may still be used without the layer.
const ALLOWED_WRITES = new Set(["/api/payroll/access-log"]);
// Payroll answers that are files (not JSON), so they cannot be masked: the
// Approval tab's attached scans / sheets.
const FILE_ROUTE = /^\/api\/payroll\/approval\/files\/\d+$/;

/**
 * Express middleware for "/api/payroll": authenticates (the route does again),
 * then for an account without the layer refuses changes and file downloads,
 * and masks every JSON answer.
 */
export function payrollAmountGuard(deps: {
  authenticateToken: (req: any, res: any, next: () => void) => any;
  canSeeAmounts: (user: any) => Promise<boolean>;
}) {
  return (req: any, res: any, next: () => void) =>
    deps.authenticateToken(req, res, async () => {
      let ok = false;
      try {
        ok = await deps.canSeeAmounts(req.user);
      } catch {
        ok = false;
      }
      if (ok) return next();
      const path = String(req.originalUrl || "").split("?")[0];
      const reading = req.method === "GET" || req.method === "HEAD";
      if (!reading && !ALLOWED_WRITES.has(path)) {
        return res.status(403).json({
          error: 'Changing Payroll needs the "See salary amounts" permission (Admin Panel -> Users -> Module Access -> Payroll).',
          amounts_hidden: true
        });
      }
      if (reading && FILE_ROUTE.test(path)) {
        return res.status(403).json({ error: 'This file needs the "See salary amounts" permission.', amounts_hidden: true });
      }
      const json = res.json.bind(res);
      res.json = (body: any) => json(maskPayrollAmounts(body));
      res.setHeader("X-Payroll-Amounts", "hidden");
      next();
    });
}
