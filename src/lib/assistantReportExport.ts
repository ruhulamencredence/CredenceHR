/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PDF / Excel of a Credence Assistant list answer (AiAssistantRoutes.ts
// AssistantReport). The server sends the table only to accounts with
// users.can_export_assistant_reports, so having one is the permission.
// PDF uses the company's standard report layout (pdfStandard.ts).

import { isNativePlatform, savePdfCrossPlatform } from './saveFile';
import { drawStandardHeader, loadPdfCompany, standardTable } from './pdfStandard';
import { finalizePdfPageNumbers } from './pdfLetterhead';
import { emailReport } from './reportEmail';

export interface AssistantReport {
  title: string;
  file: string;
  details?: [string, string][];
  columns: string[];
  rows: (string | number | null)[][];
}

const cell = (v: string | number | null) => (v === null || v === undefined ? '' : String(v));

export async function downloadAssistantPdf(token: string, r: AssistantReport, preparedBy: string, mode: 'save' | 'email' = 'save') {
  const [{ default: jsPDF }, { default: autoTable }, co] = await Promise.all([import('./jspdf'), import('jspdf-autotable'), loadPdfCompany(token)]);
  const doc = new jsPDF({ orientation: r.columns.length > 6 ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const y = drawStandardHeader(doc, co, r.title, [...(r.details || []), ['Prepared by', preparedBy]]);
  autoTable(doc, {
    ...standardTable(y),
    head: [r.columns],
    body: r.rows.map((row) => row.map(cell)),
    columnStyles: { 0: { halign: 'center', cellWidth: 9 } }
  });
  finalizePdfPageNumbers(doc);
  if (mode === 'email') {
    await emailReport(doc, { fileName: `${r.file}.pdf`, title: r.title });
    return;
  }
  await savePdfCrossPlatform(doc, `${r.file}.pdf`);
}

export async function downloadAssistantExcel(r: AssistantReport, preparedBy: string) {
  const XLSX = await import('xlsx');
  const aoa: (string | number)[][] = [
    [r.title],
    ...(r.details || []).map(([k, v]) => [k, v]),
    ['Prepared by', preparedBy],
    [],
    r.columns,
    ...r.rows.map((row) => row.map((v) => (typeof v === 'number' ? v : cell(v))))
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = r.columns.map((c, i) => ({ wch: Math.min(45, Math.max(c.length + 2, ...r.rows.slice(0, 300).map((row) => cell(row[i]).length + 2))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  const name = `${r.file}.xlsx`;
  if (await isNativePlatform()) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const data = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const written = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
      await Share.share({ title: name, url: written.uri, dialogTitle: `Save or share ${name}` });
      return;
    } catch (err) {
      console.error('Native Excel save failed, falling back to browser download:', err);
    }
  }
  XLSX.writeFile(wb, name);
}
