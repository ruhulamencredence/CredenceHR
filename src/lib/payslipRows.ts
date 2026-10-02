/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The Earnings | Deductions rows of a payslip PDF, shared by Payroll ->
// Payslips (PayslipManagementPanel.tsx) and the quick payslip download in
// PayrollModule.tsx. Each Allowance & Adjustment line a run carries
// (pay_lines, PayrollItemsRoutes.ts) gets its own row under its own name.

export interface PayslipLine {
  name: string;
  kind: string;
  amount: number;
}

export function payslipRows(
  r: {
    basic_amount: number;
    allowances_total: number;
    overtime_amount: number;
    bonus_amount: number;
    absent_deduction: number;
    tax_deduction: number;
    pf_deduction: number;
    advance_deduction: number;
    other_deduction: number;
    pay_lines?: PayslipLine[];
  },
  money: (n: number) => string
): string[][] {
  const lines = r.pay_lines || [];
  const earnings: [string, number][] = [
    ['Basic Salary', r.basic_amount],
    ['Allowances', r.allowances_total],
    ['Overtime', r.overtime_amount],
    ['Bonus', r.bonus_amount],
    ...lines.filter((l) => l.kind === 'earning').map((l) => [l.name, l.amount] as [string, number])
  ];
  const deductions: [string, number][] = [
    ['Absent / LWP / Late Deduction', r.absent_deduction],
    ['Tax Deduction', r.tax_deduction],
    ['Provident Fund', r.pf_deduction],
    ['Advance Recovery', r.advance_deduction],
    ['Other Deduction', r.other_deduction],
    ...lines.filter((l) => l.kind === 'deduction').map((l) => [l.name, l.amount] as [string, number])
  ];
  const rows: string[][] = [];
  for (let i = 0; i < Math.max(earnings.length, deductions.length); i++) {
    const e = earnings[i];
    const d = deductions[i];
    rows.push([e ? e[0] : '', e ? money(e[1]) : '', d ? d[0] : '', d ? money(d[1]) : '']);
  }
  return rows;
}

// jsPDF's built-in fonts have no ৳ glyph (it printed as "ó" and spread the
// digits apart), so payslip PDFs write amounts as "Tk 1,500.00".
export const pdfMoney = (n: number | null | undefined) =>
  `Tk ${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
