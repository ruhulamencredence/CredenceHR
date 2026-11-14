/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// SIM & Mobile Bill -> SIM Inventory: for every company SIM, where it is now,
// who had it before and for how long, its limits and its monthly bills.
//
//   mobile_sim_holders — one row per stretch a SIM spent with one person at
//     one duty location (employee_id NULL = in stock, with nobody). The open
//     row (to_date NULL) is where it is now. Written by every SIM add, edit
//     and import in MobileBillRoutes.ts (recordSimHolder). SIMs that existed
//     before this table are filled once from their activity log
//     (mobile_sim_events "added" / "assigned" — names matched back to
//     employees), with the current duty location on the current stretch.
//
// Reading needs the Mobile Bill module and its "SIM Inventory" layer
// (sim_inventory); a Superadmin always may.

import type { Express } from "express";
import { getStartupMarker, setStartupMarker } from "./startupOnce";

type Query = (sql: string, params?: any[]) => Promise<any>;

const DAY = 864e5;
const ymd = (v: any): string | null => {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
};
const todayBd = () => new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY));
const money = (v: any) => Math.round(Number(v || 0) * 100) / 100;
const norm = (v: any) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export async function ensureSimInventorySchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(
      `CREATE TABLE IF NOT EXISTS mobile_sim_holders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sim_id INT NOT NULL,
        employee_id INT NULL,
        holder_name VARCHAR(150) NULL,
        duty_location VARCHAR(150) NULL,
        from_date DATE NOT NULL,
        to_date DATE NULL,
        source VARCHAR(10) NOT NULL DEFAULT 'live',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sim_holders_sim (sim_id, from_date),
        INDEX idx_sim_holders_employee (employee_id),
        FOREIGN KEY (sim_id) REFERENCES mobile_sims(id) ON DELETE CASCADE
      )`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not ensure mobile_sim_holders: " + err.message);
    return;
  }
  if (await getStartupMarker(dbPool, "mobile_sim_holders_v1")) return;
  try {
    await backfill((sql: string, params?: any[]) => dbPool.query(sql, params).then((r: any) => r[0]));
    await setStartupMarker(dbPool, "mobile_sim_holders_v1");
  } catch (err: any) {
    console.warn("⚠️ Could not fill SIM holder history: " + err.message);
  }
}

// The stretches of SIMs that have none yet, rebuilt from their activity log.
async function backfill(q: Query) {
  const sims: any[] = (await q("SELECT s.* FROM mobile_sims s WHERE NOT EXISTS (SELECT 1 FROM mobile_sim_holders h WHERE h.sim_id = s.id)")) || [];
  if (!sims.length) return;
  const emps: any[] = (await q("SELECT id, name FROM all_employees")) || [];
  const byName = new Map<string, number | null>();
  for (const e of emps) {
    const k = norm(e.name);
    byName.set(k, byName.has(k) ? null : Number(e.id)); // two with one name: not matched
  }
  const nameOf = new Map<number, string>(emps.map((e: any) => [Number(e.id), String(e.name)]));
  const events: any[] = (await q("SELECT sim_id, action, message, created_at FROM mobile_sim_events WHERE action IN ('added', 'assigned') ORDER BY created_at, id")) || [];
  const bySim = new Map<number, any[]>();
  for (const ev of events) {
    const k = Number(ev.sim_id);
    if (!bySim.has(k)) bySim.set(k, []);
    bySim.get(k)!.push(ev);
  }
  for (const s of sims) {
    const start = ymd(s.issued_on) || ymd(s.created_at) || todayBd();
    // [date, holder name or null]
    const steps: [string, string | null][] = [];
    for (const ev of bySim.get(Number(s.id)) || []) {
      const msg = String(ev.message || "");
      const at = ymd(ev.created_at) || start;
      let m: RegExpExecArray | null;
      if (ev.action === "added") {
        if ((m = /given to (.+?), limit/i.exec(msg)) || (m = /Imported for (.+?), limit/i.exec(msg))) steps.push([start, m[1].trim()]);
        else steps.push([start, null]);
      } else if ((m = /^Given to (.+?)(?: \(was .+\))?\.$/i.exec(msg))) steps.push([at, m[1].trim()]);
      else if (/^Taken back from /i.test(msg)) steps.push([at, null]);
    }
    const currentName = s.employee_id ? nameOf.get(Number(s.employee_id)) || null : null;
    if (!steps.length) steps.push([start, currentName]);
    // The log must end where the SIM is now.
    if (norm(steps[steps.length - 1][1]) !== norm(currentName)) steps.push([todayBd() < start ? start : todayBd(), currentName]);
    // Same-day changes: the last one of the day counts.
    const merged: [string, string | null][] = [];
    for (const st of steps) {
      if (merged.length && merged[merged.length - 1][0] === st[0]) merged[merged.length - 1] = st;
      else if (!merged.length || norm(merged[merged.length - 1][1]) !== norm(st[1])) merged.push(st);
    }
    for (let i = 0; i < merged.length; i++) {
      const [from, name] = merged[i];
      const to = i + 1 < merged.length ? merged[i + 1][0] : null;
      const last = i === merged.length - 1;
      const empId = last && s.employee_id ? Number(s.employee_id) : name ? byName.get(norm(name)) ?? null : null;
      await q(
        "INSERT INTO mobile_sim_holders (sim_id, employee_id, holder_name, duty_location, from_date, to_date, source) VALUES (?, ?, ?, ?, ?, ?, 'log')",
        [Number(s.id), empId, name, last ? s.duty_location || null : null, from, to]
      );
    }
  }
}

