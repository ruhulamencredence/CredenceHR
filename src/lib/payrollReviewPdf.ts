/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Approval -> Print: the salary sheet on paper for the HR
// Director / the MD (who marks it by hand) or for the file. A summary page
// by department, then one page per department, the Fine column, a version
// stamp (each print is numbered on the server: POST .../printed) so an old
// copy can be told apart, and the four signature boxes.

import { maskMoney } from './payrollAmounts';
import jsPDF from './jspdf';
import autoTable from 'jspdf-autotable';
import { apiUrl } from './api';
import { drawStandardHeader, loadPdfCompany, standardTable } from './pdfStandard';
import { finalizePdfPageNumbers } from './pdfLetterhead';
import { savePdfCrossPlatform } from './saveFile';

export type PrintFor = 'hrd' | 'md' | 'final';
export const PRINT_FOR_LABEL: Record<PrintFor, string> = { hrd: 'For HR Director review', md: 'For MD review', final: 'Final (file / Accounts)' };

interface Row {
  employee_code: string;
  employee_name: string;
  department: string;
  designation: string;
  working_days: number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  lwp_days: number;
  late_count: number;
  gross: number;
  absent_deduction: number;
  late_deduction: number;
  fine?: number;
  tax: number;
  pf: number;
  advance: number;
  other_deduction: number;
  extra_deduction: number;
  total_deduction: number;
  net: number;
  status: string;
}

const n0 = maskMoney((v: number) => Math.round(Number(v) || 0).toLocaleString('en-US'));
const monthText = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, (mo || 1) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};

async function getJson(token: string, path: string, body?: any) {
  const r = await fetch(apiUrl(path), {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
}

export async function printPayrollReview(token: string, month: string, forWho: PrintFor, names: { prepared?: string | null; hrd?: string | null }) {
  // The rows first: if this account can't see the sheet nothing is counted as printed.
  const sheet = await getJson(token, `/api/payroll/approval/${month}/salary-sheet`);
  const rows: Row[] = (sheet.rows || []).filter((r: Row) => r.status !== 'held');
  if (!rows.length) throw new Error('Nothing to print for this month.');
  const { version } = await getJson(token, `/api/payroll/approval/${month}/printed`, { for: forWho });
  const co = await loadPdfCompany(token);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const printedAt = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  const stamp = `Print v${version} · ${PRINT_FOR_LABEL[forWho]} · ${printedAt}`;
  const others = (r: Row) => r.tax + r.pf + r.advance + r.other_deduction + r.extra_deduction;
  const after = () => (doc as any).lastAutoTable?.finalY || 40;

  const stampPage = () => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text(stamp, W - 14, 8, { align: 'right' });
    doc.setTextColor(0);
  };
  const signatures = (y: number) => {
    if (y > H - 26) {
      doc.addPage();
      stampPage();
      y = 30;
    }
    const boxes: [string, string][] = [
      ['Prepared by', `HR${names.prepared ? ` — ${names.prepared}` : ''}`],
      ['Checked by', `HR Director${names.hrd ? ` — ${names.hrd}` : ''}`],
      ['Approved by', 'Managing Director'],
      ['Received by', 'Accounts']
    ];
    const w = (W - 28) / 4;
    boxes.forEach(([h, v], i) => {
      const x = 14 + i * w;
      doc.setDrawColor(170);
      doc.rect(x + 2, y, w - 4, 20);
      doc.line(x + 6, y + 13, x + w - 6, y + 13);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text(h, x + w / 2, y + 16.5, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.text(v, x + w / 2, y + 19.3, { align: 'center' });
    });
  };

  // Departments, Head Office / Accounts order kept simple: by name.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.department || 'No department';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const deptNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const tot = (list: Row[]) => ({
    n: list.length,
    gross: list.reduce((s, r) => s + r.gross, 0),
    cut: list.reduce((s, r) => s + r.absent_deduction + r.late_deduction, 0),
    fine: list.reduce((s, r) => s + (r.fine || 0), 0),
    other: list.reduce((s, r) => s + others(r), 0),
    ded: list.reduce((s, r) => s + r.total_deduction, 0),
    net: list.reduce((s, r) => s + r.net, 0)
  });

  // ---- summary page ----
  let y = drawStandardHeader(doc, co, `Salary Sheet — ${monthText(month)}`, [
    ['Employees', String(rows.length)],
    ['Departments', String(deptNames.length)],
    ['Copy', PRINT_FOR_LABEL[forWho]]
  ]);
  stampPage();
  const all = tot(rows);
  autoTable(doc, {
    ...standardTable(y + 3),
    head: [['SL', 'Department', 'Employees', 'Gross', 'Absent / late cut', 'Fine', 'Other ded.', 'Total ded.', 'Net']],
    body: deptNames.map((d, i) => {
      const t = tot(groups.get(d)!);
      return [i + 1, d, t.n, n0(t.gross), n0(t.cut), n0(t.fine), n0(t.other), n0(t.ded), n0(t.net)];
    }),
    foot: [[{ content: 'TOTAL', colSpan: 2, styles: { halign: 'left' } }, all.n, n0(all.gross), n0(all.cut), n0(all.fine), n0(all.other), n0(all.ded), n0(all.net)]],
    columnStyles: { 0: { halign: 'center', cellWidth: 8 }, 1: { halign: 'left' }, 2: { halign: 'center' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } }
  });
  signatures(after() + 12);

  // ---- one page per department ----
  for (const d of deptNames) {
    const list = groups.get(d)!;
    doc.addPage();
    const gy = drawStandardHeader(doc, co, d, [
      ['Month', monthText(month)],
      ['Employees', String(list.length)]
    ]);
    stampPage();
    const t = tot(list);
    autoTable(doc, {
      ...standardTable(gy + 3),
      styles: { ...standardTable(0).styles, fontSize: 6.4, cellPadding: 1.2 },
      head: [['SL', 'ID', 'Name', 'Designation', 'Days W/P/A/L/LWP', 'Late', 'Gross', 'Absent / late cut', 'Fine', 'Other ded.', 'Total ded.', 'Net', 'Remarks (MD)']],
      body: list.map((r, i) => [
        i + 1,
        r.employee_code,
        r.employee_name,
        r.designation,
        `${r.working_days}/${r.present_days}/${r.absent_days}/${r.leave_days}/${r.lwp_days}`,
        r.late_count || '',
        n0(r.gross),
        n0(r.absent_deduction + r.late_deduction),
        r.fine ? n0(r.fine) : '',
        n0(others(r)),
        n0(r.total_deduction),
        n0(r.net),
        ''
      ]),
      foot: [[{ content: 'Total', colSpan: 6, styles: { halign: 'left' } }, n0(t.gross), n0(t.cut), n0(t.fine), n0(t.other), n0(t.ded), n0(t.net), '']],
      columnStyles: {
        0: { halign: 'center', cellWidth: 7 },
        1: { halign: 'left', cellWidth: 17 },
        2: { halign: 'left' },
        3: { halign: 'left' },
        4: { halign: 'center', cellWidth: 22 },
        5: { halign: 'center', cellWidth: 9 },
        6: { halign: 'right' },
        7: { halign: 'right' },
        8: { halign: 'right' },
        9: { halign: 'right' },
        10: { halign: 'right' },
        11: { halign: 'right', fontStyle: 'bold' },
        12: { cellWidth: 38 }
      }
    });
    signatures(after() + 10);
  }
  finalizePdfPageNumbers(doc);
  await savePdfCrossPlatform(doc, `Salary-Sheet-${month}-v${version}-${forWho}.pdf`);
  return version as number;
}
