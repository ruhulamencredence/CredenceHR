/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employees -> "Office / Project & Branch" and "Export" — also in HR
// Operations. How many employees work at each place: first split by Head
// Office / Project (the Branch's type in Admin Panel -> Branches), then by
// Duty Location / Branch, each with its people. Export gives every Employee
// Details column in the same layout as HR Data Import -> Employee Details, so
// the file can be corrected and imported back (no logins, passwords or bank
// accounts in it).
//
// Two doors, each with its own layers:
//   Employees module      -> "emp_headcount" (view) / "emp_export" (explicit)
//   HR Operations module  -> "hr_headcount"  (view) / "hr_emp_export" (explicit)
// Who appears follows the account's usual Department / company scope (the
// strict query scope set by requireModule).

import type { Express } from "express";
import { IMPORT_KINDS } from "./DataImportRoutes";
import { employeeMatches, loadBranchIndex, norm, placeOf, readEmployeeFilter, type PlaceKind } from "./EmployeeFilters";

type Query = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (key: any) => any;
  requireModuleLayer: (key: any, layer: string) => any;
  queryDB: Query;
}

export type { PlaceKind } from "./EmployeeFilters";

// Columns of the export: Employee Details' import columns up to "Active".
const EXPORT_FIELDS = (() => {
  const fields = IMPORT_KINDS.find((k) => k.key === "employees")?.fields || [];
  const stop = fields.findIndex((f) => f.key === "login_id");
  return (stop > 0 ? fields.slice(0, stop) : fields).map((f) => ({ key: f.key, label: f.label, type: f.type }));
})();

export function registerEmployeeHeadcountRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB } = deps;

  // Export also takes the Directory's filters (EmployeeFilters.ts).
  async function load(q: any) {
    const [emps, idx]: any[] = await Promise.all([queryDB("SELECT * FROM all_employees ORDER BY name"), loadBranchIndex(queryDB)]);
    const status = q.status === "inactive" ? "inactive" : q.status === "all" ? "all" : "active";
    const dept = norm(q.department);
    const f = readEmployeeFilter(q);
    return (emps || [])
      .filter((e: any) => (status === "all" ? true : status === "active" ? Number(e.is_active ?? 1) !== 0 : Number(e.is_active ?? 1) === 0))
      .filter((e: any) => !dept || (dept === "__none__" ? !norm(e.department) : norm(e.department) === dept))
      .filter((e: any) => employeeMatches(e, f, idx))
      .filter((e: any) => {
        const t = norm(q.q);
        return !t || [e.name, e.employee_id, e.designation, e.department, e.branch, e.email, e.phone].some((v) => norm(v).includes(t));
      })
      .map((e: any) => {
        const p = placeOf(e, idx);
        return { e, kind: p.kind, branch: p.branch || "No branch" };
      });
  }

  const headcount = async (req: any, res: any) => {
    try {
      const rows = await load(req.query || {});
      const kinds = new Map<string, Map<string, any[]>>();
      for (const r of rows) {
        if (!kinds.has(r.kind)) kinds.set(r.kind, new Map());
        const m = kinds.get(r.kind)!;
        if (!m.has(r.branch)) m.set(r.branch, []);
        m.get(r.branch)!.push({
          id: Number(r.e.id),
          employee_id: r.e.employee_id || "",
          name: r.e.name,
          designation: r.e.designation || "",
          department: r.e.department || "",
          phone: r.e.phone || r.e.mobile || "",
          joining_date: r.e.joining_date || null,
          active: Number(r.e.is_active ?? 1) !== 0
        });
      }
      const order: PlaceKind[] = ["Head Office", "Project", "Not set"];
      const groups = order
        .filter((k) => kinds.has(k))
        .map((k) => {
          const branches = [...kinds.get(k)!.entries()]
            .map(([branch, people]) => ({ branch, count: people.length, people }))
            .sort((a, b) => b.count - a.count || a.branch.localeCompare(b.branch));
          return { kind: k, count: branches.reduce((s, b) => s + b.count, 0), branches };
        });
      const departments = Array.from(new Set(rows.map((r: any) => String(r.e.department || "").trim()).filter(Boolean))).sort();
      res.json({ total: rows.length, groups, departments });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  const exportRows = async (req: any, res: any) => {
    try {
      const rows = await load(req.query || {});
      const cell = (e: any, f: { key: string; type: string }) => {
        const v = e[f.key];
        if (f.type === "yesno") return Number(v ?? 1) !== 0 ? "Yes" : "No";
        if (f.type === "date") return v ? String(v).slice(0, 10) : "";
        return v == null ? "" : String(v);
      };
      res.json({
        columns: [...EXPORT_FIELDS.map((f) => f.label), "Office / Project"],
        rows: rows.map((r: any) => [...EXPORT_FIELDS.map((f) => cell(r.e, f)), r.kind])
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  const emp = [authenticateToken, requireAdmin, requireModule("employees")];
  const hr = [authenticateToken, requireAdmin, requireModule("hr_operations")];
  app.get("/api/employees/headcount", ...emp, requireModuleLayer("employees", "emp_headcount"), headcount);
  app.get("/api/employees/export", ...emp, requireModuleLayer("employees", "emp_export"), exportRows);
  app.get("/api/hr-ops/headcount", ...hr, requireModuleLayer("hr_operations", "hr_headcount"), headcount);
  app.get("/api/hr-ops/employee-export", ...hr, requireModuleLayer("hr_operations", "hr_emp_export"), exportRows);
}
