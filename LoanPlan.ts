/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Loans & Salary Advances: paying the money out, and how it is paid back.
//
//   1. Paying out. An approved loan (employee_advances) starts "waiting for
//      payment" (disbursement_status 'pending'); nothing is taken from the
//      salary yet. Accounts (Payroll layer "Accounts Pay") gives the money
//      and records it — date, Cash / Bank / bKash-Nagad / Cheque, reference
//      — with POST /api/payroll/advances/:id/disburse. The employee is told.
//      Loans from before this existed count as paid out already.
//
//   2. The repayment plan, per loan (Payroll module; PUT .../plan):
//        repay_start_month  first salary month anything is taken
//                           (default: the month after it was paid out)
//        repay_mode         'equal'  monthly_installment every month
//                           'lump'   everything left, in one salary
//                           'custom' repay_schedule {"2027-01": 10000, ...}
//        skip_months        months nothing is taken (["2027-04"])
//        settle_month       take everything left in that month
//      installmentFor() is the one rule every payroll calculation uses
//      (PayrollRoutes.ts: preview, bulk, single, edit) and the one the
//      recovery uses when a salary is paid (settlePaidPayroll), so what a
//      salary sheet shows is what is recovered.
//
//   3. Paid back outside the salary (cash / bank): Accounts records it
//      (POST .../repay); it counts toward the loan at once.
//
// Every step is written to loan_events (who, when, what) and shown on the
// loan, to Payroll and to the employee (My Loan / Advance).

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export const money = (v: any) => Math.round((Number(v) || 0) * 100) / 100;
const tk = (v: any) => `৳${money(v).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (v: any): v is string => typeof v === "string" && MONTH_RE.test(v);
export const PAY_METHODS = ["cash", "bank", "mfs", "cheque", "other"] as const;
export const PAY_METHOD_LABEL: Record<string, string> = { cash: "Cash", bank: "Bank transfer", mfs: "bKash / Nagad", cheque: "Cheque", other: "Other" };

export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
// "2026-11-09" -> "2026-11"
const monthOfDate = (d: string) => String(d).slice(0, 7);
const dhakaToday = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);

function parseJson<T>(v: any, fallback: T): T {
  if (v == null || v === "") return fallback;
  if (typeof v === "object") return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}
export const scheduleOf = (adv: any): Record<string, number> => {
  const s = parseJson<Record<string, any>>(adv?.repay_schedule, {});
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(s || {})) if (isMonth(k) && money(v) > 0) out[k] = money(v);
  return out;
};
export const skipsOf = (adv: any): string[] => parseJson<any[]>(adv?.skip_months, []).filter(isMonth);

/**
 * How much of this loan the salary of `monthYear` takes (before the
 * remaining balance is applied). 0 while it isn't paid out, before its
 * start month, in a skipped month, or once it's paid back.
 */
export function installmentFor(adv: any, monthYear: string, paidSoFar?: number): number {
  if (!adv || adv.status !== "active") return 0;
  if ((adv.disbursement_status || "paid") !== "paid") return 0;
  const remaining = money(Number(adv.total_amount) - Number(paidSoFar ?? adv.paid_amount));
  if (remaining <= 0) return 0;
  if (isMonth(adv.repay_start_month) && monthYear < adv.repay_start_month) return 0;
  if (adv.settle_month && adv.settle_month === monthYear) return remaining;
  if (skipsOf(adv).includes(monthYear)) return 0;
  const mode = adv.repay_mode || "equal";
  if (mode === "lump") return remaining;
  if (mode === "custom") return money(Math.min(scheduleOf(adv)[monthYear] || 0, remaining));
  return money(Math.min(Number(adv.monthly_installment) || 0, remaining));
}

/**
 * The months still to come and what each takes, from `fromMonth`, until the
 * balance is covered (at most 60 months). `unscheduled` = what the plan
 * doesn't cover (a custom schedule that adds up to less than the balance).
 */
export function planPreview(adv: any, fromMonth: string): { months: { month: string; amount: number }[]; unscheduled: number } {
  const months: { month: string; amount: number }[] = [];
  if (!adv || adv.status !== "active" || (adv.disbursement_status || "paid") !== "paid") return { months, unscheduled: 0 };
  let paid = money(adv.paid_amount);
  const start = isMonth(adv.repay_start_month) && adv.repay_start_month > fromMonth ? adv.repay_start_month : fromMonth;
  for (let i = 0, m = start; i < 60 && money(Number(adv.total_amount) - paid) > 0; i++, m = shiftMonth(m, 1)) {
    const amt = installmentFor(adv, m, paid);
    if (amt > 0) {
      months.push({ month: m, amount: amt });
      paid = money(paid + amt);
    } else if ((adv.repay_mode || "equal") === "custom" && !Object.keys(scheduleOf(adv)).some((k) => k > m) && !(adv.settle_month > m)) {
      break; // nothing scheduled after this
    }
  }
  return { months, unscheduled: money(Math.max(0, Number(adv.total_amount) - paid)) };
}

export async function ensureLoanPlanSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const add = async (sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (err?.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ loan plan schema: " + err.message);
    }
  };
  // Loans that existed before this were already paid out: the default 'paid'.
  await add("ALTER TABLE employee_advances ADD COLUMN disbursement_status VARCHAR(12) NOT NULL DEFAULT 'paid'");
  await add("ALTER TABLE employee_advances ADD COLUMN disbursed_at DATE NULL");
  await add("ALTER TABLE employee_advances ADD COLUMN disbursed_by INT NULL");
  await add("ALTER TABLE employee_advances ADD COLUMN disbursement_method VARCHAR(12) NULL");
  await add("ALTER TABLE employee_advances ADD COLUMN disbursement_reference VARCHAR(100) NULL");
  await add("ALTER TABLE employee_advances ADD COLUMN repay_start_month CHAR(7) NULL");
  await add("ALTER TABLE employee_advances ADD COLUMN repay_mode VARCHAR(8) NOT NULL DEFAULT 'equal'");
  await add("ALTER TABLE employee_advances ADD COLUMN repay_schedule TEXT NULL");
  await add("ALTER TABLE employee_advances ADD COLUMN skip_months TEXT NULL");
  await add("ALTER TABLE employee_advances ADD COLUMN settle_month CHAR(7) NULL");
  // The employee's wish when applying: start taking installments from this month.
  await add("ALTER TABLE advance_requests ADD COLUMN preferred_start_month CHAR(7) NULL");
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS loan_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        advance_id INT NOT NULL,
        event VARCHAR(20) NOT NULL,
        amount DECIMAL(12, 2) NULL,
        event_date DATE NULL,
        method VARCHAR(12) NULL,
        reference VARCHAR(100) NULL,
        note VARCHAR(500) NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_loan_events_advance (advance_id, id)
      )`);
  } catch (err: any) {
    console.warn("⚠️ loan_events: " + err.message);
  }
}

