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

// ---- The APK's own version (for the app's "Update available" popup) ----
// AndroidManifest.xml inside an APK is Android's binary XML: a string pool,
// a resource-id map, then elements. versionCode / versionName are
// attributes of the first element, <manifest>.
function readStringPool(buf: Buffer, p: number): string[] {
  const headerSize = buf.readUInt16LE(p + 2);
  const count = buf.readUInt32LE(p + 8);
  const utf8 = (buf.readUInt32LE(p + 16) & 0x100) !== 0;
  const start = p + buf.readUInt32LE(p + 20);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let o = start + buf.readUInt32LE(p + headerSize + i * 4);
    if (utf8) {
      o += buf[o] & 0x80 ? 2 : 1; // length in UTF-16 units, not needed
      let len = buf[o];
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[o + 1];
        o += 2;
      } else o += 1;
      out.push(buf.toString("utf8", o, o + len));
    } else {
      let len = buf.readUInt16LE(o);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(o + 2);
        o += 4;
      } else o += 2;
      out.push(buf.toString("utf16le", o, o + len * 2));
    }
  }
  return out;
}

export function manifestVersion(axml: Buffer): { code: number; name: string | null } | null {
  if (axml.length < 8 || axml.readUInt16LE(0) !== 0x0003) return null;
  let strings: string[] = [];
  const resIds: number[] = [];
  let p = axml.readUInt16LE(2);
  while (p + 8 <= axml.length) {
    const type = axml.readUInt16LE(p);
    const headerSize = axml.readUInt16LE(p + 2);
    const size = axml.readUInt32LE(p + 4);
    if (size < 8) return null;
    if (type === 0x0001) strings = readStringPool(axml, p);
    else if (type === 0x0180) for (let i = p + headerSize; i + 4 <= p + size; i += 4) resIds.push(axml.readUInt32LE(i));
    else if (type === 0x0102) {
      const ext = p + headerSize;
      if (strings[axml.readUInt32LE(ext + 4)] !== "manifest") return null;
      const attrStart = axml.readUInt16LE(ext + 8);
      const attrSize = axml.readUInt16LE(ext + 10);
      const attrCount = axml.readUInt16LE(ext + 12);
      let code: number | null = null;
      let name: string | null = null;
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = axml.readUInt32LE(a + 4);
        const raw = axml.readUInt32LE(a + 8);
        const dataType = axml[a + 15];
        const data = axml.readUInt32LE(a + 16);
        // By name, or by Android's resource id when names are stripped.
        const attr = strings[nameIdx];
        const rid = resIds[nameIdx];
        if (attr === "versionCode" || rid === 0x0101021b) code = data;
        if (attr === "versionName" || rid === 0x0101021c) name = dataType === 0x03 ? strings[data] ?? null : raw !== 0xffffffff ? strings[raw] ?? null : null;
      }
      return code === null ? null : { code, name };
    }
    p += size;
  }
  return null;
}

// The version of an APK file's bytes. null = not readable.
export function apkVersion(apk: Buffer): { code: number; name: string | null } | null {
  const entries = zipEntries(apk);
  const m = entries?.find((e) => e.name === "AndroidManifest.xml");
  return m ? manifestVersion(zipEntryData(apk, m)) : null;
}

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

const versions = new Map<string, { code: number; name: string | null } | null>();
// What the login page's button would send now, and its version.
function currentApk(): { file: string; version: { code: number; name: string | null } | null } | null {
  const file = findApk(LOGIN_PAGE_APK) || findApk("CredenceHR.zip") || findApk("CredenceHR-android-debug.zip") || newestApk();
  const send = file && servable(file);
  if (!send) return null;
  const st = fs.statSync(send);
  const key = `${send}|${st.size}|${st.mtimeMs}`;
  if (!versions.has(key)) {
    let v: { code: number; name: string | null } | null = null;
    try {
      v = apkVersion(fs.readFileSync(send));
    } catch {
      // unreadable manifest: no version to compare
    }
    versions.set(key, v);
  }
  return { file: send, version: versions.get(key)! };
}

export function registerApkDownload(app: Express) {
  // The Android app on the server (downloads/) and its version, for the
  // app's own "Update available" popup (src/components/AppUpdatePrompt.tsx).
  // Public like the download itself: a version number, nothing else.
  app.get("/api/app/android-latest", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    const apk = currentApk();
    if (!apk || !apk.version) return res.json({ available: false });
    res.json({ available: true, version_code: apk.version.code, version_name: apk.version.name, url: `/downloads/${LOGIN_PAGE_APK}` });
  });

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
