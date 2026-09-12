/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Search, CheckCircle2, Clock, Banknote, Trash2, RefreshCw } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface PayrollListPanelProps {
  token: string;
}

interface PayrollListRecord {
  id: number;
  employee_id: number;
  employee_code: string | null;
  employee_name: string;
  designation: string | null;
  department: string | null;
  month_year: string;
  basic_salary: number;
  house_rent: number;
  medical_allowance: number;
  other_allowance: number;
  tax_deduction: number;
  pf_deduction: number;
  other_deduction: number;
  total_deduction: number;
  net_salary: number;
  payment_status: 'unpaid' | 'processed' | 'paid';
}

interface Department {
  id: number;
  name: string;
}

const currentMonthYear = () => new Date().toISOString().slice(0, 7);

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// unpaid -> Pending, processed -> Approved, paid -> Paid — the labels this
// list uses match the payroll payment_status enum 1:1, just in plain English.
const StatusBadge: React.FC<{ status: PayrollListRecord['payment_status'] }> = ({ status }) => {
  if (status === 'paid') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
        <CheckCircle2 className="w-2.5 h-2.5" /> Paid
      </span>
    );
  }
  if (status === 'processed') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
        <CheckCircle2 className="w-2.5 h-2.5" /> Approved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
      <Clock className="w-2.5 h-2.5" /> Pending
    </span>
  );
};

export const PayrollListPanel: React.FC<PayrollListPanelProps> = ({ token }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [department, setDepartment] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unpaid' | 'processed' | 'paid'>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [departments, setDepartments] = useState<Department[]>([]);
  const [records, setRecords] = useState<PayrollListRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');

  // Debounce the free-text search box so every keystroke doesn't fire a request.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/departments'), { headers: authHeaders });
        if (res.ok) setDepartments(await res.json());
      } catch {
        // Department filter just stays empty — not fatal to the list itself.
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  const fetchRecords = async () => {
    setLoading(true);
    setError('');
    setActionError('');
    try {
      const params = new URLSearchParams({ month_year: monthYear });
      if (department) params.set('department', department);
      if (statusFilter !== 'all') params.set('payment_status', statusFilter);
      if (search) params.set('search', search);
      const res = await fetch(apiUrl(`/api/payroll/employee-list?${params.toString()}`), { headers: authHeaders });
      if (!res.ok) {
        setError(res.status === 403 ? "You don't have access to the Payroll list." : 'Failed to load the payroll list.');
        return;
      }
      const data = await res.json();
      setRecords(data.records || []);
    } catch {
      setError('Failed to load the payroll list.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthYear, department, statusFilter, search]);

  const approve = async (id: number) => {
    setActionId(id);
    setActionError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/${id}/process`), { method: 'POST', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Failed to approve payroll.');
        return;
      }
      await fetchRecords();
    } catch {
      setActionError('Failed to approve payroll.');
    } finally {
      setActionId(null);
    }
  };

  const markPaid = async (id: number) => {
    setActionId(id);
    setActionError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/${id}/mark-paid`), { method: 'POST', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Failed to mark payroll as paid.');
        return;
      }
      await fetchRecords();
    } catch {
      setActionError('Failed to mark payroll as paid.');
    } finally {
      setActionId(null);
    }
  };

  const removeRecord = async (id: number) => {
    if (!window.confirm('Delete this payroll run? This cannot be undone.')) return;
    setActionId(id);
    setActionError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/${id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Failed to delete payroll run.');
        return;
      }
      await fetchRecords();
    } catch {
      setActionError('Failed to delete payroll run.');
    } finally {
      setActionId(null);
    }
  };

  const totalNet = records.reduce((s, r) => s + Number(r.net_salary || 0), 0);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-4 border-b border-slate-200 flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
          <Banknote className="w-4.5 h-4.5 text-blue-600" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Employee Salary Profiles</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">Payroll list for the selected month, with department, status and search filters.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="p-4 border-b border-slate-100 flex flex-wrap items-center gap-2">
        <input
          type="month"
          value={monthYear}
          onChange={(e) => setMonthYear(e.target.value)}
          className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          <option value="">All Departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.name}>{d.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          <option value="all">All Statuses</option>
          <option value="unpaid">Pending</option>
          <option value="processed">Approved</option>
          <option value="paid">Paid</option>
        </select>
        <div className="relative flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name or employee ID"
            className="w-full pl-8 pr-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
        <button
          onClick={fetchRecords}
          className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {actionError && (
        <p className="mx-4 mt-3 text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{actionError}</p>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size={26} /></div>
      ) : error ? (
        <p className="text-xs text-rose-600 text-center py-16">{error}</p>
      ) : records.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-16">No payroll records match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
              <tr>
                <th className="px-4 py-2.5 text-left">Employee</th>
                <th className="px-4 py-2.5 text-left">Designation</th>
                <th className="px-4 py-2.5 text-left">Department</th>
                <th className="px-4 py-2.5 text-right">Basic</th>
                <th className="px-4 py-2.5 text-right">House Rent</th>
                <th className="px-4 py-2.5 text-right">Medical</th>
                <th className="px-4 py-2.5 text-right">Other Allow.</th>
                <th className="px-4 py-2.5 text-right">Tax</th>
                <th className="px-4 py-2.5 text-right">PF</th>
                <th className="px-4 py-2.5 text-right">Other Ded.</th>
                <th className="px-4 py-2.5 text-right">Net Salary</th>
                <th className="px-4 py-2.5 text-left">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {records.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <p className="font-medium text-slate-800">{r.employee_name}</p>
                    <p className="text-[10px] text-slate-400">{r.employee_code || '—'}</p>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{r.designation || '—'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{r.department || '—'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right text-slate-700">{money(r.basic_salary)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right text-slate-700">{money(r.house_rent)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right text-slate-700">{money(r.medical_allowance)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right text-slate-700">{money(r.other_allowance)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right text-rose-600">{money(r.tax_deduction)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right text-rose-600">{money(r.pf_deduction)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right text-rose-600">{money(r.other_deduction)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-semibold text-slate-900">{money(r.net_salary)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap"><StatusBadge status={r.payment_status} /></td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {r.payment_status === 'unpaid' && (
                        <>
                          <button
                            onClick={() => approve(r.id)}
                            disabled={actionId === r.id}
                            className="px-2.5 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg disabled:opacity-50"
                          >
                            {actionId === r.id ? <Spinner size={12} /> : 'Approve'}
                          </button>
                          <button
                            onClick={() => removeRecord(r.id)}
                            disabled={actionId === r.id}
                            className="w-7 h-7 flex items-center justify-center text-rose-500 hover:bg-rose-50 rounded-lg disabled:opacity-50"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                      {r.payment_status === 'processed' && (
                        <button
                          onClick={() => markPaid(r.id)}
                          disabled={actionId === r.id}
                          className="px-2.5 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg disabled:opacity-50"
                        >
                          {actionId === r.id ? <Spinner size={12} /> : 'Mark Paid'}
                        </button>
                      )}
                      {r.payment_status === 'paid' && <span className="text-slate-300">—</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 font-semibold text-slate-700">
                <td className="px-4 py-2.5" colSpan={10}>Total ({records.length} record{records.length === 1 ? '' : 's'})</td>
                <td className="px-4 py-2.5 text-right">{money(totalNet)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
};
