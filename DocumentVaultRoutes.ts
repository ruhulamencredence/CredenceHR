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

  function listDocument(d: any, userById: Map<number, any>, signedIds: Set<number>) {
    return {
      id: Number(d.id),
      user_id: Number(d.user_id),
      user_name: userById.get(Number(d.user_id))?.name || null,
      doc_type: d.doc_type,
      file_name: d.file_name,
      file_mimetype: d.file_mimetype,
      requires_signature: !!Number(d.requires_signature),
      is_signed: signedIds.has(Number(d.id)),
      expiry_date: d.expiry_date,
      uploaded_at: d.uploaded_at
    };
  }

  // GET: a module-granted account sees every document; anyone else only
  // ever sees their own. Never includes file_data (see GET .../file below).
  app.get("/api/employee-documents", authenticateToken, async (req: any, res: any) => {
    try {
      const manage = await canManage(req.user.id, req.user.role);
      const [rows, users, signatures]: [any, any, any] = await Promise.all([
        queryDB("SELECT * FROM employee_documents"),
        queryDB("SELECT id, name FROM users"),
        queryDB("SELECT * FROM document_signatures")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const signedIds = new Set<number>(signatures.map((s: any) => Number(s.document_id)));
      const scoped = manage ? rows : rows.filter((d: any) => Number(d.user_id) === Number(req.user.id));
      const sorted = scoped.sort((a: any, b: any) => Number(b.id) - Number(a.id));
      res.json(sorted.map((d: any) => listDocument(d, userById, signedIds)));
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
      if (!isOwner && !(await canManage(req.user.id, req.user.role))) {
        return res.status(403).json({ error: "Not authorized." });
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
