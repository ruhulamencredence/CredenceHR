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
//   5. Proof of who signed (each part switchable in E-Signature settings,
//      esign_settings, all OFF until turned on):
//      - OTP: a 6-digit code emailed to the signer, needed to sign (5 min,
//        one use, 5 wrong tries locks it for 15 min, kept only as a hash);
//        on for every document type or only some;
//      - read to the end: the signer must scroll the document to its end in
//        the in-app reader before signing (time spent is recorded);
//      always on:
//      - history: every step (sent, opened, read, code sent / wrong / right,
//        signed, declined, cancelled, completed, downloaded, checked on
//        /verify) with time, IP and device, each row hash-chained to the one
//        before (document_events) so a changed or deleted row shows; printed
//        on an Audit Trail page of the signed PDF;
//      - server seal: HMAC-SHA256 of the signed PDF's SHA-256 + the history
//        with ESIGN_SEAL_KEY (.env); /verify checks it.
//   6. Digital signature with a certificate (switch in E-Signature settings,
//      off until turned on): the finished PDF is also signed inside the file
//      with the company's certificate, so Adobe Reader shows it as signed and
//      catches any change by itself (ESignCertificate.ts).
//   7. Sent from where the document is made: an HR letter (HR Operations ->
//      Letters) or an exit's Clearance Certificate / Settlement Sheet becomes
//      a Document Vault document linked to it (source_type / source_id) and
//      is sent from the same Signatures popup.
//
// Access:
//   Admin Panel -> Document Vault (module "document_vault"): send a document
//   for the owner's own signature, see progress, cancel. Adding other
//   signers / an order is its own explicit-only layer "sign_request".
//   Self Service -> Documents to Sign: users.can_sign_documents, OFF by
//   default (Module Access). A signer must have it before HR can add them.
//   E-Signature settings: the explicit-only layer "esign_settings".
//   /verify/<code>: public by design (the point is that a bank or embassy
//   can check a document), and shows only the document type, the owner's
//   name, the signers and the dates — never the file.

