/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Bill Claim Policy (Admin Panel -> HRM -> Claims/Bill/Disbursement -> Bill
// Claim Policy) — the rules a Bill Claim is checked against, and the
// list of bill categories, both kept in the database so the Superadmin changes
// them from the screen, never in code.
//
// How it fits together:
//   POLICY_DEFS        every rule the engine knows: key, type, default, label.
//                      The Policy page draws its form from this list (served by
//                      GET /api/bill-claim-policy), so a rule added here shows
//                      up there with nothing else to wire.
//   bill_claim_policy_settings
//                      the value the Superadmin chose for each rule, per
//                      company (a rule never saved uses its default).
//   bill_claim_categories
//                      bill categories with their own optional limits. A
//                      category is never removed from old claims: each bill
//                      line keeps the category NAME it was filed under, so
//                      deleting or renaming one leaves past claims as they were.
//   bill_claim_items   the bill lines of a claim — one per category/date/amount.
//   checkClaimBills()  applies every rule to a claim being filed.
//   bill_claim_policy_history
//                      every change anyone makes here (and every refused
//                      attempt), who/when/before/after. Append-only: no route
//                      edits or deletes it, database triggers refuse UPDATE and
//                      DELETE on it, and each row carries a hash of the row
//                      before it, so a row altered or removed directly in the
//                      database shows up as a broken chain (History -> Verify).
//                      Its company column is company_ref, not company_id, so
//                      deleting a company (companyDelete.ts) leaves it alone.
//
// Sister companies can use the mother company's policy (Companies -> "Uses the
// mother company's… Bill claim policy & categories"), like the other shared
// settings in companyScope.ts.

import type { Express } from "express";
import { createHash } from "crypto";
import { activeCompanyId } from "./companyContext";
import { sendPushToUserIds } from "./PushNotificationService";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export type PolicyValue = number | boolean;

export interface PolicyDef {
  key: string;
  group: "dates" | "amounts" | "claim" | "review";
  label: string;
  help: string;
  type: "number" | "boolean";
  default: PolicyValue;
  min?: number;
  max?: number;
  unit?: string;
}

// Every rule the engine applies. 0 on a number rule means "no limit" unless
// its help says otherwise.
export const POLICY_DEFS: PolicyDef[] = [
  {
    key: "backdate_days",
    group: "dates",
    label: "Bills can be claimed for the last … days",
    help: "A bill's date can be today or up to this many days before today. 0 = today only.",
    type: "number",
    default: 5,
    min: 0,
    max: 365,
    unit: "days"
  },
  {
    key: "allow_future_dates",
    group: "dates",
    label: "Allow future bill dates",
    help: "Off: a bill's date can't be after today.",
    type: "boolean",
    default: false
  },
  {
    key: "lock_dates_after_day",
    group: "dates",
    label: "Close a date once its claim day has passed",
    help:
      "Bills for a date can be added any number of times on the day they're first claimed. From the next day on, no more bills can be added for that date.",
    type: "boolean",
    default: true
  },
  {
    key: "rejected_dates_reopen",
    group: "dates",
    label: "Rejected claims don't close their dates",
    help:
      "On: if a claim was rejected, its dates can be claimed again. Only used while \"One claim per date\" is off — with it on, a rejected claim keeps its dates unless the approver ticks \"Allow re-claim\".",
    type: "boolean",
    default: true
  },
  {
    key: "one_claim_per_date",
    group: "dates",
    label: "One claim per date",
    help:
      "A date's bills all go in one claim. To add or change a bill for a date that already has a claim, the employee edits that claim instead of filing a new one.",
    type: "boolean",
    default: true
  },
  {
    key: "lock_whole_range",
    group: "dates",
    label: "A claim holds every date from its From Date to its To Date",
    help:
      "With \"One claim per date\": no date inside a claim's From–To range can be picked again in another claim, even a date that has no bill in it. Off: only the dates that have a bill are held.",
    type: "boolean",
    default: true
  },
  {
    key: "one_claim_per_day",
    group: "claim",
    label: "One new claim per day",
    help: "An employee can file one claim a day (its Claim Date). To add more bills that day they edit that claim instead of filing another.",
    type: "boolean",
    default: true
  },
  {
    key: "transport_from_check_in_out",
    group: "claim",
    label: "Transport bills come only from Check In/Out",
    help:
      "A Transport bill's amount is the total of the check-in/outs ticked for it — it can't be typed in. At least one check-in/out must be ticked, and a claim has one Transport bill (every check-in/out goes on it). Off: a Transport bill with no check-in/out can have its amount typed in.",
    type: "boolean",
    default: true
  },
  {
    key: "window_from_first_submit",
    group: "dates",
    label: "Count the date window from the day the claim was first filed",
    help: "On: a claim edited later (e.g. after a Return) still accepts the dates it could take when it was filed. Off: counted from the day of the edit.",
    type: "boolean",
    default: true
  },
  {
    key: "edit_lock_layer",
    group: "review",
    label: "The employee can edit a claim until this Layer approves it",
    help: "1 = until the Supervisor (or the template's first Layer) approves. After that the claim is locked; only a Return reopens it.",
    type: "number",
    default: 1,
    min: 1,
    max: 10,
    unit: "layer"
  },
  {
    key: "allow_return",
    group: "review",
    label: "Approvers can Return a claim for correction",
    help: "The Layer holding the claim sends it back to the employee with a reason; after the edit it starts again from Layer 1. Not possible once the bill is made.",
    type: "boolean",
    default: true
  },
  {
    key: "approver_signature",
    group: "review",
    label: "Put each approver's signature on the Bill and Voucher",
    help: "When a Layer approves a claim, that approver's saved signature (Approve Application → My signature) is kept with that approval and printed under \"Approved By\" on the Conveyance Bill and Payment Voucher PDFs, with their name, Layer and the date. An approver with no saved signature is printed by name only.",
    type: "boolean",
    default: false
  },
  {
    key: "decision_reason_required",
    group: "review",
    label: "A reason is required to Return or Reject",
    help: "The reason is shown to the employee.",
    type: "boolean",
    default: true
  },
  {
    key: "allow_reclaim_on_reject",
    group: "review",
    label: "Approvers can allow a re-claim when rejecting",
    help: "Shows an \"Allow re-claim\" tick on Reject. Ticked: the employee may edit and resubmit the claim. Not ticked: the rejection is final and its dates stay closed.",
    type: "boolean",
    default: true
  },
  {
    key: "max_bills_per_claim",
    group: "claim",
    label: "Most bills in one claim",
    help: "How many bill lines one claim may have.",
    type: "number",
    default: 20,
    min: 1,
    max: 200,
    unit: "bills"
  },
  {
    key: "max_claim_total",
    group: "amounts",
    label: "Largest claim total",
    help: "The most one claim can add up to. 0 = no limit.",
    type: "number",
    default: 0,
    min: 0,
    unit: "৳"
  },
  {
    key: "attachment_required_above",
    group: "amounts",
    label: "Receipt needed when the claim total is above",
    help: "Claims over this total must attach a receipt/file. 0 = never required by amount.",
    type: "number",
    default: 0,
    min: 0,
    unit: "৳"
  },
  {
    key: "enforce_category_limits",
    group: "amounts",
    label: "Apply each category's own limits",
    help: "Uses the per-bill limit, monthly limit and receipt setting of each category below.",
    type: "boolean",
    default: true
  }
];

export const DEFAULT_CATEGORIES = ["Transport", "Fuel", "Toll", "Parking", "Others"];

// runPlain: a non-prepared query (CREATE TRIGGER can't go through prepared statements).
export async function ensureBillClaimPolicySchema(queryDB: QueryDB, runPlain: (sql: string) => Promise<unknown> = queryDB) {
  await queryDB(`CREATE TABLE IF NOT EXISTS bill_claim_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL DEFAULT 1,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    max_per_bill DECIMAL(12, 2) NULL,
    monthly_limit DECIMAL(12, 2) NULL,
    receipt_required TINYINT(1) NOT NULL DEFAULT 0,
    deleted_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_bcc_company (company_id)
  )`);
  await queryDB(`CREATE TABLE IF NOT EXISTS bill_claim_policy_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL DEFAULT 1,
    policy_key VARCHAR(64) NOT NULL,
    policy_value VARCHAR(255) NOT NULL,
    updated_by INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_bcp_company_key (company_id, policy_key)
  )`);
  await queryDB(`CREATE TABLE IF NOT EXISTS bill_claim_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bill_claim_id INT NOT NULL,
    category_id INT NULL,
    category_name VARCHAR(100) NOT NULL,
    bill_date DATE NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    description VARCHAR(500) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_uci_claim (bill_claim_id),
    KEY idx_uci_date (bill_date),
    FOREIGN KEY (bill_claim_id) REFERENCES bill_claims(id) ON DELETE CASCADE
  )`);
  await queryDB(`CREATE TABLE IF NOT EXISTS bill_claim_policy_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    company_ref INT NOT NULL,
    actor_id INT NULL,
    actor_name VARCHAR(150) NULL,
    actor_role VARCHAR(30) NULL,
    action VARCHAR(40) NOT NULL,
    target_type VARCHAR(20) NOT NULL,
    target_id INT NULL,
    target_name VARCHAR(150) NULL,
    before_json TEXT NULL,
    after_json TEXT NULL,
    ip VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL,
    created_at VARCHAR(30) NOT NULL,
    prev_hash CHAR(64) NOT NULL,
    row_hash CHAR(64) NOT NULL,
    KEY idx_bcph_company (company_ref, id)
  )`);
  // The database itself refuses to change or remove history rows.
  try {
    const have: any[] =
      (await queryDB(
        "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'bill_claim_policy_history'"
      )) || [];
    const names = new Set(have.map((t) => t.TRIGGER_NAME));
    for (const [name, event] of [
      ["bcph_no_update", "UPDATE"],
      ["bcph_no_delete", "DELETE"]
    ]) {
      if (names.has(name)) continue;
      await runPlain(
        `CREATE TRIGGER ${name} BEFORE ${event} ON bill_claim_policy_history FOR EACH ROW
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Bill Claim Policy history cannot be changed or deleted.'`
      );
    }
  } catch (err: any) {
    console.warn(
      "⚠️ Could not add the Bill Claim Policy history guard triggers (the app itself never changes history, and the hash chain still shows tampering): " +
        err.message +
        " — a MySQL admin can run SET GLOBAL log_bin_trust_function_creators = 1; once (or grant the TRIGGER/SUPER privilege) and restart the app."
    );
  }
  // The rules people must read before their first Bill Claim: each change to
  // the rules is a new version (a hash of the rules, so any change counts),
  // and every open / confirm of them is kept (Bill Claim → (i) Rules).
  await queryDB(`CREATE TABLE IF NOT EXISTS bill_claim_rule_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_ref INT NOT NULL,
    rules_hash CHAR(64) NOT NULL,
    changed_by VARCHAR(150) NULL,
    summary VARCHAR(255) NULL,
    created_at DATETIME NOT NULL,
    KEY idx_bcrv_company (company_ref, id)
  )`);
  await queryDB(`CREATE TABLE IF NOT EXISTS bill_claim_rule_reads (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    company_ref INT NOT NULL,
    user_id INT NOT NULL,
    version_id INT NOT NULL,
    action VARCHAR(16) NOT NULL,
    device VARCHAR(60) NULL,
    ip VARCHAR(64) NULL,
    created_at DATETIME NOT NULL,
    KEY idx_bcrr_user (company_ref, user_id, id),
    KEY idx_bcrr_company (company_ref, id)
  )`);
  // A category's limit per day, and its limits by designation (JSON list of
  // { designation_id, designation, max_per_bill, daily_limit, monthly_limit } —
  // a field left blank there uses the category's own).
  for (const sql of [
    "ALTER TABLE bill_claim_categories ADD COLUMN daily_limit DECIMAL(12, 2) NULL AFTER max_per_bill",
    "ALTER TABLE bill_claim_categories ADD COLUMN designation_limits TEXT NULL"
  ]) {
    await queryDB(sql).catch((err: any) => {
      if (err?.code !== "ER_DUP_FIELDNAME") throw err;
    });
  }
  // Categories come from bill_claim_categories now, so the claim's own
  // category column holds any name (or "Fuel, Toll" for a multi-category claim).
  const cols: any[] = (await queryDB("SHOW COLUMNS FROM bill_claims LIKE 'category'")) || [];
  if (cols[0] && /^enum/i.test(String(cols[0].Type))) {
    await queryDB("ALTER TABLE bill_claims MODIFY COLUMN category VARCHAR(255) NOT NULL DEFAULT 'Others'");
  }
}

// ---- helpers ----

export function dhakaDate(value: any): string {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value).slice(0, 10);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  return `${p.find((x) => x.type === "year")!.value}-${p.find((x) => x.type === "month")!.value}-${p.find((x) => x.type === "day")!.value}`;
}

