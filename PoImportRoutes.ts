/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PEPM -> Reports -> P.O Import: the purchase orders from the ERP's order
// export (Excel) put on the MPR rows they were made for.
//
// Each sheet line is matched to MPR rows (entries) by:
//   - MPR No      = the sheet's "Mrf No" (or "MPR No") column — must be equal;
//   - Material    = "Material Name" vs the row's item — equal after ignoring
//                   case, spaces and punctuation, or the same words in
//                   another order;
//   - Project     = "Project Name" vs the row's project — the ERP's
//                   "WIP-CHL-68_" prefix and "(address)" are ignored, small
//                   spelling differences are allowed;
//   - Specification = "Brand Name" vs the row's Specification — checked
//                   when the sheet gives one ("NONE" / blank = not checked);
//                   word order and a letter or two of spelling don't matter.
// The page reads the sheet (a multi-item P.O only names its project and P.O
// on its first line; the page carries them down) and sends the lines; this
// file checks them (preview) and saves the matched ones (import). Carrying /
// loading / discount lines have no MPR No and are left out.
//
// Saved in mpr_po_lines, one row per MPR row + P.O No: importing the same
// P.O again updates it instead of adding it twice. Every import is kept in
// mpr_po_imports (who, when, file, counts).
// Permission: the Reports layer "po_import" (explicit-only). Reading the P.O
// numbers on the MPR Entries report / Dispatch Material needs only those
// pages' own access.

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: any) => any;
  requireModuleLayer: (moduleKey: any, layer: any) => any;
  queryDB: QueryDB;
}

export async function ensurePoImportSchema(dbPool: any): Promise<void> {
  const run = async (sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      console.warn("⚠️ P.O import schema: " + err.message);
    }
  };
  await run(`
    CREATE TABLE IF NOT EXISTS mpr_po_imports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      file_name VARCHAR(255) NULL,
      total_lines INT NOT NULL DEFAULT 0,
      matched_lines INT NOT NULL DEFAULT 0,
      new_pos INT NOT NULL DEFAULT 0,
      updated_pos INT NOT NULL DEFAULT 0,
      unmatched_lines INT NOT NULL DEFAULT 0,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS mpr_po_lines (
      id INT AUTO_INCREMENT PRIMARY KEY,
      entry_id INT NOT NULL,
      po_no VARCHAR(100) NOT NULL,
      po_date DATE NULL,
      req_no VARCHAR(100) NULL,
      app_no VARCHAR(100) NULL,
      supplier VARCHAR(255) NULL,
      brand VARCHAR(255) NULL,
      unit VARCHAR(50) NULL,
      order_qty DECIMAL(14,2) NULL,
      app_qty DECIMAL(14,2) NULL,
      rate DECIMAL(14,2) NULL,
      amount DECIMAL(16,2) NULL,
      received_qty DECIMAL(14,2) NULL,
      import_id INT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mpr_po_line (entry_id, po_no),
      KEY idx_mpr_po_no (po_no)
    ) DEFAULT CHARSET=utf8mb4
  `);
}

