/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat attachments live in a folder on the server, not in the database.
// The database keeps only `chat_messages.attachment_path`, e.g.
// "image/2026/11/9f2c…e1.jpg": the first part says which folder (voice,
// image, video, document) and the rest is relative to that folder, so the
// folders can be moved by changing .env alone.
//
//   CHAT_ATTACHMENT_DIR   the main folder (default: ./uploads/chat). Inside
//                         it: voice/, image/, video/, document/.
//   CHAT_VOICE_DIR, CHAT_IMAGE_DIR, CHAT_VIDEO_DIR, CHAT_DOCUMENT_DIR
//                         optional: put one kind somewhere else.
//
// File names on disk are random (never the name the sender gave), and every
// path is checked to stay inside its folder. The folders are not served by
// the web server: a file is only sent by GET /api/chat/messages/:id/attachment
// to a member of that chat.

import fs from "fs";
import path from "path";
import crypto from "crypto";

export type ChatFileKind = "voice" | "image" | "video" | "document";
const KINDS: ChatFileKind[] = ["voice", "image", "video", "document"];
const ENV_OF: Record<ChatFileKind, string> = {
  voice: "CHAT_VOICE_DIR",
  image: "CHAT_IMAGE_DIR",
  video: "CHAT_VIDEO_DIR",
  document: "CHAT_DOCUMENT_DIR"
};

export function chatRootDir(): string {
  return path.resolve(process.env.CHAT_ATTACHMENT_DIR?.trim() || path.join(process.cwd(), "uploads", "chat"));
}

export function chatKindDir(kind: ChatFileKind): string {
  const own = process.env[ENV_OF[kind]]?.trim();
  return path.resolve(own || path.join(chatRootDir(), kind));
}

export function chatFileKind(mimetype: string | null | undefined, messageType?: string | null): ChatFileKind {
  const m = String(mimetype || "").toLowerCase();
  if (m.startsWith("audio/") || messageType === "audio") return "voice";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("image/") || messageType === "image") return "image";
  return "document";
}

// A short, safe extension: from the sender's file name if it is plain
// letters/digits, else from the type; never anything with a slash or dot.
function extensionFor(filename: string | null | undefined, mimetype: string | null | undefined): string {
  const fromName = path.extname(String(filename || "")).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const sub = String(mimetype || "").toLowerCase().split("/")[1]?.split(";")[0] || "";
  const clean = sub.replace(/^x-/, "").replace(/[^a-z0-9]/g, "");
  return clean.slice(0, 8) || "bin";
}

// The file on disk for a stored path, or null when the path is not one we
// wrote (unknown folder, "..", absolute…).
export function resolveChatPath(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = String(stored).split("/");
  const kind = parts.shift() as ChatFileKind;
  if (!KINDS.includes(kind) || !parts.length || parts.some((p) => !p || p === "." || p === "..")) return null;
  const base = chatKindDir(kind);
  const full = path.resolve(base, ...parts);
  return full.startsWith(base + path.sep) ? full : null;
}

// Writes the file and returns the path to keep in the database.
export async function saveChatFile(buffer: Buffer, mimetype: string | null | undefined, filename: string | null | undefined, messageType?: string | null): Promise<string> {
  const kind = chatFileKind(mimetype, messageType);
  const now = new Date();
  const rel = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), `${crypto.randomBytes(16).toString("hex")}.${extensionFor(filename, mimetype)}`];
  const dir = path.join(chatKindDir(kind), rel[0], rel[1]);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, rel[2]), buffer, { flag: "wx" });
  return [kind, ...rel].join("/");
}

// Removes a file once no message points at it any more (a forwarded copy
// shares the same file).
export async function removeChatFileIfUnused(queryDB: (sql: string, params?: any[]) => Promise<any>, stored: string | null | undefined): Promise<void> {
  const full = resolveChatPath(stored);
  if (!full) return;
  const still: any[] = (await queryDB("SELECT 1 FROM chat_messages WHERE attachment_path = ? LIMIT 1", [stored])) || [];
  if (still.length) return;
  await fs.promises.unlink(full).catch(() => {});
}

// One-time move of attachments saved in the database before this change:
// each is written to its folder, the row gets the path and its blob is
// cleared. Runs in the background a few at a time; with several server
// processes only the one holding the MySQL lock does it. A row whose file
// cannot be written keeps its blob and is still served from the database.
export async function moveOldChatAttachments(dbPool: any): Promise<void> {
  if (!dbPool) return;
  let conn: any;
  try {
    conn = await dbPool.getConnection();
    const [[lock]]: any = await conn.query("SELECT GET_LOCK('credence_chat_files_move', 0) AS got");
    if (!lock?.got) return;
    let moved = 0;
    let failed = 0;
    let lastId = 0;
    for (;;) {
      const [rows]: any = await conn.query(
        "SELECT id, message_type, attachment_filename, attachment_mimetype, attachment_data FROM chat_messages WHERE attachment_data IS NOT NULL AND attachment_path IS NULL AND id > ? ORDER BY id LIMIT 20",
        [lastId]
      );
      if (!rows.length) break;
      for (const r of rows) {
        lastId = r.id;
        try {
          const buf: Buffer = Buffer.isBuffer(r.attachment_data) ? r.attachment_data : Buffer.from(r.attachment_data);
          const stored = await saveChatFile(buf, r.attachment_mimetype, r.attachment_filename, r.message_type);
          const [res]: any = await conn.query("UPDATE chat_messages SET attachment_path = ?, attachment_data = NULL WHERE id = ? AND attachment_path IS NULL", [stored, r.id]);
          if (!res?.affectedRows) await fs.promises.unlink(resolveChatPath(stored)!).catch(() => {});
          else moved++;
        } catch {
          failed++;
        }
      }
    }
    if (moved || failed) console.log(`📁 Chat attachments moved to ${chatRootDir()}: ${moved}${failed ? `, ${failed} left in the database (folder not writable?)` : ""}`);
    await conn.query("SELECT RELEASE_LOCK('credence_chat_files_move')");
  } catch (err: any) {
    console.warn("⚠️ Could not move chat attachments to the folder: " + err.message);
  } finally {
    conn?.release?.();
  }
}
