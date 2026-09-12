/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import {
  ArrowLeft,
  Banknote,
  Users,
  Wallet,
  Gift,
  PlayCircle,
  FileDown,
  FileSpreadsheet,
  ReceiptText,
  X,
  RefreshCw,
  AlertTriangle
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';
import { PayrollListPanel } from './PayrollListPanel';
import { SalaryStructureSetupPanel } from './SalaryStructureSetupPanel';
import { RunPayrollWizard } from './RunPayrollWizard';
import { AttendanceOvertimeSummaryPanel } from './AttendanceOvertimeSummaryPanel';
import { PayslipManagementPanel } from './PayslipManagementPanel';
import { LoanAdvanceManagementPanel } from './LoanAdvanceManagementPanel';
import { BonusIncentiveManagementPanel } from './BonusIncentiveManagementPanel';

interface PayrollModuleProps {
  token: string;
  onBack: () => void;
}

interface StatusBucket {
  count: number;
  amount: number;
}

interface DeptSlice {
  department: string;
  total: number;
}

interface TrendPoint {
  month_year: string;
  total: number;
}

interface DashboardSummary {
  month_year: string;
  total_expense: number;
  total_bonus: number;
  total_deductions: number;
  active_employees: number;
  paid: StatusBucket;
  unpaid: StatusBucket;
  processed: StatusBucket;
  department_distribution: DeptSlice[];
  monthly_trend: TrendPoint[];
}

interface PayrollEmployee {
  id: number;
  employee_code: string | null;
  name: string;
  department: string | null;
  designation: string | null;
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
  payment_method: string;
  remarks: string | null;
}

const DEPT_COLORS = [
  '#2563eb', '#16a34a', '#f59e0b', '#db2777', '#7c3aed',
  '#0891b2', '#dc2626', '#65a30d', '#0d9488', '#9333ea'
];

const currentMonthYear = () => new Date().toISOString().slice(0, 7);

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const compactMoney = (n: number | null | undefined) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 100000) return `৳${(v / 100000).toFixed(1)}L`;
  if (Math.abs(v) >= 1000) return `৳${(v / 1000).toFixed(1)}k`;
  return `৳${v.toFixed(0)}`;
};

const monthLabel = (my: string) => {
  const [y, m] = my.split('-').map(Number);
  if (!y || !m) return my;
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
};

