/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Details" of any request an approver is asked to decide — so whoever
// approves can see exactly what they approve, from wherever they are:
// Self Service -> Approve Application (pending and history), the Dashboard's
// Pending Approvals card, the approvals bell, Admin Panel -> Approvals.
//
//   GET /api/approval-details?type=<source_type>&id=<source_id>
//     -> { type, type_label, title, status, submitted_at, requester, fields,
//          table, attachments, locations, timeline }
//   GET /api/approval-details/file?type=&id=   the request's attachment
//
// Who may open one: the person who asked; anyone in its approval chain —
// past, current or still to come (Supervisor, Head, Template Layer,
// old global chain step, ad-hoc approver and who asked them in, anyone who
// already acted); the Reliever / direct Approver of a Leave Application;
// the approvers of an Exit's clearance items; an Admin with the Approvals
// module (who sees every request there); the Superadmin. Nobody else.
//
// HR Actions and Exits are decided ABOUT someone, not asked for by them:
//   - the employee never opens an HR Action about them (a separation,
//     demotion or increment HR is still deciding), nor an Exit HR opened for
//     them (a termination) — only a resignation they asked for themselves;
//   - the Approvals module alone doesn't open them (it never listed them):
//     an HR Action needs HR Operations, an Exit needs Exit / Offboarding,
//     besides the people in its own chain;
//   - an account with the module where that kind of request is worked on
//     (Bill Claim, Attendance, Monthly Leave Application, Asset Management,
//     Vehicle Management, Mobile Bill, Payroll for loans / advances, Claims):
//     it already lists them there (MODULE_FOR_TYPE);
//   - salary in an HR Action ("Now -> Becomes") is shown only to the
//     Superadmin, whoever raised it, its approvers, and accounts with
//     Payroll's "See salary amounts"; everyone else gets "*****".

import type { Express } from "express";

type Q = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  queryDB: Q;
  getAdminModules: (userId: number) => Promise<string[]>;
  getApprovalChain: () => Promise<any[]>;
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
  toDateOnlyString: (value: any) => string | null;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
}

const SALARY_KEY = /salary|basic|gross|house_rent|medical|conveyance|allowance|pf_|_pf|tax|increment|amount|pay/i;
const MASK = "*****";

const TYPE_LABEL: Record<string, string> = {
  bill_claim: "Bill Claim",
  attendance_correction: "Attendance Correction",
  leave_application: "Leave Application",
  leave_reliever: "Leave Application (you are the Reliever)",
  leave_direct: "Leave Application",
  asset_requisition: "Asset Requisition",
  vehicle_requisition: "Vehicle Requisition",
  mobile_limit_request: "Mobile Bill Limit",
  advance_request: "Loan / Salary Advance",
  attendance: "Check In / Check Out",
  claim: "Movement (Check In/Out)",
  hr_action: "HR Action",
  exit_clearance: "Exit Clearance"
};

// Which table the attachment of a type lives in (data / name / mime columns).
const FILES: Record<string, { table: string; data: string; name: string; mime: string }> = {
  bill_claim: { table: "bill_claims", data: "file_data", name: "file_name", mime: "file_mimetype" },
  attendance_correction: { table: "attendance_corrections", data: "file_data", name: "file_name", mime: "file_mimetype" },
  asset_requisition: { table: "asset_requisitions", data: "attachment_data", name: "attachment_filename", mime: "attachment_mimetype" }
};

