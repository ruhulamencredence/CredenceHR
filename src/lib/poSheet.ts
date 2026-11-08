/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Reads the ERP's purchase-order export (Reports -> P.O Import, server:
// PoImportRoutes.ts) from the sheet's rows (an array of arrays).
//   - The header row is found by its titles (Order No, Mrf No / MPR No,
//     Material Name …), wherever it is.
//   - A P.O with several items names its project and P.O No only on its
//     first line: they are carried down to the lines under it.
//   - Carrying / loading / discount lines (no MPR No) are counted, not sent.

export interface PoSheetLine {
  line: number;
  project: string;
  poNo: string;
  poDate: string;
  reqNo: string;
  mrfNo: string;
  appNo: string;
  supplier: string;
  material: string;
  brand: string;
  unit: string;
  orderQty: string;
  appQty: string;
  rate: string;
  amount: string;
  receivedQty: string;
}

const norm = (s: any) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
// Column titles (letters only, lower case) each field is read from.
const TITLES: Record<keyof Omit<PoSheetLine, 'line'>, string[]> = {
  project: ['projectname', 'project'],
  poNo: ['orderno', 'pono', 'purchaseorderno', 'porderno'],
  poDate: ['orderdate', 'podate', 'date'],
  reqNo: ['reqno', 'requisitionno'],
  mrfNo: ['mrfno', 'mprno', 'mprormrfno', 'mrf', 'mpr', 'mprmrfno'],
  appNo: ['appno'],
  supplier: ['suppliername', 'supplier'],
  material: ['materialname', 'material', 'descriptionofmaterials', 'itemname'],
  brand: ['brandname', 'brand', 'specification'],
  unit: ['unit'],
  orderQty: ['orderqty', 'poqty'],
  appQty: ['appqty'],
  rate: ['apprate', 'rate'],
  amount: ['amount'],
  receivedQty: ['reqty', 'receivedqty', 'recqty']
};

export function readPoSheet(rows: any[][]): { lines: PoSheetLine[]; chargeLines: number; error?: string } {
  const headerAt = rows.findIndex((r) => {
    const t = (r || []).map(norm);
    return TITLES.mrfNo.some((k) => t.includes(k)) && TITLES.material.some((k) => t.includes(k)) && TITLES.poNo.some((k) => t.includes(k));
  });
  if (headerAt < 0) return { lines: [], chargeLines: 0, error: 'This sheet has no "Order No", "Mrf No" (or "MPR No") and "Material Name" columns.' };
  const head = rows[headerAt].map(norm);
  const col: Partial<Record<keyof typeof TITLES, number>> = {};
  for (const [field, names] of Object.entries(TITLES) as [keyof typeof TITLES, string[]][]) {
    // The first column whose title is one of these (in the order listed).
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) {
        col[field] = i;
        break;
      }
    }
  }
  const get = (r: any[], f: keyof typeof TITLES) => (col[f] === undefined ? '' : String(r[col[f]!] ?? '').trim());
  const lines: PoSheetLine[] = [];
  let chargeLines = 0;
  let project = '';
  let poNo = '';
  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => String(c ?? '').trim())) continue;
    // A new P.O starts where the project / order number is written.
    if (get(r, 'project')) project = get(r, 'project');
    if (get(r, 'poNo')) poNo = get(r, 'poNo');
    const mrfNo = get(r, 'mrfNo');
    const material = get(r, 'material');
    if (!mrfNo || mrfNo === '-' || !material) {
      if (material) chargeLines++;
      continue;
    }
    lines.push({
      line: i + 1,
      project,
      poNo,
      poDate: get(r, 'poDate'),
      reqNo: get(r, 'reqNo'),
      mrfNo,
      appNo: get(r, 'appNo'),
      supplier: get(r, 'supplier'),
      material,
      brand: get(r, 'brand'),
      unit: get(r, 'unit'),
      orderQty: get(r, 'orderQty'),
      appQty: get(r, 'appQty'),
      rate: get(r, 'rate'),
      amount: get(r, 'amount'),
      receivedQty: get(r, 'receivedQty')
    });
  }
  return { lines, chargeLines };
}
