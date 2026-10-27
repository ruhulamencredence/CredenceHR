/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// SIM and ID card requisitions — an employee (or a new joiner, from My
// Onboarding) asks for a company SIM or an ID card; HR issues it against the
// request or turns it down.
//
//   Self Service -> SIM & ID Card   users.can_request_items, off by default
//                                   (Module Access). Needs an Employee record.
//   My Onboarding -> Requisitions   the joiner's own, while HR Ops Settings ->
//                                   "Joiners can request a SIM / ID card" is on
//                                   (off by default). Moves to the Employee
//                                   when the onboarding is approved.
//   HR Operations -> Requisitions   layer "requisitions" (explicit only):
//                                   see, issue, reject. Issuing a SIM links a
//                                   SIM already given to the person in Mobile
//                                   Bill; issuing an ID card records the card
//                                   number and ticks "ID card issued" in their
//                                   onboarding checklist.
//
// Something can only be issued to an Employee, so a joiner's request waits
// for the onboarding approval.

import type { Express } from "express";
import { activeCompanyId } from "./companyContext";
import { createAlert } from "./Alerts";
import { loadSettings } from "./HROperationsRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export const REQUISITION_KINDS = ["sim", "id_card"] as const;
export type RequisitionKind = (typeof REQUISITION_KINDS)[number];
const KIND_LABEL: Record<RequisitionKind, string> = { sim: "SIM", id_card: "ID card" };
// Why it is asked for.
const REASONS: Record<RequisitionKind, string[]> = {
  sim: ["new", "replacement"],
  id_card: ["new", "lost", "damaged", "replacement"]
};

export async function ensureRequisitionSchema(queryDB: QueryDB) {
  await queryDB(`CREATE TABLE IF NOT EXISTS employee_requisitions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL DEFAULT 1,
    user_id INT NOT NULL,
    employee_id INT NULL,
    application_id INT NULL,
    kind VARCHAR(20) NOT NULL,
    -- requested -> issued | rejected | cancelled
    status VARCHAR(20) NOT NULL DEFAULT 'requested',
    reason VARCHAR(30) NOT NULL DEFAULT 'new',
    note VARCHAR(1000) NULL,
    operator VARCHAR(30) NULL,
    name_on_card VARCHAR(150) NULL,
    blood_group VARCHAR(10) NULL,
    sim_id INT NULL,
    card_number VARCHAR(60) NULL,
    decided_by INT NULL,
    decided_at DATETIME NULL,
    decision_note VARCHAR(500) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_req_user (user_id),
    INDEX idx_req_employee (employee_id),
    INDEX idx_req_application (application_id)
  )`);
  try {
    await queryDB("ALTER TABLE users ADD COLUMN can_request_items TINYINT(1) NOT NULL DEFAULT 0");
  } catch (err: any) {
    if (err?.code !== "ER_DUP_FIELDNAME" && !/Duplicate column/i.test(String(err?.message))) console.warn("⚠️ Could not add users.can_request_items: " + err.message);
  }
}

const str = (v: unknown, max: number) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

// What the person filled in, checked and trimmed. Throws a 400 message.
function cleanRequest(body: any): { kind: RequisitionKind; reason: string; note: string | null; operator: string | null; name_on_card: string | null; blood_group: string | null } {
  const kind = String(body?.kind || "") as RequisitionKind;
  if (!REQUISITION_KINDS.includes(kind)) throw Object.assign(new Error("Pick SIM or ID card."), { statusCode: 400 });
  const reason = String(body?.reason || "new");
  if (!REASONS[kind].includes(reason)) throw Object.assign(new Error("Pick why you need it."), { statusCode: 400 });
  const note = str(body?.note, 1000);
  if (reason !== "new" && !note) throw Object.assign(new Error("Tell HR what happened to the old one."), { statusCode: 400 });
  return {
    kind,
    reason,
    note,
    operator: kind === "sim" ? str(body?.operator, 30) : null,
    name_on_card: kind === "id_card" ? str(body?.name_on_card, 150) : null,
    blood_group: kind === "id_card" ? str(body?.blood_group, 10) : null
  };
}

const shape = (r: any) => ({
  id: Number(r.id),
  kind: r.kind,
  status: r.status,
  reason: r.reason,
  note: r.note || null,
  operator: r.operator || null,
  name_on_card: r.name_on_card || null,
  blood_group: r.blood_group || null,
  card_number: r.card_number || null,
  sim_id: r.sim_id ? Number(r.sim_id) : null,
  sim_number: r.sim_number || null,
  decision_note: r.decision_note || null,
  decided_at: r.decided_at || null,
  created_at: r.created_at
});

