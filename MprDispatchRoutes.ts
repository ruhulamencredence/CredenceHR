/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PEPM: the MPR cycle after the project asks for material.
//
//   Project asks (an MPR row: entries)  ->  Purchase dispatches  ->  Project receives
//
// Purchase picks the rows to work on in the MPR Entries report (filter, tick,
// "Send to Dispatch"); only those rows are in Dispatch Material.
// Dispatch Material (Admin Panel -> PEPM Management -> Reports, after Budget
// Submission Status): Purchase sends material against MPR rows, all of a row's
// remaining Qty or part of it, with supplier / rate / P.O. / challan. Either on
// screen or from the "Daily Site Requirement and Delivery Status" Excel they
// fill and upload (the page reads the sheet, this file checks and saves it).
// Permission: the Reports layer "dispatch_material" (explicit-only). Everyone
// in Purchase who has it sees and works on every row here.
//
// Material Receive (Self Service -> PEPM Operation, switch
// users.can_receive_material): "My MPR in Dispatch" shows where the rows this
// account entered (its own Job entries) stand in Dispatch Material, read only.
// "On the way": an account with the switch, for the projects it holds
// (user_project_permissions), confirms what arrived — all of it, or less,
// with a note. When the row's whole Qty has arrived the row is complete and
// leaves the open MPR Entries report.
//
// Every dispatch, receipt and cancellation is written to mpr_fulfil_log (the
// row's timeline). Nothing is ever deleted: a wrong dispatch is cancelled
// (while not yet received), with a reason.

import type { Express } from "express";

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: any) => any;
  requireModuleLayer: (moduleKey: any, layer: any) => any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  parseQtyNumber: (value: any) => number | null;
  toDateOnlyString: (value: any) => string | null;
  todayInDhaka: () => string;
  createAlert: (queryDB: any, params: { userId: number; type: any; title: string; message: string; relatedType?: string; relatedId?: number }) => Promise<void>;
}

