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

export {};
