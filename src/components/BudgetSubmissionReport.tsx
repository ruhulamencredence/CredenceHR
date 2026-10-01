/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> PEPM Management -> Reports -> "Submission Status": pick a
// Budget and see, Project by Project, who has submitted Jobs and Final
// Submitted, and which Projects in that Budget haven't submitted anything yet
// (GET /api/reports/budget-submission-status).

import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Search, Download, CheckCircle2, Clock3, XCircle, ChevronDown, ChevronRight, Lock } from 'lucide-react';
import { Budget } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';

type Status = 'not_submitted' | 'job_submitted' | 'final_submitted';

interface Submitter {
  user_id: number;
  name: string;
  job_count: number;
  job_nos: string[];
  final_submitted: boolean;
  final_submitted_at: string | null;
}

interface ProjectStatus {
  project_id: number | null;
  project_name: string;
  in_budget: boolean;
  budget_item_count: number;
  job_count: number;
  entry_count: number;
  last_entry_at: string | null;
  submitters: Submitter[];
  status: Status;
}

const STATUS: Record<Status, { label: string; badge: string; dot: string; icon: React.ComponentType<{ className?: string }> }> = {
  not_submitted: { label: 'Not submitted', badge: 'bg-rose-50 text-rose-700 border-rose-200', dot: 'bg-rose-500', icon: XCircle },
  job_submitted: { label: 'Job submitted · Final pending', badge: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500', icon: Clock3 },
  final_submitted: { label: 'Final submitted', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', icon: CheckCircle2 }
};

const FILTERS: { key: 'all' | Status; label: string }[] = [
  { key: 'all', label: 'All projects' },
  { key: 'not_submitted', label: 'Not submitted' },
  { key: 'job_submitted', label: 'Final pending' },
  { key: 'final_submitted', label: 'Final submitted' }
];

interface BudgetSubmissionReportProps {
  token: string;
  budgets: Budget[];
}

export function BudgetSubmissionReport({ token, budgets }: BudgetSubmissionReportProps) {
  // Newest published Budget first — that's the one Users are working on.
  const sortedBudgets = useMemo(
    () => [...budgets].sort((a: any, b: any) => Number(!!b.is_published) - Number(!!a.is_published) || String(b.created_at).localeCompare(String(a.created_at))),
    [budgets]
  );
  const [budgetId, setBudgetId] = useState<string>('');
  const [rows, setRows] = useState<ProjectStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!budgetId && sortedBudgets.length > 0) setBudgetId(String(sortedBudgets[0].id));
  }, [sortedBudgets, budgetId]);

  useEffect(() => {
    if (!budgetId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(apiUrl(`/api/reports/budget-submission-status?budget_id=${budgetId}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json.error || 'Could not load the submission status.');
        if (!cancelled) setRows(json.projects || []);
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [budgetId, token]);

  const counts = useMemo(() => {
    const c = { all: 0, not_submitted: 0, job_submitted: 0, final_submitted: 0 };
    for (const r of rows || []) {
      c.all++;
      c[r.status]++;
    }
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows || []).filter(
      (r) =>
        (filter === 'all' || r.status === filter) &&
        (!q || r.project_name.toLowerCase().includes(q) || r.submitters.some((s) => s.name.toLowerCase().includes(q)))
    );
  }, [rows, filter, query]);

  const budgetName = sortedBudgets.find((b) => String(b.id) === budgetId)?.budget_name || '';

  const downloadExcel = () => {
    const data = visible.map((r) => ({
      Project: r.project_name,
      Status: STATUS[r.status].label,
      'In Budget File': r.in_budget ? 'Yes' : 'No',
      'Budget Items': r.budget_item_count,
      Jobs: r.job_count,
      'MPR Entries': r.entry_count,
      'Submitted By': r.submitters.map((s) => s.name).join(', '),
      'Final Submitted By': r.submitters.filter((s) => s.final_submitted).map((s) => s.name).join(', '),
      'Final Pending': r.submitters.filter((s) => !s.final_submitted).map((s) => s.name).join(', '),
      'Last Entry': r.last_entry_at ? formatDate(r.last_entry_at) : ''
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Submission Status');
    XLSX.writeFile(wb, `Submission_Status_${budgetName.replace(/[^\w-]+/g, '_') || budgetId}.xlsx`);
  };

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="p-6 border-b border-slate-200 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Budget Submission Status</h3>
            <p className="text-xs text-slate-500">
              Which Projects in a Budget have submitted Jobs and Final Submitted, and which haven’t started yet.
            </p>
          </div>
          <button
            onClick={downloadExcel}
            disabled={visible.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" /> Download Excel
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px]">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">Budget</label>
            <select
              value={budgetId}
              onChange={(e) => setBudgetId(e.target.value)}
              className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {sortedBudgets.length === 0 && <option value="">No budgets yet</option>}
              {sortedBudgets.map((b: any) => (
                <option key={b.id} value={b.id}>
                  {b.budget_name}
                  {b.is_published ? '' : ' (not published)'}
                </option>
              ))}
            </select>
          </div>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search project or user…"
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold transition-colors ${
                  active ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-blue-300'
                }`}
              >
                {f.key !== 'all' && <span className={`w-2 h-2 rounded-full ${STATUS[f.key].dot}`} />}
                {f.label}
                <span className={`px-1.5 rounded-full text-[10px] ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{counts[f.key]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size={20} className="text-slate-400" />
        </div>
      ) : error ? (
        <p className="text-xs text-rose-600 text-center py-12">{error}</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-12">
          {rows && rows.length === 0 ? 'This Budget has no Projects yet.' : 'No projects match this filter.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Project</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Jobs</th>
                <th className="px-4 py-3 text-right">MPR Entries</th>
                <th className="px-4 py-3 text-left">Submitted By</th>
                <th className="px-4 py-3 text-left">Last Entry</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {visible.map((r) => {
                const key = r.project_name;
                const s = STATUS[r.status];
                const Icon = s.icon;
                const expandable = r.submitters.length > 0;
                const isOpen = open.has(key);
                return (
                  <React.Fragment key={key}>
                    <tr
                      className={`hover:bg-slate-50/80 ${expandable ? 'cursor-pointer' : ''}`}
                      onClick={() => expandable && toggle(key)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                          {expandable ? (
                            isOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                          ) : (
                            <span className="w-3.5" />
                          )}
                          {r.project_name}
                        </div>
                        <div className="ml-5 text-[11px] text-slate-400">
                          {r.in_budget ? `${r.budget_item_count} budget item${r.budget_item_count === 1 ? '' : 's'}` : 'Not in the Budget file'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${s.badge}`}>
                          <Icon className="w-3 h-3" /> {s.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">{r.job_count || '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{r.entry_count || '—'}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {r.submitters.length === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {r.submitters.map((u) => (
                              <span
                                key={u.user_id}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${
                                  u.final_submitted ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'
                                }`}
                                title={u.final_submitted ? 'Final submitted' : 'Final submit pending'}
                              >
                                {u.final_submitted && <Lock className="w-2.5 h-2.5" />} {u.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{r.last_entry_at ? formatDate(r.last_entry_at) : '—'}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={6} className="px-4 py-3">
                          <table className="min-w-full text-xs">
                            <thead className="text-[10px] uppercase tracking-wider text-slate-400">
                              <tr>
                                <th className="text-left py-1 pr-4">User</th>
                                <th className="text-left py-1 pr-4">Job Nos</th>
                                <th className="text-left py-1 pr-4">Final Submit</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.submitters.map((u) => (
                                <tr key={u.user_id} className="border-t border-slate-100">
                                  <td className="py-1.5 pr-4 font-semibold text-slate-800">{u.name}</td>
                                  <td className="py-1.5 pr-4 text-slate-600">{u.job_nos.join(', ') || '—'}</td>
                                  <td className="py-1.5 pr-4">
                                    {u.final_submitted ? (
                                      <span className="text-emerald-700 font-semibold">
                                        Yes{u.final_submitted_at ? ` · ${formatDate(u.final_submitted_at)}` : ''}
                                      </span>
                                    ) : (
                                      <span className="text-amber-700 font-semibold">Pending</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