export async function logLoanEvent(
  queryDB: QueryDB,
  e: { advanceId: number; event: string; amount?: number | null; date?: string | null; method?: string | null; reference?: string | null; note?: string | null; by?: number | null }
) {
  await queryDB(
    "INSERT INTO loan_events (advance_id, event, amount, event_date, method, reference, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [e.advanceId, e.event, e.amount ?? null, e.date ?? null, e.method ?? null, e.reference ?? null, e.note ? String(e.note).slice(0, 500) : null, e.by ?? null]
  ).catch(() => {});
}

// Who can pay a loan out: Superadmins and Payroll "Accounts Pay" holders.
export async function accountsPayUserIds(queryDB: QueryDB): Promise<number[]> {
  const [supers, rows]: any[] = await Promise.all([
    queryDB("SELECT id FROM users WHERE role = 'superadmin'").catch(() => []),
    queryDB("SELECT DISTINCT user_id FROM admin_module_permission_layers WHERE module_key = 'payroll' AND layer_key = 'accounts_pay'").catch(() => [])
  ]);
  return Array.from(new Set([...(supers || []).map((r: any) => Number(r.id)), ...(rows || []).map((r: any) => Number(r.user_id))].filter(Boolean)));
}

const kindName = (adv: any) => (adv?.kind === "loan" ? "Loan" : "Salary Advance");
const planText = (adv: any) => {
  const start = isMonth(adv.repay_start_month) ? ` from ${adv.repay_start_month}` : "";
  if (adv.repay_mode === "lump") return `everything in one salary${start}`;
  if (adv.repay_mode === "custom") return `by a month-by-month schedule${start}`;
  return `${tk(adv.monthly_installment)} a month${start}`;
};

