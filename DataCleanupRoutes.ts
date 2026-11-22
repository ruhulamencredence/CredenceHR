// System Data Cleanup — only the system owner (users.is_platform_admin = 1,
// the /system login) can remove Leave applications, Bill Claims, Check In/Out
// (movement claims), Remote Attendance and Employee change-history lines,
// one by one or in bulk, instead of deleting them on the server by hand.
//
// Every removal needs a reason and the typed "DELETE <n>", is logged as a
// batch, and the removed rows (with everything that hung off them) are kept
// for 30 days so the batch can be put back. Records that money already went
// out on are locked: a day / leave in a month whose salary is Processed or
// Paid, and anything on a Disbursed Bill.
//
// Lists go through queryDB, so they only ever show the active company's
// records (companyScope). The removal itself runs in one transaction per
// record on the ids that list just confirmed.
import type { Express, Request, Response } from "express";
import { companyStore } from "./companyContext";
import { loadBranchIndex, placeOf, norm } from "./EmployeeFilters";

type Query = (sql: string, params?: any[]) => Promise<any>;
type WithTransaction = (fn: (q: Query) => Promise<void>) => Promise<void>;

interface Deps {
  authenticateToken: any;
  queryDB: Query;
  withTransaction?: WithTransaction;
  adjustLeaveTypeBalance: (
    userId: number,
    leaveType: string,
    delta: number
  ) => Promise<void>;
  closedPayMonthFor: (
    userId: number,
    dateStr: string
  ) => Promise<string | null>;
}

export const CLEANUP_KINDS = [
  "leave",
  "bill",
  "claim",
  "attendance",
  "history",
] as const;
type Kind = (typeof CLEANUP_KINDS)[number];
const KIND_LABEL: Record<Kind, string> = {
  leave: "Leave applications",
  bill: "Bill Claims",
  claim: "Check In/Out",
  attendance: "Remote Attendance",
  history: "Employee change history",
};
const MAX_MATCH = 5000;
const KEEP_DAYS = 30;

// One snapshot of what a record's removal took away, enough to put it back.
interface Snapshot {
  tables: { table: string; rows: any[]; ignore?: boolean }[];
  updates?: { table: string; id: number; set: Record<string, any> }[];
  leave?: { user_id: number; leave_type: string; days: number };
}

const enc = (v: any): any => {
  if (Buffer.isBuffer(v)) return { $b: v.toString("base64") };
  if (v instanceof Date) return { $d: v.toISOString() };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
};
const dec = (v: any): any => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (typeof v.$b === "string" && Object.keys(v).length === 1)
      return Buffer.from(v.$b, "base64");
    if (typeof v.$d === "string" && Object.keys(v).length === 1)
      return new Date(v.$d);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
  }
  if (Array.isArray(v)) return v.map(dec);
  return v;
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ins = async (q: Query, table: string, row: any, ignore = false) => {
  const cols = Object.keys(row).filter((c) => IDENT.test(c));
  if (!IDENT.test(table) || !cols.length) return;
  await q(
    `INSERT ${ignore ? "IGNORE " : ""}INTO ${table} (${cols.join(
      ", "
    )}) VALUES (${cols.map(() => "?").join(", ")})`,
    cols.map((c) => row[c])
  );
};
const inList = (ids: number[]) =>
  ids.length ? ids.map(() => "?").join(",") : "NULL";
const day = (v: any) => String(v ?? "").slice(0, 10);
const bad = (msg: string, code = 400) =>
  Object.assign(new Error(msg), { statusCode: code });

