/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Payslips — "পে-স্লিপ পেজ".
//
// Three things live here, all scoped to one selected month's payroll runs
// (GET /api/payroll?month_year=...):
//   * Bulk Payslip Generator — one PDF, one page per employee, built
//     client-side with the same jsPDF + letterhead helpers PayrollModule.tsx
//     already uses for a single payslip.
//   * Individual Payslip View & Print / Download — View opens the PDF in a
//     new tab (the browser's own viewer gives Print/Save for free);
//     Download saves it straight to disk via savePdfCrossPlatform.
//   * Email Payslips — per-employee and "Email All" buttons. NOTE: this
//     calls POST /api/payroll/:id/email and POST /api/payroll/email-bulk,
//     which do not exist yet in PayrollRoutes.ts (no SMTP/mailer is wired
//     up anywhere in this project) — the buttons are ready, but the server
//     route + mail transport still need to be added before they can
//     actually send anything.

import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  ReceiptText,
  FileDown,
  Eye,
  Mail,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Layers
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';

interface PayslipManagementPanelProps {
  token: string;
}

interface PayrollRecord {
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
  total_deduction: number;
  net_salary: number;
  payment_status: 'unpaid' | 'processed' | 'paid';
  remarks: string | null;
}

const currentMonthYear = () => new Date().toISOString().slice(0, 7);

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthLabel = (my: string) => {
  const [y, m] = my.split('-').map(Number);
  if (!y || !m) return my;
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
};

// One employee's payslip content drawn onto whatever page of `doc` is
// currently active — shared by the single-record view/download/print flow
// and the bulk generator (which just calls this once per page).
const drawPayslipPage = (doc: jsPDF, logoImg: HTMLImageElement, record: PayrollRecord) => {
  const startY = drawPdfLetterhead(doc, logoImg, {
    reportTitle: `Payslip — ${monthLabel(record.month_year)}`,
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
    body: [
      ['Basic Salary', money(record.basic_amount), 'Absent / LWP Deduction', money(record.absent_deduction)],
      ['Allowances', money(record.allowances_total), 'Tax Deduction', money(record.tax_deduction)],
      ['Overtime', money(record.overtime_amount), 'Provident Fund', money(record.pf_deduction)],
      ['Bonus', money(record.bonus_amount), 'Advance Recovery', money(record.advance_deduction)],
      ['', '', 'Other Deduction', money(record.other_deduction)]
    ],
    foot: [['Gross Earned', money(record.gross_earned), 'Total Deduction', money(record.total_deduction)]],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [37, 99, 235], textColor: 255 },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold' }
  });

  const finalY = (doc as any).lastAutoTable.finalY + 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`Net Salary: ${money(record.net_salary)}`, 14, finalY);
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

const buildSinglePayslip = async (record: PayrollRecord) => {
  const logoImg = await loadImageElement(credenceLogo);
  const doc = new jsPDF();
  drawPayslipPage(doc, logoImg, record);
  finalizePdfPageNumbers(doc);
  return doc;
};

