/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Attendance & OT — "Monthly Attendance & Overtime Summary".
//
// Reads already-generated payroll runs for the selected month
// (GET /api/payroll?month_year=...) and lets the Admin review/adjust the
// two things this page is scoped to:
//   * Overtime — OT Hours and the OT Amount actually paid.
//   * LWP (Leave Without Pay) — the unpaid-absence days that drive
//     absent_deduction.
// Editing a row calls the existing PUT /api/payroll/:id, which recomputes
// absent_deduction / gross_earned / net_salary server-side from the row's
// Salary Structure — this panel never does that math itself, so it can
// never drift from what Run Payroll / the Payroll List already show.
// A "Paid" run is read-only here too (PUT already refuses those).

import React, { useEffect, useMemo, useState } from 'react';
import { Clock, AlertTriangle, Pencil, Check, X, RefreshCw, Banknote } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface AttendanceOvertimeSummaryPanelProps {
  token: string;
}

interface PayrollRow {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  designation: string | null;
  month_year: string;
  total_working_days: number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  lwp_days: number;
  overtime_hours: number;
  overtime_amount: number;
  absent_deduction: number;
  net_salary: number;
  remarks: string | null;
  payment_status: 'unpaid' | 'processed' | 'paid';
}

interface EditState {
  overtime_hours: string;
  overtime_amount: string;
  absent_days: string;
  lwp_days: string;
  remarks: string;
}

const currentMonthYear = () => new Date().toISOString().slice(0, 7);

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthLabel = (my: string) => {
  const [y, m] = my.split('-').map(Number);
  if (!y || !m) return my;
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
};