// Plain calendar-day arithmetic on YYYY-MM-DD.
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

const isDate = (v: any) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function parseValue(def: PolicyDef, raw: any): PolicyValue {
  if (def.type === "boolean") return raw === true || raw === 1 || raw === "1" || raw === "true";
  let n = Number(raw);
  if (!Number.isFinite(n)) n = Number(def.default);
  if (def.min != null) n = Math.max(def.min, n);
  if (def.max != null) n = Math.min(def.max, n);
  return n;
}

export type PolicyValues = Record<string, PolicyValue>;

/** The rules in force for the active company (own values first, then the mother company's, then defaults). */
export async function loadPolicy(queryDB: QueryDB): Promise<PolicyValues> {
  const rows: any[] = (await queryDB("SELECT company_id, policy_key, policy_value FROM bill_claim_policy_settings")) || [];
  const own = activeCompanyId();
  const values: PolicyValues = {};
  for (const def of POLICY_DEFS) {
    const mine = rows.find((r) => r.policy_key === def.key && Number(r.company_id) === own);
    const any = mine || rows.find((r) => r.policy_key === def.key);
    values[def.key] = any ? parseValue(def, any.policy_value) : def.default;
  }
  return values;
}

export interface BillCategory {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  max_per_bill: number | null;
  daily_limit: number | null;
  monthly_limit: number | null;
  receipt_required: boolean;
  designation_limits: DesignationLimit[];
  // Set on the copy a claimant gets (categoriesFor): whose designation's
  // limits are in force instead of the category's own.
  limits_for?: string | null;
}