// The loan for one payroll / employee page: plan, preview and history.
export async function loanDetail(queryDB: QueryDB, adv: any, fromMonth: string) {
  const events: any[] =
    (await queryDB(
      `SELECT ev.id, ev.event, ev.amount, ev.event_date, ev.method, ev.reference, ev.note, ev.created_at, u.name AS by_name
         FROM loan_events ev LEFT JOIN users u ON u.id = ev.created_by WHERE ev.advance_id = ? ORDER BY ev.id DESC`,
      [adv.id]
    ).catch(() => [])) || [];
  return {
    disbursement_status: adv.disbursement_status || "paid",
    disbursed_at: adv.disbursed_at || null,
    disbursement_method: adv.disbursement_method || null,
    disbursement_reference: adv.disbursement_reference || null,
    repay_start_month: adv.repay_start_month || null,
    repay_mode: adv.repay_mode || "equal",
    repay_schedule: scheduleOf(adv),
    skip_months: skipsOf(adv),
    settle_month: adv.settle_month || null,
    plan: planPreview(adv, fromMonth),
    events: events.map((e) => ({ ...e, amount: e.amount != null ? money(e.amount) : null }))
  };
}

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (key: any) => any;
  requireModuleLayer: (key: any, layer: any) => any;
  queryDB: QueryDB;
  createAlert: (queryDB: QueryDB, p: { userId: number; type: any; title: string; message: string; relatedType?: string; relatedId?: number }) => Promise<void>;
}

