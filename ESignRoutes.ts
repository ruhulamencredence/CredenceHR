/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// E-Signature on Document Vault documents (DocumentVaultRoutes.ts):
//
//   1. Signature image — every signer draws or uploads their signature
//      (user_signatures keeps it for next time).
//   2. Signed PDF — when the last signer signs, the signatures, names and
//      times are stamped onto the PDF (on a Signature Certificate page at the
//      end, or along the bottom of the last page too) with a verification
//      line on every page. A JPG / PNG document becomes a PDF page first.
//   3. Tamper check — the original's SHA-256 is fixed when the document is
//      sent for signing, every signature re-checks it, and the signed PDF's
//      SHA-256 is kept too. Anyone can open /verify/<code> (QR on the
//      certificate) to see who signed it and when, and drop in a copy of the
//      file to check it is the genuine one.
//   4. Several signers in order — e.g. Employee -> HR Manager -> MD; only the
//      signer whose turn it is can sign, the next one gets an alert.
//
// Access:
//   Admin Panel -> Document Vault (module "document_vault"): send a document
//   for the owner's own signature, see progress, cancel. Adding other
//   signers / an order is its own explicit-only layer "sign_request".
//   Self Service -> Documents to Sign: users.can_sign_documents, OFF by
//   default (Module Access). A signer must have it before HR can add them.
//   /verify/<code>: public by design (the point is that a bank or embassy
//   can check a document), and shows only the document type, the owner's
//   name, the signers and the dates — never the file.

