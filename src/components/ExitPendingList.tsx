/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Exit / Offboarding -> Pending (GET /api/exit-requests/pending): every exit
// not finished yet and what each one is still waiting on — open clearance
// items and who they sit with, the Full & Final settlement, days to / past
// the last working day and (with the "exit_dues" layer) assets, SIMs and
// loans still open in other modules. Same idea as Onboarding's pending list.
// Clicking a person opens their exit in the list below.

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardList, Package, Wallet } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { LoadingBlock } from './LoadingBlock';

interface PendingExit {
  id: number;
  user_id: number;
  name: string | null;
  employee_code: string | null;
  department: string | null;
  designation: string | null;
  exit_type: 'resignation' | 'termination';
  status: 'pending' | 'clearance' | 'settled';
  last_working_day: string | null;
  days_left: number | null;
  clearance_total: number;
  clearance_done: number;
  open_clearance: { id: number; department: string; item_label: string; approver_name: string | null }[];
  settlement_status: 'draft' | 'approved' | 'paid' | null;
  net_payable: number | null;
  blocking_dues: { key: string; kind: string; label: string; amount: number | null }[];
  other_dues: number;
  pending: { key: string; label: string; tone: 'red' | 'amber' | 'slate' }[];
}
interface PendingData {
  today: string;
  with_dues: boolean;
  summary: {
    open: number;
    not_accepted: number;
    leaving_7_days: number;
    past_last_day: number;
    clearance_open: number;
    settlement_unpaid: number;
    blocking_dues: number | null;
  };
  by_department: { department: string; open: number; approvers: string[]; exits: { id: number; name: string }[] }[];
  exits: PendingExit[];
}
type Filter = 'all' | 'not_accepted' | 'leaving' | 'past' | 'unpaid' | 'dues';

