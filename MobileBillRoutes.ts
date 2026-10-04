/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Mobile Bill — company SIMs given to employees, their monthly limits and bills.
//
//   HR (Admin Panel -> HRM -> Mobile Bill, module "mobile_bill") gives SIMs
//   (one employee may hold more than one), sets each SIM's monthly limit —
//   from the employee type's limit (mobile_limit_policies, keyed by
//   all_employees.employment_category) or a custom amount — imports the bill
//   the operator sends each month (number + amount), pays it (the payment
//   sheet: what the company pays up to the limit, number by number) and runs
//   the reports: operator-wise, month by month, the 2–6 month average per
//   number, who spends more or less than their limit, and the excess over the
//   limit (to deduct from salary later — for now only a report).
//
//   Every SIM is postpaid; the bill is paid by the company up to the limit.
//
//   An employee (Self Service -> My Mobile SIM, users.can_view_mobile_bill —
//   off until turned on in Module Access) sees their SIMs, limits and bills
//   and applies for a higher limit — for one month or from a month onwards.
//   The application rides the Dynamic Approval Engine (request_type 'mobile',
//   source_type 'mobile_limit_request'): the Supervisor layer and the
//   template's layers up to HR. With no chain at all it waits for HR here.
//   The final approval changes the limit (finalizeMobileLimitRequest).
//
// mobile_sims / mobile_bills / mobile_limit_policies / mobile_limit_requests
// carry company_id (companyScope.ts OWN_TABLES); mobile_sim_events hangs off
// a SIM (LINKED_TABLES).

import type { Express } from "express";
import type { AlertType } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type CreateAlert = (
  queryDB: QueryDB,
  params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
) => Promise<void>;

interface MobileBillRouteDeps {
  authenticateToken: any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  createAlert: CreateAlert;
  createTemplateApprovalRequest: (
    requestType: "mobile",
    sourceType: "mobile_limit_request",
    sourceId: number,
    requestedBy: number
  ) => Promise<{ autoApproved: boolean; template: any | null }>;
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
}

export const MOBILE_OPERATORS = ["Grameenphone", "Robi", "Airtel", "Banglalink", "Teletalk"] as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 01XXXXXXXXX — accepts +8801…, 8801…, 1… (Excel drops the leading 0).
export function normalizeMobile(v: any): string | null {
  let d = String(v ?? "").replace(/\.0+$/, "").replace(/\D/g, "");
  if (d.startsWith("880")) d = d.slice(2);
  else if (d.startsWith("88") && d.length === 13) d = d.slice(2);
  if (d.length === 10 && d.startsWith("1")) d = "0" + d;
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
}
export function operatorOf(phone: string): string | null {
  const p = phone.slice(0, 3);
  if (p === "017" || p === "013") return "Grameenphone";
  if (p === "018") return "Robi";
  if (p === "016") return "Airtel";
  if (p === "019" || p === "014") return "Banglalink";
  if (p === "015") return "Teletalk";
  return null;
}
const money = (v: any) => Math.round(Number(v || 0) * 100) / 100;
const str = (v: any, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : v == null ? "" : String(v).trim().slice(0, max));
const ymd = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const s = String(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
};
const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const monthText = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
};
const typeKey = (t: any) => String(t || "").trim().toLowerCase();

export async function ensureMobileBillSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const run = async (label: string, sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      console.warn(`⚠️ Could not ensure ${label}: ` + err.message);
    }
  };
  await run(
    "mobile_limit_policies table",
    `CREATE TABLE IF NOT EXISTS mobile_limit_policies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      employee_type VARCHAR(100) NOT NULL DEFAULT '',
      limit_amount DECIMAL(10,2) NOT NULL,
      note VARCHAR(255) NULL,
      updated_by INT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_mobile_policy_type (company_id, employee_type)
    )`
  );
  await run(
    "mobile_sims table",
    `CREATE TABLE IF NOT EXISTS mobile_sims (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      phone_number VARCHAR(15) NOT NULL,
      operator VARCHAR(30) NOT NULL,
      sim_type VARCHAR(15) NOT NULL DEFAULT 'postpaid',
      package_name VARCHAR(100) NULL,
      employee_id INT NULL,
      duty_location VARCHAR(150) NULL,
      limit_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      limit_source VARCHAR(10) NOT NULL DEFAULT 'type',
      status VARCHAR(10) NOT NULL DEFAULT 'active',
      issued_on DATE NULL,
      note VARCHAR(255) NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_mobile_sim_number (company_id, phone_number),
      INDEX idx_mobile_sims_employee (employee_id)
    )`
  );
  await run(
    "mobile_bills table",
    `CREATE TABLE IF NOT EXISTS mobile_bills (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      sim_id INT NOT NULL,
      bill_month CHAR(7) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      limit_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      employee_id INT NULL,
      paid_at DATETIME NULL,
      paid_by INT NULL,
      imported_by INT NULL,
      imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_mobile_bill (company_id, sim_id, bill_month),
      INDEX idx_mobile_bills_month (bill_month),
      FOREIGN KEY (sim_id) REFERENCES mobile_sims(id) ON DELETE CASCADE
    )`
  );
  await run(
    "mobile_limit_requests table",
    `CREATE TABLE IF NOT EXISTS mobile_limit_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      sim_id INT NOT NULL,
      user_id INT NOT NULL,
      current_limit DECIMAL(10,2) NOT NULL,
      requested_limit DECIMAL(10,2) NOT NULL,
      scope VARCHAR(10) NOT NULL DEFAULT 'month',
      for_month CHAR(7) NOT NULL,
      reason TEXT NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      decided_by INT NULL,
      decided_at DATETIME NULL,
      decision_note VARCHAR(500) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sim_id) REFERENCES mobile_sims(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_mobile_requests_status (status)
    )`
  );
  await run(
    "mobile_sim_events table",
    `CREATE TABLE IF NOT EXISTS mobile_sim_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sim_id INT NOT NULL,
      action VARCHAR(30) NOT NULL,
      message VARCHAR(500) NOT NULL,
      actor_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sim_id) REFERENCES mobile_sims(id) ON DELETE CASCADE
    )`
  );
}