export function registerLoanPlanRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB, createAlert } = deps;
  const payrollGate = [authenticateToken, requireAdmin, requireModule("payroll")];
  const accountsGate = [authenticateToken, requireAdmin, requireModuleLayer("payroll", "accounts_pay")];

  const loadAdvance = async (id: any) => {
    const rows: any[] = (await queryDB("SELECT * FROM employee_advances WHERE id = ?", [Number(id)])) || [];
    return rows[0] || null;
  };
  const tellEmployee = async (adv: any, title: string, message: string) => {
    const rows: any[] = (await queryDB("SELECT user_id FROM all_employees WHERE id = ?", [adv.employee_id]).catch(() => [])) || [];
    const uid = rows[0]?.user_id ? Number(rows[0].user_id) : null;
    if (uid) await createAlert(queryDB, { userId: uid, type: "loan_request", title, message, relatedType: "employee_advance", relatedId: Number(adv.id) }).catch(() => {});
  };
  const readPayment = (b: any): { error?: string; date: string; method: string; reference: string | null; note: string | null } => {
    const date = String(b?.date || dhakaToday()).slice(0, 10);
    const method = String(b?.method || "");
    const out = { date, method, reference: b?.reference ? String(b.reference).trim().slice(0, 100) || null : null, note: b?.note ? String(b.note).trim().slice(0, 500) || null : null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { ...out, error: "Pick the date." };
    if (date > dhakaToday()) return { ...out, error: "The date can't be in the future." };
    if (!(PAY_METHODS as readonly string[]).includes(method)) return { ...out, error: "Choose how it was paid: Cash, Bank transfer, bKash / Nagad, Cheque or Other." };
    if ((method === "bank" || method === "mfs" || method === "cheque") && !out.reference) return { ...out, error: "Write the transaction / cheque reference." };
    return out;
  };

  // One loan: its plan, the months to come, and its history.
  app.get("/api/payroll/advances/:id(\\d+)/detail", ...payrollGate, async (req: any, res: any) => {
    try {
      const adv = await loadAdvance(req.params.id);
      if (!adv) return res.status(404).json({ error: "Loan not found." });
      const from = isMonth(req.query.from) ? String(req.query.from) : monthOfDate(dhakaToday());
      res.json({ id: Number(adv.id), ...(await loanDetail(queryDB, adv, from)) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Accounts: the money was given to the employee.
  app.post("/api/payroll/advances/:id(\\d+)/disburse", ...accountsGate, async (req: any, res: any) => {
    try {
      const adv = await loadAdvance(req.params.id);
      if (!adv) return res.status(404).json({ error: "Loan not found." });
      if ((adv.disbursement_status || "paid") !== "pending") return res.status(400).json({ error: "This one is already marked as paid out." });
      const p = readPayment(req.body);
      if (p.error) return res.status(400).json({ error: p.error });
      // Installments start the month after it's paid out, unless a later
      // month is already set (or Accounts picks one now).
      const asked = isMonth(req.body?.start_month) ? String(req.body.start_month) : null;
      const earliest = shiftMonth(monthOfDate(p.date), 1);
      const start = asked || (isMonth(adv.repay_start_month) && adv.repay_start_month > earliest ? adv.repay_start_month : earliest);
      if (start < monthOfDate(p.date)) return res.status(400).json({ error: "Installments can't start before the month it is paid out." });
      // Once only: two clicks (or two people) at the same time pay it out once.
      const r: any = await queryDB(
        `UPDATE employee_advances SET disbursement_status = 'paid', disbursed_at = ?, disbursed_by = ?, disbursement_method = ?, disbursement_reference = ?, repay_start_month = ?
          WHERE id = ? AND disbursement_status = 'pending'`,
        [p.date, req.user.id, p.method, p.reference, start, adv.id]
      );
      if (r && r.affectedRows === 0) return res.status(409).json({ error: "This one is already marked as paid out." });
      await logLoanEvent(queryDB, { advanceId: Number(adv.id), event: "disbursed", amount: money(adv.total_amount), date: p.date, method: p.method, reference: p.reference, note: p.note, by: req.user.id });
      const fresh = await loadAdvance(adv.id);
      await tellEmployee(
        fresh,
        `${kindName(fresh)} Paid to You`,
        `Your ${kindName(fresh).toLowerCase()} of ${tk(fresh.total_amount)} was paid on ${p.date} (${PAY_METHOD_LABEL[p.method]}${p.reference ? `, ref. ${p.reference}` : ""}). It is repaid from your salary ${planText(fresh)}.`
      );
      res.json({ success: true, repay_start_month: start });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Payroll: how it is paid back.
  app.put("/api/payroll/advances/:id(\\d+)/plan", ...payrollGate, async (req: any, res: any) => {
    try {
      const adv = await loadAdvance(req.params.id);
      if (!adv) return res.status(404).json({ error: "Loan not found." });
      if (adv.status !== "active") return res.status(400).json({ error: "This one is already settled." });
      const b = req.body || {};
      const remaining = money(Number(adv.total_amount) - Number(adv.paid_amount));
      const mode = b.repay_mode === "lump" || b.repay_mode === "custom" ? b.repay_mode : "equal";
      const start = b.repay_start_month == null || b.repay_start_month === "" ? null : String(b.repay_start_month);
      if (start !== null && !isMonth(start)) return res.status(400).json({ error: "Pick the month installments start." });
      if (start && adv.disbursed_at && start < monthOfDate(String(adv.disbursed_at instanceof Date ? adv.disbursed_at.toISOString() : adv.disbursed_at))) {
        return res.status(400).json({ error: "Installments can't start before the month it was paid out." });
      }
      let installment = money(adv.monthly_installment);
      if (mode === "equal") {
        installment = money(b.monthly_installment ?? adv.monthly_installment);
        if (!(installment > 0)) return res.status(400).json({ error: "Enter the monthly installment." });
        if (installment > money(adv.total_amount)) return res.status(400).json({ error: "The monthly installment can't be more than the loan." });
      }
      let schedule: Record<string, number> | null = null;
      if (mode === "custom") {
        schedule = {};
        for (const [m, v] of Object.entries(b.repay_schedule || {})) {
          if (!isMonth(m)) return res.status(400).json({ error: `"${m}" isn't a month.` });
          const a = money(v);
          if (a < 0) return res.status(400).json({ error: "Amounts can't be negative." });
          if (a > 0) schedule[m] = a;
        }
        const months = Object.keys(schedule).sort();
        if (!months.length) return res.status(400).json({ error: "Add at least one month with an amount." });
        if (start && months[0] < start) return res.status(400).json({ error: "A month in the schedule is before the start month." });
        const sum = money(Object.values(schedule).reduce((s, x) => s + x, 0));
        if (Math.abs(sum - remaining) > 0.01) {
          return res.status(400).json({ error: `The months add up to ${tk(sum)} — they must add up to what's left, ${tk(remaining)}.` });
        }
      }
      const skips = Array.from(new Set((Array.isArray(b.skip_months) ? b.skip_months : []).map(String))).filter(isMonth).sort();
      if (skips.length !== (Array.isArray(b.skip_months) ? new Set(b.skip_months.map(String)).size : 0)) return res.status(400).json({ error: "A month to skip isn't a month." });
      if (skips.length > 24) return res.status(400).json({ error: "At most 24 months can be skipped." });
      const settle = b.settle_month == null || b.settle_month === "" ? null : String(b.settle_month);
      if (settle !== null && !isMonth(settle)) return res.status(400).json({ error: "Pick the month to take everything that's left." });
      if (settle && start && settle < start) return res.status(400).json({ error: "The settle month is before the start month." });

      await queryDB(
        "UPDATE employee_advances SET repay_mode = ?, repay_start_month = ?, monthly_installment = ?, repay_schedule = ?, skip_months = ?, settle_month = ? WHERE id = ?",
        [mode, start, installment, schedule ? JSON.stringify(schedule) : null, skips.length ? JSON.stringify(skips) : null, settle, adv.id]
      );
      const fresh = await loadAdvance(adv.id);
      const bits = [planText(fresh)];
      if (skips.length) bits.push(`nothing taken in ${skips.join(", ")}`);
      if (settle) bits.push(`everything left taken in ${settle}`);
      await logLoanEvent(queryDB, { advanceId: Number(adv.id), event: "plan", note: bits.join("; "), by: req.user.id });
      await tellEmployee(fresh, `${kindName(fresh)} Repayment Plan Changed`, `Your ${kindName(fresh).toLowerCase()} is now repaid ${bits.join("; ")}. ${tk(remaining)} is left.`);
      res.json({ success: true, ...(await loanDetail(queryDB, fresh, monthOfDate(dhakaToday()))) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Accounts: the employee paid some (or all) of it back outside the salary.
  app.post("/api/payroll/advances/:id(\\d+)/repay", ...accountsGate, async (req: any, res: any) => {
    try {
      const adv = await loadAdvance(req.params.id);
      if (!adv) return res.status(404).json({ error: "Loan not found." });
      if (adv.status !== "active") return res.status(400).json({ error: "This one is already settled." });
      if ((adv.disbursement_status || "paid") !== "paid") return res.status(400).json({ error: "It hasn't been paid out yet — there is nothing to pay back." });
      const p = readPayment(req.body);
      if (p.error) return res.status(400).json({ error: p.error });
      const amount = money(req.body?.amount);
      const remaining = money(Number(adv.total_amount) - Number(adv.paid_amount));
      if (!(amount > 0)) return res.status(400).json({ error: "Enter the amount paid back." });
      if (amount > remaining) return res.status(400).json({ error: `Only ${tk(remaining)} is left on it.` });
      // Against the balance as it is now: a second click at the same moment can't count it twice.
      const r: any = await queryDB(
        "UPDATE employee_advances SET paid_amount = paid_amount + ?, status = CASE WHEN paid_amount + ? >= total_amount - 0.005 THEN 'completed' ELSE status END WHERE id = ? AND status = 'active' AND paid_amount = ?",
        [amount, amount, adv.id, adv.paid_amount]
      );
      if (r && r.affectedRows === 0) return res.status(409).json({ error: "The loan changed just now — open it again and retry." });
      await logLoanEvent(queryDB, { advanceId: Number(adv.id), event: "repaid", amount, date: p.date, method: p.method, reference: p.reference, note: p.note, by: req.user.id });
      const fresh = await loadAdvance(adv.id);
      const left = money(Number(fresh.total_amount) - Number(fresh.paid_amount));
      await tellEmployee(
        fresh,
        `${kindName(fresh)} Repayment Received`,
        `${tk(amount)} you paid back on ${p.date} (${PAY_METHOD_LABEL[p.method]}) was counted. ${left > 0 ? `${tk(left)} is left.` : "It is fully paid back."}`
      );
      res.json({ success: true, remaining: left, status: fresh.status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
