// The Android app download on the login page (AndroidApkRoute.ts): a phone
// must always get an installable APK, never the web page or a zip.
//
//   npm run test:apk

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import { apkInside, apkVersion, manifestVersion, registerApkDownload } from "../AndroidApkRoute";

// A zip with the files stored uncompressed (the reader skips CRCs).
function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const APK = makeZip([
  { name: "AndroidManifest.xml", data: Buffer.from("manifest") },
  { name: "classes.dex", data: Buffer.from("dex") }
]);
const ARTIFACT = makeZip([{ name: "app-debug.apk", data: APK }]);

test("a real APK is sent as it is", () => {
  assert.equal(apkInside(APK), "self");
});

test("GitHub's artifact zip: the APK inside it is sent", () => {
  const inner = apkInside(ARTIFACT);
  assert.ok(Buffer.isBuffer(inner));
  assert.deepEqual(inner, APK);
});

test("a web page, a zip without an APK, or with two, is not sent", () => {
  assert.equal(apkInside(Buffer.from("<!doctype html><html></html>")), null);
  assert.equal(apkInside(makeZip([{ name: "readme.txt", data: Buffer.from("x") }])), null);
  assert.equal(apkInside(makeZip([{ name: "a.apk", data: APK }, { name: "b.apk", data: APK }])), null);
});

