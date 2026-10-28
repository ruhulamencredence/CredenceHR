/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Opens an uploaded spreadsheet. XLSX.read on the raw bytes of a text file
// (a .csv) only knows it is UTF-8 when it starts with a byte-order mark —
// Excel's "CSV UTF-8" has one, but Google Sheets / LibreOffice exports don't,
// and their Bangla names came out as "à¦°à¦¹à¦¿à¦®". A text file that is valid
// UTF-8 is therefore decoded here first; .xlsx / .xls (and a CSV in an old
// Windows code page) are read from the bytes as before.
import * as XLSX from 'xlsx';

export function readWorkbook(data: ArrayBuffer | Uint8Array, opts: XLSX.ParsingOptions = {}): XLSX.WorkBook {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const zipOrOle = (bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0xd0 && bytes[1] === 0xcf);
  if (!zipOrOle) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
      return XLSX.read(text, { ...opts, type: 'string' });
    } catch {
      // not UTF-8 text: fall through
    }
  }
  return XLSX.read(bytes, { ...opts, type: 'array' });
}