import crypto from "crypto";
import type { Express } from "express";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import type { AlertType } from "./Alerts";
import { sendMail, isMailerConfigured } from "./mailer";
import { activeCompanyId } from "./companyContext";
import { activeCertificate, addSignaturePlaceholder, certFromEnvConfigured, ensureESignCertificateSchema, signPdfWith, type LoadedCert } from "./ESignCertificate";

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
  await run("employee_documents.seal", "ALTER TABLE employee_documents ADD COLUMN seal CHAR(64) NULL", ["ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"]);
  await run("employee_documents.events_head", "ALTER TABLE employee_documents ADD COLUMN events_head CHAR(64) NULL", ["ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"]);
  // Digital signature (ESignCertificate.ts) and where the document came from.
  for (const [c, def] of [
    ["pki_subject", "VARCHAR(255) NULL"],
    ["pki_issuer", "VARCHAR(255) NULL"],
    ["pki_self_signed", "TINYINT(1) NULL"],
    ["source_type", "VARCHAR(32) NULL"],
    ["source_id", "INT NULL"]
  ] as [string, string][]) {
    await run(`employee_documents.${c}`, `ALTER TABLE employee_documents ADD COLUMN ${c} ${def}`, ["ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"]);
  }
  await run("employee_documents source key", "ALTER TABLE employee_documents ADD INDEX idx_doc_source (source_type, source_id)", ["ER_DUP_KEYNAME", "ER_NO_SUCH_TABLE"]);
  await run(
    "esign_settings",
    `CREATE TABLE IF NOT EXISTS esign_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      otp_required TINYINT(1) NOT NULL DEFAULT 0,
      otp_doc_types TEXT NULL,
      require_read TINYINT(1) NOT NULL DEFAULT 0,
      updated_by INT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_esign_settings_company (company_id)
    )`
  );
  await run(
    "esign_otps",
    `CREATE TABLE IF NOT EXISTS esign_otps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      document_id INT NOT NULL,
      user_id INT NOT NULL,
      code_hash CHAR(64) NOT NULL,
      sent_to VARCHAR(255) NULL,
      expires_at DATETIME NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      locked_until DATETIME NULL,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      INDEX idx_esign_otps_doc_user (document_id, user_id),
      FOREIGN KEY (document_id) REFERENCES employee_documents(id) ON DELETE CASCADE
    )`
  );
  await run(
    "document_events",
    `CREATE TABLE IF NOT EXISTS document_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      document_id INT NOT NULL,
      seq INT NOT NULL,
      event VARCHAR(32) NOT NULL,
      user_id INT NULL,
      ip VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      detail VARCHAR(500) NULL,
      at_iso VARCHAR(32) NOT NULL,
      prev_hash CHAR(64) NOT NULL,
      hash CHAR(64) NOT NULL,
      UNIQUE KEY uniq_doc_event_seq (document_id, seq),
      FOREIGN KEY (document_id) REFERENCES employee_documents(id) ON DELETE CASCADE
    )`
  );
  await run("esign_settings.pki_sign", "ALTER TABLE esign_settings ADD COLUMN pki_sign TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
  await ensureESignCertificateSchema(dbPool);
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
  events?: { at: string; label: string; who: string; ip: string | null; device: string; detail: string | null }[];
  eventsHead?: string;
  sealed?: boolean;
  // Digital signature (ESignCertificate.ts): a note on the certificate page
  // and the signature's reserved place; the caller then signs the bytes.
  certificate?: { subject: string; organization: string | null; issuer: string; self_signed: boolean } | null;
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
    const f = fitText(font, v, 8.5, W - 40 - 160 - (y > 700 ? 110 : 0));
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
    "Each signer signed in the order shown, after signing in to CredenceHR with their own account.",
    ...(opts.certificate
      ? [
          `The PDF itself is digitally signed with the certificate of ${opts.certificate.subject}` +
            (opts.certificate.self_signed ? " (self-signed)." : `, issued by ${opts.certificate.issuer}.`),
          "A PDF reader (e.g. Adobe Reader) shows that signature and flags any change made after signing."
        ]
      : [])
  ];
  for (const n of notes) {
    cert.drawText(pdfText(n), { x: 40, y, size: 8, font, color: gray });
    y -= 12;
  }
  // Audit Trail: every step, hash-chained.
  if (opts.events && opts.events.length) {
    let page = pdf.addPage([595.28, 841.89]);
    let yy = 800;
    const head = () => {
      page.drawText("Audit Trail", { x: 40, y: yy, size: 18, font: bold, color: violet });
      yy -= 16;
      page.drawText(pdfText(`${opts.docType} · verification code ${opts.verifyCode}`), { x: 40, y: yy, size: 8.5, font, color: gray });
      yy -= 22;
      for (const [x, t] of [[40, "When (BST)"], [150, "What"], [300, "Who"], [430, "IP / device"]] as [number, string][]) page.drawText(t, { x, y: yy, size: 8, font: bold, color: rgb(0.25, 0.25, 0.3) });
      yy -= 12;
    };
    head();
    for (const e of opts.events) {
      if (yy < 90) {
        page = pdf.addPage([595.28, 841.89]);
        yy = 800;
        head();
      }
      page.drawLine({ start: { x: 40, y: yy + 9 }, end: { x: 555, y: yy + 9 }, thickness: 0.3, color: rgb(0.88, 0.88, 0.92) });
      const cell = (f: PDFFont, text: string, size: number, width: number, x: number, color = rgb(0.15, 0.15, 0.2)) => {
        const t = fitText(f, text, size, width);
        page.drawText(t.s, { x, y: yy, size: t.sz, font: f, color });
      };
      cell(font, dhaka(e.at).replace(" (BST)", ""), 7.5, 105, 40);
      cell(bold, e.label, 7.5, 145, 150);
      cell(font, e.who, 7.5, 125, 300);
      cell(font, [e.ip, e.device].filter(Boolean).join(" · "), 7, 125, 430, gray);
      if (e.detail) {
        yy -= 10;
        cell(font, e.detail, 7, 405, 150, gray);
      }
      yy -= 14;
    }
    yy -= 10;
    if (yy < 80) {
      page = pdf.addPage([595.28, 841.89]);
      yy = 800;
    }
    page.drawText("History fingerprint (last hash of the chain)", { x: 40, y: yy, size: 8, font: bold, color: rgb(0.25, 0.25, 0.3) });
    yy -= 11;
    page.drawText(pdfText(opts.eventsHead || ""), { x: 40, y: yy, size: 7, font, color: gray });
    yy -= 14;
    page.drawText(
      pdfText(opts.sealed ? "Sealed by the CredenceHR server (HMAC-SHA256) - the verify page checks the seal." : "Not sealed by the server (no seal key set)."),
      { x: 40, y: yy, size: 8, font, color: gray }
    );
  }
  for (const p of pdf.getPages()) footer(p);
  pdf.setTitle(`${pdfText(opts.docType)} (signed)`);
  pdf.setProducer("CredenceHR E-Signature");
  pdf.setCreator("CredenceHR");
  if (opts.certificate) {
    addSignaturePlaceholder(pdf, opts.certificate, `Signed by ${opts.signers.map((s) => pdfText(s.signed_name)).join(", ")} in CredenceHR (verification code ${opts.verifyCode})`);
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  }
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------
// History (hash-chained) and server seal
// ---------------------------------------------------------------------------
export const EVENT_LABEL: Record<string, string> = {
  sent: "Sent for signing",
  notified: "Told it is their turn",
  viewed: "Opened the document",
  read: "Read it to the end",
  otp_sent: "Sign-in code sent",
  otp_wrong: "Wrong code entered",
  otp_locked: "Code locked (too many wrong tries)",
  otp_ok: "Code confirmed",
  signed: "Signed",
  declined: "Declined",
  cancelled: "Signing cancelled",
  completed: "Signed by everyone — signed PDF made",
  downloaded: "Downloaded the signed PDF",
  verified_view: "Looked up on the verify page",
  verified_check: "A copy was checked on the verify page"
};
export const reqMeta = (req: any) => ({
  ip: req ? String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 64) || null : null,
  ua: req ? String(req.headers?.["user-agent"] || "").slice(0, 255) || null : null
});
const ZERO = "0".repeat(64);
const eventHash = (r: { document_id: number; seq: number; event: string; user_id: number | null; ip: string | null; user_agent: string | null; detail: string | null; at_iso: string; prev_hash: string }) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([Number(r.document_id), Number(r.seq), r.event, r.user_id == null ? null : Number(r.user_id), r.ip || null, r.user_agent || null, r.detail || null, r.at_iso, r.prev_hash]))
    .digest("hex");

