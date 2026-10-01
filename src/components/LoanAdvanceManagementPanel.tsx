/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Loans & Advances — "লোন এবং অ্যাডভান্স স্যালারি".
//
// Built on the existing employee_advances API
// (GET/POST/PUT/DELETE /api/payroll/advances) plus the newer
// advance_requests API (GET /api/payroll/advance-requests,
// POST /api/payroll/advance-requests/:id/decision) for the
// employee-submit -> Admin-approve/reject flow. Three tabs sharing related
// data:
//   * Requests — log a new advance/loan directly (an Admin creating one
//     here *is* immediate approval) and see every one ever logged.
//   * Approvals — pending advance_requests submitted by employees with a
//     linked login (POST /api/user-advance-requests, elsewhere in the app);
//     Approve turns one into a real employee_advances row, Reject closes it
//     out with a remark. Both decisions are final — a decided request drops
//     off this list.
//   * Repayment Tracker — the same employee_advances rows, read-focused:
//     EMI, paid so far, remaining balance, progress bar.
//
// Repayment itself is still fully automatic and unchanged: paid_amount only
// ever moves when a payroll run that deducted this advance is marked Paid
// (POST /api/payroll/:id/mark-paid, in PayrollRoutes.ts) — nothing on this
// page writes paid_amount directly.