export const AttendanceOvertimeSummaryPanel: React.FC<AttendanceOvertimeSummaryPanelProps> = ({ token }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [editingId, setEditingId] = useState<number | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState('');

  const fetchRows = async () => {
    setLoading(true);
    setError('');
    setEditingId(null);
    try {
      const res = await fetch(apiUrl(`/api/payroll?month_year=${monthYear}`), { headers: authHeaders });
      if (!res.ok) {
        setError(res.status === 403 ? "You don't have access to Payroll." : 'Failed to load payroll runs for this month.');
        return;
      }
      setRows(await res.json());
    } catch {
      setError('Failed to load payroll runs for this month.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthYear]);

  const startEdit = (r: PayrollRow) => {
    setEditingId(r.id);
    setRowError('');
    setEdit({
      overtime_hours: String(r.overtime_hours ?? 0),
      overtime_amount: String(r.overtime_amount ?? 0),
      absent_days: String(r.absent_days ?? 0),
      lwp_days: String(r.lwp_days ?? 0),
      remarks: r.remarks || ''
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEdit(null);
    setRowError('');
  };

  const saveEdit = async (r: PayrollRow) => {
    if (!edit) return;
    setSaving(true);
    setRowError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/${r.id}`), {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          total_working_days: r.total_working_days,
          present_days: r.present_days,
          absent_days: Number(edit.absent_days),
          leave_days: r.leave_days,
          lwp_days: Number(edit.lwp_days),
          overtime_hours: Number(edit.overtime_hours),
          overtime_amount: Number(edit.overtime_amount),
          bonus_amount: (r as any).bonus_amount ?? 0,
          other_deduction: (r as any).other_deduction ?? 0,
          remarks: edit.remarks
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setRowError(data.error || 'Failed to save changes.');
        return;
      }
      setEditingId(null);
      setEdit(null);
      await fetchRows();
    } catch {
      setRowError('Failed to save changes.');
    } finally {
      setSaving(false);
    }
  };

  const totals = rows.reduce(
    (acc, r) => {
      acc.otHours += Number(r.overtime_hours) || 0;
      acc.otAmount += Number(r.overtime_amount) || 0;
      acc.lwpDays += Number(r.lwp_days) || 0;
      acc.lwpDeduction += Number(r.absent_deduction) || 0;
      return acc;
    },
    { otHours: 0, otAmount: 0, lwpDays: 0, lwpDeduction: 0 }
  );

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-600" /> Monthly Attendance &amp; Overtime Summary
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5 max-w-md">
            Review OT hours/payment and LWP-driven salary cuts for {monthLabel(monthYear)}'s processed payroll runs, and adjust any row.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={monthYear}
            onChange={(e) => setMonthYear(e.target.value)}
            className="px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            onClick={fetchRows}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Summary strip */}
      {!loading && !error && rows.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <p className="text-[11px] text-slate-500">Total OT Hours</p>
            <p className="text-lg font-semibold text-slate-800">{totals.otHours.toFixed(1)}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <p className="text-[11px] text-slate-500">Total OT Payment</p>
            <p className="text-lg font-semibold text-slate-800">{money(totals.otAmount)}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <p className="text-[11px] text-slate-500">Total LWP Days</p>
            <p className="text-lg font-semibold text-slate-800">{totals.lwpDays}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <p className="text-[11px] text-slate-500">Absent/LWP Deduction</p>
            <p className="text-lg font-semibold text-rose-600">{money(totals.lwpDeduction)}</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size={26} /></div>
        ) : error ? (
          <p className="text-xs text-rose-600 text-center py-16">{error}</p>
        ) : rows.length === 0 ? (
          <div className="text-center py-16">
            <AlertTriangle className="w-6 h-6 text-amber-400 mx-auto mb-2" />
            <p className="text-xs text-slate-400">
              No payroll runs generated for {monthLabel(monthYear)} yet — use "Run Payroll" first.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2.5 text-left">Employee</th>
                  <th className="px-3 py-2.5 text-right">Present</th>
                  <th className="px-3 py-2.5 text-right">Absent</th>
                  <th className="px-3 py-2.5 text-right">Leave</th>
                  <th className="px-3 py-2.5 text-right">LWP</th>
                  <th className="px-3 py-2.5 text-right">OT Hours</th>
                  <th className="px-3 py-2.5 text-right">OT Amount</th>
                  <th className="px-3 py-2.5 text-right">Absent/LWP Cut</th>
                  <th className="px-3 py-2.5 text-right">Net Salary</th>
                  <th className="px-3 py-2.5 text-left">Remarks</th>
                  <th className="px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {rows.map((r) => {
                  const isEditing = editingId === r.id;
                  const locked = r.payment_status === 'paid';
                  return (
                    <tr key={r.id} className={isEditing ? 'bg-blue-50/40' : 'hover:bg-slate-50/80'}>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <p className="font-medium text-slate-800">{r.employee_name}</p>
                        <p className="text-[10px] text-slate-400">{r.employee_code || '—'} · {r.department || '—'}</p>
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{r.present_days}</td>
                      <td className="px-3 py-2.5 text-right">
                        {isEditing ? (
                          <input
                            type="number"
                            value={edit!.absent_days}
                            onChange={(e) => setEdit((s) => (s ? { ...s, absent_days: e.target.value } : s))}
                            className="w-14 px-1.5 py-1 text-xs border border-slate-200 rounded-md text-right focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        ) : (
                          <span className="text-slate-600">{r.absent_days}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{r.leave_days}</td>
                      <td className="px-3 py-2.5 text-right">
                        {isEditing ? (
                          <input
                            type="number"
                            value={edit!.lwp_days}
                            onChange={(e) => setEdit((s) => (s ? { ...s, lwp_days: e.target.value } : s))}
                            className="w-14 px-1.5 py-1 text-xs border border-slate-200 rounded-md text-right focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        ) : (
                          <span className={r.lwp_days > 0 ? 'text-rose-600 font-medium' : 'text-slate-600'}>{r.lwp_days}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {isEditing ? (
                          <input
                            type="number"
                            value={edit!.overtime_hours}
                            onChange={(e) => setEdit((s) => (s ? { ...s, overtime_hours: e.target.value } : s))}
                            className="w-16 px-1.5 py-1 text-xs border border-slate-200 rounded-md text-right focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        ) : (
                          <span className="text-slate-600">{r.overtime_hours}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {isEditing ? (
                          <input
                            type="number"
                            value={edit!.overtime_amount}
                            onChange={(e) => setEdit((s) => (s ? { ...s, overtime_amount: e.target.value } : s))}
                            className="w-20 px-1.5 py-1 text-xs border border-slate-200 rounded-md text-right focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        ) : (
                          <span className="text-emerald-700 font-medium">{money(r.overtime_amount)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-rose-600">{money(r.absent_deduction)}</td>
                      <td className="px-3 py-2.5 text-right font-semibold text-slate-900">{money(r.net_salary)}</td>
                      <td className="px-3 py-2.5">
                        {isEditing ? (
                          <input
                            type="text"
                            value={edit!.remarks}
                            onChange={(e) => setEdit((s) => (s ? { ...s, remarks: e.target.value } : s))}
                            placeholder="Optional"
                            className="w-28 px-1.5 py-1 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        ) : (
                          <span className="text-slate-400">{r.remarks || '—'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {locked ? (
                          <span className="text-[10px] text-slate-300">Paid · locked</span>
                        ) : isEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => saveEdit(r)}
                              disabled={saving}
                              className="w-7 h-7 flex items-center justify-center text-emerald-600 hover:bg-emerald-50 rounded-lg disabled:opacity-50"
                              title="Save"
                            >
                              {saving ? <Spinner size={12} /> : <Check className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={cancelEdit}
                              disabled={saving}
                              className="w-7 h-7 flex items-center justify-center text-slate-400 hover:bg-slate-100 rounded-lg disabled:opacity-50"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => startEdit(r)}
                            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg ml-auto"
                            title="Adjust OT / LWP"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rowError && (
        <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <Banknote className="w-3.5 h-3.5 shrink-0" /> {rowError}
        </p>
      )}
    </div>
  );
};
