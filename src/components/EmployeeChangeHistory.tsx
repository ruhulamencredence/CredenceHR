/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Employees -> "Change History" view: every Department/
// Designation change (employee_transfers) and every other field edit
// (employee_change_log) across ALL employees, in one filterable timeline.
// Also home to the pieces the per-employee History tab in EmployeesPanel.tsx
// shares with it (entry card, timeline builder, field/value labels), so both
// screens render a change identically.

import React, { useState, useEffect, useMemo } from 'react';
import { History, Search, Building2, Briefcase, Users2, ArrowRight, X } from 'lucide-react';
import { EmployeeTransfer, EmployeeChangeLogEntry } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

// ---- Shared helpers ------------------------------------------------------
// Field-level rows in employee_change_log use raw column names; these turn
// them into what an admin would call them. Anything not listed falls back to
// the column name in Title Case (e.g. present_city -> "Present City").
const HISTORY_FIELD_LABELS: Record<string, string> = {
  employee_id: 'Employee ID',
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  is_active: 'Status',
  branch: 'Branch',
  nid_ssn: 'NID / SSN',
  is_foreigner: 'Foreigner',
  date_of_birth: 'Date of Birth',
  job_base: 'Job Base',
  personal_email: 'Personal Email'
};
// branch_id is logged alongside branch (the name) — showing both is noise.
const HISTORY_HIDDEN_FIELDS = new Set(['branch_id']);

const historyFieldLabel = (field: string) =>
  HISTORY_FIELD_LABELS[field] ||
  field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const historyValueLabel = (field: string, v: string | null) => {
  if (v === null || v === '') return '—';
  if (field === 'is_active') return v === '1' ? 'Active' : 'Inactive';
  if (field === 'is_foreigner') return v === '1' ? 'Yes' : 'No';
  return v;
};

const historyTime = (v: string | null | undefined) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');
const dateOnly = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '');

export type HistoryFilter = 'all' | 'job' | 'fields';
export type HistoryEntry =
  | { kind: 'job'; key: string; at: string; employeeName?: string | null; employeeCode?: string | null; row: EmployeeTransfer }
  | { kind: 'fields'; key: string; at: string; by: string | null; employeeName?: string | null; employeeCode?: string | null; rows: EmployeeChangeLogEntry[] };

export const HISTORY_FILTERS: [HistoryFilter, string][] = [
  ['all', 'All'],
  ['job', 'Department / Designation'],
  ['fields', 'Other fields']
];

