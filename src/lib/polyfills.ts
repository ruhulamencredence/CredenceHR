/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// pdf.js (PdfPreviewModal — letter / payslip / report previews) calls
// Map.prototype.getOrInsertComputed, which only very recent browsers ship.
// Older Chromium builds and Android System WebViews don't have it, and the
// preview then fails with "Couldn't render the preview". Imported first in
// main.tsx so it's in place before any module that loads pdf.js.
type Upsertable = { prototype: any };
for (const C of [Map, WeakMap] as Upsertable[]) {
  if (!C.prototype.getOrInsertComputed) {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value(this: Map<any, any>, key: any, compute: (k: any) => any) {
        if (!this.has(key)) this.set(key, compute(key));
        return this.get(key);
      }
    });
  }
  if (!C.prototype.getOrInsert) {
    Object.defineProperty(C.prototype, 'getOrInsert', {
      configurable: true,
      writable: true,
      value(this: Map<any, any>, key: any, value: any) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      }
    });
  }
}

// Safari (iPhone / iPad / Mac) can't read "2026-11-14 09:00:00" — the way the
// server sends every date-time (mysql2 dateStrings) — and gives "Invalid
// Date"; Chrome and Android read it as local time. Only where the browser
// fails that, Date and Date.parse are wrapped so such a string is read as
// "2026-11-14T09:00:00" (local time — what Chrome already does). Every other
// value, and every other browser, is left exactly as it was.
const SPACE_DATE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
if (typeof Date !== 'undefined' && Number.isNaN(new Date('2026-01-02 03:04:05').getTime())) {
  const NativeDate = Date;
  const fix = (v: any) => (typeof v === 'string' && SPACE_DATE_TIME.test(v.trim()) ? v.trim().replace(' ', 'T') : v);
  // A function, not a class: Date() called without `new` still returns a string.
  const SafeDate: any = function (this: any, ...args: any[]) {
    if (!new.target) return (NativeDate as any)();
    if (args.length === 1) args[0] = fix(args[0]);
    return new (NativeDate as any)(...args);
  };
  SafeDate.prototype = NativeDate.prototype; // `x instanceof Date` keeps working
  SafeDate.parse = (s: string) => NativeDate.parse(fix(s));
  SafeDate.UTC = NativeDate.UTC;
  SafeDate.now = NativeDate.now;
  (globalThis as any).Date = SafeDate;
}

export {};
