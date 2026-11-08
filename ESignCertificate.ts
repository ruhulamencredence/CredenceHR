/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// E-Signature -> digital signature with a certificate (ESignRoutes.ts).
//
// When "Digital signature (certificate)" is on in E-Signature settings, the
// finished signed PDF is also signed inside the file with the company's
// certificate (PKCS#7 detached, the kind Adobe Reader shows in its blue/green
// "Signed and all signatures are valid" bar). Changing even one byte of the
// file afterwards breaks that signature in any PDF reader, without our
// /verify page.
//
// Which certificate:
//   - ESIGN_CERT_FILE + ESIGN_CERT_PASSWORD (.env): a .p12 / .pfx bought from
//     a licensed Certifying Authority (in Bangladesh: one licensed by the CCA).
//     Adobe then shows it as valid.
//   - otherwise a self-signed certificate in the company's name, made by the
//     server the first time it is needed and kept in esign_certificates. The
//     signature still catches any change, but Adobe says "validity unknown"
//     because nobody vouches for the certificate — it is for trying the
//     feature out until a real certificate is bought.

import fs from "fs";
import crypto from "crypto";
import forge from "node-forge";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { P12Signer } from "@signpdf/signer-p12";
import signpdfModule from "@signpdf/signpdf";
import type { PDFDocument } from "pdf-lib";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
const signpdf: any = (signpdfModule as any).default ?? signpdfModule;

export interface CertInfo {
  source: "file" | "self_signed";
  subject: string;
  organization: string | null;
  issuer: string;
  self_signed: boolean;
  valid_from: string;
  valid_to: string;
  expired: boolean;
  fingerprint: string;
}
export interface LoadedCert {
  p12: Buffer;
  passphrase: string;
  info: CertInfo;
  pem: string;
}

// Room for the signature in the PDF: a bought certificate's chain of 2-3
// certificates fits easily.
const SIGNATURE_LENGTH = 16384;

export async function ensureESignCertificateSchema(dbPool: any): Promise<void> {
  try {
    await dbPool.query(`CREATE TABLE IF NOT EXISTS esign_certificates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      p12 MEDIUMBLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_esign_cert_company (company_id)
    )`);
  } catch (err: any) {
    console.warn(`⚠️ E-Signature (esign_certificates): ${err.message}`);
  }
}

const attr = (c: forge.pki.Certificate["subject"], name: string) => (c.getField(name)?.value as string | undefined) || null;

// Opens a .p12 and finds the certificate that belongs to its private key.
function openP12(p12: Buffer, passphrase: string, source: CertInfo["source"]): LoadedCert {
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(p12.toString("binary")), passphrase);
  } catch (err: any) {
    throw new Error(/MAC|password|Invalid/i.test(String(err?.message)) ? "The certificate's password is wrong." : `The certificate file can't be read (${err?.message || err}).`);
  }
  const keyBag =
    parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ||
    parsed.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const key = keyBag?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new Error("The certificate file has no private key — export it again with the private key (.p12 / .pfx).");
  const certs = (parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean) as forge.pki.Certificate[];
  const cert = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals?.(key.n)) || certs[0];
  if (!cert) throw new Error("The certificate file has no certificate in it.");
  const subject = attr(cert.subject, "CN") || attr(cert.subject, "O") || "—";
  const issuer = attr(cert.issuer, "CN") || attr(cert.issuer, "O") || "—";
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    p12,
    passphrase,
    pem: forge.pki.certificateToPem(cert),
    info: {
      source,
      subject,
      organization: attr(cert.subject, "O"),
      issuer,
      self_signed: cert.isIssuer(cert),
      valid_from: cert.validity.notBefore.toISOString(),
      valid_to: cert.validity.notAfter.toISOString(),
      expired: cert.validity.notAfter.getTime() < Date.now(),
      fingerprint: crypto.createHash("sha256").update(Buffer.from(der, "binary")).digest("hex")
    }
  };
}

let fileCache: { key: string; cert: LoadedCert } | null = null;
export const certFromEnvConfigured = () => !!String(process.env.ESIGN_CERT_FILE || "").trim();
function certFromEnv(): LoadedCert {
  const file = String(process.env.ESIGN_CERT_FILE || "").trim();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`The certificate file in ESIGN_CERT_FILE (${file}) isn't there.`);
  }
  const key = `${file}|${stat.mtimeMs}|${process.env.ESIGN_CERT_PASSWORD || ""}`;
  if (fileCache?.key === key) return fileCache.cert;
  const cert = openP12(fs.readFileSync(file), String(process.env.ESIGN_CERT_PASSWORD || ""), "file");
  fileCache = { key, cert };
  return cert;
}

// The self-signed one is only as secret as the database it lives in, so its
// password just keeps it from being a bare key at rest.
const selfSignedPass = () => crypto.createHash("sha256").update(`credencehr-esign-selfsigned|${process.env.ESIGN_SEAL_KEY || ""}`).digest("hex").slice(0, 32);

function makeSelfSigned(companyName: string): Buffer {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
  cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400_000);
  const name = companyName.slice(0, 64) || "CredenceHR";
  const attrs = [
    { name: "commonName", value: name },
    { name: "organizationName", value: name },
    { shortName: "OU", value: "CredenceHR E-Signature (self-signed)" },
    { name: "countryName", value: "BD" }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "extKeyUsage", emailProtection: true }
  ]);
  cert.sign(key, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], selfSignedPass(), { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
}

// The certificate to sign with: the bought one from .env, else the company's
// self-signed one (made now when `create`). null = none yet.
export async function activeCertificate(queryDB: QueryDB, companyName: () => Promise<string>, create = false): Promise<LoadedCert | null> {
  if (certFromEnvConfigured()) return certFromEnv();
  const rows: any[] = (await queryDB("SELECT p12 FROM esign_certificates LIMIT 1").catch(() => [])) || [];
  if (rows[0]?.p12) {
    try {
      return openP12(Buffer.isBuffer(rows[0].p12) ? rows[0].p12 : Buffer.from(rows[0].p12), selfSignedPass(), "self_signed");
    } catch {
      // ESIGN_SEAL_KEY changed since it was made — make a new one below.
      if (!create) return null;
      await queryDB("DELETE FROM esign_certificates");
    }
  }
  if (!create) return null;
  await queryDB("INSERT INTO esign_certificates (p12) VALUES (?)", [makeSelfSigned(await companyName())]);
  return activeCertificate(queryDB, companyName, false);
}

// Reserve the signature's place; the PDF must then be saved without object
// streams (pdf.save({ useObjectStreams: false })).
export function addSignaturePlaceholder(pdf: PDFDocument, cert: Pick<CertInfo, "subject" | "organization">, reason: string) {
  pdflibAddPlaceholder({
    pdfDoc: pdf,
    reason,
    contactInfo: "",
    name: cert.organization || cert.subject,
    location: "Bangladesh",
    signatureLength: SIGNATURE_LENGTH,
    appName: "CredenceHR"
  });
}

export async function signPdfWith(pdf: Buffer, cert: LoadedCert): Promise<Buffer> {
  return Buffer.from(await signpdf.sign(pdf, new P12Signer(cert.p12, { passphrase: cert.passphrase })));
}