async function logSim(queryDB: QueryDB, simId: number, action: string, message: string, actorId: number | null) {
  try {
    await queryDB("INSERT INTO mobile_sim_events (sim_id, action, message, actor_id) VALUES (?, ?, ?, ?)", [simId, action, message.slice(0, 500), actorId]);
  } catch (err: any) {
    console.warn("⚠️ Could not log mobile SIM event: " + err.message);
  }
}

// The limit a SIM has for one month: an approved one-month raise for that
// month wins, otherwise the SIM's own limit.
async function limitFor(queryDB: QueryDB, sim: any, month: string): Promise<number> {
  const rows: any[] =
    (await queryDB("SELECT requested_limit FROM mobile_limit_requests WHERE sim_id = ? AND status = 'approved' AND scope = 'month' AND for_month = ? ORDER BY id DESC", [
      sim.id,
      month
    ])) || [];
  return rows.length ? money(rows[0].requested_limit) : money(sim.limit_amount);
}

// The approval chain's final Approve (performApprovalAction in server.ts), or
// HR deciding a request that has no chain.
export async function finalizeMobileLimitRequest(queryDB: QueryDB, createAlert: CreateAlert, requestId: number, actorId: number, remarks: string | null) {
  const rows: any[] = (await queryDB("SELECT * FROM mobile_limit_requests WHERE id = ?", [requestId])) || [];
  const r = rows[0];
  if (!r) throw new Error("Limit request not found.");
  if (r.status !== "pending") return;
  await queryDB("UPDATE mobile_limit_requests SET status = 'approved', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?", [actorId, remarks, requestId]);
  const simRows: any[] = (await queryDB("SELECT * FROM mobile_sims WHERE id = ?", [r.sim_id])) || [];
  const sim = simRows[0];
  const newLimit = money(r.requested_limit);
  if (sim) {
    if (r.scope === "permanent") {
      await queryDB("UPDATE mobile_sims SET limit_amount = ?, limit_source = 'custom' WHERE id = ?", [newLimit, sim.id]);
      await queryDB("UPDATE mobile_bills SET limit_amount = ? WHERE sim_id = ? AND bill_month >= ?", [newLimit, sim.id, r.for_month]);
      await logSim(queryDB, Number(sim.id), "limit", `Limit ${money(sim.limit_amount)} → ${newLimit} from ${monthText(r.for_month)} (approved request #${r.id}).`, actorId);
    } else {
      await queryDB("UPDATE mobile_bills SET limit_amount = ? WHERE sim_id = ? AND bill_month = ?", [newLimit, sim.id, r.for_month]);
      await logSim(queryDB, Number(sim.id), "limit", `Limit ${newLimit} for ${monthText(r.for_month)} only (approved request #${r.id}).`, actorId);
    }
  }
  await createAlert(queryDB, {
    userId: Number(r.user_id),
    type: "mobile_bill",
    title: "Mobile Limit Approved",
    message: `Your limit for ${sim ? sim.phone_number : "your SIM"} is now ৳${newLimit} ${r.scope === "permanent" ? `from ${monthText(r.for_month)}` : `for ${monthText(r.for_month)}`}.`,
    relatedType: "mobile_limit_request",
    relatedId: Number(r.id)
  }).catch(() => {});
}

export async function rejectMobileLimitRequest(queryDB: QueryDB, createAlert: CreateAlert, requestId: number, actorId: number, remarks: string | null) {
  const rows: any[] = (await queryDB("SELECT * FROM mobile_limit_requests WHERE id = ?", [requestId])) || [];
  const r = rows[0];
  if (!r || r.status !== "pending") return;
  await queryDB("UPDATE mobile_limit_requests SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?", [actorId, remarks, requestId]);
  await createAlert(queryDB, {
    userId: Number(r.user_id),
    type: "mobile_bill",
    title: "Mobile Limit Request Rejected",
    message: `Your request to raise the limit to ৳${money(r.requested_limit)} was not approved${remarks ? `: ${remarks}` : "."}`,
    relatedType: "mobile_limit_request",
    relatedId: Number(r.id)
  }).catch(() => {});
}