// ---- Matching ---------------------------------------------------------------
// Lower case, letters and digits only ("Hollow Box (1\"X1.5\")" -> "hollowbox1x15").
export const textKey = (s: any) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/[^a-z0-9ঀ-৿]+/g, "");
// "WIP-CHL-68_Park Riviera (P-1/17, ...)" -> "parkriviera".
export const projectKey = (s: any) =>
  textKey(
    String(s ?? "")
      .replace(/^\s*wip[-\s]*[a-z]*[-\s]*\d*\s*[_:\-]\s*/i, "")
      .replace(/\(.*$/, "")
  );
// Same material: equal after ignoring case, spaces and punctuation, or the
// same words in another order ("Stone Chips - 1/2\" Down" = "1/2\" Down Stone Chips").
const words = (s: any) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[×]/g, "x")
    .split(/[^a-z0-9\u0980-\u09ff]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
export const sameMaterial = (a: string, b: string) => textKey(a) === textKey(b) || words(a) === words(b);

// MPR / MRF No: "073878" and "73878" are the same number.
export const mrfKey = (s: any) => String(s ?? "").trim().toLowerCase().replace(/^0+(?=\d)/, "");
const NO_BRAND = new Set(["", "none", "na", "nil", "nobrand", "any"]);

function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export function sameProject(a: string, b: string) {
  const x = projectKey(a);
  const y = projectKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))) return true;
  return Math.min(x.length, y.length) >= 6 && editDistance(x, y, 2) <= 2;
}
export function sameSpec(sheetBrand: string, spec: string) {
  const b = textKey(sheetBrand);
  if (NO_BRAND.has(b)) return true;
  const s = textKey(spec);
  if (!s) return true; // the MPR row gives none to compare with
  if (b === s || (Math.min(b.length, s.length) >= 3 && (b.includes(s) || s.includes(b)))) return true;
  // The same words in another order, a letter or two apart
  // ("Panchogor FM 2.3-2.4" = "Panchogorh 2.3-2.4 FM").
  const wb = words(sheetBrand).replace(/ /g, "");
  const ws = words(spec).replace(/ /g, "");
  return Math.min(wb.length, ws.length) >= 8 && editDistance(wb, ws, 2) <= 2;
}

export interface PoLineIn {
  line: number;
  project: string;
  poNo: string;
  poDate: string;
  reqNo: string;
  mrfNo: string;
  appNo: string;
  supplier: string;
  material: string;
  brand: string;
  unit: string;
  orderQty: number | null;
  appQty: number | null;
  rate: number | null;
  amount: number | null;
  receivedQty: number | null;
}
type Status = "matched" | "mpr_not_found" | "material_not_found" | "project_differs" | "spec_differs" | "no_po";
interface Candidate { id: number; project: string; mprNo: string; item: string; spec: string; qty: number | null; unit: string }

const num = (v: any) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).replace(/,/g, "").trim();
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};
const str = (v: any, max: number) => String(v ?? "").trim().slice(0, max);
// "27-Sep-2026" / "2026-09-27" / Excel day number -> "2026-09-27".
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function poDate(v: any): string | null {
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase());
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (/^\d{5}$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000).toISOString().slice(0, 10);
  return null;
}

function cleanLine(r: any, i: number): PoLineIn {
  return {
    line: Number(r?.line) || i + 1,
    project: str(r?.project, 255),
    poNo: str(r?.poNo, 100),
    poDate: str(r?.poDate, 30),
    reqNo: str(r?.reqNo, 100),
    mrfNo: str(r?.mrfNo, 100),
    appNo: str(r?.appNo, 100),
    supplier: str(r?.supplier, 255),
    material: str(r?.material, 255),
    brand: str(r?.brand, 255),
    unit: str(r?.unit, 50),
    orderQty: num(r?.orderQty),
    appQty: num(r?.appQty),
    rate: num(r?.rate),
    amount: num(r?.amount),
    receivedQty: num(r?.receivedQty)
  };
}

