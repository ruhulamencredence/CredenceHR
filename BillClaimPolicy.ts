/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Bill Claim Policy (Admin Panel -> HRM -> Claims/Bill/Disbursement -> Bill
// Claim Policy) — the rules a Conveyance Bill Claim is checked against, and the
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
//   user_claim_items   the bill lines of a claim — one per category/date/amount.
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

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export type PolicyValue = number | boolean;

export interface PolicyDef {
  key: string;
  group: "dates" | "amounts" | "claim";
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
    help: "On: if a claim was rejected, its dates can be claimed again.",
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
  await queryDB(`CREATE TABLE IF NOT EXISTS user_claim_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_claim_id INT NOT NULL,
    category_id INT NULL,
    category_name VARCHAR(100) NOT NULL,
    bill_date DATE NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    description VARCHAR(500) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_uci_claim (user_claim_id),
    KEY idx_uci_date (bill_date),
    FOREIGN KEY (user_claim_id) REFERENCES user_claims(id) ON DELETE CASCADE
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
  // Categories come from bill_claim_categories now, so the claim's own
  // category column holds any name (or "Fuel, Toll" for a multi-category claim).
  const cols: any[] = (await queryDB("SHOW COLUMNS FROM user_claims LIKE 'category'")) || [];
  if (cols[0] && /^enum/i.test(String(cols[0].Type))) {
    await queryDB("ALTER TABLE user_claims MODIFY COLUMN category VARCHAR(255) NOT NULL DEFAULT 'Others'");
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
  monthly_limit: number | null;
  receipt_required: boolean;
}

function toCategory(r: any): BillCategory {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description ?? null,
    is_active: !!Number(r.is_active),
    sort_order: Number(r.sort_order) || 0,
    max_per_bill: r.max_per_bill != null ? Number(r.max_per_bill) : null,
    monthly_limit: r.monthly_limit != null ? Number(r.monthly_limit) : null,
    receipt_required: !!Number(r.receipt_required)
  };
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
 * Dates (within [from, to]) this user can no longer add bills for: they already
 * have a bill on that date, filed on an earlier day than today.
 */
export async function lockedDates(queryDB: QueryDB, userId: number, today: string, from: string, to: string, policy: PolicyValues): Promise<string[]> {
  if (!policy.lock_dates_after_day) return [];
  const claims: any[] =
    (await queryDB("SELECT id, status, created_at, from_date, to_date FROM user_claims WHERE user_id = ?", [userId])) || [];
  const earlier = claims.filter(
    (c) => dhakaDate(c.created_at) < today && !(policy.rejected_dates_reopen && c.status === "rejected")
  );
  if (earlier.length === 0) return [];
  const ids = earlier.map((c) => Number(c.id));
  const items: any[] =
    (await queryDB(`SELECT user_claim_id, bill_date FROM user_claim_items WHERE user_claim_id IN (${ids.map(() => "?").join(",")})`, ids)) || [];
  const withItems = new Set(items.map((i) => Number(i.user_claim_id)));
  const locked = new Set<string>();
  for (const i of items) locked.add(dhakaDate(i.bill_date));
  // Claims filed before bill lines existed: their whole From–To range counts.
  for (const c of earlier) {
    if (withItems.has(Number(c.id))) continue;
    const f = dhakaDate(c.from_date);
    const t = dhakaDate(c.to_date) || f;
    if (!f || t < from || f > to) continue;
    for (const d of datesBetween(f < from ? from : f, t > to ? to : t)) locked.add(d);
  }
  return [...locked].filter((d) => d >= from && d <= to).sort();
}

/** The date window the policy allows today. */
export function dateWindow(policy: PolicyValues, today: string) {
  const back = Number(policy.backdate_days) || 0;
  return { min: addDays(today, -back), max: policy.allow_future_dates ? addDays(today, 365) : today };
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
  args: { userId: number; today: string; from: string; to: string; lines: BillLineInput[]; extraTotal: number; hasAttachment: boolean }
): Promise<{ error: string } | { lines: CheckedLine[]; total: number; categorySummary: string }> {
  const policy = await loadPolicy(queryDB);
  const categories = await loadCategories(queryDB);
  const { userId, today, from, to } = args;
  const win = dateWindow(policy, today);
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
      return { error: `Bill ${n}: ${cat.name} bills can be at most ${fmt(cat.max_per_bill)} each.` };
    }
    const desc = typeof l.description === "string" ? l.description.trim().slice(0, 500) || null : null;
    lines.push({ category_id: cat.id, category_name: cat.name, bill_date: date, amount, description: desc });
  }

  const locked = new Set(await lockedDates(queryDB, userId, today, from, to, policy));
  const closed = [...new Set(lines.map((l) => l.bill_date).filter((d) => locked.has(d)))];
  if (closed.length) {
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

  // Monthly limit per category: this claim plus the user's other claims (not
  // rejected) for bills in the same calendar month.
  if (policy.enforce_category_limits) {
    const limited = categories.filter((c) => c.monthly_limit != null && lines.some((l) => l.category_id === c.id));
    if (limited.length) {
      const mine: any[] = (await queryDB("SELECT id, status FROM user_claims WHERE user_id = ?", [userId])) || [];
      const ids = mine.filter((c) => c.status !== "rejected").map((c) => Number(c.id));
      const past: any[] = ids.length
        ? (await queryDB(`SELECT category_id, category_name, bill_date, amount FROM user_claim_items WHERE user_claim_id IN (${ids.map(() => "?").join(",")})`, ids)) || []
        : [];
      for (const c of limited) {
        const months = new Set(lines.filter((l) => l.category_id === c.id).map((l) => l.bill_date.slice(0, 7)));
        for (const m of months) {
          const used =
            past
              .filter((p) => (Number(p.category_id) === c.id || p.category_name === c.name) && dhakaDate(p.bill_date).slice(0, 7) === m)
              .reduce((s, p) => s + Number(p.amount), 0) +
            lines.filter((l) => l.category_id === c.id && l.bill_date.slice(0, 7) === m).reduce((s, l) => s + l.amount, 0);
          if (used > (c.monthly_limit as number)) {
            return { error: `${c.name}: the monthly limit for ${m} is ${fmt(c.monthly_limit as number)} — this claim would make it ${fmt(used)}.` };
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
    (await queryDB(`SELECT * FROM user_claim_items WHERE user_claim_id IN (${ids.map(() => "?").join(",")}) ORDER BY bill_date, id`, ids)) || [];
  const by: Record<number, any[]> = {};
  for (const i of items) {
    (by[Number(i.user_claim_id)] ||= []).push({
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

export function registerBillClaimPolicyRoutes(
  app: Express,
  deps: {
    authenticateToken: any;
    requireConveyanceClaimAccess: any;
    queryDB: QueryDB;
    getAdminModules: (userId: number) => Promise<string[]>;
    todayInDhaka: () => string;
  }
) {
  const { authenticateToken, requireConveyanceClaimAccess, queryDB, getAdminModules, todayInDhaka } = deps;

  // Viewing: Superadmin and the Bill Claim (conveyance) module. Changing: Superadmin.
  const canView = async (req: any) => req.user?.role === "superadmin" || (await getAdminModules(req.user.id)).includes("conveyance");
  const requireView = async (req: any, res: any, next: any) => {
    try {
      if (await canView(req)) return next();
      res.status(403).json({ error: "You don't have access to Bill Claim Policy." });
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
        can_edit: req.user.role === "superadmin"
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
    const monthly = money(b.monthly_limit);
    if ((maxPer != null && !(maxPer > 0)) || (monthly != null && !(monthly > 0))) return { error: "Limits must be more than 0, or left blank." };
    return {
      v: [
        name,
        b.description ? String(b.description).trim().slice(0, 255) : null,
        b.is_active === false || b.is_active === 0 ? 0 : 1,
        Number(b.sort_order) || 0,
        maxPer,
        monthly,
        b.receipt_required ? 1 : 0
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
        "INSERT INTO bill_claim_categories (name, description, is_active, sort_order, max_per_bill, monthly_limit, receipt_required) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
        "UPDATE bill_claim_categories SET name = ?, description = ?, is_active = ?, sort_order = ?, max_per_bill = ?, monthly_limit = ?, receipt_required = ? WHERE id = ?",
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

  // What the "New Conveyance Claim" form needs: rules, active categories,
  // allowed date window and the dates already closed for this user.
  app.get("/api/bill-claim-policy/mine", authenticateToken, requireConveyanceClaimAccess, async (req: any, res) => {
    try {
      const policy = await loadPolicy(queryDB);
      const today = todayInDhaka();
      const win = dateWindow(policy, today);
      res.json({
        today,
        min_date: win.min,
        max_date: win.max,
        values: policy,
        categories: (await loadCategories(queryDB)).filter((c) => c.is_active),
        locked_dates: await lockedDates(queryDB, req.user.id, today, win.min, win.max, policy)
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