export function registerMobileBillRoutes(app: Express, deps: MobileBillRouteDeps) {
  const { authenticateToken, queryDB, getAdminModules, createAlert, createTemplateApprovalRequest, getCurrentStepApprovers } = deps;

  // ---- who may do what -------------------------------------------------
  async function isHr(user: any): Promise<boolean> {
    if (user.role === "superadmin") return true;
    return (await getAdminModules(Number(user.id))).includes("mobile_bill");
  }
  async function hasSelf(user: any): Promise<boolean> {
    if (user.role === "superadmin") return true;
    const rows: any[] = (await queryDB("SELECT can_view_mobile_bill FROM users WHERE id = ?", [user.id])) || [];
    return !!Number(rows[0]?.can_view_mobile_bill || 0) || (await isHr(user));
  }
  const hrOnly = async (req: any, res: any, next: any) => {
    try {
      if (!(await isHr(req.user))) return res.status(403).json({ error: "Mobile Bill access required." });
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
  const selfOnly = async (req: any, res: any, next: any) => {
    try {
      if (!(await hasSelf(req.user))) return res.status(403).json({ error: "My Mobile SIM isn't turned on for your account." });
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  async function hrUserIds(): Promise<number[]> {
    const users: any[] = (await queryDB("SELECT id, role FROM users")) || [];
    const out: number[] = [];
    for (const u of users) {
      if (u.role === "superadmin") continue;
      if ((await getAdminModules(Number(u.id))).includes("mobile_bill")) out.push(Number(u.id));
    }
    return out.length ? out : users.filter((u) => u.role === "superadmin").map((u) => Number(u.id));
  }

  // ---- reading -----------------------------------------------------------
  async function employees(): Promise<any[]> {
    return (
      (await queryDB("SELECT id, employee_id, name, designation, department, branch, employment_category, user_id, mobile FROM all_employees")) || []
    ).map((e: any) => ({
      id: Number(e.id),
      employee_code: e.employee_id || null,
      name: e.name,
      designation: e.designation || null,
      department: e.department || null,
      work_station: e.branch || null,
      employee_type: e.employment_category || null,
      user_id: e.user_id ? Number(e.user_id) : null,
      mobile: e.mobile || null
    }));
  }
  async function policies(): Promise<any[]> {
    return ((await queryDB("SELECT * FROM mobile_limit_policies ORDER BY employee_type")) || []).map((p: any) => ({
      id: Number(p.id),
      employee_type: p.employee_type || "",
      limit_amount: money(p.limit_amount),
      note: p.note || null
    }));
  }
  // The type limit for an employee: their type's row, else the default ('').
  function typeLimit(pols: any[], employeeType: string | null): number | null {
    const k = typeKey(employeeType);
    const hit = pols.find((p) => typeKey(p.employee_type) === k && k) || pols.find((p) => !typeKey(p.employee_type));
    return hit ? hit.limit_amount : null;
  }

  async function loadSims(where = "", params: any[] = []): Promise<any[]> {
    const [sims, emps, pending, lastBills]: any[] = await Promise.all([
      queryDB(`SELECT * FROM mobile_sims ${where}`, params),
      employees(),
      queryDB("SELECT sim_id, COUNT(*) AS n FROM mobile_limit_requests WHERE status = 'pending' GROUP BY sim_id"),
      queryDB("SELECT sim_id, bill_month, amount, limit_amount FROM mobile_bills ORDER BY bill_month DESC")
    ]);
    const empById = new Map<number, any>(emps.map((e: any) => [e.id, e]));
    const pendingBySim = new Map<number, number>((pending || []).map((p: any) => [Number(p.sim_id), Number(p.n)]));
    const lastBySim = new Map<number, any>();
    for (const b of lastBills || []) if (!lastBySim.has(Number(b.sim_id))) lastBySim.set(Number(b.sim_id), b);
    return (sims || [])
      .map((s: any) => {
        const e = s.employee_id ? empById.get(Number(s.employee_id)) : null;
        const lb = lastBySim.get(Number(s.id));
        return {
          id: Number(s.id),
          phone_number: s.phone_number,
          operator: s.operator,
          sim_type: s.sim_type,
          package_name: s.package_name || null,
          employee_id: s.employee_id ? Number(s.employee_id) : null,
          employee: e || null,
          duty_location: s.duty_location || null,
          limit_amount: money(s.limit_amount),
          limit_source: s.limit_source,
          status: s.status,
          issued_on: ymd(s.issued_on),
          note: s.note || null,
          pending_requests: pendingBySim.get(Number(s.id)) || 0,
          last_bill: lb ? { month: lb.bill_month, amount: money(lb.amount), limit_amount: money(lb.limit_amount) } : null
        };
      })
      .sort((a: any, b: any) => String(a.employee?.name || "~").localeCompare(String(b.employee?.name || "~")) || a.phone_number.localeCompare(b.phone_number));
  }

  async function loadRequests(where = "", params: any[] = []): Promise<any[]> {
    const [reqs, sims, users, approvals]: any[] = await Promise.all([
      queryDB(`SELECT * FROM mobile_limit_requests ${where}`, params),
      loadSims(),
      queryDB("SELECT id, name FROM users"),
      queryDB("SELECT * FROM approval_requests WHERE source_type = 'mobile_limit_request'")
    ]);
    const simById = new Map<number, any>(sims.map((s: any) => [s.id, s]));
    const userName = new Map<number, string>((users || []).map((u: any) => [Number(u.id), u.name]));
    const approvalBySource = new Map<number, any>();
    for (const a of approvals || []) approvalBySource.set(Number(a.source_id), a);
    const out = [];
    for (const r of reqs || []) {
      const ap = approvalBySource.get(Number(r.id));
      let waitingOn: string[] = [];
      if (ap && ap.status === "pending" && r.status === "pending") {
        waitingOn = (await getCurrentStepApprovers(ap)).map((x) => x.user_name || "Unknown");
      }
      const sim = simById.get(Number(r.sim_id));
      out.push({
        id: Number(r.id),
        sim_id: Number(r.sim_id),
        phone_number: sim?.phone_number || null,
        operator: sim?.operator || null,
        employee: sim?.employee || null,
        user_id: Number(r.user_id),
        user_name: userName.get(Number(r.user_id)) || null,
        current_limit: money(r.current_limit),
        requested_limit: money(r.requested_limit),
        scope: r.scope,
        for_month: r.for_month,
        reason: r.reason,
        status: r.status,
        decided_by_name: r.decided_by ? userName.get(Number(r.decided_by)) || null : null,
        decided_at: r.decided_at || null,
        decision_note: r.decision_note || null,
        created_at: r.created_at,
        // Riding an approval chain? Then HR can't decide it here.
        chain: ap ? { status: ap.status, step: Number(ap.current_step), total: Number(ap.total_steps), waiting_on: waitingOn } : null
      });
    }
    return out.sort((a, b) => b.id - a.id);
  }

  // ---- access & lookups --------------------------------------------------
  app.get("/api/mobile-bill/access", authenticateToken, async (req: any, res: any) => {
    try {
      res.json({ hr: await isHr(req.user), self: await hasSelf(req.user), operators: MOBILE_OPERATORS });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/mobile-bill/meta", authenticateToken, hrOnly, async (_req: any, res: any) => {
    try {
      const [emps, pols] = await Promise.all([employees(), policies()]);
      const types = Array.from(new Set(emps.map((e) => String(e.employee_type || "").trim()).filter(Boolean))).sort();
      res.json({
        operators: MOBILE_OPERATORS,
        employees: emps.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((e) => ({ ...e, type_limit: typeLimit(pols, e.employee_type) })),
        employee_types: types,
        policies: pols
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- limits by employee type -------------------------------------------
  app.get("/api/mobile-bill/policies", authenticateToken, hrOnly, async (_req: any, res: any) => {
    try {
      const [pols, sims] = await Promise.all([policies(), loadSims("WHERE status = 'active'")]);
      res.json(
        pols.map((p) => ({
          ...p,
          sims: sims.filter((s) => s.limit_source === "type" && (typeKey(s.employee?.employee_type) === typeKey(p.employee_type) || (!p.employee_type && !pols.some((x) => x.employee_type && typeKey(x.employee_type) === typeKey(s.employee?.employee_type))))).length
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every active SIM that follows its type's limit takes the current one.
  async function reapplyTypeLimits(actorId: number): Promise<number> {
    const [pols, sims] = await Promise.all([policies(), loadSims("WHERE limit_source = 'type'")]);
    let changed = 0;
    for (const s of sims) {
      const lim = typeLimit(pols, s.employee?.employee_type || null);
      if (lim == null || lim === s.limit_amount) continue;
      await queryDB("UPDATE mobile_sims SET limit_amount = ? WHERE id = ?", [lim, s.id]);
      await logSim(queryDB, s.id, "limit", `Limit ${s.limit_amount} → ${lim} (employee type limit changed).`, actorId);
      changed++;
    }
    return changed;
  }

  app.post("/api/mobile-bill/policies", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const type = str(b.employee_type, 100);
      const amount = Number(b.limit_amount);
      if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "Enter the limit in taka." });
      const existing: any[] = (await queryDB("SELECT id FROM mobile_limit_policies WHERE employee_type = ?", [type])) || [];
      if (existing.length && Number(existing[0].id) !== Number(b.id || 0)) return res.status(400).json({ error: `${type || "The default limit"} is already set — edit it instead.` });
      if (b.id) {
        await queryDB("UPDATE mobile_limit_policies SET employee_type = ?, limit_amount = ?, note = ?, updated_by = ? WHERE id = ?", [type, money(amount), str(b.note, 255) || null, req.user.id, Number(b.id)]);
      } else {
        await queryDB("INSERT INTO mobile_limit_policies (employee_type, limit_amount, note, updated_by) VALUES (?, ?, ?, ?)", [type, money(amount), str(b.note, 255) || null, req.user.id]);
      }
      const changed = await reapplyTypeLimits(Number(req.user.id));
      res.json({ success: true, sims_updated: changed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mobile-bill/policies/:id(\\d+)", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      await queryDB("DELETE FROM mobile_limit_policies WHERE id = ?", [Number(req.params.id)]);
      const changed = await reapplyTypeLimits(Number(req.user.id));
      res.json({ success: true, sims_updated: changed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- SIMs --------------------------------------------------------------
  app.get("/api/mobile-bill/sims", authenticateToken, hrOnly, async (_req: any, res: any) => {
    try {
      res.json(await loadSims());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/mobile-bill/sims/:id(\\d+)", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const sim = (await loadSims("WHERE id = ?", [id]))[0];
      if (!sim) return res.status(404).json({ error: "SIM not found." });
      const [events, bills, requests, users]: any[] = await Promise.all([
        queryDB("SELECT * FROM mobile_sim_events WHERE sim_id = ? ORDER BY id DESC", [id]),
        queryDB("SELECT * FROM mobile_bills WHERE sim_id = ? ORDER BY bill_month DESC", [id]),
        loadRequests("WHERE sim_id = ?", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userName = new Map<number, string>((users || []).map((u: any) => [Number(u.id), u.name]));
      res.json({
        ...sim,
        events: (events || []).map((e: any) => ({ id: Number(e.id), action: e.action, message: e.message, actor_name: e.actor_id ? userName.get(Number(e.actor_id)) || null : null, created_at: e.created_at })),
        bills: (bills || []).map((b: any) => ({ id: Number(b.id), month: b.bill_month, amount: money(b.amount), limit_amount: money(b.limit_amount), paid_at: b.paid_at || null })),
        requests
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Validates a SIM form; returns the cleaned fields or an error.
  async function cleanSim(b: any, id: number | null) {
    const phone = normalizeMobile(b.phone_number);
    if (!phone) return { error: "Enter a valid mobile number (01XXXXXXXXX)." };
    const dup: any[] = (await queryDB("SELECT id FROM mobile_sims WHERE phone_number = ?", [phone])) || [];
    if (dup.some((d) => Number(d.id) !== id)) return { error: `${phone} is already in the SIM list.` };
    const operator = (MOBILE_OPERATORS as readonly string[]).includes(b.operator) ? b.operator : operatorOf(phone);
    if (!operator) return { error: "Pick the operator." };
    let employeeId: number | null = null;
    let emp: any = null;
    if (b.employee_id) {
      emp = (await employees()).find((e) => e.id === Number(b.employee_id));
      if (!emp) return { error: "That employee isn't in this company." };
      employeeId = emp.id;
    }
    const limitSource = b.limit_source === "custom" ? "custom" : "type";
    let limit = Number(b.limit_amount);
    if (limitSource === "type") {
      const lim = typeLimit(await policies(), emp?.employee_type || null);
      if (lim == null) return { error: `No limit is set for ${emp?.employee_type ? `"${emp.employee_type}"` : "this employee's type"} and no default limit either — set one under Limits, or give a custom limit.` };
      limit = lim;
    } else if (!Number.isFinite(limit) || limit < 0) {
      return { error: "Enter the limit in taka." };
    }
    const issued = b.issued_on ? ymd(b.issued_on) : null;
    return {
      phone,
      operator,
      packageName: str(b.package_name, 100) || null,
      employeeId,
      emp,
      dutyLocation: str(b.duty_location, 150) || null,
      limit: money(limit),
      limitSource,
      status: b.status === "inactive" ? "inactive" : "active",
      issued,
      note: str(b.note, 255) || null
    };
  }

  app.post("/api/mobile-bill/sims", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const f: any = await cleanSim(req.body || {}, null);
      if (f.error) return res.status(400).json({ error: f.error });
      const r: any = await queryDB(
        `INSERT INTO mobile_sims (phone_number, operator, package_name, employee_id, duty_location, limit_amount, limit_source, status, issued_on, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [f.phone, f.operator, f.packageName, f.employeeId, f.dutyLocation, f.limit, f.limitSource, f.status, f.issued, f.note, req.user.id]
      );
      const id = Number(r.insertId);
      await logSim(queryDB, id, "added", `SIM added${f.emp ? ` and given to ${f.emp.name}` : " (not given to anyone yet)"}, limit ৳${f.limit}.`, Number(req.user.id));
      if (f.emp?.user_id) {
        await createAlert(queryDB, {
          userId: f.emp.user_id,
          type: "mobile_bill",
          title: "Company SIM Given to You",
          message: `${f.phone} (${f.operator}) is now yours, with a monthly limit of ৳${f.limit}.`,
          relatedType: "mobile_sim",
          relatedId: id
        }).catch(() => {});
      }
      res.status(201).json((await loadSims("WHERE id = ?", [id]))[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/mobile-bill/sims/:id(\\d+)", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const old = (await loadSims("WHERE id = ?", [id]))[0];
      if (!old) return res.status(404).json({ error: "SIM not found." });
      const f: any = await cleanSim(req.body || {}, id);
      if (f.error) return res.status(400).json({ error: f.error });
      await queryDB(
        `UPDATE mobile_sims SET phone_number = ?, operator = ?, package_name = ?, employee_id = ?, duty_location = ?, limit_amount = ?, limit_source = ?, status = ?, issued_on = ?, note = ? WHERE id = ?`,
        [f.phone, f.operator, f.packageName, f.employeeId, f.dutyLocation, f.limit, f.limitSource, f.status, f.issued, f.note, id]
      );
      const actor = Number(req.user.id);
      if (old.employee_id !== f.employeeId) {
        await logSim(queryDB, id, "assigned", f.emp ? `Given to ${f.emp.name}${old.employee ? ` (was ${old.employee.name})` : ""}.` : `Taken back from ${old.employee?.name || "the employee"}.`, actor);
        if (f.emp?.user_id) {
          await createAlert(queryDB, {
            userId: f.emp.user_id,
            type: "mobile_bill",
            title: "Company SIM Given to You",
            message: `${f.phone} (${f.operator}) is now yours, with a monthly limit of ৳${f.limit}.`,
            relatedType: "mobile_sim",
            relatedId: id
          }).catch(() => {});
        }
      }
      if (old.limit_amount !== f.limit) await logSim(queryDB, id, "limit", `Limit ৳${old.limit_amount} → ৳${f.limit}${f.limitSource === "type" ? " (employee type limit)" : ""}.`, actor);
      if (old.status !== f.status) await logSim(queryDB, id, "status", f.status === "active" ? "Turned back on." : "Turned off (inactive).", actor);
      if (old.phone_number !== f.phone || old.operator !== f.operator) await logSim(queryDB, id, "edited", `Number/operator ${old.phone_number} ${old.operator} → ${f.phone} ${f.operator}.`, actor);
      res.json((await loadSims("WHERE id = ?", [id]))[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Only a SIM with no bill yet can be deleted — otherwise turn it off.
  app.delete("/api/mobile-bill/sims/:id(\\d+)", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const bills: any[] = (await queryDB("SELECT id FROM mobile_bills WHERE sim_id = ? LIMIT 1", [id])) || [];
      if (bills.length) return res.status(400).json({ error: "This SIM has bills — turn it off (Inactive) instead of deleting it." });
      const reqIds = ((await queryDB("SELECT id FROM mobile_limit_requests WHERE sim_id = ? AND status = 'pending'", [id])) || []).map((r: any) => Number(r.id));
      for (const rid of reqIds) {
        await queryDB("UPDATE approval_requests SET status = 'rejected' WHERE source_type = 'mobile_limit_request' AND source_id = ? AND status = 'pending'", [rid]).catch(() => {});
      }
      await queryDB("DELETE FROM mobile_sims WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Many SIMs at once from HR's own list (number, Emp. ID, operator, limit,
  // duty location) — same sheet as the one HR keeps today.
  app.post("/api/mobile-bill/sims/import", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 5000) : [];
      const dryRun = req.body?.dry_run !== false;
      const [emps, pols, sims] = await Promise.all([employees(), policies(), loadSims()]);
      const byCode = new Map<string, any>();
      for (const e of emps) if (e.employee_code) byCode.set(String(e.employee_code).trim().toLowerCase(), e);
      const known = new Set(sims.map((s) => s.phone_number));
      const seen = new Set<string>();
      const results = rows.map((row, i) => {
        const phone = normalizeMobile(row.phone_number);
        const out: any = { row: i + 1, phone_number: phone || String(row.phone_number || ""), errors: [] as string[] };
        if (!phone) out.errors.push("Not a valid mobile number");
        else if (known.has(phone)) out.errors.push("Already in the SIM list");
        else if (seen.has(phone)) out.errors.push("Twice in this file");
        if (phone) seen.add(phone);
        const code = String(row.employee_code ?? "").trim();
        const emp = code ? byCode.get(code.toLowerCase()) : null;
        if (code && !emp) out.errors.push(`No employee with ID ${code}`);
        out.employee_name = emp?.name || null;
        out.operator = (MOBILE_OPERATORS as readonly string[]).find((o) => o.toLowerCase() === String(row.operator || "").trim().toLowerCase()) || (phone ? operatorOf(phone) : null);
        if (!out.operator) out.errors.push("Operator unknown");
        const lim = row.limit_amount === "" || row.limit_amount == null ? null : Number(row.limit_amount);
        if (lim != null && (!Number.isFinite(lim) || lim < 0)) out.errors.push("Limit is not a number");
        out.limit_source = lim != null ? "custom" : "type";
        out.limit_amount = lim != null ? money(lim) : typeLimit(pols, emp?.employee_type || null);
        if (out.limit_amount == null) out.errors.push("No limit given and no type/default limit set");
        out.duty_location = str(row.duty_location, 150) || null;
        out.employee_id = emp?.id || null;
        out.emp_user_id = emp?.user_id || null;
        return out;
      });
      const ok = results.filter((r) => !r.errors.length);
      if (!dryRun) {
        for (const r of ok) {
          const ins: any = await queryDB(
            "INSERT INTO mobile_sims (phone_number, operator, employee_id, duty_location, limit_amount, limit_source, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
            [r.phone_number, r.operator, r.employee_id, r.duty_location, r.limit_amount, r.limit_source, req.user.id]
          );
          await logSim(queryDB, Number(ins.insertId), "added", `Imported${r.employee_name ? ` for ${r.employee_name}` : ""}, limit ৳${r.limit_amount}.`, Number(req.user.id));
        }
      }
      res.json({ dry_run: dryRun, total: results.length, ok: ok.length, failed: results.length - ok.length, rows: results.map(({ emp_user_id, ...r }) => r) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- limit requests ----------------------------------------------------
  app.get("/api/mobile-bill/requests", authenticateToken, hrOnly, async (_req: any, res: any) => {
    try {
      res.json(await loadRequests());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // HR decides a request that has no approval chain (nobody else to ask).
  app.post("/api/mobile-bill/requests/:id(\\d+)/decide", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const r = (await loadRequests("WHERE id = ?", [id]))[0];
      if (!r) return res.status(404).json({ error: "Request not found." });
      if (r.status !== "pending") return res.status(400).json({ error: `This request was already ${r.status}.` });
      if (r.chain && r.chain.status === "pending") return res.status(400).json({ error: "This request is in the approval chain — decide it from Approve Applications." });
      const note = str(req.body?.note, 500) || null;
      if (req.body?.decision === "approve") await finalizeMobileLimitRequest(queryDB, createAlert, id, Number(req.user.id), note);
      else if (req.body?.decision === "reject") await rejectMobileLimitRequest(queryDB, createAlert, id, Number(req.user.id), note);
      else return res.status(400).json({ error: "decision must be approve or reject." });
      res.json((await loadRequests("WHERE id = ?", [id]))[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Self Service -------------------------------------------------------
  async function myEmployeeIds(userId: number): Promise<number[]> {
    const rows: any[] = (await queryDB("SELECT id FROM all_employees WHERE user_id = ?", [userId])) || [];
    return rows.map((r) => Number(r.id));
  }

  app.get("/api/mobile-bill/my", authenticateToken, selfOnly, async (req: any, res: any) => {
    try {
      const empIds = await myEmployeeIds(Number(req.user.id));
      const sims = empIds.length ? await loadSims(`WHERE employee_id IN (${empIds.map(() => "?").join(",")})`, empIds) : [];
      const simIds = sims.map((s) => s.id);
      const bills: any[] = simIds.length ? (await queryDB(`SELECT * FROM mobile_bills WHERE sim_id IN (${simIds.map(() => "?").join(",")}) ORDER BY bill_month DESC`, simIds)) || [] : [];
      const requests = await loadRequests("WHERE user_id = ?", [Number(req.user.id)]);
      res.json({
        sims: sims.map((s) => ({
          ...s,
          bills: bills
            .filter((b) => Number(b.sim_id) === s.id)
            .slice(0, 12)
            .map((b) => ({ month: b.bill_month, amount: money(b.amount), limit_amount: money(b.limit_amount) }))
        })),
        requests,
        this_month: thisMonth()
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mobile-bill/my/requests", authenticateToken, selfOnly, async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const uid = Number(req.user.id);
      const empIds = await myEmployeeIds(uid);
      const sim = (await loadSims("WHERE id = ?", [Number(b.sim_id)]))[0];
      if (!sim || !sim.employee_id || !empIds.includes(sim.employee_id)) return res.status(404).json({ error: "That SIM isn't yours." });
      if (sim.status !== "active") return res.status(400).json({ error: "That SIM is turned off." });
      const scope = b.scope === "permanent" ? "permanent" : "month";
      const month = String(b.for_month || "");
      if (!MONTH_RE.test(month)) return res.status(400).json({ error: "Pick the month." });
      const [ty, tm] = thisMonth().split("-").map(Number);
      const lastMonth = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, "0")}`;
      if (month < lastMonth) return res.status(400).json({ error: "The month can't be earlier than last month." });
      const current = await limitFor(queryDB, sim, month);
      const amount = Number(b.requested_limit);
      if (!Number.isFinite(amount) || amount <= current) return res.status(400).json({ error: `The new limit must be more than your current limit (৳${current}).` });
      const reason = str(b.reason, 2000);
      if (!reason) return res.status(400).json({ error: "Tell HR why you need a higher limit." });
      const open: any[] = (await queryDB("SELECT id FROM mobile_limit_requests WHERE sim_id = ? AND status = 'pending'", [sim.id])) || [];
      if (open.length) return res.status(400).json({ error: "You already have a request waiting for this SIM." });
      const r: any = await queryDB(
        "INSERT INTO mobile_limit_requests (sim_id, user_id, current_limit, requested_limit, scope, for_month, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [sim.id, uid, current, money(amount), scope, month, reason]
      );
      const id = Number(r.insertId);
      await logSim(queryDB, sim.id, "request", `${req.user.name || "The employee"} asked for ৳${money(amount)} ${scope === "permanent" ? `from ${monthText(month)}` : `for ${monthText(month)}`}.`, uid);
      const what = `${req.user.name || "An employee"} asked to raise the limit of ${sim.phone_number} from ৳${current} to ৳${money(amount)} ${scope === "permanent" ? `from ${monthText(month)}` : `for ${monthText(month)}`}.`;
      const { autoApproved } = await createTemplateApprovalRequest("mobile", "mobile_limit_request", id, uid);
      if (autoApproved) {
        // No supervisor and no template: HR decides it in Mobile Bill.
        for (const hr of await hrUserIds()) {
          if (hr === uid) continue;
          await createAlert(queryDB, { userId: hr, type: "mobile_bill", title: "Mobile Limit Request", message: what, relatedType: "mobile_limit_request", relatedId: id }).catch(() => {});
        }
      } else {
        const ap: any[] = (await queryDB("SELECT * FROM approval_requests WHERE source_type = 'mobile_limit_request' AND source_id = ?", [id])) || [];
        if (ap[0]) {
          for (const a of await getCurrentStepApprovers(ap[0])) {
            await createAlert(queryDB, { userId: a.user_id, type: "mobile_limit_approval" as AlertType, title: "Mobile Limit Request Awaiting Your Approval", message: what, relatedType: "mobile_limit_request", relatedId: id }).catch(() => {});
          }
        }
      }
      res.status(201).json((await loadRequests("WHERE id = ?", [id]))[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mobile-bill/my/requests/:id(\\d+)/cancel", authenticateToken, selfOnly, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const rows: any[] = (await queryDB("SELECT * FROM mobile_limit_requests WHERE id = ?", [id])) || [];
      const r = rows[0];
      if (!r || Number(r.user_id) !== Number(req.user.id)) return res.status(404).json({ error: "Request not found." });
      if (r.status !== "pending") return res.status(400).json({ error: `This request was already ${r.status}.` });
      await queryDB("UPDATE mobile_limit_requests SET status = 'cancelled', decided_at = NOW() WHERE id = ?", [id]);
      await queryDB("UPDATE approval_requests SET status = 'rejected' WHERE source_type = 'mobile_limit_request' AND source_id = ? AND status = 'pending'", [id]).catch(() => {});
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- bills ---------------------------------------------------------------
  // One month, every SIM that is active or has a bill that month.
  app.get("/api/mobile-bill/bills", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const month = MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : thisMonth();
      const [sims, bills, monthReqs]: any[] = await Promise.all([
        loadSims(),
        queryDB("SELECT * FROM mobile_bills WHERE bill_month = ?", [month]),
        queryDB("SELECT sim_id, requested_limit FROM mobile_limit_requests WHERE status = 'approved' AND scope = 'month' AND for_month = ? ORDER BY id ASC", [month])
      ]);
      const billBySim = new Map<number, any>((bills || []).map((b: any) => [Number(b.sim_id), b]));
      const monthLimit = new Map<number, number>((monthReqs || []).map((r: any) => [Number(r.sim_id), money(r.requested_limit)]));
      const rows = sims
        .filter((s) => s.status === "active" || billBySim.has(s.id))
        .map((s) => {
          const b = billBySim.get(s.id);
          const limit = b ? money(b.limit_amount) : monthLimit.get(s.id) ?? s.limit_amount;
          const amount = b ? money(b.amount) : null;
          return {
            sim_id: s.id,
            bill_id: b ? Number(b.id) : null,
            phone_number: s.phone_number,
            operator: s.operator,
            employee: s.employee,
            duty_location: s.duty_location,
            limit_amount: limit,
            amount,
            payable: amount == null ? null : Math.min(amount, limit),
            excess: amount == null ? null : Math.max(0, money(amount - limit)),
            paid_at: b?.paid_at || null
          };
        });
      res.json({ month, rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The operator's bill: number + amount per row. Unknown numbers are left out
  // and listed back so HR can add the SIM first.
  app.post("/api/mobile-bill/bills/import", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const month = String(req.body?.month || "");
      if (!MONTH_RE.test(month)) return res.status(400).json({ error: "Pick the bill month." });
      const operator = (MOBILE_OPERATORS as readonly string[]).includes(req.body?.operator) ? req.body.operator : null;
      const replace = req.body?.replace === true;
      const dryRun = req.body?.dry_run !== false;
      const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 10000) : [];
      if (!rows.length) return res.status(400).json({ error: "The file has no rows." });
      const sims = await loadSims();
      const simByPhone = new Map<string, any>(sims.map((s) => [s.phone_number, s]));
      const existing: any[] = (await queryDB("SELECT sim_id, amount, paid_at FROM mobile_bills WHERE bill_month = ?", [month])) || [];
      const existingBySim = new Map<number, any>(existing.map((b) => [Number(b.sim_id), b]));
      const seen = new Map<number, number>();
      const results = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const phone = normalizeMobile(row.phone_number);
        const out: any = { row: i + 1, phone_number: phone || String(row.phone_number ?? ""), amount: null, errors: [] as string[], warnings: [] as string[] };
        const amount = Number(String(row.amount ?? "").replace(/[,৳\s]/g, ""));
        if (!phone) out.errors.push("Not a valid mobile number");
        if (!Number.isFinite(amount) || amount < 0 || String(row.amount ?? "").trim() === "") out.errors.push("Amount is not a number");
        else out.amount = money(amount);
        const sim = phone ? simByPhone.get(phone) : null;
        if (phone && !sim) out.errors.push("Number not in the SIM list — add the SIM first");
        if (sim && operator && sim.operator !== operator) out.errors.push(`This number is ${sim.operator}, not ${operator}`);
        if (sim && seen.has(sim.id)) out.errors.push(`Twice in this file (row ${seen.get(sim.id)})`);
        if (sim) seen.set(sim.id, i + 1);
        if (sim) {
          out.sim_id = sim.id;
          out.operator = sim.operator;
          out.employee_name = sim.employee?.name || null;
          out.limit_amount = await limitFor(queryDB, sim, month);
          const ex = existingBySim.get(sim.id);
          if (ex) {
            if (ex.paid_at) out.errors.push("This month's bill is already marked paid");
            else if (!replace) out.errors.push(`Already imported (৳${money(ex.amount)}) — tick "Replace" to overwrite`);
            else out.warnings.push(`Replaces ৳${money(ex.amount)}`);
          }
          if (sim.status !== "active") out.warnings.push("SIM is turned off");
        }
        results.push(out);
      }
      const ok = results.filter((r) => !r.errors.length);
      if (!dryRun) {
        for (const r of ok) {
          const sim = simByPhone.get(r.phone_number);
          await queryDB(
            `INSERT INTO mobile_bills (sim_id, bill_month, amount, limit_amount, employee_id, imported_by) VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE amount = VALUES(amount), limit_amount = VALUES(limit_amount), employee_id = VALUES(employee_id), imported_by = VALUES(imported_by), imported_at = CURRENT_TIMESTAMP`,
            [r.sim_id, month, r.amount, r.limit_amount, sim?.employee_id || null, req.user.id]
          );
        }
      }
      res.json({ dry_run: dryRun, month, total: results.length, ok: ok.length, failed: results.length - ok.length, amount: money(ok.reduce((s, r) => s + r.amount, 0)), rows: results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/mobile-bill/bills", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const month = String(req.body?.month || "");
      if (!MONTH_RE.test(month)) return res.status(400).json({ error: "Pick the bill month." });
      const sim = (await loadSims("WHERE id = ?", [Number(req.body?.sim_id)]))[0];
      if (!sim) return res.status(404).json({ error: "SIM not found." });
      const ex: any[] = (await queryDB("SELECT * FROM mobile_bills WHERE sim_id = ? AND bill_month = ?", [sim.id, month])) || [];
      if (ex[0]?.paid_at) return res.status(400).json({ error: "This bill is already marked paid — undo that first." });
      if (req.body?.amount === null || req.body?.amount === "") {
        await queryDB("DELETE FROM mobile_bills WHERE sim_id = ? AND bill_month = ?", [sim.id, month]);
        return res.json({ success: true });
      }
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "Enter the bill in taka." });
      const limit = ex[0] ? money(ex[0].limit_amount) : await limitFor(queryDB, sim, month);
      await queryDB(
        `INSERT INTO mobile_bills (sim_id, bill_month, amount, limit_amount, employee_id, imported_by) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE amount = VALUES(amount), imported_by = VALUES(imported_by)`,
        [sim.id, month, money(amount), limit, sim.employee_id, req.user.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark one month's bills paid (all, or one operator's) — or undo it.
  app.post("/api/mobile-bill/bills/mark-paid", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const month = String(req.body?.month || "");
      if (!MONTH_RE.test(month)) return res.status(400).json({ error: "Pick the bill month." });
      const operator = (MOBILE_OPERATORS as readonly string[]).includes(req.body?.operator) ? req.body.operator : null;
      const paid = req.body?.paid !== false;
      // Plain id list (no sub-select) so the company guard on writes applies.
      let simFilter = "";
      const params: any[] = paid ? [req.user.id, month] : [month];
      if (operator) {
        const ids = (await loadSims()).filter((s) => s.operator === operator).map((s) => s.id);
        if (!ids.length) return res.json({ success: true, updated: 0 });
        simFilter = ` AND sim_id IN (${ids.map(() => "?").join(",")})`;
        params.push(...ids);
      }
      const r: any = paid
        ? await queryDB(`UPDATE mobile_bills SET paid_at = NOW(), paid_by = ? WHERE bill_month = ? AND paid_at IS NULL${simFilter}`, params)
        : await queryDB(`UPDATE mobile_bills SET paid_at = NULL, paid_by = NULL WHERE bill_month = ?${simFilter}`, params);
      res.json({ success: true, updated: Number(r?.affectedRows || 0) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- reports -------------------------------------------------------------
  // Every bill between two months plus the SIM list; the page builds the
  // operator, month-by-month, average and over/under-limit views from it.
  app.get("/api/mobile-bill/report", authenticateToken, hrOnly, async (req: any, res: any) => {
    try {
      const to = MONTH_RE.test(String(req.query.to || "")) ? String(req.query.to) : thisMonth();
      const from = MONTH_RE.test(String(req.query.from || "")) ? String(req.query.from) : to;
      if (from > to) return res.status(400).json({ error: "From must be before To." });
      const [sims, bills]: any[] = await Promise.all([loadSims(), queryDB("SELECT * FROM mobile_bills WHERE bill_month >= ? AND bill_month <= ?", [from, to])]);
      res.json({
        from,
        to,
        sims,
        bills: (bills || []).map((b: any) => ({ sim_id: Number(b.sim_id), month: b.bill_month, amount: money(b.amount), limit_amount: money(b.limit_amount), paid: !!b.paid_at }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