export function registerPoImportRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("reports"), requireModuleLayer("reports", "po_import")];

  // The MPR rows these MPR numbers name (this company's), by MPR No.
  async function candidates(mrfNos: string[]): Promise<Map<string, Candidate[]>> {
    const out = new Map<string, Candidate[]>();
    const keys = [...new Set(mrfNos.map(mrfKey).filter(Boolean))];
    for (let i = 0; i < keys.length; i += 500) {
      const part = keys.slice(i, i + 500);
      const rows: any[] =
        (await queryDB(
          `SELECT e.id, e.item_name, e.requisitioned_qty, p.project_name, m.mpr_no, bi.specification, bi.unit, bi.project_name AS bi_project
             FROM entries e
             JOIN projects p ON e.project_id = p.id
             JOIN mpr_numbers m ON e.mpr_id = m.id
             LEFT JOIN budget_items bi ON bi.id = e.budget_item_id
            WHERE e.deleted_at IS NULL AND TRIM(LEADING '0' FROM LOWER(TRIM(m.mpr_no))) IN (${part.map(() => "?").join(",")})`,
          part
        )) || [];
      for (const r of rows) {
        const k = mrfKey(r.mpr_no);
        const list = out.get(k) || [];
        list.push({
          id: Number(r.id),
          project: String(r.project_name || r.bi_project || ""),
          mprNo: String(r.mpr_no),
          item: String(r.item_name || ""),
          spec: String(r.specification || ""),
          qty: r.requisitioned_qty === null || r.requisitioned_qty === undefined ? null : Number(r.requisitioned_qty),
          unit: String(r.unit || "")
        });
        out.set(k, list);
      }
    }
    return out;
  }

  // Each line's result: matched rows, or why not.
  async function check(lines: PoLineIn[]) {
    const byMrf = await candidates(lines.map((l) => l.mrfNo));
    const existing = new Set<string>();
    const ids = [...new Set([...byMrf.values()].flat().map((c) => c.id))];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const rows: any[] = (await queryDB(`SELECT entry_id, po_no FROM mpr_po_lines WHERE entry_id IN (${part.map(() => "?").join(",")})`, part)) || [];
      for (const r of rows) existing.add(`${r.entry_id}|${String(r.po_no).toLowerCase()}`);
    }
    return lines.map((l) => {
      let status: Status = "matched";
      let note = "";
      let matched: Candidate[] = [];
      const inMpr = byMrf.get(mrfKey(l.mrfNo)) || [];
      if (!l.poNo) status = "no_po";
      else if (!inMpr.length) status = "mpr_not_found";
      else {
        const sameItem = inMpr.filter((c) => sameMaterial(c.item, l.material));
        if (!sameItem.length) {
          status = "material_not_found";
          note = `This MPR has: ${[...new Set(inMpr.map((c) => c.item))].slice(0, 4).join(", ")}`;
        } else {
          const sameProj = sameItem.filter((c) => sameProject(l.project, c.project));
          if (!sameProj.length) {
            status = "project_differs";
            note = `MPR is under ${[...new Set(sameItem.map((c) => c.project))].join(", ")}`;
          } else {
            matched = sameProj.filter((c) => sameSpec(l.brand, c.spec));
            if (!matched.length) {
              status = "spec_differs";
              note = `MPR specification: ${[...new Set(sameProj.map((c) => c.spec))].join(", ")}`;
            }
          }
        }
      }
      return {
        ...l,
        status,
        note,
        entries: matched.map((c) => ({ id: c.id, project: c.project, mprNo: c.mprNo, item: c.item, spec: c.spec, qty: c.qty, unit: c.unit, already: existing.has(`${c.id}|${l.poNo.toLowerCase()}`) }))
      };
    });
  }

  const readLines = (req: any): PoLineIn[] => {
    const raw = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (raw.length > 20000) throw Object.assign(new Error("The sheet has too many lines (20,000 at most)."), { status: 400 });
    // Carrying / loading / discount lines carry no MPR No.
    return raw.map(cleanLine).filter((l: PoLineIn) => l.mrfNo && l.material);
  };

  app.post("/api/mpr-po/preview", ...gate, async (req: any, res) => {
    try {
      const results = await check(readLines(req));
      res.json({ results });
    } catch (err: any) {
      res.status(Number(err?.status) || 500).json({ error: err.message });
    }
  });

  app.post("/api/mpr-po/import", ...gate, async (req: any, res) => {
    try {
      const results = await check(readLines(req));
      const ok = results.filter((r) => r.status === "matched");
      // The same MPR row + P.O on two sheet lines: their quantities add up.
      const merged = new Map<string, { entryId: number; l: (typeof ok)[number]; orderQty: number | null; appQty: number | null; amount: number | null; receivedQty: number | null }>();
      const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a || 0) + (b || 0));
      for (const r of ok)
        for (const e of r.entries) {
          const k = `${e.id}|${r.poNo.toLowerCase()}`;
          const m = merged.get(k);
          if (!m) merged.set(k, { entryId: e.id, l: r, orderQty: r.orderQty, appQty: r.appQty, amount: r.amount, receivedQty: r.receivedQty });
          else Object.assign(m, { orderQty: add(m.orderQty, r.orderQty), appQty: add(m.appQty, r.appQty), amount: add(m.amount, r.amount), receivedQty: add(m.receivedQty, r.receivedQty) });
        }
      const already = new Set(ok.flatMap((r) => r.entries.filter((e) => e.already).map((e) => `${e.id}|${r.poNo.toLowerCase()}`)));
      const ins: any = await queryDB(
        "INSERT INTO mpr_po_imports (file_name, total_lines, matched_lines, new_pos, updated_pos, unmatched_lines, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [str(req.body?.fileName, 255) || null, results.length, ok.length, [...merged.keys()].filter((k) => !already.has(k)).length, [...merged.keys()].filter((k) => already.has(k)).length, results.length - ok.length, req.user.id]
      );
      const importId = Number(ins?.insertId) || null;
      for (const m of merged.values()) {
        const l = m.l;
        await queryDB(
          `INSERT INTO mpr_po_lines (entry_id, po_no, po_date, req_no, app_no, supplier, brand, unit, order_qty, app_qty, rate, amount, received_qty, import_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE po_date = VALUES(po_date), req_no = VALUES(req_no), app_no = VALUES(app_no), supplier = VALUES(supplier), brand = VALUES(brand),
             unit = VALUES(unit), order_qty = VALUES(order_qty), app_qty = VALUES(app_qty), rate = VALUES(rate), amount = VALUES(amount),
             received_qty = VALUES(received_qty), import_id = VALUES(import_id)`,
          [m.entryId, l.poNo, poDate(l.poDate), l.reqNo || null, l.appNo || null, l.supplier || null, l.brand || null, l.unit || null, m.orderQty, m.appQty, l.rate, m.amount, m.receivedQty, importId, req.user.id]
        );
      }
      res.json({
        importId,
        matchedLines: ok.length,
        newPos: [...merged.keys()].filter((k) => !already.has(k)).length,
        updatedPos: [...merged.keys()].filter((k) => already.has(k)).length,
        unmatched: results.length - ok.length
      });
    } catch (err: any) {
      res.status(Number(err?.status) || 500).json({ error: err.message });
    }
  });

  app.get("/api/mpr-po/imports", ...gate, async (_req: any, res) => {
    try {
      const rows: any[] =
        (await queryDB(
          `SELECT i.*, u.name AS created_by_name FROM mpr_po_imports i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.id DESC LIMIT 50`
        )) || [];
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

const dateOnly = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
};

// The P.O lines of these MPR rows (for the Dispatch Material / report pages).
export async function poLinesFor(queryDB: QueryDB, entryIds: number[]): Promise<Map<number, any[]>> {
  const out = new Map<number, any[]>();
  for (let i = 0; i < entryIds.length; i += 500) {
    const part = entryIds.slice(i, i + 500);
    if (!part.length) continue;
    const rows: any[] =
      (await queryDB(
        `SELECT entry_id, po_no, po_date, supplier, order_qty, rate, amount, received_qty FROM mpr_po_lines WHERE entry_id IN (${part.map(() => "?").join(",")}) ORDER BY po_date ASC, id ASC`,
        part
      ).catch(() => [])) || [];
    for (const r of rows) {
      const list = out.get(Number(r.entry_id)) || [];
      list.push({
        poNo: r.po_no,
        poDate: dateOnly(r.po_date),
        supplier: r.supplier || "",
        orderQty: r.order_qty === null ? null : Number(r.order_qty),
        rate: r.rate === null ? null : Number(r.rate),
        amount: r.amount === null ? null : Number(r.amount),
        receivedQty: r.received_qty === null ? null : Number(r.received_qty)
      });
      out.set(Number(r.entry_id), list);
    }
  }
  return out;
}
