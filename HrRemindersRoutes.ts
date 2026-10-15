/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR reminders: dates HR must act on, sent as alerts (and push) before they
// arrive instead of waiting for someone to open the dashboard.
//
//   probation   — hr_employee_service.probation_end_date, until confirmed
//   contract    — hr_employee_service.contract_end_date
//   document    — employee_documents.expiry_date
//   retirement  — date of birth + the retirement age (HR Ops Settings)
//   increment   — the active increment policy (computeIncrementsDue)
//
// Who is told: Admin / User accounts ticked for the HR Operations layer
// "reminders_receive" in that company (explicit-only), plus the Employee's
// direct supervisor when HR Ops Settings say so. Superadmins can't be given
// layers (Module Access), so they see the list on the dashboard but get no
// alerts — a group's Superadmins aren't flooded.
//
// When: HR Ops Settings -> reminder_lead_days, e.g. "30,15,7,0" — one
// reminder as each of those days-before is reached (0 = on the day, or the
// first run after it is overdue). hr_reminder_log remembers what was sent,
// so each step goes once per person, however often the job runs. A date
// that already has a matching personnel action pending (confirmation,
// contract renewal…) is not reminded.
//
// The job runs two minutes after start-up and then hourly, once per company,
// inside that company's context (its own settings and Employees).

import type { Express } from "express";
import { companyStore, activeCompanyId } from "./companyContext";
import { contextForCompany } from "./CompanyRoutes";
import { loadSettings, computeIncrementsDue, addDays } from "./HROperationsRoutes";
import { runsBackgroundJobs } from "./jobRunner";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export const REMINDER_KINDS = ["probation", "contract", "document", "retirement", "increment"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

const KIND_LABEL: Record<ReminderKind, string> = {
  probation: "Probation ends",
  contract: "Contract ends",
  document: "Document expires",
  retirement: "Retirement",
  increment: "Increment due"
};
// The personnel actions that deal with each kind — offered as the next step,
// and a pending one of them means HR is already on it.
export const NEXT_ACTIONS: Record<ReminderKind, string[]> = {
  probation: ["confirmation", "probation_extension"],
  contract: ["contract_renewal", "termination"],
  document: [],
  retirement: ["retirement"],
  increment: ["increment"]
};

// How far back an overdue date is still reminded / listed.
const OVERDUE_DAYS = 30;

export async function ensureHrReminderSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS hr_reminder_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        company_id INT NOT NULL,
        kind VARCHAR(20) NOT NULL,
        employee_id INT NOT NULL,
        ref_key VARCHAR(40) NOT NULL DEFAULT '',
        ref_date DATE NOT NULL,
        lead_days INT NOT NULL,
        user_id INT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_hr_reminder (company_id, kind, employee_id, ref_key, ref_date, lead_days, user_id)
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure hr_reminder_log table exists: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (tests/hr_linkage.test.ts)
// ---------------------------------------------------------------------------

// "30,15,7,0" -> [30, 15, 7, 0] (whole days 0..365, largest first).
export function parseLeadDays(raw: any): number[] {
  const out = new Set<number>();
  for (const part of String(raw ?? "").split(/[,\s]+/)) {
    if (!/^\d+$/.test(part)) continue;
    const n = Number(part);
    if (n >= 0 && n <= 365) out.add(n);
  }
  const list = [...out].sort((a, b) => b - a);
  return list.length ? list : [30, 15, 7, 0];
}

// Which reminder step a date `days` away has reached: the smallest lead day
// that is >= days (so a late first run sends only the latest step, not all
// the earlier ones at once). Overdue dates fall on the smallest step; dates
// further out than the largest step, or overdue for too long, get none.
export function reminderStep(days: number, leads: number[]): number | null {
  if (!Number.isFinite(days) || days < -OVERDUE_DAYS) return null;
  const asc = [...leads].sort((a, b) => a - b);
  for (const s of asc) if (days <= s) return s;
  return null;
}

// The day someone born on dob reaches `age` (29 Feb -> 28 Feb).
export function retirementDate(dob: string | null | undefined, age: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob || ""));
  if (!m || !(age > 0)) return null;
  const y = Number(m[1]) + Math.floor(age);
  let d = Number(m[3]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > last) d = last;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const dateOnly = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
};