export const PayslipManagementPanel: React.FC<PayslipManagementPanelProps> = ({ token }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState<'pdf' | 'email' | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchRecords = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll?month_year=${monthYear}`), { headers: authHeaders });
      if (!res.ok) {
        setError(res.status === 403 ? "You don't have access to Payroll." : 'Failed to load payroll records for this month.');
        return;
      }
      setRecords(await res.json());
    } catch {
      setError('Failed to load payroll records for this month.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
    setNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthYear]);

  // ---- Individual: View (new tab) / Download -----------------------------
  const viewPayslip = async (record: PayrollRecord) => {
    setBusyId(record.id);
    try {
      const doc = await buildSinglePayslip(record);
      const url = doc.output('bloburl');
      window.open(url as unknown as string, '_blank');
    } finally {
      setBusyId(null);
    }
  };

  const downloadPayslip = async (record: PayrollRecord) => {
    setBusyId(record.id);
    try {
      const doc = await buildSinglePayslip(record);
      await savePdfCrossPlatform(doc, `Payslip_${record.employee_name.replace(/\s+/g, '_')}_${record.month_year}.pdf`);
    } finally {
      setBusyId(null);
    }
  };

  // ---- Bulk: one PDF, one page per employee -------------------------------
  const generateBulkPayslips = async () => {
    if (records.length === 0) return;
    setBulkBusy('pdf');
    setNotice(null);
    try {
      const logoImg = await loadImageElement(credenceLogo);
      const doc = new jsPDF();
      records.forEach((record, i) => {
        if (i > 0) doc.addPage();
        drawPayslipPage(doc, logoImg, record);
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `Payslips_${monthYear}.pdf`);
      setNotice({ type: 'success', text: `Generated ${records.length} payslip${records.length === 1 ? '' : 's'} in one PDF.` });
    } catch {
      setNotice({ type: 'error', text: 'Failed to generate the bulk payslip PDF.' });
    } finally {
      setBulkBusy(null);
    }
  };

  // ---- Email: per-employee and "Email All" --------------------------------
  // Backend route not implemented yet — see file header note.
  const emailPayslip = async (record: PayrollRecord) => {
    setBusyId(record.id);
    setNotice(null);
    try {
      const res = await fetch(apiUrl(`/api/payroll/${record.id}/email`), { method: 'POST', headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error || `Couldn't email ${record.employee_name}'s payslip — email sending isn't set up on the server yet.` });
        return;
      }
      setNotice({ type: 'success', text: `Payslip emailed to ${record.employee_name}.` });
    } catch {
      setNotice({ type: 'error', text: `Couldn't email ${record.employee_name}'s payslip — email sending isn't set up on the server yet.` });
    } finally {
      setBusyId(null);
    }
  };

  const emailAllPayslips = async () => {
    if (records.length === 0) return;
    setBulkBusy('email');
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/payroll/email-bulk'), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ month_year: monthYear })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error || "Couldn't email payslips — email sending isn't set up on the server yet." });
        return;
      }
      const sent = (data.results || []).filter((r: any) => r.success).length;
      setNotice({ type: 'success', text: `Emailed ${sent} of ${records.length} payslip${records.length === 1 ? '' : 's'}.` });
    } catch {
      setNotice({ type: 'error', text: "Couldn't email payslips — email sending isn't set up on the server yet." });
    } finally {
      setBulkBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <ReceiptText className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Payslips — {monthLabel(monthYear)}</h2>
            <p className="text-[11px] text-slate-500 mt-0.5 max-w-md">
              Generate, view, download, or email payslips for this month's processed payroll runs.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={monthYear}
            onChange={(e) => setMonthYear(e.target.value)}
            className="px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            onClick={fetchRecords}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Bulk actions */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Bulk Actions</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={generateBulkPayslips}
            disabled={records.length === 0 || bulkBusy !== null}
            className="flex items-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-all justify-center disabled:opacity-50"
          >
            {bulkBusy === 'pdf' ? <Spinner size={16} /> : <Layers className="w-4 h-4" />} Generate All Payslips (PDF)
          </button>
          <button
            onClick={emailAllPayslips}
            disabled={records.length === 0 || bulkBusy !== null}
            className="flex items-center gap-2 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl transition-all justify-center disabled:opacity-50"
          >
            {bulkBusy === 'email' ? <Spinner size={16} /> : <Mail className="w-4 h-4" />} Email All Payslips
          </button>
        </div>
      </div>

      {notice && (
        <p
          className={`text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 ${
            notice.type === 'success' ? 'text-emerald-700 bg-emerald-50 border border-emerald-100' : 'text-rose-600 bg-rose-50 border border-rose-100'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
          {notice.text}
        </p>
      )}

      {/* Individual list */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size={26} /></div>
        ) : error ? (
          <p className="text-xs text-rose-600 text-center py-16">{error}</p>
        ) : records.length === 0 ? (
          <div className="text-center py-16">
            <AlertTriangle className="w-6 h-6 text-amber-400 mx-auto mb-2" />
            <p className="text-xs text-slate-400">No payroll runs generated for {monthLabel(monthYear)} yet — use "Run Payroll" first.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {records.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{r.employee_name}</p>
                  <p className="text-[11px] text-slate-400">{r.department || '—'} &middot; Net {money(r.net_salary)}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => viewPayslip(r)}
                    disabled={busyId === r.id}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-600 text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                    title="View / Print"
                  >
                    {busyId === r.id ? <Spinner size={14} /> : <Eye className="w-3.5 h-3.5" />} View
                  </button>
                  <button
                    onClick={() => downloadPayslip(r)}
                    disabled={busyId === r.id}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                  >
                    {busyId === r.id ? <Spinner size={14} /> : <FileDown className="w-3.5 h-3.5" />} PDF
                  </button>
                  <button
                    onClick={() => emailPayslip(r)}
                    disabled={busyId === r.id}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                  >
                    {busyId === r.id ? <Spinner size={14} /> : <Mail className="w-3.5 h-3.5" />} Email
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
