/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Document Vault + E-signature (Admin Panel -> HR Advanced -> "Document
// Vault") — kept in its own file, same reasoning as ExitOffboardingRoutes.ts.
//
// Data model:
//   employee_documents  — one row per document held against an employee
//                          (Appointment Letter, ID copy, contract, etc.),
//                          file bytes stored the same base64 -> LONGBLOB way
//                          every other upload in this app already does (see
//                          ConveyanceBillClaimRoutes.ts/profileRoutes.ts —
//                          no multipart/multer anywhere in this codebase).
//                          expiry_date (e.g. visa/license) is optional, read
//                          by the panel to flag documents expiring soon.
//   document_signatures — a simple typed-name + timestamp e-signature by the
//                          document's own employee, one per document
//                          (requires_signature on the document just marks
//                          whether one is being asked for).
//
// Same convention as ExitOffboardingRoutes.ts: writes only ever `WHERE id =
// ?`, filtering/scoping happens in JS after a full-table SELECT (skipping
// file_data itself in that list query — see listDocument below — so the
// list endpoint never drags every document's raw bytes over the wire), and
// every INSERT/UPDATE is all-`?`-placeholders.

import type { Express } from "express";
import { logDocEvent } from "./ESignRoutes";

interface DocumentVaultRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "document_vault") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
}

export async function ensureDocumentVaultSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        doc_type VARCHAR(100) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_mimetype VARCHAR(100) NULL,
        file_data LONGBLOB NULL,
        requires_signature TINYINT(1) NOT NULL DEFAULT 0,
        expiry_date DATE NULL,
        uploaded_by INT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure employee_documents table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS document_signatures (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NOT NULL,
        signer_user_id INT NOT NULL,
        signed_name VARCHAR(255) NOT NULL,
        signed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_signature_document (document_id),
        FOREIGN KEY (document_id) REFERENCES employee_documents(id) ON DELETE CASCADE,
        FOREIGN KEY (signer_user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure document_signatures table exists: " + err.message);
  }
}

