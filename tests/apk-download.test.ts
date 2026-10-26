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
import { apkInside, registerApkDownload } from "../AndroidApkRoute";

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