const TONE: Record<string, string> = {
  red: 'bg-rose-50 text-rose-700 border-rose-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  slate: 'bg-slate-100 text-slate-600 border-slate-200'
};
const fmtDay = (d: string | null) => {
  if (!d) return '—';
  const t = new Date(`${d}T00:00:00`);
  return isNaN(t.getTime()) ? d : t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const daysText = (n: number | null) => (n === null ? 'No last day set' : n === 0 ? 'Last day today' : n > 0 ? `${n} day${n === 1 ? '' : 's'} left` : `${-n} day${n === -1 ? '' : 's'} past last day`);

export const ExitPendingList: React.FC<{ token: string; refreshKey: number; onOpen: (exitId: number) => void }> = ({ token, refreshKey, onOpen }) => {
  const [data, setData] = useState<PendingData | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [dept, setDept] = useState('');

  useEffect(() => {
    fetch(apiUrl('/api/exit-requests/pending'), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not load the pending list');
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [token, refreshKey]);

  if (error) return <p className="mx-6 my-4 text-xs text-rose-600">{error}</p>;
  if (!data)
    return (
      <LoadingBlock />
    );

  const s = data.summary;
  const tiles: { key: Filter; label: string; value: number; icon: React.ComponentType<{ className?: string }>; tone: string }[] = [
    { key: 'all', label: 'Exits in progress', value: s.open, icon: ClipboardList, tone: 'text-slate-900' },
    { key: 'not_accepted', label: 'Not accepted yet', value: s.not_accepted, icon: AlertTriangle, tone: s.not_accepted ? 'text-amber-600' : 'text-slate-900' },
    { key: 'leaving', label: 'Leaving in 7 days', value: s.leaving_7_days, icon: CalendarClock, tone: s.leaving_7_days ? 'text-blue-600' : 'text-slate-900' },
    { key: 'past', label: 'Past last day, not settled', value: s.past_last_day, icon: AlertTriangle, tone: s.past_last_day ? 'text-rose-600' : 'text-slate-900' },
    { key: 'unpaid', label: 'Settlement not paid', value: s.settlement_unpaid, icon: Wallet, tone: s.settlement_unpaid ? 'text-amber-600' : 'text-slate-900' },
    ...(data.with_dues && s.blocking_dues !== null
      ? [{ key: 'dues' as Filter, label: 'Assets / SIM / loans open', value: s.blocking_dues, icon: Package, tone: s.blocking_dues ? 'text-rose-600' : 'text-slate-900' }]
      : [])
  ];
  const shown = data.exits.filter((e) => {
    if (dept && !e.open_clearance.some((c) => c.department === dept)) return false;
    switch (filter) {
      case 'not_accepted':
        return e.status === 'pending';
      case 'leaving':
        return e.days_left !== null && e.days_left >= 0 && e.days_left <= 7;
      case 'past':
        return e.days_left !== null && e.days_left < 0 && e.status !== 'settled';
      case 'unpaid':
        return e.settlement_status !== 'paid';
      case 'dues':
        return e.blocking_dues.length > 0;
      default:
        return true;
    }
  });

  return (
    <div className="px-4 sm:px-6 py-5 border-b border-slate-200 bg-slate-50/60 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-bold text-slate-800">Offboarding — pending</p>
        <p className="text-[11px] text-slate-500">
          {s.clearance_open} clearance item{s.clearance_open === 1 ? '' : 's'} open · tap a tile to filter, a person to open their exit
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setFilter(filter === t.key ? 'all' : t.key)}
            className={`text-left rounded-xl bg-white border px-3 py-2.5 transition-shadow hover:shadow-sm ${filter === t.key ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}
          >
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </div>
            <div className={`text-xl font-bold mt-0.5 ${t.tone}`}>{t.value}</div>
          </button>
        ))}
      </div>

      {data.by_department.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-500 mb-1.5">Clearance waiting by department</p>
          <div className="flex flex-wrap gap-1.5">
            {data.by_department.map((d) => (
              <button
                key={d.department}
                type="button"
                onClick={() => setDept(dept === d.department ? '' : d.department)}
                title={d.exits.map((x) => x.name).join(', ')}
                className={`text-[11px] px-2.5 py-1 rounded-full border ${dept === d.department ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
              >
                <span className="font-semibold">{d.department}</span>: {d.open} pending · {d.approvers.join(', ')}
              </button>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="rounded-xl bg-white border border-slate-200 py-6 text-center text-xs text-slate-500 flex items-center justify-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" /> {data.exits.length ? 'Nothing pending for this filter.' : 'No exit is pending — everyone is cleared and paid.'}
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((e) => {
            const pct = e.clearance_total ? Math.round((e.clearance_done / e.clearance_total) * 100) : 0;
            const late = e.days_left !== null && e.days_left < 0 && e.status !== 'settled';
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpen(e.id)}
                className={`w-full text-left rounded-xl bg-white border p-3 hover:shadow-sm transition-shadow ${late ? 'border-rose-300' : 'border-slate-200'}`}
              >
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800">
                      {e.name || `User #${e.user_id}`}
                      <span className="ml-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{e.exit_type}</span>
                      <span className="ml-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{e.status}</span>
                    </p>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {[e.employee_code, e.designation, e.department].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`text-[11px] font-semibold ${late ? 'text-rose-600' : e.days_left !== null && e.days_left <= 7 ? 'text-blue-700' : 'text-slate-600'}`}>{daysText(e.days_left)}</p>
                    <p className="text-[11px] text-slate-400">Last day {fmtDay(e.last_working_day)}</p>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                    <div className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[11px] font-semibold text-slate-600 whitespace-nowrap">
                    Clearance {e.clearance_done}/{e.clearance_total}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {e.pending.map((p) => (
                    <span key={p.key} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${TONE[p.tone]}`}>
                      {p.label}
                    </span>
                  ))}
                  {e.other_dues > 0 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full border bg-white text-slate-500 border-slate-200">
                      +{e.other_dues} claim / bill / ride on record
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
