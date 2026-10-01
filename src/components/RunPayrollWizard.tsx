/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Run Payroll — "পে-রোল প্রসেসিং পেজ", a 5-step wizard:
//   1. Select Month & Year
//   2. Attendance & Leave Sync — review/edit each employee's Present/Absent/
//      Leave days for the month, auto-filled where attendance data exists
//      (GET /api/payroll/wizard/attendance-summary).
//   3. Adjustments — manual Bonus/Incentive, Overtime, and Fine (Other
//      Deduction) per employee for this run.
//   4. Preview & Calculate — final breakdown per employee
//      (POST /api/payroll/generate-preview), nothing written yet.
//   5. Submit — commits every row in one batch (POST /api/payroll/generate-bulk).
//
// Same visual language as the rest of the Payroll module (card shell, table
// styling, Spinner, money()) so it drops in as a full-screen modal over
// PayrollModule.tsx.

import React, { useEffect, useMemo, useState } from 'react';
import { X, ChevronRight, ChevronLeft, RefreshCw, CheckCircle2, AlertTriangle, Info, Clock, Undo2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface RunPayrollWizardProps {
  token: string;
  initialMonthYear: string;
  onClose: () => void;
  onCompleted: () => void;
}

interface WizardRow {
  employee_id: number;
  employee_code: string | null;
  employee_name: string;
  department: string | null;
  designation: string | null;
  total_working_days: number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  lwp_days: number;
  late_count: number;
  late_deduction_days: number;
  extreme_late_count: number;
  extreme_late_deduction_days: number;
  overtime_hours: number;
  overtime_amount: number;
  bonus_amount: number;
  other_deduction: number;
  remarks: string;
  has_attendance_data: boolean;
  has_salary_structure: boolean;
  already_generated: boolean;
  included: boolean;
  pending_bonus_amount?: number;
}

interface PreviewResult {
  employee_id: number;
  error?: string;
  already_generated?: boolean;
  basic_amount?: number;
  allowances_earned?: number;
  overtime_amount?: number;
  bonus_amount?: number;
  gross_earned?: number;
  absent_deduction?: number;
  late_deduction_days?: number;
  late_deduction_amount?: number;
  tax_deduction?: number;
  pf_deduction?: number;
  advance_deduction?: number;
  other_deduction?: number;
  total_deduction?: number;
  net_salary?: number;
}

interface SubmitResult {
  employee_id: number;
  success: boolean;
  net_salary?: number;
  error?: string;
}

const STEPS = ['Select Month', 'Attendance & Leave', 'Adjustments', 'Preview & Calculate', 'Submit'];

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthLabel = (my: string) => {
  const [y, m] = my.split('-').map(Number);
  if (!y || !m) return my;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

// "09:00:00" + 10 -> "9:10 AM" — used to spell out the actual late-cutoff
// clock time next to the raw shift-start/grace numbers.
const addMinutesToTime = (time: string, minutes: number) => {
  const [h, m] = String(time || '09:00:00').split(':').map(Number);
  const total = h * 60 + m + Number(minutes || 0);
  const hh = Math.floor((total % 1440) / 60);
  const mm = total % 60;
  const period = hh >= 12 ? 'PM' : 'AM';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12}:${String(mm).padStart(2, '0')} ${period}`;
};

const dateLabel = (iso: string) => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
};

export const RunPayrollWizard: React.FC<RunPayrollWizardProps> = ({ token, initialMonthYear, onClose, onCompleted }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [step, setStep] = useState(1);
  const [monthYear, setMonthYear] = useState(initialMonthYear);
  const [rows, setRows] = useState<WizardRow[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState('');

  const [previewResults, setPreviewResults] = useState<Map<number, PreviewResult>>(new Map());
  const [calculating, setCalculating] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const [latePolicy, setLatePolicy] = useState<{
    shift_start_time: string;
    grace_minutes: number;
    lates_per_deduction_day: number;
    extreme_grace_minutes: number;
    extreme_lates_per_deduction_day: number;
  } | null>(null);
  const [viewingLateFor, setViewingLateFor] = useState<WizardRow | null>(null);

  const [paymentMethod, setPaymentMethod] = useState('Bank Transfer');
  const [submitting, setSubmitting] = useState(false);
  const [submitResults, setSubmitResults] = useState<SubmitResult[] | null>(null);
  const [submitError, setSubmitError] = useState('');

  const fetchSummary = async () => {
    setLoadingSummary(true);
    setSummaryError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/wizard/attendance-summary?month_year=${monthYear}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setSummaryError(data.error || 'Failed to load attendance summary.');
        return;
      }
      setLatePolicy(data.late_policy || null);
      setRows(
        (data.employees || []).map((e: any) => ({
          ...e,
          overtime_amount: 0,
          // Pre-filled from any bonus staged earlier via Bonus & Incentive
          // -> "Stage" (POST /api/payroll/pending-bonuses) for an employee
          // who had no run yet for this month — still editable here, and
          // consumed server-side once this run is actually generated.
          bonus_amount: Number(e.pending_bonus_amount) || 0,
          other_deduction: 0,
          remarks: '',
          included: e.has_salary_structure && !e.already_generated
        }))
      );
    } catch {
      setSummaryError('Failed to load attendance summary.');
    } finally {
      setLoadingSummary(false);
    }
  };

  const goToStep2 = async () => {
    setStep(2);
    await fetchSummary();
  };

  const updateRow = (employeeId: number, patch: Partial<WizardRow>) => {
    setRows((prev) => prev.map((r) => (r.employee_id === employeeId ? { ...r, ...patch } : r)));
  };

  const includedRows = rows.filter((r) => r.included);

  const runPreview = async () => {
    setCalculating(true);
    setPreviewError('');
    try {
      const res = await fetch(apiUrl('/api/payroll/generate-preview'), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          month_year: monthYear,
          employees: includedRows.map((r) => ({
            employee_id: r.employee_id,
            total_working_days: r.total_working_days,
            present_days: r.present_days,
            absent_days: r.absent_days,
            leave_days: r.leave_days,
            lwp_days: r.lwp_days,
            // Delay + Extreme Delay combined — both tiers price identically
            // (one deducted day per threshold crossed), the server's preview
            // math just needs the total day count, not which tier it came
            // from; the tiers stay visually separate in Step 2/late-summary.
            late_count: r.late_count + r.extreme_late_count,
            late_deduction_days: r.late_deduction_days + r.extreme_late_deduction_days,
            overtime_amount: r.overtime_amount,
            bonus_amount: r.bonus_amount,
            other_deduction: r.other_deduction
          }))
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setPreviewError(data.error || 'Failed to calculate preview.');
        return;
      }
      const map = new Map<number, PreviewResult>();
      for (const r of data.results || []) map.set(r.employee_id, r);
      setPreviewResults(map);
    } catch {
      setPreviewError('Failed to calculate preview.');
    } finally {
      setCalculating(false);
    }
  };

  const goToStep4 = async () => {
    setStep(4);
    await runPreview();
  };

  const submitBatch = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const validRows = includedRows.filter((r) => {
        const p = previewResults.get(r.employee_id);
        return p && !p.error;
      });
      const res = await fetch(apiUrl('/api/payroll/generate-bulk'), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          month_year: monthYear,
          payment_method: paymentMethod,
          employees: validRows.map((r) => ({
            employee_id: r.employee_id,
            total_working_days: r.total_working_days,
            present_days: r.present_days,
            absent_days: r.absent_days,
            leave_days: r.leave_days,
            lwp_days: r.lwp_days,
            late_count: r.late_count + r.extreme_late_count,
            late_deduction_days: r.late_deduction_days + r.extreme_late_deduction_days,
            overtime_hours: r.overtime_hours,
            overtime_amount: r.overtime_amount,
            bonus_amount: r.bonus_amount,
            other_deduction: r.other_deduction,
            remarks: r.remarks || null
          }))
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error || 'Failed to process payroll batch.');
        return;
      }
      setSubmitResults(data.results || []);
      onCompleted();
    } catch {
      setSubmitError('Failed to process payroll batch.');
    } finally {
      setSubmitting(false);
    }
  };

  const previewTotals = includedRows.reduce(
    (acc, r) => {
      const p = previewResults.get(r.employee_id);
      if (p && !p.error) {
        acc.gross += p.gross_earned || 0;
        acc.deductions += p.total_deduction || 0;
        acc.net += p.net_salary || 0;
        acc.count += 1;
      }
      return acc;
    },
    { gross: 0, deductions: 0, net: 0, count: 0 }
  );

  const numInput = (row: WizardRow, key: keyof WizardRow, width = 'w-16') => (
    <input
      type="number"
      value={row[key] as number}
      disabled={!row.included}
      onChange={(e) => updateRow(row.employee_id, { [key]: Number(e.target.value) } as any)}
      className={`${width} px-1.5 py-1 text-xs border border-slate-200 rounded-md text-right focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-slate-50 disabled:text-slate-300`}
    />
  );

  return (
    <>
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <h2 className="text-sm font-semibold text-slate-800">Run Payroll — {monthLabel(monthYear)}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1 px-5 py-3 border-b border-slate-100 shrink-0 overflow-x-auto">
          {STEPS.map((label, i) => {
            const num = i + 1;
            const active = step === num;
            const done = step > num;
            return (
              <React.Fragment key={label}>
                <div className="flex items-center gap-1.5 shrink-0">
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      active ? 'bg-blue-600 text-white' : done ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    {done ? <CheckCircle2 className="w-3 h-3" /> : num}
                  </div>
                  <span className={`text-[11px] font-medium whitespace-nowrap ${active ? 'text-slate-800' : 'text-slate-400'}`}>{label}</span>
                </div>
                {num < STEPS.length && <div className="w-6 h-px bg-slate-200 shrink-0" />}
              </React.Fragment>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {step === 1 && (
            <div className="max-w-sm mx-auto py-10 text-center space-y-4">
              <p className="text-sm text-slate-600">Select the month you want to run Payroll for.</p>
              <input
                type="month"
                value={monthYear}
                onChange={(e) => setMonthYear(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-center focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs text-slate-500">
                    Present/Absent/Leave days for {monthLabel(monthYear)}, auto-filled where attendance data exists — edit any row as needed.
                  </p>
                  {latePolicy && (
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      Delay: shift starts {latePolicy.shift_start_time?.slice(0, 5)}, grace {latePolicy.grace_minutes} min (late past{' '}
                      {addMinutesToTime(latePolicy.shift_start_time, latePolicy.grace_minutes)}), {latePolicy.lates_per_deduction_day} lates ={' '}
                      1 day's pay deducted. Extreme Delay: past{' '}
                      {addMinutesToTime(latePolicy.shift_start_time, latePolicy.extreme_grace_minutes)}, {latePolicy.extreme_lates_per_deduction_day}{' '}
                      late{latePolicy.extreme_lates_per_deduction_day === 1 ? '' : 's'} = 1 day's pay deducted.
                    </p>
                  )}
                </div>
                <button
                  onClick={fetchSummary}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 hover:text-blue-600 border border-slate-200 rounded-lg shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Re-sync
                </button>
              </div>
              {loadingSummary ? (
                <div className="flex justify-center py-16"><Spinner size={26} /></div>
              ) : summaryError ? (
                <p className="text-xs text-rose-600 text-center py-16">{summaryError}</p>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded-xl">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
                      <tr>
                        <th className="px-3 py-2 text-left">Include</th>
                        <th className="px-3 py-2 text-left">Employee</th>
                        <th className="px-3 py-2 text-right">Working Days</th>
                        <th className="px-3 py-2 text-right">Present</th>
                        <th className="px-3 py-2 text-right">Absent</th>
                        <th className="px-3 py-2 text-right">Leave</th>
                        <th className="px-3 py-2 text-right">LWP</th>
                        <th className="px-3 py-2 text-right">Late</th>
                        <th className="px-3 py-2 text-left">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {rows.map((r) => (
                        <tr key={r.employee_id} className={!r.included ? 'bg-slate-50/60' : ''}>
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={r.included}
                              disabled={!r.has_salary_structure || r.already_generated}
                              onChange={(e) => updateRow(r.employee_id, { included: e.target.checked })}
                            />
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <p className="font-medium text-slate-800">{r.employee_name}</p>
                            <p className="text-[10px] text-slate-400">{r.employee_code || '—'} · {r.department || '—'}</p>
                          </td>
                          <td className="px-3 py-2 text-right">{numInput(r, 'total_working_days')}</td>
                          <td className="px-3 py-2 text-right">{numInput(r, 'present_days')}</td>
                          <td className="px-3 py-2 text-right">{numInput(r, 'absent_days')}</td>
                          <td className="px-3 py-2 text-right">{numInput(r, 'leave_days')}</td>
                          <td className="px-3 py-2 text-right">{numInput(r, 'lwp_days')}</td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            <button
                              onClick={() => setViewingLateFor(r)}
                              disabled={!r.late_count && !r.extreme_late_count}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold ${
                                r.late_count > 0
                                  ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                                  : 'text-slate-300 cursor-default'
                              }`}
                              title={r.late_count ? 'View / waive late days' : 'No late days this month'}
                            >
                              <Clock className="w-3 h-3" /> {r.late_count || 0}
                            </button>
                            {r.extreme_late_count > 0 && (
                              <button
                                onClick={() => setViewingLateFor(r)}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 ml-1 rounded-md text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100"
                                title="View / waive Extreme Delay days"
                              >
                                <Clock className="w-3 h-3" /> {r.extreme_late_count}
                              </button>
                            )}
                            {(r.late_deduction_days > 0 || r.extreme_late_deduction_days > 0) && (
                              <p className="text-[9px] text-rose-500 mt-0.5">
                                −{r.late_deduction_days + r.extreme_late_deduction_days} day
                                {r.late_deduction_days + r.extreme_late_deduction_days === 1 ? '' : 's'} pay
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {r.already_generated ? (
                              <span className="text-[10px] font-semibold text-amber-600">Already generated</span>
                            ) : !r.has_salary_structure ? (
                              <span className="text-[10px] font-semibold text-rose-600">No Salary Structure</span>
                            ) : !r.has_attendance_data ? (
                              <span className="text-[10px] text-slate-400">No attendance source — defaulted full present</span>
                            ) : (
                              <span className="text-[10px] text-emerald-600">Synced</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div>
              <p className="text-xs text-slate-500 mb-3">
                Add any manual Bonus/Incentive, Overtime, or Fine for this run — only for the {includedRows.length} employee
                {includedRows.length === 1 ? '' : 's'} included from Step 2.
              </p>
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
                    <tr>
                      <th className="px-3 py-2 text-left">Employee</th>
                      <th className="px-3 py-2 text-right">OT Hours</th>
                      <th className="px-3 py-2 text-right">OT Amount</th>
                      <th className="px-3 py-2 text-right">Bonus / Incentive</th>
                      <th className="px-3 py-2 text-right">Fine / Other Ded.</th>
                      <th className="px-3 py-2 text-left">Remarks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {includedRows.map((r) => (
                      <tr key={r.employee_id}>
                        <td className="px-3 py-2 whitespace-nowrap font-medium text-slate-800">{r.employee_name}</td>
                        <td className="px-3 py-2 text-right">{numInput(r, 'overtime_hours')}</td>
                        <td className="px-3 py-2 text-right">{numInput(r, 'overtime_amount', 'w-20')}</td>
                        <td className="px-3 py-2 text-right">
                          {numInput(r, 'bonus_amount', 'w-20')}
                          {!!r.pending_bonus_amount && (
                            <p className="text-[9px] text-amber-600 mt-0.5">Staged: {money(r.pending_bonus_amount)}</p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">{numInput(r, 'other_deduction', 'w-20')}</td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={r.remarks}
                            onChange={(e) => updateRow(r.employee_id, { remarks: e.target.value })}
                            placeholder="Optional"
                            className="w-32 px-1.5 py-1 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        </td>
                      </tr>
                    ))}
                    {includedRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                          No employees included — go back to Step 2.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-slate-500">Final calculation before submitting — nothing is saved yet.</p>
                <button
                  onClick={runPreview}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 hover:text-blue-600 border border-slate-200 rounded-lg shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Recalculate
                </button>
              </div>
              {calculating ? (
                <div className="flex justify-center py-16"><Spinner size={26} /></div>
              ) : previewError ? (
                <p className="text-xs text-rose-600 text-center py-16">{previewError}</p>
              ) : (
                <>
                  <div className="overflow-x-auto border border-slate-200 rounded-xl">
                    <table className="min-w-full divide-y divide-slate-200">
                      <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
                        <tr>
                          <th className="px-3 py-2 text-left">Employee</th>
                          <th className="px-3 py-2 text-right">Gross Earned</th>
                          <th className="px-3 py-2 text-right">Deductions</th>
                          <th className="px-3 py-2 text-right">Net Salary</th>
                          <th className="px-3 py-2 text-left">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {includedRows.map((r) => {
                          const p = previewResults.get(r.employee_id);
                          return (
                            <tr key={r.employee_id}>
                              <td className="px-3 py-2 whitespace-nowrap font-medium text-slate-800">{r.employee_name}</td>
                              <td className="px-3 py-2 text-right">{p && !p.error ? money(p.gross_earned) : '—'}</td>
                              <td className="px-3 py-2 text-right text-rose-600">{p && !p.error ? money(p.total_deduction) : '—'}</td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-900">{p && !p.error ? money(p.net_salary) : '—'}</td>
                              <td className="px-3 py-2">
                                {!p ? (
                                  <span className="text-[10px] text-slate-400">—</span>
                                ) : p.error ? (
                                  <span className="text-[10px] font-semibold text-rose-600">{p.error}</span>
                                ) : (
                                  <span className="text-[10px] font-semibold text-emerald-600">Ready</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-50 font-semibold text-slate-700">
                          <td className="px-3 py-2">Total ({previewTotals.count} employee{previewTotals.count === 1 ? '' : 's'})</td>
                          <td className="px-3 py-2 text-right">{money(previewTotals.gross)}</td>
                          <td className="px-3 py-2 text-right text-rose-600">{money(previewTotals.deductions)}</td>
                          <td className="px-3 py-2 text-right">{money(previewTotals.net)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <label className="text-[11px] text-slate-500">Payment Method</label>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                    >
                      <option>Bank Transfer</option>
                      <option>Cash</option>
                      <option>Mobile Banking</option>
                      <option>Cheque</option>
                    </select>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 5 && (
            <div className="max-w-lg mx-auto py-6 space-y-4">
              {!submitResults ? (
                <>
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-start gap-2">
                    <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-blue-800">
                      Ready to process Payroll for {monthLabel(monthYear)} — {previewTotals.count} employee
                      {previewTotals.count === 1 ? '' : 's'}, total net {money(previewTotals.net)}. This creates one
                      Unpaid payroll run per employee; nothing is disbursed yet.
                    </p>
                  </div>
                  {submitError && <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{submitError}</p>}
                  <button
                    onClick={submitBatch}
                    disabled={submitting || previewTotals.count === 0}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl disabled:opacity-50"
                  >
                    {submitting ? <Spinner size={16} /> : 'Submit for Processing'}
                  </button>
                </>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-emerald-700">
                    <CheckCircle2 className="w-5 h-5" />
                    <p className="text-sm font-semibold">
                      {submitResults.filter((r) => r.success).length} of {submitResults.length} payroll runs generated.
                    </p>
                  </div>
                  {submitResults.some((r) => !r.success) && (
                    <div className="border border-amber-200 bg-amber-50 rounded-xl p-3 space-y-1">
                      <p className="text-[11px] font-semibold text-amber-700 flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> Some rows failed
                      </p>
                      {submitResults.filter((r) => !r.success).map((r) => {
                        const row = rows.find((x) => x.employee_id === r.employee_id);
                        return (
                          <p key={r.employee_id} className="text-[11px] text-amber-700">
                            {row?.employee_name || `Employee #${r.employee_id}`}: {r.error}
                          </p>
                        );
                      })}
                    </div>
                  )}
                  <button
                    onClick={onClose}
                    className="w-full px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl"
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav */}
        {!(step === 5 && submitResults) && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-slate-200 shrink-0">
            <button
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              disabled={step === 1}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-30"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Back
            </button>
            {step < 5 ? (
              <button
                onClick={() => {
                  if (step === 1) goToStep2();
                  else if (step === 3) goToStep4();
                  else setStep((s) => s + 1);
                }}
                disabled={(step === 2 && (loadingSummary || includedRows.length === 0)) || (step === 4 && calculating)}
                className="flex items-center gap-1 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
    {viewingLateFor && (
      <LateDaysModal
        authHeaders={authHeaders}
        employeeId={viewingLateFor.employee_id}
        employeeName={viewingLateFor.employee_name}
        monthYear={monthYear}
        onClose={() => {
          setViewingLateFor(null);
          // Waiving/un-waiving changes late_count for this employee, which
          // changes late_deduction_days and therefore the payroll math — a
          // full re-sync keeps Step 2 (and any already-calculated Step 4
          // preview, on its own Recalculate) consistent with the server.
          fetchSummary();
        }}
      />
    )}
    </>
  );
};

// Per-employee, per-day late drill-down — lists every late day this month
// (from real check-in times, per the current Late Policy) and lets HR waive
// or un-waive any single one, e.g. a documented traffic/medical exception
// that shouldn't count toward the "3 lates = 1 day" threshold. Closing this
// always re-syncs Step 2 so the row's Late count reflects whatever changed.
interface LateDay {
  date: string;
  extreme: boolean;
  waived: boolean;
  waiver_id: number | null;
  reason: string | null;
}

const LateDaysModal: React.FC<{
  authHeaders: Record<string, string>;
  employeeId: number;
  employeeName: string;
  monthYear: string;
  onClose: () => void;
}> = ({ authHeaders, employeeId, employeeName, monthYear, onClose }) => {
  const [days, setDays] = useState<LateDay[]>([]);
  const [policy, setPolicy] = useState<{
    shift_start_time: string;
    grace_minutes: number;
    lates_per_deduction_day: number;
    extreme_grace_minutes: number;
    extreme_lates_per_deduction_day: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/late-summary/${employeeId}?month_year=${monthYear}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load late-day details.');
        return;
      }
      setDays(data.days || []);
      setPolicy(data.policy || null);
    } catch {
      setError('Failed to load late-day details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, monthYear]);

  const waive = async (date: string) => {
    setBusyDate(date);
    try {
      const res = await fetch(apiUrl('/api/payroll/late-waivers'), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: employeeId, waiver_date: date, reason: reasonDraft[date] || null })
      });
      if (res.ok) await load();
    } finally {
      setBusyDate(null);
    }
  };

  const unwaive = async (day: LateDay) => {
    if (!day.waiver_id) return;
    setBusyDate(day.date);
    try {
      const res = await fetch(apiUrl(`/api/payroll/late-waivers/${day.waiver_id}`), { method: 'DELETE', headers: authHeaders });
      if (res.ok) await load();
    } finally {
      setBusyDate(null);
    }
  };

  const countedLate = days.filter((d) => !d.waived && !d.extreme).length;
  const deductionDays = policy ? Math.floor(countedLate / Number(policy.lates_per_deduction_day || 1)) : 0;
  const countedExtremeLate = days.filter((d) => !d.waived && d.extreme).length;
  const extremeDeductionDays = policy ? Math.floor(countedExtremeLate / Number(policy.extreme_lates_per_deduction_day || 1)) : 0;

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Late Days — {employeeName}</h2>
            <p className="text-[11px] text-slate-400">{monthLabel(monthYear)}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading ? (
            <div className="flex justify-center py-10"><Spinner size={24} /></div>
          ) : error ? (
            <p className="text-xs text-rose-600 text-center py-10">{error}</p>
          ) : days.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-10">No late days this month.</p>
          ) : (
            <>
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[11px] text-slate-600 space-y-1">
                <p>
                  {countedLate} counted Delay day{countedLate === 1 ? '' : 's'}
                  {policy ? ` — every ${policy.lates_per_deduction_day} lates deducts 1 day's pay` : ''} →{' '}
                  <span className="font-semibold text-rose-600">{deductionDays} day{deductionDays === 1 ? '' : 's'}</span> deducted.
                </p>
                <p>
                  {countedExtremeLate} counted Extreme Delay day{countedExtremeLate === 1 ? '' : 's'}
                  {policy ? ` — every ${policy.extreme_lates_per_deduction_day} deducts 1 day's pay` : ''} →{' '}
                  <span className="font-semibold text-rose-600">{extremeDeductionDays} day{extremeDeductionDays === 1 ? '' : 's'}</span> deducted.
                </p>
              </div>
              <div className="space-y-2">
                {days.map((d) => (
                  <div
                    key={d.date}
                    className={`border rounded-lg p-2.5 ${d.waived ? 'border-slate-200 bg-slate-50/60' : d.extreme ? 'border-rose-200 bg-rose-50/60' : 'border-amber-200 bg-amber-50/60'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className={`text-xs font-medium ${d.waived ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                          {dateLabel(d.date)}
                          {d.extreme && (
                            <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wide text-rose-600 bg-rose-100 px-1.5 py-0.5 rounded-full">
                              Extreme
                            </span>
                          )}
                        </p>
                        {d.waived && d.reason && <p className="text-[10px] text-slate-400 mt-0.5">Waived: {d.reason}</p>}
                      </div>
                      {d.waived ? (
                        <button
                          onClick={() => unwaive(d)}
                          disabled={busyDate === d.date}
                          className="flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-slate-500 hover:text-blue-600 border border-slate-200 rounded-md disabled:opacity-50"
                        >
                          {busyDate === d.date ? <Spinner size={12} /> : <Undo2 className="w-3 h-3" />} Un-waive
                        </button>
                      ) : (
                        <button
                          onClick={() => waive(d.date)}
                          disabled={busyDate === d.date}
                          className="px-2 py-1 text-[11px] font-semibold text-amber-700 hover:text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-md disabled:opacity-50"
                        >
                          {busyDate === d.date ? <Spinner size={12} /> : 'Waive'}
                        </button>
                      )}
                    </div>
                    {!d.waived && (
                      <input
                        type="text"
                        value={reasonDraft[d.date] || ''}
                        onChange={(e) => setReasonDraft((prev) => ({ ...prev, [d.date]: e.target.value }))}
                        placeholder="Reason (optional) — e.g. approved late start"
                        className="w-full mt-2 px-2 py-1 text-[11px] border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400"
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200">
          <button onClick={onClose} className="w-full px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg">
            Done
          </button>
        </div>
      </div>
    </div>
  );
};