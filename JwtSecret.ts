/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The key every sign-in token is signed with. Anyone who knows it can make a
// token for any account (a Superadmin's too), so it is never a value written
// in the code or in .env.example:
//   - JWT_SECRET from .env, when it is long (32+) and not a published default;
//   - otherwise a random key made on the first start and kept in .jwt-secret
//     (next to the server, or JWT_SECRET_FILE), shared by every PM2 worker on
//     this machine and kept across restarts.
// Several servers behind one address must all have the same JWT_SECRET in .env.

import crypto from "crypto";
import fs from "fs";
import path from "path";

const PUBLISHED = ["super_secret_jwt_key_mpr_tracker_2026", "mpr_tracker_secret_key_2026"];

export function isStrongJwtSecret(value: unknown): value is string {
  const s = String(value ?? "");
  return s.length >= 32 && !PUBLISHED.includes(s);
}

export function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (isStrongJwtSecret(fromEnv)) return fromEnv;

  const file = process.env.JWT_SECRET_FILE || path.join(process.cwd(), ".jwt-secret");
  const read = () => {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  };
  let secret = read();
  if (!isStrongJwtSecret(secret)) {
    try {
      // "wx": only one worker creates it; the others read what it wrote.
      fs.writeFileSync(file, crypto.randomBytes(48).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw new Error(`JWT_SECRET is missing or weak and ${file} can't be written: ${err?.message}`);
    }
    // Another worker may be writing it at this moment.
    const until = Date.now() + 2000;
    while (!isStrongJwtSecret((secret = read())) && Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (!isStrongJwtSecret(secret)) throw new Error(`JWT_SECRET is missing or weak and ${file} doesn't hold a usable key.`);
  }
  console.warn(
    fromEnv
      ? `⚠️ JWT_SECRET in .env is a published default or too short, so it is not used — signing with the key in ${file}. Put a long random value (openssl rand -hex 48) in .env.`
      : `⚠️ JWT_SECRET is not set — signing with the key in ${file}. Put a long random value (openssl rand -hex 48) in .env.`
  );
  return secret;
}
