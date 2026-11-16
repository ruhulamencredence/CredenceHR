/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { RequestDetailsButton } from './RequestDetails';
import React, { useEffect, useMemo, useState } from 'react';
import { History, Search } from 'lucide-react';
import { SearchSelect } from './Combobox';
import { apiUrl } from '../lib/api';
import { LoadingBlock } from './LoadingBlock';
import { PagerBar } from './PagerBar';

// GET /api/my-approvals/history — every approve / reject this account made.
interface HistoryItem {
  key: string;
  type: string;
  title: string;
  requested_by_name: string | null;
  requested_by_code?: string | null;
  requested_by_designation?: string | null;
  requested_by_department?: string | null;
  action: 'approved' | 'rejected';
  remarks: string | null;
  acted_at: string;
  step: number | null;
  amount?: number | null;
  source_type?: string;
  source_id?: number;
}
interface HistoryResponse {
  summary: { total: number; approved: number; rejected: number; by_type: Record<string, { approved: number; rejected: number }> };
  items: HistoryItem[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : `${pad(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()}`;
};
const fmtTime = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();
};
// Same look as Bill Disbursement (DisbursementPanel.tsx).
const LBL = 'block text-[10px] font-semibold text-slate-500 mb-1';
const INPUT = 'w-full text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none';
const NO_DEPT = '(No department)';