export async function ensureMprDispatchSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ MPR dispatch (${label}): ${err.message}`);
    }
  };
  await run(
    "mpr_dispatches",
    `CREATE TABLE IF NOT EXISTS mpr_dispatches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      entry_id INT NOT NULL,
      qty DECIMAL(14,2) NOT NULL,
      dispatch_date DATE NOT NULL,
      supplier VARCHAR(255) NULL,
      rate DECIMAL(14,2) NULL,
      po_no VARCHAR(255) NULL,
      challan_no VARCHAR(100) NULL,
      vehicle_no VARCHAR(100) NULL,
      note VARCHAR(1000) NULL,
      source VARCHAR(20) NOT NULL DEFAULT 'screen',
      status VARCHAR(20) NOT NULL DEFAULT 'sent',
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      received_qty DECIMAL(14,2) NULL,
      received_date DATE NULL,
      received_note VARCHAR(1000) NULL,
      received_by INT NULL,
      received_at TIMESTAMP NULL DEFAULT NULL,
      cancelled_by INT NULL,
      cancelled_at TIMESTAMP NULL DEFAULT NULL,
      cancel_reason VARCHAR(1000) NULL,
      KEY idx_mpr_dispatch_entry (entry_id),
      KEY idx_mpr_dispatch_status (status)
    ) DEFAULT CHARSET=utf8mb4`
  );
  await run(
    "mpr_fulfil_log",
    `CREATE TABLE IF NOT EXISTS mpr_fulfil_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      entry_id INT NOT NULL,
      dispatch_id INT NULL,
      action VARCHAR(20) NOT NULL,
      qty DECIMAL(14,2) NULL,
      detail VARCHAR(1000) NULL,
      user_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_mpr_fulfil_log_entry (entry_id)
    ) DEFAULT CHARSET=utf8mb4`
  );
  // Each MPR row's totals, kept in step with its dispatches (refreshEntry).
  const cols: [string, string][] = [
    ["md_status", "VARCHAR(20) NOT NULL DEFAULT 'pending'"],
    ["md_target_qty", "DECIMAL(14,2) NULL"],
    ["md_dispatched_qty", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
    ["md_received_qty", "DECIMAL(14,2) NOT NULL DEFAULT 0"],
    ["md_last_dispatch_date", "DATE NULL"],
    ["md_received_date", "DATE NULL"],
    // Sent to Dispatch Material from the MPR Entries report (when, by whom).
    ["md_queued_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["md_queued_by", "INT NULL"]
  ];
  for (const [c, d] of cols) await run(`entries.${c}`, `ALTER TABLE entries ADD COLUMN ${c} ${d}`, ["ER_DUP_FIELDNAME"]);
  // Self Service switch: confirm material received for one's own projects.
  await run("users.can_receive_material", "ALTER TABLE users ADD COLUMN can_receive_material TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
}

export const MD_STATUS_LABEL: Record<string, string> = {
  pending: "Not dispatched",
  partly_dispatched: "Partly dispatched",
  dispatched: "Dispatched",
  partly_received: "Partly received",
  received: "Received"
};

export function registerMprDispatchRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, hasModuleLayer, queryDB, parseQtyNumber, toDateOnlyString, todayInDhaka, createAlert } = deps;
  const dispatchGate = [authenticateToken, requireAdmin, requireModule("reports"), requireModuleLayer("reports", "dispatch_material")];

  const bad = (message: string, status = 400) => Object.assign(new Error(message), { status });
  const handler = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      const status = Number(err?.status) || 500;
      if (status >= 500) console.warn("⚠️ MPR dispatch:", err?.message || err);
      res.status(status).json({ error: err?.message || "Something went wrong." });
    }
  };
  const str = (v: any, max = 255) => (v === null || v === undefined ? "" : String(v).trim().slice(0, max));
  const num = (v: any): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = parseQtyNumber(v);
    return n === null || !Number.isFinite(n) ? null : n;
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const EPS = 0.005;
  // A date from the screen or Excel: YYYY-MM-DD, DD/MM/YY(YY) or DD-MM-YY(YY).
  const dateOf = (v: any): string | null => {
    const s = str(v, 40);
    if (!s) return null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
    if (m) {
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
    return null;
  };

  const log = (entryId: number, dispatchId: number | null, action: string, qty: number | null, detail: string, userId: number) =>
    queryDB("INSERT INTO mpr_fulfil_log (entry_id, dispatch_id, action, qty, detail, user_id) VALUES (?, ?, ?, ?, ?, ?)", [
      entryId,
      dispatchId,
      action,
      qty,
      detail.slice(0, 1000),
      userId
    ]).catch(() => undefined);

  // The Qty the row asked for: its own requisitioned Qty, else the Budget
  // row's Req. Qty. null when neither is a number.
  async function targetOf(entryId: number): Promise<number | null> {
    const rows: any[] =
      (await queryDB(
        `SELECT e.requisitioned_qty, bi.req_qty FROM entries e LEFT JOIN budget_items bi ON bi.id = e.budget_item_id WHERE e.id = ?`,
        [entryId]
      )) || [];
    const r = rows[0];
    if (!r) return null;
    const own = r.requisitioned_qty === null || r.requisitioned_qty === undefined ? null : Number(r.requisitioned_qty);
    if (own !== null && Number.isFinite(own) && own > 0) return own;
    const fromBudget = num(r.req_qty);
    return fromBudget !== null && fromBudget > 0 ? fromBudget : null;
  }

  // Works the row's totals and status out from its dispatches again.
  //   received          the whole Qty has arrived (no Qty known: everything sent has arrived)
  //   dispatched        the whole Qty is sent, some of it still on the way
  //   partly_dispatched part is sent and on the way, more to send
  //   partly_received   what was sent has arrived, but less than the whole Qty
  //   pending           nothing sent yet
  // A short receipt counts only what arrived, so the rest can be sent again.
  async function refreshEntry(entryId: number) {
    const target = await targetOf(entryId);
    const ds: any[] = (await queryDB("SELECT * FROM mpr_dispatches WHERE entry_id = ? AND status <> 'cancelled'", [entryId])) || [];
    let sent = 0,
      open = 0,
      recv = 0,
      covered = 0,
      lastDispatch: string | null = null,
      lastReceived: string | null = null;
    for (const d of ds) {
      const q = Number(d.qty) || 0;
      sent += q;
      const dd = toDateOnlyString(d.dispatch_date);
      if (dd && (!lastDispatch || dd > lastDispatch)) lastDispatch = dd;
      if (d.status === "received") {
        const rq = Number(d.received_qty) || 0;
        recv += rq;
        covered += rq;
        const rd = toDateOnlyString(d.received_date);
        if (rd && (!lastReceived || rd > lastReceived)) lastReceived = rd;
      } else {
        open += 1;
        covered += q;
      }
    }
    let status = "pending";
    if (target !== null && recv >= target - EPS) status = "received";
    else if (target === null && ds.length > 0 && open === 0) status = "received";
    else if (open > 0) status = target !== null && covered >= target - EPS ? "dispatched" : "partly_dispatched";
    else if (recv > 0) status = "partly_received";
    await queryDB(
      `UPDATE entries SET md_status = ?, md_target_qty = ?, md_dispatched_qty = ?, md_received_qty = ?, md_last_dispatch_date = ?, md_received_date = ? WHERE id = ?`,
      [status, target, r2(sent), r2(recv), lastDispatch, status === "received" ? lastReceived : null, entryId]
    );
    return { status, target, sent: r2(sent), received: r2(recv), remaining: target === null ? null : Math.max(0, r2(target - covered)) };
  }

  // One MPR row as the Dispatch page shows it.
  const ROW_SQL = `
    SELECT e.id, e.entry_date, e.item_name, e.job_name, e.delivery_date, e.requisitioned_qty, e.project_id, e.created_by,
      e.md_status, e.md_target_qty, e.md_dispatched_qty, e.md_received_qty, e.md_last_dispatch_date, e.md_received_date, e.md_queued_at, e.md_queued_by,
      qu.name AS queued_by_name,
      p.project_name, m.mpr_no, j.job_no, b.budget_name, u.name AS user_name,
      bi.specification, bi.unit, bi.req_qty
    FROM entries e
    JOIN projects p ON e.project_id = p.id
    JOIN jobs j ON e.job_id = j.id
    JOIN mpr_numbers m ON e.mpr_id = m.id
    LEFT JOIN users u ON e.created_by = u.id
    LEFT JOIN users qu ON e.md_queued_by = qu.id
    LEFT JOIN budgets b ON e.budget_id = b.id
    LEFT JOIN budget_items bi ON bi.id = e.budget_item_id
    WHERE e.deleted_at IS NULL`;
  const rowOut = (r: any, dispatches: any[] = []) => {
    const target = r.md_target_qty !== null && r.md_target_qty !== undefined ? Number(r.md_target_qty) : r.requisitioned_qty != null ? Number(r.requisitioned_qty) : num(r.req_qty);
    const covered = dispatches.reduce((n, d) => n + (d.status === "received" ? Number(d.receivedQty) || 0 : d.status === "sent" ? Number(d.qty) || 0 : 0), 0);
    return {
      id: Number(r.id),
      entryDate: toDateOnlyString(r.entry_date),
      projectId: Number(r.project_id),
      projectName: r.project_name,
      mprNo: r.mpr_no,
      jobNo: r.job_no,
      jobName: r.job_name || "",
      budgetName: r.budget_name || "",
      item: r.item_name,
      specification: r.specification || "",
      unit: r.unit || "",
      qty: target,
      deliveryDate: toDateOnlyString(r.delivery_date),
      requestedBy: r.user_name || "",
      status: r.md_status || "pending",
      dispatchedQty: Number(r.md_dispatched_qty) || 0,
      receivedQty: Number(r.md_received_qty) || 0,
      remaining: target === null ? null : Math.max(0, r2(target - covered)),
      lastDispatchDate: toDateOnlyString(r.md_last_dispatch_date),
      receivedDate: toDateOnlyString(r.md_received_date),
      queuedAt: r.md_queued_at || null,
      queuedBy: r.queued_by_name || "",
      dispatches
    };
  };
  const dispatchOut = (d: any) => ({
    id: Number(d.id),
    entryId: Number(d.entry_id),
    qty: Number(d.qty),
    dispatchDate: toDateOnlyString(d.dispatch_date),
    supplier: d.supplier || "",
    rate: d.rate === null || d.rate === undefined ? null : Number(d.rate),
    poNo: d.po_no || "",
    challanNo: d.challan_no || "",
    vehicleNo: d.vehicle_no || "",
    note: d.note || "",
    source: d.source,
    status: d.status,
    sentBy: d.sent_by_name || "",
    sentAt: d.created_at,
    receivedQty: d.received_qty === null || d.received_qty === undefined ? null : Number(d.received_qty),
    receivedDate: toDateOnlyString(d.received_date),
    receivedNote: d.received_note || "",
    receivedBy: d.received_by_name || "",
    cancelReason: d.cancel_reason || ""
  });
  const DISPATCH_SQL = `
    SELECT d.*, us.name AS sent_by_name, ur.name AS received_by_name
    FROM mpr_dispatches d
    LEFT JOIN users us ON us.id = d.created_by
    LEFT JOIN users ur ON ur.id = d.received_by`;
  async function dispatchesFor(entryIds: number[]): Promise<Map<number, any[]>> {
    const out = new Map<number, any[]>();
    if (!entryIds.length) return out;
    for (let i = 0; i < entryIds.length; i += 500) {
      const part = entryIds.slice(i, i + 500);
      const rows: any[] = (await queryDB(`${DISPATCH_SQL} WHERE d.entry_id IN (${part.map(() => "?").join(",")}) ORDER BY d.dispatch_date ASC, d.id ASC`, part)) || [];
      for (const d of rows) {
        const list = out.get(Number(d.entry_id)) || [];
        list.push(dispatchOut(d));
        out.set(Number(d.entry_id), list);
      }
    }
    return out;
  }

  // ---- Dispatch Material ------------------------------------------------------
  // view: open (not yet fully received; the default), received, all.
  app.get(
    "/api/mpr-dispatch/rows",
    ...dispatchGate,
    handler(async (req, res) => {
      const view = ["open", "received", "all"].includes(String(req.query.view)) ? String(req.query.view) : "open";
      // Only rows Purchase sent here from the MPR Entries report.
      let sql = `${ROW_SQL} AND e.md_queued_at IS NOT NULL`;
      if (view === "open") sql += " AND e.md_status <> 'received'";
      if (view === "received") sql += " AND e.md_status = 'received'";
      sql += " ORDER BY e.delivery_date ASC, p.project_name ASC, e.id ASC";
      const rows: any[] = (await queryDB(sql)) || [];
      const ds = await dispatchesFor(rows.map((r) => Number(r.id)));
      res.setHeader("Cache-Control", "no-store");
      res.json({ rows: rows.map((r) => rowOut(r, ds.get(Number(r.id)) || [])) });
    })
  );

  // Sends material: [{ entryId, qty, dispatchDate, supplier, rate, poNo, challanNo, vehicleNo, note }].
  // Checks every line first; saves only when all of them are right.
  app.post(
    "/api/mpr-dispatch/dispatch",
    ...dispatchGate,
    handler(async (req, res) => {
      const items: any[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, 2000) : [];
      const source = req.body?.source === "excel" ? "excel" : "screen";
      if (!items.length) throw bad("Pick at least one MPR row to dispatch.");
      const today = todayInDhaka();
      const errors: { index: number; entryId: number; error: string }[] = [];
      const clean: any[] = [];
      // Qty being sent in this same batch per row, so two lines can't overshoot together.
      const inBatch = new Map<number, number>();
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const entryId = Number(it.entryId);
        const fail = (error: string) => errors.push({ index: i, entryId, error });
        const rows: any[] = entryId ? (await queryDB(`${ROW_SQL} AND e.id = ?`, [entryId])) || [] : [];
        if (!rows[0]) {
          fail("MPR row not found (deleted, or not in this company).");
          continue;
        }
        const qty = num(it.qty);
        if (qty === null || qty <= 0) {
          fail("Enter the Qty sent.");
          continue;
        }
        const date = it.dispatchDate ? dateOf(it.dispatchDate) : today;
        if (!date) {
          fail("Dispatch date isn't a date.");
          continue;
        }
        if (date > today) {
          fail("Dispatch date can't be in the future.");
          continue;
        }
        if (rows[0].md_status === "received") {
          fail("This MPR row is already fully received.");
          continue;
        }
        if (!rows[0].md_queued_at) {
          fail("This MPR row isn't in Dispatch Material — send it there from the MPR Entries report first.");
          continue;
        }
        const ds = (await dispatchesFor([entryId])).get(entryId) || [];
        const row = rowOut(rows[0], ds);
        const already = inBatch.get(entryId) || 0;
        if (row.remaining !== null && qty + already > row.remaining + EPS) {
          fail(`Only ${r2(row.remaining - already)} ${row.unit || ""} left to send on this row.`.replace(/\s+\./, "."));
          continue;
        }
        inBatch.set(entryId, already + qty);
        const rate = num(it.rate);
        clean.push({
          entryId,
          qty: r2(qty),
          date,
          supplier: str(it.supplier) || null,
          rate: rate === null ? null : r2(rate),
          poNo: str(it.poNo) || null,
          challanNo: str(it.challanNo, 100) || null,
          vehicleNo: str(it.vehicleNo, 100) || null,
          note: str(it.note, 1000) || null,
          row
        });
      }
      if (errors.length) {
        res.status(400).json({ error: `${errors.length} line${errors.length === 1 ? " needs" : "s need"} fixing — nothing was dispatched.`, errors });
        return;
      }
      const userId = Number(req.user.id);
      const byProject = new Map<number, { name: string; lines: string[] }>();
      for (const c of clean) {
        const r: any = await queryDB(
          `INSERT INTO mpr_dispatches (entry_id, qty, dispatch_date, supplier, rate, po_no, challan_no, vehicle_no, note, source, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [c.entryId, c.qty, c.date, c.supplier, c.rate, c.poNo, c.challanNo, c.vehicleNo, c.note, source, userId]
        );
        const id = Number(r.insertId);
        await log(
          c.entryId,
          id,
          "dispatch",
          c.qty,
          [c.supplier && `Supplier ${c.supplier}`, c.poNo && `P.O. ${c.poNo}`, c.challanNo && `Challan ${c.challanNo}`, c.vehicleNo && `Vehicle ${c.vehicleNo}`, c.note]
            .filter(Boolean)
            .join(" · "),
          userId
        );
        await refreshEntry(c.entryId);
        const p = byProject.get(c.row.projectId) || { name: c.row.projectName, lines: [] };
        p.lines.push(`${c.row.mprNo} ${c.row.item}: ${c.qty} ${c.row.unit || ""}`.trim());
        byProject.set(c.row.projectId, p);
      }
      // Tell the project's receivers what is on its way.
      for (const [projectId, p] of byProject) {
        const people: any[] =
          (await queryDB(
            `SELECT DISTINCT u.id FROM users u JOIN user_project_permissions upp ON upp.user_id = u.id
             WHERE upp.project_id = ? AND u.can_receive_material = 1 AND COALESCE(u.is_blocked, 0) = 0`,
            [projectId]
          ).catch(() => [])) || [];
        for (const u of people) {
          await createAlert(queryDB, {
            userId: Number(u.id),
            type: "mpr_dispatch",
            title: "Material dispatched",
            message: `${p.name}: ${p.lines.slice(0, 4).join("; ")}${p.lines.length > 4 ? ` and ${p.lines.length - 4} more` : ""}. Confirm it in Material Receive when it arrives.`,
            relatedType: "mpr_dispatch"
          });
        }
      }
      res.status(201).json({ dispatched: clean.length });
    })
  );

  // MPR Entries report -> "Send to Dispatch": these rows go to Dispatch Material.
  app.post(
    "/api/mpr-dispatch/queue",
    ...dispatchGate,
    handler(async (req, res) => {
      const ids = [...new Set<number>((Array.isArray(req.body?.entryIds) ? req.body.entryIds : []).map(Number).filter((n: number) => n > 0))].slice(0, 2000);
      if (!ids.length) throw bad("Tick at least one MPR row.");
      const rows: any[] = (await queryDB(`${ROW_SQL} AND e.id IN (${ids.map(() => "?").join(",")})`, ids)) || [];
      let added = 0,
        already = 0,
        done = 0;
      for (const r of rows) {
        if (r.md_status === "received") {
          done++;
          continue;
        }
        if (r.md_queued_at) {
          already++;
          continue;
        }
        await queryDB("UPDATE entries SET md_queued_at = NOW(), md_queued_by = ? WHERE id = ? AND md_queued_at IS NULL", [Number(req.user.id), Number(r.id)]);
        await log(Number(r.id), null, "queue", null, "Sent to Dispatch Material", Number(req.user.id));
        await refreshEntry(Number(r.id));
        added++;
      }
      res.json({ added, already, received: done, missing: ids.length - rows.length });
    })
  );
  // Back out of Dispatch Material — only while nothing has been sent on the row.
  app.post(
    "/api/mpr-dispatch/unqueue",
    ...dispatchGate,
    handler(async (req, res) => {
      const ids = [...new Set<number>((Array.isArray(req.body?.entryIds) ? req.body.entryIds : []).map(Number).filter((n: number) => n > 0))].slice(0, 2000);
      if (!ids.length) throw bad("Pick at least one MPR row.");
      let removed = 0;
      const kept: number[] = [];
      for (const id of ids) {
        const sent: any[] = (await queryDB("SELECT COUNT(*) AS n FROM mpr_dispatches WHERE entry_id = ? AND status <> 'cancelled'", [id])) || [];
        if (Number(sent[0]?.n || 0) > 0) {
          kept.push(id);
          continue;
        }
        const r: any = await queryDB("UPDATE entries SET md_queued_at = NULL, md_queued_by = NULL WHERE id = ? AND md_queued_at IS NOT NULL", [id]);
        if (Number(r?.affectedRows)) {
          await log(id, null, "unqueue", null, "Taken out of Dispatch Material", Number(req.user.id));
          removed++;
        }
      }
      res.json({ removed, kept: kept.length });
    })
  );

  // A dispatch sent by mistake, while it isn't received yet.
  app.post(
    "/api/mpr-dispatch/dispatches/:id/cancel",
    ...dispatchGate,
    handler(async (req, res) => {
      const reason = str(req.body?.reason, 1000);
      if (!reason) throw bad("Say why it is cancelled.");
      const d: any = ((await queryDB("SELECT * FROM mpr_dispatches WHERE id = ?", [Number(req.params.id)])) || [])[0];
      if (!d) throw bad("Dispatch not found.", 404);
      if (d.status !== "sent") throw bad(d.status === "received" ? "Already received — it can't be cancelled." : "Already cancelled.");
      await queryDB("UPDATE mpr_dispatches SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ? AND status = 'sent'", [
        Number(req.user.id),
        reason,
        Number(d.id)
      ]);
      await log(Number(d.entry_id), Number(d.id), "cancel", Number(d.qty), reason, Number(req.user.id));
      res.json(await refreshEntry(Number(d.entry_id)));
    })
  );

  // ---- Material Receive (Self Service) ---------------------------------------
  async function canReceive(user: any): Promise<boolean> {
    if (user?.role === "superadmin") return true;
    const rows: any[] = (await queryDB("SELECT can_receive_material FROM users WHERE id = ?", [Number(user?.id)]).catch(() => [])) || [];
    return !!Number(rows[0]?.can_receive_material);
  }
  // The projects this account receives for: every one for an Admin or the
  // Superadmin, else the ones it was given (user_project_permissions).
  async function myProjectIds(user: any): Promise<number[] | null> {
    if (user.role === "superadmin" || user.role === "admin") return null;
    const rows: any[] = (await queryDB("SELECT project_id FROM user_project_permissions WHERE user_id = ?", [Number(user.id)])) || [];
    return rows.map((r) => Number(r.project_id));
  }
  const receiveGate = async (req: any) => {
    if (!(await canReceive(req.user))) throw bad("Material Receive isn't turned on for your account.", 403);
  };

  // The rows this account entered itself (entries.created_by) that Purchase
  // took into Dispatch Material — every status, read only.
  app.get(
    "/api/material-receive/my-mpr",
    authenticateToken,
    handler(async (req, res) => {
      await receiveGate(req);
      const rows: any[] =
        (await queryDB(`${ROW_SQL} AND e.md_queued_at IS NOT NULL AND e.created_by = ? ORDER BY e.md_status = 'received', e.delivery_date ASC, e.id ASC`, [
          Number(req.user.id)
        ])) || [];
      const ds = await dispatchesFor(rows.map((r) => Number(r.id)));
      res.setHeader("Cache-Control", "no-store");
      res.json({ rows: rows.map((r) => rowOut(r, ds.get(Number(r.id)) || [])) });
    })
  );

  // Rows of my projects with material on the way (open), or the last 60 days
  // of what arrived (?view=received).
  app.get(
    "/api/material-receive",
    authenticateToken,
    handler(async (req, res) => {
      await receiveGate(req);
      const ids = await myProjectIds(req.user);
      res.setHeader("Cache-Control", "no-store");
      if (ids && !ids.length) return res.json({ rows: [] });
      const received = req.query.view === "received";
      let sql = ROW_SQL;
      const params: any[] = [];
      if (ids) {
        sql += ` AND e.project_id IN (${ids.map(() => "?").join(",")})`;
        params.push(...ids);
      }
      sql += received
        ? ` AND EXISTS (SELECT 1 FROM mpr_dispatches d WHERE d.entry_id = e.id AND d.status = 'received' AND d.received_date >= CURDATE() - INTERVAL 60 DAY)`
        : ` AND EXISTS (SELECT 1 FROM mpr_dispatches d WHERE d.entry_id = e.id AND d.status = 'sent')`;
      sql += " ORDER BY e.delivery_date ASC, e.id ASC";
      const rows: any[] = (await queryDB(sql, params)) || [];
      const ds = await dispatchesFor(rows.map((r) => Number(r.id)));
      res.json({ rows: rows.map((r) => rowOut(r, ds.get(Number(r.id)) || [])) });
    })
  );

  // Confirms one dispatch arrived: { receivedQty, receivedDate, note }.
  // Less than was sent needs a note (short / damaged).
  app.post(
    "/api/material-receive/:dispatchId",
    authenticateToken,
    handler(async (req, res) => {
      await receiveGate(req);
      const d: any = ((await queryDB("SELECT * FROM mpr_dispatches WHERE id = ?", [Number(req.params.dispatchId)])) || [])[0];
      if (!d) throw bad("Dispatch not found.", 404);
      const entry: any = ((await queryDB(`${ROW_SQL} AND e.id = ?`, [Number(d.entry_id)])) || [])[0];
      if (!entry) throw bad("MPR row not found.", 404);
      const ids = await myProjectIds(req.user);
      if (ids && !ids.includes(Number(entry.project_id))) throw bad("This isn't one of your projects.", 403);
      if (d.status !== "sent") throw bad(d.status === "received" ? "Already received." : "This dispatch was cancelled by Purchase.");
      const qty = num(req.body?.receivedQty);
      if (qty === null || qty < 0) throw bad("Enter the Qty that arrived.");
      if (qty > Number(d.qty) + EPS) throw bad(`More than was sent (${Number(d.qty)}).`);
      const date = req.body?.receivedDate ? dateOf(req.body.receivedDate) : todayInDhaka();
      if (!date) throw bad("Received date isn't a date.");
      if (date > todayInDhaka()) throw bad("Received date can't be in the future.");
      const sentOn = toDateOnlyString(d.dispatch_date);
      if (sentOn && date < sentOn) throw bad(`Received date can't be before it was sent (${sentOn}).`);
      const note = str(req.body?.note, 1000);
      const short = qty < Number(d.qty) - EPS;
      if (short && !note) throw bad("Less than was sent — say why (short, damaged…).");
      const done: any = await queryDB(
        "UPDATE mpr_dispatches SET status = 'received', received_qty = ?, received_date = ?, received_note = ?, received_by = ?, received_at = NOW() WHERE id = ? AND status = 'sent'",
        [r2(qty), date, note || null, Number(req.user.id), Number(d.id)]
      );
      if (!Number(done?.affectedRows)) throw bad("Already received.");
      await log(Number(d.entry_id), Number(d.id), "receive", r2(qty), short ? `Short by ${r2(Number(d.qty) - qty)} — ${note}` : note || "", Number(req.user.id));
      const now = await refreshEntry(Number(d.entry_id));
      // Purchase hears about a short receipt.
      if (short && d.created_by) {
        await createAlert(queryDB, {
          userId: Number(d.created_by),
          type: "mpr_dispatch",
          title: "Material received short",
          message: `${entry.project_name} · ${entry.mpr_no} ${entry.item_name}: ${r2(qty)} of ${Number(d.qty)} arrived — ${note}`,
          relatedType: "mpr_dispatch"
        });
      }
      res.json(now);
    })
  );

  // ---- Timeline of one MPR row ------------------------------------------------
  // For Dispatch Material, the MPR Entries report (Reports "read"), or a
  // receiver of the row's project.
  app.get(
    "/api/mpr-dispatch/entries/:id/timeline",
    authenticateToken,
    handler(async (req, res) => {
      const entryId = Number(req.params.id);
      const entry: any = ((await queryDB(`${ROW_SQL} AND e.id = ?`, [entryId])) || [])[0];
      if (!entry) throw bad("MPR row not found.", 404);
      let ok = (await hasModuleLayer(req.user, "reports", "dispatch_material")) || (await hasModuleLayer(req.user, "reports", "read"));
      if (!ok && (await canReceive(req.user))) {
        // A receiver of the row's project, or the one who entered the row.
        const ids = await myProjectIds(req.user);
        ok = !ids || ids.includes(Number(entry.project_id)) || Number(entry.created_by) === Number(req.user.id);
      }
      if (!ok) throw bad("You don't have access to this MPR row.", 403);
      res.setHeader("Cache-Control", "no-store");
      res.json(await timelineOf(entry));
    })
  );
  async function timelineOf(entry: any) {
    const rows: any[] =
      (await queryDB(
        `SELECT l.*, u.name AS user_name FROM mpr_fulfil_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.entry_id = ? ORDER BY l.created_at ASC, l.id ASC`,
        [Number(entry.id)]
      )) || [];
    return {
      row: rowOut(entry, (await dispatchesFor([Number(entry.id)])).get(Number(entry.id)) || []),
      events: [
        { action: "request", qty: entry.md_target_qty ?? entry.requisitioned_qty ?? null, detail: `Delivery date ${toDateOnlyString(entry.delivery_date) || "—"}`, at: toDateOnlyString(entry.entry_date), by: entry.user_name || "" },
        ...rows.map((l) => ({ action: l.action, qty: l.qty === null ? null : Number(l.qty), detail: l.detail || "", at: l.created_at, by: l.user_name || "" }))
      ]
    };
  }

  return { refreshEntry, canReceive, myProjectIds };
}
