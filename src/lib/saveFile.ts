/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// jsPDF's doc.save() works by faking a click on an <a download> link — that's
// how every "Export PDF" button on the web build gets its file into Downloads.
// That trick doesn't exist inside a Capacitor Android WebView (there's no
// browser download manager to hand the blob to), so on the APK the button
// looked like it did nothing: no error, no file, no toast.
//
// Fix: detect native Capacitor at runtime. When native, write the PDF into the
// app's cache directory and hand it to the OS Share sheet instead — the user
// picks "Save to Downloads", Drive, WhatsApp, etc. On the ordinary web build
// (or in a plain browser tab hitting the same server URL) Capacitor's web shim
// reports isNativePlatform() === false, so this just falls through to the
// normal doc.save() download, unchanged.
//
// Requires @capacitor/core, @capacitor/filesystem, and @capacitor/share to be
// installed (npm install @capacitor/core @capacitor/filesystem @capacitor/share)
// before `npm run build` — they're already listed in package.json.

import type jsPDFType from "jspdf";

export async function isNativePlatform(): Promise<boolean> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    // @capacitor/core not installed/loadable (e.g. plain web-only checkout) —
    // treat as "not native" and let the caller fall back to doc.save().
    return false;
  }
}

/**
 * Saves a jsPDF document. On the Android APK this writes the PDF to cache and
 * opens the native Share sheet; everywhere else it's a normal browser download.
 */
export async function savePdfCrossPlatform(
  doc: jsPDFType,
  filename: string,
): Promise<void> {
  if (await isNativePlatform()) {
    try {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const { Share } = await import("@capacitor/share");

      // jsPDF hands back the PDF bytes as a data URI string — strip the
      // "data:application/pdf;filename=...;base64," prefix to get raw base64.
      const base64Data = doc.output("datauristring").split(",")[1];

      const written = await Filesystem.writeFile({
        path: filename,
        data: base64Data,
        directory: Directory.Cache,
      });

      await Share.share({
        title: filename,
        url: written.uri,
        dialogTitle: `Save or share ${filename}`,
      });
      return;
    } catch (err) {
      // Permission denial, no share target, etc. — don't leave the user with
      // a silent failure, fall back to the (likely also silent, but at least
      // unchanged/familiar) web download path below.
      console.error(
        "Native PDF save failed, falling back to browser download:",
        err,
      );
    }
  }

  doc.save(filename);
}