export interface DesignationLimit {
  designation_id: number | null;
  designation: string;
  max_per_bill: number | null;
  daily_limit: number | null;
  monthly_limit: number | null;
}

const num = (x: any): number | null => (x === "" || x == null || !Number.isFinite(Number(x)) ? null : Number(x));

function parseDesignationLimits(raw: any): DesignationLimit[] {
  let list: any[] = [];
  try {
    list = Array.isArray(raw) ? raw : raw ? JSON.parse(String(raw)) : [];
  } catch {
    list = [];
  }
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && String(d.designation || "").trim())
    .map((d) => ({
      designation_id: num(d.designation_id),
      designation: String(d.designation).trim().slice(0, 150),
      max_per_bill: num(d.max_per_bill),
      daily_limit: num(d.daily_limit),
      monthly_limit: num(d.monthly_limit)
    }));
}

function toCategory(r: any): BillCategory {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description ?? null,
    is_active: !!Number(r.is_active),
    sort_order: Number(r.sort_order) || 0,
    max_per_bill: r.max_per_bill != null ? Number(r.max_per_bill) : null,
    daily_limit: r.daily_limit != null ? Number(r.daily_limit) : null,
    monthly_limit: r.monthly_limit != null ? Number(r.monthly_limit) : null,
    receipt_required: !!Number(r.receipt_required),
    designation_limits: parseDesignationLimits(r.designation_limits)
  };
}

/**
 * The categories as they apply to one employee: where a category has limits
 * for the employee's designation (matched by designation id, else by name),
 * those replace the category's own — a field left blank keeps the category's.
 */
export async function categoriesFor(queryDB: QueryDB, userId: number): Promise<BillCategory[]> {
  const cats = await loadCategories(queryDB);
  if (!cats.some((c) => c.designation_limits.length)) return cats;
  const emp: any = ((await queryDB("SELECT designation_id, designation FROM all_employees WHERE user_id = ? LIMIT 1", [userId]).catch(() => [])) || [])[0];
  if (!emp) return cats;
  const did = num(emp.designation_id);
  const dname = String(emp.designation || "").trim().toLowerCase();
  return cats.map((c) => {
    const hit =
      c.designation_limits.find((d) => did != null && d.designation_id === did) ||
      (dname ? c.designation_limits.find((d) => d.designation.toLowerCase() === dname) : undefined);
    if (!hit) return c;
    return {
      ...c,
      max_per_bill: hit.max_per_bill ?? c.max_per_bill,
      daily_limit: hit.daily_limit ?? c.daily_limit,
      monthly_limit: hit.monthly_limit ?? c.monthly_limit,
      limits_for: hit.designation
    };
  });
}

// ---- history (append-only) ----

export interface HistoryActor {
  id: number | null;
  name: string | null;
  role: string | null;
  ip?: string | null;
  userAgent?: string | null;
}
export const SYSTEM_ACTOR: HistoryActor = { id: null, name: "System", role: "system" };
export function actorFrom(req: any): HistoryActor {
  const fwd = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return {
    id: req.user?.id ?? null,
    name: req.user?.name ?? req.user?.email ?? null,
    role: req.user?.role ?? null,
    ip: (fwd || req.ip || "").slice(0, 64) || null,
    userAgent: String(req.headers?.["user-agent"] || "").slice(0, 255) || null
  };
}

const GENESIS = "0".repeat(64);
const hashRow = (r: any) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        r.prev_hash,
        Number(r.company_ref),
        r.actor_id != null ? Number(r.actor_id) : null,
        r.actor_name ?? null,
        r.actor_role ?? null,
        r.action,
        r.target_type,
        r.target_id != null ? Number(r.target_id) : null,
        r.target_name ?? null,
        r.before_json ?? null,
        r.after_json ?? null,
        r.ip ?? null,
        r.user_agent ?? null,
        r.created_at
      ])
    )
    .digest("hex");

// One writer at a time, so each row links to the row really before it.
let historyQueue: Promise<unknown> = Promise.resolve();