import crypto from "crypto";
import type { Express } from "express";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import type { AlertType } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface RegisterESignRoutesDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  getAdminModules: (userId: number) => Promise<string[]>;
  queryDB: QueryDB;
  createAlert: (queryDB: QueryDB, params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export async function ensureESignSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ E-Signature (${label}): ${err.message}`);
    }
  };
  await run("users.can_sign_documents", "ALTER TABLE users ADD COLUMN can_sign_documents TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
  const cols: [string, string][] = [
    ["sha256", "CHAR(64) NULL"],
    ["verify_code", "VARCHAR(24) NULL"],
    ["sign_status", "VARCHAR(16) NOT NULL DEFAULT 'none'"],
    ["sign_placement", "VARCHAR(16) NOT NULL DEFAULT 'page'"],
    ["signed_file", "LONGBLOB NULL"],
    ["signed_sha256", "CHAR(64) NULL"],
    ["sign_requested_by", "INT NULL"],
    ["sign_requested_at", "DATETIME NULL"],
    ["completed_at", "DATETIME NULL"]
  ];
  for (const [c, def] of cols) await run(`employee_documents.${c}`, `ALTER TABLE employee_documents ADD COLUMN ${c} ${def}`, ["ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"]);
  await run("verify_code key", "ALTER TABLE employee_documents ADD UNIQUE KEY uniq_doc_verify_code (verify_code)", ["ER_DUP_KEYNAME", "ER_NO_SUCH_TABLE"]);
  await run(
    "user_signatures",
    `CREATE TABLE IF NOT EXISTS user_signatures (
      user_id INT NOT NULL PRIMARY KEY,
      image MEDIUMBLOB NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await run(
    "document_signers",
    `CREATE TABLE IF NOT EXISTS document_signers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      document_id INT NOT NULL,
      step_order INT NOT NULL,
      signer_user_id INT NOT NULL,
      label VARCHAR(100) NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'waiting',
      signed_name VARCHAR(255) NULL,
      signature_image MEDIUMBLOB NULL,
      signed_at DATETIME NULL,
      ip VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      decline_reason VARCHAR(500) NULL,
      UNIQUE KEY uniq_doc_step (document_id, step_order),
      INDEX idx_doc_signers_user (signer_user_id),
      FOREIGN KEY (document_id) REFERENCES employee_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (signer_user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export const sha256 = (buf: Buffer | Uint8Array) => crypto.createHash("sha256").update(buf).digest("hex");
const toBuffer = (v: any): Buffer | null => (v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v));
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newVerifyCode = () => {
  const bytes = crypto.randomBytes(12);
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
};
const SIGNABLE = (mime: string, name: string) => {
  const m = String(mime || "").toLowerCase();
  const n = String(name || "").toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m === "image/png" || n.endsWith(".png")) return "png";
  if (m === "image/jpeg" || m === "image/jpg" || /\.jpe?g$/.test(n)) return "jpg";
  return null;
};
// The standard PDF fonts only cover Latin-1.
const pdfText = (s: any) => String(s ?? "").replace(/[^\x20-\x7E -ÿ]/g, "?");
const dhaka = (d: any) =>
  d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) + " (BST)" : "";
const PNG_RE = /^data:image\/png;base64,/;
// A DATETIME read back as "YYYY-MM-DD HH:MM:SS" (server-local) -> ISO (UTC),
// so a browser in any timezone shows the right time.
const iso = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d.toISOString();
};

function publicBase(req: any) {
  const env = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  if (env) return env;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.get?.("host") || "").split(",")[0];
  return `${proto}://${host}`;
}

// Fit text into a width by shrinking, then cutting.
function fitText(font: PDFFont, text: string, size: number, width: number) {
  let s = pdfText(text);
  let sz = size;
  while (sz > 6 && font.widthOfTextAtSize(s, sz) > width) sz -= 0.5;
  while (s.length > 1 && font.widthOfTextAtSize(s, sz) > width) s = s.slice(0, -1);
  return { s, sz };
}

interface SignerForPdf {
  name: string;
  label: string | null;
  signed_name: string;
  signed_at: any;
  image: Buffer | null;
  ip: string | null;
}

// The signed copy: the original (a PDF, or an image made into a page) with a
// verification line on every page, the signatures along the bottom of the
// last page when asked, and a Signature Certificate page at the end.
export async function buildSignedPdf(opts: {
  file: Buffer;
  kind: "pdf" | "png" | "jpg";
  placement: "page" | "last_page";
  docType: string;
  fileName: string;
  ownerName: string;
  requestedBy: string;
  requestedAt: any;
  originalSha256: string;
  verifyCode: string;
  verifyUrl: string;
  signers: SignerForPdf[];
}): Promise<Buffer> {
  let pdf: PDFDocument;
  if (opts.kind === "pdf") {
    pdf = await PDFDocument.load(opts.file, { ignoreEncryption: true, updateMetadata: false });
  } else {
    pdf = await PDFDocument.create();
    const img = opts.kind === "png" ? await pdf.embedPng(opts.file) : await pdf.embedJpg(opts.file);
    const A4 = { w: 595.28, h: 841.89 };
    const scale = Math.min((A4.w - 60) / img.width, (A4.h - 90) / img.height, 1);
    const page = pdf.addPage([A4.w, A4.h]);
    page.drawImage(img, { x: (A4.w - img.width * scale) / 2, y: A4.h - 30 - img.height * scale, width: img.width * scale, height: img.height * scale });
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const gray = rgb(0.38, 0.4, 0.45);
  const violet = rgb(0.43, 0.0, 0.87);
  const images = await Promise.all(opts.signers.map(async (s) => (s.image ? pdf.embedPng(s.image).catch(() => null) : null)));
  const qrPng = await QRCode.toBuffer(opts.verifyUrl, { type: "png", margin: 1, width: 300, errorCorrectionLevel: "M" });
  const qr = await pdf.embedPng(qrPng);

  const footer = (page: PDFPage) => {
    const { width } = page.getSize();
    const line = `Digitally signed via CredenceHR  ·  Verification code ${opts.verifyCode}  ·  ${opts.verifyUrl}`;
    const f = fitText(font, line, 7, width - 40);
    page.drawRectangle({ x: 14, y: 6, width: width - 28, height: 13, color: rgb(1, 1, 1), opacity: 0.85 });
    page.drawText(f.s, { x: 20, y: 10, size: f.sz, font, color: gray });
  };

  // Signatures along the bottom of the last original page.
  if (opts.placement === "last_page") {
    const pages = pdf.getPages();
    const last = pages[pages.length - 1];
    const { width } = last.getSize();
    const perRow = Math.min(4, opts.signers.length);
    const rows = Math.ceil(opts.signers.length / perRow);
    const boxW = (width - 40 - (perRow - 1) * 8) / perRow;
    const boxH = 70;
    opts.signers.forEach((s, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const x = 20 + c * (boxW + 8);
      const y = 24 + (rows - 1 - r) * (boxH + 6);
      last.drawRectangle({ x, y, width: boxW, height: boxH, color: rgb(1, 1, 1), opacity: 0.92, borderColor: rgb(0.85, 0.85, 0.9), borderWidth: 0.6 });
      const img = images[i];
      if (img) {
        const sc = Math.min((boxW - 12) / img.width, 30 / img.height);
        last.drawImage(img, { x: x + 6, y: y + 34, width: img.width * sc, height: img.height * sc });
      }
      const n = fitText(bold, s.signed_name, 8, boxW - 12);
      last.drawText(n.s, { x: x + 6, y: y + 22, size: n.sz, font: bold, color: rgb(0.1, 0.1, 0.15) });
      const l = fitText(font, s.label || "", 7, boxW - 12);
      if (l.s) last.drawText(l.s, { x: x + 6, y: y + 13, size: l.sz, font, color: gray });
      const t = fitText(font, dhaka(s.signed_at), 6.5, boxW - 12);
      last.drawText(t.s, { x: x + 6, y: y + 4, size: t.sz, font, color: gray });
    });
  }

  // Signature Certificate.
  const cert = pdf.addPage([595.28, 841.89]);
  const W = 595.28;
  let y = 800;
  cert.drawText("Signature Certificate", { x: 40, y, size: 20, font: bold, color: violet });
  y -= 18;
  cert.drawText("This document was signed electronically in CredenceHR.", { x: 40, y, size: 9, font, color: gray });
  cert.drawImage(qr, { x: W - 40 - 96, y: 720, width: 96, height: 96 });
  cert.drawText("Scan to verify", { x: W - 40 - 96 + 18, y: 708, size: 7.5, font, color: gray });
  y -= 30;
  const row = (k: string, v: string) => {
    cert.drawText(pdfText(k), { x: 40, y, size: 8.5, font: bold, color: rgb(0.25, 0.25, 0.3) });
    const f = fitText(font, v, 8.5, W - 40 - 160 - (y > 720 ? 110 : 0));
    cert.drawText(f.s, { x: 160, y, size: f.sz, font, color: rgb(0.1, 0.1, 0.15) });
    y -= 15;
  };
  row("Document", opts.docType);
  row("File", opts.fileName);
  row("Belongs to", opts.ownerName);
  row("Sent for signing by", `${opts.requestedBy}, ${dhaka(opts.requestedAt)}`);
  row("Verification code", opts.verifyCode);
  row("Verify at", opts.verifyUrl);
  cert.drawText("Original file SHA-256", { x: 40, y, size: 8.5, font: bold, color: rgb(0.25, 0.25, 0.3) });
  cert.drawText(opts.originalSha256, { x: 160, y, size: 7, font, color: rgb(0.1, 0.1, 0.15) });
  y -= 26;
  cert.drawText(`Signers (${opts.signers.length}), in order`, { x: 40, y, size: 11, font: bold, color: rgb(0.1, 0.1, 0.15) });
  y -= 10;
  opts.signers.forEach((s, i) => {
    const h = 64;
    y -= h;
    cert.drawRectangle({ x: 40, y, width: W - 80, height: h - 6, color: rgb(0.98, 0.97, 1), borderColor: rgb(0.88, 0.85, 0.95), borderWidth: 0.6 });
    cert.drawText(`${i + 1}`, { x: 50, y: y + h / 2 - 6, size: 14, font: bold, color: violet });
    const img = images[i];
    if (img) {
      const sc = Math.min(150 / img.width, 40 / img.height);
      cert.drawImage(img, { x: 72, y: y + 8, width: img.width * sc, height: img.height * sc });
    }
    const nx = 240;
    cert.drawText(pdfText(s.signed_name), { x: nx, y: y + 40, size: 10, font: bold, color: rgb(0.1, 0.1, 0.15) });
    cert.drawText(pdfText([s.label, s.name !== s.signed_name ? `account: ${s.name}` : ""].filter(Boolean).join("  ·  ")), { x: nx, y: y + 27, size: 8, font, color: gray });
    cert.drawText(pdfText(`Signed ${dhaka(s.signed_at)}${s.ip ? `  ·  IP ${s.ip}` : ""}`), { x: nx, y: y + 14, size: 8, font, color: gray });
  });
  y -= 24;
  const notes = [
    "How to check this document: open the link above (or scan the QR code) and drop in this PDF.",
    "If even one byte of the file was changed after signing, it will not match.",
    "Each signer signed in the order shown, after signing in to CredenceHR with their own account."
  ];
  for (const n of notes) {
    cert.drawText(pdfText(n), { x: 40, y, size: 8, font, color: gray });
    y -= 12;
  }
  for (const p of pdf.getPages()) footer(p);
  pdf.setTitle(`${pdfText(opts.docType)} (signed)`);
  pdf.setProducer("CredenceHR E-Signature");
  pdf.setCreator("CredenceHR");
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerESignRoutes(app: Express, deps: RegisterESignRoutesDeps) {
  const { authenticateToken, requireAdmin, requireModule, hasModuleLayer, getAdminModules, queryDB, createAlert } = deps;
  const adminGate = [authenticateToken, requireAdmin, requireModule("document_vault")];
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const notify = async (userId: number | null | undefined, title: string, message: string, docId: number) => {
    if (userId) await createAlert(queryDB, { userId: Number(userId), type: "document_sign", title, message, relatedType: "employee_document", relatedId: docId });
  };

  async function isVaultManager(user: any) {
    if (user.role === "superadmin") return true;
    if (user.role !== "admin" && user.role !== "user") return false;
    return (await getAdminModules(Number(user.id))).includes("document_vault");
  }
  async function canSignDocuments(userId: number) {
    const rows: any[] = (await queryDB("SELECT role, can_sign_documents, is_onboarding FROM users WHERE id = ?", [userId]).catch(() => [])) || [];
    const u = rows[0];
    return !!u && (u.role === "superadmin" || (Number(u.can_sign_documents) === 1 && !Number(u.is_onboarding)));
  }
  const requireSigner = async (req: any, res: any, next: any) => {
    if (!(await canSignDocuments(Number(req.user.id)))) return res.status(403).json({ error: "Documents to Sign isn't turned on for your account." });
    next();
  };
  async function loadDoc(id: number, withFile = false) {
    const rows: any[] =
      (await queryDB(
        withFile
          ? "SELECT * FROM employee_documents WHERE id = ?"
          : "SELECT id, user_id, doc_type, file_name, file_mimetype, requires_signature, sha256, verify_code, sign_status, sign_placement, signed_sha256, sign_requested_by, sign_requested_at, completed_at, uploaded_at FROM employee_documents WHERE id = ?",
        [id]
      )) || [];
    if (!rows.length) throw bad("Document not found.", 404);
    return rows[0];
  }
  async function signersOf(docId: number): Promise<any[]> {
    return ((await queryDB("SELECT * FROM document_signers WHERE document_id = ? ORDER BY step_order", [docId])) || []) as any[];
  }
  async function usersByIds(ids: number[]) {
    const uniq = [...new Set(ids.filter(Boolean).map(Number))];
    if (!uniq.length) return new Map<number, any>();
    const rows: any[] = (await queryDB(`SELECT id, name, role, can_sign_documents FROM users WHERE id IN (${uniq.map(() => "?").join(",")})`, uniq)) || [];
    return new Map<number, any>(rows.map((r) => [Number(r.id), r]));
  }
  const signerView = (s: any, users: Map<number, any>) => ({
    id: Number(s.id),
    step: Number(s.step_order),
    user_id: Number(s.signer_user_id),
    name: users.get(Number(s.signer_user_id))?.name || "—",
    label: s.label || null,
    status: s.status,
    signed_name: s.signed_name || null,
    signed_at: iso(s.signed_at),
    decline_reason: s.decline_reason || null
  });
  async function docView(doc: any) {
    const signers = await signersOf(Number(doc.id));
    const users = await usersByIds([...signers.map((s) => Number(s.signer_user_id)), Number(doc.user_id), Number(doc.sign_requested_by)]);
    return {
      id: Number(doc.id),
      doc_type: doc.doc_type,
      file_name: doc.file_name,
      owner_id: Number(doc.user_id),
      owner_name: users.get(Number(doc.user_id))?.name || null,
      sign_status: doc.sign_status || "none",
      placement: doc.sign_placement || "page",
      verify_code: doc.verify_code || null,
      sha256: doc.sha256 || null,
      signed_sha256: doc.signed_sha256 || null,
      requested_by: users.get(Number(doc.sign_requested_by))?.name || null,
      requested_at: iso(doc.sign_requested_at),
      completed_at: iso(doc.completed_at),
      has_signed_file: doc.sign_status === "completed",
      signers: signers.map((s) => signerView(s, users))
    };
  }

  // ---- HR (Document Vault) ----
  app.get("/api/esign/caps", ...adminGate, async (req: any, res) => {
    res.json({ can_request_others: await hasModuleLayer(req.user, "document_vault", "sign_request") });
  });

  // People who can be asked to sign (Documents to Sign turned on).
  app.get("/api/esign/signers", ...adminGate, async (_req: any, res) => {
    try {
      const rows: any[] = (await queryDB("SELECT id, name, role, can_sign_documents FROM users")) || [];
      res.json(
        rows
          .map((u) => ({ id: Number(u.id), name: u.name, can_sign: u.role === "superadmin" || Number(u.can_sign_documents) === 1 }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      );
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/esign/documents/:id", authenticateToken, async (req: any, res) => {
    try {
      const doc = await loadDoc(Number(req.params.id));
      const view = await docView(doc);
      const me = Number(req.user.id);
      if (!(await isVaultManager(req.user)) && view.owner_id !== me && !view.signers.some((s) => s.user_id === me)) throw bad("Not authorized.", 403);
      res.json(view);
    } catch (err) {
      fail(res, err);
    }
  });

  // Body: { signers: [{ user_id, label }], placement: "page" | "last_page" }.
  // Only the owner alone -> plain Document Vault access; anyone else or more
  // than one signer -> the "sign_request" layer.
  app.post("/api/esign/documents/:id/request", ...adminGate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const doc = await loadDoc(id, true);
      if (doc.sign_status === "pending") throw bad("This document is already out for signing — cancel that first.");
      if (doc.sign_status === "completed") throw bad("This document is already signed. Upload it again to sign a new version.");
      if (!SIGNABLE(doc.file_mimetype, doc.file_name)) throw bad("Only a PDF, JPG or PNG can be signed.");
      const file = toBuffer(doc.file_data);
      if (!file?.length) throw bad("No file stored on this document.");
      const list: any[] = Array.isArray(req.body?.signers) ? req.body.signers : [];
      const signers = list.map((s) => ({ user_id: Number(s?.user_id), label: String(s?.label || "").trim().slice(0, 100) || null })).filter((s) => s.user_id);
      if (!signers.length) throw bad("Add at least one signer.");
      if (signers.length > 10) throw bad("At most 10 signers.");
      if (new Set(signers.map((s) => s.user_id)).size !== signers.length) throw bad("The same person can't sign twice.");
      const onlyOwner = signers.length === 1 && signers[0].user_id === Number(doc.user_id);
      if (!onlyOwner && !(await hasModuleLayer(req.user, "document_vault", "sign_request"))) {
        throw bad("Asking anyone other than the employee themself to sign needs the 'Request signatures from others' permission.", 403);
      }
      const users = await usersByIds(signers.map((s) => s.user_id));
      const missing = signers.filter((s) => !users.has(s.user_id));
      if (missing.length) throw bad("One of the signers doesn't exist.");
      const off = signers.filter((s) => { const u = users.get(s.user_id); return u.role !== "superadmin" && Number(u.can_sign_documents) !== 1; });
      if (off.length) throw bad(`Turn on "Documents to Sign" for ${off.map((s) => users.get(s.user_id).name).join(", ")} in Module Access first.`);
      const placement = req.body?.placement === "last_page" ? "last_page" : "page";

      await queryDB("DELETE FROM document_signers WHERE document_id = ?", [id]);
      for (let i = 0; i < signers.length; i++) {
        await queryDB("INSERT INTO document_signers (document_id, step_order, signer_user_id, label, status) VALUES (?, ?, ?, ?, ?)", [id, i + 1, signers[i].user_id, signers[i].label, i === 0 ? "pending" : "waiting"]);
      }
      const code = doc.verify_code || newVerifyCode();
      await queryDB(
        "UPDATE employee_documents SET requires_signature = 1, sha256 = ?, verify_code = ?, sign_status = 'pending', sign_placement = ?, signed_file = NULL, signed_sha256 = NULL, sign_requested_by = ?, sign_requested_at = ?, completed_at = NULL WHERE id = ?",
        [sha256(file), code, placement, req.user.id, new Date(), id]
      );
      const owner = (await usersByIds([Number(doc.user_id)])).get(Number(doc.user_id));
      await notify(signers[0].user_id, "Document waiting for your signature", `${doc.doc_type} of ${owner?.name || "an employee"}. Open Self Service → Documents to Sign.`, id);
      res.json(await docView(await loadDoc(id)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/esign/documents/:id/cancel", ...adminGate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const doc = await loadDoc(id);
      if (doc.sign_status !== "pending") throw bad("Only a document that is out for signing can be cancelled.");
      await queryDB("UPDATE employee_documents SET sign_status = 'cancelled' WHERE id = ?", [id]);
      await queryDB("UPDATE document_signers SET status = 'cancelled' WHERE document_id = ? AND status IN ('pending', 'waiting')", [id]);
      res.json(await docView(await loadDoc(id)));
    } catch (err) {
      fail(res, err);
    }
  });

  // The signed PDF — owner, a signer, or Document Vault.
  app.get("/api/esign/documents/:id/signed", authenticateToken, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const doc = await loadDoc(id, true);
      const me = Number(req.user.id);
      const signers = await signersOf(id);
      if (!(await isVaultManager(req.user)) && Number(doc.user_id) !== me && !signers.some((s) => Number(s.signer_user_id) === me)) throw bad("Not authorized.", 403);
      const file = toBuffer(doc.signed_file);
      if (doc.sign_status !== "completed" || !file) throw bad("This document isn't signed by everyone yet.", 404);
      const base = String(doc.file_name || `document_${id}`).replace(/\.[^.]+$/, "");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(`${base} (signed).pdf`)}"`);
      res.send(file);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Self Service -> Documents to Sign ----
  app.get("/api/esign/my", authenticateToken, requireSigner, async (req: any, res) => {
    try {
      const me = Number(req.user.id);
      // Documents I am asked to sign, and my own documents sent for signing.
      const mine: any[] = (await queryDB("SELECT document_id FROM document_signers WHERE signer_user_id = ?", [me])) || [];
      const owned: any[] = (await queryDB("SELECT id FROM employee_documents WHERE user_id = ? AND sign_status <> 'none'", [me]).catch(() => [])) || [];
      const out = [];
      for (const id of [...new Set([...mine.map((m) => Number(m.document_id)), ...owned.map((o) => Number(o.id))])]) {
        const doc = await loadDoc(id).catch(() => null);
        if (!doc || doc.sign_status === "none") continue;
        const v = await docView(doc);
        const my = v.signers.find((s) => s.user_id === me) || null;
        out.push({ ...v, my_step: my?.step ?? null, my_status: my?.status ?? null, my_turn: v.sign_status === "pending" && my?.status === "pending" });
      }
      out.sort((a, b) => Number(b.my_turn) - Number(a.my_turn) || String(b.requested_at || "").localeCompare(String(a.requested_at || "")));
      res.json(out);
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/esign/my-signature", authenticateToken, requireSigner, async (req: any, res) => {
    try {
      const rows: any[] = (await queryDB("SELECT image, updated_at FROM user_signatures WHERE user_id = ?", [req.user.id])) || [];
      const img = toBuffer(rows[0]?.image);
      res.json({ image: img ? `data:image/png;base64,${img.toString("base64")}` : null, updated_at: rows[0]?.updated_at || null });
    } catch (err) {
      fail(res, err);
    }
  });
  const readSignatureImage = (v: any): Buffer => {
    const s = String(v || "");
    if (!PNG_RE.test(s)) throw bad("The signature must be a PNG image.");
    const buf = Buffer.from(s.replace(PNG_RE, ""), "base64");
    if (buf.length < 100) throw bad("The signature is empty — draw it first.");
    if (buf.length > 400 * 1024) throw bad("The signature image is too big (at most 400 KB).");
    if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw bad("The signature must be a PNG image.");
    return buf;
  };
  app.put("/api/esign/my-signature", authenticateToken, requireSigner, async (req: any, res) => {
    try {
      const buf = readSignatureImage(req.body?.image);
      await queryDB("INSERT INTO user_signatures (user_id, image) VALUES (?, ?) ON DUPLICATE KEY UPDATE image = VALUES(image)", [req.user.id, buf]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });
  app.delete("/api/esign/my-signature", authenticateToken, requireSigner, async (req: any, res) => {
    try {
      await queryDB("DELETE FROM user_signatures WHERE user_id = ?", [req.user.id]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Body: { signed_name, image (PNG data URL; empty = the saved one),
  // save_signature, agree: true }.
  app.post("/api/esign/documents/:id/sign", authenticateToken, requireSigner, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const me = Number(req.user.id);
      if (req.body?.agree !== true) throw bad("Tick that you have read the document and agree to sign it.");
      const signedName = String(req.body?.signed_name || "").trim().slice(0, 255);
      if (signedName.length < 2) throw bad("Type your full name.");
      const doc = await loadDoc(id, true);
      if (doc.sign_status !== "pending") throw bad("This document isn't waiting for signatures.");
      const signers = await signersOf(id);
      const mine = signers.find((s) => Number(s.signer_user_id) === me);
      if (!mine) throw bad("You aren't a signer of this document.", 403);
      if (mine.status !== "pending") throw bad(mine.status === "signed" ? "You have already signed this document." : "It isn't your turn to sign yet.", 409);
      const file = toBuffer(doc.file_data);
      if (!file || sha256(file) !== doc.sha256) throw bad("The document was changed after it was sent for signing, so it can't be signed. Ask HR to send it again.", 409);
      let image: Buffer;
      if (req.body?.image) image = readSignatureImage(req.body.image);
      else {
        const saved: any[] = (await queryDB("SELECT image FROM user_signatures WHERE user_id = ?", [me])) || [];
        const b = toBuffer(saved[0]?.image);
        if (!b) throw bad("Draw or upload your signature.");
        image = b;
      }
      if (req.body?.save_signature) await queryDB("INSERT INTO user_signatures (user_id, image) VALUES (?, ?) ON DUPLICATE KEY UPDATE image = VALUES(image)", [me, image]);
      const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 64) || null;
      const ua = String(req.headers["user-agent"] || "").slice(0, 255) || null;
      const now = new Date();
      // Only while it is still this signer's turn (a second click / tab can't sign twice).
      const upd: any = await queryDB(
        "UPDATE document_signers SET status = 'signed', signed_name = ?, signature_image = ?, signed_at = ?, ip = ?, user_agent = ? WHERE id = ? AND status = 'pending'",
        [signedName, image, now, ip, ua, Number(mine.id)]
      );
      if (upd && upd.affectedRows === 0) throw bad("You have already signed this document.", 409);
      const next = signers.find((s) => Number(s.step_order) > Number(mine.step_order) && s.status === "waiting");
      const owner = (await usersByIds([Number(doc.user_id)])).get(Number(doc.user_id));
      if (next) {
        await queryDB("UPDATE document_signers SET status = 'pending' WHERE id = ?", [Number(next.id)]);
        await notify(Number(next.signer_user_id), "Document waiting for your signature", `${doc.doc_type} of ${owner?.name || "an employee"} — ${signedName} signed before you. Open Self Service → Documents to Sign.`, id);
      } else {
        // Everyone signed: build the signed copy.
        const all = await signersOf(id);
        const users = await usersByIds([...all.map((s) => Number(s.signer_user_id)), Number(doc.sign_requested_by)]);
        const pdf = await buildSignedPdf({
          file,
          kind: SIGNABLE(doc.file_mimetype, doc.file_name)!,
          placement: doc.sign_placement === "last_page" ? "last_page" : "page",
          docType: doc.doc_type,
          fileName: doc.file_name,
          ownerName: owner?.name || "",
          requestedBy: users.get(Number(doc.sign_requested_by))?.name || "HR",
          requestedAt: doc.sign_requested_at,
          originalSha256: doc.sha256,
          verifyCode: doc.verify_code,
          verifyUrl: `${publicBase(req)}/verify/${doc.verify_code}`,
          signers: all.map((s) => ({
            name: users.get(Number(s.signer_user_id))?.name || "",
            label: s.label || null,
            signed_name: s.signed_name || "",
            signed_at: s.signed_at,
            image: toBuffer(s.signature_image),
            ip: s.ip || null
          }))
        });
        await queryDB("UPDATE employee_documents SET signed_file = ?, signed_sha256 = ?, sign_status = 'completed', completed_at = ? WHERE id = ?", [pdf, sha256(pdf), now, id]);
        const tell = new Set<number>([Number(doc.user_id), Number(doc.sign_requested_by)].filter(Boolean));
        for (const uid of tell) await notify(uid, "Document signed by everyone", `${doc.doc_type} of ${owner?.name || "an employee"} is signed. The signed PDF is ready.`, id);
      }
      res.json(await docView(await loadDoc(id)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/esign/documents/:id/decline", authenticateToken, requireSigner, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const me = Number(req.user.id);
      const reason = String(req.body?.reason || "").trim().slice(0, 500);
      if (!reason) throw bad("Say why you are declining.");
      const doc = await loadDoc(id);
      if (doc.sign_status !== "pending") throw bad("This document isn't waiting for signatures.");
      const mine = (await signersOf(id)).find((s) => Number(s.signer_user_id) === me);
      if (!mine || mine.status !== "pending") throw bad("It isn't your turn to sign this document.", 403);
      await queryDB("UPDATE document_signers SET status = 'declined', decline_reason = ?, signed_at = ? WHERE id = ?", [reason, new Date(), Number(mine.id)]);
      await queryDB("UPDATE employee_documents SET sign_status = 'declined' WHERE id = ?", [id]);
      const who = (await usersByIds([me])).get(me);
      await notify(Number(doc.sign_requested_by), "Signature declined", `${who?.name || "A signer"} declined to sign ${doc.doc_type}: ${reason}`, id);
      res.json(await docView(await loadDoc(id)));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Public verification (no sign-in) ----
  const hits = new Map<string, { n: number; at: number }>();
  const limited = (req: any) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.at > 60_000) {
      hits.set(ip, { n: 1, at: now });
      if (hits.size > 5000) hits.clear();
      return false;
    }
    h.n++;
    return h.n > 30;
  };
  const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  async function publicView(code: string) {
    if (!CODE_RE.test(code)) throw bad("That verification code isn't valid.", 404);
    const rows: any[] =
      (await queryDB(
        "/*unscoped*/ SELECT id, user_id, doc_type, sign_status, sha256, signed_sha256, sign_requested_at, completed_at FROM employee_documents WHERE verify_code = ?",
        [code]
      )) || [];
    const doc = rows[0];
    if (!doc || !["pending", "completed", "declined", "cancelled"].includes(doc.sign_status)) throw bad("No document has this verification code.", 404);
    const signers: any[] = (await queryDB("/*unscoped*/ SELECT step_order, signer_user_id, label, status, signed_name, signed_at FROM document_signers WHERE document_id = ? ORDER BY step_order", [Number(doc.id)])) || [];
    const ids = [Number(doc.user_id), ...signers.map((s) => Number(s.signer_user_id))];
    const users: any[] = (await queryDB(`/*unscoped*/ SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids)) || [];
    const nameOf = new Map<number, string>(users.map((u) => [Number(u.id), u.name]));
    return {
      doc,
      view: {
        code,
        doc_type: doc.doc_type,
        owner_name: nameOf.get(Number(doc.user_id)) || null,
        status: doc.sign_status,
        sent_at: iso(doc.sign_requested_at),
        completed_at: iso(doc.completed_at),
        signed_sha256: doc.signed_sha256 || null,
        original_sha256: doc.sha256 || null,
        signers: signers.map((s) => ({
          step: Number(s.step_order),
          name: s.status === "signed" ? s.signed_name || nameOf.get(Number(s.signer_user_id)) : nameOf.get(Number(s.signer_user_id)) || null,
          label: s.label || null,
          status: s.status,
          signed_at: s.status === "signed" ? iso(s.signed_at) : null
        }))
      }
    };
  }
  app.get("/api/public/verify/:code", async (req: any, res) => {
    try {
      if (limited(req)) throw bad("Too many checks — wait a minute.", 429);
      res.json((await publicView(String(req.params.code || "").toUpperCase())).view);
    } catch (err) {
      fail(res, err);
    }
  });
  // Body: { file_base64 } — does this copy match the signed one?
  app.post("/api/public/verify/:code/check", async (req: any, res) => {
    try {
      if (limited(req)) throw bad("Too many checks — wait a minute.", 429);
      const { doc } = await publicView(String(req.params.code || "").toUpperCase());
      const b64 = String(req.body?.file_base64 || "");
      if (!b64) throw bad("Choose the file to check.");
      const buf = Buffer.from(b64, "base64");
      if (buf.length > 20 * 1024 * 1024) throw bad("The file is too big.");
      const h = sha256(buf);
      const match = doc.signed_sha256 && h === doc.signed_sha256 ? "signed" : doc.sha256 && h === doc.sha256 ? "original" : "none";
      res.json({ match, sha256: h });
    } catch (err) {
      fail(res, err);
    }
  });
}