export async function loadDocEvents(queryDB: QueryDB, docId: number): Promise<any[]> {
  return ((await queryDB("/*unscoped*/ SELECT * FROM document_events WHERE document_id = ? ORDER BY seq", [docId]).catch(() => [])) || []) as any[];
}
// Every row's hash re-made from its own fields and the row before it.
export function checkEventChain(rows: any[]): { ok: boolean; broken_at: number | null; head: string } {
  let prev = ZERO;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (Number(r.seq) !== i + 1 || r.prev_hash !== prev || eventHash(r) !== r.hash) return { ok: false, broken_at: i + 1, head: prev };
    prev = r.hash;
  }
  return { ok: true, broken_at: null, head: prev };
}
// One history row; never throws (a failed log must not undo the action).
export async function logDocEvent(queryDB: QueryDB, docId: number, event: string, opts: { userId?: number | null; req?: any; detail?: string | null } = {}) {
  const { ip, ua } = reqMeta(opts.req);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const last: any[] = (await queryDB("/*unscoped*/ SELECT seq, hash FROM document_events WHERE document_id = ? ORDER BY seq DESC LIMIT 1", [docId])) || [];
      const row = {
        document_id: docId,
        seq: last.length ? Number(last[0].seq) + 1 : 1,
        event,
        user_id: opts.userId ?? null,
        ip,
        user_agent: ua,
        detail: opts.detail ? String(opts.detail).slice(0, 500) : null,
        at_iso: new Date().toISOString(),
        prev_hash: last.length ? String(last[0].hash) : ZERO
      };
      await queryDB(
        "INSERT INTO document_events (document_id, seq, event, user_id, ip, user_agent, detail, at_iso, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [row.document_id, row.seq, row.event, row.user_id, row.ip, row.user_agent, row.detail, row.at_iso, row.prev_hash, eventHash(row)]
      );
      return;
    } catch (err: any) {
      if (err?.code !== "ER_DUP_ENTRY") {
        console.warn(`⚠️ E-Signature history (${event}): ${err?.message || err}`);
        return;
      }
    }
  }
}
// Server seal over the signed PDF and its history at signing time.
const sealKey = () => String(process.env.ESIGN_SEAL_KEY || "").trim();
export const sealOf = (signedSha: string, head: string, code: string) =>
  sealKey() ? crypto.createHmac("sha256", sealKey()).update(`${signedSha}|${head}|${code}`).digest("hex") : null;