export function enabledKinds(settings: Record<string, string>): ReminderKind[] {
  const want = String(settings.reminder_kinds ?? REMINDER_KINDS.join(","))
    .split(",")
    .map((x) => x.trim());
  return REMINDER_KINDS.filter((k) => want.includes(k));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface HrEvent {
  key: string;
  kind: ReminderKind;
  label: string;
  detail: string | null;
  employee_id: number;
  employee_code: string | null;
  name: string;
  designation: string | null;
  user_id: number | null;
  date: string;
  days: number;
  next_actions: string[];
  pending_action: { id: number; type: string } | null;
  // Extra key part for kinds that can repeat for one Employee (documents).
  ref_key: string;
}

// Every watched date of the active company's active Employees between
// OVERDUE_DAYS ago and `horizon` days ahead.
export async function collectHrEvents(queryDB: QueryDB, today: string, settings: Record<string, string>, horizon: number): Promise<HrEvent[]> {
  const kinds = enabledKinds(settings);
  const safe = (sql: string, params?: any[]) => queryDB(sql, params).catch(() => [] as any[]);
  const [employees, services, docs, actions]: any[][] = await Promise.all([
    safe("SELECT * FROM all_employees"),
    safe("SELECT * FROM hr_employee_service"),
    kinds.includes("document") ? safe("SELECT id, user_id, doc_type, expiry_date FROM employee_documents") : Promise.resolve([]),
    safe("SELECT id, employee_id, action_type, status FROM hr_actions")
  ]);
  const active = (employees || []).filter((e: any) => Number(e.is_active ?? 1) === 1);
  const byId = new Map<number, any>(active.map((e: any) => [Number(e.id), e]));
  const byUser = new Map<number, any>(active.filter((e: any) => e.user_id).map((e: any) => [Number(e.user_id), e]));
  const pendingFor = (empId: number, kind: ReminderKind) => {
    const a = (actions || []).find((x: any) => Number(x.employee_id) === empId && x.status === "pending" && NEXT_ACTIONS[kind].includes(x.action_type));
    return a ? { id: Number(a.id), type: String(a.action_type) } : null;
  };
  const out: HrEvent[] = [];
  const push = (kind: ReminderKind, e: any, date: string | null, detail: string | null, refKey = "") => {
    if (!date) return;
    const days = daysBetween(today, date);
    if (days < -OVERDUE_DAYS || days > horizon) return;
    out.push({
      key: `${kind}:${e.id}:${refKey}:${date}`,
      kind,
      label: KIND_LABEL[kind],
      detail,
      employee_id: Number(e.id),
      employee_code: e.employee_id ?? null,
      name: e.name,
      designation: e.designation ?? null,
      user_id: e.user_id ? Number(e.user_id) : null,
      date,
      days,
      next_actions: NEXT_ACTIONS[kind],
      pending_action: pendingFor(Number(e.id), kind),
      ref_key: refKey
    });
  };
  for (const s of services || []) {
    const e = byId.get(Number(s.employee_id));
    if (!e) continue;
    const confirmed = !!dateOnly(s.confirmation_date) || /confirm/i.test(String(s.service_status || ""));
    if (kinds.includes("probation") && !confirmed) push("probation", e, dateOnly(s.probation_end_date), null);
    if (kinds.includes("contract")) push("contract", e, dateOnly(s.contract_end_date), null);
  }
  for (const d of docs || []) {
    const e = byUser.get(Number(d.user_id));
    if (e) push("document", e, dateOnly(d.expiry_date), d.doc_type || "Document", `doc${d.id}`);
  }
  if (kinds.includes("retirement")) {
    const age = Number(settings.retirement_age || 60);
    for (const e of active) push("retirement", e, retirementDate(dateOnly(e.date_of_birth), age), `Age ${age}`);
  }
  if (kinds.includes("increment")) {
    const r = await computeIncrementsDue(queryDB, today, { from: addDays(today, -OVERDUE_DAYS), to: addDays(today, horizon) }).catch(() => ({ rows: [] as any[] }));
    for (const row of r.rows || []) {
      const e = byId.get(Number(row.employee_id));
      if (e) push("increment", e, row.due_date, row.percent ? `${row.percent}% by policy` : null);
    }
  }
  return out.sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

type CreateAlert = (queryDB: QueryDB, params: { userId: number; type: any; title: string; message: string; relatedType?: string; relatedId?: number }) => Promise<void>;

// Accounts of this company ticked for "reminders_receive" and still holding
// HR Operations itself, not blocked.
async function reminderRecipients(queryDB: QueryDB, companyId: number): Promise<number[]> {
  const rows: any[] = await queryDB(
    `/*unscoped*/ SELECT DISTINCT u.id FROM admin_module_permission_layers l
       JOIN users u ON u.id = l.user_id
       JOIN admin_module_permissions p ON p.user_id = l.user_id AND p.module_key = 'hr_operations' AND p.company_id = l.company_id
      WHERE l.module_key = 'hr_operations' AND l.layer_key = 'reminders_receive' AND l.company_id = ?
        AND u.role IN ('admin', 'user') AND COALESCE(u.is_blocked, 0) = 0`,
    [companyId]
  ).catch(() => []);
  return (rows || []).map((r: any) => Number(r.id));
}

const whenText = (days: number) => (days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`);

// One pass for the active company. Returns how many reminders went out.
export async function runRemindersForCompany(queryDB: QueryDB, createAlert: CreateAlert, today: string): Promise<{ sent: number; alerts: number }> {
  const settings = await loadSettings(queryDB);
  if (String(settings.reminders_enabled ?? "1") !== "1") return { sent: 0, alerts: 0 };
  const leads = parseLeadDays(settings.reminder_lead_days);
  const companyId = activeCompanyId();
  const events = await collectHrEvents(queryDB, today, settings, Math.max(...leads));
  const hr = await reminderRecipients(queryDB, companyId);
  const notifySupervisor = String(settings.reminder_notify_supervisor ?? "1") === "1";
  const [supervisors, employees]: any[][] = notifySupervisor
    ? await Promise.all([queryDB("SELECT employee_id, supervisor_id, is_direct FROM employee_supervisors").catch(() => []), queryDB("SELECT id, user_id FROM all_employees").catch(() => [])])
    : [[], []];
  const supervisorUser = (empId: number): number | null => {
    const s = (supervisors || []).find((x: any) => Number(x.employee_id) === empId && Number(x.is_direct) === 1);
    const u = s && (employees || []).find((e: any) => Number(e.id) === Number(s.supervisor_id))?.user_id;
    return u ? Number(u) : null;
  };
  const batches = new Map<number, HrEvent[]>();
  let sent = 0;
  for (const ev of events) {
    if (ev.pending_action) continue;
    const step = reminderStep(ev.days, leads);
    if (step === null) continue;
    const to = new Set<number>(hr);
    const sup = notifySupervisor ? supervisorUser(ev.employee_id) : null;
    if (sup && sup !== ev.user_id) to.add(sup);
    for (const uid of to) {
      const r: any = await queryDB(
        "/*unscoped*/ INSERT IGNORE INTO hr_reminder_log (company_id, kind, employee_id, ref_key, ref_date, lead_days, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [companyId, ev.kind, ev.employee_id, ev.ref_key, ev.date, step, uid]
      ).catch(() => null);
      if (!r || Number(r.affectedRows) !== 1) continue;
      sent++;
      batches.set(uid, [...(batches.get(uid) || []), ev]);
    }
  }
  // One alert (and push) per person per run, listing everything due.
  const hrSet = new Set(hr);
  for (const [uid, list] of batches) {
    const line = (e: HrEvent) => `${e.label}${e.detail ? ` (${e.detail})` : ""} — ${e.name}${e.employee_code ? ` (${e.employee_code})` : ""}, ${whenText(e.days)}`;
    await createAlert(queryDB, {
      userId: uid,
      type: "hr_reminder",
      title: list.length === 1 ? `${list[0].label} ${whenText(list[0].days)}: ${list[0].name}` : `${list.length} HR dates coming up`,
      message: `${list.slice(0, 8).map(line).join("; ")}${list.length > 8 ? `; and ${list.length - 8} more` : ""}.${hrSet.has(uid) ? " Open HR Operations → Dashboard to act on it." : " You are their direct supervisor."}`,
      relatedType: "hr_reminder"
    }).catch(() => {});
  }
  return { sent, alerts: batches.size };
}

// Every active company, each in its own context.
export async function runAllReminders(queryDB: QueryDB, createAlert: CreateAlert, today: string) {
  const companies: any[] = await queryDB("/*unscoped*/ SELECT id, is_active FROM companies").catch(() => []);
  const ids = (companies || []).filter((c: any) => Number(c.is_active ?? 1) === 1).map((c: any) => Number(c.id));
  const result: Record<number, { sent: number; alerts: number }> = {};
  for (const id of ids.length ? ids : [1]) {
    try {
      const ctx = await contextForCompany(queryDB, id);
      result[id] = await companyStore.run(ctx, () => runRemindersForCompany(queryDB, createAlert, today));
    } catch (err: any) {
      console.warn(`⚠️ HR reminders for company ${id}: ${err.message}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface HrReminderDeps {
  authenticateToken: any;
  requireModule: (k: "hr_operations") => any;
  requireModuleLayer: (k: "hr_operations", layer: "reminders_receive") => any;
  hasModuleLayer: (user: any, k: "hr_operations", layer: string) => Promise<boolean>;
  queryDB: QueryDB;
  createAlert: CreateAlert;
  todayInDhaka: () => string;
  // Runs the hourly job (off when there is no MySQL).
  schedule: boolean;
}

export function registerHrReminderRoutes(app: Express, deps: HrReminderDeps) {
  const { authenticateToken, requireModule, requireModuleLayer, hasModuleLayer, queryDB, createAlert, todayInDhaka } = deps;
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });

  app.get("/api/hr-ops/reminders/access", authenticateToken, requireModule("hr_operations"), async (req: any, res: any) => {
    try {
      res.json({ reminders_receive: await hasModuleLayer(req.user, "hr_operations", "reminders_receive") });
    } catch (err) {
      fail(res, err);
    }
  });

  // HR Operations -> Dashboard: what is coming up (and recently overdue).
  app.get("/api/hr-ops/reminders/upcoming", authenticateToken, requireModule("hr_operations"), requireModuleLayer("hr_operations", "reminders_receive"), async (_req: any, res: any) => {
    try {
      const today = todayInDhaka();
      const settings = await loadSettings(queryDB);
      res.json({ today, kinds: enabledKinds(settings), events: await collectHrEvents(queryDB, today, settings, 60) });
    } catch (err) {
      fail(res, err);
    }
  });

  // tests/hr_linkage.test.ts: run the job now, optionally as if it were
  // another day. Only on a server started with NODE_ENV=test.
  app.post("/api/hr-ops/reminders/run", authenticateToken, async (req: any, res: any) => {
    if (process.env.NODE_ENV !== "test") return res.status(404).json({ error: "Not found" });
    if (req.user?.role !== "superadmin") return res.status(403).json({ error: "Superadmin only." });
    try {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.today || "")) ? String(req.body.today) : todayInDhaka();
      res.json({ today: day, companies: await runAllReminders(queryDB, createAlert, day) });
    } catch (err) {
      fail(res, err);
    }
  });

  if (deps.schedule && runsBackgroundJobs()) {
    const tick = () => runAllReminders(queryDB, createAlert, todayInDhaka()).catch((err) => console.warn("⚠️ HR reminders: " + err.message));
    setTimeout(tick, 2 * 60 * 1000);
    setInterval(tick, 60 * 60 * 1000);
  }
}