test("the login page's button: any APK or artifact zip in the folder, newest first, saved as CredenceHR.apk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apk-test-"));
  const newer = makeZip([{ name: "AndroidManifest.xml", data: Buffer.from("newer") }]);
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  fs.writeFileSync(path.join(dir, "old.apk"), APK);
  fs.utimesSync(path.join(dir, "old.apk"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.writeFileSync(path.join(dir, "CredenceHR-android-debug (3).zip"), makeZip([{ name: "app-debug.apk", data: newer }]));
  const prev = process.env.APK_DIR;
  process.env.APK_DIR = dir;
  const app = express();
  registerApkDownload(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/downloads/CredenceHR.apk`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-disposition"), 'attachment; filename="CredenceHR.apk"');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), newer);
    // Other names are only ever their own file.
    assert.equal((await fetch(`${base}/downloads/Else.apk`)).status, 404);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.APK_DIR;
    else process.env.APK_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the route: right type and file name, unwraps the artifact, 404 instead of the web page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apk-test-"));
  fs.writeFileSync(path.join(dir, "CredenceHR.apk"), APK);
  fs.writeFileSync(path.join(dir, "Other-android-debug.zip"), ARTIFACT);
  fs.writeFileSync(path.join(dir, "Page.apk"), "<html></html>");
  const prev = process.env.APK_DIR;
  process.env.APK_DIR = dir;
  const app = express();
  registerApkDownload(app);
  // Stands in for the web app's catch-all, which used to answer instead.
  app.get(/.*/, (_req, res) => res.type("html").send("<html>app</html>"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/downloads/CredenceHR.apk`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal(ok.headers.get("content-disposition"), 'attachment; filename="CredenceHR.apk"');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), APK);

    const art = await fetch(`${base}/downloads/Other.apk`);
    assert.equal(art.status, 200);
    assert.deepEqual(Buffer.from(await art.arrayBuffer()), APK);

    for (const p of ["/downloads/Missing.apk", "/downloads/Page.apk", "/downloads/..%2F..%2Fetc%2Fpasswd.apk"]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 404, p);
      assert.match(r.headers.get("content-type") || "", /text\/plain/, p);
    }
  } finally {
    server.close();
    if (prev === undefined) delete process.env.APK_DIR;
    else process.env.APK_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Android's binary AndroidManifest.xml with just <manifest versionCode versionName>.
function makeManifest(code: number, name: string, withNames = true): Buffer {
  const strs = [withNames ? "versionCode" : "", withNames ? "versionName" : "", "manifest", name];
  const enc = strs.map((t) => {
    const b = Buffer.alloc(2 + t.length * 2 + 2);
    b.writeUInt16LE(t.length, 0);
    b.write(t, 2, "utf16le");
    return b;
  });
  const offsets: number[] = [];
  let off = 0;
  for (const e of enc) {
    offsets.push(off);
    off += e.length;
  }
  const poolHeader = Buffer.alloc(28);
  const offs = Buffer.alloc(strs.length * 4);
  offsets.forEach((o, i) => offs.writeUInt32LE(o, i * 4));
  const data = Buffer.concat(enc);
  const pool = Buffer.concat([poolHeader, offs, data]);
  pool.writeUInt16LE(0x0001, 0);
  pool.writeUInt16LE(28, 2);
  pool.writeUInt32LE(pool.length, 4);
  pool.writeUInt32LE(strs.length, 8);
  pool.writeUInt32LE(0, 16); // UTF-16
  pool.writeUInt32LE(28 + offs.length, 20);
  const resMap = Buffer.alloc(16);
  resMap.writeUInt16LE(0x0180, 0);
  resMap.writeUInt16LE(8, 2);
  resMap.writeUInt32LE(16, 4);
  resMap.writeUInt32LE(0x0101021b, 8);
  resMap.writeUInt32LE(0x0101021c, 12);
  const el = Buffer.alloc(16 + 20 + 2 * 20);
  el.writeUInt16LE(0x0102, 0);
  el.writeUInt16LE(16, 2);
  el.writeUInt32LE(el.length, 4);
  el.writeUInt32LE(0xffffffff, 16); // ns
  el.writeUInt32LE(2, 20); // "manifest"
  el.writeUInt16LE(20, 24); // attribute start
  el.writeUInt16LE(20, 26); // attribute size
  el.writeUInt16LE(2, 28); // attribute count
  const attr = (i: number, nameIdx: number, raw: number, type: number, value: number) => {
    const a = 36 + i * 20;
    el.writeUInt32LE(0xffffffff, a);
    el.writeUInt32LE(nameIdx, a + 4);
    el.writeUInt32LE(raw, a + 8);
    el.writeUInt16LE(8, a + 12);
    el[a + 15] = type;
    el.writeUInt32LE(value, a + 16);
  };
  attr(0, 0, 0xffffffff, 0x10, code);
  attr(1, 1, 3, 0x03, 3);
  const body = Buffer.concat([pool, resMap, el]);
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0);
  head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

test("the APK's version is read from its manifest (by name, or by resource id when names are stripped)", () => {
  assert.deepEqual(manifestVersion(makeManifest(431234, "1.0.2026.10.26-1800")), { code: 431234, name: "1.0.2026.10.26-1800" });
  assert.deepEqual(manifestVersion(makeManifest(7, "1.0.7", false)), { code: 7, name: "1.0.7" });
  assert.equal(manifestVersion(Buffer.from("<manifest/>")), null);
  const apk = makeZip([{ name: "AndroidManifest.xml", data: makeManifest(42, "1.0.42") }]);
  assert.deepEqual(apkVersion(apk), { code: 42, name: "1.0.42" });
  // A real APK built by Android tooling, when the repo has one.
  const real = path.join(process.cwd(), "public", "downloads", "MBO.apk");
  if (fs.existsSync(real)) assert.equal(typeof apkVersion(fs.readFileSync(real))?.code, "number");
});

test("GET /api/app/android-latest: the version of the APK the button would send", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apk-test-"));
  const prev = process.env.APK_DIR;
  process.env.APK_DIR = dir;
  const app = express();
  registerApkDownload(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/app/android-latest`)).json(), { available: false });
    fs.writeFileSync(path.join(dir, "CredenceHR-android-debug.zip"), makeZip([{ name: "app-debug.apk", data: makeZip([{ name: "AndroidManifest.xml", data: makeManifest(431999, "1.0.x") }]) }]));
    assert.deepEqual(await (await fetch(`${base}/api/app/android-latest`)).json(), { available: true, version_code: 431999, version_name: "1.0.x", url: "/downloads/CredenceHR.apk" });
  } finally {
    server.close();
    if (prev === undefined) delete process.env.APK_DIR;
    else process.env.APK_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
