// The Android app download on the login page (/downloads/CredenceHR.apk).
//
// Served by this route rather than as a plain static file, because both ways
// that went wrong ended with a phone that couldn't install it:
//   - no APK on the server: the web app's catch-all answered with index.html,
//     so the phone saved a web page named CredenceHR.apk;
//   - the APK put on the server was GitHub's Actions artifact, which GitHub
//     always hands out as a .zip with the .apk inside: the phone saved a zip.
// Here a real APK is sent with Android's own type and as an attachment; a zip
// that only wraps an APK is unwrapped first; and a missing file is a plain
// 404 that says so.
//
// Where the file is looked for, first match wins:
//   APK_DIR (env), <app folder>/downloads, dist/downloads, public/downloads;
// in each, CredenceHR.apk, else CredenceHR.zip / CredenceHR-android-debug.zip,
// else (for the login page's button) the newest APK or APK zip there.
// <app folder>/downloads is the place to put it: `npm run build` empties
// dist/, so a file put there disappears on the next deploy.
import type { Express } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

const APK_TYPE = "application/vnd.android.package-archive";
const NAME_RE = /^[A-Za-z0-9._-]+\.apk$/i;
// What the login page's "Android (APK)" button asks for (AuthScreen.tsx).
const LOGIN_PAGE_APK = "CredenceHR.apk";

type ZipEntry = { name: string; method: number; compSize: number; size: number; localOffset: number };

// The file list of a zip (an APK is one). null = not a zip.
export function zipEntries(buf: Buffer): ZipEntry[] | null {
  const min = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      localOffset: buf.readUInt32LE(p + 42)
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipEntryData(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error("broken zip entry");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`zip method ${e.method} not supported`);
}

export const isApk = (entries: ZipEntry[] | null) => !!entries && entries.some((e) => e.name === "AndroidManifest.xml");

// What to send for a file on disk: itself (a real APK), the APK inside it
// (a zip that holds exactly one), or nothing (anything else).
export function apkInside(buf: Buffer): Buffer | "self" | null {
  const entries = zipEntries(buf);
  if (!entries) return null;
  if (isApk(entries)) return "self";
  const apks = entries.filter((e) => /\.apk$/i.test(e.name) && !e.name.endsWith("/"));
  if (apks.length !== 1) return null;
  const inner = zipEntryData(buf, apks[0]);
  return isApk(zipEntries(inner)) ? inner : null;
}

const apkDirs = () => [process.env.APK_DIR, path.join(process.cwd(), "downloads"), path.join(process.cwd(), "dist", "downloads"), path.join(process.cwd(), "public", "downloads")];

function findApk(name: string): string | null {
  for (const d of apkDirs()) {
    if (!d) continue;
    const f = path.join(d, name);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      // not here
    }
  }
  return null;
}

// The login page's button (CredenceHR.apk) when no file has that name: the
// newest APK — or zip holding one — in the first folder that has any, so an
// app-debug.apk or CredenceHR-android-debug.zip dropped in works unrenamed.
// Only APK_DIR and <app folder>/downloads: dist/ and public/ still carry an
// old pre-rebrand MBO.apk that must never go out as CredenceHR.apk.
function newestApk(): string | null {
  for (const d of apkDirs().slice(0, 2)) {
    if (!d) continue;
    let files: { f: string; t: number }[] = [];
    try {
      files = fs
        .readdirSync(d)
        .filter((n) => /\.(apk|zip)$/i.test(n))
        .map((n) => path.join(d, n))
        .filter((f) => fs.statSync(f).isFile())
        .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    } catch {
      continue; // no such folder
    }
    for (const { f } of files) if (servable(f)) return f;
  }
  return null;
}

// One check per file version (path + size + time), not per download.
const checked = new Map<string, string | null>();
function servable(file: string): string | null {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (checked.has(key)) return checked.get(key)!;
  let out: string | null = null;
  try {
    const what = apkInside(fs.readFileSync(file));
    if (what === "self") out = file;
    else if (what) {
      const dir = path.join(os.tmpdir(), "credencehr-apk");
      fs.mkdirSync(dir, { recursive: true });
      out = path.join(dir, `${path.basename(file, ".apk")}-${st.size}-${Math.trunc(st.mtimeMs)}.apk`);
      fs.writeFileSync(out, what);
      console.warn(`ℹ️ ${file} is a zip with the APK inside (a GitHub artifact?) — sending the APK from it.`);
    } else console.warn(`⚠️ ${file} is not an Android APK, nor a zip holding one — not sending it.`);
  } catch (err: any) {
    console.warn(`⚠️ Could not read ${file}: ${err.message}`);
  }
  checked.set(key, out);
  return out;
}

export function registerApkDownload(app: Express) {
  app.get(/^\/downloads\/([^/]+\.apk)$/i, (req, res) => {
    let name = "";
    try {
      name = decodeURIComponent(String((req.params as any)[0] || ""));
    } catch {
      // a broken %-escape: not a name we have
    }
    const notHere = () =>
      res
        .status(404)
        .type("text/plain; charset=utf-8")
        .send("The Android app isn't on this server yet. Ask your Admin to put CredenceHR.apk in the server's downloads folder.");
    if (!NAME_RE.test(name)) return notHere();
    // GitHub's artifact zip put there as it came (CredenceHR-android-debug.zip)
    // or as <name>.zip counts too — the APK inside it is sent.
    const base = name.replace(/\.apk$/i, "");
    const file =
      findApk(name) || findApk(`${base}.zip`) || findApk(`${base}-android-debug.zip`) || (name === LOGIN_PAGE_APK ? newestApk() : null);
    const send = file && servable(file);
    if (!send) return notHere();
    res.sendFile(send, {
      headers: {
        "Content-Type": APK_TYPE,
        "Content-Disposition": `attachment; filename="${name}"`,
        // no-transform: a proxy or CDN in between must pass it through as is.
        "Cache-Control": "no-cache, no-transform"
      }
    });
  });
}