export function registerDocumentVaultRoutes(app: Express, deps: DocumentVaultRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules } = deps;
  const adminGate = [authenticateToken, requireAdmin, requireModule("document_vault")];

  async function canManage(userId: number, role: string): Promise<boolean> {
    if (role === "superadmin") return true;
    if (role !== "admin" && role !== "user") return false;
    const modules = await getAdminModules(userId);
    return modules.includes("document_vault");
  }

  // signerRows: E-Signature progress (ESignRoutes.ts, document_signers).
  function listDocument(d: any, userById: Map<number, any>, signedIds: Set<number>, signerRows: any[] = []) {
    const mine = signerRows.filter((s: any) => Number(s.document_id) === Number(d.id));
    return {
      id: Number(d.id),
      user_id: Number(d.user_id),
      user_name: userById.get(Number(d.user_id))?.name || null,
      doc_type: d.doc_type,
      file_name: d.file_name,
      file_mimetype: d.file_mimetype,
      requires_signature: !!Number(d.requires_signature),
      is_signed: signedIds.has(Number(d.id)) || d.sign_status === "completed",
      sign_status: d.sign_status || "none",
      signers_total: mine.length,
      signers_done: mine.filter((s: any) => s.status === "signed").length,
      expiry_date: d.expiry_date,
      uploaded_at: d.uploaded_at
    };
  }

  // GET: a module-granted account sees every document; anyone else only
  // ever sees their own. Never includes file_data (see GET .../file below).
  app.get("/api/employee-documents", authenticateToken, async (req: any, res: any) => {
    try {
      const manage = await canManage(req.user.id, req.user.role);
      const [rows, users, signatures, signerRows]: [any, any, any, any] = await Promise.all([
        // Every column but file_data (the file itself, read only by GET .../file):
        // with it, listing ~1,500 documents pulled every PDF into memory.
        queryDB("SELECT id, user_id, doc_type, file_name, file_mimetype, requires_signature, expiry_date, uploaded_by, uploaded_at, sign_status FROM employee_documents"),
        queryDB("SELECT id, name FROM users"),
        queryDB("SELECT * FROM document_signatures"),
        queryDB("SELECT document_id, status FROM document_signers").catch(() => [])
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const signedIds = new Set<number>(signatures.map((s: any) => Number(s.document_id)));
      const scoped = manage ? rows : rows.filter((d: any) => Number(d.user_id) === Number(req.user.id));
      const sorted = scoped.sort((a: any, b: any) => Number(b.id) - Number(a.id));
      res.json(sorted.map((d: any) => listDocument(d, userById, signedIds, signerRows)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The Employee picker for Upload Document — every login-linked account
  // except the Superadmin, with its Employee ID when it has a directory row.
  // Its own endpoint (instead of GET /api/users) so an HR account granted
  // only document_vault, not the Users module, can still pick an employee.
  app.get("/api/employee-documents/people", ...adminGate, async (_req: any, res: any) => {
    try {
      const [users, employees]: [any, any] = await Promise.all([
        queryDB("SELECT id, name, role FROM users"),
        queryDB("SELECT * FROM all_employees")
      ]);
      const codeByUser = new Map<number, string>(
        employees.filter((e: any) => e.user_id != null).map((e: any): [number, string] => [Number(e.user_id), e.employee_id])
      );
      res.json(
        users
          .filter((u: any) => u.role !== "superadmin")
          .map((u: any) => ({ id: Number(u.id), name: u.name, employee_code: codeByUser.get(Number(u.id)) || null }))
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: upload a document against an employee — module-gated (only HR
  // uploads into the vault; an employee never uploads their own).
  app.post("/api/employee-documents", ...adminGate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const userId = Number(body.user_id);
      const docType = typeof body.doc_type === "string" ? body.doc_type.trim().slice(0, 100) : "";
      const fileName = typeof body.file_name === "string" ? body.file_name.trim().slice(0, 255) : "";
      const fileBase64 = typeof body.file_base64 === "string" ? body.file_base64 : "";
      if (!userId || !docType || !fileName || !fileBase64) {
        return res.status(400).json({ error: "Employee, document type and a file are required." });
      }
      const fileBuffer = Buffer.from(fileBase64, "base64");
      const fileMimetype = typeof body.file_mimetype === "string" ? body.file_mimetype : "application/octet-stream";
      const requiresSignature = !!body.requires_signature;
      const expiryDate = body.expiry_date || null;

      const result: any = await queryDB(
        `INSERT INTO employee_documents (user_id, doc_type, file_name, file_mimetype, file_data, requires_signature, expiry_date, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, docType, fileName, fileMimetype, fileBuffer, requiresSignature ? 1 : 0, expiryDate, req.user.id]
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM employee_documents WHERE id = ?", [Number(result.insertId)]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.status(201).json(listDocument(rows[0], userById, new Set()));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: download/preview the raw file — the owner themself, or a
  // document_vault-granted account.
  app.get("/api/employee-documents/:id/file", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const rows: any = await queryDB("SELECT * FROM employee_documents WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Document not found." });
      const doc = rows[0];
      const isOwner = Number(doc.user_id) === Number(req.user.id);
      // Someone asked to sign it (E-Signature, document_signers) may read it too.
      const isSigner = !isOwner && ((await queryDB("SELECT id FROM document_signers WHERE document_id = ? AND signer_user_id = ?", [id, req.user.id]).catch(() => [])) || []).length > 0;
      if (!isOwner && !isSigner && !(await canManage(req.user.id, req.user.role))) {
        return res.status(403).json({ error: "Not authorized." });
      }
      // E-Signature history: a signer / the employee opening it while it is
      // being signed (ESignRoutes.ts).
      // (once per person per 2 minutes — the reader and a download both open it).
      if ((isOwner || isSigner) && doc.sign_status === "pending") {
        const last: any[] = (await queryDB("SELECT event, user_id, at_iso FROM document_events WHERE document_id = ? ORDER BY seq DESC LIMIT 1", [id]).catch(() => [])) || [];
        const again = last[0] && last[0].event === "viewed" && Number(last[0].user_id) === Number(req.user.id) && Date.now() - new Date(last[0].at_iso).getTime() < 120_000;
        if (!again) await logDocEvent(queryDB, id, "viewed", { userId: Number(req.user.id), req });
      }
      if (!doc.file_data) return res.status(404).json({ error: "No file stored on this document." });
      const buffer: Buffer = Buffer.isBuffer(doc.file_data) ? doc.file_data : Buffer.from(doc.file_data);
      res.setHeader("Content-Type", doc.file_mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.file_name || `document_${doc.id}`)}"`);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE: module-gated.
  app.delete("/api/employee-documents/:id", ...adminGate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      await queryDB("DELETE FROM document_signatures WHERE document_id = ?", [id]);
      await queryDB("DELETE FROM employee_documents WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: the document's own employee signs it — a simple typed-full-name +
  // timestamp e-signature (no drawn-signature/PKI infrastructure here). Only
  // the named employee may sign; one signature per document (re-signing
  // just overwrites the name/timestamp).
  app.post("/api/employee-documents/:id/sign", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const rows: any = await queryDB("SELECT * FROM employee_documents WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Document not found." });
      const doc = rows[0];
      if (Number(doc.user_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "Only the employee this document belongs to can sign it." });
      }
      const signedName = typeof req.body?.signed_name === "string" ? req.body.signed_name.trim().slice(0, 255) : "";
      if (!signedName) return res.status(400).json({ error: "Type your full name to sign." });

      const allSignatures: any = await queryDB("SELECT * FROM document_signatures");
      const existing = allSignatures.find((s: any) => Number(s.document_id) === id);
      if (existing) {
        await queryDB("UPDATE document_signatures SET signed_name = ?, signed_at = ? WHERE id = ?", [
          signedName,
          new Date(),
          Number(existing.id)
        ]);
      } else {
        await queryDB("INSERT INTO document_signatures (document_id, signer_user_id, signed_name) VALUES (?, ?, ?)", [
          id,
          req.user.id,
          signedName
        ]);
      }
      res.json({ success: true, signed_name: signedName });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