const shortUa = (ua: string | null) => {
  const s = String(ua || "");
  const os = /Android/i.test(s) ? "Android" : /iPhone|iPad/i.test(s) ? "iOS" : /Windows/i.test(s) ? "Windows" : /Mac OS/i.test(s) ? "Mac" : /Linux/i.test(s) ? "Linux" : "";
  const br = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" on ") || (s ? s.slice(0, 40) : "");
};
const maskEmail = (e: string) => {
  const [u, d] = String(e).split("@");
  return d ? `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d}` : e;
};

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

  // ---- settings (esign_settings, one row per company; all off by default) ----
  async function loadSettings() {
    const rows: any[] = (await queryDB("SELECT * FROM esign_settings LIMIT 1").catch(() => [])) || [];
    const r = rows[0];
    let types: string[] = [];
    try {
      types = r?.otp_doc_types ? JSON.parse(r.otp_doc_types) : [];
    } catch {
      types = [];
    }
    return {
      otp_required: Number(r?.otp_required) === 1,
      otp_doc_types: Array.isArray(types) ? types.map(String) : [],
      require_read: Number(r?.require_read) === 1,
      pki_sign: Number(r?.pki_sign) === 1
    };
  }
  // ---- certificate (ESignCertificate.ts) ----
  const companyName = async () => {
    const rows: any[] = (await queryDB("/*unscoped*/ SELECT name FROM companies WHERE id = ?", [activeCompanyId()]).catch(() => [])) || [];
    return String(rows[0]?.name || "CredenceHR");
  };
  const certificate = (create = false) => activeCertificate(queryDB, companyName, create);
  const certView = (c: LoadedCert | null) => (c ? c.info : null);
  const otpNeeded = (st: Awaited<ReturnType<typeof loadSettings>>, docType: string) => st.otp_required && (!st.otp_doc_types.length || st.otp_doc_types.includes(String(docType)));
  // The signer's "read to the end" since the document was last sent.
  async function hasRead(docId: number, userId: number) {
    const ev = await loadDocEvents(queryDB, docId);
    const lastSent = [...ev].reverse().find((e) => e.event === "sent");
    return ev.some((e) => e.event === "read" && Number(e.user_id) === userId && (!lastSent || Number(e.seq) > Number(lastSent.seq)));
  }
  const otpSecret = () => sealKey() || "credencehr-esign";
  const otpHash = (docId: number, userId: number, code: string) => crypto.createHash("sha256").update(`${docId}|${userId}|${code}|${otpSecret()}`).digest("hex");

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
          : "SELECT id, user_id, doc_type, file_name, file_mimetype, requires_signature, sha256, verify_code, sign_status, sign_placement, signed_sha256, sign_requested_by, sign_requested_at, completed_at, uploaded_at, pki_subject, pki_issuer, pki_self_signed, source_type, source_id FROM employee_documents WHERE id = ?",
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
      signers: signers.map((s) => signerView(s, users)),
      otp_required: otpNeeded(await loadSettings(), doc.doc_type),
      require_read: (await loadSettings()).require_read,
      certificate: doc.pki_subject ? { subject: doc.pki_subject, issuer: doc.pki_issuer || null, self_signed: Number(doc.pki_self_signed) === 1 } : null,
      source_type: doc.source_type || null,
      source_id: doc.source_id == null ? null : Number(doc.source_id)
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
        "UPDATE employee_documents SET requires_signature = 1, sha256 = ?, verify_code = ?, sign_status = 'pending', sign_placement = ?, signed_file = NULL, signed_sha256 = NULL, sign_requested_by = ?, sign_requested_at = ?, completed_at = NULL, pki_subject = NULL, pki_issuer = NULL, pki_self_signed = NULL WHERE id = ?",
        [sha256(file), code, placement, req.user.id, new Date(), id]
      );
      const owner = (await usersByIds([Number(doc.user_id)])).get(Number(doc.user_id));
      await logDocEvent(queryDB, id, "sent", {
        userId: Number(req.user.id),
        req,
        detail: `To ${signers.map((s, i) => `${i + 1}. ${users.get(s.user_id).name}${s.label ? ` (${s.label})` : ""}`).join(", ")} · original SHA-256 ${sha256(file)}`
      });
      await notify(signers[0].user_id, "Document waiting for your signature", `${doc.doc_type} of ${owner?.name || "an employee"}. Open Self Service → Documents to Sign.`, id);
      await logDocEvent(queryDB, id, "notified", { detail: users.get(signers[0].user_id).name });
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
      await logDocEvent(queryDB, id, "cancelled", { userId: Number(req.user.id), req });
      res.json(await docView(await loadDoc(id)));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Sent from where the document is made (HR letters, exit documents) ----
  // The page makes the PDF (the same one it downloads) and sends it here; it
  // becomes a Document Vault document of that employee, linked to its source,
  // and is then sent from the usual Signatures popup. The owner is always
  // looked up here, never taken from the page.
  const SOURCE_TYPES: Record<string, { docType: (given: string) => string; owner: (id: number) => Promise<number | null> }> = {
    hr_letter: {
      docType: (given) => given || "HR Letter",
      owner: async (id) => {
        const l: any[] = (await queryDB("SELECT employee_id, status FROM hr_letters WHERE id = ?", [id])) || [];
        if (!l.length) throw bad("Letter not found.", 404);
        if (l[0].status === "cancelled") throw bad("This letter is cancelled.");
        const e: any[] = (await queryDB("SELECT user_id FROM all_employees WHERE id = ?", [Number(l[0].employee_id)])) || [];
        return e[0]?.user_id ? Number(e[0].user_id) : null;
      }
    },
    exit_clearance: { docType: () => "Clearance Certificate", owner: async (id) => exitOwner(id) },
    exit_settlement: { docType: () => "Full & Final Settlement", owner: async (id) => exitOwner(id) }
  };
  async function exitOwner(id: number) {
    const r: any[] = (await queryDB("SELECT user_id, status FROM exit_requests WHERE id = ?", [id])) || [];
    if (!r.length) throw bad("Exit request not found.", 404);
    if (r[0].status === "cancelled") throw bad("This exit is cancelled.");
    return r[0].user_id ? Number(r[0].user_id) : null;
  }
  // ?type=hr_letter -> the latest document of each source of that type.
  app.get("/api/esign/sources", ...adminGate, async (req: any, res) => {
    try {
      const type = String(req.query.type || "");
      if (!SOURCE_TYPES[type]) throw bad("Unknown document source.");
      const docs: any[] = (await queryDB("SELECT id, source_id, sign_status FROM employee_documents WHERE source_type = ?", [type])) || [];
      const ids = docs.map((d) => Number(d.id));
      const signers: any[] = ids.length ? (await queryDB(`SELECT document_id, status FROM document_signers WHERE document_id IN (${ids.map(() => "?").join(",")})`, ids)) || [] : [];
      const latest = new Map<number, any>();
      for (const d of docs) if (!latest.has(Number(d.source_id)) || Number(d.id) > Number(latest.get(Number(d.source_id)).id)) latest.set(Number(d.source_id), d);
      res.json(
        [...latest.values()].map((d) => {
          const mine = signers.filter((s) => Number(s.document_id) === Number(d.id));
          return { source_id: Number(d.source_id), document_id: Number(d.id), sign_status: d.sign_status || "none", signers_total: mine.length, signers_done: mine.filter((s) => s.status === "signed").length };
        })
      );
    } catch (err) {
      fail(res, err);
    }
  });
  // Body: { source_type, source_id, file_base64 (PDF), file_name, doc_type }.
  app.post("/api/esign/sources", ...adminGate, async (req: any, res) => {
    try {
      const type = String(req.body?.source_type || "");
      const src = SOURCE_TYPES[type];
      const sourceId = Number(req.body?.source_id);
      if (!src || !sourceId) throw bad("Unknown document source.");
      const ownerId = await src.owner(sourceId);
      if (!ownerId) throw bad("This employee has no login account, so they can't sign. Link one in Users first.");
      const prev: any[] = (await queryDB("SELECT id, sign_status FROM employee_documents WHERE source_type = ? AND source_id = ? ORDER BY id DESC LIMIT 1", [type, sourceId])) || [];
      // Already out for signing / signed: open that one, the file stays as signed.
      if (prev[0] && ["pending", "completed"].includes(prev[0].sign_status)) return res.json(await docView(await loadDoc(Number(prev[0].id))));
      const file = Buffer.from(String(req.body?.file_base64 || ""), "base64");
      if (file.length < 100 || file.subarray(0, 5).toString("latin1") !== "%PDF-") throw bad("The document must be a PDF.");
      if (file.length > 20 * 1024 * 1024) throw bad("The document is too big (at most 20 MB).");
      const fileName = String(req.body?.file_name || "").trim().slice(0, 255) || `document_${sourceId}.pdf`;
      const docType = src.docType(String(req.body?.doc_type || "").trim().slice(0, 100));
      let id: number;
      if (prev[0]) {
        // Never sent, declined or cancelled: send today's copy instead.
        id = Number(prev[0].id);
        await queryDB("UPDATE employee_documents SET file_data = ?, file_name = ?, file_mimetype = 'application/pdf', doc_type = ?, sign_status = 'none' WHERE id = ?", [file, fileName, docType, id]);
      } else {
        const r: any = await queryDB(
          "INSERT INTO employee_documents (user_id, doc_type, file_name, file_mimetype, file_data, requires_signature, uploaded_by, source_type, source_id) VALUES (?, ?, ?, 'application/pdf', ?, 1, ?, ?, ?)",
          [ownerId, docType, fileName, file, req.user.id, type, sourceId]
        );
        id = Number(r.insertId);
      }
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
      await logDocEvent(queryDB, id, "downloaded", { userId: me, req });
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
        out.push({ ...v, my_step: my?.step ?? null, my_status: my?.status ?? null, my_turn: v.sign_status === "pending" && my?.status === "pending", i_read: my ? await hasRead(id, me) : false });
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
      const settings = await loadSettings();
      if (settings.require_read && !(await hasRead(id, me))) throw bad("Read the document to the end first (Read).", 409);
      let image: Buffer;
      if (req.body?.image) image = readSignatureImage(req.body.image);
      else {
        const saved: any[] = (await queryDB("SELECT image FROM user_signatures WHERE user_id = ?", [me])) || [];
        const b = toBuffer(saved[0]?.image);
        if (!b) throw bad("Draw or upload your signature.");
        image = b;
      }
      // OTP last, once everything else is in order (a wrong code costs a try).
      if (otpNeeded(settings, doc.doc_type)) {
        const code = String(req.body?.otp || "").replace(/\D/g, "");
        const rows: any[] = (await queryDB("SELECT * FROM esign_otps WHERE document_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1", [id, me])) || [];
        const o = rows[0];
        const nowMs = Date.now();
        const t = (v: any) => new Date(String(v).replace(" ", "T")).getTime();
        if (!o || o.used_at) throw bad("Ask for a code first (Send code).", 400);
        if (o.locked_until && t(o.locked_until) > nowMs) throw bad("Too many wrong codes — try again in 15 minutes.", 429);
        if (t(o.expires_at) < nowMs) throw bad("The code has expired — send a new one.", 400);
        if (code.length !== 6) throw bad("Type the 6-digit code from your email.", 400);
        if (otpHash(id, me, code) !== o.code_hash) {
          const attempts = Number(o.attempts) + 1;
          const lock = attempts >= 5 ? new Date(nowMs + 15 * 60_000) : null;
          await queryDB("UPDATE esign_otps SET attempts = ?, locked_until = ? WHERE id = ?", [attempts, lock, Number(o.id)]);
          await logDocEvent(queryDB, id, lock ? "otp_locked" : "otp_wrong", { userId: me, req });
          throw bad(lock ? "Wrong code 5 times — locked for 15 minutes." : `Wrong code — ${5 - attempts} tries left.`, lock ? 429 : 400);
        }
        await queryDB("UPDATE esign_otps SET used_at = ? WHERE id = ?", [new Date(), Number(o.id)]);
        await logDocEvent(queryDB, id, "otp_ok", { userId: me, req });
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
      await logDocEvent(queryDB, id, "signed", { userId: me, req, detail: `As "${signedName}"${mine.label ? ` (${mine.label})` : ""} · signature image SHA-256 ${sha256(image).slice(0, 16)}…` });
      const next = signers.find((s) => Number(s.step_order) > Number(mine.step_order) && s.status === "waiting");
      const owner = (await usersByIds([Number(doc.user_id)])).get(Number(doc.user_id));
      if (next) {
        await queryDB("UPDATE document_signers SET status = 'pending' WHERE id = ?", [Number(next.id)]);
        await notify(Number(next.signer_user_id), "Document waiting for your signature", `${doc.doc_type} of ${owner?.name || "an employee"} — ${signedName} signed before you. Open Self Service → Documents to Sign.`, id);
        await logDocEvent(queryDB, id, "notified", { detail: (await usersByIds([Number(next.signer_user_id)])).get(Number(next.signer_user_id))?.name || null });
      } else {
        // Everyone signed: build the signed copy.
        const all = await signersOf(id);
        const evRows = await loadDocEvents(queryDB, id);
        const users = await usersByIds([...all.map((s) => Number(s.signer_user_id)), Number(doc.sign_requested_by), ...evRows.map((e) => Number(e.user_id)).filter(Boolean)]);
        const chain = checkEventChain(evRows);
        const pdfOpts: Parameters<typeof buildSignedPdf>[0] = {
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
          })),
          events: evRows.map((e) => ({
            at: e.at_iso,
            label: EVENT_LABEL[e.event] || e.event,
            who: e.user_id ? users.get(Number(e.user_id))?.name || `#${e.user_id}` : e.event === "notified" ? `to ${e.detail || ""}` : "—",
            ip: e.ip || null,
            device: shortUa(e.user_agent),
            detail: e.event === "notified" ? null : e.detail || null
          })),
          eventsHead: chain.head,
          sealed: !!sealKey()
        };
        // Digital signature with the company's certificate, when it is on. A
        // certificate problem never stops the signing — the PDF is then made
        // without it and the history says why.
        let pdf: Buffer | null = null;
        let pki: LoadedCert | null = null;
        let pkiNote = "";
        if (settings.pki_sign) {
          try {
            pki = await certificate(true);
            if (!pki) throw new Error("no certificate");
            if (pki.info.expired) throw new Error(`the certificate expired on ${pki.info.valid_to.slice(0, 10)}`);
            pdf = await signPdfWith(await buildSignedPdf({ ...pdfOpts, certificate: pki.info }), pki);
            pkiNote = ` · digitally signed with the certificate of ${pki.info.subject}${pki.info.self_signed ? " (self-signed)" : `, issued by ${pki.info.issuer}`}`;
          } catch (err: any) {
            console.warn(`⚠️ E-Signature certificate (document ${id}): ${err?.message || err}`);
            pdf = null;
            pki = null;
            pkiNote = ` · NOT digitally signed with the certificate: ${String(err?.message || err).slice(0, 200)}`;
          }
        }
        if (!pdf) pdf = await buildSignedPdf(pdfOpts);
        const signedSha = sha256(pdf);
        await queryDB(
          "UPDATE employee_documents SET signed_file = ?, signed_sha256 = ?, sign_status = 'completed', completed_at = ?, events_head = ?, seal = ?, pki_subject = ?, pki_issuer = ?, pki_self_signed = ? WHERE id = ?",
          [pdf, signedSha, now, chain.head, sealOf(signedSha, chain.head, doc.verify_code), pki?.info.subject ?? null, pki?.info.issuer ?? null, pki ? (pki.info.self_signed ? 1 : 0) : null, id]
        );
        await logDocEvent(queryDB, id, "completed", { detail: `Signed PDF SHA-256 ${signedSha}${pkiNote}` });
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
      await logDocEvent(queryDB, id, "declined", { userId: me, req, detail: reason });
      const who = (await usersByIds([me])).get(me);
      await notify(Number(doc.sign_requested_by), "Signature declined", `${who?.name || "A signer"} declined to sign ${doc.doc_type}: ${reason}`, id);
      res.json(await docView(await loadDoc(id)));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- E-Signature settings (layer "esign_settings") ----
  app.get("/api/esign/settings", ...adminGate, async (req: any, res) => {
    try {
      const types: any[] = (await queryDB("SELECT DISTINCT doc_type FROM employee_documents").catch(() => [])) || [];
      res.json({
        ...(await loadSettings()),
        can_edit: await hasModuleLayer(req.user, "document_vault", "esign_settings"),
        email_ready: isMailerConfigured(),
        seal_ready: !!sealKey(),
        ...(await (async () => {
          try {
            return { certificate: certView(await certificate(false)), certificate_error: null as string | null, cert_from_env: certFromEnvConfigured() };
          } catch (err: any) {
            return { certificate: null, certificate_error: String(err?.message || err), cert_from_env: true };
          }
        })()),
        doc_types: [...new Set(types.map((t) => String(t.doc_type)).filter(Boolean))].sort()
      });
    } catch (err) {
      fail(res, err);
    }
  });
  app.put("/api/esign/settings", ...adminGate, async (req: any, res) => {
    try {
      if (!(await hasModuleLayer(req.user, "document_vault", "esign_settings"))) throw bad("You don't have permission to change the E-Signature settings.", 403);
      const otp = !!req.body?.otp_required;
      if (otp && !isMailerConfigured()) throw bad("Email isn't set up on the server (SMTP_HOST / SMTP_USER / SMTP_PASS in .env), so codes can't be sent. Set it up first.");
      const types = Array.isArray(req.body?.otp_doc_types) ? [...new Set(req.body.otp_doc_types.map((t: any) => String(t).trim().slice(0, 100)).filter(Boolean))].slice(0, 50) : [];
      const read = !!req.body?.require_read;
      // Not sent by an older screen -> keep what is saved.
      const pkiOn = req.body?.pki_sign === undefined ? (await loadSettings()).pki_sign : !!req.body.pki_sign;
      if (pkiOn) {
        // Turning it on makes sure there is a certificate that works (the
        // company's self-signed one is made now when none is set in .env).
        let c: LoadedCert | null = null;
        try {
          c = await certificate(true);
        } catch (err: any) {
          throw bad(`The certificate can't be used: ${err?.message || err}`);
        }
        if (!c) throw bad("No certificate could be made.");
        if (c.info.expired) throw bad(`The certificate expired on ${c.info.valid_to.slice(0, 10)} — put a new one in ESIGN_CERT_FILE.`);
      }
      const cur: any[] = (await queryDB("SELECT id FROM esign_settings LIMIT 1").catch(() => [])) || [];
      if (cur.length) await queryDB("UPDATE esign_settings SET otp_required = ?, otp_doc_types = ?, require_read = ?, pki_sign = ?, updated_by = ? WHERE id = ?", [otp ? 1 : 0, JSON.stringify(types), read ? 1 : 0, pkiOn ? 1 : 0, req.user.id, Number(cur[0].id)]);
      else await queryDB("INSERT INTO esign_settings (otp_required, otp_doc_types, require_read, pki_sign, updated_by) VALUES (?, ?, ?, ?, ?)", [otp ? 1 : 0, JSON.stringify(types), read ? 1 : 0, pkiOn ? 1 : 0, req.user.id]);
      res.json(await loadSettings());
    } catch (err) {
      fail(res, err);
    }
  });

  // The public half of the certificate (.cer), e.g. for a bank that wants to
  // add the company's self-signed certificate to Adobe's trusted list.
  app.get("/api/esign/certificate.cer", ...adminGate, async (_req: any, res) => {
    try {
      const c = await certificate(false);
      if (!c) throw bad("There is no certificate yet — turn on Digital signature in E-Signature settings.", 404);
      res.setHeader("Content-Type", "application/x-x509-ca-cert");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`${c.info.subject} e-signature certificate.cer`)}"`);
      res.send(c.pem);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- OTP: a 6-digit code to the signer's email ----
  app.post("/api/esign/documents/:id/otp", authenticateToken, requireSigner, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const me = Number(req.user.id);
      const doc = await loadDoc(id);
      if (doc.sign_status !== "pending") throw bad("This document isn't waiting for signatures.");
      const mine = (await signersOf(id)).find((s) => Number(s.signer_user_id) === me);
      if (!mine || mine.status !== "pending") throw bad("It isn't your turn to sign this document.", 403);
      if (!otpNeeded(await loadSettings(), doc.doc_type)) throw bad("No code is needed for this document.");
      const nowMs = Date.now();
      const t = (v: any) => new Date(String(v).replace(" ", "T")).getTime();
      const recent: any[] = (await queryDB("SELECT * FROM esign_otps WHERE document_id = ? AND user_id = ? ORDER BY id DESC LIMIT 6", [id, me])) || [];
      if (recent[0]?.locked_until && t(recent[0].locked_until) > nowMs) throw bad("Too many wrong codes — try again in 15 minutes.", 429);
      if (recent[0] && nowMs - t(recent[0].created_at) < 60_000) throw bad("A code was just sent — wait a minute before asking again.", 429);
      if (recent.filter((o) => nowMs - t(o.created_at) < 3600_000).length >= 5) throw bad("Too many codes this hour — try again later.", 429);
      const u: any[] = (await queryDB("SELECT email, name FROM users WHERE id = ?", [me])) || [];
      const email = String(u[0]?.email || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("Your account has no email address to send the code to. Ask HR to add it.");
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const r: any = await queryDB(
        "INSERT INTO esign_otps (document_id, user_id, code_hash, sent_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [id, me, otpHash(id, me, code), maskEmail(email), new Date(nowMs + 5 * 60_000), new Date(nowMs)]
      );
      const sent = await sendMail({
        to: email,
        subject: `${code} is your signing code`,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e1b4b">
          <p>Hello ${String(u[0]?.name || "").replace(/[<>&]/g, "")},</p>
          <p>Your code to sign <b>${String(doc.doc_type).replace(/[<>&]/g, "")}</b> in CredenceHR is:</p>
          <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
          <p>It works once, for 5 minutes. If you didn't ask to sign anything, don't share it and tell HR.</p></div>`
      });
      if (!sent.success) {
        await queryDB("DELETE FROM esign_otps WHERE id = ?", [Number(r.insertId)]);
        throw bad(`The code couldn't be emailed: ${sent.error}`, 502);
      }
      await logDocEvent(queryDB, id, "otp_sent", { userId: me, req, detail: `By email to ${maskEmail(email)}` });
      res.json({ sent_to: maskEmail(email), expires_in: 300 });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- "Read to the end" from the in-app reader ----
  app.post("/api/esign/documents/:id/read", authenticateToken, requireSigner, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const me = Number(req.user.id);
      const doc = await loadDoc(id);
      if (doc.sign_status !== "pending") throw bad("This document isn't waiting for signatures.");
      if (!(await signersOf(id)).some((s) => Number(s.signer_user_id) === me)) throw bad("You aren't a signer of this document.", 403);
      const secs = Math.max(0, Math.min(86400, Math.round(Number(req.body?.seconds) || 0)));
      const pages = Math.max(0, Math.min(5000, Math.round(Number(req.body?.pages) || 0)));
      if (!(await hasRead(id, me))) await logDocEvent(queryDB, id, "read", { userId: me, req, detail: `${pages ? `${pages} page${pages === 1 ? "" : "s"}, ` : ""}${secs} seconds` });
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- History (Document Vault) ----
  app.get("/api/esign/documents/:id/events", ...adminGate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      await loadDoc(id);
      const rows = await loadDocEvents(queryDB, id);
      const chain = checkEventChain(rows);
      const users = await usersByIds(rows.map((r) => Number(r.user_id)).filter(Boolean));
      res.json({
        chain_ok: chain.ok,
        broken_at: chain.broken_at,
        events: rows.map((r) => ({
          seq: Number(r.seq),
          event: r.event,
          label: EVENT_LABEL[r.event] || r.event,
          user_name: r.user_id ? users.get(Number(r.user_id))?.name || null : null,
          ip: r.ip || null,
          device: shortUa(r.user_agent),
          detail: r.detail || null,
          at: r.at_iso
        }))
      });
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
        "/*unscoped*/ SELECT id, user_id, doc_type, sign_status, sha256, signed_sha256, sign_requested_at, completed_at, seal, events_head, verify_code, signed_file, pki_subject, pki_issuer, pki_self_signed FROM employee_documents WHERE verify_code = ?",
        [code]
      )) || [];
    const doc = rows[0];
    if (!doc || !["pending", "completed", "declined", "cancelled"].includes(doc.sign_status)) throw bad("No document has this verification code.", 404);
    const signers: any[] = (await queryDB("/*unscoped*/ SELECT step_order, signer_user_id, label, status, signed_name, signed_at FROM document_signers WHERE document_id = ? ORDER BY step_order", [Number(doc.id)])) || [];
    const ids = [Number(doc.user_id), ...signers.map((s) => Number(s.signer_user_id))];
    const users: any[] = (await queryDB(`/*unscoped*/ SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids)) || [];
    const nameOf = new Map<number, string>(users.map((u) => [Number(u.id), u.name]));
    // Integrity of what is on record: the stored signed PDF still has its
    // fingerprint, the history chain is unbroken, the server seal matches.
    const events = await loadDocEvents(queryDB, Number(doc.id));
    const chain = checkEventChain(events);
    const signedFile = toBuffer(doc.signed_file);
    const integrity =
      doc.sign_status === "completed"
        ? {
            file_ok: !!signedFile && sha256(signedFile) === doc.signed_sha256,
            history_ok: chain.ok && (!doc.events_head || events.some((e) => e.hash === doc.events_head)),
            seal: !doc.seal ? "none" : sealKey() ? (sealOf(doc.signed_sha256, doc.events_head || "", doc.verify_code) === doc.seal ? "valid" : "invalid") : "unknown"
          }
        : null;
    delete doc.signed_file;
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
        integrity,
        certificate:
          doc.sign_status === "completed" && doc.pki_subject
            ? { subject: doc.pki_subject, issuer: doc.pki_issuer || null, self_signed: Number(doc.pki_self_signed) === 1 }
            : null,
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
      const { doc, view } = await publicView(String(req.params.code || "").toUpperCase());
      await logDocEvent(queryDB, Number(doc.id), "verified_view", { req });
      res.json(view);
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
      await logDocEvent(queryDB, Number(doc.id), "verified_check", { req, detail: match === "signed" ? "Matched the signed copy" : match === "original" ? "Matched the unsigned original" : "Did NOT match" });
      res.json({ match, sha256: h });
    } catch (err) {
      fail(res, err);
    }
  });
}
