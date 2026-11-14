/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employees -> Directory filters (and the same filters on its Export): narrow
// the list by Designation, Branch, Head Office / Project, Job Status,
// Category, Job Base, Gender, Blood Group, login, joining date and "missing"
// details. Only filters what the account can already see in the Employees
// module — the rows are the same scoped all_employees rows — so nothing new
// is shown; the options are built from those rows too.

type Query = (sql: string, params?: any[]) => Promise<any>;

export type PlaceKind = "Head Office" | "Project" | "Not set";

export const norm = (v: any) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Plain text columns that filter by exact value (case-insensitive).
export const EMPLOYEE_VALUE_FILTERS = [
  { key: "designation", label: "Designation" },
  { key: "division", label: "Division" },
  { key: "unit", label: "Unit" },
  { key: "job_status", label: "Job Status" },
  { key: "employment_category", label: "Employment Category" },
  { key: "job_base", label: "Job Base" },
  { key: "gender", label: "Gender" },
  { key: "blood_group", label: "Blood Group" },
  { key: "religion", label: "Religion" }
] as const;

// "Missing …" — details HR still has to fill.
export const EMPLOYEE_MISSING_FILTERS: Record<string, { label: string; empty: (e: any) => boolean }> = {
  phone: { label: "Phone", empty: (e) => !String(e.phone || e.mobile || "").trim() },
  email: { label: "Email", empty: (e) => !String(e.email || "").trim() },
  nid: { label: "NID", empty: (e) => !String(e.nid_ssn || "").trim() },
  dob: { label: "Date of Birth", empty: (e) => !e.date_of_birth },
  joining: { label: "Joining Date", empty: (e) => !e.joining_date },
  department: { label: "Department", empty: (e) => !String(e.department || "").trim() },
  designation: { label: "Designation", empty: (e) => !String(e.designation || "").trim() },
  branch: { label: "Branch", empty: (e) => !String(e.branch || "").trim() && !e.branch_id },
  pin: { label: "Device PIN", empty: (e) => !String(e.zk_device_pin ?? "").trim() },
  blood: { label: "Blood Group", empty: (e) => !String(e.blood_group || "").trim() }
};

export interface BranchIndex {
  byId: Map<number, any>;
  byName: Map<string, any>;
}

export async function loadBranchIndex(queryDB: Query): Promise<BranchIndex> {
  const branches: any[] = (await queryDB("SELECT id, branch_name, branch_type FROM branches").catch(() => [])) || [];
  return {
    byId: new Map(branches.map((b: any) => [Number(b.id), b])),
    byName: new Map(branches.map((b: any) => [norm(b.branch_name), b]))
  };
}

// Head Office / Project from the Branch's type (Admin Panel -> Branches); an
// imported Branch that isn't in Branches falls back to its Division text.
export function placeOf(e: any, idx: BranchIndex): { kind: PlaceKind; branch: string } {
  const b = (e.branch_id && idx.byId.get(Number(e.branch_id))) || (e.branch ? idx.byName.get(norm(e.branch)) : null);
  const div = norm(e.division);
  const kind: PlaceKind = b
    ? b.branch_type === "project_site"
      ? "Project"
      : "Head Office"
    : /project|site/.test(div)
      ? "Project"
      : /head|corporate|office/.test(div)
        ? "Head Office"
        : "Not set";
  return { kind, branch: (b?.branch_name || e.branch || "").trim() };
}

export interface EmployeeFilter {
  values: Record<string, string>;
  branch: string;
  place: string;
  login: string;
  joinedFrom: string;
  joinedTo: string;
  missing: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readEmployeeFilter(q: any): EmployeeFilter {
  const s = (k: string) => String(q?.[k] ?? "").trim();
  const values: Record<string, string> = {};
  for (const f of EMPLOYEE_VALUE_FILTERS) if (s(f.key)) values[f.key] = s(f.key);
  return {
    values,
    branch: s("branch"),
    place: ["head_office", "project", "not_set"].includes(s("place")) ? s("place") : "",
    login: ["yes", "no"].includes(s("login")) ? s("login") : "",
    joinedFrom: DAY.test(s("joined_from")) ? s("joined_from") : "",
    joinedTo: DAY.test(s("joined_to")) ? s("joined_to") : "",
    missing: EMPLOYEE_MISSING_FILTERS[s("missing")] ? s("missing") : ""
  };
}

export const hasEmployeeFilter = (f: EmployeeFilter) =>
  !!(Object.keys(f.values).length || f.branch || f.place || f.login || f.joinedFrom || f.joinedTo || f.missing);

const PLACE_KEY: Record<PlaceKind, string> = { "Head Office": "head_office", Project: "project", "Not set": "not_set" };

export function employeeMatches(e: any, f: EmployeeFilter, idx: BranchIndex): boolean {
  for (const [k, v] of Object.entries(f.values)) {
    if (v === "__none__" ? String(e[k] || "").trim() !== "" : norm(e[k]) !== norm(v)) return false;
  }
  if (f.branch || f.place) {
    const p = placeOf(e, idx);
    if (f.branch && (f.branch === "__none__" ? p.branch !== "" : norm(p.branch) !== norm(f.branch))) return false;
    if (f.place && PLACE_KEY[p.kind] !== f.place) return false;
  }
  if (f.login === "yes" && !e.user_id) return false;
  if (f.login === "no" && e.user_id) return false;
  if (f.joinedFrom || f.joinedTo) {
    const j = e.joining_date ? String(e.joining_date instanceof Date ? e.joining_date.toISOString() : e.joining_date).slice(0, 10) : "";
    if (!j) return false;
    if (f.joinedFrom && j < f.joinedFrom) return false;
    if (f.joinedTo && j > f.joinedTo) return false;
  }
  if (f.missing && !EMPLOYEE_MISSING_FILTERS[f.missing].empty(e)) return false;
  return true;
}

// The choices for each filter, with how many of these rows have each value.
export function employeeFilterOptions(rows: any[], idx: BranchIndex) {
  const count = (vals: string[]) => {
    const m = new Map<string, { value: string; count: number }>();
    for (const raw of vals) {
      const v = raw.trim();
      if (!v) continue;
      const k = norm(v);
      const cur = m.get(k);
      if (cur) cur.count++;
      else m.set(k, { value: v, count: 1 });
    }
    return [...m.values()].sort((a, b) => a.value.localeCompare(b.value));
  };
  const out: Record<string, { value: string; count: number }[]> = {};
  for (const f of EMPLOYEE_VALUE_FILTERS) out[f.key] = count(rows.map((e) => String(e[f.key] ?? "")));
  out.branch = count(rows.map((e) => placeOf(e, idx).branch));
  return {
    ...out,
    missing: Object.entries(EMPLOYEE_MISSING_FILTERS).map(([value, m]) => ({ value, label: m.label }))
  };
}