/** Appends one history row. Never throws into the caller's request. */
export function recordHistory(
  queryDB: QueryDB,
  actor: HistoryActor,
  entry: { action: string; targetType: "rule" | "category" | "policy"; targetId?: number | null; targetName?: string | null; before?: any; after?: any },
  companyRef = activeCompanyId()
): Promise<void> {
  const run = async () => {
    const last: any[] =
      (await queryDB("SELECT row_hash FROM bill_claim_policy_history WHERE company_ref = ? ORDER BY id DESC LIMIT 1", [companyRef])) || [];
    const row: any = {
      company_ref: companyRef,
      actor_id: actor.id,
      actor_name: actor.name ? String(actor.name).slice(0, 150) : null,
      actor_role: actor.role,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      target_name: entry.targetName ? String(entry.targetName).slice(0, 150) : null,
      before_json: entry.before === undefined ? null : JSON.stringify(entry.before),
      after_json: entry.after === undefined ? null : JSON.stringify(entry.after),
      ip: actor.ip ?? null,
      user_agent: actor.userAgent ?? null,
      created_at: new Date().toISOString(),
      prev_hash: last[0]?.row_hash || GENESIS
    };
    row.row_hash = hashRow(row);
    await queryDB(
      `INSERT INTO bill_claim_policy_history
         (company_ref, actor_id, actor_name, actor_role, action, target_type, target_id, target_name, before_json, after_json, ip, user_agent, created_at, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.company_ref, row.actor_id, row.actor_name, row.actor_role, row.action, row.target_type, row.target_id, row.target_name,
        row.before_json, row.after_json, row.ip, row.user_agent, row.created_at, row.prev_hash, row.row_hash
      ]
    );
  };
  const p = historyQueue.then(run, run);
  historyQueue = p.catch(() => {});
  return p.catch((err: any) => console.warn("⚠️ Could not record Bill Claim Policy history: " + err.message));
}

/** Re-checks the hash chain of a company's history. */
export async function verifyHistory(queryDB: QueryDB, companyRef = activeCompanyId()) {
  const rows: any[] = (await queryDB("SELECT * FROM bill_claim_policy_history WHERE company_ref = ? ORDER BY id ASC", [companyRef])) || [];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || hashRow(r) !== r.row_hash) return { ok: false, checked: rows.length, broken_at: Number(r.id) };
    prev = r.row_hash;
  }
  return { ok: true, checked: rows.length, broken_at: null as number | null };
}

/** Whether the database triggers that refuse UPDATE/DELETE on history are in place. */
export async function historyGuardActive(queryDB: QueryDB): Promise<boolean> {
  const t: any[] =
    (await queryDB(
      "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'bill_claim_policy_history'"
    ).catch(() => [])) || [];
  const names = new Set(t.map((x) => x.TRIGGER_NAME));
  return names.has("bcph_no_update") && names.has("bcph_no_delete");
}

/** Categories not deleted (active and inactive). A company that never had any gets the defaults. */
export async function loadCategories(queryDB: QueryDB): Promise<BillCategory[]> {
  let rows: any[] = (await queryDB("SELECT * FROM bill_claim_categories")) || [];
  if (rows.length === 0) {
    for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
      await queryDB("INSERT INTO bill_claim_categories (name, sort_order) VALUES (?, ?)", [DEFAULT_CATEGORIES[i], i + 1]);
    }
    rows = (await queryDB("SELECT * FROM bill_claim_categories")) || [];
    await recordHistory(queryDB, SYSTEM_ACTOR, {
      action: "categories_seeded",
      targetType: "category",
      targetName: "Starting categories",
      after: rows.map(toCategory)
    });
  }
  return rows
    .filter((r) => !r.deleted_at)
    .map(toCategory)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

/**
 * Dates (within [from, to]) this user can no longer put in a new claim (or in
 * `excludeClaimId`, the claim being edited), each with the claim that holds it.
 *
 * "One claim per date" on: every date that is already in another claim of
 * theirs, whatever its status (a rejected claim keeps its dates unless the
 * approver allowed a re-claim — and then it is that same claim that gets
 * edited). Off: the older rule — a date closes once the day its claim was
 * filed has passed (rejected claims optionally reopening theirs).
 */
export async function claimedDates(
  queryDB: QueryDB,
  userId: number,
  today: string,
  from: string,
  to: string,
  policy: PolicyValues,
  excludeClaimId: number | null = null
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const oneClaim = !!policy.one_claim_per_date;
  if (!oneClaim && !policy.lock_dates_after_day) return out;
  const claims: any[] =
    (await queryDB("SELECT id, status, created_at, from_date, to_date FROM bill_claims WHERE user_id = ?", [userId])) || [];
  const others = claims.filter((c) => Number(c.id) !== Number(excludeClaimId));
  const holding = oneClaim
    ? others
    : others.filter((c) => dhakaDate(c.created_at) < today && !(policy.rejected_dates_reopen && c.status === "rejected"));
  if (holding.length === 0) return out;
  const ids = holding.map((c) => Number(c.id));
  const items: any[] =
    (await queryDB(`SELECT bill_claim_id, bill_date FROM bill_claim_items WHERE bill_claim_id IN (${ids.map(() => "?").join(",")})`, ids)) || [];
  const withItems = new Set(items.map((i) => Number(i.bill_claim_id)));
  for (const i of items) {
    const d = dhakaDate(i.bill_date);
    if (d >= from && d <= to && !out.has(d)) out.set(d, Number(i.bill_claim_id));
  }
  // Claims filed before bill lines existed — and, with "a claim holds every
  // date from its From Date to its To Date", every claim — hold their whole
  // From–To range.
  const wholeRange = oneClaim && !!policy.lock_whole_range;
  for (const c of holding) {
    if (withItems.has(Number(c.id)) && !wholeRange) continue;
    const f = dhakaDate(c.from_date);
    const t = dhakaDate(c.to_date) || f;
    if (!f || t < from || f > to) continue;
    for (const d of datesBetween(f < from ? from : f, t > to ? to : t)) if (!out.has(d)) out.set(d, Number(c.id));
  }
  return out;
}

/** The claim this user already filed on `day` (its Claim Date), if any — for "One new claim per day". */
export async function claimFiledOn(queryDB: QueryDB, userId: number, day: string, excludeClaimId: number | null = null): Promise<number | null> {
  const rows: any[] = (await queryDB("SELECT id, claim_date FROM bill_claims WHERE user_id = ?", [userId])) || [];
  const hit = rows.find((r) => Number(r.id) !== Number(excludeClaimId) && dhakaDate(r.claim_date) === day);
  return hit ? Number(hit.id) : null;
}

export async function lockedDates(
  queryDB: QueryDB,
  userId: number,
  today: string,
  from: string,
  to: string,
  policy: PolicyValues,
  excludeClaimId: number | null = null
): Promise<string[]> {
  return [...(await claimedDates(queryDB, userId, today, from, to, policy, excludeClaimId)).keys()].sort();
}

/**
 * The date window the policy allows today. `firstFiled` (YYYY-MM-DD) is the
 * day a claim being edited was first filed: with "count the window from the
 * day the claim was first filed" on, the window starts from that day instead.
 */
export function dateWindow(policy: PolicyValues, today: string, firstFiled?: string | null) {
  const back = Number(policy.backdate_days) || 0;
  const base = firstFiled && policy.window_from_first_submit && firstFiled < today ? firstFiled : today;
  return { min: addDays(base, -back), max: policy.allow_future_dates ? addDays(today, 365) : today };
}

export interface BillLineInput {
  category_id?: any;
  category?: any;
  bill_date?: any;
  amount?: any;
  description?: any;
}
export interface CheckedLine {
  category_id: number | null;
  category_name: string;
  bill_date: string;
  amount: number;
  description: string | null;
}

/**
 * Applies every rule to a claim being filed. Returns the cleaned bill lines,
 * or the first rule it breaks as `error`.
 */
export async function checkClaimBills(
  queryDB: QueryDB,
  args: {
    userId: number;
    today: string;
    from: string;
    to: string;
    lines: BillLineInput[];
    extraTotal: number;
    hasAttachment: boolean;
    // Editing an existing claim: its own id (its dates and its share of the
    // monthly limits don't count against it) and the day it was first filed.
    editingClaimId?: number | null;
    firstFiled?: string | null;
  }
): Promise<{ error: string } | { lines: CheckedLine[]; total: number; categorySummary: string }> {
  const policy = await loadPolicy(queryDB);
  const categories = await categoriesFor(queryDB, args.userId);
  const { userId, today, from, to } = args;
  const win = dateWindow(policy, today, args.firstFiled);
  const fmt = (n: number) => `৳${n.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (!isDate(from) || !isDate(to)) return { error: "From Date and To Date are required." };
  if (to < from) return { error: "To Date can't be before From Date." };
  if (from < win.min) {
    return { error: Number(policy.backdate_days) === 0 ? "Bills can only be claimed for today." : `Bills can only be claimed for the last ${policy.backdate_days} days (from ${win.min}).` };
  }
  if (to > win.max) return { error: "Bills can't be claimed for a future date." };

  if (!Array.isArray(args.lines) || args.lines.length === 0) {
    if (args.extraTotal > 0) return { lines: [], total: args.extraTotal, categorySummary: "" };
    return { error: "Add at least one bill." };
  }
  if (args.lines.length > Number(policy.max_bills_per_claim)) return { error: `A claim can have at most ${policy.max_bills_per_claim} bills.` };

  const lines: CheckedLine[] = [];
  for (let i = 0; i < args.lines.length; i++) {
    const l = args.lines[i] || {};
    const n = i + 1;
    const cat =
      categories.find((c) => c.id === Number(l.category_id)) ||
      (l.category ? categories.find((c) => c.name.toLowerCase() === String(l.category).trim().toLowerCase()) : undefined);
    if (!cat || !cat.is_active) return { error: `Bill ${n}: select a valid category.` };
    const date = String(l.bill_date || "");
    if (!isDate(date)) return { error: `Bill ${n}: select the bill's date.` };
    if (date < from || date > to) return { error: `Bill ${n}: the date must be between ${from} and ${to}.` };
    const amount = Math.round(Number(l.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return { error: `Bill ${n}: enter an amount greater than 0.` };
    if (policy.enforce_category_limits && cat.max_per_bill != null && amount > cat.max_per_bill) {
      return { error: `Bill ${n}: ${cat.name} bills can be at most ${fmt(cat.max_per_bill)} each${cat.limits_for ? ` for ${cat.limits_for}` : ""}.` };
    }
    const desc = typeof l.description === "string" ? l.description.trim().slice(0, 500) || null : null;
    lines.push({ category_id: cat.id, category_name: cat.name, bill_date: date, amount, description: desc });
  }

  const held = await claimedDates(queryDB, userId, today, from, to, policy, args.editingClaimId ?? null);
  // With whole-range holding, this claim's own From–To range may not overlap
  // another claim's either (it would hold those dates too).
  const checkDates = policy.one_claim_per_date && policy.lock_whole_range ? datesBetween(from, to) : lines.map((l) => l.bill_date);
  const closed = [...new Set(checkDates.filter((d) => held.has(d)))];
  if (closed.length) {
    if (policy.one_claim_per_date) {
      const owners = [...new Set(closed.map((d) => held.get(d)))];
      return {
        error: `${closed.join(", ")} ${closed.length === 1 ? "is" : "are"} already covered by your claim${owners.length === 1 ? "" : "s"} ${owners.map((o) => `#${o}`).join(", ")} — one date goes in one claim. Pick other dates, or edit that claim.`
      };
    }
    return {
      error: `${closed.join(", ")} ${closed.length === 1 ? "was" : "were"} already claimed on an earlier day — more bills can't be added for ${closed.length === 1 ? "that date" : "those dates"}.`
    };
  }

  const total = Math.round((lines.reduce((s, l) => s + l.amount, 0) + args.extraTotal) * 100) / 100;
  if (Number(policy.max_claim_total) > 0 && total > Number(policy.max_claim_total)) {
    return { error: `A claim can add up to at most ${fmt(Number(policy.max_claim_total))}.` };
  }
  const needsFile =
    (Number(policy.attachment_required_above) > 0 && total > Number(policy.attachment_required_above)) ||
    (policy.enforce_category_limits && lines.some((l) => categories.find((c) => c.id === l.category_id)?.receipt_required));
  if (needsFile && !args.hasAttachment) return { error: "Attach the receipt — this claim needs one." };

  // Daily / monthly limit per category: this claim plus the user's other
  // claims (not rejected) for bills on the same day / in the same month.
  if (policy.enforce_category_limits) {
    const limited = categories.filter((c) => (c.monthly_limit != null || c.daily_limit != null) && lines.some((l) => l.category_id === c.id));
    if (limited.length) {
      const mine: any[] = (await queryDB("SELECT id, status FROM bill_claims WHERE user_id = ?", [userId])) || [];
      const ids = mine.filter((c) => c.status !== "rejected" && Number(c.id) !== Number(args.editingClaimId)).map((c) => Number(c.id));
      const past: any[] = ids.length
        ? (await queryDB(`SELECT category_id, category_name, bill_date, amount FROM bill_claim_items WHERE bill_claim_id IN (${ids.map(() => "?").join(",")})`, ids)) || []
        : [];
      const forWho = (c: BillCategory) => (c.limits_for ? ` for ${c.limits_for}` : "");
      for (const c of limited.filter((x) => x.daily_limit != null)) {
        const days = new Set(lines.filter((l) => l.category_id === c.id).map((l) => l.bill_date));
        for (const d of days) {
          const used =
            past
              .filter((p) => (Number(p.category_id) === c.id || p.category_name === c.name) && dhakaDate(p.bill_date) === d)
              .reduce((s, p) => s + Number(p.amount), 0) +
            lines.filter((l) => l.category_id === c.id && l.bill_date === d).reduce((s, l) => s + l.amount, 0);
          if (used > (c.daily_limit as number)) {
            return { error: `${c.name}: the limit${forWho(c)} is ${fmt(c.daily_limit as number)} a day — ${d} would come to ${fmt(used)}.` };
          }
        }
      }
      for (const c of limited.filter((x) => x.monthly_limit != null)) {
        const months = new Set(lines.filter((l) => l.category_id === c.id).map((l) => l.bill_date.slice(0, 7)));
        for (const m of months) {
          const used =
            past
              .filter((p) => (Number(p.category_id) === c.id || p.category_name === c.name) && dhakaDate(p.bill_date).slice(0, 7) === m)
              .reduce((s, p) => s + Number(p.amount), 0) +
            lines.filter((l) => l.category_id === c.id && l.bill_date.slice(0, 7) === m).reduce((s, l) => s + l.amount, 0);
          if (used > (c.monthly_limit as number)) {
            return { error: `${c.name}: the monthly limit${forWho(c)} for ${m} is ${fmt(c.monthly_limit as number)} — this claim would make it ${fmt(used)}.` };
          }
        }
      }
    }
  }

  const categorySummary = [...new Set(lines.map((l) => l.category_name))].join(", ").slice(0, 255);
  return { lines, total, categorySummary };
}

/** Adds `items` (bill lines) to each claim row. */
export async function attachClaimItems(queryDB: QueryDB, rows: any[]): Promise<any[]> {
  if (!rows.length) return rows;
  const ids = rows.map((r) => Number(r.id));
  const items: any[] =
    (await queryDB(`SELECT * FROM bill_claim_items WHERE bill_claim_id IN (${ids.map(() => "?").join(",")}) ORDER BY bill_date, id`, ids)) || [];
  const by: Record<number, any[]> = {};
  for (const i of items) {
    (by[Number(i.bill_claim_id)] ||= []).push({
      id: Number(i.id),
      category_id: i.category_id != null ? Number(i.category_id) : null,
      category_name: i.category_name,
      bill_date: dhakaDate(i.bill_date),
      amount: Number(i.amount),
      description: i.description ?? null
    });
  }
  return rows.map((r) => ({ ...r, items: by[Number(r.id)] || [] }));
}

// ---- routes ----

// ---- the rules people read before claiming (Bill Claim → (i) Rules) ----

/** A fingerprint of everything the rules sheet says: the policy and every active category. */
async function rulesHash(queryDB: QueryDB): Promise<string> {
  const policy = await loadPolicy(queryDB);
  const cats = (await loadCategories(queryDB))
    .filter((c) => c.is_active)
    .map((c) => [c.name, c.max_per_bill, c.daily_limit, c.monthly_limit, c.receipt_required, c.designation_limits]);
  return createHash("sha256").update(JSON.stringify({ policy, cats })).digest("hex");
}

export interface RulesVersion {
  id: number;
  no: number;
  at: string | null;
  changed_by: string | null;
  summary: string | null;
}

/** The current rules version — a new one is opened the first time the rules are seen changed. */
export async function currentRulesVersion(queryDB: QueryDB): Promise<RulesVersion> {
  const company = activeCompanyId();
  const hash = await rulesHash(queryDB);
  const last: any = ((await queryDB("SELECT * FROM bill_claim_rule_versions WHERE company_ref = ? ORDER BY id DESC LIMIT 1", [company])) || [])[0];
  if (!last || last.rules_hash !== hash) {
    // Who changed it: the latest Change History entry, if there is one.
    const h: any = last ? ((await queryDB("SELECT actor_name, target_name FROM bill_claim_policy_history WHERE company_ref = ? AND action <> 'denied' ORDER BY id DESC LIMIT 1", [company]).catch(() => [])) || [])[0] : null;
    await queryDB("INSERT INTO bill_claim_rule_versions (company_ref, rules_hash, changed_by, summary, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())", [
      company,
      hash,
      h?.actor_name || null,
      h?.target_name ? String(h.target_name).slice(0, 255) : last ? "Rules changed" : "First version"
    ]);
  }
  const rows: any[] = (await queryDB("SELECT * FROM bill_claim_rule_versions WHERE company_ref = ? ORDER BY id ASC", [company])) || [];
  const cur = rows[rows.length - 1];
  return { id: Number(cur.id), no: rows.length, at: cur.created_at ? new Date(cur.created_at + (String(cur.created_at).endsWith("Z") ? "" : "Z")).toISOString() : null, changed_by: cur.changed_by || null, summary: cur.summary || null };
}

/** Has this person confirmed the current rules? (Their own claims need it.) */
export async function hasReadCurrentRules(queryDB: QueryDB, userId: number): Promise<boolean> {
  const v = await currentRulesVersion(queryDB);
  const row = ((await queryDB("SELECT id FROM bill_claim_rule_reads WHERE company_ref = ? AND user_id = ? AND version_id = ? AND action = 'confirm' LIMIT 1", [activeCompanyId(), userId, v.id])) || [])[0];
  return !!row;
}

export function registerBillClaimPolicyRoutes(
  app: Express,
  deps: {
    authenticateToken: any;
    requireBillClaimAccess: any;
    queryDB: QueryDB;
    getAdminModules: (userId: number) => Promise<string[]>;
    hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
    todayInDhaka: () => string;
  }
) {
  const { authenticateToken, requireBillClaimAccess, queryDB, getAdminModules, hasModuleLayer, todayInDhaka } = deps;

  // Viewing: Superadmin and the Bill Claim (conveyance) module. Changing: Superadmin.
  const canView = async (req: any) => req.user?.role === "superadmin" || (await getAdminModules(req.user.id)).includes("bill_claim");
  const requireView = async (req: any, res: any, next: any) => {
    try {
      if (await canView(req)) return next();
      res.status(403).json({ error: "You don't have access to Bill Claim Policy." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
  // Who has read the rules (its own page): the page's viewers who also have
  // the Bill Claim layer "rules_readers" (on unless layers were saved without it).
  const canSeeReaders = async (req: any) => req.user?.role === "superadmin" || ((await canView(req)) && (await hasModuleLayer(req.user, "bill_claim", "rules_readers")));
  const requireReaders = async (req: any, res: any, next: any) => {
    try {
      if (await canSeeReaders(req)) return next();
      res.status(403).json({ error: "You don't have access to who has read the Bill Claim rules." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
  // Refused attempts are recorded too.
  const requireSuper = (req: any, res: any, next: any) => {
    if (req.user?.role === "superadmin") return next();
    recordHistory(queryDB, actorFrom(req), {
      action: "denied",
      targetType: "policy",
      targetName: `${req.method} ${req.originalUrl || req.url}`.slice(0, 150),
      after: req.body && Object.keys(req.body).length ? req.body : undefined
    }).finally(() => res.status(403).json({ error: "Only the Superadmin can change the Bill Claim Policy." }));
  };

  app.get("/api/bill-claim-policy", authenticateToken, requireView, async (req: any, res) => {
    try {
      res.json({
        defs: POLICY_DEFS,
        values: await loadPolicy(queryDB),
        categories: await loadCategories(queryDB),
        can_edit: req.user.role === "superadmin",
        can_see_readers: await canSeeReaders(req)
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/bill-claim-policy", authenticateToken, requireSuper, async (req: any, res) => {
    try {
      const incoming = req.body?.values || {};
      const before = await loadPolicy(queryDB);
      const changed: Record<string, { from: PolicyValue; to: PolicyValue }> = {};
      for (const def of POLICY_DEFS) {
        if (!(def.key in incoming)) continue;
        const v = parseValue(def, incoming[def.key]);
        if (v === before[def.key]) continue;
        changed[def.key] = { from: before[def.key], to: v };
        await queryDB(
          `INSERT INTO bill_claim_policy_settings (policy_key, policy_value, updated_by) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE policy_value = VALUES(policy_value), updated_by = VALUES(updated_by)`,
          [def.key, String(v === true ? 1 : v === false ? 0 : v), req.user.id]
        );
      }
      const keys = Object.keys(changed);
      if (keys.length) {
        await recordHistory(queryDB, actorFrom(req), {
          action: "rules_changed",
          targetType: "rule",
          targetName: keys.map((k) => POLICY_DEFS.find((d) => d.key === k)?.label || k).join("; "),
          before: Object.fromEntries(keys.map((k) => [k, changed[k].from])),
          after: Object.fromEntries(keys.map((k) => [k, changed[k].to]))
        });
      }
      res.json({ success: true, values: await loadPolicy(queryDB) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Category fields shared by create and edit.
  const readCategory = (b: any): { error: string } | { v: any[] } => {
    const name = String(b?.name || "").trim().slice(0, 100);
    if (!name) return { error: "Enter the category name." };
    const money = (x: any) => (x === "" || x == null ? null : Number(x));
    const maxPer = money(b.max_per_bill);
    const daily = money(b.daily_limit);
    const monthly = money(b.monthly_limit);
    const bad = (x: number | null) => x != null && !(x > 0);
    if (bad(maxPer) || bad(daily) || bad(monthly)) return { error: "Limits must be more than 0, or left blank." };
    const byDesignation = parseDesignationLimits(b.designation_limits);
    const seen = new Set<string>();
    for (const d of byDesignation) {
      const k = d.designation_id != null ? `#${d.designation_id}` : d.designation.toLowerCase();
      if (seen.has(k)) return { error: `${d.designation} is listed twice — keep one row per designation.` };
      seen.add(k);
      if (bad(d.max_per_bill) || bad(d.daily_limit) || bad(d.monthly_limit)) return { error: `${d.designation}: limits must be more than 0, or left blank.` };
      if (d.max_per_bill == null && d.daily_limit == null && d.monthly_limit == null) return { error: `${d.designation}: give at least one limit, or remove the row.` };
    }
    return {
      v: [
        name,
        b.description ? String(b.description).trim().slice(0, 255) : null,
        b.is_active === false || b.is_active === 0 ? 0 : 1,
        Number(b.sort_order) || 0,
        maxPer,
        monthly,
        b.receipt_required ? 1 : 0,
        daily,
        byDesignation.length ? JSON.stringify(byDesignation) : null
      ]
    };
  };
  const nameTaken = async (name: string, exceptId?: number) =>
    (await loadCategories(queryDB)).some((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== exceptId);

  app.post("/api/bill-claim-categories", authenticateToken, requireSuper, async (req: any, res) => {
    try {
      const r = readCategory(req.body);
      if ("error" in r) return res.status(400).json(r);
      if (await nameTaken(r.v[0])) return res.status(409).json({ error: "A category with this name already exists." });
      // New categories go to the end of the list unless an order is given.
      if (req.body?.sort_order === undefined || req.body?.sort_order === "") {
        r.v[3] = (await loadCategories(queryDB)).reduce((m, c) => Math.max(m, c.sort_order), 0) + 1;
      }
      const result = await queryDB(
        "INSERT INTO bill_claim_categories (name, description, is_active, sort_order, max_per_bill, monthly_limit, receipt_required, daily_limit, designation_limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        r.v
      );
      const created = (await loadCategories(queryDB)).find((c) => c.id === Number(result.insertId));
      await recordHistory(queryDB, actorFrom(req), {
        action: "category_added",
        targetType: "category",
        targetId: Number(result.insertId),
        targetName: r.v[0],
        after: created
      });
      res.status(201).json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Renaming changes only future claims — past bill lines keep the name they were filed under.
  app.put("/api/bill-claim-categories/:id", authenticateToken, requireSuper, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const r = readCategory(req.body);
      if ("error" in r) return res.status(400).json(r);
      const current = (await loadCategories(queryDB)).find((c) => c.id === id);
      if (!current) return res.status(404).json({ error: "Category not found." });
      if (req.body?.sort_order === undefined) r.v[3] = current.sort_order;
      if (await nameTaken(r.v[0], id)) return res.status(409).json({ error: "A category with this name already exists." });
      await queryDB(
        "UPDATE bill_claim_categories SET name = ?, description = ?, is_active = ?, sort_order = ?, max_per_bill = ?, monthly_limit = ?, receipt_required = ?, daily_limit = ?, designation_limits = ? WHERE id = ?",
        [...r.v, id]
      );
      const updated = (await loadCategories(queryDB)).find((c) => c.id === id);
      await recordHistory(queryDB, actorFrom(req), {
        action: "category_changed",
        targetType: "category",
        targetId: id,
        targetName: current.name === r.v[0] ? current.name : `${current.name} → ${r.v[0]}`,
        before: current,
        after: updated
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deleting hides the category from new claims; claims already filed keep it.
  app.delete("/api/bill-claim-categories/:id", authenticateToken, requireSuper, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const all = await loadCategories(queryDB);
      const current = all.find((c) => c.id === id);
      if (!current) return res.status(404).json({ error: "Category not found." });
      const active = all.filter((c) => c.is_active);
      if (active.length === 1 && active[0].id === id) return res.status(400).json({ error: "Keep at least one active category." });
      await queryDB("UPDATE bill_claim_categories SET deleted_at = NOW(), is_active = 0 WHERE id = ?", [id]);
      await recordHistory(queryDB, actorFrom(req), {
        action: "category_deleted",
        targetType: "category",
        targetId: id,
        targetName: current.name,
        before: current
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // History — read only. There is no route that changes or deletes it.
  app.get("/api/bill-claim-policy/history", authenticateToken, requireView, async (req: any, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const beforeId = Number(req.query.before_id) || null;
      const rows: any[] =
        (await queryDB(
          `SELECT id, actor_id, actor_name, actor_role, action, target_type, target_id, target_name, before_json, after_json, ip, created_at, row_hash
             FROM bill_claim_policy_history WHERE company_ref = ?${beforeId ? " AND id < ?" : ""} ORDER BY id DESC LIMIT ${limit + 1}`,
          beforeId ? [activeCompanyId(), beforeId] : [activeCompanyId()]
        )) || [];
      const parse = (v: any) => {
        try {
          return v == null ? null : JSON.parse(v);
        } catch {
          return v;
        }
      };
      res.json({
        rows: rows.slice(0, limit).map((r) => ({
          id: Number(r.id),
          actor_id: r.actor_id != null ? Number(r.actor_id) : null,
          actor_name: r.actor_name,
          actor_role: r.actor_role,
          action: r.action,
          target_type: r.target_type,
          target_id: r.target_id != null ? Number(r.target_id) : null,
          target_name: r.target_name,
          before: parse(r.before_json),
          after: parse(r.after_json),
          ip: r.ip,
          created_at: r.created_at,
          hash: String(r.row_hash).slice(0, 12)
        })),
        has_more: rows.length > limit
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/bill-claim-policy/history/verify", authenticateToken, requireView, async (_req: any, res) => {
    try {
      res.json({ ...(await verifyHistory(queryDB)), db_guard: await historyGuardActive(queryDB) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Category names for anyone signed in (Admin claim screens use them).
  app.get("/api/bill-claim-categories", authenticateToken, async (_req: any, res) => {
    try {
      res.json(await loadCategories(queryDB));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- (i) Rules: read before the first claim, and again after a change ----
  const utc = (v: any) => (v ? new Date(String(v).replace(" ", "T") + (String(v).endsWith("Z") ? "" : "Z")).toISOString() : null);
  const myReading = async (userId: number) => {
    const version = await currentRulesVersion(queryDB);
    const rows: any[] =
      (await queryDB("SELECT version_id, created_at FROM bill_claim_rule_reads WHERE company_ref = ? AND user_id = ? AND action = 'confirm' ORDER BY id DESC", [activeCompanyId(), userId])) || [];
    const current = rows.find((r) => Number(r.version_id) === version.id);
    return { version, confirmed_at: current ? utc(current.created_at) : null, confirmed_older: !current && rows.length > 0, last_confirmed_at: rows[0] ? utc(rows[0].created_at) : null };
  };
  app.get("/api/bill-claim-rules/mine", authenticateToken, requireBillClaimAccess, async (req: any, res) => {
    try {
      res.json(await myReading(Number(req.user.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // { action: 'open' | 'confirm', device } — a confirm counts for the current rules only.
  app.post("/api/bill-claim-rules/read", authenticateToken, requireBillClaimAccess, async (req: any, res) => {
    try {
      const action = req.body?.action === "confirm" ? "confirm" : "open";
      const version = await currentRulesVersion(queryDB);
      if (action === "confirm" && Number(req.body?.version_id) && Number(req.body.version_id) !== version.id) {
        return res.status(409).json({ error: "The rules changed while you were reading — read the new ones and confirm again." });
      }
      const device = String(req.body?.device || "").trim().slice(0, 60) || null;
      // One "open" a person a version is enough; every confirm is kept.
      const already =
        action === "open"
          ? ((await queryDB("SELECT id FROM bill_claim_rule_reads WHERE company_ref = ? AND user_id = ? AND version_id = ? AND action = 'open' AND created_at > UTC_TIMESTAMP() - INTERVAL 30 MINUTE LIMIT 1", [activeCompanyId(), req.user.id, version.id])) || [])[0]
          : null;
      if (!already) {
        await queryDB("INSERT INTO bill_claim_rule_reads (company_ref, user_id, version_id, action, device, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())", [
          activeCompanyId(),
          req.user.id,
          version.id,
          action,
          device,
          actorFrom(req).ip
        ]);
      }
      res.json(await myReading(Number(req.user.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // Bill Claim Policy → Who has read the rules: everyone who can file a Bill
  // Claim (the Bill Claim switch, the Bill Claim module, or Superadmin), and the log.
  const claimers = async () => {
    const users: any[] = (await queryDB("SELECT id, name, role, can_view_bill_claims FROM users WHERE COALESCE(is_onboarding, 0) = 0", []).catch(() => queryDB("SELECT id, name, role, can_view_bill_claims FROM users", []))) || [];
    const mod: any[] = (await queryDB("SELECT DISTINCT user_id FROM admin_module_permissions WHERE module_key = 'bill_claim' AND company_id = ?", [activeCompanyId()]).catch(() => [])) || [];
    const withModule = new Set(mod.map((m) => Number(m.user_id)));
    return users.filter((u) => u.role === "superadmin" || !!Number(u.can_view_bill_claims) || withModule.has(Number(u.id)));
  };
  app.get("/api/bill-claim-rules/readers", authenticateToken, requireReaders, async (_req: any, res) => {
    try {
      const version = await currentRulesVersion(queryDB);
      const versions: any[] = (await queryDB("SELECT id FROM bill_claim_rule_versions WHERE company_ref = ? ORDER BY id ASC", [activeCompanyId()])) || [];
      const noOf = new Map<number, number>(versions.map((v, i) => [Number(v.id), i + 1]));
      const people = await claimers();
      const reads: any[] = (await queryDB("SELECT * FROM bill_claim_rule_reads WHERE company_ref = ? ORDER BY id ASC", [activeCompanyId()])) || [];
      const emps: any[] = (await queryDB("SELECT user_id, employee_id, designation, department FROM all_employees WHERE user_id IS NOT NULL ORDER BY is_active ASC", []).catch(() => [])) || [];
      const empOf = new Map<number, any>(emps.map((e) => [Number(e.user_id), e]));
      const names = new Map<number, string>(((await queryDB("SELECT id, name FROM users", [])) || []).map((u: any) => [Number(u.id), u.name]));
      const rows = people.map((u: any) => {
        const mine = reads.filter((r) => Number(r.user_id) === Number(u.id));
        const confirms = mine.filter((r) => r.action === "confirm");
        const cur = confirms.filter((r) => Number(r.version_id) === version.id).pop();
        const last = confirms[confirms.length - 1];
        const openedNow = mine.some((r) => Number(r.version_id) === version.id);
        const e = empOf.get(Number(u.id));
        return {
          user_id: Number(u.id),
          name: u.name,
          employee_code: e?.employee_id || null,
          designation: e?.designation || null,
          department: e?.department || null,
          status: cur ? "read" : last ? "old" : openedNow || mine.length ? "opened" : "never",
          confirmed_at: utc((cur || last)?.created_at),
          confirmed_version: (cur || last) ? noOf.get(Number((cur || last).version_id)) || null : null,
          device: (cur || last || mine[mine.length - 1])?.device || null,
          opens: mine.filter((r) => r.action === "open").length
        };
      });
      const log = reads
        .slice(-200)
        .reverse()
        .map((r) => ({ at: utc(r.created_at), name: names.get(Number(r.user_id)) || "Unknown", action: r.action, version: noOf.get(Number(r.version_id)) || null, device: r.device || null }));
      const changes = (await queryDB("SELECT id, changed_by, summary, created_at FROM bill_claim_rule_versions WHERE company_ref = ? ORDER BY id DESC LIMIT 20", [activeCompanyId()])) || [];
      res.json({
        version,
        people: rows,
        log,
        changes: changes.map((c: any) => ({ no: noOf.get(Number(c.id)) || null, at: utc(c.created_at), by: c.changed_by || null, summary: c.summary || null }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // A push to everyone who hasn't confirmed the current rules.
  app.post("/api/bill-claim-rules/remind", authenticateToken, requireReaders, async (req: any, res) => {
    try {
      const version = await currentRulesVersion(queryDB);
      const done = new Set<number>(
        ((await queryDB("SELECT DISTINCT user_id FROM bill_claim_rule_reads WHERE company_ref = ? AND version_id = ? AND action = 'confirm'", [activeCompanyId(), version.id])) || []).map((r: any) => Number(r.user_id))
      );
      const to = (await claimers()).map((u: any) => Number(u.id)).filter((id: number) => !done.has(id) && id !== Number(req.user.id));
      if (to.length) {
        await sendPushToUserIds(queryDB, to, "Bill Claim rules", "Read the Bill Claim rules and confirm before your next claim — tap (i) Rules on Bill Claim.", { type: "bill_claim_rules" }, Number(req.user.id));
      }
      res.json({ success: true, sent: to.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // What the "New Bill Claim" form needs: rules, active categories,
  // allowed date window and the dates already closed for this user.
  app.get("/api/bill-claim-policy/mine", authenticateToken, requireBillClaimAccess, async (req: any, res) => {
    try {
      const policy = await loadPolicy(queryDB);
      const today = todayInDhaka();
      // ?claim_id=: the employee's own claim being edited — its dates aren't
      // closed to it, and its window counts from the day it was first filed.
      let editing: any = null;
      if (req.query.claim_id) {
        const rows: any[] = (await queryDB("SELECT id, user_id, first_submitted_at, created_at FROM bill_claims WHERE id = ?", [Number(req.query.claim_id)])) || [];
        if (rows.length && Number(rows[0].user_id) === Number(req.user.id)) editing = rows[0];
      }
      const firstFiled = editing ? dhakaDate(editing.first_submitted_at || editing.created_at) : null;
      const win = dateWindow(policy, today, firstFiled);
      res.json({
        today,
        min_date: win.min,
        max_date: win.max,
        values: policy,
        // With this employee's designation limits in place of the category's.
        categories: (await categoriesFor(queryDB, req.user.id)).filter((c) => c.is_active),
        locked_dates: await lockedDates(queryDB, req.user.id, today, win.min, win.max, policy, editing ? Number(editing.id) : null),
        // "One new claim per day": the claim already filed today, if any.
        today_claim_id: policy.one_claim_per_day && !editing ? await claimFiledOn(queryDB, req.user.id, today) : null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