import React, { useEffect, useMemo, useState } from 'react';
import {
  HandCoins,
  Plus,
  Pencil,
  Trash2,
  X,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Wallet
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface LoanAdvanceManagementPanelProps {
  token: string;
}

interface AdvanceRecord {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  total_amount: number;
  monthly_installment: number;
  paid_amount: number;
  remaining_amount: number;
  reason: string | null;
  status: 'active' | 'completed';
  created_at: string;
}

interface AdvanceRequest {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  total_amount: number;
  monthly_installment: number;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

interface EmployeeLite {
  id: number;
  employee_code: string | null;
  name: string;
  department: string | null;
  designation: string | null;
}

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const LoanAdvanceManagementPanel: React.FC<LoanAdvanceManagementPanelProps> = ({ token }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [subTab, setSubTab] = useState<'requests' | 'approvals' | 'tracker'>('requests');

  const [advances, setAdvances] = useState<AdvanceRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'completed'>('active');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');

  const [pendingRequests, setPendingRequests] = useState<AdvanceRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsError, setRequestsError] = useState('');
  const [decidingId, setDecidingId] = useState<number | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AdvanceRecord | null>(null);

  const fetchAdvances = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetch(apiUrl(`/api/payroll/advances?${params.toString()}`), { headers: authHeaders });
      if (!res.ok) {
        setError(res.status === 403 ? "You don't have access to Loans & Advances." : 'Failed to load advances.');
        return;
      }
      setAdvances(await res.json());
    } catch {
      setError('Failed to load advances.');
    } finally {
      setLoading(false);
    }
  };

  const fetchPendingRequests = async () => {
    setRequestsLoading(true);
    setRequestsError('');
    try {
      const res = await fetch(apiUrl('/api/payroll/advance-requests?status=pending'), { headers: authHeaders });
      if (!res.ok) {
        setRequestsError(res.status === 403 ? "You don't have access to Loans & Advances." : 'Failed to load pending requests.');
        return;
      }
      setPendingRequests(await res.json());
    } catch {
      setRequestsError('Failed to load pending requests.');
    } finally {
      setRequestsLoading(false);
    }
  };

  useEffect(() => {
    fetchAdvances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  useEffect(() => {
    fetchPendingRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decideRequest = async (request: AdvanceRequest, action: 'approve' | 'reject') => {
    if (action === 'reject' && !window.confirm(`Reject ${request.employee_name}'s loan/advance request?`)) return;
    setDecidingId(request.id);
    setRequestsError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/advance-requests/${request.id}/decision`), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (!res.ok) {
        setRequestsError(data.error || `Failed to ${action} the request.`);
        return;
      }
      await fetchPendingRequests();
      if (action === 'approve') await fetchAdvances();
    } catch {
      setRequestsError(`Failed to ${action} the request.`);
    } finally {
      setDecidingId(null);
    }
  };

  const markCompleted = async (a: AdvanceRecord) => {
    if (!window.confirm(`Mark "${a.employee_name}"'s advance as fully settled (Completed)?`)) return;
    setActionError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/advances/${a.id}`), {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' })
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Failed to update advance.');
        return;
      }
      await fetchAdvances();
    } catch {
      setActionError('Failed to update advance.');
    }
  };

  const remove = async (a: AdvanceRecord) => {
    if (!window.confirm(`Delete this advance for "${a.employee_name}"? This cannot be undone.`)) return;
    setActionError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/advances/${a.id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Failed to delete advance.');
        return;
      }
      await fetchAdvances();
    } catch {
      setActionError('Failed to delete advance.');
    }
  };

  const totals = advances.reduce(
    (acc, a) => {
      acc.total += Number(a.total_amount) || 0;
      acc.paid += Number(a.paid_amount) || 0;
      acc.remaining += Number(a.remaining_amount) || 0;
      return acc;
    },
    { total: 0, paid: 0, remaining: 0 }
  );

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <HandCoins className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Loans &amp; Advance Salary</h2>
            <p className="text-[11px] text-slate-500 mt-0.5 max-w-md">
              Log employee loans/advances and track EMI recovery against each month's payroll.
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> New Loan / Advance
        </button>
      </div>

      <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1 w-fit">
        <button
          onClick={() => setSubTab('requests')}
          className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
            subTab === 'requests' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
          }`}
        >
          Requests
        </button>
        <button
          onClick={() => setSubTab('approvals')}
          className={`relative px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
            subTab === 'approvals' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
          }`}
        >
          Approvals
          {pendingRequests.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[9px] font-bold rounded-full bg-rose-500 text-white">
              {pendingRequests.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setSubTab('tracker')}
          className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
            subTab === 'tracker' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
          }`}
        >
          Repayment Tracker
        </button>
      </div>

      {/* Filters */}
      {subTab !== 'approvals' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-3 flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="all">All</option>
          </select>
          <button
            onClick={fetchAdvances}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {actionError && (
        <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{actionError}</p>
      )}

      {subTab === 'approvals' ? (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          {requestsError && (
            <p className="text-xs text-rose-600 bg-rose-50 border-b border-rose-100 px-4 py-2">{requestsError}</p>
          )}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
            <p className="text-xs text-slate-500">Loan/advance requests submitted by employees, awaiting a decision.</p>
            <button
              onClick={fetchPendingRequests}
              className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          {requestsLoading ? (
            <div className="flex justify-center py-16"><Spinner size={26} /></div>
          ) : pendingRequests.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-16">No pending requests.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {pendingRequests.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{r.employee_name}</p>
                    <p className="text-[11px] text-slate-400">
                      {r.employee_code || '—'} &middot; {money(r.total_amount)} total &middot; EMI {money(r.monthly_installment)}/mo
                      {r.reason ? ` · ${r.reason}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => decideRequest(r, 'approve')}
                      disabled={decidingId === r.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                    >
                      {decidingId === r.id ? <Spinner size={14} /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve
                    </button>
                    <button
                      onClick={() => decideRequest(r, 'reject')}
                      disabled={decidingId === r.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                    >
                      {decidingId === r.id ? <Spinner size={14} /> : <XCircle className="w-3.5 h-3.5" />} Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
      <>
      {subTab === 'tracker' && !loading && !error && advances.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <p className="text-[11px] text-slate-500">Total Issued</p>
            <p className="text-lg font-semibold text-slate-800">{money(totals.total)}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <p className="text-[11px] text-slate-500">Recovered So Far</p>
            <p className="text-lg font-semibold text-emerald-700">{money(totals.paid)}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <p className="text-[11px] text-slate-500">Outstanding</p>
            <p className="text-lg font-semibold text-rose-600">{money(totals.remaining)}</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size={26} /></div>
        ) : error ? (
          <p className="text-xs text-rose-600 text-center py-16">{error}</p>
        ) : advances.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-16">No advances match this filter.</p>
        ) : subTab === 'requests' ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2.5 text-left">Employee</th>
                  <th className="px-4 py-2.5 text-left">Reason</th>
                  <th className="px-4 py-2.5 text-right">Total Amount</th>
                  <th className="px-4 py-2.5 text-right">Monthly EMI</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {advances.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <p className="font-medium text-slate-800">{a.employee_name}</p>
                      <p className="text-[10px] text-slate-400">{a.employee_code || '—'}</p>
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">{a.reason || '—'}</td>
                    <td className="px-4 py-2.5 text-right text-slate-700">{money(a.total_amount)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-700">{money(a.monthly_installment)}</td>
                    <td className="px-4 py-2.5">
                      {a.status === 'completed' ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                          <CheckCircle2 className="w-2.5 h-2.5" /> Completed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                          <Clock className="w-2.5 h-2.5" /> Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => {
                            setEditing(a);
                            setShowForm(true);
                          }}
                          className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {a.status === 'active' && (
                          <button
                            onClick={() => markCompleted(a)}
                            className="px-2.5 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg"
                          >
                            Settle
                          </button>
                        )}
                        {Number(a.paid_amount) === 0 && (
                          <button
                            onClick={() => remove(a)}
                            className="w-7 h-7 flex items-center justify-center text-rose-500 hover:bg-rose-50 rounded-lg"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {advances.map((a) => {
              const pct = Number(a.total_amount) > 0 ? Math.min(100, (Number(a.paid_amount) / Number(a.total_amount)) * 100) : 0;
              return (
                <li key={a.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{a.employee_name}</p>
                      <p className="text-[11px] text-slate-400">{a.employee_code || '—'} &middot; EMI {money(a.monthly_installment)}/mo</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-semibold text-slate-800">{money(a.paid_amount)} / {money(a.total_amount)}</p>
                      <p className="text-[10px] text-rose-500">{money(a.remaining_amount)} remaining</p>
                    </div>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${a.status === 'completed' ? 'bg-emerald-500' : 'bg-blue-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      </>
      )}

      {showForm && (
        <AdvanceFormModal
          authHeaders={authHeaders}
          advance={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            fetchAdvances();
          }}
        />
      )}
    </div>
  );
};

const AdvanceFormModal: React.FC<{
  authHeaders: Record<string, string>;
  advance: AdvanceRecord | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ authHeaders, advance, onClose, onSaved }) => {
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [employeeId, setEmployeeId] = useState(advance ? String(advance.employee_id) : '');
  const [totalAmount, setTotalAmount] = useState(advance ? String(advance.total_amount) : '');
  const [installment, setInstallment] = useState(advance ? String(advance.monthly_installment) : '');
  const [reason, setReason] = useState(advance?.reason || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (advance) return; // editing: employee/total are fixed, no need to load the picker
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/payroll/employees'), { headers: authHeaders });
        if (res.ok) setEmployees(await res.json());
      } catch {
        // Dropdown just stays empty — error surfaces on submit instead.
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  const submit = async () => {
    setError('');
    if (!advance && !employeeId) {
      setError('Please select an employee.');
      return;
    }
    const inst = Number(installment);
    if (!inst || inst <= 0) {
      setError('Monthly EMI must be a positive number.');
      return;
    }
    if (!advance) {
      const total = Number(totalAmount);
      if (!total || total <= 0) {
        setError('Total Amount must be a positive number.');
        return;
      }
      if (inst > total) {
        setError("Monthly EMI can't be more than the Total Amount.");
        return;
      }
    }
    setSubmitting(true);
    try {
      const url = advance ? `/api/payroll/advances/${advance.id}` : '/api/payroll/advances';
      const res = await fetch(apiUrl(url), {
        method: advance ? 'PUT' : 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          advance
            ? { monthly_installment: inst, reason: reason.trim() || null }
            : { employee_id: Number(employeeId), total_amount: Number(totalAmount), monthly_installment: inst, reason: reason.trim() || null }
        )
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to save the advance.');
        return;
      }
      onSaved();
    } catch {
      setError('Failed to save the advance.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <Wallet className="w-4 h-4 text-blue-600" /> {advance ? 'Edit Advance' : 'New Loan / Advance'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          {!advance && (
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Employee</label>
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">Select an employee</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}{e.employee_code ? ` (${e.employee_code})` : ''}{e.department ? ` — ${e.department}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!advance && (
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Total Amount</label>
              <input
                type="number"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          )}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Monthly EMI (deducted from payroll each month)</label>
            <input
              type="number"
              value={installment}
              onChange={(e) => setInstallment(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Eid advance, emergency loan"
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
          >
            {submitting ? <Spinner size={14} /> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
