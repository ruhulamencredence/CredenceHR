/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Scans / photos of the printed salary sheet that came back from the HR
// Director or the MD (Payroll -> Approval), kept as files in a folder, not
// in the database (same idea as chatFiles.ts / noticeFiles.ts):
//
//   PAYROLL_FILES_DIR   the folder (default: ./uploads/payroll), by year
//                       and month inside.
//
// Random names on disk, every path checked to stay inside the folder, never
// served as a public folder — only GET /api/payroll/approval/files/:id.

import fs from "fs";
import path from "path";
import crypto from "crypto";

export const PAYROLL_FILE_MAX_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function payrollFileExtension(mimetype: string): string | null {
  return TYPES[String(mimetype || "").toLowerCase().split(";")[0].trim()] || null;
}

// The first bytes must match the type (a renamed file is refused).
export function looksLikeType(buf: Buffer, mimetype: string): boolean {
  const m = String(mimetype || "").toLowerCase();
  if (m === "application/pdf") return buf.subarray(0, 5).toString("ascii") === "%PDF-";
  if (m === "image/png") return buf[0] === 0x89 && buf.subarray(1, 4).toString("ascii") === "PNG";
  if (m === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8;
  if (m === "image/webp") return buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

export function payrollRootDir(): string {
  return path.resolve(process.env.PAYROLL_FILES_DIR?.trim() || path.join(process.cwd(), "uploads", "payroll"));
}

export function resolvePayrollPath(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = String(stored).split("/");
  if (parts.length < 2 || parts.some((p) => !p || p === "." || p === "..")) return null;
  const base = payrollRootDir();
  const full = path.resolve(base, ...parts);
  return full.startsWith(base + path.sep) ? full : null;
}

export async function savePayrollFile(buffer: Buffer, ext: string): Promise<string> {
  const now = new Date();
  const rel = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), `${crypto.randomBytes(16).toString("hex")}.${ext}`];
  const dir = path.join(payrollRootDir(), rel[0], rel[1]);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, rel[2]), buffer, { flag: "wx" });
  return rel.join("/");
}

export async function removePayrollFile(stored: string | null | undefined): Promise<void> {
  const full = resolvePayrollPath(stored);
  if (full) await fs.promises.unlink(full).catch(() => {});
}