// One newest-first timeline: each Department/Designation change is its own
// entry; field rows written by the same save (same employee + created_at +
// user) are grouped into one entry.
export function buildHistoryTimeline(transfers: EmployeeTransfer[], changes: EmployeeChangeLogEntry[]): HistoryEntry[] {
  const entries: HistoryEntry[] = transfers.map((row) => ({
    kind: 'job',
    key: `t${row.id}`,
    at: row.created_at || row.effective_date || '',
    employeeName: row.employee_name ?? null,
    employeeCode: row.employee_code ?? null,
    row
  }));
  const groups = new Map<string, EmployeeChangeLogEntry[]>();
  for (const r of changes) {
    if (HISTORY_HIDDEN_FIELDS.has(r.field_name)) continue;
    const k = `${r.employee_id}|${r.created_at}|${r.action_by ?? ''}`;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  groups.forEach((rows, k) =>
    entries.push({
      kind: 'fields',
      key: `c${k}`,
      at: rows[0].created_at,
      by: rows[0].action_by_name ?? null,
      employeeName: rows[0].employee_name ?? null,
      employeeCode: rows[0].employee_code ?? null,
      rows
    })
  );
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export const HistoryEntryCard: React.FC<{ entry: HistoryEntry }> = ({ entry: h }) => {
  const employeeHeader = h.employeeName ? (
    <div className="flex items-baseline gap-1.5">
      <span className="text-sm font-semibold text-slate-900">{h.employeeName}</span>
      {h.employeeCode && <span className="font-mono text-[11px] text-slate-400">{h.employeeCode}</span>}
    </div>
  ) : null;

  if (h.kind === 'job') {
    return (
      <li className="rounded-xl border border-violet-200 bg-violet-50/40 p-3 text-xs text-slate-600 space-y-1">
        {employeeHeader}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-slate-700">{historyTime(h.at) || '—'}</span>
            <span className="px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 text-[10px] font-semibold">Department / Designation</span>
            {h.row.applied === false && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 text-[10px] font-semibold">Scheduled</span>
            )}
          </span>
          {h.row.action_by_name && <span className="text-slate-400 whitespace-nowrap">by {h.row.action_by_name}</span>}
        </div>
        {(h.row.from_department_name || h.row.to_department_name) && (
          <div className="flex items-center gap-1.5">
            <Building2 className="w-3 h-3 text-slate-400" />
            <span>{h.row.from_department_name || '—'}</span>
            <ArrowRight className="w-3 h-3 text-slate-300" />
            <span className="font-medium text-slate-800">{h.row.to_department_name || '—'}</span>
          </div>
        )}
        {(h.row.from_designation || h.row.to_designation) && (
          <div className="flex items-center gap-1.5">
            <Briefcase className="w-3 h-3 text-slate-400" />
            <span>{h.row.from_designation || '—'}</span>
            <ArrowRight className="w-3 h-3 text-slate-300" />
            <span className="font-medium text-slate-800">{h.row.to_designation || '—'}</span>
          </div>
        )}
        {(h.row.from_supervisor_name || h.row.to_supervisor_name) && (
          <div className="flex items-center gap-1.5">
            <Users2 className="w-3 h-3 text-slate-400" />
            <span>{h.row.from_supervisor_name || '—'}</span>
            <ArrowRight className="w-3 h-3 text-slate-300" />
            <span className="font-medium text-slate-800">{h.row.to_supervisor_name || '—'}</span>
          </div>
        )}
        <p className="text-slate-400">
          Effective {dateOnly(h.row.effective_date) || '—'}
          {h.row.reason ? <span className="italic text-slate-500"> — {h.row.reason}</span> : null}
        </p>
      </li>
    );
  }

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 space-y-1.5">
      {employeeHeader}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold text-slate-700">{historyTime(h.at) || '—'}</span>
          <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-semibold">
            {h.rows.length} {h.rows.length === 1 ? 'field' : 'fields'} edited
          </span>
        </span>
        {h.by && <span className="text-slate-400 whitespace-nowrap">by {h.by}</span>}
      </div>
      <dl className="space-y-1">
        {h.rows.map((r) => (
          <div key={r.id} className="grid grid-cols-[8rem_1fr] gap-2 items-baseline">
            <dt className="font-medium text-slate-500 truncate" title={historyFieldLabel(r.field_name)}>
              {historyFieldLabel(r.field_name)}
            </dt>
            <dd className="flex items-baseline gap-1.5 flex-wrap min-w-0">
              <span className="text-slate-400 line-through break-words max-w-full">{historyValueLabel(r.field_name, r.old_value)}</span>
              <ArrowRight className="w-3 h-3 text-slate-300 shrink-0 self-center" />
              <span className="font-medium text-slate-800 break-words max-w-full">{historyValueLabel(r.field_name, r.new_value)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
};

// ---- All-employees view --------------------------------------------------
const PAGE_SIZE = 100;

export const EmployeeChangeHistory: React.FC<{ token: string }> = ({ token }) => {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [kind, setKind] = useState<HistoryFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [reloadTick, setReloadTick] = useState(0);

  const [transfers, setTransfers] = useState<EmployeeTransfer[]>([]);
  const [changes, setChanges] = useState<EmployeeChangeLogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Wait for a pause in typing before hitting the API, and go back to the
  // first page whenever the search changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setLimit(PAGE_SIZE);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (debouncedSearch) params.set('q', debouncedSearch);
        if (kind !== 'all') params.set('kind', kind);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const res = await fetch(apiUrl(`/api/employee-change-history?${params.toString()}`), {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load change history');
        if (cancelled) return;
        setTransfers(data.transfers || []);
        setChanges(data.changes || []);
        setHasMore(!!data.hasMore);
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Could not load change history');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, debouncedSearch, kind, from, to, limit, reloadTick]);

  const timeline = useMemo(() => buildHistoryTimeline(transfers, changes), [transfers, changes]);
  const filtersActive = !!(search || from || to || kind !== 'all');
  const clearFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setKind('all');
    setFrom('');
    setTo('');
    setLimit(PAGE_SIZE);
  };

  const inputCls =
    'px-3 py-2 bg-white border border-slate-200 rounded-xl text-slate-900 text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none';

  return (
    <div className="space-y-3">
      <div className="flex flex-col lg:flex-row lg:items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by employee name or ID…"
            className="block w-full pl-9 pr-3 py-2.5 bg-white border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <label className="text-[11px] font-semibold text-slate-500">From</label>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setLimit(PAGE_SIZE); }} className={inputCls} />
          <label className="text-[11px] font-semibold text-slate-500">To</label>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setLimit(PAGE_SIZE); }} className={inputCls} />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {HISTORY_FILTERS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => { setKind(k); setLimit(PAGE_SIZE); }}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                kind === k ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {filtersActive && (
          <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800">
            <X className="w-3 h-3" /> Clear filters
          </button>
        )}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadTick((n) => n + 1)} className="font-semibold underline">Retry</button>
        </div>
      ) : loading && timeline.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-slate-400 gap-2 text-sm">
          <Spinner size={16} /> Loading change history…
        </div>
      ) : timeline.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-10 text-center">
          <History className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">
            {filtersActive
              ? 'No changes match these filters.'
              : 'Nothing recorded yet. Employee edits saved from now on will appear here; earlier edits were not captured.'}
          </p>
        </div>
      ) : (
        <>
          <ol className={`space-y-2 ${loading ? 'opacity-60' : ''}`}>
            {timeline.map((h) => (
              <HistoryEntryCard key={h.key} entry={h} />
            ))}
          </ol>
          <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              Showing {timeline.length} {timeline.length === 1 ? 'entry' : 'entries'}
              {hasMore ? ' — older history is available' : ''}
            </span>
            {hasMore && (
              <button
                type="button"
                onClick={() => setLimit((l) => l + PAGE_SIZE)}
                disabled={loading}
                className="px-3 py-1.5 rounded-xl border border-slate-200 bg-white font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Load older'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};
