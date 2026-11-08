/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// pdf.js (≈800 KB) is fetched the first time a PDF is shown, not with the
// page that might show one. Every PDF viewer in the app gets it from here.

let pending: Promise<typeof import('pdfjs-dist')> | null = null;

export function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pending) {
    pending = Promise.all([
      import('pdfjs-dist'),
      // Vite-specific: the worker script's URL, so parsing runs off the main thread.
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = (worker as any).default;
      return lib;
    });
    pending.catch(() => {
      pending = null; // offline: try again next time
    });
  }
  return pending;
}