// Self Service -> Approve Application -> History: every request this account
// approved or rejected in a period — searchable, filtered by decision, type,
// employee, Department and Layer, a table on a computer and cards on a phone.
export const ApprovalHistory: React.FC<{ token: string }> = ({ token }) => {
  const now = new Date();
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(ymd(now));
  const [actionFilter, setActionFilter] = useState<'all' | 'approved' | 'rejected'>('all');
  const [typeFilter, setTypeFilter] = useState('');
  const [who, setWho] = useState('');
  const [dept, setDept] = useState('');
  const [layer, setLayer] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // One page of decisions at a time — a long period has hundreds.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    fetch(apiUrl(`/api/my-approvals/history?${qs}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Failed to load your history.');
        if (!cancelled) setData(d);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, from, to]);

  const items = data?.items || [];
  const types = useMemo(() => Array.from(new Set(items.map((i) => i.type))).sort(), [items]);
  // Everyone in the period, searchable by name, Employee ID, designation, Department.
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      if (!i.requested_by_name) continue;
      m.set(i.requested_by_name, [i.requested_by_name, i.requested_by_code, i.requested_by_designation, i.requested_by_department].filter(Boolean).join(' · '));
    }
    return Array.from(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);
  const departments = useMemo(() => Array.from(new Set(items.map((i) => i.requested_by_department || NO_DEPT))).sort(), [items]);
  const layers = useMemo(() => Array.from(new Set(items.map((i) => i.step).filter((n): n is number => !!n))).sort((a, b) => a - b), [items]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(
      (i) =>
        (actionFilter === 'all' || i.action === actionFilter) &&
        (!typeFilter || i.type === typeFilter) &&
        (!who || i.requested_by_name === who) &&
        (!dept || (i.requested_by_department || NO_DEPT) === dept) &&
        (!layer || String(i.step || '') === layer) &&
        (!q || [i.type, i.title, i.requested_by_name, i.requested_by_code, i.requested_by_designation, i.requested_by_department, i.remarks].join(' ').toLowerCase().includes(q))
    );
  }, [items, actionFilter, typeFilter, who, dept, layer, search]);
  useEffect(() => setPage(1), [data, actionFilter, typeFilter, who, dept, layer, search, pageSize]);
  const pageRows = shown.slice((page - 1) * pageSize, page * pageSize);
  const approved = shown.filter((i) => i.action === 'approved').length;
  const billTotal = shown.reduce((s, i) => s + (i.action === 'approved' && i.type === 'Bill Claim' ? Number(i.amount) || 0 : 0), 0);
  const who2 = (i: HistoryItem) => [i.requested_by_code, i.requested_by_designation].filter(Boolean).join(' · ');
  const decision = (i: HistoryItem) =>
    i.action === 'approved' ? (
      <span className="px-2 py-0.5 rounded-full font-semibold border text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Approved</span>
    ) : (
      <span className="px-2 py-0.5 rounded-full font-semibold border text-[10px] bg-rose-50 text-rose-700 border-rose-200">Rejected</span>
    );

  return (
    <div>
      <div className="px-6 py-4 border-b border-slate-200 flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="apph-search" className={LBL}>Search</label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input id="apph-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, Employee ID, detail or your remarks" className={`${INPUT} pl-8`} />
            </div>
          </div>
          <div className="min-w-0 sm:w-64">
            <span className={LBL}>Decision</span>
            <div className="flex bg-slate-100 rounded-lg p-0.5" role="group" aria-label="Decision">
              {(['approved', 'rejected', 'all'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  aria-pressed={actionFilter === st}
                  onClick={() => setActionFilter(st)}
                  className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold capitalize transition-colors ${
                    actionFilter === st ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2 items-end">
          <div className="min-w-0">
            <label htmlFor="apph-type" className={LBL}>Type</label>
            <select id="apph-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={INPUT}>
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <span className={LBL}>Employee</span>
            <SearchSelect value={who} onChange={(e) => setWho(e.target.value)} aria-label="Employee" className={INPUT}>
              <option value="">All employees</option>
              {people.map(([name, label]) => (
                <option key={name} value={name}>{label}</option>
              ))}
            </SearchSelect>
          </div>
          <div className="min-w-0">
            <span className={LBL}>Department</span>
            <SearchSelect value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department" className={INPUT}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </SearchSelect>
          </div>
          <div className="min-w-0">
            <label htmlFor="apph-layer" className={LBL}>Layer</label>
            <select id="apph-layer" value={layer} onChange={(e) => setLayer(e.target.value)} className={INPUT}>
              <option value="">Any layer</option>
              {layers.map((n) => (
                <option key={n} value={String(n)}>Layer {n}</option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="apph-from" className={LBL}>Decided from</label>
            <input id="apph-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={INPUT} />
          </div>
          <div className="min-w-0">
            <label htmlFor="apph-to" className={LBL}>Decided to</label>
            <input id="apph-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={INPUT} />
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <div className="mx-6 my-4 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">{error}</div>
      ) : (
        <>
          <div className="px-6 py-3 border-b border-slate-200 bg-slate-50/60 text-xs text-slate-600 flex flex-wrap gap-x-5 gap-y-1">
            <span><b className="text-slate-900">{shown.length}</b> decision{shown.length === 1 ? '' : 's'}</span>
            <span>Approved <b className="text-emerald-700">{approved}</b></span>
            <span>Rejected <b className="text-rose-600">{shown.length - approved}</b></span>
            {billTotal > 0 && (
              <span>Bill Claims approved <b className="text-slate-900">৳{billTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b></span>
            )}
          </div>

          {shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
              <History className="w-6 h-6 text-slate-300" />
              <p className="text-sm">No decisions match.</p>
            </div>
          ) : (
            <>
              {/* Phone — cards. */}
              <div className="md:hidden divide-y divide-slate-100">
                {pageRows.map((i) => (
                  <div key={i.key} className="px-4 py-3 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">{i.type}</span>
                      {decision(i)}
                    </div>
                    <div className="text-xs">
                      <span className="font-medium text-slate-800">{i.requested_by_name || '—'}</span>
                      {who2(i) && <span className="text-slate-500"> · {who2(i)}</span>}
                    </div>
                    {i.title && <div className="text-xs text-slate-600">{i.title}</div>}
                    {i.remarks && <div className="text-[11px] text-slate-500 italic">“{i.remarks}”</div>}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-[11px] text-slate-400">
                        {fmtDay(i.acted_at)} {fmtTime(i.acted_at)}
                        {i.step ? ` · Layer ${i.step}` : ''}
                      </span>
                      {i.source_type && i.source_id ? <RequestDetailsButton token={token} type={i.source_type} id={i.source_id} /> : null}
                    </div>
                  </div>
                ))}
              </div>
              {/* Computer — table, like Bill Disbursement. */}
              <div className="hidden md:block overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Decided on</th>
                      <th className="px-4 py-2.5 text-left">Type</th>
                      <th className="px-4 py-2.5 text-left">Employee</th>
                      <th className="px-4 py-2.5 text-left">Department</th>
                      <th className="px-4 py-2.5 text-left">Detail</th>
                      <th className="px-4 py-2.5 text-left">Layer</th>
                      <th className="px-4 py-2.5 text-left">Decision</th>
                      <th className="px-4 py-2.5 text-left"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {pageRows.map((i) => (
                      <tr key={i.key} className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">
                          {fmtDay(i.acted_at)}
                          <span className="block text-[11px] text-slate-400">{fmtTime(i.acted_at)}</span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs">{i.type}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">
                          <span className="font-medium text-slate-800">{i.requested_by_name || '—'}</span>
                          {who2(i) && <span className="block text-[11px] text-slate-500">{who2(i)}</span>}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">{i.requested_by_department || '—'}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs max-w-[280px]">
                          <span className="block truncate" title={i.title}>{i.title || '—'}</span>
                          {i.remarks && <span className="block truncate text-[11px] italic text-slate-400" title={i.remarks}>“{i.remarks}”</span>}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">{i.step || '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">{decision(i)}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">
                          {i.source_type && i.source_id ? <RequestDetailsButton token={token} type={i.source_type} id={i.source_id} /> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <PagerBar page={page} pageSize={pageSize} total={shown.length} onPage={setPage} onPageSize={setPageSize} />
            </>
          )}
        </>
      )}
    </div>
  );
};