export function registerDataCleanupRoutes(app: Express, deps: Deps) {
  const {
    authenticateToken,
    queryDB,
    withTransaction,
    adjustLeaveTypeBalance,
    closedPayMonthFor,
  } = deps;

  let schemaReady: Promise<void> | null = null;
  const ensureSchema = () =>
    (schemaReady ||= (async () => {
      await queryDB(`CREATE TABLE IF NOT EXISTS data_cleanup_batches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        company_id INT NULL,
        kind VARCHAR(20) NOT NULL,
        mode VARCHAR(20) NULL,
        count INT NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        filters_json TEXT NULL,
        actor_id INT NOT NULL,
        actor_name VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        restored_at DATETIME NULL,
        restored_by INT NULL,
        restored_count INT NULL,
        INDEX idx_dcb_company (company_id, created_at)
      )`);
      await queryDB(`CREATE TABLE IF NOT EXISTS data_cleanup_trash (
        id INT AUTO_INCREMENT PRIMARY KEY,
        batch_id INT NOT NULL,
        kind VARCHAR(20) NOT NULL,
        record_id VARCHAR(40) NOT NULL,
        label VARCHAR(500) NULL,
        rows_json LONGTEXT NOT NULL,
        restored TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_dct_batch (batch_id)
      )`);
    })().catch((e) => {
      schemaReady = null;
      throw e;
    }));
  const purgeOld = () =>
    queryDB(
      `DELETE FROM data_cleanup_trash WHERE created_at < (NOW() - INTERVAL ${KEEP_DAYS} DAY)`
    ).catch(() => {});

  // Only the system owner — never a company Superadmin, never a module key.
  const requireOwner = async (req: any, res: Response, next: any) => {
    try {
      const rows: any[] =
        (await queryDB(
          "SELECT id, name, is_platform_admin FROM users WHERE id = ?",
          [req.user?.id]
        )) || [];
      const me = rows.find((u) => Number(u.id) === Number(req.user?.id));
      if (!me || Number(me.is_platform_admin || 0) !== 1)
        return res
          .status(403)
          .json({ error: "Only the system owner can use Data cleanup." });
      req.cleanupActor = me;
      await ensureSchema();
      next();
    } catch (e: any) {
      res
        .status(500)
        .json({ error: e.message || "Data cleanup is not available." });
    }
  };
  const fail = (res: Response, e: any) =>
    res
      .status(e.statusCode || 500)
      .json({ error: e.message || "Something went wrong." });
  const kindOf = (v: any): Kind => {
    if (!CLEANUP_KINDS.includes(v)) throw bad("Unknown kind.");
    return v as Kind;
  };

  // ---------- people ----------
  const loadPeople = async () => {
    const emps: any[] =
      (await queryDB(
        "SELECT id, user_id, name, employee_id, designation, department, branch, branch_id, division FROM all_employees ORDER BY name"
      )) || [];
    const idx = await loadBranchIndex(queryDB);
    const byUser = new Map<number, any>();
    const byId = new Map<number, any>();
    for (const e of emps) {
      const p = { ...e, place: placeOf(e, idx).kind };
      byId.set(Number(e.id), p);
      if (e.user_id && !byUser.has(Number(e.user_id)))
        byUser.set(Number(e.user_id), p);
    }
    return { emps: [...byId.values()], byUser, byId };
  };
  const personOf = (p: any) =>
    p
      ? {
          name: p.name,
          code: p.employee_id,
          designation: p.designation,
          department: p.department,
          place: p.place,
        }
      : null;

  // ---------- pay-month lock ----------
  const payLock = async () => {
    const closedUsers = new Set<number>();
    const rows: any[] =
      (await queryDB(
        "SELECT DISTINCT e.user_id FROM payrolls p JOIN all_employees e ON e.id = p.employee_id WHERE p.payment_status IN ('processed','paid') AND e.user_id IS NOT NULL"
      ).catch(() => [])) || [];
    for (const r of rows) closedUsers.add(Number(r.user_id));
    const memo = new Map<string, Promise<string | null>>();
    return (userId: number, d: string): Promise<string | null> => {
      if (!closedUsers.has(Number(userId)) || !/^\d{4}-\d{2}-\d{2}$/.test(d))
        return Promise.resolve(null);
      const k = `${userId}|${d}`;
      if (!memo.has(k))
        memo.set(
          k,
          closedPayMonthFor(Number(userId), d).catch(() => null)
        );
      return memo.get(k)!;
    };
  };
  const monthName = (m: string) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(Date.UTC(y, (mo || 1) - 1, 1)).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  };
  const paidMsg = (m: string) =>
    `Locked — ${monthName(m)} salary is already processed / paid`;

  // ---------- list ----------
  interface Row {
    id: string;
    user_id: number | null;
    emp: any;
    date: string;
    status: string;
    effect: string;
    locked: string | null;
    [k: string]: any;
  }

  async function listKind(kind: Kind, f: any): Promise<Row[]> {
    const { byUser, byId } = await loadPeople();
    const lockFor = await payLock();
    const where: string[] = [];
    const params: any[] = [];
    const empSel = f.emp ? byId.get(Number(f.emp)) : null;
    if (f.emp && !empSel) return [];
    const from = /^\d{4}-\d{2}-\d{2}$/.test(f.from || "") ? f.from : "";
    const to = /^\d{4}-\d{2}-\d{2}$/.test(f.to || "") ? f.to : "";
    let out: Row[] = [];
    // Removal re-checks exactly the records it was given (no 5000 cap).
    const idsOf = (prefix?: string) =>
      (Array.isArray(f.ids) ? f.ids : [])
        .map(String)
        .filter((v: string) =>
          prefix ? v.startsWith(prefix + ":") : /^\d+$/.test(v)
        )
        .map((v: string) => Number(prefix ? v.slice(prefix.length + 1) : v));
    const byIds = (col: string, prefix?: string, w = where, p = params) => {
      if (!Array.isArray(f.ids)) return;
      const ids = idsOf(prefix);
      w.push(ids.length ? `${col} IN (${inList(ids)})` : "1=0");
      p.push(...ids);
    };

    if (kind === "leave") {
      byIds("la.id");
      if (empSel)
        where.push("la.user_id = ?"), params.push(empSel.user_id || 0);
      if (from) where.push("la.end_date >= ?"), params.push(from);
      if (to) where.push("la.start_date <= ?"), params.push(to);
      if (f.status) where.push("la.status = ?"), params.push(f.status);
      if (f.type) where.push("la.leave_type = ?"), params.push(f.type);
      const rows: any[] =
        (await queryDB(
          `SELECT la.id, la.user_id, la.leave_type, la.start_date, la.end_date, la.day_count, la.status, la.purpose, la.created_at,
                  (SELECT ar.current_step FROM approval_requests ar WHERE ar.source_type = 'leave_application' AND ar.source_id = la.id ORDER BY ar.id DESC LIMIT 1) AS step
             FROM leave_applications la ${
               where.length ? "WHERE " + where.join(" AND ") : ""
             }
            ORDER BY la.start_date DESC, la.id DESC LIMIT ${MAX_MATCH + 1}`,
          params
        )) || [];
      for (const r of rows) {
        let locked: string | null = null;
        if (r.status === "approved") {
          const m =
            (await lockFor(r.user_id, day(r.start_date))) ||
            (await lockFor(r.user_id, day(r.end_date)));
          if (m) locked = paidMsg(m);
        }
        const days = Number(r.day_count || 0);
        out.push({
          id: String(r.id),
          user_id: Number(r.user_id),
          emp: personOf(byUser.get(Number(r.user_id))),
          date: day(r.start_date),
          end_date: day(r.end_date),
          leave_type: r.leave_type,
          days,
          purpose: r.purpose || "",
          applied: day(r.created_at),
          status:
            r.status +
            (r.status === "pending" && r.step ? ` · Layer ${r.step}` : ""),
          effect:
            r.status === "rejected"
              ? "Nothing else to undo"
              : `${days} day${days === 1 ? " goes" : "s go"} back to the ${
                  r.leave_type
                } balance${
                  r.status === "pending" ? "; its approval request closes" : ""
                }`,
          locked,
        });
      }
    }

    if (kind === "bill") {
      byIds("b.id");
      if (empSel) where.push("b.user_id = ?"), params.push(empSel.user_id || 0);
      if (from) where.push("b.claim_date >= ?"), params.push(from);
      if (to) where.push("b.claim_date <= ?"), params.push(to);
      if (f.status === "returned") where.push("b.edit_state = 'returned'");
      else if (f.status) where.push("b.status = ?"), params.push(f.status);
      if (f.type)
        where.push(
          "(b.category = ? OR EXISTS (SELECT 1 FROM bill_claim_items i WHERE i.bill_claim_id = b.id AND i.category_name = ?))"
        ),
          params.push(f.type, f.type);
      const rows: any[] =
        (await queryDB(
          `SELECT b.id, b.user_id, b.claim_date, b.category, b.amount, b.approved_amount, b.status, b.edit_state,
                  (SELECT GROUP_CONCAT(DISTINCT i.category_name SEPARATOR ', ') FROM bill_claim_items i WHERE i.bill_claim_id = b.id) AS cats,
                  (SELECT ar.current_step FROM approval_requests ar WHERE ar.source_type = 'bill_claim' AND ar.source_id = b.id ORDER BY ar.id DESC LIMIT 1) AS step,
                  (SELECT GROUP_CONCAT(DISTINCT CONCAT(cb.id, ':', cb.is_disbursed, ':', COALESCE(cb.voucher_no, ''))) FROM conveyance_bill_items ci JOIN conveyance_bills cb ON cb.id = ci.bill_id WHERE ci.bill_claim_id = b.id) AS bills
             FROM bill_claims b ${
               where.length ? "WHERE " + where.join(" AND ") : ""
             }
            ORDER BY b.claim_date DESC, b.id DESC LIMIT ${MAX_MATCH + 1}`,
          params
        )) || [];
      for (const r of rows) {
        const bills = String(r.bills || "")
          .split(",")
          .filter(Boolean)
          .map((s) => {
            const [id, dis, ...v] = s.split(":");
            return {
              id: Number(id),
              disbursed: dis === "1",
              voucher: v.join(":"),
            };
          });
        const paid = bills.find((b) => b.disbursed);
        const status =
          (r.edit_state === "returned" ? "returned" : r.status) +
          (r.status === "pending" && r.step ? ` · Layer ${r.step}` : "") +
          (bills.length
            ? ` · Bill #${bills.map((b) => b.id).join(", #")}${
                paid ? " Disbursed" : " (Pending)"
              }`
            : "");
        out.push({
          id: String(r.id),
          user_id: Number(r.user_id),
          emp: personOf(byUser.get(Number(r.user_id))),
          date: day(r.claim_date),
          cats: r.cats || r.category || "",
          amount: Number(r.approved_amount ?? r.amount ?? 0),
          status,
          effect: paid
            ? ""
            : bills.length
            ? `Comes off Bill #${bills
                .map((b) => b.id)
                .join(", #")} (an emptied Bill goes too)`
            : r.status === "pending"
            ? "Its approval request closes; the date can be claimed again"
            : "Nothing else to undo",
          locked: paid
            ? `Locked — paid out${
                paid.voucher ? ` on voucher ${paid.voucher}` : ""
              } (Undisburse it first)`
            : null,
        });
      }
    }

    if (kind === "claim") {
      byIds("c.id");
      if (empSel) where.push("c.user_id = ?"), params.push(empSel.user_id || 0);
      if (from)
        where.push("c.check_in_at >= ?"), params.push(from + " 00:00:00");
      if (to) where.push("c.check_in_at <= ?"), params.push(to + " 23:59:59");
      if (f.q)
        where.push("c.purpose LIKE ?"),
          params.push(`%${String(f.q).slice(0, 100)}%`);
      const rows: any[] =
        (await queryDB(
          `SELECT c.id, c.user_id, c.purpose, c.status, c.check_in_at, c.check_out_at, c.distance_km, c.check_in_remarks, c.check_out_remarks,
                  (SELECT ar.status FROM approval_requests ar WHERE ar.source_type = 'claim' AND ar.source_id = c.id ORDER BY ar.id DESC LIMIT 1) AS appr,
                  (SELECT ar.current_step FROM approval_requests ar WHERE ar.source_type = 'claim' AND ar.source_id = c.id ORDER BY ar.id DESC LIMIT 1) AS step,
                  (SELECT SUM(ci.amount) FROM conveyance_bill_items ci WHERE ci.claim_id = c.id) AS amount,
                  (SELECT GROUP_CONCAT(DISTINCT CONCAT(cb.id, ':', cb.is_disbursed, ':', COALESCE(cb.voucher_no, ''))) FROM conveyance_bill_items ci JOIN conveyance_bills cb ON cb.id = ci.bill_id WHERE ci.claim_id = c.id) AS bills,
                  (SELECT GROUP_CONCAT(DISTINCT r.bill_claim_id) FROM bill_claim_references r WHERE r.claim_id = c.id) AS in_claims
             FROM claims c ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY c.check_in_at DESC, c.id DESC LIMIT ${MAX_MATCH + 1}`,
          params
        )) || [];
      for (const r of rows) {
        const st = r.status === "open" ? "open" : r.appr || "completed";
        if (f.status && f.status !== st) continue;
        const bills = String(r.bills || "")
          .split(",")
          .filter(Boolean)
          .map((s) => {
            const [id, dis, ...v] = s.split(":");
            return {
              id: Number(id),
              disbursed: dis === "1",
              voucher: v.join(":"),
            };
          });
        const paid = bills.find((b) => b.disbursed);
        const inClaims = String(r.in_claims || "")
          .split(",")
          .filter(Boolean);
        out.push({
          id: String(r.id),
          user_id: Number(r.user_id),
          emp: personOf(byUser.get(Number(r.user_id))),
          date: day(r.check_in_at),
          purpose: r.purpose || "",
          check_in_at: r.check_in_at,
          check_out_at: r.check_out_at,
          distance_km: r.distance_km == null ? null : Number(r.distance_km),
          amount: r.amount == null ? null : Number(r.amount),
          status:
            (st === "open" ? "Open — no Check Out" : st) +
            (st === "pending" && r.step ? ` · Layer ${r.step}` : "") +
            (bills.length
              ? ` · Bill #${bills.map((b) => b.id).join(", #")}${
                  paid ? " Disbursed" : " (Pending)"
                }`
              : ""),
          effect: paid
            ? ""
            : inClaims.length
            ? ""
            : st === "open"
            ? "The open trip goes; a new Check In can start"
            : bills.length
            ? `Comes off Bill #${bills.map((b) => b.id).join(", #")}`
            : st === "pending"
            ? "Its approval request closes"
            : "Nothing else to undo",
          locked: paid
            ? `Locked — paid out${
                paid.voucher ? ` on voucher ${paid.voucher}` : ""
              }`
            : inClaims.length
            ? `Locked — used on Bill Claim #${inClaims.join(
                ", #"
              )}; remove that Bill Claim first`
            : null,
        });
      }
    }

    if (kind === "attendance") {
      const w2: string[] = [];
      const p2: any[] = [];
      byIds("a.id", "a");
      byIds("c.id", "c", w2, p2);
      if (empSel)
        where.push("a.user_id = ?"),
          params.push(empSel.user_id || 0),
          w2.push("c.user_id = ?"),
          p2.push(empSel.user_id || 0);
      if (from)
        where.push("a.attendance_date >= ?"),
          params.push(from),
          w2.push("c.attendance_date >= ?"),
          p2.push(from);
      if (to)
        where.push("a.attendance_date <= ?"),
          params.push(to),
          w2.push("c.attendance_date <= ?"),
          p2.push(to);
      if (f.project)
        where.push("a.project_id = ?"),
          params.push(Number(f.project)),
          w2.push("c.project_id = ?"),
          p2.push(Number(f.project));
      const outOnly = f.mode === "out";
      if (outOnly) where.push("a.check_out_at IS NOT NULL");
      const rows: any[] =
        (await queryDB(
          `SELECT a.id, a.user_id, a.project_id, a.attendance_date, a.check_in_at, a.check_out_at, a.check_in_distance_m, a.check_out_distance_m,
                  a.check_in_place, a.check_out_place,
                  (SELECT p.project_name FROM projects p WHERE p.id = a.project_id) AS project_name,
                  (SELECT ar.status FROM approval_requests ar WHERE ar.source_type = 'attendance' AND ar.source_id = a.id ORDER BY ar.id DESC LIMIT 1) AS offsite,
                  (SELECT ac.status FROM attendance_corrections ac WHERE ac.user_id = a.user_id AND ac.attendance_date = a.attendance_date ORDER BY ac.id DESC LIMIT 1) AS corr
             FROM attendance a ${
               where.length ? "WHERE " + where.join(" AND ") : ""
             }
            ORDER BY a.attendance_date DESC, a.id DESC LIMIT ${MAX_MATCH + 1}`,
          params
        )) || [];
      const howOf = (r: any) =>
        r.corr
          ? `Correct Attendance · ${r.corr}`
          : r.offsite
          ? `Off-site · ${
              r.offsite === "pending" ? "waiting approval" : r.offsite
            }`
          : "App (GPS)";
      for (const r of rows) {
        const m = await lockFor(r.user_id, day(r.attendance_date));
        out.push({
          id: `a:${r.id}`,
          user_id: Number(r.user_id),
          emp: personOf(byUser.get(Number(r.user_id))),
          date: day(r.attendance_date),
          project: r.project_name || "",
          check_in_at: r.check_in_at,
          check_out_at: r.check_out_at,
          in_m:
            r.check_in_distance_m == null
              ? null
              : Math.round(Number(r.check_in_distance_m)),
          out_m:
            r.check_out_distance_m == null
              ? null
              : Math.round(Number(r.check_out_distance_m)),
          status: howOf(r),
          effect: outOnly
            ? "The Out goes; the In stays and the person can give the Out again"
            : r.corr
            ? "The correction of that day goes too"
            : r.offsite === "pending"
            ? "Its approval request closes"
            : "The day then shows from the office machine, or Absent",
          locked: m ? paidMsg(m) : null,
        });
      }
      if (!outOnly) {
        // A Correct Attendance of a day with no attendance row (still pending,
        // or rejected) is its own line.
        const cs: any[] =
          (await queryDB(
            `SELECT c.id, c.user_id, c.project_id, c.attendance_date, c.requested_check_in_at, c.requested_check_out_at, c.status,
                    (SELECT p.project_name FROM projects p WHERE p.id = c.project_id) AS project_name
               FROM attendance_corrections c
              WHERE NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = c.user_id AND a.attendance_date = c.attendance_date)
                ${w2.length ? "AND " + w2.join(" AND ") : ""}
              ORDER BY c.attendance_date DESC, c.id DESC LIMIT ${
                MAX_MATCH + 1
              }`,
            p2
          )) || [];
        for (const r of cs) {
          const m = await lockFor(r.user_id, day(r.attendance_date));
          out.push({
            id: `c:${r.id}`,
            user_id: Number(r.user_id),
            emp: personOf(byUser.get(Number(r.user_id))),
            date: day(r.attendance_date),
            project: r.project_name || "",
            check_in_at: r.requested_check_in_at,
            check_out_at: r.requested_check_out_at,
            in_m: null,
            out_m: null,
            status: `Correct Attendance · ${r.status} (no attendance yet)`,
            effect:
              r.status === "pending"
                ? "The request and its approval close"
                : "Only the request line goes",
            locked: m && r.status === "approved" ? paidMsg(m) : null,
          });
        }
        out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      }
    }

    if (kind === "history") {
      byIds("l.id");
      if (empSel) where.push("l.employee_id = ?"), params.push(empSel.id);
      if (from)
        where.push("l.created_at >= ?"), params.push(from + " 00:00:00");
      if (to) where.push("l.created_at <= ?"), params.push(to + " 23:59:59");
      if (f.type) where.push("l.field_name = ?"), params.push(f.type);
      if (f.by) where.push("l.action_by = ?"), params.push(Number(f.by));
      if (f.nochange === "1")
        where.push("COALESCE(l.old_value, '') = COALESCE(l.new_value, '')");
      const rows: any[] =
        (await queryDB(
          `SELECT l.id, l.employee_id, l.field_name, LEFT(l.old_value, 300) AS old_value, LEFT(l.new_value, 300) AS new_value, l.action_by, l.created_at,
                  (SELECT u.name FROM users u WHERE u.id = l.action_by) AS by_name
             FROM employee_change_log l ${
               where.length ? "WHERE " + where.join(" AND ") : ""
             }
            ORDER BY l.created_at DESC, l.id DESC LIMIT ${MAX_MATCH + 1}`,
          params
        )) || [];
      for (const r of rows) {
        const p = byId.get(Number(r.employee_id));
        out.push({
          id: String(r.id),
          user_id: p?.user_id ? Number(p.user_id) : null,
          emp: personOf(p),
          date: String(r.created_at || ""),
          field: r.field_name,
          old_value: r.old_value ?? "",
          new_value: r.new_value ?? "",
          by: r.by_name || (r.action_by ? `User #${r.action_by}` : "System"),
          status:
            (r.old_value ?? "") === (r.new_value ?? "")
              ? "No real change"
              : "Changed",
          effect:
            "Only the history line goes — the employee's record stays as it is",
          locked: null,
        });
      }
    }

    // Department / Head Office–Project filters work on the person.
    if (f.dept)
      out = out.filter((r) => norm(r.emp?.department) === norm(f.dept));
    if (f.place)
      out = out.filter((r) => (r.emp?.place || "Not set") === f.place);
    return out;
  }

  // ---------- remove one record ----------
  async function removeOne(
    kind: Kind,
    id: string,
    mode: string,
    q: Query
  ): Promise<{ snap: Snapshot; label: string } | null> {
    const snap: Snapshot = { tables: [] };
    // A Bill Claim's link to a Check In/Out that is itself removed (and not
    // put back) is simply left out on restore.
    const take = (
      table: string,
      rows: any[],
      ignore = table === "bill_claim_references"
    ) => rows.length && snap.tables.push({ table, rows, ignore });
    const approvals = async (
      sourceType: string,
      sourceIds: number[],
      eventType?: string
    ) => {
      if (!sourceIds.length) return;
      const ars: any[] = await q(
        `SELECT * FROM approval_requests WHERE source_type = ? AND source_id IN (${inList(
          sourceIds
        )})${eventType ? " AND event_type = ?" : ""}`,
        [sourceType, ...sourceIds, ...(eventType ? [eventType] : [])]
      );
      const arIds = ars.map((a) => Number(a.id));
      const sigs: any[] = arIds.length
        ? await q(
            `SELECT * FROM claim_approval_signatures WHERE approval_request_id IN (${inList(
              arIds
            )})`,
            arIds
          )
        : [];
      take("approval_requests", ars);
      take("claim_approval_signatures", sigs);
      if (sigs.length)
        await q(
          `DELETE FROM claim_approval_signatures WHERE approval_request_id IN (${inList(
            arIds
          )})`,
          arIds
        );
      if (arIds.length)
        await q(
          `DELETE FROM approval_requests WHERE id IN (${inList(arIds)})`,
          arIds
        );
    };
    // Conveyance Bill lines of a claim / Bill Claim; a Bill left empty goes too.
    const billLines = async (
      col: "claim_id" | "bill_claim_id",
      rid: number
    ) => {
      const items: any[] = await q(
        `SELECT * FROM conveyance_bill_items WHERE ${col} = ?`,
        [rid]
      );
      if (!items.length) return;
      const billIds = [...new Set(items.map((i) => Number(i.bill_id)))];
      const bills: any[] = await q(
        `SELECT * FROM conveyance_bills WHERE id IN (${inList(
          billIds
        )}) FOR UPDATE`,
        billIds
      );
      if (bills.some((b) => Number(b.is_disbursed) === 1))
        throw bad("It is on a Disbursed Bill.", 409);
      await q(`DELETE FROM conveyance_bill_items WHERE ${col} = ?`, [rid]);
      const emptied: any[] = [];
      for (const b of bills) {
        const left: any[] = await q(
          "SELECT COUNT(*) AS n FROM conveyance_bill_items WHERE bill_id = ?",
          [b.id]
        );
        if (Number(left[0]?.n || 0) === 0) emptied.push(b);
      }
      // Bills first on restore (they are the parents), the lines last.
      if (emptied.length) {
        snap.tables.unshift({
          table: "conveyance_bills",
          rows: emptied,
          ignore: true,
        });
        await q(
          `DELETE FROM conveyance_bills WHERE id IN (${inList(
            emptied.map((b) => Number(b.id))
          )})`,
          emptied.map((b) => Number(b.id))
        );
      }
      snap.tables.push({
        table: "conveyance_bill_items",
        rows: items,
        ignore: true,
      });
    };

    if (kind === "leave") {
      const rid = Number(id);
      const [la] = (await q(
        "SELECT * FROM leave_applications WHERE id = ? FOR UPDATE",
        [rid]
      )) as any[];
      if (!la) return null;
      take("leave_applications", [la]);
      await approvals("leave_application", [rid]);
      await q("DELETE FROM leave_applications WHERE id = ?", [rid]);
      if (la.status === "pending" || la.status === "approved")
        snap.leave = {
          user_id: Number(la.user_id),
          leave_type: String(la.leave_type),
          days: Number(la.day_count || 0),
        };
      return {
        snap,
        label: `${la.leave_type} leave ${day(la.start_date)} – ${day(
          la.end_date
        )} (${Number(la.day_count || 0)} d, ${la.status})`,
      };
    }

    if (kind === "bill") {
      const rid = Number(id);
      const [bc] = (await q(
        "SELECT * FROM bill_claims WHERE id = ? FOR UPDATE",
        [rid]
      )) as any[];
      if (!bc) return null;
      take("bill_claims", [bc]);
      for (const t of [
        "bill_claim_items",
        "bill_claim_references",
        "bill_claim_history",
      ])
        take(t, await q(`SELECT * FROM ${t} WHERE bill_claim_id = ?`, [rid]));
      await approvals("bill_claim", [rid]);
      await billLines("bill_claim_id", rid);
      for (const t of [
        "bill_claim_items",
        "bill_claim_references",
        "bill_claim_history",
      ])
        await q(`DELETE FROM ${t} WHERE bill_claim_id = ?`, [rid]);
      await q("DELETE FROM bill_claims WHERE id = ?", [rid]);
      return {
        snap,
        label: `Bill Claim #${rid} · ${day(bc.claim_date)} · ৳${Number(
          bc.approved_amount ?? bc.amount ?? 0
        )} (${bc.status})`,
      };
    }

    if (kind === "claim") {
      const rid = Number(id);
      const [c] = (await q("SELECT * FROM claims WHERE id = ? FOR UPDATE", [
        rid,
      ])) as any[];
      if (!c) return null;
      const refs: any[] = await q(
        "SELECT bill_claim_id FROM bill_claim_references WHERE claim_id = ?",
        [rid]
      );
      if (refs.length)
        throw bad(
          `It is used on Bill Claim #${refs
            .map((r) => r.bill_claim_id)
            .join(", #")}; remove that Bill Claim first.`,
          409
        );
      take("claims", [c]);
      await approvals("claim", [rid]);
      await billLines("claim_id", rid);
      await q("DELETE FROM claims WHERE id = ?", [rid]);
      return {
        snap,
        label: `Check In/Out #${rid} · ${day(c.check_in_at)} · ${String(
          c.purpose || ""
        ).slice(0, 80)}`,
      };
    }

    if (kind === "attendance") {
      const [t, raw] = id.split(":");
      const rid = Number(raw);
      if (t === "c") {
        const [c] = (await q(
          "SELECT * FROM attendance_corrections WHERE id = ? FOR UPDATE",
          [rid]
        )) as any[];
        if (!c) return null;
        take("attendance_corrections", [c]);
        await approvals("attendance_correction", [rid]);
        await q("DELETE FROM attendance_corrections WHERE id = ?", [rid]);
        return {
          snap,
          label: `Correct Attendance request · ${day(c.attendance_date)} (${
            c.status
          })`,
        };
      }
      const [a] = (await q("SELECT * FROM attendance WHERE id = ? FOR UPDATE", [
        rid,
      ])) as any[];
      if (!a) return null;
      if (mode === "out") {
        if (!a.check_out_at) return null;
        const cols = [
          "check_out_at",
          "check_out_lat",
          "check_out_lng",
          "check_out_distance_m",
          "check_out_remarks",
          "check_out_place",
          "check_out_first_at",
          "check_out_update_count",
          "check_out_project_id",
        ];
        snap.updates = [
          {
            table: "attendance",
            id: rid,
            set: Object.fromEntries(cols.map((c) => [c, a[c]])),
          },
        ];
        await approvals("attendance", [rid], "check_out");
        await q(
          `UPDATE attendance SET ${cols
            .map(
              (c) => `${c} = ${c === "check_out_update_count" ? "0" : "NULL"}`
            )
            .join(", ")} WHERE id = ?`,
          [rid]
        );
        return { snap, label: `Out of ${day(a.attendance_date)} (In kept)` };
      }
      take("attendance", [a]);
      take(
        "attendance_admin_edits",
        await q(
          "SELECT * FROM attendance_admin_edits WHERE attendance_id = ?",
          [rid]
        )
      );
      const cors: any[] = await q(
        "SELECT * FROM attendance_corrections WHERE user_id = ? AND attendance_date = ?",
        [a.user_id, day(a.attendance_date)]
      );
      take("attendance_corrections", cors);
      await approvals("attendance", [rid]);
      await approvals(
        "attendance_correction",
        cors.map((c) => Number(c.id))
      );
      await q("DELETE FROM attendance_admin_edits WHERE attendance_id = ?", [
        rid,
      ]);
      if (cors.length)
        await q(
          `DELETE FROM attendance_corrections WHERE id IN (${inList(
            cors.map((c) => Number(c.id))
          )})`,
          cors.map((c) => Number(c.id))
        );
      await q("DELETE FROM attendance WHERE id = ?", [rid]);
      return { snap, label: `Attendance ${day(a.attendance_date)} (In + Out)` };
    }

    // history
    const rid = Number(id);
    const [l] = (await q("SELECT * FROM employee_change_log WHERE id = ?", [
      rid,
    ])) as any[];
    if (!l) return null;
    take("employee_change_log", [l]);
    await q("DELETE FROM employee_change_log WHERE id = ?", [rid]);
    return {
      snap,
      label: `${l.field_name}: ${String(l.old_value ?? "").slice(
        0,
        60
      )} → ${String(l.new_value ?? "").slice(0, 60)}`,
    };
  }

  // ---------- routes ----------
  app.get(
    "/api/system/cleanup/options",
    authenticateToken,
    requireOwner,
    async (_req: any, res: Response) => {
      try {
        const { emps } = await loadPeople();
        const [types, cats, projects, fields, by] = await Promise.all([
          queryDB(
            "SELECT DISTINCT leave_type AS v FROM leave_applications ORDER BY leave_type"
          ).catch(() => []),
          queryDB(
            "SELECT DISTINCT v FROM (SELECT category_name AS v FROM bill_claim_items UNION SELECT category AS v FROM bill_claims) x WHERE v IS NOT NULL AND v <> '' ORDER BY v"
          ).catch(() => []),
          queryDB(
            "SELECT id, project_name FROM projects ORDER BY project_name"
          ).catch(() => []),
          queryDB(
            "SELECT DISTINCT field_name AS v FROM employee_change_log ORDER BY field_name"
          ).catch(() => []),
          queryDB(
            "SELECT DISTINCT l.action_by AS id, u.name FROM employee_change_log l JOIN users u ON u.id = l.action_by ORDER BY u.name"
          ).catch(() => []),
        ]);
        const depts = [
          ...new Set(
            emps
              .map((e: any) => String(e.department || "").trim())
              .filter(Boolean)
          ),
        ].sort();
        res.json({
          employees: emps.map((e: any) => ({
            id: e.id,
            name: e.name,
            employee_id: e.employee_id,
            designation: e.designation,
            department: e.department,
          })),
          departments: depts,
          leave_types: (types || []).map((r: any) => r.v).filter(Boolean),
          categories: (cats || []).map((r: any) => r.v),
          projects: projects || [],
          fields: (fields || []).map((r: any) => r.v).filter(Boolean),
          changed_by: by || [],
        });
      } catch (e) {
        fail(res, e);
      }
    }
  );

  app.get(
    "/api/system/cleanup/log",
    authenticateToken,
    requireOwner,
    async (_req: any, res: Response) => {
      try {
        await purgeOld();
        const cid = companyStore.getStore()?.companyId ?? null;
        const rows: any[] =
          (await queryDB(
            `SELECT b.*, (SELECT COUNT(*) FROM data_cleanup_trash t WHERE t.batch_id = b.id AND t.restored = 0) AS kept,
                  (SELECT u.name FROM users u WHERE u.id = b.restored_by) AS restored_by_name
             FROM data_cleanup_batches b WHERE ${
               cid == null ? "1=1" : "b.company_id <=> ?"
             } ORDER BY b.id DESC LIMIT 200`,
            cid == null ? [] : [cid]
          )) || [];
        res.json({
          keep_days: KEEP_DAYS,
          batches: rows.map((b) => ({
            id: b.id,
            kind: b.kind,
            kind_label: KIND_LABEL[b.kind as Kind] || b.kind,
            mode: b.mode,
            count: Number(b.count || 0),
            reason: b.reason,
            actor_name: b.actor_name,
            created_at: b.created_at,
            restored_at: b.restored_at,
            restored_by_name: b.restored_by_name,
            restored_count: b.restored_count,
            can_restore: Number(b.kept || 0) > 0,
          })),
        });
      } catch (e) {
        fail(res, e);
      }
    }
  );

  app.get(
    "/api/system/cleanup/batches/:id",
    authenticateToken,
    requireOwner,
    async (req: any, res: Response) => {
      try {
        const items: any[] =
          (await queryDB(
            "SELECT id, record_id, label, restored FROM data_cleanup_trash WHERE batch_id = ? ORDER BY id",
            [Number(req.params.id)]
          )) || [];
        res.json({ items });
      } catch (e) {
        fail(res, e);
      }
    }
  );

  app.get(
    "/api/system/cleanup/:kind",
    authenticateToken,
    requireOwner,
    async (req: any, res: Response) => {
      try {
        const kind = kindOf(req.params.kind);
        const all = await listKind(kind, req.query || {});
        const capped = all.length > MAX_MATCH;
        const rows = all.slice(0, MAX_MATCH);
        const removable = rows.filter((r) => !r.locked);
        const summary = {
          total: rows.length,
          capped,
          locked: rows.length - removable.length,
          removable: removable.length,
          leave_days:
            kind === "leave"
              ? removable
                  .filter((r) => !/^rejected/.test(r.status))
                  .reduce((s, r) => s + Number(r.days || 0), 0)
              : undefined,
          amount:
            kind === "bill"
              ? removable.reduce((s, r) => s + Number(r.amount || 0), 0)
              : undefined,
        };
        if (req.query.ids_only === "1")
          return res.json({ ids: removable.map((r) => r.id), summary });
        if (req.query.all === "1") return res.json({ rows, summary });
        const size = Math.min(200, Math.max(10, Number(req.query.size) || 50));
        const page = Math.max(1, Number(req.query.page) || 1);
        res.json({
          rows: rows.slice((page - 1) * size, page * size),
          page,
          size,
          summary,
        });
      } catch (e) {
        fail(res, e);
      }
    }
  );

  app.post(
    "/api/system/cleanup/:kind/remove",
    authenticateToken,
    requireOwner,
    async (req: any, res: Response) => {
      try {
        if (!withTransaction)
          throw bad("Removing needs the MySQL database.", 503);
        const kind = kindOf(req.params.kind);
        const body = req.body || {};
        const ids: string[] = [
          ...new Set<string>(
            (Array.isArray(body.ids) ? body.ids : []).map((v: any) => String(v))
          ),
        ].slice(0, 200);
        const total = Number(body.total) || 0;
        const reason = String(body.reason || "").trim();
        const mode = kind === "attendance" && body.mode === "out" ? "out" : "";
        if (!ids.length) throw bad("Nothing selected.");
        if (reason.length < 3) throw bad("Write the reason for removing them.");
        if (
          !total ||
          String(body.confirm || "")
            .trim()
            .toUpperCase() !== `DELETE ${total}`
        )
          throw bad(`Type DELETE ${total || ""} to confirm.`.trim());
        const idRe = kind === "attendance" ? /^[ac]:\d+$/ : /^\d+$/;
        if (ids.some((i) => !idRe.test(i))) throw bad("Bad record id.");

        // Re-check against the company-scoped list: only records this company
        // sees, and none that are locked.
        const listed = new Map(
          (await listKind(kind, { mode, ids })).map((r) => [r.id, r])
        );
        const skipped: { id: string; why: string }[] = [];
        const todo: string[] = [];
        for (const i of ids) {
          const r = listed.get(i);
          if (!r)
            skipped.push({
              id: i,
              why: "Not found (already removed, or not in this company)",
            });
          else if (r.locked) skipped.push({ id: i, why: r.locked });
          else todo.push(i);
        }

        let batchId = Number(body.batch_id) || 0;
        const actor = req.cleanupActor;
        if (batchId) {
          const own: any[] = await queryDB(
            "SELECT id FROM data_cleanup_batches WHERE id = ? AND actor_id = ? AND kind = ? AND restored_at IS NULL",
            [batchId, actor.id, kind]
          );
          if (!own.length)
            throw bad("That removal batch is not open any more.", 409);
        } else if (todo.length) {
          const cid = companyStore.getStore()?.companyId ?? null;
          const r: any = await queryDB(
            "INSERT INTO data_cleanup_batches (company_id, kind, mode, count, reason, filters_json, actor_id, actor_name) VALUES (?, ?, ?, 0, ?, ?, ?, ?)",
            [
              cid,
              kind,
              mode || null,
              reason.slice(0, 2000),
              JSON.stringify(body.filters || {}).slice(0, 4000),
              actor.id,
              actor.name || null,
            ]
          );
          batchId = Number(r?.insertId || 0);
        }

        let removed = 0;
        for (const i of todo) {
          let done: { snap: Snapshot; label: string } | null = null;
          try {
            await withTransaction(async (q) => {
              done = await removeOne(kind, i, mode, q);
              if (done)
                await q(
                  "INSERT INTO data_cleanup_trash (batch_id, kind, record_id, label, rows_json) VALUES (?, ?, ?, ?, ?)",
                  [
                    batchId,
                    kind,
                    i,
                    done.label.slice(0, 500),
                    JSON.stringify(enc(done.snap)),
                  ]
                );
            });
          } catch (e: any) {
            skipped.push({ id: i, why: e.message || "Could not remove" });
            continue;
          }
          if (!done) {
            skipped.push({ id: i, why: "Already gone" });
            continue;
          }
          removed++;
          const lv = (done as { snap: Snapshot }).snap.leave;
          if (lv && lv.days)
            await adjustLeaveTypeBalance(
              lv.user_id,
              lv.leave_type,
              lv.days
            ).catch((e) =>
              console.warn("Data cleanup leave refund:", e?.message)
            );
        }
        if (batchId && removed)
          await queryDB(
            "UPDATE data_cleanup_batches SET count = count + ? WHERE id = ?",
            [removed, batchId]
          );
        res.json({ batch_id: batchId || null, removed, skipped });
      } catch (e) {
        fail(res, e);
      }
    }
  );

  app.post(
    "/api/system/cleanup/batches/:id/restore",
    authenticateToken,
    requireOwner,
    async (req: any, res: Response) => {
      try {
        if (!withTransaction)
          throw bad("Putting back needs the MySQL database.", 503);
        await purgeOld();
        const batchId = Number(req.params.id);
        const cid = companyStore.getStore()?.companyId ?? null;
        const [batch] = (await queryDB(
          `SELECT * FROM data_cleanup_batches WHERE id = ?${
            cid == null ? "" : " AND company_id <=> ?"
          }`,
          cid == null ? [batchId] : [batchId, cid]
        )) as any[];
        if (!batch) throw bad("Removal not found.", 404);
        const items: any[] =
          (await queryDB(
            "SELECT * FROM data_cleanup_trash WHERE batch_id = ? AND restored = 0 ORDER BY id DESC",
            [batchId]
          )) || [];
        if (!items.length)
          throw bad(
            `Nothing left to put back — removals are kept for ${KEEP_DAYS} days.`,
            409
          );
        const onlyIds = Array.isArray(req.body?.items)
          ? new Set(req.body.items.map(Number))
          : null;
        const lockFor = await payLock();
        let restored = 0;
        const skipped: { label: string; why: string }[] = [];
        for (const it of items) {
          if (onlyIds && !onlyIds.has(Number(it.id))) continue;
          const snap: Snapshot = dec(JSON.parse(it.rows_json || "{}"));
          // A day / leave in a month that has since been paid stays out.
          const main = snap.tables[0]?.rows?.[0] || {};
          const lockDay =
            it.kind === "leave" && main.status === "approved"
              ? day(main.start_date)
              : it.kind === "attendance"
              ? day(main.attendance_date || "")
              : "";
          if (it.kind === "attendance" && snap.updates?.length) {
            const [a] = (await queryDB(
              "SELECT user_id, attendance_date FROM attendance WHERE id = ?",
              [snap.updates[0].id]
            )) as any[];
            if (a) {
              const m = await lockFor(a.user_id, day(a.attendance_date));
              if (m) {
                skipped.push({ label: it.label, why: paidMsg(m) });
                continue;
              }
            }
          } else if (lockDay && main.user_id) {
            const m = await lockFor(main.user_id, lockDay);
            if (m) {
              skipped.push({ label: it.label, why: paidMsg(m) });
              continue;
            }
          }
          try {
            await withTransaction(async (q) => {
              for (const u of snap.updates || []) {
                const cols = Object.keys(u.set).filter((c) => IDENT.test(c));
                const r: any = await q(
                  `UPDATE ${u.table} SET ${cols
                    .map((c) => `${c} = ?`)
                    .join(", ")} WHERE id = ? AND check_out_at IS NULL`,
                  [...cols.map((c) => u.set[c]), u.id]
                );
                if (!r?.affectedRows)
                  throw bad(
                    "The record is gone, or a new Out was given since."
                  );
              }
              for (const t of snap.tables) {
                // Lines of a Bill that has been disbursed since are not added back to it.
                for (const row of t.rows) {
                  if (t.table === "conveyance_bill_items") {
                    const [b] = (await q(
                      "SELECT is_disbursed FROM conveyance_bills WHERE id = ?",
                      [row.bill_id]
                    )) as any[];
                    if (!b || Number(b.is_disbursed) === 1) continue;
                  }
                  await ins(q, t.table, row, !!t.ignore);
                }
              }
              await q(
                "UPDATE data_cleanup_trash SET restored = 1 WHERE id = ?",
                [it.id]
              );
            });
          } catch (e: any) {
            skipped.push({
              label: it.label,
              why:
                e?.code === "ER_DUP_ENTRY"
                  ? "A new record for the same day / id exists now"
                  : e.message || "Could not put back",
            });
            continue;
          }
          restored++;
          if (snap.leave?.days)
            await adjustLeaveTypeBalance(
              snap.leave.user_id,
              snap.leave.leave_type,
              -snap.leave.days
            ).catch(() => {});
        }
        await queryDB(
          "UPDATE data_cleanup_batches SET restored_at = NOW(), restored_by = ?, restored_count = COALESCE(restored_count, 0) + ? WHERE id = ?",
          [req.cleanupActor.id, restored, batchId]
        );
        res.json({ restored, skipped });
      } catch (e) {
        fail(res, e);
      }
    }
  );
}
