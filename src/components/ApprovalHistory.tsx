/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, History, Search } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

// GET /api/my-approvals/history — every approve / reject this account made.
interface HistoryItem {
  key: string;
  type: string;
  title: string;
  requested_by_name: string | null;
  action: 'approved' | 'rejected';
  remarks: string | null;
  acted_at: string;
  step: number | null;
}
interface HistoryResponse {
  summary: { total: number; approved: number; rejected: number; by_type: Record<string, { approved: number; rejected: number }> };
  items: HistoryItem[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtWhen = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
};

// Self Service -> Approve Application -> History: how many requests this
// account approved and rejected, by type, and each decision.
export const ApprovalHistory: React.FC<{ token: string }> = ({ token }) => {
  const now = new Date();
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(ymd(now));
  const [actionFilter, setActionFilter] = useState<'all' | 'approved' | 'rejected'>('all');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  const types = useMemo(() => Object.keys(data?.summary.by_type || {}).sort(), [data]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items || []).filter(
      (i) =>
        (actionFilter === 'all' || i.action === actionFilter) &&
        (!typeFilter || i.type === typeFilter) &&
        (!q || `${i.type} ${i.title} ${i.requested_by_name || ''} ${i.remarks || ''}`.toLowerCase().includes(q))
    );
  }, [data, actionFilter, typeFilter, search]);

  const s = data?.summary;
  const inputCls = 'text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-200 focus:outline-none';

  return (
    <div>
      <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        </label>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={inputCls} aria-label="Type">
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, detail…" className={`${inputCls} w-full pl-8`} />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-14">
          <Spinner size={20} className="text-slate-400" />
        </div>
      ) : error ? (
        <div className="mx-6 my-4 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">{error}</div>
      ) : (
        <>
          <div className="px-6 pt-4 grid grid-cols-3 gap-2.5">
            {(
              [
                ['all', 'Total', s?.total || 0, 'text-slate-900', 'bg-slate-50 border-slate-200'],
                ['approved', 'Approved', s?.approved || 0, 'text-emerald-700', 'bg-emerald-50 border-emerald-200'],
                ['rejected', 'Rejected', s?.rejected || 0, 'text-rose-700', 'bg-rose-50 border-rose-200']
              ] as const
            ).map(([key, label, value, text, tone]) => (
              <button
                key={key}
                type="button"
                onClick={() => setActionFilter(key)}
                className={`text-left rounded-xl border px-4 py-3 transition ${tone} ${actionFilter === key ? 'ring-2 ring-blue-300' : ''}`}
              >
                <div className="text-xs font-medium text-slate-500">{label}</div>
                <div className={`text-xl font-bold ${text}`}>{value}</div>
              </button>
            ))}
          </div>

          {types.length > 0 && (
            <div className="px-6 pt-3 flex flex-wrap gap-1.5">
              {types.map((t) => {
                const c = s!.by_type[t];
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTypeFilter(typeFilter === t ? '' : t)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition ${
                      typeFilter === t ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                    }`}
                  >
                    {t} · <span className={typeFilter === t ? '' : 'text-emerald-600'}>{c.approved}✓</span>{' '}
                    <span className={typeFilter === t ? '' : 'text-rose-600'}>{c.rejected}✕</span>
                  </button>
                );
              })}
            </div>
          )}

          {shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
              <History className="w-6 h-6 text-slate-300" />
              <p className="text-sm">No decisions in this period.</p>
            </div>
          ) : (
            <div className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
              {shown.map((i) => (
                <div key={i.key} className="px-6 py-3 flex items-start gap-3">
                  {i.action === 'approved' ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-slate-900">{i.type}</span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          i.action === 'approved' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                        }`}
                      >
                        {i.action === 'approved' ? 'Approved' : 'Rejected'}
                        {i.step ? ` · Layer ${i.step}` : ''}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600 truncate">
                      {i.requested_by_name && <span className="font-medium text-slate-700">{i.requested_by_name}</span>}
                      {i.requested_by_name && i.title ? ' — ' : ''}
                      {i.title}
                    </div>
                    {i.remarks && <div className="text-[11px] text-slate-500 italic mt-0.5">“{i.remarks}”</div>}
                  </div>
                  <div className="text-[11px] text-slate-400 shrink-0 text-right">{fmtWhen(i.acted_at)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