const parse = (v: any, fb: any) => {
  if (v == null || v === "") return fb;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fb;
  }
};
const money = (v: any) => (v == null || v === "" ? null : `৳${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const yesNo = (v: any) => (Number(v) ? "Yes" : null);
const leaveTypeLabel = (t: string) =>
  ({ casual: "Casual", sick: "Sick", lwp: "Leave Without Pay", earned: "Earned", maternity: "Maternity", paternity: "Paternity" } as Record<string, string>)[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, " ") : "Leave");

export function registerApprovalDetailsRoutes(app: Express, deps: Deps) {
  const { authenticateToken, queryDB, getAdminModules, getApprovalChain, getCurrentStepApprovers, toDateOnlyString, hasModuleLayer } = deps;
  const d = (v: any) => (v ? toDateOnlyString(v) : null);
  const dt = (v: any) => {
    if (!v) return null;
    const x = new Date(v);
    return isNaN(x.getTime()) ? String(v) : x.toISOString();
  };
  const one = async (sql: string, params: any[]) => ((await queryDB(sql, params).catch(() => [])) as any[])[0] || null;
  const nameOf = async (id: any) => (id ? (await one("SELECT name FROM users WHERE id = ?", [Number(id)]))?.name || null : null);

  // The approval_requests row behind a request (the newest, for a resubmitted one).
  const requestRowFor = (type: string, id: number) =>
    type === "leave_reliever" || type === "leave_direct" || type === "hr_action" || type === "exit_clearance"
      ? Promise.resolve(type === "leave_reliever" || type === "leave_direct" ? one("SELECT * FROM approval_requests WHERE source_type = 'leave_application' AND source_id = ? ORDER BY id DESC LIMIT 1", [id]) : null)
      : one("SELECT * FROM approval_requests WHERE source_type = ? AND source_id = ? ORDER BY id DESC LIMIT 1", [type, id]);

  // The underlying record, its owner (user id) and a few ids the checks need.
  async function loadSource(type: string, id: number): Promise<{ row: any; ownerUserId: number | null } | null> {
    const t = type === "leave_reliever" || type === "leave_direct" ? "leave_application" : type;
    switch (t) {
      case "bill_claim": {
        const r = await one("SELECT * FROM bill_claims WHERE id = ?", [id]);
        return r && { row: r, ownerUserId: Number(r.user_id) };
      }
      case "attendance_correction": {
        const r = await one("SELECT * FROM attendance_corrections WHERE id = ?", [id]);
        return r && { row: r, ownerUserId: Number(r.user_id) };
      }
      case "leave_application": {
        const r = await one("SELECT * FROM leave_applications WHERE id = ?", [id]);
        return r && { row: r, ownerUserId: Number(r.user_id) };
      }
      case "asset_requisition": {
        const r = await one("SELECT * FROM asset_requisitions WHERE id = ?", [id]);
        return r && { row: r, ownerUserId: Number(r.employee_user_id) };
      }
      case "vehicle_requisition": {
        const r = await one("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
        return r && { row: r, ownerUserId: Number(r.employee_user_id) };
      }
      case "mobile_limit_request": {
        const r = await one("SELECT r.*, s.phone_number FROM mobile_limit_requests r LEFT JOIN mobile_sims s ON s.id = r.sim_id WHERE r.id = ?", [id]);
        return r && { row: r, ownerUserId: Number(r.user_id) };
      }
      case "advance_request": {
        const r = await one("SELECT a.*, e.user_id AS emp_user_id FROM advance_requests a LEFT JOIN all_employees e ON e.id = a.employee_id WHERE a.id = ?", [id]);
        return r && { row: r, ownerUserId: r.emp_user_id ? Number(r.emp_user_id) : Number(r.requested_by) || null };
      }
      case "attendance": {
        const r = await one("SELECT * FROM attendance WHERE id = ?", [id]);
        return r && { row: r, ownerUserId: Number(r.user_id) };
      }
      case "claim": {
        const r = await one("SELECT * FROM claims WHERE id = ?", [id]);
        return r && { row: r, ownerUserId: Number(r.user_id) };
      }
      case "hr_action": {
        const r = await one("SELECT h.*, e.user_id AS emp_user_id FROM hr_actions h LEFT JOIN all_employees e ON e.id = h.employee_id WHERE h.id = ?", [id]);
        return r && { row: r, ownerUserId: r.emp_user_id ? Number(r.emp_user_id) : null };
      }
      case "exit_clearance": {
        // id is the clearance item (what the approver's queue lists).
        const ci = await one("SELECT * FROM exit_clearance_items WHERE id = ?", [id]);
        if (!ci) return null;
        const er = await one("SELECT * FROM exit_requests WHERE id = ?", [Number(ci.exit_id)]);
        return er && { row: { ...er, clearance_item: ci }, ownerUserId: Number(er.user_id) };
      }
    }
    return null;
  }

  // Everyone in an HR Action's own chain: its approvers and whoever acted.
  function hrActionPeople(row: any): Set<number> {
    const ids = new Set<number>();
    for (const st of parse(row.chain_json, [])) for (const x of st?.approver_ids || []) ids.add(Number(x));
    for (const h of parse(row.history_json, [])) if (h?.by != null) ids.add(Number(h.by));
    return ids;
  }

  const MODULE_FOR_TYPE: Record<string, string> = {
    bill_claim: "bill_claim",
    attendance_correction: "attendance",
    attendance: "attendance",
    leave_application: "leave_applications",
    leave_reliever: "leave_applications",
    leave_direct: "leave_applications",
    asset_requisition: "asset_management",
    vehicle_requisition: "vehicle_management",
    mobile_limit_request: "mobile_bill",
    advance_request: "payroll",
    claim: "claims"
  };

  async function mayOpen(user: any, type: string, id: number, src: { row: any; ownerUserId: number | null }, reqRow: any): Promise<boolean> {
    const me = Number(user.id);
    if (user.role === "superadmin") return true;
    const modules = user.role === "admin" || user.role === "user" ? await getAdminModules(me).catch(() => [] as string[]) : [];
    if (type === "hr_action") {
      // Never the employee it is about (unless they raised it themselves).
      if (Number(src.row.created_by) === me) return true;
      if (hrActionPeople(src.row).has(me)) return true;
      return modules.includes("hr_operations");
    }
    if (type === "exit_clearance") {
      // The employee: only a resignation they asked for (not one HR opened).
      const ownAsk = src.row.exit_type === "resignation" && (src.row.requested_by == null || Number(src.row.requested_by) === src.ownerUserId);
      if (src.ownerUserId === me && ownAsk) return true;
      if (Number(src.row.requested_by) === me) return true;
      const items: any[] = (await queryDB("SELECT approver_user_id, cleared_by FROM exit_clearance_items WHERE exit_id = ?", [Number(src.row.id)]).catch(() => [])) || [];
      if (items.some((i) => Number(i.approver_user_id) === me || Number(i.cleared_by) === me)) return true;
      return modules.includes("exit_offboarding");
    }
    if (src.ownerUserId === me) return true;
    if (modules.includes("approvals")) return true;
    // Whoever works on this kind of request in its own module already sees it
    // there (e.g. Payroll lists every advance waiting, Asset Management every
    // requisition), so the Admin Dashboard's waiting lists can show its
    // details to them too.
    const owner = MODULE_FOR_TYPE[type];
    if (owner && modules.includes(owner)) return true;
    if (type === "leave_application" || type === "leave_reliever" || type === "leave_direct") {
      if (Number(src.row.reliever_id) === me || Number(src.row.approver_id) === me || Number(src.row.decided_by) === me) return true;
    }
    // Every approval_requests row for it (a resubmitted request has several).
    const sourceType = type === "leave_reliever" || type === "leave_direct" ? "leave_application" : type;
    const rows: any[] = reqRow ? ((await queryDB("SELECT * FROM approval_requests WHERE source_type = ? AND source_id = ?", [sourceType, id]).catch(() => [reqRow])) as any[]) : [];
    for (const r of rows) {
      if ([r.requested_by, r.supervisor_step_user_id, r.head_step_user_id, r.adhoc_approver_id, r.adhoc_added_by].some((x) => Number(x) === me)) return true;
      if (parse(r.actions_json, []).some((a: any) => Number(a.approver_id) === me || Number(a.user_id) === me)) return true;
      if (r.template_id) {
        const hit = await one(
          `SELECT 1 AS ok FROM approval_template_step_approvers sa JOIN approval_template_steps s ON s.id = sa.step_id WHERE s.template_id = ? AND sa.user_id = ? LIMIT 1`,
          [Number(r.template_id), me]
        );
        if (hit) return true;
      } else {
        const chain = await getApprovalChain().catch(() => [] as any[]);
        if (chain.some((s: any) => Number(s.user_id) === me)) return true;
      }
    }
    return false;
  }

  async function requester(userId: number | null) {
    if (!userId) return null;
    const u = await one("SELECT id, name, email FROM users WHERE id = ?", [userId]);
    const e = await one("SELECT employee_id, designation, department, branch FROM all_employees WHERE user_id = ? LIMIT 1", [userId]);
    return { name: u?.name || null, employee_id: e?.employee_id || null, designation: e?.designation || null, department: e?.department || null, branch: e?.branch || null };
  }

  async function timeline(reqRow: any) {
    if (!reqRow) return null;
    const actions = parse(reqRow.actions_json, []);
    const steps: any[] = [];
    for (const a of actions) {
      steps.push({
        step: Number(a.step_order) || null,
        who: a.approver_name || (await nameOf(a.approver_id || a.user_id)) || null,
        action: a.action || null,
        note: a.remarks || a.comment || a.note || null,
        at: a.acted_at || a.at || null
      });
    }
    let waiting: string[] = [];
    if (reqRow.status === "pending") {
      try {
        waiting = (await getCurrentStepApprovers(reqRow)).map((x) => x.user_name || `User #${x.user_id}`);
      } catch {
        waiting = [];
      }
      if (!waiting.length && (Number(reqRow.awaiting_approver) === 1 || reqRow.stuck_since)) waiting = ["the Superadmin (no approver set yet)"];
    }
    return { status: reqRow.status, current_step: Number(reqRow.current_step) || null, total_steps: Number(reqRow.total_steps) || null, steps, waiting_on: waiting };
  }

  // Field list per type: [label, value] pairs (empty values are dropped).
  async function describe(type: string, src: { row: any }, seesSalary = true) {
    const r = src.row;
    const F = (pairs: [string, any][]) => pairs.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "").map(([label, value]) => ({ label, value: String(value) }));
    let title = TYPE_LABEL[type] || type;
    let fields: { label: string; value: string }[] = [];
    let table: { columns: string[]; rows: string[][] } | null = null;
    let attachments: { label: string }[] = [];
    let locations: { label: string; lat: number; lng: number; place?: string | null }[] = [];
    const t = type === "leave_reliever" || type === "leave_direct" ? "leave_application" : type;
    const loc = (label: string, lat: any, lng: any, place?: any) => {
      if (lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) locations.push({ label, lat: Number(lat), lng: Number(lng), place: place || null });
    };
    const projectName = async (pid: any) => (pid ? (await one("SELECT project_name FROM projects WHERE id = ?", [Number(pid)]))?.project_name || null : null);

    if (t === "bill_claim") {
      title = `${r.category || "Bill"} claim — ${money(r.amount) || ""}`;
      fields = F([
        ["Category", r.category],
        ["Claim date", d(r.claim_date)],
        ["Period", r.from_date || r.to_date ? `${d(r.from_date) || "—"} to ${d(r.to_date) || "—"}` : null],
        ["Amount claimed", money(r.amount)],
        ["Approved amount (so far)", r.approved_amount != null && Number(r.approved_amount) !== Number(r.amount) ? money(r.approved_amount) : null],
        ["Description", r.description],
        ["Filed by", r.filed_by && Number(r.filed_by) !== Number(r.user_id) ? await nameOf(r.filed_by) : null],
        ["Returned for edit", r.return_reason],
        ["Version", Number(r.version) > 1 ? `Resubmitted (v${r.version})` : null],
        ["Status", r.status]
      ]);
      const items: any[] = (await queryDB("SELECT * FROM bill_claim_items WHERE bill_claim_id = ? ORDER BY bill_date, id", [Number(r.id)]).catch(() => [])) || [];
      if (items.length) table = { columns: ["Date", "Category", "Description", "Amount"], rows: items.map((i) => [d(i.bill_date) || "—", i.category_name || "—", i.description || "—", money(i.amount) || "—"]) };
      if (r.file_name) attachments = [{ label: r.file_name }];
    } else if (t === "attendance_correction") {
      const proj = await projectName(r.project_id);
      title = `Attendance correction — ${d(r.attendance_date)}`;
      fields = F([
        ["Date", d(r.attendance_date)],
        ["Project", proj],
        ["Asked check in", r.requested_check_in_at ? dt(r.requested_check_in_at) : null],
        ["Asked check out", r.requested_check_out_at ? dt(r.requested_check_out_at) : null],
        ["Check in was off site", yesNo(r.offsite_in)],
        ["Check out was off site", yesNo(r.offsite_out)],
        ["Check in place", r.in_place],
        ["Check in distance", r.in_distance_m != null ? `${Math.round(Number(r.in_distance_m))} m from the project` : null],
        ["Check out place", r.out_place],
        ["Check out distance", r.out_distance_m != null ? `${Math.round(Number(r.out_distance_m))} m from the project` : null],
        ["Reason", r.remarks],
        ["Status", r.status]
      ]);
      loc("Check in", r.in_lat, r.in_lng, r.in_place);
      loc("Check out", r.out_lat, r.out_lng, r.out_place);
      if (r.file_name) attachments = [{ label: r.file_name }];
    } else if (t === "leave_application") {
      title = `${leaveTypeLabel(r.leave_type)} leave — ${Number(r.day_count)} day${Number(r.day_count) === 1 ? "" : "s"}`;
      fields = F([
        ["Leave type", leaveTypeLabel(r.leave_type)],
        ["From", d(r.start_date)],
        ["To", d(r.end_date)],
        ["Days", r.day_count != null ? String(Number(r.day_count)) : null],
        ["Half day", yesNo(r.is_half_day)],
        ["Continuous", yesNo(r.is_continuous)],
        ["Prefix / suffix holidays", Number(r.is_prefix) || Number(r.is_suffix) ? [Number(r.is_prefix) ? "Prefix" : "", Number(r.is_suffix) ? "Suffix" : ""].filter(Boolean).join(", ") : null],
        ["Abroad", yesNo(r.is_foreign_leave)],
        ["Purpose", r.purpose],
        ["Applied on", d(r.apply_date || r.created_at)],
        ["Reliever", r.reliever_id ? `${(await nameOf(r.reliever_id)) || "—"}${r.reliever_status ? ` (${r.reliever_status})` : ""}` : null],
        ["Reliever's note", r.reliever_remarks],
        ["Remarks", r.remarks],
        ["Status", r.status]
      ]);
      // Leave already taken this year of the same type — helps the decision.
      const year = String(d(r.start_date) || "").slice(0, 4);
      if (year) {
        const taken = await one(
          "SELECT COALESCE(SUM(day_count), 0) AS n FROM leave_applications WHERE user_id = ? AND leave_type = ? AND status = 'approved' AND YEAR(start_date) = ? AND id <> ?",
          [Number(r.user_id), r.leave_type, Number(year), Number(r.id)]
        );
        if (taken) fields.push({ label: `Approved ${leaveTypeLabel(r.leave_type)} leave in ${year} (before this)`, value: `${Number(taken.n)} day${Number(taken.n) === 1 ? "" : "s"}` });
      }
    } else if (t === "asset_requisition") {
      title = `Asset requisition — ${r.asset_category || ""}`;
      fields = F([
        ["Category", r.asset_category],
        ["Urgency", r.urgency],
        ["Needed by", d(r.target_date)],
        ["Reason", r.reason],
        ["Supervisor's note", r.manager_remarks],
        ["Status", r.status]
      ]);
      const items: any[] = (await queryDB("SELECT * FROM asset_requisition_items WHERE requisition_id = ? AND removed_at IS NULL ORDER BY id", [Number(r.id)]).catch(() => [])) || [];
      if (items.length) table = { columns: ["Item", "Purpose", "Qty"], rows: items.map((i) => [i.item_name || "—", i.purpose || "—", `${Number(i.quantity)}${i.unit ? " " + i.unit : ""}`]) };
      if (r.attachment_filename) attachments = [{ label: r.attachment_filename }];
    } else if (t === "vehicle_requisition") {
      title = `Vehicle — ${r.pickup_location || ""} → ${r.destination || ""}`;
      const veh = r.assigned_vehicle_id ? await one("SELECT * FROM vehicles WHERE id = ?", [Number(r.assigned_vehicle_id)]) : null;
      fields = F([
        ["Purpose", r.purpose],
        ["From", r.pickup_location],
        ["To", r.destination],
        ["Date", d(r.ride_date)],
        ["Start time", r.start_time],
        ["Estimated time", r.estimated_duration_hours != null ? `${Number(r.estimated_duration_hours)} h` : null],
        ["Expected back", r.expected_return_at ? dt(r.expected_return_at) : null],
        ["Self drive", yesNo(r.self_drive)],
        ["Vehicle", veh ? [veh.vehicle_no, veh.model, veh.vehicle_type].filter(Boolean).join(" · ") : null],
        ["Driver", r.driver_name ? `${r.driver_name}${r.driver_mobile ? " · " + r.driver_mobile : ""}` : null],
        ["Status", r.status]
      ]);
      loc("Destination", r.destination_lat, r.destination_lng, r.destination);
    } else if (t === "mobile_limit_request") {
      title = `Mobile bill limit — ${money(r.requested_limit) || ""}`;
      fields = F([
        ["SIM", r.phone_number],
        ["Current limit", money(r.current_limit)],
        ["Asked limit", money(r.requested_limit)],
        ["For", r.scope === "permanent" ? `From ${r.for_month || "now"} on` : `Only ${r.for_month || "this month"}`],
        ["Reason", r.reason],
        ["Status", r.status]
      ]);
    } else if (t === "advance_request") {
      title = `${r.request_kind === "advance" ? "Salary advance" : "Loan"} — ${money(r.total_amount) || ""}`;
      const emp = r.employee_id ? await one("SELECT name, employee_id FROM all_employees WHERE id = ?", [Number(r.employee_id)]) : null;
      fields = F([
        ["For employee", emp ? `${emp.name}${emp.employee_id ? " · " + emp.employee_id : ""}` : null],
        ["Kind", r.request_kind === "advance" ? "Salary advance" : "Loan"],
        ["Amount", money(r.total_amount)],
        ["Monthly installment", money(r.monthly_installment)],
        ["Installments", r.installments],
        ["Start month", r.preferred_start_month],
        ["Reason", r.reason],
        ["Status", r.status]
      ]);
      const open = await one("SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS amt FROM advance_requests WHERE employee_id = ? AND status = 'approved' AND id <> ?", [Number(r.employee_id), Number(r.id)]);
      if (open && Number(open.n)) fields.push({ label: "Earlier approved loans / advances", value: `${Number(open.n)} (${money(open.amt)})` });
    } else if (t === "attendance") {
      const proj = await projectName(r.project_id);
      title = `Check in / out — ${d(r.attendance_date)}`;
      fields = F([
        ["Date", d(r.attendance_date)],
        ["Project", proj],
        ["Checked in", r.check_in_at ? dt(r.check_in_at) : null],
        ["Check in place", r.check_in_place],
        ["Check in distance", r.check_in_distance_m != null ? `${Math.round(Number(r.check_in_distance_m))} m from the project` : null],
        ["Check in note", r.check_in_remarks],
        ["Checked out", r.check_out_at ? dt(r.check_out_at) : null],
        ["Check out place", r.check_out_place],
        ["Check out distance", r.check_out_distance_m != null ? `${Math.round(Number(r.check_out_distance_m))} m from the project` : null],
        ["Check out note", r.check_out_remarks]
      ]);
      loc("Check in", r.check_in_lat, r.check_in_lng, r.check_in_place);
      loc("Check out", r.check_out_lat, r.check_out_lng, r.check_out_place);
    } else if (t === "claim") {
      title = `Movement — ${r.purpose || ""}`;
      fields = F([
        ["Purpose", r.purpose],
        ["Checked in", r.check_in_at ? dt(r.check_in_at) : null],
        ["Check in note", r.check_in_remarks],
        ["Checked out", r.check_out_at ? dt(r.check_out_at) : null],
        ["Check out note", r.check_out_remarks],
        ["Distance", r.distance_km != null ? `${Number(r.distance_km)} km` : null],
        ["Status", r.status]
      ]);
      loc("Check in", r.check_in_lat, r.check_in_lng);
      loc("Check out", r.check_out_lat, r.check_out_lng);
    } else if (t === "hr_action") {
      const emp = await one("SELECT name, employee_id, designation, department, branch FROM all_employees WHERE id = ?", [Number(r.employee_id)]);
      const label = String(r.action_type || "HR action").replace(/_/g, " ");
      title = `${label.charAt(0).toUpperCase() + label.slice(1)}${emp ? " — " + emp.name : ""}`;
      fields = F([
        ["Employee", emp ? `${emp.name}${emp.employee_id ? " · " + emp.employee_id : ""}` : null],
        ["Effective date", d(r.effective_date)],
        ["Reason", r.reason],
        ["Remarks", r.remarks],
        ["Status", r.status]
      ]);
      const from = parse(r.from_json, {});
      const to = parse(r.to_json, {});
      const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((k) => !/(_id|^id)$/.test(k) && String(from[k] ?? "") !== String(to[k] ?? ""));
      const shown = (k: string, v: any) => (!seesSalary && SALARY_KEY.test(k) ? MASK : String(v ?? "—"));
      if (keys.length) table = { columns: ["What", "Now", "Becomes"], rows: keys.map((k) => [k.replace(/_/g, " "), shown(k, from[k]), shown(k, to[k])]) };
    } else if (t === "exit_clearance") {
      const ci = r.clearance_item;
      title = `Exit clearance — ${ci?.department || ""}`;
      const items: any[] = (await queryDB("SELECT department, item_label, is_cleared FROM exit_clearance_items WHERE exit_id = ? ORDER BY id", [Number(r.id)]).catch(() => [])) || [];
      fields = F([
        ["Exit type", r.exit_type],
        ["Reason", r.reason],
        ["Notice date", d(r.notice_date)],
        ["Last working day", d(r.last_working_day)],
        ["Your item", ci ? `${ci.department} — ${ci.item_label}` : null],
        ["Status", r.status]
      ]);
      if (items.length) table = { columns: ["Department", "Item", "Cleared"], rows: items.map((i) => [i.department || "—", i.item_label || "—", Number(i.is_cleared) ? "Yes" : "Not yet"]) };
    }
    return { title, fields, table, attachments, locations };
  }

  const read = async (req: any, res: any) => {
    const type = String(req.query.type || "").trim();
    const id = Number(req.query.id);
    if (!TYPE_LABEL[type] || !Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Unknown request." });
      return null;
    }
    const src = await loadSource(type, id);
    if (!src) {
      res.status(404).json({ error: "This request no longer exists." });
      return null;
    }
    const reqRow = await requestRowFor(type, id);
    if (!(await mayOpen(req.user, type, id, src, reqRow))) {
      res.status(403).json({ error: "You can't open this request." });
      return null;
    }
    return { type, id, src, reqRow };
  };

  app.get("/api/approval-details", authenticateToken, async (req: any, res) => {
    try {
      const ok = await read(req, res);
      if (!ok) return;
      const { type, id, src, reqRow } = ok;
      // HR Action salary: Superadmin, who raised it, its approvers, or
      // Payroll's "See salary amounts".
      const me = Number(req.user.id);
      const seesSalary =
        type !== "hr_action" ||
        req.user.role === "superadmin" ||
        Number(src.row.created_by) === me ||
        hrActionPeople(src.row).has(me) ||
        (await hasModuleLayer(req.user, "payroll", "salary_amounts").catch(() => false));
      const body = await describe(type, src, seesSalary);
      let tl = await timeline(reqRow);
      if (!tl && type === "hr_action") {
        const hist = parse(src.row.history_json, []);
        const steps = [];
        for (const h of hist) steps.push({ step: Number(h.step) || null, who: h.by_name || (await nameOf(h.by)), action: h.action || null, note: h.remarks || h.note || null, at: h.at || null });
        tl = { status: src.row.status, current_step: Number(src.row.current_step) || null, total_steps: Number(src.row.total_steps) || null, steps, waiting_on: [] };
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        type,
        id,
        type_label: TYPE_LABEL[type],
        status: reqRow?.status || src.row.status || null,
        submitted_at: dt(src.row.created_at),
        requester: await requester(src.ownerUserId),
        ...body,
        has_file: !!FILES[type === "leave_reliever" || type === "leave_direct" ? "leave_application" : type] && body.attachments.length > 0,
        timeline: tl
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The request's attached file, for the same people as the details above.
  app.get("/api/approval-details/file", authenticateToken, async (req: any, res) => {
    try {
      const ok = await read(req, res);
      if (!ok) return;
      const f = FILES[ok.type];
      if (!f) return res.status(404).json({ error: "No attachment." });
      const row = await one(`SELECT ${f.data} AS data, ${f.name} AS name, ${f.mime} AS mime FROM ${f.table} WHERE id = ?`, [ok.id]);
      if (!row?.data) return res.status(404).json({ error: "No attachment." });
      const buffer: Buffer = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      res.setHeader("Content-Type", row.mime || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.name || `attachment_${ok.id}`)}"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