// ---------------------------------------------------------------------------
// Monthly Payroll Expense Trend — plain SVG bar chart, no charting library.
// ---------------------------------------------------------------------------
const TrendChart: React.FC<{ points: TrendPoint[] }> = ({ points }) => {
  const max = Math.max(1, ...points.map((p) => p.total));
  const width = 560;
  const height = 200;
  const padding = { top: 10, right: 10, bottom: 28, left: 10 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const barGap = 18;
  const barWidth = points.length ? (chartW - barGap * (points.length - 1)) / points.length : 0;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="Monthly payroll expense trend">
      {points.map((p, i) => {
        const barHeight = max > 0 ? (p.total / max) * chartH : 0;
        const x = padding.left + i * (barWidth + barGap);
        const y = padding.top + (chartH - barHeight);
        return (
          <g key={p.month_year}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(barHeight, p.total > 0 ? 2 : 0)}
              rx={4}
              fill="#2563eb"
              opacity={i === points.length - 1 ? 1 : 0.55}
            />
            <text x={x + barWidth / 2} y={height - 12} textAnchor="middle" fontSize="10" fill="#64748b">
              {monthLabel(p.month_year).split(' ')[0]}
            </text>
            <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" fontSize="9" fill="#334155">
              {p.total > 0 ? compactMoney(p.total) : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ---------------------------------------------------------------------------
// Salary Distribution by Department — plain SVG donut + legend.
// ---------------------------------------------------------------------------
const DepartmentDonut: React.FC<{ slices: DeptSlice[] }> = ({ slices }) => {
  const total = slices.reduce((s, d) => s + d.total, 0);
  const size = 160;
  const strokeWidth = 26;
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;

  let offsetSoFar = 0;

  if (total <= 0) {
    return <p className="text-xs text-slate-400 text-center py-10">No payroll processed for this month yet.</p>;
  }

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Salary distribution by department">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
          {slices.map((d, i) => {
            const pct = d.total / total;
            const dash = pct * circumference;
            const el = (
              <circle
                key={d.department}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={DEPT_COLORS[i % DEPT_COLORS.length]}
                strokeWidth={strokeWidth}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offsetSoFar}
              />
            );
            offsetSoFar += dash;
            return el;
          })}
        </g>
        <text x={size / 2} y={size / 2 - 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="#0f172a">
          {compactMoney(total)}
        </text>
        <text x={size / 2} y={size / 2 + 11} textAnchor="middle" fontSize="8" fill="#94a3b8">
          Total Net
        </text>
      </svg>
      <ul className="flex-1 w-full space-y-1.5">
        {slices.map((d, i) => (
          <li key={d.department} className="flex items-center justify-between text-xs gap-2">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: DEPT_COLORS[i % DEPT_COLORS.length] }} />
              <span className="text-slate-600 truncate">{d.department}</span>
            </span>
            <span className="text-slate-800 font-medium shrink-0">{money(d.total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------
const SummaryCard: React.FC<{
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string;
  sub?: string;
}> = ({ icon, iconBg, label, value, sub }) => (
  <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 flex items-start gap-3">
    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${iconBg}`}>{icon}</div>
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-slate-800 truncate">{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  </div>
);


// ---------------------------------------------------------------------------
// "Generate Payslips" quick action — pick a record from the selected month
// and download a branded PDF payslip built with jsPDF + the shared letterhead.
// ---------------------------------------------------------------------------
const GeneratePayslipModal: React.FC<{ token: string; monthYear: string; onClose: () => void }> = ({
  token,
  monthYear,
  onClose
}) => {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingId, setGeneratingId] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(apiUrl(`/api/payroll?month_year=${monthYear}`), { headers: authHeaders });
        if (res.ok) setRecords(await res.json());
        else setError('Failed to load payroll records for this month.');
      } catch {
        setError('Failed to load payroll records for this month.');
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [monthYear]);

  const downloadPayslip = async (record: PayrollRecord) => {
    setGeneratingId(record.id);
    try {
      const logoImg = await loadImageElement(credenceLogo);
      const doc = new jsPDF();
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

      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `Payslip_${record.employee_name.replace(/\s+/g, '_')}_${record.month_year}.pdf`);
    } finally {
      setGeneratingId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <ReceiptText className="w-4 h-4 text-blue-600" /> Generate Payslips — {monthLabel(monthYear)}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-2">
          {loading ? (
            <div className="flex justify-center py-10"><Spinner size={24} /></div>
          ) : error ? (
            <p className="text-xs text-rose-600 text-center py-10">{error}</p>
          ) : records.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-10">No payroll records for this month yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {records.map((r) => (
                <li key={r.id} className="flex items-center justify-between px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{r.employee_name}</p>
                    <p className="text-[11px] text-slate-400">{r.department || '—'} &middot; Net {money(r.net_salary)}</p>
                  </div>
                  <button
                    onClick={() => downloadPayslip(r)}
                    disabled={generatingId === r.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold rounded-lg transition-all disabled:opacity-50 shrink-0"
                  >
                    {generatingId === r.id ? <Spinner size={14} /> : <FileDown className="w-3.5 h-3.5" />} PDF
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// "Download Reports" quick action — exports the selected month's payroll as
// Excel (xlsx) or a branded PDF summary table.
// ---------------------------------------------------------------------------
const DownloadReportsModal: React.FC<{ token: string; monthYear: string; onClose: () => void }> = ({
  token,
  monthYear,
  onClose
}) => {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(apiUrl(`/api/payroll?month_year=${monthYear}`), { headers: authHeaders });
        if (res.ok) setRecords(await res.json());
        else setError('Failed to load payroll records for this month.');
      } catch {
        setError('Failed to load payroll records for this month.');
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [monthYear]);

  const exportExcel = () => {
    setExporting('excel');
    try {
      const rows = records.map((r) => ({
        Employee: r.employee_name,
        Code: r.employee_code || '',
        Department: r.department || '',
        Designation: r.designation || '',
        'Working Days': r.total_working_days,
        Present: r.present_days,
        Absent: r.absent_days,
        Leave: r.leave_days,
        LWP: r.lwp_days,
        Basic: r.basic_amount,
        Allowances: r.allowances_total,
        Overtime: r.overtime_amount,
        Bonus: r.bonus_amount,
        'Gross Earned': r.gross_earned,
        'Total Deduction': r.total_deduction,
        'Net Salary': r.net_salary,
        Status: r.payment_status
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payroll');
      XLSX.writeFile(wb, `Payroll_Report_${monthYear}.xlsx`);
    } finally {
      setExporting(null);
    }
  };

  const exportPdf = async () => {
    setExporting('pdf');
    try {
      const logoImg = await loadImageElement(credenceLogo);
      const doc = new jsPDF({ orientation: 'landscape' });
      const startY = drawPdfLetterhead(doc, logoImg, {
        reportTitle: `Payroll Report — ${monthLabel(monthYear)}`,
        filters: [
          ['Records', String(records.length)],
          ['Total Net Payout', money(records.reduce((s, r) => s + Number(r.net_salary || 0), 0))]
        ]
      });
      autoTable(doc, {
        startY,
        margin: { top: startY, left: 10, right: 10 },
        head: [['Employee', 'Code', 'Department', 'Gross Earned', 'Total Deduction', 'Net Salary', 'Status']],
        body: records.map((r) => [
          r.employee_name,
          r.employee_code || '—',
          r.department || '—',
          money(r.gross_earned),
          money(r.total_deduction),
          money(r.net_salary),
          r.payment_status
        ]),
        styles: { fontSize: 8, cellPadding: 1.5 },
        headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 250, 252] }
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `Payroll_Report_${monthYear}.pdf`);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-blue-600" /> Download Reports — {monthLabel(monthYear)}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {loading ? (
            <div className="flex justify-center py-6"><Spinner size={24} /></div>
          ) : error ? (
            <p className="text-xs text-rose-600 text-center py-6">{error}</p>
          ) : (
            <>
              <p className="text-xs text-slate-500">{records.length} payroll record{records.length === 1 ? '' : 's'} found for this month.</p>
              <button
                onClick={exportExcel}
                disabled={records.length === 0 || exporting !== null}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-sm font-semibold rounded-lg transition-all disabled:opacity-50"
              >
                {exporting === 'excel' ? <Spinner size={16} /> : <FileSpreadsheet className="w-4 h-4" />} Export as Excel
              </button>
              <button
                onClick={exportPdf}
                disabled={records.length === 0 || exporting !== null}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-sm font-semibold rounded-lg transition-all disabled:opacity-50"
              >
                {exporting === 'pdf' ? <Spinner size={16} /> : <FileDown className="w-4 h-4" />} Export as PDF
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
export const PayrollModule: React.FC<PayrollModuleProps> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'list' | 'attendance' | 'payslips' | 'loans' | 'bonus' | 'setup'
  >('dashboard');
  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const [showProcessModal, setShowProcessModal] = useState(false);
  const [showPayslipModal, setShowPayslipModal] = useState(false);
  const [showReportsModal, setShowReportsModal] = useState(false);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setForbidden(false);
    try {
      const res = await fetch(apiUrl(`/api/payroll/dashboard-summary?month_year=${monthYear}`), { headers: authHeaders });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        setLoadError('Failed to load the Payroll dashboard.');
        return;
      }
      setSummary(await res.json());
    } catch {
      setLoadError('Failed to load the Payroll dashboard.');
    } finally {
      setLoading(false);
    }
  }, [monthYear, authHeaders]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const totalEmployeesPayrolled = (summary?.paid.count || 0) + (summary?.unpaid.count || 0) + (summary?.processed.count || 0);
  const paidAmount = summary?.paid.amount || 0;
  const outstandingAmount = (summary?.unpaid.amount || 0) + (summary?.processed.amount || 0);
  const outstandingCount = (summary?.unpaid.count || 0) + (summary?.processed.count || 0);

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Payroll']} />
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          </>
        )}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-4">
          <div className="p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                <Banknote className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-slate-800">Payroll Dashboard</h1>
                <p className="text-xs text-slate-500 mt-0.5 max-w-md">
                  Salary expense, disbursement status, and department breakdown at a glance.
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
                onClick={fetchSummary}
                className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
                title="Refresh"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Dashboard / Payroll List tabs */}
        <div className="flex items-center gap-1 mb-4 bg-white border border-slate-200 rounded-xl p-1 w-fit">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'dashboard' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
            }`}
          >
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab('list')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'list' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
            }`}
          >
            Payroll List
          </button>
          <button
            onClick={() => setActiveTab('attendance')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'attendance' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
            }`}
          >
            Attendance & OT
          </button>
          <button
            onClick={() => setActiveTab('payslips')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'payslips' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
            }`}
          >
            Payslips
          </button>
          <button
            onClick={() => setActiveTab('loans')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'loans' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
            }`}
          >
            Loans & Advances
          </button>
          <button
            onClick={() => setActiveTab('bonus')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'bonus' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
            }`}
          >
            Bonus & Incentive
          </button>
          <button
            onClick={() => setActiveTab('setup')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'setup' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
            }`}
          >
            Salary Setup
          </button>
        </div>

        {activeTab === 'list' ? (
          <PayrollListPanel token={token} />
        ) : activeTab === 'attendance' ? (
          <AttendanceOvertimeSummaryPanel token={token} />
        ) : activeTab === 'payslips' ? (
          <PayslipManagementPanel token={token} />
        ) : activeTab === 'loans' ? (
          <LoanAdvanceManagementPanel token={token} />
        ) : activeTab === 'bonus' ? (
          <BonusIncentiveManagementPanel token={token} />
        ) : activeTab === 'setup' ? (
          <SalaryStructureSetupPanel token={token} />
        ) : forbidden ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-10 text-center">
            <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-700">You don't have access to the Payroll dashboard.</p>
            <p className="text-xs text-slate-400 mt-1">Ask an Admin to grant Payroll access from Admin Panel → Users → Module Access.</p>
          </div>
        ) : loading && !summary ? (
          <div className="flex justify-center py-20"><Spinner size={28} /></div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-10 text-center">
            <p className="text-sm text-rose-600">{loadError}</p>
            <button onClick={fetchSummary} className="mt-3 text-xs font-semibold text-blue-600 hover:text-blue-800">
              Try again
            </button>
          </div>
        ) : summary ? (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <SummaryCard
                icon={<Banknote className="w-5 h-5 text-blue-600" />}
                iconBg="bg-blue-50"
                label={`Total Payroll — ${monthLabel(summary.month_year)}`}
                value={money(summary.total_expense)}
                sub={`${totalEmployeesPayrolled} employee${totalEmployeesPayrolled === 1 ? '' : 's'} processed`}
              />
              <SummaryCard
                icon={<Wallet className="w-5 h-5 text-emerald-600" />}
                iconBg="bg-emerald-50"
                label="Paid vs Unpaid"
                value={`${money(paidAmount)} paid`}
                sub={`${money(outstandingAmount)} outstanding across ${outstandingCount} run${outstandingCount === 1 ? '' : 's'}`}
              />
              <SummaryCard
                icon={<Gift className="w-5 h-5 text-amber-600" />}
                iconBg="bg-amber-50"
                label="Bonuses & Deductions"
                value={money(summary.total_bonus)}
                sub={`${money(summary.total_deductions)} total deductions`}
              />
              <SummaryCard
                icon={<Users className="w-5 h-5 text-violet-600" />}
                iconBg="bg-violet-50"
                label="Active Employees"
                value={String(summary.active_employees)}
                sub="Across all departments"
              />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Monthly Payroll Expense Trend</h3>
                <TrendChart points={summary.monthly_trend} />
              </div>
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Salary Distribution by Department</h3>
                <DepartmentDonut slices={summary.department_distribution} />
              </div>
            </div>

            {/* Quick actions */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Quick Actions</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button
                  onClick={() => setShowProcessModal(true)}
                  className="flex items-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-all justify-center"
                >
                  <PlayCircle className="w-4 h-4" /> Run Payroll
                </button>
                <button
                  onClick={() => setShowPayslipModal(true)}
                  className="flex items-center gap-2 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl transition-all justify-center"
                >
                  <ReceiptText className="w-4 h-4" /> Generate Payslips
                </button>
                <button
                  onClick={() => setShowReportsModal(true)}
                  className="flex items-center gap-2 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl transition-all justify-center"
                >
                  <FileSpreadsheet className="w-4 h-4" /> Download Reports
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {showProcessModal && (
        <RunPayrollWizard
          token={token}
          initialMonthYear={monthYear}
          onClose={() => setShowProcessModal(false)}
          onCompleted={fetchSummary}
        />
      )}
      {showPayslipModal && (
        <GeneratePayslipModal token={token} monthYear={monthYear} onClose={() => setShowPayslipModal(false)} />
      )}
      {showReportsModal && (
        <DownloadReportsModal token={token} monthYear={monthYear} onClose={() => setShowReportsModal(false)} />
      )}
    </div>
  );
};