export function registerRequisitionRoutes(
  app: Express,
  deps: { authenticateToken: any; requireModuleLayer: any; hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>; queryDB: QueryDB }
) {
  const { authenticateToken, requireModuleLayer, hasModuleLayer, queryDB } = deps;
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const hrGate = [authenticateToken, requireModuleLayer("hr_operations", "requisitions")];

  // Whoever can issue these hears about a new request.
  async function tellHr(title: string, message: string, id: number) {
    // Only accounts that have HR Operations at all are checked for the layer.
    const users: any[] =
      (await queryDB(
        "SELECT id, role FROM users WHERE role = 'superadmin' OR id IN (SELECT user_id FROM admin_module_permissions WHERE module_key = 'hr_operations')"
      ).catch(() => [])) || [];
    let told = 0;
    for (const u of users) {
      if (u.role === "superadmin") continue;
      if (await hasModuleLayer({ id: Number(u.id), role: u.role }, "hr_operations", "requisitions").catch(() => false)) {
        await createAlert(queryDB, { userId: Number(u.id), type: "requisition", title, message, relatedType: "requisition_hr", relatedId: id }).catch(() => {});
        told++;
      }
    }
    if (!told) for (const u of users.filter((x) => x.role === "superadmin")) await createAlert(queryDB, { userId: Number(u.id), type: "requisition", title, message, relatedType: "requisition_hr", relatedId: id }).catch(() => {});
  }

  async function addRequest(userId: number, who: string, owner: { employeeId: number | null; applicationId: number | null; companyId: number }, body: any) {
    const f = cleanRequest(body);
    const open: any[] =
      (await queryDB("SELECT id FROM employee_requisitions WHERE user_id = ? AND kind = ? AND status = 'requested'", [userId, f.kind])) || [];
    if (open.length) throw Object.assign(new Error(`You already have a ${KIND_LABEL[f.kind]} request waiting.`), { statusCode: 400 });
    const r: any = await queryDB(
      `INSERT INTO employee_requisitions (company_id, user_id, employee_id, application_id, kind, reason, note, operator, name_on_card, blood_group)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner.companyId, userId, owner.employeeId, owner.applicationId, f.kind, f.reason, f.note, f.operator, f.name_on_card, f.blood_group]
    );
    const id = Number(r.insertId);
    await tellHr(`${KIND_LABEL[f.kind]} Requisition`, `${who} asked for ${f.kind === "sim" ? "a company SIM" : "an ID card"}${f.reason !== "new" ? ` (${f.reason})` : ""}.`, id);
    return id;
  }

  // ---------------- Self Service ----------------
  async function selfEmployee(user: any): Promise<{ id: number; company_id: number } | null> {
    const rows: any[] = (await queryDB("SELECT id, company_id FROM all_employees WHERE user_id = ?", [Number(user.id)])) || [];
    return rows[0] ? { id: Number(rows[0].id), company_id: Number(rows[0].company_id ?? 1) } : null;
  }
  const selfGate = async (req: any, res: any, next: any) => {
    try {
      if (req.user?.onb) return res.status(403).json({ error: "Not available while onboarding." });
      if (req.user?.role === "superadmin") return next();
      const rows: any[] = (await queryDB("SELECT can_request_items FROM users WHERE id = ?", [Number(req.user.id)])) || [];
      if (!rows[0] || Number(rows[0].can_request_items) !== 1) return res.status(403).json({ error: "SIM & ID Card requests aren't turned on for your account." });
      next();
    } catch (err) {
      fail(res, err);
    }
  };
  const mine = async (userId: number) =>
    (
      (await queryDB(
        `SELECT r.*, s.phone_number AS sim_number FROM employee_requisitions r LEFT JOIN mobile_sims s ON s.id = r.sim_id
         WHERE r.user_id = ? ORDER BY r.id DESC`,
        [userId]
      ).catch(() => queryDB("SELECT * FROM employee_requisitions WHERE user_id = ? ORDER BY id DESC", [userId]))) || []
    ).map(shape);

  app.get("/api/requisitions/mine", authenticateToken, selfGate, async (req: any, res: any) => {
    try {
      res.json({ has_employee: !!(await selfEmployee(req.user)), rows: await mine(Number(req.user.id)) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/requisitions", authenticateToken, selfGate, async (req: any, res: any) => {
    try {
      const emp = await selfEmployee(req.user);
      if (!emp) return res.status(400).json({ error: "Your login isn't linked to an Employee record yet — ask HR." });
      const id = await addRequest(Number(req.user.id), req.user.name || "An employee", { employeeId: emp.id, applicationId: null, companyId: emp.company_id }, req.body);
      res.status(201).json({ id });
    } catch (err) {
      fail(res, err);
    }
  });

  const cancelOwn = async (req: any, res: any) => {
    try {
      const rows: any[] = (await queryDB("SELECT * FROM employee_requisitions WHERE id = ? AND user_id = ?", [Number(req.params.id), Number(req.user.id)])) || [];
      if (!rows[0]) return res.status(404).json({ error: "Request not found." });
      if (rows[0].status !== "requested") return res.status(400).json({ error: `This request was already ${rows[0].status}.` });
      await queryDB("UPDATE employee_requisitions SET status = 'cancelled', decided_at = NOW() WHERE id = ?", [Number(rows[0].id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  };
  app.post("/api/requisitions/:id(\\d+)/cancel", authenticateToken, selfGate, cancelOwn);

  // ---------------- My Onboarding (the joiner) ----------------
  // onboardingPathAllowed() already lets an onboarding login reach
  // /api/onboarding/me/*; these are also refused to anyone else.
  async function joinerApplication(req: any): Promise<any | null> {
    if (!req.user?.onb) {
      const u: any[] = (await queryDB("/*unscoped*/ SELECT is_onboarding FROM users WHERE id = ?", [Number(req.user.id)])) || [];
      if (!u[0] || Number(u[0].is_onboarding) !== 1) return null;
    }
    const rows: any[] =
      (await queryDB("/*unscoped*/ SELECT id, company_id, status FROM onboarding_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1", [Number(req.user.id)])) || [];
    return rows[0] || null;
  }
  const joinerEnabled = async () => String((await loadSettings(queryDB).catch(() => ({}) as Record<string, string>)).onboarding_requisitions || "0") === "1";

  app.get("/api/onboarding/me/requisitions", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await joinerApplication(req);
      if (!a) return res.status(403).json({ error: "Only for a new joiner's onboarding." });
      res.json({ enabled: await joinerEnabled(), rows: await mine(Number(req.user.id)) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/onboarding/me/requisitions", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await joinerApplication(req);
      if (!a) return res.status(403).json({ error: "Only for a new joiner's onboarding." });
      if (!(await joinerEnabled())) return res.status(403).json({ error: "HR hasn't turned on SIM / ID card requests for new joiners." });
      if (!["draft", "submitted", "rejected"].includes(String(a.status))) return res.status(400).json({ error: "Your onboarding is closed." });
      const id = await addRequest(Number(req.user.id), `${req.user.name || "A new joiner"} (new joiner)`, { employeeId: null, applicationId: Number(a.id), companyId: Number(a.company_id) }, req.body);
      res.status(201).json({ id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/onboarding/me/requisitions/:id(\\d+)/cancel", authenticateToken, async (req: any, res: any) => {
    if (!(await joinerApplication(req).catch(() => null))) return res.status(403).json({ error: "Only for a new joiner's onboarding." });
    return cancelOwn(req, res);
  });

  // ---------------- HR Operations -> Requisitions ----------------
  // Only the active company's people: employees through the (company-scoped)
  // Employee list, joiners through their application's company.
  async function hrRows(where = "", params: any[] = []) {
    const [rows, emps, apps, sims]: any[][] = await Promise.all([
      queryDB(`SELECT * FROM employee_requisitions ${where} ORDER BY (status = 'requested') DESC, id DESC`, params),
      queryDB("SELECT id, employee_id, name, designation, department, user_id FROM all_employees"),
      queryDB("/*unscoped*/ SELECT id, company_id, name, designation, status FROM onboarding_applications"),
      queryDB("SELECT id, phone_number, operator, employee_id, status FROM mobile_sims").catch(() => [])
    ]);
    const empById = new Map<number, any>((emps || []).map((e: any) => [Number(e.id), e]));
    const appById = new Map<number, any>((apps || []).map((a: any) => [Number(a.id), a]));
    const simById = new Map<number, any>((sims || []).map((s: any) => [Number(s.id), s]));
    const cid = activeCompanyId();
    const users: any[] = (await queryDB("SELECT id, name FROM users")) || [];
    const nameOf = new Map<number, string>(users.map((u: any) => [Number(u.id), String(u.name)]));
    return (rows || [])
      .filter((r: any) => (r.employee_id ? empById.has(Number(r.employee_id)) : !!appById.get(Number(r.application_id)) && Number(appById.get(Number(r.application_id)).company_id) === cid))
      .map((r: any) => {
        const e = r.employee_id ? empById.get(Number(r.employee_id)) : null;
        const a = r.application_id ? appById.get(Number(r.application_id)) : null;
        const sim = r.sim_id ? simById.get(Number(r.sim_id)) : null;
        return {
          ...shape({ ...r, sim_number: sim?.phone_number }),
          person: e?.name || a?.name || nameOf.get(Number(r.user_id)) || "—",
          employee_row_id: e ? Number(e.id) : null,
          employee_code: e?.employee_id || null,
          designation: e?.designation || a?.designation || null,
          department: e?.department || null,
          joiner: !e,
          application_status: a?.status || null,
          decided_by_name: r.decided_by ? nameOf.get(Number(r.decided_by)) || null : null,
          // SIMs already given to this Employee in Mobile Bill (to pick when issuing).
          person_sims: e ? (sims || []).filter((s: any) => Number(s.employee_id) === Number(e.id) && s.status === "active").map((s: any) => ({ id: Number(s.id), phone_number: s.phone_number, operator: s.operator })) : []
        };
      });
  }

  app.get("/api/hr-ops/requisitions", ...hrGate, async (_req: any, res: any) => {
    try {
      res.json(await hrRows());
    } catch (err) {
      fail(res, err);
    }
  });

  async function oneForHr(id: number) {
    const r = (await hrRows("WHERE id = ?", [id]))[0];
    if (!r) throw Object.assign(new Error("Request not found."), { statusCode: 404 });
    if (r.status !== "requested") throw Object.assign(new Error(`This request was already ${r.status}.`), { statusCode: 400 });
    return r;
  }

  app.post("/api/hr-ops/requisitions/:id(\\d+)/issue", ...hrGate, async (req: any, res: any) => {
    try {
      const r = await oneForHr(Number(req.params.id));
      if (!r.employee_row_id) return res.status(409).json({ error: "This is a new joiner's request — approve their onboarding first, then issue it." });
      const note = str(req.body?.note, 500);
      let message = "";
      if (r.kind === "sim") {
        const simId = Number(req.body?.sim_id);
        const sim = r.person_sims.find((s: any) => s.id === simId);
        if (!sim) return res.status(400).json({ error: "Pick the SIM — give it to this employee in Mobile Bill first." });
        await queryDB("UPDATE employee_requisitions SET status = 'issued', sim_id = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?", [simId, Number(req.user.id), note, r.id]);
        message = `Your SIM ${sim.phone_number} (${sim.operator}) is ready.`;
      } else {
        const card = str(req.body?.card_number, 60);
        if (!card) return res.status(400).json({ error: "Write the ID card number." });
        await queryDB("UPDATE employee_requisitions SET status = 'issued', card_number = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?", [card, Number(req.user.id), note, r.id]);
        // Onboarding checklist: "ID card issued" is done, with the number.
        await queryDB(
          "UPDATE hr_onboarding_items SET status = 'done', value_text = ?, done_by = ?, done_at = NOW() WHERE employee_id = ? AND task_key = 'id_card' AND status <> 'done'",
          [card, Number(req.user.id), r.employee_row_id]
        ).catch(() => {});
        message = `Your ID card (${card}) is ready.`;
      }
      const owner: any[] = (await queryDB("SELECT user_id FROM employee_requisitions WHERE id = ?", [r.id])) || [];
      if (owner[0]) await createAlert(queryDB, { userId: Number(owner[0].user_id), type: "requisition", title: `${KIND_LABEL[r.kind as RequisitionKind]} Issued`, message: message + (note ? ` ${note}` : ""), relatedType: "requisition", relatedId: r.id }).catch(() => {});
      res.json((await hrRows("WHERE id = ?", [r.id]))[0]);
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/requisitions/:id(\\d+)/reject", ...hrGate, async (req: any, res: any) => {
    try {
      const r = await oneForHr(Number(req.params.id));
      const note = str(req.body?.note, 500);
      if (!note) return res.status(400).json({ error: "Tell them why." });
      await queryDB("UPDATE employee_requisitions SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?", [Number(req.user.id), note, r.id]);
      const owner: any[] = (await queryDB("SELECT user_id FROM employee_requisitions WHERE id = ?", [r.id])) || [];
      if (owner[0]) await createAlert(queryDB, { userId: Number(owner[0].user_id), type: "requisition", title: `${KIND_LABEL[r.kind as RequisitionKind]} Request Turned Down`, message: note, relatedType: "requisition", relatedId: r.id }).catch(() => {});
      res.json((await hrRows("WHERE id = ?", [r.id]))[0]);
    } catch (err) {
      fail(res, err);
    }
  });
}