// A SIM's holder or duty location changes (add, edit, import): close the
// current stretch and open a new one. Nothing happens when neither changed.
export async function recordSimHolder(
  queryDB: Query,
  simId: number,
  employee: { id: number; name: string } | null,
  dutyLocation: string | null,
  from?: string | null
): Promise<void> {
  try {
    const day = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : todayBd();
    const open: any = ((await queryDB("SELECT * FROM mobile_sim_holders WHERE sim_id = ? AND to_date IS NULL ORDER BY id DESC LIMIT 1", [simId])) as any[])[0];
    const empId = employee ? Number(employee.id) : null;
    if (open && (open.employee_id == null ? null : Number(open.employee_id)) === empId && norm(open.duty_location) === norm(dutyLocation)) return;
    if (open) {
      // Changed the same day it started: that stretch never really was.
      if (ymd(open.from_date) === day) await queryDB("DELETE FROM mobile_sim_holders WHERE id = ?", [open.id]);
      else await queryDB("UPDATE mobile_sim_holders SET to_date = ? WHERE id = ?", [day, open.id]);
    }
    await queryDB("INSERT INTO mobile_sim_holders (sim_id, employee_id, holder_name, duty_location, from_date, source) VALUES (?, ?, ?, ?, ?, 'live')", [
      simId,
      empId,
      employee?.name || null,
      dutyLocation || null,
      day
    ]);
  } catch (err: any) {
    console.warn("⚠️ Could not record SIM holder: " + err.message);
  }
}

interface Deps {
  authenticateToken: any;
  queryDB: Query;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
}

