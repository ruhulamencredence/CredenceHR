/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Sign in with fingerprint (src/lib/fingerprint.ts) — what each failure of the
// phone's fingerprint window means. The saved setup may only be thrown away
// when it is really gone; a busy sensor or a window the system closed (as
// happens when it opens while the app is still starting) keeps it.
//
//   npm run test:fingerprint

import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintFailure } from "../src/lib/fingerprint";

// Errors as @capgo/capacitor-native-biometric (Android / iOS) rejects them.
const err = (message: string, code?: string) => Object.assign(new Error(message), code === undefined ? {} : { code });

test("cancel / 'Use password' / system cancel say nothing and keep the setup", () => {
  for (const e of [err("Cancel", "16"), err("Use password", "17"), err("Canceled", "15"), err("x", "11")]) {
    const r = fingerprintFailure(e);
    assert.equal(r.cancelled, true);
    assert.equal(r.forget, false);
  }
});

test("a wrong finger and a lock-out keep the setup", () => {
  assert.match(fingerprintFailure(err("Not recognized", "10")).message, /didn't match/);
  for (const c of ["2", "4"]) {
    const r = fingerprintFailure(err("Too many attempts", c));
    assert.equal(r.forget, false);
    assert.match(r.message, /locked/);
  }
});

test("the saved secret gone (removed, fingerprints changed) → turn it on again", () => {
  for (const e of [
    err("No protected credentials found", "21"),
    err("No protected credentials found for server", "21"),
    err("No credentials found"),
    err("Biometric enrollment changed", "0")
  ]) {
    const r = fingerprintFailure(e);
    assert.equal(r.forget, true, e.message);
    assert.match(r.message, /turned on again/);
  }
});

test("a busy sensor, no fingerprint enrolled, or an unknown failure keep the setup", () => {
  for (const e of [
    err("Biometric hardware unavailable", "1"),
    err("No biometrics enrolled", "3"),
    err("Authentication failed"), // the window was closed without an answer
    err("Something went wrong.", "0"),
    err("The phone's fingerprint window didn't answer in 120 seconds.")
  ]) {
    const r = fingerprintFailure(e);
    assert.equal(r.cancelled, false, e.message);
    assert.equal(r.forget, false, e.message);
    assert.ok(r.message.length > 10, e.message);
  }
  assert.match(fingerprintFailure(err("Authentication failed")).message, /try again/);
});
