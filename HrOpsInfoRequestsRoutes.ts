/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Information requests — closing the gaps Employee Reports finds (missing
// documents, no nominee, no emergency contact) by asking the Employee.
//
//   HR picks employees (usually straight from a report) and sends a request:
//   either specific items, or "whatever this employee is missing" (worked out
//   here from the required-document list and the family records). One row
//   per item in hr_info_requests. Employees without an app login are skipped
//   — they can't answer, and HR fills those gaps from Service Book instead.
//
//   The Employee sees their open items in Self Service -> My Letters &
//   Service Record -> Pending Items, uploads the document (photo / PDF) or
//   fills in nominee / emergency-contact details, and submits. Nothing
//   reaches their record yet: HR reviews every submission (Employee Reports
//   -> Requests) and only an approval writes it —
//     document          -> employee_documents (Document Vault),
//     nominee           -> hr_emp_family rows marked nominee (the submitted
//                          list replaces any earlier nominee marks, shares
//                          must total 100%),
//     emergency_contact -> hr_emp_family row marked emergency contact.
//   A rejection goes back to the Employee with the reason, to resubmit.
//
//   Items still open on/after their due date get a daily reminder alert.
//
// Same data-access convention as HROperationsRoutes.ts: reads are
// `SELECT * FROM x` (optionally narrowed by one `WHERE col = ?`) re-filtered
// in JS, writes only ever use `WHERE id = ?`.

import type { Express } from "express";
import type { AlertType } from "./Alerts";
import { loadSettings, toDate, num } from "./HROperationsRoutes";
import { requiredDocuments, missingDocuments, rowsFor } from "./HrOps360Routes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface InfoRequestRouteDeps {
  authenticateToken: any;
  requireModule: (moduleKey: "hr_operations") => any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
  createAlert: (
    queryDB: QueryDB,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
}

export async function ensureInfoRequestsSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS hr_info_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        batch_id VARCHAR(40) NULL,
        employee_id INT NOT NULL,
        user_id INT NOT NULL,
        -- document / nominee / emergency_contact
        item_type VARCHAR(30) NOT NULL,
        doc_type VARCHAR(100) NULL,
        note VARCHAR(500) NULL,
        due_date DATE NULL,
        -- pending -> submitted -> approved | rejected (-> submitted again) ; cancelled
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        submission_json TEXT NULL,
        file_name VARCHAR(255) NULL,
        file_mime VARCHAR(100) NULL,
        file_data LONGBLOB NULL,
        submitted_at TIMESTAMP NULL DEFAULT NULL,
        review_remarks VARCHAR(500) NULL,
        reviewed_by INT NULL,
        reviewed_at TIMESTAMP NULL DEFAULT NULL,
        result_ref VARCHAR(100) NULL,
        requested_by INT NULL,
        reminded_on DATE NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure hr_info_requests table exists: " + err.message);
  }
}

const ITEM_LABEL: Record<string, string> = { document: "Document", nominee: "Nominee details", emergency_contact: "Emergency contact" };
const OPEN = new Set(["pending", "submitted", "rejected"]);
const itemTitle = (r: any) => (r.item_type === "document" ? r.doc_type || "Document" : ITEM_LABEL[r.item_type] || r.item_type);
const parse = (v: any, fb: any) => {
  if (v == null || v === "") return fb;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return fb;
  }
};

// One person from a nominee / emergency-contact submission, cleaned.
function cleanPerson(p: any) {
  const s = (v: any, max: number) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
  return {
    name: s(p?.name, 150),
    relation: s(p?.relation, 60),
    date_of_birth: toDate(p?.date_of_birth),
    phone: s(p?.phone, 60),
    nid: s(p?.nid, 60),
    address: s(p?.address, 500),
    occupation: s(p?.occupation, 150),
    nominee_percent: num(p?.nominee_percent)
  };
}

