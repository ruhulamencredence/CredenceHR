/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// One employee's payslip PDF (letterhead, Earnings | Deductions, net,
// attendance). Shared by Payroll -> Payslips (PayslipManagementPanel.tsx)
// and Self Service -> My Payslip (MyPayslips.tsx), so both give the same PDF.

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { payslipRows, pdfMoney, PayslipLine } from './payslipRows';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from './pdfLetterhead';
import credenceLogo from '../assets/credence-logo.png';

export interface PayrollRecord {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  month_year: string;
  total_working_days: number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  lwp_days: number;
  overtime_hours: number;
  basic_amount: number;
  allowances_total: number;
  overtime_amount: number;
  bonus_amount: number;
  gross_earned: number;
  absent_deduction: number;
  tax_deduction: number;
  pf_deduction: number;
  advance_deduction: number;
  other_deduction: number;
  item_earnings?: number;
  item_deductions?: number;
  pay_lines?: PayslipLine[];
  total_deduction: number;
  net_salary: number;
  payment_status: 'unpaid' | 'processed' | 'paid';
  remarks: string | null;
}

export const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const monthLabel = (my: string) => {
  const [y, m] = my.split('-').map(Number);
  if (!y || !m) return my;
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
};

// One employee's payslip content drawn onto whatever page of `doc` is
// currently active — shared by the single-record view/download/print flow
// and the bulk generator (which just calls this once per page).
export const drawPayslipPage = (doc: jsPDF, logoImg: HTMLImageElement, record: PayrollRecord) => {
  const startY = drawPdfLetterhead(doc, logoImg, {
    reportTitle: `Payslip — ${monthLabel(record.month_year)}`,
    filtersLabel: 'Employee Details:',
    filters: [
      ['Employee', `${record.employee_name}${record.employee_code ? ` (${record.employee_code})` : ''}`],
      ['Designation', record.designation || '—'],
      ['Department', record.department || '—'],
      ['Payment Status', record.payment_status.toUpperCase()]
    ]
  });

  autoTable(doc, {
    startY,
    margin: { top: startY, left: 14, right: 14 },
    head: [['Earnings', 'Amount', 'Deductions', 'Amount']],
    body: payslipRows(record, pdfMoney),
    foot: [['Gross Earned', pdfMoney(record.gross_earned), 'Total Deduction', pdfMoney(record.total_deduction)]],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [37, 99, 235], textColor: 255 },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold' }
  });

  const finalY = (doc as any).lastAutoTable.finalY + 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`Net Salary: ${pdfMoney(record.net_salary)}`, 14, finalY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `Attendance: ${record.present_days} present / ${record.absent_days} absent / ${record.leave_days} leave / ${record.lwp_days} LWP out of ${record.total_working_days} working days`,
    14,
    finalY + 6
  );
  if (record.remarks) {
    doc.text(`Remarks: ${record.remarks}`, 14, finalY + 12);
  }
};

export const buildSinglePayslip = async (record: PayrollRecord) => {
  const logoImg = await loadImageElement(credenceLogo);
  const doc = new jsPDF();
  drawPayslipPage(doc, logoImg, record);
  finalizePdfPageNumbers(doc);
  return doc;
};


export const loadPayslipLogo = () => loadImageElement(credenceLogo);