export function registerSimInventoryRoutes(app: Express, deps: Deps) {
  const { authenticateToken, queryDB, hasModuleLayer } = deps;
  const gate = async (req: any, res: any, next: any) => {
    try {
      if (req.user?.role === "superadmin" || (await hasModuleLayer(req.user, "mobile_bill", "sim_inventory"))) return next();
      res.status(403).json({ error: "SIM Inventory access required." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  const loadEmployees = async () => {
    const rows: any[] = (await queryDB("SELECT id, employee_id, name, designation, department FROM all_employees")) || [];
    return new Map<number, any>(rows.map((e) => [Number(e.id), e]));
  };
  const who = (emps: Map<number, any>, id: any, fallback: string | null) => {
    const e = id ? emps.get(Number(id)) : null;
    return e
      ? { id: Number(e.id), name: e.name, employee_code: e.employee_id || null, designation: e.designation || null, department: e.department || null }
      : fallback
        ? { id: null, name: fallback, employee_code: null, designation: null, department: null }
        : null;
  };

  // Every SIM: where it is now, since when, how many holders, bills.
  app.get("/api/mobile-bill/inventory", authenticateToken, gate, async (_req: any, res: any) => {
    try {
      const today = todayBd();
      const [sims, holders, bills, emps]: any[] = await Promise.all([
        queryDB("SELECT * FROM mobile_sims ORDER BY phone_number"),
        queryDB("SELECT * FROM mobile_sim_holders ORDER BY from_date, id"),
        queryDB("SELECT sim_id, bill_month, amount, limit_amount FROM mobile_bills ORDER BY bill_month"),
        loadEmployees()
      ]);
      const hBySim = new Map<number, any[]>();
      for (const h of holders || []) {
        const k = Number(h.sim_id);
        if (!hBySim.has(k)) hBySim.set(k, []);
        hBySim.get(k)!.push(h);
      }
      const bBySim = new Map<number, any[]>();
      for (const b of bills || []) {
        const k = Number(b.sim_id);
        if (!bBySim.has(k)) bBySim.set(k, []);
        bBySim.get(k)!.push(b);
      }
      res.json(
        (sims || []).map((s: any) => {
          const hs = hBySim.get(Number(s.id)) || [];
          const open = [...hs].reverse().find((h) => !h.to_date) || null;
          const since = open ? ymd(open.from_date) : ymd(s.issued_on);
          const bs = bBySim.get(Number(s.id)) || [];
          const total = bs.reduce((t, b) => t + money(b.amount), 0);
          const last = bs[bs.length - 1];
          return {
            id: Number(s.id),
            phone_number: s.phone_number,
            operator: s.operator,
            package_name: s.package_name || null,
            status: s.status,
            holder: who(emps, s.employee_id, null),
            duty_location: s.duty_location || null,
            since,
            days: since ? daysBetween(since, today) : null,
            holders: new Set(hs.filter((h) => h.employee_id || h.holder_name).map((h) => (h.employee_id ? `e${h.employee_id}` : `n${norm(h.holder_name)}`))).size,
            limit_amount: money(s.limit_amount),
            bills: bs.length,
            total_billed: money(total),
            average_bill: bs.length ? money(total / bs.length) : 0,
            over_limit_months: bs.filter((b) => money(b.amount) > money(b.limit_amount)).length,
            last_bill: last ? { month: last.bill_month, amount: money(last.amount), limit_amount: money(last.limit_amount) } : null
          };
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // One SIM's whole story.
  app.get("/api/mobile-bill/inventory/:id(\\d+)", authenticateToken, gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const sim: any = ((await queryDB("SELECT * FROM mobile_sims WHERE id = ?", [id])) as any[])[0];
      if (!sim) return res.status(404).json({ error: "SIM not found." });
      const today = todayBd();
      const [holders, events, bills, users, emps]: any[] = await Promise.all([
        queryDB("SELECT * FROM mobile_sim_holders WHERE sim_id = ? ORDER BY from_date DESC, id DESC", [id]),
        queryDB("SELECT * FROM mobile_sim_events WHERE sim_id = ? AND action IN ('added', 'limit') ORDER BY created_at DESC, id DESC", [id]),
        queryDB("SELECT * FROM mobile_bills WHERE sim_id = ? ORDER BY bill_month DESC", [id]),
        queryDB("SELECT id, name FROM users"),
        loadEmployees()
      ]);
      const userName = new Map<number, string>((users || []).map((u: any) => [Number(u.id), u.name]));
      res.json({
        id,
        phone_number: sim.phone_number,
        operator: sim.operator,
        package_name: sim.package_name || null,
        status: sim.status,
        issued_on: ymd(sim.issued_on),
        holder: who(emps, sim.employee_id, null),
        duty_location: sim.duty_location || null,
        limit_amount: money(sim.limit_amount),
        limit_source: sim.limit_source,
        holders: (holders || []).map((h: any) => {
          const from = ymd(h.from_date)!;
          const to = ymd(h.to_date);
          return {
            holder: who(emps, h.employee_id, h.holder_name || null),
            duty_location: h.duty_location || null,
            from,
            to,
            current: !to,
            days: daysBetween(from, to || today),
            // Rebuilt from the activity log (before this history was kept).
            from_log: h.source === "log"
          };
        }),
        limits: (events || [])
          .filter((e: any) => e.new_limit != null || e.action === "limit")
          .map((e: any) => ({
            date: ymd(e.created_at),
            old_limit: e.old_limit == null ? null : money(e.old_limit),
            new_limit: e.new_limit == null ? null : money(e.new_limit),
            kind: e.change_kind || null,
            for_month: e.for_month || null,
            note: e.message,
            by: e.actor_id ? userName.get(Number(e.actor_id)) || null : null
          })),
        bills: (bills || []).map((b: any) => ({
          month: b.bill_month,
          amount: money(b.amount),
          limit_amount: money(b.limit_amount),
          over: Math.max(0, money(money(b.amount) - money(b.limit_amount))),
          holder: who(emps, b.employee_id, null),
          paid_at: b.paid_at || null
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