export function registerInfoRequestRoutes(app: Express, deps: InfoRequestRouteDeps) {
  const { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka, createAlert } = deps;
  const gate = [authenticateToken, requireModule("hr_operations")];
  const fail = (res: any, err: any, status = 500) => res.status(err?.statusCode || status).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  async function canUse(userId: number, role: string | undefined, mod: string) {
    if (role === "superadmin") return true;
    if (role !== "admin" && role !== "user") return false;
    return (await getAdminModules(userId).catch(() => [])).includes(mod);
  }
  const notify = (userId: number, title: string, message: string, id?: number) =>
    createAlert(queryDB, { userId, type: "hr_request", title, message, relatedType: "hr_info_request", relatedId: id }).catch(() => {});

  // What an Employee is currently missing (same rules as Employee Reports).
  async function gapsFor(emp: any, settings: Record<string, string>, docsByUser: Map<number, string[]>, famByEmp: Map<number, any[]>) {
    const out: { item_type: string; doc_type?: string }[] = [];
    const types = docsByUser.get(Number(emp.user_id)) || [];
    for (const d of missingDocuments(requiredDocuments(settings), types)) out.push({ item_type: "document", doc_type: d });
    const fam = famByEmp.get(Number(emp.id)) || [];
    const noms = fam.filter((f: any) => Number(f.is_nominee));
    const share = noms.reduce((s: number, f: any) => s + Number(f.nominee_percent || 0), 0);
    if (!noms.length || Math.abs(share - 100) > 0.01) out.push({ item_type: "nominee" });
    if (!fam.some((f: any) => Number(f.is_emergency))) out.push({ item_type: "emergency_contact" });
    return out;
  }

  const publicRow = (r: any, emp: any, names: Map<number, string>) => ({
    id: Number(r.id),
    batch_id: r.batch_id,
    employee_id: Number(r.employee_id),
    employee_name: emp?.name || null,
    employee_code: emp?.employee_id || null,
    department: emp?.department || null,
    item_type: r.item_type,
    item_label: itemTitle(r),
    doc_type: r.doc_type,
    note: r.note,
    due_date: toDate(r.due_date),
    overdue: OPEN.has(r.status) && r.status !== "submitted" && !!toDate(r.due_date) && toDate(r.due_date)! < todayInDhaka(),
    status: r.status,
    submission: parse(r.submission_json, null),
    has_file: !!r.file_name,
    file_name: r.file_name,
    file_mime: r.file_mime,
    submitted_at: r.submitted_at,
    review_remarks: r.review_remarks,
    reviewed_by: r.reviewed_by ? names.get(Number(r.reviewed_by)) || null : null,
    reviewed_at: r.reviewed_at,
    requested_by: r.requested_by ? names.get(Number(r.requested_by)) || null : null,
    created_at: r.created_at
  });

  // ---------------- HR side ----------------

  // body: { employee_ids: number[], from_gaps?: ('documents'|'nominee'|'emergency_contact')[],
  //         items?: {item_type, doc_type?}[], note?, due_date? }
  app.post("/api/hr-ops/info-requests", ...gate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const ids: number[] = [...new Set<number>((Array.isArray(body.employee_ids) ? body.employee_ids : []).map(Number).filter(Boolean))].slice(0, 2000);
      if (!ids.length) throw bad("Pick at least one employee.");
      const fromGaps = new Set<string>(Array.isArray(body.from_gaps) ? body.from_gaps : []);
      const fixed: { item_type: string; doc_type?: string }[] = (Array.isArray(body.items) ? body.items : [])
        .filter((i: any) => ["document", "nominee", "emergency_contact"].includes(i?.item_type) && (i.item_type !== "document" || String(i.doc_type || "").trim()))
        .map((i: any) => ({ item_type: i.item_type, doc_type: i.item_type === "document" ? String(i.doc_type).trim().slice(0, 100) : undefined }));
      if (!fromGaps.size && !fixed.length) throw bad("Choose what to ask for.");
      const note = body.note ? String(body.note).slice(0, 500) : null;
      const due = toDate(body.due_date);

      const [emps, existing, docs, fam, settings] = await Promise.all([
        queryDB("SELECT * FROM all_employees"),
        queryDB("SELECT * FROM hr_info_requests"),
        queryDB("SELECT * FROM employee_documents").catch(() => []),
        queryDB("SELECT * FROM hr_emp_family").catch(() => []),
        loadSettings(queryDB)
      ]);
      const docsByUser = new Map<number, string[]>();
      for (const d of docs) docsByUser.set(Number(d.user_id), [...(docsByUser.get(Number(d.user_id)) || []), String(d.doc_type)]);
      const famByEmp = new Map<number, any[]>();
      for (const f of fam) famByEmp.set(Number(f.employee_id), [...(famByEmp.get(Number(f.employee_id)) || []), f]);
      const openKey = (empId: number, t: string, d?: string | null) => `${empId}|${t}|${String(d || "").toLowerCase()}`;
      const open = new Set(existing.filter((r: any) => OPEN.has(r.status)).map((r: any) => openKey(Number(r.employee_id), r.item_type, r.doc_type)));

      const batch = `B${Date.now()}`;
      let created = 0;
      let already = 0;
      const noLogin: string[] = [];
      const nothing: string[] = [];
      for (const id of ids) {
        const e = emps.find((x: any) => Number(x.id) === id);
        if (!e) continue;
        if (!e.user_id) {
          noLogin.push(e.name);
          continue;
        }
        let items = [...fixed];
        if (fromGaps.size) {
          const gaps = await gapsFor(e, settings, docsByUser, famByEmp);
          items.push(...gaps.filter((g) => (g.item_type === "document" ? fromGaps.has("documents") : fromGaps.has(g.item_type))));
        }
        const seen = new Set<string>();
        items = items.filter((i) => {
          const k = openKey(id, i.item_type, i.doc_type);
          if (seen.has(k)) return false;
          seen.add(k);
          if (open.has(k)) {
            already++;
            return false;
          }
          return true;
        });
        if (!items.length) {
          nothing.push(e.name);
          continue;
        }
        for (const i of items) {
          await queryDB(
            "INSERT INTO hr_info_requests (batch_id, employee_id, user_id, item_type, doc_type, note, due_date, status, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [batch, id, Number(e.user_id), i.item_type, i.doc_type || null, note, due, "pending", req.user.id]
          );
          created++;
        }
        await notify(
          Number(e.user_id),
          "HR needs information from you",
          `Please submit: ${items.map((i) => (i.item_type === "document" ? i.doc_type : ITEM_LABEL[i.item_type])).join(", ")}${due ? ` by ${due}` : ""}. Open My Letters & Service Record → Pending Items.${note ? ` Note: ${note}` : ""}`
        );
      }
      res.json({ success: true, created, employees: ids.length - noLogin.length - nothing.length, already_requested: already, no_login: noLogin, nothing_missing: nothing });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/info-requests", ...gate, async (_req: any, res: any) => {
    try {
      const [rows, emps, users] = await Promise.all([queryDB("SELECT * FROM hr_info_requests"), queryDB("SELECT * FROM all_employees"), queryDB("SELECT * FROM users").catch(() => [])]);
      const names = new Map<number, string>(users.map((u: any) => [Number(u.id), u.name]));
      const empBy = new Map<number, any>(emps.map((e: any) => [Number(e.id), e]));
      const list = rows.sort((a: any, b: any) => Number(b.id) - Number(a.id)).map((r: any) => publicRow(r, empBy.get(Number(r.employee_id)), names));
      const count = (s: string) => list.filter((r: any) => r.status === s).length;
      res.json({
        items: list,
        summary: {
          pending: count("pending"),
          submitted: count("submitted"),
          rejected: count("rejected"),
          approved: count("approved"),
          overdue: list.filter((r: any) => r.overdue).length,
          employees_open: new Set(list.filter((r: any) => OPEN.has(r.status)).map((r: any) => r.employee_id)).size
        }
      });
    } catch (err) {
      fail(res, err);
    }
  });

  async function requestById(id: number) {
    const rows: any[] = await queryDB("SELECT * FROM hr_info_requests WHERE id = ?", [id]);
    const r = rows.find((x: any) => Number(x.id) === id);
    if (!r) throw bad("Request not found.", 404);
    return r;
  }

  app.get("/api/hr-ops/info-requests/:id/file", ...gate, async (req: any, res: any) => {
    try {
      const r = await requestById(Number(req.params.id));
      if (!r.file_data) throw bad("No file.", 404);
      const buf: Buffer = Buffer.isBuffer(r.file_data) ? r.file_data : Buffer.from(r.file_data);
      res.setHeader("Content-Type", r.file_mime || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(r.file_name || "file")}"`);
      res.send(buf);
    } catch (err) {
      fail(res, err);
    }
  });

  // Approve writes the submission into the Employee's record; reject sends
  // it back with the reason.
  app.post("/api/hr-ops/info-requests/:id/review", ...gate, async (req: any, res: any) => {
    try {
      const r = await requestById(Number(req.params.id));
      if (r.status !== "submitted") throw bad("Only a submitted item can be reviewed.");
      const decision = req.body?.decision;
      const remarks = req.body?.remarks ? String(req.body.remarks).trim().slice(0, 500) : null;
      if (decision === "rejected") {
        if (!remarks) throw bad("Tell the employee why it was rejected.");
        await queryDB("UPDATE hr_info_requests SET status = ?, review_remarks = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", ["rejected", remarks, req.user.id, new Date(), Number(r.id)]);
        await notify(Number(r.user_id), `${itemTitle(r)} — please resubmit`, `HR could not accept your ${itemTitle(r)}: ${remarks}`, Number(r.id));
        return res.json({ success: true, status: "rejected" });
      }
      if (decision !== "approved") throw bad("Decision must be approved or rejected.");

      let ref: string | null = null;
      if (r.item_type === "document") {
        // Document Vault upload is its own module permission.
        if (!(await canUse(Number(req.user.id), req.user.role, "document_vault"))) throw bad("Approving a document saves it to Document Vault — that needs the Document Vault module.", 403);
        if (!r.file_data) throw bad("This submission has no file.");
        const ins: any = await queryDB(
          "INSERT INTO employee_documents (user_id, doc_type, file_name, file_mimetype, file_data, requires_signature, expiry_date, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [Number(r.user_id), r.doc_type || "Document", r.file_name, r.file_mime || "application/octet-stream", r.file_data, 0, toDate(parse(r.submission_json, {})?.expiry_date), req.user.id]
        );
        ref = `document:${ins.insertId}`;
      } else {
        const people: any[] = (parse(r.submission_json, {})?.people || []).map(cleanPerson).filter((p: any) => p.name);
        if (!people.length) throw bad("This submission has no details.");
        const family = await rowsFor(queryDB, "hr_emp_family", "employee_id", Number(r.employee_id));
        const ids: number[] = [];
        if (r.item_type === "nominee") {
          // The submitted list is the full nominee list.
          for (const f of family.filter((f: any) => Number(f.is_nominee))) await queryDB("UPDATE hr_emp_family SET is_nominee = ?, nominee_percent = ? WHERE id = ?", [0, null, Number(f.id)]);
        }
        for (const p of people) {
          const same = family.find((f: any) => String(f.name || "").trim().toLowerCase() === p.name!.toLowerCase());
          if (same) {
            await queryDB(
              `UPDATE hr_emp_family SET relation = ?, date_of_birth = ?, phone = ?, nid = ?, address = ?, occupation = ?, ${r.item_type === "nominee" ? "is_nominee = ?, nominee_percent = ?" : "is_emergency = ?"} WHERE id = ?`,
              [
                p.relation ?? same.relation,
                p.date_of_birth ?? toDate(same.date_of_birth),
                p.phone ?? same.phone,
                p.nid ?? same.nid,
                p.address ?? same.address,
                p.occupation ?? same.occupation,
                ...(r.item_type === "nominee" ? [1, p.nominee_percent] : [1]),
                Number(same.id)
              ]
            );
            ids.push(Number(same.id));
          } else {
            const ins: any = await queryDB(
              "INSERT INTO hr_emp_family (employee_id, name, relation, date_of_birth, occupation, phone, nid, address, is_nominee, nominee_percent, is_emergency, is_dependent, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                Number(r.employee_id),
                p.name,
                p.relation,
                p.date_of_birth,
                p.occupation,
                p.phone,
                p.nid,
                p.address,
                r.item_type === "nominee" ? 1 : 0,
                r.item_type === "nominee" ? p.nominee_percent : null,
                r.item_type === "emergency_contact" ? 1 : 0,
                0,
                req.user.id
              ]
            );
            ids.push(Number(ins.insertId));
          }
        }
        ref = `family:${ids.join(",")}`;
      }
      await queryDB("UPDATE hr_info_requests SET status = ?, review_remarks = ?, reviewed_by = ?, reviewed_at = ?, result_ref = ? WHERE id = ?", [
        "approved",
        remarks,
        req.user.id,
        new Date(),
        ref,
        Number(r.id)
      ]);
      await notify(Number(r.user_id), `${itemTitle(r)} accepted`, `HR accepted your ${itemTitle(r)} — it is now on your record. Thank you.`, Number(r.id));
      res.json({ success: true, status: "approved" });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/info-requests/:id/cancel", ...gate, async (req: any, res: any) => {
    try {
      const r = await requestById(Number(req.params.id));
      if (!OPEN.has(r.status)) throw bad("This item is already closed.");
      await queryDB("UPDATE hr_info_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", ["cancelled", req.user.id, new Date(), Number(r.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- Employee side ----------------

  app.get("/api/hr-ops/my/info-requests", authenticateToken, async (req: any, res: any) => {
    try {
      const rows = await rowsFor(queryDB, "hr_info_requests", "user_id", Number(req.user.id));
      const users: any[] = await queryDB("SELECT * FROM users").catch(() => []);
      const names = new Map<number, string>(users.map((u: any) => [Number(u.id), u.name]));
      const emps: any[] = await queryDB("SELECT * FROM all_employees");
      const list = rows
        .filter((r: any) => r.status !== "cancelled")
        .sort((a: any, b: any) => (OPEN.has(b.status) ? 1 : 0) - (OPEN.has(a.status) ? 1 : 0) || Number(b.id) - Number(a.id))
        .map((r: any) => {
          const p = publicRow(r, emps.find((e: any) => Number(e.id) === Number(r.employee_id)), names);
          return { ...p, employee_name: undefined, employee_code: undefined, department: undefined };
        });
      const emp = emps.find((e: any) => Number(e.user_id) === Number(req.user.id));
      const family = emp ? await rowsFor(queryDB, "hr_emp_family", "employee_id", Number(emp.id)) : [];
      res.json({
        items: list,
        open: list.filter((r: any) => r.status === "pending" || r.status === "rejected").length,
        // Pre-fill the nominee / emergency forms with what HR already has.
        family: family.map((f: any) => ({
          name: f.name,
          relation: f.relation,
          phone: f.phone,
          date_of_birth: toDate(f.date_of_birth),
          nid: f.nid,
          address: f.address,
          is_nominee: !!Number(f.is_nominee),
          nominee_percent: f.nominee_percent != null ? Number(f.nominee_percent) : null,
          is_emergency: !!Number(f.is_emergency)
        }))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/my/info-requests/:id/submit", authenticateToken, async (req: any, res: any) => {
    try {
      const r = await requestById(Number(req.params.id));
      if (Number(r.user_id) !== Number(req.user.id)) throw bad("Request not found.", 404);
      if (r.status !== "pending" && r.status !== "rejected") throw bad("This item has already been submitted.");
      const body = req.body || {};
      if (r.item_type === "document") {
        if (!body.file_base64 || !body.file_name) throw bad("Attach the document (photo or PDF).");
        const buf = Buffer.from(String(body.file_base64), "base64");
        if (buf.length > 8 * 1024 * 1024) throw bad("File is larger than 8 MB.");
        await queryDB(
          "UPDATE hr_info_requests SET status = ?, file_name = ?, file_mime = ?, file_data = ?, submission_json = ?, submitted_at = ?, review_remarks = ? WHERE id = ?",
          [
            "submitted",
            String(body.file_name).slice(0, 255),
            String(body.file_mime || "application/octet-stream").slice(0, 100),
            buf,
            JSON.stringify({ expiry_date: toDate(body.expiry_date), comment: body.comment ? String(body.comment).slice(0, 500) : null }),
            new Date(),
            null,
            Number(r.id)
          ]
        );
      } else {
        const people = (Array.isArray(body.people) ? body.people : []).slice(0, 10).map(cleanPerson);
        if (!people.length || people.some((p: any) => !p.name)) throw bad("Enter a name for every person.");
        if (people.some((p: any) => !p.phone) && r.item_type === "emergency_contact") throw bad("An emergency contact needs a phone number.");
        if (r.item_type === "nominee") {
          if (people.some((p: any) => p.nominee_percent == null || p.nominee_percent <= 0)) throw bad("Give each nominee a share (%).");
          const total = people.reduce((s: number, p: any) => s + Number(p.nominee_percent), 0);
          if (Math.abs(total - 100) > 0.01) throw bad(`Nominee shares must add up to 100% (now ${Math.round(total * 100) / 100}%).`);
        }
        await queryDB("UPDATE hr_info_requests SET status = ?, submission_json = ?, submitted_at = ?, review_remarks = ? WHERE id = ?", [
          "submitted",
          JSON.stringify({ people, comment: body.comment ? String(body.comment).slice(0, 500) : null }),
          new Date(),
          null,
          Number(r.id)
        ]);
      }
      if (r.requested_by) {
        const emps: any[] = await queryDB("SELECT * FROM all_employees");
        const e = emps.find((x: any) => Number(x.id) === Number(r.employee_id));
        await notify(
          Number(r.requested_by),
          "Submitted for review",
          `${e?.name || "An employee"} submitted ${itemTitle(r)}. Review it in HR Operations → Employee Reports → Requests.`,
          Number(r.id)
        );
      }
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- reminders ----------------
  // Once a day, every item still waiting on the employee and due tomorrow
  // or already overdue gets a reminder (one alert per employee).
  const remind = async () => {
    try {
      const today = todayInDhaka();
      const t = new Date(`${today}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + 1);
      const tomorrow = t.toISOString().slice(0, 10);
      const rows: any[] = await queryDB("SELECT * FROM hr_info_requests").catch(() => []);
      const due = rows.filter(
        (r: any) => (r.status === "pending" || r.status === "rejected") && toDate(r.due_date) && toDate(r.due_date)! <= tomorrow && toDate(r.reminded_on) !== today
      );
      const byUser = new Map<number, any[]>();
      for (const r of due) byUser.set(Number(r.user_id), [...(byUser.get(Number(r.user_id)) || []), r]);
      for (const [uid, items] of byUser) {
        const overdue = items.some((r: any) => toDate(r.due_date)! < today);
        await notify(uid, overdue ? "Reminder: HR is still waiting" : "Reminder: due tomorrow", `Please submit: ${items.map(itemTitle).join(", ")}. Open My Letters & Service Record → Pending Items.`);
        for (const r of items) await queryDB("UPDATE hr_info_requests SET reminded_on = ? WHERE id = ?", [today, Number(r.id)]);
      }
    } catch (err: any) {
      console.warn("⚠️ Info request reminders: " + err.message);
    }
  };
  setTimeout(remind, 90 * 1000);
  setInterval(remind, 60 * 60 * 1000);
}
