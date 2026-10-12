/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Exit / Offboarding -> the two printable documents: the Clearance
// Certificate (who cleared each department, and when) and the Full & Final
// Settlement Sheet (what is paid, what is deducted, the net). Built from
// GET /api/exit-requests/:id/documents, which only accounts with the Exit
// layer "exit_pdf" can read.

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from './pdfLetterhead';
import { savePdfCrossPlatform } from './saveFile';
import credenceLogo from '../assets/credence-logo.png';

export interface ExitDocuments {
  employee: { name: string | null; employee_code: string | null; designation: string | null; department: string | null; joining_date: string | null };
  exit: { id: number; exit_type: string; reason: string | null; notice_date: string | null; last_working_day: string | null; status: string };
  clearance: { department: string; item_label: string; is_cleared: boolean; cleared_by: string | null; cleared_at: string | null; remarks: string | null }[];
  settlement: {
    unused_leave_days: number;
    unused_leave_encashment: number;
    gratuity_amount: number;
    outstanding_dues: number;
    other_additions: number;
    other_deductions: number;
    net_payable: number;
    notes: string | null;
    status: string;
    paid_at: string | null;
    prepared_by: string | null;
    added_dues: { key: string; label: string; amount: number }[];
  } | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (v: string | null | undefined) => {
  if (!v) return '—';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}` : String(v);
};
// Helvetica has no taka sign, so amounts print as "BDT 12,000.00".
const bdt = (n: number) => `BDT ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const typeLabel = (t: string) => (t === 'termination' ? 'Termination' : 'Resignation');
const fileSafe = (s: string | null) => (s || 'Employee').replace(/[^A-Za-z0-9]+/g, '_');

const personRows = (d: ExitDocuments): [string, string][] => [
  ['Name', d.employee.name || '—'],
  ['Employee ID', d.employee.employee_code || '—'],
  ['Designation', d.employee.designation || '—'],
  ['Department', d.employee.department || '—'],
  ['Separation', typeLabel(d.exit.exit_type)],
  ['Last Working Day', day(d.exit.last_working_day)],
  ['Joining Date', day(d.employee.joining_date)]
];

// Three signature lines at the foot of the last page.
function drawSignatures(doc: jsPDF, y: number, labels: string[]) {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  let top = Math.max(y + 24, 0);
  if (top > h - 30) {
    doc.addPage();
    top = 40;
  }
  const colW = (w - 28) / labels.length;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  labels.forEach((label, i) => {
    const x = 14 + i * colW;
    doc.setDrawColor(148, 163, 184);
    doc.line(x + 2, top, x + colW - 8, top);
    doc.text(label, x + 2, top + 5);
  });
}

export async function saveClearanceCertificatePdf(d: ExitDocuments) {
  const logo = await loadImageElement(credenceLogo);
  const doc = new jsPDF();
  let y = drawPdfLetterhead(doc, logo, { reportTitle: 'Clearance Certificate', filtersLabel: 'Employee Details:', filters: personRows(d) });
  const all = d.clearance.length > 0 && d.clearance.every((c) => c.is_cleared);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  const intro = all
    ? `This is to certify that ${d.employee.name || 'the employee'} has returned all company property and settled all obligations, and has been cleared by every department listed below.`
    : `Clearance status for ${d.employee.name || 'the employee'}. Departments marked "Pending" have not yet given their clearance.`;
  const lines = doc.splitTextToSize(intro, doc.internal.pageSize.getWidth() - 28);
  doc.text(lines, 14, y + 2);
  y += lines.length * 5 + 6;
  autoTable(doc, {
    startY: y,
    head: [['Department', 'Item', 'Status', 'Cleared by', 'Date', 'Remarks']],
    body: d.clearance.map((c) => [c.department, c.item_label, c.is_cleared ? 'Cleared' : 'Pending', c.is_cleared ? c.cleared_by || '—' : '—', c.is_cleared ? day(c.cleared_at) : '—', c.remarks || '']),
    styles: { fontSize: 8.5, cellPadding: 2.2 },
    columnStyles: { 0: { cellWidth: 22 }, 2: { cellWidth: 20 }, 4: { cellWidth: 26 } },
    headStyles: { fillColor: [124, 58, 237] },
    didParseCell: (h) => {
      if (h.section === 'body' && h.column.index === 2) h.cell.styles.textColor = h.cell.raw === 'Cleared' ? [4, 120, 87] : [180, 83, 9];
    }
  });
  y = (doc as any).lastAutoTable.finalY;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(all ? 4 : 180, all ? 120 : 83, all ? 87 : 9);
  doc.text(all ? 'All departments cleared' : 'Clearance incomplete', 14, y + 9);
  drawSignatures(doc, y + 10, ['Prepared by (HR)', 'Authorised Signatory']);
  finalizePdfPageNumbers(doc);
  await savePdfCrossPlatform(doc, `Clearance_Certificate_${fileSafe(d.employee.name)}.pdf`);
}

export async function saveSettlementSheetPdf(d: ExitDocuments) {
  const s = d.settlement;
  if (!s) throw new Error('There is no settlement for this exit yet — open the settlement first.');
  const logo = await loadImageElement(credenceLogo);
  const doc = new jsPDF();
  const paid = s.status === 'paid';
  const y = drawPdfLetterhead(doc, logo, {
    reportTitle: 'Full & Final Settlement',
    filtersLabel: 'Employee Details:',
    filters: [...personRows(d), ['Status', paid ? `Paid on ${day(s.paid_at)}` : 'Draft (not paid)']]
  });
  const otherDues = Math.max(0, s.outstanding_dues - s.added_dues.reduce((t, a) => t + a.amount, 0));
  const body: (string | { content: string; styles: object })[][] = [];
  const section = (t: string) => body.push([{ content: t, styles: { fontStyle: 'bold', fillColor: [241, 245, 249] } }, { content: '', styles: { fillColor: [241, 245, 249] } }]);
  section('Payable to the employee');
  body.push([`Leave encashment (${s.unused_leave_days} unused day${s.unused_leave_days === 1 ? '' : 's'})`, bdt(s.unused_leave_encashment)]);
  body.push(['Gratuity', bdt(s.gratuity_amount)]);
  body.push(['Other additions', bdt(s.other_additions)]);
  section('Deductions');
  s.added_dues.forEach((a) => body.push([a.label, `- ${bdt(a.amount)}`]));
  if (otherDues > 0 || s.added_dues.length === 0) body.push(['Outstanding dues', `- ${bdt(s.added_dues.length ? otherDues : s.outstanding_dues)}`]);
  body.push(['Other deductions', `- ${bdt(s.other_deductions)}`]);
  autoTable(doc, {
    startY: y,
    head: [['Item', 'Amount']],
    body: body as any,
    foot: [['Net payable', bdt(s.net_payable)]],
    styles: { fontSize: 9.5, cellPadding: 2.6 },
    columnStyles: { 1: { halign: 'right', cellWidth: 55 } },
    headStyles: { fillColor: [124, 58, 237] },
    footStyles: { fillColor: [236, 253, 245], textColor: [4, 120, 87], fontStyle: 'bold', fontSize: 11 }
  });
  let end = (doc as any).lastAutoTable.finalY;
  if (s.notes) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    const lines = doc.splitTextToSize(`Notes: ${s.notes}`, doc.internal.pageSize.getWidth() - 28);
    doc.text(lines, 14, end + 8);
    end += 8 + lines.length * 4.5;
  }
  drawSignatures(doc, end + 6, ['Prepared by' + (s.prepared_by ? ` (${s.prepared_by})` : ''), 'Employee (received)', 'Approved by']);
  finalizePdfPageNumbers(doc);
  await savePdfCrossPlatform(doc, `Final_Settlement_${fileSafe(d.employee.name)}.pdf`);
}
