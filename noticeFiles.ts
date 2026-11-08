/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Pictures and attachments of Notices live in a folder on the server, not in
// the database (same idea as chatFiles.ts). The database keeps only
// notice_files.file_path, e.g. "image/2026/11/9f2c…e1.png".
//
//   NOTICE_FILES_DIR   the folder (default: ./uploads/notices). Inside it:
//                      image/ and file/, by year and month.
//
// Names on disk are random (never the uploaded name), every path is checked
// to stay inside the folder, and the folder is not served by the web server:
// a file goes out only through GET /api/notices/files/:id (NoticeRoutes.ts).

import fs from "fs";
import path from "path";
import crypto from "crypto";

export type NoticeFileKind = "image" | "file";

export const NOTICE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const NOTICE_FILE_MAX_BYTES = 20 * 1024 * 1024;

// What may be uploaded, by type; anything else is refused.
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const FILE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  ...IMAGE_TYPES
};

export function noticeFileExtension(kind: NoticeFileKind, mimetype: string): string | null {
  const m = String(mimetype || "").toLowerCase().split(";")[0].trim();
  return (kind === "image" ? IMAGE_TYPES : FILE_TYPES)[m] || null;
}

// The first bytes of a picture must match its type (a renamed file is refused).
export function looksLikeImage(buf: Buffer, mimetype: string): boolean {
  const m = String(mimetype || "").toLowerCase();
  if (m === "image/png") return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (m === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8;
  if (m === "image/gif") return buf.subarray(0, 4).toString("ascii") === "GIF8";
  if (m === "image/webp") return buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

export function noticeRootDir(): string {
  return path.resolve(process.env.NOTICE_FILES_DIR?.trim() || path.join(process.cwd(), "uploads", "notices"));
}

export function resolveNoticePath(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = String(stored).split("/");
  if (!["image", "file"].includes(parts[0]) || parts.length < 2 || parts.some((p) => !p || p === "." || p === "..")) return null;
  const base = noticeRootDir();
  const full = path.resolve(base, ...parts);
  return full.startsWith(base + path.sep) ? full : null;
}

export async function saveNoticeFile(buffer: Buffer, kind: NoticeFileKind, ext: string): Promise<string> {
  const now = new Date();
  const rel = [kind, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), `${crypto.randomBytes(16).toString("hex")}.${ext}`];
  const dir = path.join(noticeRootDir(), ...rel.slice(0, 3));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, rel[3]), buffer, { flag: "wx" });
  return rel.join("/");
}

export async function removeNoticeFile(stored: string | null | undefined): Promise<void> {
  const full = resolveNoticePath(stored);
  if (full) await fs.promises.unlink(full).catch(() => {});
}
